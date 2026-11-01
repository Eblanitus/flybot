// Простой бот одной жизни для хардкор-стенда, этап 1а (docs/goal_path.md). Его задача — проверить цикл стенда, а не выжить:
// ест при голоде, убегает от врага рядом, в остальное время стоит. Умный цикл жизни — этап 1б.
// Карточку жизни пишет ровно один раз: смерть, отключение, команда «quit» от стенда (вышел срок мира) или свой срок --maxSec.
//   node hardcore/life.js --host 127.0.0.1 --port 25566 --name HC_1 --version 26.1 --world <id> --seed <сид> --out <card.json> --maxSec 7260
'use strict';
const fs = require('fs');
const L = require('./lib');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const A = {
  host: arg('host', '127.0.0.1'), port: +arg('port', 25566), name: arg('name', 'HC_1'), version: arg('version', '26.1'),
  world: arg('world', ''), seed: arg('seed', ''), out: arg('out', `card-${Date.now()}.json`), maxSec: +arg('maxSec', 7260)
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
let lastAge = null, lowest = { hp: 20, food: 20 }, eats = 0, flees = 0;

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
  return f;
}

function writeCard(result, extra = {}) {
  if (written) return; written = true;
  try { if (spawned) frame(); } catch (e) {}
  const lifeSec = Math.round((Date.now() - t0) / 1000);
  const ageNow = lastAge;
  const card = {
    nick: A.name, world: A.world, seed: A.seed, result, mode: 'stage1a',
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), lifeSec,
    gameDays: age0 != null && ageNow != null ? r1((ageNow - age0) / 24000) : null,
    spawnTimeOfDay: tod0, firstNightSurvived: nightEnd != null && ageNow != null ? ageNow >= nightEnd : false,
    hpLast: frames.length ? frames[frames.length - 1].hp : null, foodLast: frames.length ? frames[frames.length - 1].food : null,
    lowest, eats, flees, chat: chat.slice(-10), last60s: frames.slice(), interventions: 0, ...extra
  };
  try { fs.writeFileSync(A.out, JSON.stringify(card, null, 1)); } catch (e) { console.error('карточка не записана:', e.message); }
  console.log(`[life] ${A.name}: ${result}, ${lifeSec} с`);
}
function finish(result, extra) {
  writeCard(result, extra);
  clearInterval(timer);
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
  try { await bot.equip(item, 'hand'); await bot.consume(); eats++; } catch (e) {} finally { eating = false; }
}

function step() {
  if (!spawned || written) return;
  const f = frame();
  if (Date.now() - t0 > A.maxSec * 1000) return finish('timeout', { note: 'свой срок --maxSec' });
  if (f.food != null && (f.food <= T.EAT_FOOD || (f.hp < 20 && f.food <= T.EAT_HURT_FOOD))) eat();
  if (!pf || !bot.pathfinder) return;
  const enemy = bot.nearestEntity(isHostile);
  const d = enemy ? enemy.position.distanceTo(bot.entity.position) : Infinity;
  if (enemy && d < T.FLEE_DIST && fleeing !== enemy.id) {
    fleeing = enemy.id; flees++;
    try { bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalFollow(enemy, T.SAFE_DIST)), true); } catch (e) {}
  } else if (fleeing != null && (!enemy || d > T.SAFE_DIST)) {
    fleeing = null;
    try { bot.pathfinder.setGoal(null); } catch (e) {}
  }
}

bot.once('spawn', () => {
  spawned = true;
  if (bot.game && bot.game.gameMode === 'spectator') return finish('already_dead', { note: 'вошёл зрителем — в этом мире уже умирал' });
  age0 = bot.time ? Number(bot.time.age) : null; tod0 = bot.time ? bot.time.timeOfDay : null;
  if (age0 != null && tod0 != null) nightEnd = L.firstNightEnd(age0, tod0);
  if (pf) try { const m = new pf.Movements(bot); m.canDig = false; m.allow1by1towers = false; bot.pathfinder.setMovements(m); } catch (e) {}
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
