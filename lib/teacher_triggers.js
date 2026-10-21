// Очередь случаев для учителя (brain/TEACHER_PROMPT.md). Ядро: учитель и инженер этот файл не меняют.
// Сторож (brain_guard.ps1) раз в 30 с зовёт:  node lib/teacher_triggers.js scan   — найти новые случаи;
//   take — взять следующий (печатает {"id","type","caseFile","report"} или {"busy"}/{"none"}); finish <id> <ok|timeout|crash> — закрыть.
// Источники (только чтение): data/blackbox/*.json (смерть, почти-смерть), data/events.log (провалы задач, застревание, итог дня,
// сообщения хозяина), brain/runner.log (провалы выученных навыков). Всплески склеиваются в один случай; один учитель за раз.
// Состояние — data/teacher_queue.json; материалы случая для учителя — data/teacher_cases/<id>.json; отчёт учитель пишет в data/teacher/<id>.md.
// Только факты и счётчики: тактик и решений здесь нет.
'use strict';
const fs = require('fs');
const path = require('path');
const bbFiles = require('./blackbox_files');

const ROOT = path.join(__dirname, '..');
const OWNER = 'eblanitus228';
const DEFAULTS = {
  QUIET_MS: 90 * 1000,            // случай ждёт 90 с тишины — всплеск склеивается в один
  MAX_WAIT_MS: 10 * 60 * 1000,    // но не дольше 10 мин от первого сигнала
  MERGE_MS: 5 * 60 * 1000,        // смерть/провал/застревание в пределах 5 мин от прошлого сигнала — тот же случай
  COOLDOWN_MS: 30 * 60 * 1000,    // тот же провал / застревание после разбора — снова не раньше чем через 30 мин (смерть — всегда)
  STUCK_WINDOW_MS: 10 * 60 * 1000, STUCK_FAILS: 6, // застряла: за 10 мин ≥ 6 провалов задач и ни одной успешной (кроме мелочей)
  STALE_MS: 40 * 60 * 1000,       // «в работе» дольше — сторож потерял учителя, случай закрывается как провал
  MAX_PENDING: 20, MAX_FINISHED: 80, MAX_ITEMS: 40, MAX_SEEN: 400,
  MAX_READ: 2 * 1024 * 1024,      // за один проход читаем не больше 2 МБ нового журнала
  EVENTS_TAIL: 150, RUNNER_TAIL: 40
};
const PRIO = { death: 1, near: 2, owner: 3, stuck: 4, fail: 5, day: 6, migrate: 7 };
const TYPE_RU = { death: 'смерть', near: 'почти-смерть', owner: 'сообщение хозяина', stuck: 'застряла', fail: 'провал дважды', day: 'итог дня', migrate: 'разовая: перенос правил' };
const INCIDENT = new Set(['death', 'near', 'stuck', 'fail']);
const TRIVIAL = new Set(['chat', 'eat', 'equip_item', 'look', 'stop', 'status', 'mark', 'say']);

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
    fails: {}, recent: [], cooldown: {}, suppressed: 0, dropped: 0, cases: []
  };
  // разовая задача при первом запуске: перенести полезное из «Выученных правил» notes.md в учебник
  addTrigger(st, now, L, { type: 'migrate', key: 'migrate', item: { at: now, kind: 'migrate', ref: 'brain/notes.md', text: 'первый запуск учителя: перенести полезные правила из notes.md в brain/lessons.md' } }, true);
  return st;
}

// ---------- склейка ----------
function addTrigger(st, now, L, trig, due = false) {
  const { type, key, item } = trig;
  if ((type === 'fail' || type === 'stuck') && st.cooldown[key] && st.cooldown[key] > now) { st.suppressed++; return null; }
  const pending = st.cases.filter(c => c.status === 'pending');
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
    addTrigger(st, now, L, { type: kind, key: kind, item: { at: r.ok && r.data.savedAt ? Date.parse(r.data.savedAt) || now : now, kind, ref: 'data/blackbox/' + name, text: short(text, 240), by } });
  }
  if (st.blackboxSeen.length > L.MAX_SEEN) st.blackboxSeen = st.blackboxSeen.slice(-L.MAX_SEEN);
}

function failSeen(st, now, L, key, sig, item) {
  const f = st.fails[key];
  if (f && f.sig === sig) f.n++; else st.fails[key] = { sig, n: 1 };
  st.fails[key].at = now;
  if (st.fails[key].n >= 2) { st.fails[key].n = 0; addTrigger(st, now, L, { type: 'fail', key: 'fail:' + key + ':' + sig, item }); } // каждая следующая пара — снова сигнал (в паузе после разбора — молча)
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
      st.recent.push({ at, ok: false });
      failSeen(st, now, L, String(e.name), norm(e.reason), { at, kind: 'fail', ref, by: e.by || e.source || null, text: short(`${e.name} провалился дважды подряд: ${e.reason}`, 240) });
    } else if (e.type === 'task_done') {
      delete st.fails[String(e.name)];
      if (!TRIVIAL.has(e.name)) st.recent.push({ at, ok: true });
    } else if (e.type === 'death') {
      addTrigger(st, now, L, { type: 'death', key: 'death', item: { at, kind: 'death', ref, text: short(`смерть: ${e.cause || ''} ${e.message || ''}`, 240) } });
    } else if (e.type === 'day_report') {
      addTrigger(st, now, L, { type: 'day', key: 'day:' + e.day, item: { at, kind: 'day', ref, text: short(e.line || ('день ' + e.day), 240) } });
    } else if (e.type === 'owner_msg' || (e.type === 'chat' && e.from === OWNER)) {
      const text = String(e.text || '').trim();
      if (text.length >= 2) addTrigger(st, now, L, { type: 'owner', key: 'owner', item: { at, kind: 'owner', ref, text: short(text, 300) } });
    }
  }
  // застряла: в окне много провалов и ни одного успеха
  st.recent = st.recent.filter(x => now - x.at <= L.STUCK_WINDOW_MS);
  const bad = st.recent.filter(x => !x.ok).length, good = st.recent.filter(x => x.ok).length;
  if (bad >= L.STUCK_FAILS && good === 0) {
    addTrigger(st, now, L, { type: 'stuck', key: 'stuck', item: { at: now, kind: 'stuck', ref: 'data/events.log (task_failed за 10 мин)', text: `застряла: за ${Math.round(L.STUCK_WINDOW_MS / 60000)} мин ${bad} провалов задач и ни одной успешной` } });
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
    if (e.ok) { delete st.fails[key]; continue; }
    const at = Date.parse(e.time) || now;
    failSeen(st, now, L, key, norm(e.error), { at, kind: 'fail', ref: `brain/runner.log #${e.id} (${e.time})`, by: 'skill:' + e.name, text: short(`навык ${e.name} провалился дважды подряд: ${e.error}`, 240) });
  }
}

