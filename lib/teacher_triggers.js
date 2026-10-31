// Очередь случаев для учителя (brain/TEACHER_PROMPT.md). Ядро: учитель и инженер этот файл не меняют.
// Сторож (brain_guard.ps1) раз в 30 с зовёт:  node lib/teacher_triggers.js scan   — найти новые случаи;
//   take — взять следующий (печатает {"id","type","caseFile","report"} или {"busy"}/{"none"}/{"none","budget","retryAt"}); finish <id> <ok|timeout|crash|limit> — закрыть (limit: модель упёрлась в лимит запросов — случай обратно в очередь); release — случай «в работе» обратно в очередь (сторож перезапущен).
// Источники (только чтение): data/blackbox/*.json (смерть, почти-смерть), data/events.log (простой стройки progress_idle — главный случай,
// провалы задач, застревание, сообщения хозяина; итог дня случаем больше не заводится — он забивал очередь), brain/runner.log (провалы выученных навыков: каждый провал версии — повод заказать другой вариант),
// код соседа (Ассасин, его папка — только чтение: новые или изменённые навыки — повод взять у него приём). Всплески склеиваются в один случай; один учитель за раз.
// Состояние — data/teacher_queue.json; материалы случая для учителя — data/teacher_cases/<id>.json; отчёт учитель пишет в data/teacher/<id>.md.
// Бухгалтерия (lib/teacher_ledger.js): в материалы обычного случая — выписка счетов; на finish ok строки «Проводка:» из отчёта проводятся;
// scan раз в цикл — оплата/устаревание/ПОВТОР и случаи-«счета» (invoice: счёт набрал порог — учитель пишет одну заявку).
// Разгрузка учителя (0.3, шаг 4): повторы разбирает КОД, модель — только первый случай нового вида.
//   Фильтр на входе: провал-прерывание (вытеснен, /abort, «безопасность:»…) — не случай; первый провал выученного навыка — не случай; «справилась сама» (тот же навык
//   успешно завершился за 10 мин) — случай снимается. Созревший случай scan разбирает кодом (resolveByCode): закрывает без проводки или проводит на счёт
//   (ledger.caseFinished) и пишет короткий отчёт «разобрано кодом» в data/teacher; модели уходит всё непонятное и первый случай нового вида.
//   Бюджет запусков (take): 6 в час и 40 в сутки; хозяин и счёт — мимо часового предела. take при переборе: {none, budget, retryAt};
//   CLI budget — проверка для сторожа перед помощником, note helper — учёт запуска помощника в том же бюджете.
// Только факты и счётчики: тактик и решений здесь нет.
'use strict';
const fs = require('fs');
const path = require('path');
const bbFiles = require('./blackbox_files');
const eyesLib = require('./eyes');
const ledger = require('./teacher_ledger');

const ROOT = path.join(__dirname, '..');
const OWNER = 'eblanitus228';
const DEFAULTS = {
  TECH_TRIES: 3,                  // технический сбой разбора — повтор до 3 раз, потом «failed»
  QUIET_MS: 90 * 1000,            // случай ждёт 90 с тишины — всплеск склеивается в один
  MAX_WAIT_MS: 10 * 60 * 1000,    // но не дольше 10 мин от первого сигнала
  MERGE_MS: 5 * 60 * 1000,        // смерть/провал/застревание в пределах 5 мин от прошлого сигнала — тот же случай
  COOLDOWN_MS: 30 * 60 * 1000,    // тот же провал / застревание после разбора — снова не раньше чем через 30 мин (смерть — всегда)
  IDLE_MIN: 30,                   // простой: событие progress_idle с min ≥ 30 — случай «простой»
  IDLE_COOLDOWN_MS: 60 * 60 * 1000, // новый случай простоя — не чаще раза в 60 мин (свой счётчик, чужие паузы на него не влияют)
  STUCK_WINDOW_MS: 10 * 60 * 1000, STUCK_FAILS: 6, // застряла: за 10 мин ≥ 6 провалов задач и ни одной успешной (кроме мелочей)
  STALE_MS: 40 * 60 * 1000,       // «в работе» дольше — сторож потерял учителя, случай закрывается как провал
  MAX_PENDING: 20, MAX_FINISHED: 80, MAX_ITEMS: 40, MAX_SEEN: 400,
  MAX_READ: 2 * 1024 * 1024,      // за один проход читаем не больше 2 МБ нового журнала
  EVENTS_TAIL: 150, RUNNER_TAIL: 40,
  HEAL_MS: 10 * 60 * 1000,        // «справилась сама»: тот же навык успешно завершился в течение 10 мин после провала — случай снимается (чисто провальный случай ждёт столько же)
  HOUR_LIMIT: 6, DAY_LIMIT: 40,   // бюджет запусков модели: в час (хозяин и счёт — мимо) и в сутки (общий)
  IDLE_LOOK_MS: 20 * 60 * 1000,   // причина простоя — по провалам за эти минуты до отметки
  MAX_FAILS_KEPT: 10, MAX_LAUNCHES: 200
};
const BUDGET_FREE = new Set(['owner', 'invoice']);   // мимо часового предела
// папка соседа (Ассасин): читаем только список файлов его навыков и поведения, ничего туда не пишем
const NEIGHBOR_DIR = process.env.FLYBOT_NEIGHBOR_DIR || 'C:/Users/user/AppData/Local/hermes/cache/scratch/mcbot';
const NEIGHBOR_CODE = [['lib', 'skills'], ['behavior'], ['lib']];
// day и migrate больше не заводятся; оставлены, чтобы читалась старая очередь
// хозяин — первым, счёт (invoice) — раньше обычных случаев
const PRIO = { owner: 0, invoice: 0.5, idle: 1, death: 2, near: 3, stuck: 5, fail: 6, day: 7, neighbor: 8, migrate: 9 };
const TYPE_RU = { invoice: 'счёт: пора заявка', idle: 'простой', death: 'смерть', near: 'почти-смерть', owner: 'сообщение хозяина', stuck: 'застряла', fail: 'провал', day: 'итог дня', neighbor: 'новое у соседа', migrate: 'разовая: перенос правил' };
const INCIDENT = new Set(['death', 'near', 'stuck', 'fail']);
const TRIVIAL = new Set(['chat', 'eat', 'equip_item', 'look', 'stop', 'status', 'mark', 'say']);
// провал-прерывание (кто-то отнял тело, сторож/мозг отменил) — не случай: ошибка не в самой задаче
const INTERRUPT_RE = /вытеснен|прерван|прервал|прерыв|post \/abort|отключ|уступк\S* мозгу|занят навыком|безопасность:|навык выключен/i;
// кто убил: известные мобы и стихии (латиницей — для slug счёта). Всё остальное (ник игрока, «неизвестно») — не код, а модель
const MOBS = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'evoker', 'ravager', 'phantom',
  'slime', 'magma_cube', 'silverfish', 'blaze', 'ghast', 'wither_skeleton', 'zombie_villager', 'zombified_piglin', 'piglin', 'hoglin', 'guardian', 'vex', 'warden', 'bee', 'wolf', 'endermite',
  'drowning', 'fall', 'lava', 'fire', 'burning', 'explosion', 'starvation', 'suffocation', 'void', 'cactus', 'freeze', 'lightning']);
