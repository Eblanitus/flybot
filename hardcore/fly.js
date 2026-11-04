// Бот этапа 1б (решение хозяина 04.11): одна жизнь = настоящий FlyBot — тело bot.js с автопилотом и рефлексами (behavior/)
// и исполнитель выученных навыков brain/runner.js. Свои решения стенд не пишет. Мозга (LLM) нет: автопилот работает сам, как ночью у FlyBot.
// Этот файл только запускает их, раз в секунду смотрит снимок тела (GET /snapshot, как наблюдатель — X-Observer: 1)
// и пишет карточку жизни в том же виде, что life.js: длина, первая ночь, ступени 1–6, события для ленты, последние 60 с.
// Память жизни — своя папка <ник>.fly\ рядом с карточкой: заметки (пустые — ни базы, ни целей старого мира), данные тела
// (variants.json, experience.json, свои блоки), статистика навыков. Выученные навыки brain\learned — общие, только чтение.
//   node hardcore/fly.js --host 127.0.0.1 --port 25566 --name HC_1 --version 26.1 --world <id> --seed <сид> --out <card.json> --maxSec 7260
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const L = require('./lib');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const A = {
  host: arg('host', '127.0.0.1'), port: +arg('port', 25566), name: arg('name', 'HC_1'), version: arg('version', '26.1'),
  world: arg('world', ''), seed: arg('seed', ''), out: arg('out', `card-${Date.now()}.json`), maxSec: +arg('maxSec', 7260),
  ctlBase: +arg('ctlBase', 3310), runnerBase: +arg('runnerBase', 3410), joinSec: +arg('joinSec', 120)
};
const ROOT = path.join(__dirname, '..');
const num = Number((/(\d+)$/.exec(A.name) || [0, 0])[1]);
const CTL = A.ctlBase + num, RUN = A.runnerBase + num;
const life = path.join(path.dirname(path.resolve(A.out)), A.name + '.fly');
const dirs = { data: path.join(life, 'data'), runner: path.join(life, 'runner') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const notes = path.join(life, 'notes.md');
if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Заметки\n\nНовый хардкор-мир: базы нет, целей нет.\n');

const env = Object.assign({}, process.env, {
  DATA_DIR: dirs.data, FLYBOT_NOTES: notes, MC_VERSION: A.version, RUNNER_URL: `http://127.0.0.1:${RUN}`,
  RUNNER_PORT: String(RUN), BODY_URL: `http://127.0.0.1:${CTL}`, RUNNER_DATA: dirs.runner, RUNNER_LEARNED: path.join(ROOT, 'brain', 'learned')
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

const t0 = Date.now();
const frames = [], chat = [];
const chron = L.makeChronicle();
const ladder = L.makeLadder();
let spawned = false, written = false, age0 = null, tod0 = null, wtStart = null, lastWt = null, lastSnap = null, evSince = 0, lowNoHealSec = 0;
let lowest = { hp: 20, food: 20 }, eats = 0, flees = 0, everTable = false, wasClosed = false;
const exits = [], acts = {}, lastDeath = { msg: null };
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
      if (k === 'eat') eats++; if (k === 'flee') flees++;
      chron.note(lastWt, k, `${w}${d.by && d.by !== 'autopilot' ? ' (' + d.by + ')' : ''}`);
    }
    if (e.type === 'task_done' || e.type === 'task_failed') {
      const a = acts[d.name] || (acts[d.name] = { n: 0, ok: 0 }); a.n++; if (e.type === 'task_done' && !d.error) a.ok++;
    }
    if (e.type === 'death') lastDeath.msg = d.message || d.cause || null;
    if (e.type === 'chat' || e.type === 'system') { const m = String(d.msg || d.text || d.message || ''); if (m.includes(A.name)) { chat.push(m.slice(0, 200)); while (chat.length > 20) chat.shift(); } }
  }
}

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
      console.log(`[fly] ${A.name} в мире ${A.world}, тело :${CTL}, навыки :${RUN}`);
    }
    lastSnap = s;
    const f = frameOf(s);
    frames.push(f); while (frames.length > 60) frames.shift();
    if (f.wt != null) lastWt = f.wt;
    lowest.hp = Math.min(lowest.hp, f.hp); if (f.food != null) lowest.food = Math.min(lowest.food, f.food);
    if (f.hp < 10 && f.food != null && f.food < 18) lowNoHealSec++;
    chron.observe(f);
    // выход из укрытия (8.1): было закрыто со всех сторон — стало открыто; HP и сытость в этот момент — в карточку
    const closed = !!(s.sheltered && s.sheltered.closed);
    if (wasClosed && !closed) { exits.push({ lifeSec: f.t, wt: f.wt, hp: f.hp, food: f.food }); chron.note(f.wt, 'leave', `вышел: HP ${f.hp}, сытость ${f.food}`); }
    wasClosed = closed;
    for (const n of ladder.update(situation(s), f.t, f.wt)) { chron.note(f.wt, 'stage', `ступень ${n}: ${L.STEP_TEXT[n]}`); console.log(`[fly] ${A.name}: ступень ${n} — ${L.STEP_TEXT[n]}`); }
    await readEvents();
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
  const card = {
    nick: A.name, world: A.world, seed: A.seed, result, mode: 'stage1b-flybot',
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), lifeSec,
    gameDays: age0 != null && lastWt != null ? r1((lastWt - age0) / 24000) : null,
    spawnTimeOfDay: tod0, firstNightSurvived: chron.events.some(e => e.kind === 'night_survived'),
    hpLast: frames.length ? frames[frames.length - 1].hp : null, foodLast: frames.length ? frames[frames.length - 1].food : null,
    lowest, eats, flees, wtStart, wtEnd: lastWt, events: chron.events, chat: chat.slice(-10), last60s: frames.slice(), interventions: 0,
    ladder: ladder.reached, topStep: ladder.top(), exits, actions: acts, lowHpNoHealSec: lowNoHealSec,
    deathSoonAfterExit: result === 'death' && !!last && lifeSec - last.lifeSec <= 60,
    autopilot: lastSnap && lastSnap.autopilot ? lastSnap.autopilot : null, ...extra
  };
  try { fs.writeFileSync(A.out, JSON.stringify(card, null, 1)); } catch (e) { console.error('карточка не записана:', e.message); }
  console.log(`[fly] ${A.name}: ${result}, ${lifeSec} с, высшая ступень ${ladder.top()}`);
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
