// Бот этапа 1б (решение хозяина 04.11): одна жизнь = настоящий FlyBot — тело bot.js с автопилотом и рефлексами (behavior/)
// и исполнитель выученных навыков brain/runner.js. Свои решения стенд не пишет. Мозга (LLM) нет: автопилот работает сам, как ночью у FlyBot.
// Этот файл только запускает их, раз в секунду смотрит снимок тела (GET /snapshot, как наблюдатель — X-Observer: 1)
// и пишет карточку жизни в том же виде, что life.js: длина, первая ночь, ступени 1–6, события для ленты, последние 60 с.
// Память жизни — своя папка <ник>.fly\ рядом с карточкой: заметки (пустые — ни базы, ни целей старого мира), данные тела
// (variants.json, experience.json, свои блоки), статистика навыков. Выученные навыки brain\learned — общие, только чтение.
// Этап 1в (баттл-рояль, --br HC_): награда — убийства других мух. Тело получает HC_BR_PREFIX: мухи с этим префиксом законные цели
// для fight, в снимке есть панель локатора (lib/locator.js). Охотник здесь же (hardcore/br.js huntDecision): когда муха готова
// (HP, сытость, оружие или срок подготовки) и на локаторе есть другая муха — follow к ней, вблизи — fight. Остальное время — автопилот.
//   node hardcore/fly.js --host 127.0.0.1 --port 25566 --name HC_1 --version 26.1 --world <id> --seed <сид> --out <card.json> --maxSec 7260 [--br HC_]
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const L = require('./lib');
const BR = require('./br');
const P = require('./points');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const A = {
  host: arg('host', '127.0.0.1'), port: +arg('port', 25566), name: arg('name', 'HC_1'), version: arg('version', '26.1'),
  world: arg('world', ''), seed: arg('seed', ''), out: arg('out', `card-${Date.now()}.json`), maxSec: +arg('maxSec', 7260),
  ctlBase: +arg('ctlBase', 3310), runnerBase: +arg('runnerBase', 3410), joinSec: +arg('joinSec', 120),
  br: arg('br', ''),   // префикс ников мух баттл-рояля (этап 1в); пусто — обычный 1б
  pool: arg('pool', ''),  // этап 2: общая память пула навыков (hardcore/pool); пусто — пул выключен, day_routine/night_mine как раньше
  shared: arg('shared', ''),  // этап 2 (Б10): общая память мух (<папка>/variants.json, experience.json, decider.json); жизнь берёт копию, стенд сливает после мира
  group: arg('group', ''),    // этап 2 (Б11): learn — учащаяся муха, control — контроль (без проб решателя; общей памяти нет — stand не даёт --shared)
  stage2: arg('stage2', '') === '1'   // этап 2 (Б6+): охота и бой — дела решателя, охотник здесь только смотрит
};
const ROOT = path.join(__dirname, '..');
const num = Number((/(\d+)$/.exec(A.name) || [0, 0])[1]);
const CTL = A.ctlBase + num, RUN = A.runnerBase + num;
const life = path.join(path.dirname(path.resolve(A.out)), A.name + '.fly');
const dirs = { data: path.join(life, 'data'), runner: path.join(life, 'runner') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
if (A.shared) require('./memory').prepareLife(path.resolve(A.shared), life);   // Б10: копия общей памяти — в данные жизни (слияние — стенд, после мира)
const notes = path.join(life, 'notes.md');
if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Заметки\n\nНовый хардкор-мир: базы нет, целей нет.\n');

const env = Object.assign({}, process.env, {
  DATA_DIR: dirs.data, FLYBOT_NOTES: notes, FLYBOT_NO_BRAIN: '1', HC_STAND: '1', FLYBOT_LEDGER_LOG: path.join(life, 'inventory.jsonl'),   // журнал сумки: изменения, удары, смерть (lib/ledger.js)
  MC_VERSION: A.version, RUNNER_URL: `http://127.0.0.1:${RUN}`,
  RUNNER_PORT: String(RUN), BODY_URL: `http://127.0.0.1:${CTL}`, RUNNER_DATA: dirs.runner, RUNNER_LEARNED: path.join(ROOT, 'brain', 'learned'),
  ...(A.br ? { HC_BR_PREFIX: A.br } : {}),
  ...(A.shared ? { HC_DECIDER_MEM: path.join(path.resolve(A.shared), 'decider.json') } : {}),   // Б10: таблица решателя (читается раз за жизнь)
  ...(A.stage2 ? { HC_STAGE2: '1' } : {}), ...(A.group === 'control' ? { HC_EXPLORE: '0' } : {}),   // Б11: этап 2 у тела; контроль — без проб решателя
  ...(A.pool ? (A.stage2 ? { HC_POOL: '1' } : { HC_POOL_RUNS: path.resolve(A.pool) }) : {})   // без этапа 2: по HC_POOL_RUNS day_routine_v7 и night_mine_v7 берут навык из пула; на этапе 2 навыки пула — дела решателя (HC_POOL)
});
const kids = [];
function run(name, file, args) {
  const log = fs.openSync(path.join(life, name + '.log'), 'a');
  const p = spawn(process.execPath, [file, ...args], { cwd: ROOT, env, stdio: ['ignore', log, log], windowsHide: true });
  p.on('exit', code => { if (!written) console.log(`[fly] ${A.name}: ${name} вышел (${code})`); });
  kids.push(p);
  return p;
}

// --- наблюдение ---
const get = p => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: CTL, path: p, headers: { 'X-Observer': '1' }, timeout: 3000 }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});