const CAUSE_RU = { 'утонул': 'drowning', 'лава': 'lava', 'огонь': 'fire', 'падение': 'fall', 'голод': 'starvation', 'задохнулся в блоке': 'suffocation', 'взрыв': 'explosion', 'пустота': 'void' };
const PHASE_EN = { 'день': 'day', 'закат': 'dusk', 'ночь': 'night', 'рассвет': 'dawn' };
const slugOf = s => { const x = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); return /^[a-z][a-z0-9_]*$/.test(x) && x.length >= 2 ? x : null; };
// причина простоя по тексту провала (или статуса постройки): tool | materials | path | search | null
function idleReasonOf(t) {
  t = String(t || '');
  if (/нужен инструмент|без кирки|нет инструмента/i.test(t)) return 'tool';
  if (/нет в инвентаре|не хватил|не хватает|кончились|добираю|добор|материал/i.test(t)) return 'materials';
  if (/путь|не дошла|не могу подойти|нет продвижения|застой|слишком долго идти|иду к месту/i.test(t)) return 'path';
  if (/не вижу|не нашёл|не нашла|обошёл/i.test(t)) return 'search';
  return null;
}

function paths(cfg = {}) {
  const dataDir = cfg.dataDir || path.join(ROOT, 'data');
  const brainDir = cfg.brainDir || path.join(ROOT, 'brain');
  return {
    dataDir, brainDir,
    state: path.join(dataDir, 'teacher_queue.json'),
    cases: path.join(dataDir, 'teacher_cases'),
    reports: path.join(dataDir, 'teacher'),
    blackbox: path.join(dataDir, 'blackbox'),
    events: path.join(dataDir, 'events.log'),
    runner: cfg.runnerLog || path.join(brainDir, 'runner.log')
  };
}

const fileSize = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const pad = n => String(n).padStart(2, '0');
const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
// одинаковая ошибка = тот же текст без чисел (координаты, счётчики)
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
const short = (s, n = 160) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function loadState(P) { try { const o = JSON.parse(fs.readFileSync(P.state, 'utf8')); if (o && Array.isArray(o.cases)) return o; } catch (e) {} return null; }

// Время события из events.log: там только "t" (UTC, ЧЧ:ММ:СС) — берём сегодняшнюю дату UTC; если вышло в будущем — вчера
function eventTime(t, now) {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(t || '');
  if (!m) return now;
  const d = new Date(now); d.setUTCHours(+m[1], +m[2], +m[3], 0);
  let ms = d.getTime(); if (ms > now + 60000) ms -= 86400000;
  return ms;
}

// Новые целые строки файла с позиции pos -> { lines, pos }
function readNew(file, pos, maxRead) {
  const size = fileSize(file);
  if (size < pos) pos = Math.max(0, size - maxRead);       // файл обрезали/заменили
  if (size - pos > maxRead) pos = size - maxRead;          // слишком отстали — только свежий хвост
  if (size <= pos) return { lines: [], pos };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos);
    const end = buf.lastIndexOf(10);                        // только до последнего \n
    if (end < 0) return { lines: [], pos };
    const lines = buf.slice(0, end).toString('utf8').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
    return { lines, pos: pos + end + 1 };
  } finally { fs.closeSync(fd); }
}
function tailLines(file, n, maxBytes = 512 * 1024) {
  const size = fileSize(file); if (!size) return [];
  const from = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from);
    let lines = buf.toString('utf8').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
    if (from > 0) lines = lines.slice(1);
    return lines.slice(-n);
  } finally { fs.closeSync(fd); }
}

function freshState(P, now, L) {
  const st = {
    version: 1, created: new Date(now).toISOString(), seq: 0,
    offsets: { events: fileSize(P.events), runner: fileSize(P.runner) },  // старую историю не разбираем — только новое
    blackboxSeen: bbFiles.listFiles(P.blackbox).slice(-L.MAX_SEEN),
    fails: {}, recent: [], cooldown: {}, suppressed: 0, dropped: 0, cases: [],
    doneAt: {}, lastFails: [], kindSlug: {}, launches: [], coded: 0
  };
  return st;
}

