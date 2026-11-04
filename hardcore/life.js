// Бот одной жизни для хардкор-стенда (docs/goal_path.md).
//   --mode 1b (по умолчанию) — этап 1б: порядок дел из hardcore/order.js (опасность → еда → укрытие к закату → ступени 1–6),
//              дела исполняют навыки FlyBot через hardcore/body.js; ступени, выходы из укрытия и «застрял» — в карточку и ленту.
//   --mode 1a — простой бот этапа 1а: ест при голоде, убегает от врага рядом, в остальное время стоит.
// Карточку жизни пишет ровно один раз: смерть, отключение, команда «quit» от стенда (вышел срок мира) или свой срок --maxSec.
//   node hardcore/life.js --host 127.0.0.1 --port 25566 --name HC_1 --version 26.1 --world <id> --seed <сид> --out <card.json> --maxSec 7260
'use strict';
const fs = require('fs');
const L = require('./lib');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const A = {
  host: arg('host', '127.0.0.1'), port: +arg('port', 25566), name: arg('name', 'HC_1'), version: arg('version', '26.1'),
  world: arg('world', ''), seed: arg('seed', ''), out: arg('out', `card-${Date.now()}.json`), maxSec: +arg('maxSec', 7260),
  mode: arg('mode', '1b') === '1a' ? '1a' : '1b'
};
const T = { EAT_FOOD: 14, EAT_HURT_FOOD: 17, FLEE_DIST: 10, SAFE_DIST: 24, TICK_MS: 1000, KEEP_FRAMES: 60 };
const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper',
  'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'silverfish', 'breeze', 'parched', 'zombie_nautilus']);
const isHostile = e => !!e && e !== bot.entity && e.type !== 'player' && (e.type === 'hostile' || HOSTILE.has(String(e.name || '').toLowerCase()));

const mineflayer = require('mineflayer');
let pf = null; try { pf = require('mineflayer-pathfinder'); } catch (e) {}
const bot = mineflayer.createBot({ host: A.host, port: A.port, username: A.name, version: A.version, auth: 'offline', respawn: false });
if (pf) bot.loadPlugin(pf.pathfinder);

const t0 = Date.now();
const frames = [];
const chat = [];
let spawned = false, age0 = null, tod0 = null, nightEnd = null, written = false, eating = false, fleeing = null, timer = null;
let lastAge = null, lowest = { hp: 20, food: 20 }, eats = 0, flees = 0, wtStart = null;
const chron = L.makeChronicle();
const O = require('./order');
const B = A.mode === '1b' ? require('./body') : null;
const path = require('path');
const ladder = O.makeLadder(), stuck = O.makeStuck();
let ctx = null, cur = null, tablePlaced = false, lastWhy = null, lowNoHealSec = 0;
const exits = [], acts = {}, stuckList = [];
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
const wtNow = () => (bot.time && bot.time.time != null ? Number(bot.time.time) : null);

const r1 = x => Math.round(x * 10) / 10;
function frame() {
  const p = bot.entity && bot.entity.position;
  const enemy = bot.entity ? bot.nearestEntity(isHostile) : null;
  const f = {
    t: Math.round((Date.now() - t0) / 1000), hp: r1(bot.health || 0), food: bot.food, pos: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
    tod: bot.time ? bot.time.timeOfDay : null,
    enemy: enemy && p ? { name: enemy.name, d: r1(enemy.position.distanceTo(p)) } : null
  };
  frames.push(f); while (frames.length > T.KEEP_FRAMES) frames.shift();
  if (bot.time && bot.time.age != null) lastAge = Number(bot.time.age);
  lowest.hp = Math.min(lowest.hp, f.hp); if (f.food != null) lowest.food = Math.min(lowest.food, f.food);
  f.wt = wtNow();
  if (spawned && !written) chron.observe(f);
  return f;
}