// Команда телу от охотника (как мозг: с User-Agent, иначе тело примет её за исполнителя автопилота)
const post = (cmd, timeoutMs = 5000) => new Promise(resolve => {
  const body = JSON.stringify(cmd);
  const req = http.request({ host: '127.0.0.1', port: CTL, path: '/cmd', method: 'POST', timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'hc-hunter', 'Content-Length': Buffer.byteLength(body) } }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  req.end(body);
});

const t0 = Date.now();
const frames = [], chat = [];
const chron = L.makeChronicle();
const ladder = L.makeLadder();
const pts = P.makePoints();   // очки жизни (этап 2, А1–А3): ступени, ночи, убийства, простой, круг провалов
const deeds = [];             // дела жизни (этап 2, Б9): каждое начатое дело с обстановкой; награда — итог жизни (writeCard → deeds.jsonl)
let spawned = false, written = false, age0 = null, tod0 = null, wtStart = null, lastWt = null, lastSnap = null, evSince = 0, lowNoHealSec = 0;
let ptsNights = 0;
let lowest = { hp: 20, food: 20 }, eats = 0, flees = 0, everTable = false, wasClosed = false;
const exits = [], acts = {}, lastDeath = { msg: null };
// баттл-рояль: свои убийства, кто убил меня, охота (что видели на локаторе, наша текущая команда, счёт решений)
const kills = [], killSeen = new Set(), seenFlies = new Map(), hunt = { ours: null, follows: 0, fights: 0, legs: 0, legPending: false, why: null, lastAt: 0 };
let killedBy = null, aliveSnap = null;
const r1 = x => Math.round(x * 10) / 10;
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
const FOODS = (() => { try { return require('minecraft-data')(A.version).foodsByName || {}; } catch (e) { return {}; } })();

function frameOf(s) {
  const tm = s.eyes && s.eyes.time || {};
  const tod = s.time != null ? s.time : tm.tod;
  const wt = tm.day != null && tod != null ? Number(tm.day) * 24000 + tod : null;
  const en = s.eyes && Array.isArray(s.eyes.enemies) && s.eyes.enemies[0];
  const p = s.position;
  return { t: Math.round((Date.now() - t0) / 1000), hp: r1(s.health || 0), food: s.food, pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
    tod, wt, enemy: en ? { name: en.name, d: en.d } : null, task: s.eyes && s.eyes.task ? String(s.eyes.task.name || s.eyes.task).slice(0, 40) : null };
}