// ---------- склейка ----------
function addTrigger(st, now, L, trig, due = false) {
  const { type, key, item } = trig;
  if ((type === 'fail' || type === 'stuck') && st.cooldown[key] && st.cooldown[key] > now) { st.suppressed++; return null; }
  const pending = st.cases.filter(c => c.status === 'pending');
  // простой: пока случай ждёт — новые отметки в него же (видно, как простой растёт); новый — не чаще раза в IDLE_COOLDOWN_MS
  if (type === 'idle' && !pending.some(x => x.keys.includes(key))) {
    if (st.cooldown[key] && st.cooldown[key] > now) { st.suppressed++; return null; }
    st.cooldown[key] = now + L.IDLE_COOLDOWN_MS;
  }
  let c = INCIDENT.has(type)
    ? pending.find(x => INCIDENT.has(x.type) && now - x.lastAt <= L.MERGE_MS)
    : pending.find(x => x.keys.includes(key));
  if (c) {
    if (c.items.length < L.MAX_ITEMS) c.items.push(item); else c.more = (c.more || 0) + 1;
    c.lastAt = Math.max(c.lastAt, item.at || now);
    if (PRIO[type] < PRIO[c.type]) c.type = type;
    if (!c.keys.includes(key)) c.keys.push(key);
    return c;
  }
  c = { id: null, type, keys: [key], status: 'pending', firstAt: item.at || now, lastAt: due ? 0 : (item.at || now), items: [item] };
  c.id = `${stamp(c.firstAt)}-${++st.seq}`;
  st.cases.push(c);
  // переполнение: выкидываем самый неважный и самый старый ожидающий
  const pend = st.cases.filter(x => x.status === 'pending');
  if (pend.length > L.MAX_PENDING) {
    const victim = pend.sort((a, b) => PRIO[b.type] - PRIO[a.type] || a.firstAt - b.firstAt)[0];
    victim.status = 'dropped'; victim.finishedAt = now; st.dropped++;
  }
  return c;
}

// ---------- разбор источников ----------
function scanBlackbox(st, P, now, L) {
  const seen = new Set(st.blackboxSeen);
  const fresh = bbFiles.listFiles(P.blackbox).filter(n => !seen.has(n));
  for (const name of fresh) {
    st.blackboxSeen.push(name);
    const r = bbFiles.readFile(P.blackbox, name);
    const s = r.ok && r.data && r.data.summary ? r.data.summary : {};
    const kind = name.startsWith('death-') ? 'death' : 'near';
    const by = s.lastTask && s.lastTask.by ? s.lastTask.by : null;
    const text = `${kind === 'death' ? 'смерть' : 'почти-смерть'}: ${s.cause || s.message || '?'}` +
      (s.lastTask ? `; задача ${s.lastTask.name} (отдал ${by || '?'})` : '') + (s.worst ? `; хуже всего ${s.worst.kind} ${s.worst.ttdSec} с` : '');
    const d = kind === 'death' ? { cause: s.cause || null, phase: s.phase || null } : { minHp: typeof s.minHp === 'number' ? s.minHp : null, task: s.lastTask && s.lastTask.name || null };
    addTrigger(st, now, L, { type: kind, key: kind, item: { at: r.ok && r.data.savedAt ? Date.parse(r.data.savedAt) || now : now, kind, ref: 'data/blackbox/' + name, text: short(text, 240), by, d } });
  }
  if (st.blackboxSeen.length > L.MAX_SEEN) st.blackboxSeen = st.blackboxSeen.slice(-L.MAX_SEEN);
}

function failSeen(st, now, L, key, sig, item, need = 2) {
  item.d = { ...(item.d || {}), key };               // по key разбор кода ищет «справилась сама» (doneAt)
  const f = st.fails[key];
  if (f && f.sig === sig) f.n++; else st.fails[key] = { sig, n: 1 };
  st.fails[key].at = now;
  if (st.fails[key].n >= need) { st.fails[key].n = 0; addTrigger(st, now, L, { type: 'fail', key: 'fail:' + key + ':' + sig, item }); } // каждая следующая пара — снова сигнал (в паузе после разбора — молча)
}