function writeCard(result, extra = {}) {
  if (written) return; written = true;
  try { if (spawned) frame(); } catch (e) {}
  const endText = { death: extra.cause ? `смерть: ${extra.cause}` : 'смерть', timeout: 'срок мира вышел, жив', disconnect: 'отключился', crash: 'бот упал', already_dead: 'уже мёртв' }[result] || result;
  chron.note(wtNow(), result === 'death' ? 'death' : 'end', endText);
  const lifeSec = Math.round((Date.now() - t0) / 1000);
  const ageNow = lastAge;
  const card = {
    nick: A.name, world: A.world, seed: A.seed, result, mode: A.mode === '1b' ? 'stage1b' : 'stage1a',
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), lifeSec,
    gameDays: age0 != null && ageNow != null ? r1((ageNow - age0) / 24000) : null,
    spawnTimeOfDay: tod0, firstNightSurvived: nightEnd != null && ageNow != null ? ageNow >= nightEnd : false,
    hpLast: frames.length ? frames[frames.length - 1].hp : null, foodLast: frames.length ? frames[frames.length - 1].food : null,
    lowest, eats, flees, wtStart, wtEnd: wtNow(), events: chron.events, chat: chat.slice(-10), last60s: frames.slice(), interventions: 0,
    ...(A.mode === '1b' ? lifeExtra(result, lifeSec) : {}), ...extra
  };
  try { fs.writeFileSync(A.out, JSON.stringify(card, null, 1)); } catch (e) { console.error('карточка не записана:', e.message); }
  console.log(`[life] ${A.name}: ${result}, ${lifeSec} с`);
}
// Поля карточки этапа 1б: ступени и время до них, выходы из укрытия (8.1), застревания, счёт дел.
function lifeExtra(result, lifeSec) {
  const last = exits[exits.length - 1];
  return {
    ladder: ladder.reached, topStep: ladder.top(), exits, stuck: stuckList, actions: acts, lowHpNoHealSec: lowNoHealSec,
    deathSoonAfterExit: result === 'death' && !!last && lifeSec - last.lifeSec <= 60, lastDecision: lastWhy
  };
}
const session = { timers: [] };
function finish(result, extra) {
  writeCard(result, extra);
  clearInterval(timer);
  for (const x of session.timers) { clearInterval(x); clearTimeout(x); }
  if (cur) try { cur.task.abort('конец жизни'); } catch (e) {}
  try { bot.quit(); } catch (e) {}
  setTimeout(() => process.exit(0), 1500);
}

async function eat() {
  if (eating || !bot.registry || !bot.inventory) return;
  const foods = bot.registry.foodsByName || {};
  const bad = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
  const items = bot.inventory.items().filter(i => foods[i.name]);
  const item = items.find(i => !bad.has(i.name)) || (bot.health <= 6 ? items[0] : null);
  if (!item) return;
  eating = true;
  try { await bot.equip(item, 'hand'); await bot.consume(); eats++; chron.note(wtNow(), 'eat', `поел: ${item.name}`); } catch (e) {} finally { eating = false; }
}

function step() {
  if (!spawned || written) return;
  const f = frame();
  if (Date.now() - t0 > A.maxSec * 1000) return finish('timeout', { note: 'свой срок --maxSec' });
  if (B) return step1b(f);
  if (f.food != null && (f.food <= T.EAT_FOOD || (f.hp < 20 && f.food <= T.EAT_HURT_FOOD))) eat();
  if (!pf || !bot.pathfinder) return;
  const enemy = bot.nearestEntity(isHostile);
  const d = enemy ? enemy.position.distanceTo(bot.entity.position) : Infinity;
  if (enemy && d < T.FLEE_DIST && fleeing !== enemy.id) {
    fleeing = enemy.id; flees++;
    chron.note(wtNow(), 'flee', `бежит от ${enemy.name}`);
    try { bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, T.SAFE_DIST)), true); } catch (e) {}
  } else if (fleeing != null && (!enemy || d > T.SAFE_DIST)) {
    fleeing = null;
    try { bot.pathfinder.setGoal(null); } catch (e) {}
  }
}