// Что делал автопилот — из журнала тела: начатые навыки → события ленты; итоги — счёт дел для карточки.
const NOTE = { eat: ['eat', 'ест'], escape: ['flee', 'бежит'], shelter: ['shelter', 'в укрытие'], wait_night: ['shelter', 'пережидает ночь'], defend: ['fight', 'отбивается'], fight: ['fight', 'дерётся'] };
async function readEvents() {
  const r = await get(`/events?since=${evSince}&limit=200`);
  if (!r || !Array.isArray(r.events)) return;
  for (const e of r.events) {
    evSince = Math.max(evSince, e.id || 0);
    const d = e.data || e;
    if (e.type === 'task_started' && NOTE[d.name]) {
      const [k, w] = NOTE[d.name];
      if (k === 'flee') flees++;   // еда — по итогу (task_done eat) и по автоеде («съел …»), а не по началу дела
      chron.note(lastWt, k, `${w}${d.by && d.by !== 'autopilot' ? ' (' + d.by + ')' : ''}`);
    }
    if (e.type === 'task_done' || e.type === 'task_failed') {
      const a = acts[d.name] || (acts[d.name] = { n: 0, ok: 0 }); a.n++; if (e.type === 'task_done' && !d.error) a.ok++;
      if (e.type === 'task_done' && d.name === 'eat') eats++;
    }
    if (e.type === 'info' && typeof d.msg === 'string' && /^съел /.test(d.msg)) eats++;   // автоеда тела (behavior/reflexes.js)
    if (e.type === 'death') lastDeath.msg = d.message || d.cause || null;
    if (e.type === 'deed' && (d.verdict === 'ok' || d.verdict === 'провал')) pts.deed(d.key, d.verdict === 'ok', Math.round((Date.now() - t0) / 1000));
    if (e.type === 'deed_start') deeds.push({ t: Math.round((Date.now() - t0) / 1000), key: d.key, name: d.name, sit: d.sit || null, coarse: d.coarse || null, explore: !!d.explore });
    if (e.type === 'deed') { // В1: итог дела — в последнее дело с тем же ключом без итога, чтобы в deeds.jsonl было видно, чем кончилось
      for (let i = deeds.length - 1; i >= 0; i--) if (deeds[i].key === d.key && !deeds[i].verdict) { deeds[i].verdict = d.verdict || null; deeds[i].sec = d.sec != null ? d.sec : null; break; }
    }
    if (e.type === 'chat' || e.type === 'system') {
      const m = String(d.msg || d.text || d.message || '');
      if (m.includes(A.name)) { chat.push(m.slice(0, 200)); while (chat.length > 20) chat.shift(); }
      if (A.br) { noteKill(m); noteGone(m); }
    }
  }
}

// Убийство муха → муха: из системного сообщения о смерти. Своё — в счёт (с оружием в руке в этот момент), меня — killedBy.
function noteKill(m) {
  if (!m || m.startsWith('<') || !L.DEATH_WORDS.test(m) || killSeen.has(m)) return;
  const k = BR.parseKill(m, A.br);
  if (!k) return;
  killSeen.add(m);
  if (k.killer === A.name) {
    const weapon = BR.weaponOf(lastSnap && lastSnap.heldItem);
    kills.push({ victim: k.victim, lifeSec: Math.round((Date.now() - t0) / 1000), wt: lastWt, weapon, hp: lastSnap ? r1(lastSnap.health || 0) : null, inv: invOf(lastSnap) });
    pts.kill(weapon, Math.round((Date.now() - t0) / 1000), k.victim);
    chron.note(lastWt, 'kill', `убил ${k.victim} (${weapon === 'fist' ? 'кулаком' : weapon})`);
    console.log(`[fly] ${A.name}: убил ${k.victim}, всего ${kills.length}`);
  } else if (k.victim === A.name) killedBy = k.killer;
}