// ---------- команды ----------
function scan(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  let st = loadState(P);
  if (!st) { st = freshState(P, now, L); writeJson(P.state, st); return { ok: true, init: true, pending: 1 }; }
  scanBlackbox(st, P, now, L);
  scanEvents(st, P, now, L);
  scanRunner(st, P, now, L);
  for (const k of Object.keys(st.fails)) if (now - (st.fails[k].at || 0) > 6 * 3600 * 1000) delete st.fails[k];
  for (const k of Object.keys(st.cooldown)) if (st.cooldown[k] <= now) delete st.cooldown[k];
  const fin = st.cases.filter(c => c.status !== 'pending' && c.status !== 'working');
  if (fin.length > L.MAX_FINISHED) { const drop = new Set(fin.slice(0, fin.length - L.MAX_FINISHED)); st.cases = st.cases.filter(c => !drop.has(c)); }
  writeJson(P.state, st);
  return { ok: true, pending: st.cases.filter(c => c.status === 'pending').length, working: (st.cases.find(c => c.status === 'working') || {}).id || null };
}

function caseMaterial(c, P, L) {
  return {
    id: c.id, type: c.type, typeRu: TYPE_RU[c.type], firstAt: new Date(c.firstAt).toISOString(), lastAt: new Date(c.lastAt || c.firstAt).toISOString(),
    report: `data/teacher/${c.id}-${c.type}.md`,
    signals: c.items, more: c.more || 0,
    eventsTail: tailLines(P.events, L.EVENTS_TAIL),                                               // строки data/events.log на момент взятия
    runnerTail: tailLines(P.runner, 400).filter(l => /"type":"(run_end|auto_disable|run_start)"/.test(l)).slice(-L.RUNNER_TAIL)
  };
}

function take(cfg = {}) {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { none: true };
  const w = st.cases.find(c => c.status === 'working');
  if (w) {
    if (now - (w.startedAt || 0) < L.STALE_MS) return { busy: w.id };
    w.status = 'failed'; w.result = 'потерян (сторож перезапускался)'; w.finishedAt = now;
  }
  const due = st.cases.filter(c => c.status === 'pending' && (now - c.lastAt >= L.QUIET_MS || now - c.firstAt >= L.MAX_WAIT_MS))
    .sort((a, b) => PRIO[a.type] - PRIO[b.type] || a.firstAt - b.firstAt);
  if (!due.length) { writeJson(P.state, st); return { none: true }; }
  const c = due[0];
  c.status = 'working'; c.startedAt = now;
  const mat = caseMaterial(c, P, L);
  c.report = mat.report;
  const caseFile = path.join(P.cases, c.id + '.json');
  writeJson(caseFile, mat);
  writeJson(P.state, st);
  return { id: c.id, type: c.type, caseFile: 'data/teacher_cases/' + c.id + '.json', report: c.report };
}

function finish(cfg = {}, id, how = 'ok') {
  const P = paths(cfg), L = { ...DEFAULTS, ...(cfg.limits || {}) }, now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P); if (!st) return { ok: false, error: 'нет очереди' };
  const c = st.cases.find(x => x.id === id);
  if (!c) return { ok: false, error: 'нет случая ' + id };
  let rep = null; try { rep = fs.statSync(path.join(P.reports, path.basename(c.report || (id + '.md')))); } catch (e) {}
  c.finishedAt = now;
  c.status = rep && rep.mtimeMs >= (c.startedAt || 0) - 2000 ? 'done' : 'failed';
  c.result = c.status === 'done' ? 'отчёт написан' : `нет отчёта (${how})`;
  // разовая задача без отчёта — ещё две попытки
  if (c.status === 'failed' && c.type === 'migrate' && (c.tries || 0) < 2) { c.tries = (c.tries || 0) + 1; c.status = 'pending'; c.lastAt = 0; delete c.startedAt; }
  for (const k of c.keys) if (k.startsWith('fail:') || k === 'stuck') st.cooldown[k] = now + L.COOLDOWN_MS;
  writeJson(P.state, st);
  return { ok: true, id, status: c.status };
}

module.exports = { DEFAULTS, PRIO, TYPE_RU, OWNER, paths, scan, take, finish, addTrigger, eventTime, norm, readNew, loadState };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  let r;
  try {
    if (cmd === 'scan') r = scan();
    else if (cmd === 'take') r = take();
    else if (cmd === 'finish') r = finish({}, a, b);
    else r = { ok: false, error: 'команды: scan | take | finish <id> <ok|timeout|crash>' };
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  // только ASCII: PowerShell читает вывод в своей кодировке
  process.stdout.write(JSON.stringify(r).replace(/[\u0080-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
}