function scanEvents(st, P, now, L) {
  const r = readNew(P.events, st.offsets.events || 0, L.MAX_READ);
  st.offsets.events = r.pos;
  for (const line of r.lines) {
    let e; try { e = JSON.parse(line); } catch (er) { continue; }
    if (!e || !e.type) continue;
    const at = eventTime(e.t, now);
    const ref = `data/events.log #${e.id} (${e.t} UTC)`;
    if (e.type === 'task_failed') {
      if (INTERRUPT_RE.test(String(e.reason || ''))) continue;   // прерывание — не случай (и не провал для «застряла»)
      st.recent.push({ at, ok: false, name: String(e.name) });
      st.lastFails = (st.lastFails || []).concat([{ at, text: `${e.name}: ${e.reason}` }]).slice(-L.MAX_FAILS_KEPT);
      failSeen(st, now, L, String(e.name), norm(e.reason), { at, kind: 'fail', ref, by: e.by || e.source || null, text: short(`${e.name} провалился дважды подряд: ${e.reason}`, 240), d: { name: String(e.name), reason: String(e.reason || '') } });
    } else if (e.type === 'task_done') {
      delete st.fails[String(e.name)];
      (st.doneAt = st.doneAt || {})[String(e.name)] = at;
      if (!TRIVIAL.has(e.name)) st.recent.push({ at, ok: true });
    } else if (e.type === 'death') {
      addTrigger(st, now, L, { type: 'death', key: 'death', item: { at, kind: 'death', ref, text: short(`смерть: ${e.cause || ''} ${e.message || ''}`, 240), d: { cause: e.cause || null, phase: e.phase || null } } });
    } else if (e.type === 'progress_idle') {
      const min = Number(e.min) || 0;
      if (min >= L.IDLE_MIN) {
        // причина: поле самого события (статус постройки, если тело его пришлёт), иначе — последний понятный провал за IDLE_LOOK_MS до отметки
        let reason = idleReasonOf(e.status || e.reason || '');
        if (!reason) for (const f of (st.lastFails || []).slice().reverse()) { if (f.at <= at && at - f.at <= L.IDLE_LOOK_MS) { reason = idleReasonOf(f.text); if (reason) break; } }
        addTrigger(st, now, L, { type: 'idle', key: 'idle', item: { at, kind: 'idle', ref, text: `простой: муха не строит уже ${min} мин подряд`, d: { min, reason } } });
      }
    } else if (e.type === 'owner_msg' || (e.type === 'chat' && e.from === OWNER)) {
      const text = String(e.text || '').trim();
      if (text.length >= 2) addTrigger(st, now, L, { type: 'owner', key: 'owner', item: { at, kind: 'owner', ref, text: short(text, 300) } });
    }
  }
  // застряла: в окне много провалов и ни одного успеха
  st.recent = st.recent.filter(x => now - x.at <= L.STUCK_WINDOW_MS);
  const bad = st.recent.filter(x => !x.ok).length, good = st.recent.filter(x => x.ok).length;
  if (bad >= L.STUCK_FAILS && good === 0) {
    const cnt = {}; for (const x of st.recent) if (!x.ok && x.name) cnt[x.name] = (cnt[x.name] || 0) + 1;
    const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || null;   // чаще всего проваливалась эта задача
    addTrigger(st, now, L, { type: 'stuck', key: 'stuck', item: { at: now, kind: 'stuck', ref: 'data/events.log (task_failed за 10 мин)', text: `застряла: за ${Math.round(L.STUCK_WINDOW_MS / 60000)} мин ${bad} провалов задач и ни одной успешной`, d: { task: top } } });
    st.recent = [];
  }
}

function scanRunner(st, P, now, L) {
  const r = readNew(P.runner, st.offsets.runner || 0, L.MAX_READ);
  st.offsets.runner = r.pos;
  for (const line of r.lines) {
    let e; try { e = JSON.parse(line); } catch (er) { continue; }
    if (!e || e.type !== 'run_end') continue;
    const key = 'learned:' + e.name;
    const at = Date.parse(e.time) || now;
    if (e.ok) { delete st.fails[key]; (st.doneAt = st.doneAt || {})[key] = at; continue; }
    if (INTERRUPT_RE.test(String(e.error || ''))) continue;   // прерывание / навык выключен — не случай
    // версия выученного навыка: ПЕРВЫЙ провал — ещё не случай (бывает случайность); два одинаковых подряд — повод заказать другой вариант (старые версии остаются)
    failSeen(st, now, L, key, norm(e.error), { at, kind: 'fail', ref: `brain/runner.log #${e.id} (${e.time})`, by: 'skill:' + e.name, text: short(`навык ${e.name} провалился: ${e.error}`, 240), d: { name: String(e.name), reason: String(e.error || ''), skill: true } }, 2);
  }
}

// Сосед: новый или изменённый файл навыка/поведения в его папке → случай «новое у соседа» (первый взгляд — тоже).
// Подпись — имена, размеры и время файлов кода; статистику соседа учитель смотрит сам по его витрине.
function neighborSig(dir) {
  const parts = [];
  for (const sub of NEIGHBOR_CODE) {
    const d = path.join(dir, ...sub);
    let names = []; try { names = fs.readdirSync(d).filter(n => /\.js$/.test(n)).sort(); } catch (e) { continue; }
    for (const n of names) { try { const s = fs.statSync(path.join(d, n)); parts.push(sub.join('/') + '/' + n + ':' + s.size + ':' + Math.round(s.mtimeMs)); } catch (e) {} }
  }
  return parts;
}
function scanNeighbor(st, P, now, L, cfg) {
  const dir = 'neighborDir' in cfg ? cfg.neighborDir : NEIGHBOR_DIR;
  if (!dir) return;
  const sig = neighborSig(dir);
  if (!sig.length) return;                                    // папки нет или пусто — молча
  const was = new Set(st.neighborSig || []);
  const fresh = sig.filter(x => !was.has(x)).map(x => x.split(':')[0]);
  st.neighborSig = sig;
  if (!fresh.length) return;
  const text = (was.size ? 'у соседа изменился код: ' : 'сосед: первый просмотр, навыков в коде: ') + fresh.slice(0, 12).join(', ') + (fresh.length > 12 ? ' и ещё ' + (fresh.length - 12) : '');
  addTrigger(st, now, L, { type: 'neighbor', key: 'neighbor', item: { at: now, kind: 'neighbor', ref: 'http://127.0.0.1:3099/showcase', text: short(text, 300) } });
}