// Муха умерла (любая смерть — от мухи, моба, падения) или ушла из игры — из памяти охотника вон и больше не цель.
// Раньше память держала мёртвую 120 с, она оставалась «ближайшей», и охотник 1189 раз шёл follow за трупом.
const gone = new Set();
function noteGone(m) {
  if (!m || m.startsWith('<')) return;
  const s = m.replace(/^.*?\]: /, '').trim(), who = s.split(/\s+/)[0].replace(/[.,!:;'"]+$/, '');
  if (!who || !who.startsWith(A.br) || who === A.name) return;
  if (L.DEATH_WORDS.test(s) || / left the game$/.test(s)) { gone.add(who); seenFlies.delete(who); }
  else if (/ joined the game$/.test(s)) gone.delete(who);
}

// Охотник баттл-рояля: раз в 2 с смотрит панель локатора из снимка и решает (br.huntDecision). Команды — только свои follow/fight/stop;
// чужое дело тела (рефлекс, автопилот бежит или ест) не перебивает.
// Дальняя метка: расстояние неизвестно — считаем FAR_D (дальше любой видимой); идём отрезками до LEG блоков (goto тела, LEG_SEC),
// после каждого — снова смотрим метку. Ближе NEAR_FOLLOW и муха загружена — follow.
const { FAR_D, LEG, LEG_SEC, NEAR_FOLLOW, farLeg } = BR;   // сами функции — в hardcore/br.js (их берёт и решатель, Б6)
const BUSY_SKILLS = new Set(['escape', 'eat', 'shelter', 'wait_night', 'defend', 'recover', 'swim_to', 'pillar_up']);
async function huntTick(s, f) {
  if (!A.br || Date.now() - hunt.lastAt < 2000) return;
  hunt.lastAt = Date.now();
  const now = Date.now();
  for (const m of s.locator || []) {
    if (!m || !m.name || !m.name.startsWith(A.br) || m.name === A.name || gone.has(m.name)) continue;
    if (m.gamemode === 3 || m.gamemode === 'spectator') { gone.add(m.name); seenFlies.delete(m.name); continue; }
    if (!m.onBar || m.hidden) continue;   // как у игрока: метка видна только в конусе 120° и если муха не прячется
    // дальняя метка (tracked_waypoint): позиция примерная (чанк) или только направление (heading) — расстояние неизвестно
    seenFlies.set(m.name, { name: m.name, d: m.d == null ? FAR_D : m.d, at: m.at, heading: m.heading || null, far: !!m.far, t: now });
  }
  if (A.stage2) { hunt.why = 'этап 2: охота — дело решателя в теле (hunt_go), охотник только смотрит'; return; }
  const ti = s.eyes && s.eyes.task && s.eyes.task.status !== 'done' ? s.eyes.task : null;
  const task = ti ? String(ti.name || ti) : null, taskBy = ti ? String(ti.by || ti.source || 'brain') : null;
  // наша команда кончилась или её вытеснили. goto — простая команда тела (не навык, в снимке задачи нет): жива, пока ждём её ответ
  if (hunt.ours && (hunt.ours.task === 'goto' ? !hunt.legPending : task !== hunt.ours.task)) hunt.ours = null;
  // шли к дальней метке, а муха уже загружена рядом — дальше follow (идём не к точке, а за ней)
  if (hunt.ours && hunt.ours.task === 'goto') { const m = seenFlies.get(hunt.ours.target); if (m && !m.far && m.d <= NEAR_FOLLOW) hunt.ours = null; }
  const armed = (s.inventory || []).some(i => /_(sword|axe)$/.test(i.name));
  const sit = {
    hp: f.hp, food: f.food == null ? 20 : f.food, lifeSec: f.t, armed, isNight: s.timeOfDay === 'night',
    busy: !hunt.ours && !!task && (BUSY_SKILLS.has(task) || task === 'fight' || /reflex/.test(taskBy)),
    seen: [...seenFlies.values()].map(m => ({ name: m.name, d: m.d, at: m.at, ago: Math.round((now - m.t) / 1000) })),
    ours: hunt.ours ? { ...hunt.ours, sec: Math.round((now - hunt.ours.at) / 1000) } : null
  };
  const dcs = BR.huntDecision(sit);
  hunt.why = dcs.why;
  if (dcs.act === 'none') return;
  if (dcs.act === 'stop') { await post({ action: 'stop' }); hunt.ours = null; chron.note(f.wt, 'hunt', `бросил охоту: ${dcs.why}`); return; }
  // идём к дальней метке, а решение другое (бой, follow) — сначала снять goto (stop тела обрывает путь), иначе новая команда ждёт его конца
  if (hunt.legPending && dcs.act !== 'stop') { await post({ action: 'stop' }); for (let i = 0; i < 20 && hunt.legPending; i++) await new Promise(r => setTimeout(r, 100)); }
  // follow — только к мухе, чья позиция у тела есть (иначе «игрок не найден рядом»); к дальней метке — goto ногами в её сторону
  const tm = seenFlies.get(dcs.target);
  const leg = dcs.act === 'follow' && tm && tm.far ? farLeg(s.position, tm) : null;
  if (dcs.act === 'follow' && tm && tm.far && !leg) { hunt.why = `${dcs.why} — метка без направления`; return; }
  if (leg) {   // goto тела отвечает, только когда дошла (или LEG_SEC) — не ждём, охотник смотрит дальше; ответ снимает hunt.legPending
    hunt.legPending = true;
    post({ action: 'goto', params: { x: leg.x, z: leg.z, timeout: LEG_SEC } }, (LEG_SEC + 20) * 1000).then(r => {
      hunt.legPending = false;
      if (r && r.ok === false) hunt.why = `к ${dcs.target}: ${String(r.error || '').slice(0, 80)}`;
    });
    hunt.ours = { kind: 'follow', task: 'goto', target: dcs.target, at: Date.now() };
    hunt.follows++; hunt.legs = (hunt.legs || 0) + 1;
    chron.note(f.wt, 'hunt', `${dcs.why} (метка далеко — иду в её сторону)`);
    return;
  }
  const r = dcs.act === 'fight'
    ? await post({ action: 'fight', params: { target: dcs.target, radius: 16, flee_hp: 6, timeout: 40 }, force: true })
    : await post({ action: 'follow', params: { name: dcs.target, range: 2 }, force: true });
  if (r && r.ok !== false) {
    hunt.ours = { kind: dcs.act, task: dcs.act === 'fight' ? 'fight' : 'follow', target: dcs.target, at: Date.now() };
    if (dcs.act === 'fight') hunt.fights++; else hunt.follows++;
    chron.note(f.wt, dcs.act === 'fight' ? 'fight' : 'hunt', dcs.why);
  } else hunt.why = `${dcs.why} — тело не взяло: ${r && r.error ? String(r.error).slice(0, 80) : 'нет ответа'}`;
}

// сумка из снимка тела: { предмет: n } (для убийства и смерти в карточке; подробный журнал — inventory.jsonl)
function invOf(s) { const m = {}; for (const i of (s && s.inventory) || []) m[i.name] = (m[i.name] || 0) + i.count; return m; }

function situation(s) {
  const inv = {}; let food = 0;
  for (const i of s.inventory || []) { inv[i.name] = (inv[i.name] || 0) + i.count; if (FOODS[i.name] && !BAD_FOOD.has(i.name)) food += i.count; }
  if (inv.crafting_table || Object.keys(inv).some(n => n.endsWith('_pickaxe'))) everTable = true;   // кирку без верстака не сделать
  return { inv, food, tablePlaced: everTable, nightSurvived: chron.events.some(e => e.kind === 'night_survived') };
}

let ticking = false;
async function tick() {
  if (written || ticking) return; ticking = true;
  try {
    if (Date.now() - t0 > A.maxSec * 1000) return finish('timeout', { note: 'свой срок --maxSec' });
    const s = await get('/snapshot');
    if (!s || !s.ready) {
      if (!spawned && Date.now() - t0 > A.joinSec * 1000) return finish('disconnect', { reason: `тело FlyBot не вошло в мир за ${A.joinSec} с` });
      return;
    }
    if (!spawned) {
      spawned = true;
      if (s.gameMode === 'spectator') return finish('already_dead', { note: 'вошёл зрителем — в этом мире уже умирал' });
      const f = frameOf(s); tod0 = f.tod; age0 = f.wt; wtStart = f.wt;
      chron.note(wtStart, 'start', 'старт (FlyBot, автопилот)');
      console.log(`[fly] ${A.name} в мире ${A.world}, тело :${CTL}, навыки :${RUN}${A.group ? `, группа: ${L.groupLabel({ group: A.group })}` : ''}`);
    }
    lastSnap = s;
    if ((s.health || 0) > 0 && s.gameMode !== 'spectator') aliveSnap = s;   // сумка «до смерти» — после смерти снимок уже пустой
    const f = frameOf(s);
    frames.push(f); while (frames.length > 60) frames.shift();
    if (f.wt != null) lastWt = f.wt;
    lowest.hp = Math.min(lowest.hp, f.hp); if (f.food != null) lowest.food = Math.min(lowest.food, f.food);
    if (f.hp < 10 && f.food != null && f.food < 18) lowNoHealSec++;
    chron.observe(f);
    while (ptsNights < chron.nights()) { ptsNights++; pts.night(f.t); } // пережил ночь → +1
    const tod = f.tod == null ? null : ((f.tod % 24000) + 24000) % 24000;
    pts.frame({ t: f.t, day: tod != null && !(tod >= 13000 && tod < 23000), pos: f.pos, inv: invOf(s) });
    // выход из укрытия (8.1): было закрыто со всех сторон — стало открыто; HP и сытость в этот момент — в карточку
    const closed = !!(s.sheltered && s.sheltered.closed);
    if (wasClosed && !closed) { exits.push({ lifeSec: f.t, wt: f.wt, hp: f.hp, food: f.food }); chron.note(f.wt, 'leave', `вышел: HP ${f.hp}, сытость ${f.food}`); }
    wasClosed = closed;
    for (const n of ladder.update(situation(s), f.t, f.wt)) { if (n <= 5) pts.step(n, f.t); chron.note(f.wt, 'stage', `ступень ${n}: ${L.STEP_TEXT[n]}`); console.log(`[fly] ${A.name}: ступень ${n} — ${L.STEP_TEXT[n]}`); }
    await readEvents();
    if (A.br && f.hp > 0 && s.gameMode !== 'spectator') await huntTick(s, f).catch(e => console.error('[fly] охотник:', e.message));
    if (s.gameMode === 'spectator' || f.hp <= 0) {
      await new Promise(r => setTimeout(r, 800)); await readEvents();
      const msg = L.deathMessage(chat, A.name) || lastDeath.msg;
      return finish('death', { deathMessage: msg, cause: L.causeOf(msg) || null });
    }
  } finally { ticking = false; }
}

function writeCard(result, extra = {}) {
  if (written) return; written = true;
  const endText = { death: extra.cause ? `смерть: ${extra.cause}` : 'смерть', timeout: 'срок мира вышел, жив', disconnect: 'отключился', crash: 'бот упал', already_dead: 'уже мёртв' }[result] || result;
  chron.note(lastWt, result === 'death' ? 'death' : 'end', endText);
  const lifeSec = Math.round((Date.now() - t0) / 1000);
  const last = exits[exits.length - 1];
  const rated = require('./decider').rewards(deeds, pts.total); // каждое дело жизни получает итог этой жизни (Б4): у рано погибшей мало очков
  try { fs.writeFileSync(path.join(life, 'deeds.jsonl'), rated.map(x => JSON.stringify(x)).join('\n') + (rated.length ? '\n' : '')); } catch (e) { console.error('дела не записаны:', e.message); }
  const card = {
    nick: A.name, world: A.world, seed: A.seed, result, mode: A.stage2 ? 'stage2' : (A.br ? 'stage1v-br' : 'stage1b-flybot'), group: A.group || null,
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), lifeSec,
    gameDays: age0 != null && lastWt != null ? r1((lastWt - age0) / 24000) : null,
    spawnTimeOfDay: tod0, firstNightSurvived: chron.events.some(e => e.kind === 'night_survived'),
    hpLast: frames.length ? frames[frames.length - 1].hp : null, foodLast: frames.length ? frames[frames.length - 1].food : null,
    lowest, eats, flees, wtStart, wtEnd: lastWt, events: chron.events, chat: chat.slice(-10), last60s: frames.slice(), interventions: 0,
    ladder: ladder.reached, topStep: ladder.top(), exits, actions: acts, lowHpNoHealSec: lowNoHealSec,
    deathSoonAfterExit: result === 'death' && !!last && lifeSec - last.lifeSec <= 60,
    autopilot: lastSnap && lastSnap.autopilot ? lastSnap.autopilot : null,
    invLast: invOf(aliveSnap), handLast: aliveSnap && aliveSnap.heldItem ? (aliveSnap.heldItem.name || aliveSnap.heldItem) : null,
    points: pts.toJSON(), pointsTotal: pts.total,
    deeds: { n: rated.length, explore: rated.filter(x => x.explore).length },
    ...(A.br ? { br: true, kills, killCount: kills.length, killsArmed: kills.filter(k => BR.isWeapon(k.weapon)).length, killedBy, hunt: { follows: hunt.follows, fights: hunt.fights, legs: hunt.legs, lastWhy: hunt.why } } : {}),
    ...extra
  };
  try { fs.writeFileSync(A.out, JSON.stringify(card, null, 1)); } catch (e) { console.error('карточка не записана:', e.message); }
  console.log(`[fly] ${A.name}: ${result}, ${lifeSec} с, высшая ступень ${ladder.top()}${A.br ? `, убийств ${kills.length}` : ''}, очков ${pts.total}`);
}
function finish(result, extra) {
  writeCard(result, extra);
  clearInterval(timer);
  for (const p of kids) try { p.kill(); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
}

// HC_FLY_BODY / HC_FLY_RUNNER — подмена тела и исполнителя в test/hardcore_fly.js
run('runner', process.env.HC_FLY_RUNNER || path.join(ROOT, 'brain', 'runner.js'), []);
run('body', process.env.HC_FLY_BODY || path.join(ROOT, 'bot.js'), [A.host, String(A.port), A.name, String(CTL)]);
const timer = setInterval(() => { tick().catch(e => console.error('[fly] тик:', e.message)); }, 1000);
process.stdin.on('data', d => { if (/quit/.test(String(d))) finish('timeout', { note: 'стенд: вышел срок мира' }); });
process.on('uncaughtException', e => { console.error('[fly] упал:', e.stack || e); finish('crash', { reason: String(e.message || e) }); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => finish('timeout', { note: 'стенд остановлен' }));