// --- этап 1б: обстановка → decide() → дело навыком FlyBot ---
function situation(f) {
  const inv = {}; let foodItems = 0;
  const foods = (bot.registry && bot.registry.foodsByName) || {};
  for (const i of bot.inventory.items()) { inv[i.name] = (inv[i.name] || 0) + i.count; if (foods[i.name] && !BAD_FOOD.has(i.name)) foodItems += i.count; }
  let sheltered = false, tableNear = false;
  try { sheltered = require('../lib/skills/survival').isSheltered(bot); } catch (e) {}
  try { tableNear = !!require('../lib/skills/craft').knownStation(ctx, 'crafting_table', 24); } catch (e) {}
  return { hp: f.hp, food: f.food, foodItems, tod: f.tod, inv, enemy: f.enemy, sheltered, tableNear: tableNear || false,
    tablePlaced, nightSurvived: chron.events.some(e => e.kind === 'night_survived') };
}
function step1b(f) {
  if (f.hp < 10 && f.food != null && f.food < 18) lowNoHealSec++;
  const s = situation(f);
  for (const n of ladder.update(s, Math.round((Date.now() - t0) / 1000), f.wt)) chron.note(f.wt, 'stage', `ступень ${n}: ${O.STEP_TEXT[n]}`);
  const d = O.decide(s, stuck);
  if (cur) {
    if (B.shouldPreempt(cur.d, d)) cur.task.abort(`срочнее: ${d.do} (${d.why})`);
    return;
  }
  lastWhy = `${d.do}: ${d.why}`;
  if (d.do !== 'wait') console.log(`[life] ${A.name}: ${lastWhy}`);
  if (d.do === 'shelter') chron.note(f.wt, 'shelter', `в укрытие: ${d.why}`);
  if (d.do === 'flee') { flees++; chron.note(f.wt, 'flee', `бежит от ${f.enemy ? f.enemy.name : '?'}`); }
  if (d.do === 'fight') chron.note(f.wt, 'fight', `дерётся с ${f.enemy ? f.enemy.name : '?'}`);
  const hp0 = f.hp, food0 = f.food;
  const job = B.start(ctx, d);
  cur = job;
  job.done.then(r => {
    cur = null;
    if (written) return;
    const a = acts[d.do] || (acts[d.do] = { n: 0, ok: 0, sec: 0 });
    a.n++; if (r.ok) a.ok++; a.sec += Math.round(r.ms / 1000);
    const wt = wtNow();
    if (r.ok) {
      stuck.ok(d.do);
      if (d.do === 'eat') { eats++; const ate = r.result && r.result.ate; chron.note(wt, 'eat', `поел: ${ate && ate.length ? ate.join(', ') : '?'}`); }
      if (d.do === 'table') tablePlaced = true;
      if (d.do === 'leave') {
        const e = { lifeSec: Math.round((Date.now() - t0) / 1000), wt, hp: hp0, food: food0, why: d.why };
        exits.push(e); chron.note(wt, 'leave', `вышел: HP ${hp0}, сытость ${food0}`);
      }
    } else if (!r.aborted || /срок/.test(r.reason || '')) {
      if (stuck.fail(d.do, Date.now())) {
        stuckList.push({ do: d.do, lifeSec: Math.round((Date.now() - t0) / 1000), wt, error: r.error });
        chron.note(wt, 'stuck', `застрял: ${d.do} (${r.error})`);
      }
      if (d.do !== 'wait') console.log(`[life] ${A.name}: ${d.do} не вышло — ${r.error}`);
    }
  });
}

bot.once('spawn', () => {
  spawned = true;
  if (bot.game && bot.game.gameMode === 'spectator') return finish('already_dead', { note: 'вошёл зрителем — в этом мире уже умирал' });
  age0 = bot.time ? Number(bot.time.age) : null; tod0 = bot.time ? bot.time.timeOfDay : null;
  if (age0 != null && tod0 != null) nightEnd = L.firstNightEnd(age0, tod0);
  wtStart = wtNow(); chron.note(wtStart, 'start', 'старт');
  if (B) {
    ctx = B.makeCtx(bot, path.join(path.dirname(path.resolve(A.out)), A.name + '.mem'));
    session.bot = bot;
    try { B.attach(ctx, session); } catch (e) { console.error('[life] навыки FlyBot не подключились:', e.message); return finish('crash', { reason: 'навыки: ' + e.message }); }
  } else if (pf) try { const m = new pf.Movements(bot); m.canDig = false; m.allow1by1towers = false; bot.pathfinder.setMovements(m); } catch (e) {}
  timer = setInterval(step, T.TICK_MS);
  console.log(`[life] ${A.name} в мире ${A.world}, время суток ${tod0}`);
});
bot.on('messagestr', msg => { if (String(msg).includes(A.name)) { chat.push(String(msg).slice(0, 200)); while (chat.length > 20) chat.shift(); } });
bot.on('death', () => {
  // сообщение о смерти приходит в чат почти сразу — ждём его чуть-чуть
  setTimeout(() => {
    const msg = L.deathMessage(chat, A.name);
    finish('death', { deathMessage: msg, cause: L.causeOf(msg) });
  }, 800);
});
bot.on('kicked', reason => finish('disconnect', { reason: String(reason && reason.toString ? reason.toString() : reason).slice(0, 300) }));
bot.on('end', reason => finish('disconnect', { reason: String(reason || 'end') }));
bot.on('error', e => { console.error('[life] ошибка:', e.message); if (!spawned) finish('disconnect', { reason: 'не вошёл: ' + e.message }); });
process.stdin.on('data', d => { if (/quit/.test(String(d))) finish('timeout', { note: 'стенд: вышел срок мира' }); });
process.on('uncaughtException', e => { console.error('[life] упал:', e.stack || e); finish('crash', { reason: String(e.message || e) }); });