// ---------- команды ----------
function scan(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  let st = loadState(P);
  if (!st) { st = freshState(P, now, L); writeJson(P.state, st); return { ok: true, init: true, pending: 0 }; }
  // старая очередь: ожидающие «итог дня» и разовый перенос правил больше не разбираются
  for (const c of st.cases) if (c.status === 'pending' && (c.type === 'day' || c.type === 'migrate')) { c.status = 'dropped'; c.finishedAt = now; c.result = 'тип больше не разбирается'; }
  scanBlackbox(st, P, now, L);
  scanEvents(st, P, now, L);
  scanRunner(st, P, now, L);
  scanNeighbor(st, P, now, L, cfg);
  let coded = []; try { coded = resolveByCode(st, P, now, L, cfg); } catch (e) { coded = ['учитель: разбор кодом: ' + short(e && e.message || e, 100)]; }
  const led = ledgerTick(st, P, now, L, cfg).concat(coded);
  for (const k of Object.keys(st.doneAt || {})) if (now - st.doneAt[k] > 6 * 3600 * 1000) delete st.doneAt[k];
  for (const k of Object.keys(st.kindSlug || {})) if (now - (st.kindSlug[k].at || 0) > 30 * 86400000) delete st.kindSlug[k];
  for (const k of Object.keys(st.fails)) if (now - (st.fails[k].at || 0) > 6 * 3600 * 1000) delete st.fails[k];
  for (const k of Object.keys(st.cooldown)) if (st.cooldown[k] <= now) delete st.cooldown[k];
  const fin = st.cases.filter(c => c.status !== 'pending' && c.status !== 'working');
  if (fin.length > L.MAX_FINISHED) { const drop = new Set(fin.slice(0, fin.length - L.MAX_FINISHED)); st.cases = st.cases.filter(c => !drop.has(c)); }
  writeJson(P.state, st);
  return { ok: true, pending: st.cases.filter(c => c.status === 'pending').length, working: (st.cases.find(c => c.status === 'working') || {}).id || null, ...(led.length ? { ledger: led } : {}) };
}

// ---------- бухгалтерия ----------
const ledgerCfg = (P, cfg) => ({ dataDir: P.dataDir, brainDir: P.brainDir, now: cfg.now, ledgerLimits: cfg.ledgerLimits });
// раз в цикл: оплата / устаревание / ПОВТОР; счёт набрал порог — случай-«счёт» в очередь (сразу к разбору, без ожидания тишины)
function ledgerTick(st, P, now, L, cfg) {
  try {
    const liveCases = st.cases.filter(c => c.status === 'pending' || c.status === 'working').map(c => c.id);
    const r = ledger.tick(ledgerCfg(P, cfg), { liveCases, enqueue: (acc, info) => {
      const c = addTrigger(st, now, L, { type: 'invoice', key: 'invoice:' + acc.slug, item: { at: now, kind: 'invoice', ref: 'data/teacher_ledger.json',
        text: short(`счёт ${acc.slug} (${info.kind}): ${acc.title} — ${Math.round(info.balance)} мин при пороге ${info.threshold} (загрузка инженера ${info.load})${info.redo ? ', прошлая заявка не помогла — переделать' : ''}`, 240) } }, true);
      if (!c) return null;
      c.slug = acc.slug; return c.id;
    } });
    return r.msgs || [];
  } catch (e) { return ['бухгалтерия: ' + short(e && e.message || e, 120)]; }
}
function invoiceMaterial(c, P, cfg) {
  let acc = null; try { acc = ledger.invoiceMaterial(ledgerCfg(P, cfg), c.slug); } catch (e) {}
  return {
    id: c.id, type: c.type, typeRu: TYPE_RU.invoice, firstAt: new Date(c.firstAt).toISOString(),
    report: `data/teacher/${c.id}-invoice.md`,
    task: 'Счёт набрал порог: напиши ОДНУ заявку по этому счёту (вид core — запрос в brain/core_requests.md, иначе brain/skill_requests/<имя>.md) из доказательств ниже и отчёт. Проводок не пиши.',
    account: acc, signals: c.items
  };
}

// «Глаза» (tools/eyes.js, data/eyes.log): записи с (первый сигнал − 5 мин) по (последний сигнал + 1 мин); нет журнала или записей — поля нет
function caseEyes(c, P) {
  try {
    const ats = (c.items || []).map(i => i.at).filter(Number.isFinite).concat([c.firstAt, c.lastAt].filter(x => Number.isFinite(x) && x > 0));
    if (!ats.length) return null;
    const lines = eyesLib.eyesForCase(P.dataDir, Math.min(...ats) - 5 * 60000, Math.max(...ats) + 60000);
    return lines.length ? lines : null;
  } catch (e) { return null; }
}

// ---------- разбор кодом ----------
// Созревший случай: каждый сигнал получает вердикт — model (нужна модель) | close (закрыть без проводки) | heal (справилась сама) | post (проводка на счёт).
// Случай разбирается кодом, только если НИ ОДИН сигнал не требует модели. Сигналы без поля d (старая очередь) — модели.
function isDue(c, now, L) {
  if (!(now - c.lastAt >= L.QUIET_MS || now - c.firstAt >= L.MAX_WAIT_MS)) return false;
  // чисто провальный случай ждёт ещё: вдруг навык за 10 мин справится сам (потолок ожидания — вдвое дольше)
  if (c.type === 'fail' && c.items.every(i => i.kind === 'fail')) return now - c.lastAt >= L.HEAL_MS || now - c.firstAt >= 2 * L.HEAL_MS;
  return true;
}

function itemVerdict(it, X) {
  const d = it.d || null, L = X.L;
  const post = (slug, title, kind, min, key) => ({ act: 'post', slug, title, kind, min, key: key || slug, it });
  // счёт под этим видом есть (или модель когда-то разобрала такой вид и провела на свой счёт) — повтор кодом; нет — первый случай нового вида, модели
  const byAccount = (key, title, kind, min) => {
    const ks = X.kindSlug[key];
    const slug = X.accounts[key] ? key : (ks && X.accounts[ks.slug] ? ks.slug : null);
    return slug ? post(slug, title, kind, min, key) : { act: 'model', key };
  };
  if (it.kind === 'neighbor') return { act: 'close', why: 'новое у соседа — разбирать нечего' };
  if (!d) return { act: 'model' };
  if (it.kind === 'fail') {
    const t = X.doneAt[d.key];
    if (t != null && t > it.at && t - it.at <= L.HEAL_MS) return { act: 'heal', why: `${d.name} справилась сама (успех через ${Math.round((t - it.at) / 60000)} мин)` };
    const r = String(d.reason || ''), kind = d.skill ? 'skill' : 'behavior';
    if (/нужен инструмент/i.test(r)) return post('gather_tool_missing', 'не хватает инструмента для добычи', kind, 2);
    if (/путь не найден/i.test(r)) { const n = slugOf(d.name); return n && slugOf(n + '_path') ? post(n + '_path', `${d.name}: путь не найден`, kind, 2) : { act: 'model' }; }
    if (/нет в инвентаре|не хватило/i.test(r)) return { act: 'close', why: `${d.name}: не хватило материалов — копится само, не вина кода` };
    return { act: 'model' };
  }
  if (it.kind === 'near') {
    if (typeof d.minHp !== 'number') return { act: 'model' };
    if (d.minHp > 4) return { act: 'close', why: `почти-смерть, выжила (HP не ниже ${d.minHp}) — рефлекс сработал штатно` };
    const n = slugOf('near_' + (slugOf(d.task) || 'unknown'));
    return n ? post(n, `почти-смерть на задаче ${d.task || '?'} (HP ${d.minHp})`, 'behavior', 5) : { act: 'model' };
  }
  if (it.kind === 'death') {
    let c = String(d.cause || '').toLowerCase().trim(); c = CAUSE_RU[c] || c.replace(/\s+/g, '_');
    if (!MOBS.has(c)) return { act: 'model' };   // убил игрок (или неясно) — модели
    const ph = PHASE_EN[String(d.phase || '').toLowerCase()] || 'any';
    const key = slugOf(`death_${c}_${ph}`);
    return key ? byAccount(key, `смерть: ${c}, ${d.phase || 'время неизвестно'}`, 'behavior', 30) : { act: 'model' };
  }
  if (it.kind === 'idle') {
    if (!d.reason) return { act: 'model' };
    const key = d.reason === 'tool' ? 'gather_tool_missing' : 'idle_' + d.reason;
    return byAccount(key, `простой стройки: ${d.reason}`, 'behavior', Math.max(30, Number(d.min) || 0));
  }
  if (it.kind === 'stuck') {
    const n = slugOf('stuck_' + (slugOf(d.task) || 'unknown'));
    return n ? post(n, `застряла на задаче ${d.task || '?'}`, 'behavior', 15) : { act: 'model' };
  }
  return { act: 'model' };   // owner, invoice, прочее
}

function caseVerdict(c, X) {
  if (c.type === 'owner' || c.type === 'invoice' || c.type === 'day' || c.type === 'migrate') return { act: 'model' };
  const vs = c.items.map(it => itemVerdict(it, X));
  const ms = vs.filter(v => v.act === 'model');
  if (ms.length) { const ks = new Set(ms.map(v => v.key || '')); return { act: 'model', learnKey: ks.size === 1 && !ks.has('') ? [...ks][0] : null, keep: c.items.filter((it, i) => vs[i].act !== 'heal') }; }
  const posts = []; for (const v of vs) if (v.act === 'post' && !posts.some(p => p.slug === v.slug)) posts.push(v);
  const why = [...new Set(vs.filter(v => v.why).map(v => v.why))];
  if (!posts.length) return { act: 'close', why: why.join('; ') || 'нечего разбирать' };
  return { act: 'post', posts: posts.slice(0, 2), why: why.join('; ') };
}

const noBar = s => String(s == null ? '' : s).replace(/[|`]/g, '/');
const evRef = it => String(it.ref || '').replace(/^data\//, '').replace(/\s*\(.*\)$/, '');
// последняя осмысленная строка глаз (без «Без изменений») — доказательство в проводку
function eyesQuote(c, P) {
  const lines = caseEyes(c, P) || [];
  const l = lines.slice().reverse().find(x => !/Без изменений/i.test(x));
  if (!l) return '';
  return short(noBar(l.replace(/^\[[^\]]*\]\s*(\([^)]*\)\s*)?/, '')), 140);
}

function setCooldowns(st, c, now, L) {
  for (const k of c.keys) if (k.startsWith('fail:') || k === 'stuck') st.cooldown[k] = now + L.COOLDOWN_MS;
  if (c.keys.includes('idle')) st.cooldown.idle = now + L.IDLE_COOLDOWN_MS;   // после разбора простоя — час, чтобы заявка успела сработать
}

function writeCodeReport(P, c, verdict, lines) {
  const items = c.items.slice(0, 5).map(i => `- ${short(i.text, 160)} [${evRef(i)}]`);
  const text = [`# ${TYPE_RU[c.type] || c.type}: разобрано кодом — ${short(verdict, 120)}`, `Вердикт: код (разобрано кодом, модель не запускалась) — ${verdict}`, 'Сигналы:', ...items, ...lines, 'Модель: —'].join('\n') + '\n';
  const rel = `data/teacher/${c.id}-${c.type}.md`;
  fs.mkdirSync(P.reports, { recursive: true });
  fs.writeFileSync(path.join(P.reports, path.basename(rel)), text);
  c.report = rel;
}

// -> [сообщения для журнала сторожа]; ошибка разбора случай не ломает — он уйдёт модели
function resolveByCode(st, P, now, L, cfg) {
  const msgs = [];
  let accounts = {}; try { accounts = ledger.load(ledger.paths(ledgerCfg(P, cfg)), now).accounts || {}; } catch (e) {}
  const X = { L, accounts, kindSlug: st.kindSlug || {}, doneAt: st.doneAt || {} };
  for (const c of st.cases.filter(x => x.status === 'pending' && isDue(x, now, L))) {
    try {
      const v = caseVerdict(c, X);
      if (v.act === 'model') { c.learnKey = v.learnKey || null; if (v.keep.length && v.keep.length < c.items.length) c.items = v.keep; continue; }   // справившиеся сами сигналы из материалов убираем
      let lines = [], res = '', verdict = v.why || '';
      if (v.act === 'post') {
        const eyes = eyesQuote(c, P);
        lines = v.posts.map(p => `Проводка: ${p.slug} | ${noBar(p.title)} | ${p.kind} | ${p.min} | ${noBar(evRef(p.it))}${eyes ? `; глаза: «${eyes}»` : ''}`);
        verdict = `повтор известного вида — ${v.posts.map(p => p.slug).join(', ')}` + (v.why ? `; ${v.why}` : '');
        writeCodeReport(P, c, verdict, lines);
        const lr = ledger.caseFinished(ledgerCfg(P, cfg), { id: c.id, type: c.type, items: c.items, startedAt: now }, 'done', lines.join('\n'));
        res = 'разобрано кодом' + (lr.posted.length ? '; проводки: ' + lr.posted.join(', ') : '');
      } else {
        writeCodeReport(P, c, verdict, []);
        res = 'разобрано кодом: ' + short(verdict, 120);
      }
      c.status = 'done'; c.finishedAt = now; c.result = res; c.byCode = true; st.coded = (st.coded || 0) + 1;
      setCooldowns(st, c, now, L);
      msgs.push(`учитель: ${c.id} (${c.type}) разобран кодом — ${short(verdict, 100)}`);
    } catch (e) { msgs.push(`учитель: разбор кодом ${c.id} не вышел (${short(e && e.message || e, 80)}) — уйдёт модели`); }
  }
  return msgs;
}

function caseMaterial(c, P, L, cfg = {}) {
  if (c.type === 'invoice') return invoiceMaterial(c, P, cfg);
  const eyes = caseEyes(c, P);
  let accounts = null; try { accounts = ledger.statement(ledgerCfg(P, cfg)); } catch (e) {}
  return {
    id: c.id, type: c.type, typeRu: TYPE_RU[c.type], firstAt: new Date(c.firstAt).toISOString(), lastAt: new Date(c.lastAt || c.firstAt).toISOString(),
    report: `data/teacher/${c.id}-${c.type}.md`,
    signals: c.items.map(({ d, ...i }) => i), more: c.more || 0,
    eventsTail: tailLines(P.events, L.EVENTS_TAIL),                                               // строки data/events.log на момент взятия
    runnerTail: tailLines(P.runner, 400).filter(l => /"type":"(run_end|auto_disable|run_start)"/.test(l)).slice(-L.RUNNER_TAIL),
    ...(eyes ? { eyes } : {}),                                                                     // что видели глаза (data/eyes.log) в окне случая
    ...(accounts ? { accounts } : {})                                                              // выписка счетов бухгалтерии: переиспользуй slug
  };
}

// ---------- бюджет запусков ----------
function noteLaunch(st, now, type, L) {
  st.launches = (st.launches || []).filter(x => now - x.t < 86400000).concat([{ t: now, type }]).slice(-L.MAX_LAUNCHES);
}
// -> { hour: {n, over, retryAt}, day: {n, over, retryAt} }; retryAt — когда освободится самый старый запуск в окне
function budget(st, now, L) {
  const ls = (st.launches || []).filter(x => now - x.t < 86400000);
  const hs = ls.filter(x => now - x.t < 3600000 && !BUDGET_FREE.has(x.type));
  const mk = (arr, lim, win) => ({ n: arr.length, over: arr.length >= lim, retryAt: arr.length >= lim ? arr[arr.length - lim].t + win : null });
  return { hour: mk(hs, L.HOUR_LIMIT, 3600000), day: mk(ls, L.DAY_LIMIT, 86400000) };
}
// для сторожа: можно ли запускать помощника (он считается в том же бюджете как обычный случай)
function budgetCheck(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { ok: true, over: false };
  const b = budget(st, now, L);
  const which = b.day.over ? 'day' : b.hour.over ? 'hour' : null;
  return { ok: true, over: !!which, ...(which ? { budget: which, retryAt: b[which].retryAt } : {}), hour: b.hour.n, day: b.day.n };
}
function noteHelper(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { ok: true };
  noteLaunch(st, now, 'helper', L); writeJson(P.state, st);
  return { ok: true };
}

function take(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { none: true };
  const w = st.cases.find(c => c.status === 'working');
  if (w) {
    if (now - (w.startedAt || 0) < L.STALE_MS) return { busy: w.id };
    w.status = 'failed'; w.result = 'потерян (сторож перезапускался)'; w.finishedAt = now;
  }
  let due = st.cases.filter(c => c.status === 'pending' && isDue(c, now, L))
    .sort((a, b) => PRIO[a.type] - PRIO[b.type] || a.firstAt - b.firstAt);
  if (!due.length) { writeJson(P.state, st); return { none: true }; }
  // бюджет запусков модели: сутки — для всех, час — не для хозяина и счёта
  const bud = budget(st, now, L);
  if (bud.day.over) { writeJson(P.state, st); return { none: true, budget: 'day', retryAt: bud.day.retryAt }; }
  if (bud.hour.over) {
    due = due.filter(c => BUDGET_FREE.has(c.type));
    if (!due.length) { writeJson(P.state, st); return { none: true, budget: 'hour', retryAt: bud.hour.retryAt }; }
  }
  const c = due[0];
  noteLaunch(st, now, c.type, L);
  c.status = 'working'; c.startedAt = now;
  const caseFile = path.join(P.cases, c.id + '.json');
  // повтор после технического сбоя: материал прежний (хвост событий — на момент первого взятия, а не сейчас)
  let mat = null; if (c.techTries) { try { mat = JSON.parse(fs.readFileSync(caseFile, 'utf8')); } catch (e) {} }
  if (!mat) { mat = caseMaterial(c, P, L, cfg); writeJson(caseFile, mat); }
  c.report = mat.report;
  try { c.coreIds = ledger.coreIds(ledgerCfg(P, cfg)); } catch (e) {}   // какие запросы ядра были до разбора — новый привяжется к счёту
  writeJson(P.state, st);
  return { id: c.id, type: c.type, caseFile: 'data/teacher_cases/' + c.id + '.json', report: c.report };
}

// журнал разбора (data/teacher-<id>.log, дописывается при каждом запуске): с прошлой отметки — только этот запуск
const TECH_RE = /UnknownError|Unexpected server error|ProviderModelNotFound|Model not found|Rate limit exceeded|Free usage limit/;
function techFail(P, c, how) {
  if (how === 'timeout') return 'разбор завис';
  const log = path.join(P.dataDir, `teacher-${c.id}.log`);
  let s = ''; try { s = fs.readFileSync(log, 'utf8'); } catch (e) { return null; }
  const part = s.slice(c.logAt || 0); c.logAt = s.length;
  const m = part.match(TECH_RE); return m ? 'модель: ' + m[0] : null;
}

function finish(cfg = {}, id, how = 'ok') {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { ok: false, error: 'нет очереди' };
  const c = st.cases.find(x => x.id === id);
  if (!c) return { ok: false, error: 'нет случая ' + id };
  if (how === 'limit') { c.status = 'pending'; delete c.startedAt; writeJson(P.state, st); return { ok: true, id, status: c.status }; }
  let rep = null; try { rep = fs.statSync(path.join(P.reports, path.basename(c.report || (id + '.md')))); } catch (e) {}
  const wrote = rep && rep.mtimeMs >= (c.startedAt || 0) - 2000;
  // технический сбой (модель недоступна/упала, разбор завис) — не вина разбора: случай обратно в очередь, до TECH_TRIES раз
  const tech = !wrote && techFail(P, c, how);
  if (tech && (c.techTries || 0) < L.TECH_TRIES) {
    c.techTries = (c.techTries || 0) + 1; c.techWhy = tech; c.status = 'pending'; delete c.startedAt;
    writeJson(P.state, st); return { ok: true, id, status: c.status, tech };
  }
  c.finishedAt = now;
  c.status = wrote ? 'done' : 'failed';
  c.result = c.status === 'done' ? 'отчёт написан' : `нет отчёта (${tech ? `техсбой ${c.techTries} раз подряд: ${tech}` : how})`;
  // бухгалтерия: проводки из отчёта, у случая-счёта — привязка заявки; сбой бухгалтерии очередь не ломает
  try {
    let text = ''; if (wrote) { try { text = fs.readFileSync(path.join(P.reports, path.basename(c.report || (id + '.md'))), 'utf8'); } catch (e) {} }
    const lr = ledger.caseFinished(ledgerCfg(P, cfg), { id: c.id, type: c.type, items: c.items, startedAt: c.startedAt, coreIds: c.coreIds, slug: c.slug }, c.status, text);
    if (lr.posted.length) {
      c.result += '; проводки: ' + lr.posted.join(', ');
      if (c.learnKey && lr.posted[0]) { st.kindSlug = st.kindSlug || {}; st.kindSlug[c.learnKey] = { slug: lr.posted[0].split(' ')[0], at: now }; }   // вид разобран моделью — повторы дальше кодом, на тот же счёт
    }
    if (lr.linked) c.result += '; заявка: ' + lr.linked;
  } catch (e) { c.result += '; бухгалтерия: ' + short(e && e.message || e, 80); }
  setCooldowns(st, c, now, L);
  writeJson(P.state, st);
  return { ok: true, id, status: c.status };
}

function release(cfg = {}) {
  const P = paths(cfg), st = loadState(P); if (!st) return { ok: true, released: [] };
  const w = st.cases.filter(c => c.status === 'working');
  for (const c of w) { c.status = 'pending'; delete c.startedAt; }
  if (w.length) writeJson(P.state, st);
  return { ok: true, released: w.map(c => c.id) };
}

module.exports = { DEFAULTS, PRIO, TYPE_RU, OWNER, INTERRUPT_RE, paths, scan, take, finish, release, budgetCheck, noteHelper, addTrigger, eventTime, norm, readNew, loadState };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  let r;
  try {
    if (cmd === 'scan') r = scan();
    else if (cmd === 'take') r = take();
    else if (cmd === 'finish') r = finish({}, a, b);
    else if (cmd === 'release') r = release({});
    else if (cmd === 'budget') r = budgetCheck({});
    else if (cmd === 'note') r = noteHelper({});
    else r = { ok: false, error: 'команды: scan | take | finish <id> <ok|timeout|crash|limit> | release | budget | note helper' };
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  // только ASCII: PowerShell читает вывод в своей кодировке
  process.stdout.write(JSON.stringify(r).replace(/[\u0080-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
}
