// Офлайн-проверки ближнего боя: досягаемость до хитбокса, решение бить/отойти/подойти, безопасность шага назад, fight/defend на фальшивом боте.
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const M = require('../lib/melee');
const combat = require('../lib/skills/combat');

const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, a + ' != ' + b);

function testPure() {
  // досягаемость до хитбокса: цель в 3.5 по центру, width 0.6 -> ближний край 3.2; глаза на 1.62
  const eye = { x: 0, y: 67.62, z: 0 };
  near(M.boxDist(eye, { x: 3.5, y: 66, z: 0 }, 0.6, 1.95), 3.2);
  near(M.boxDist(eye, { x: 0, y: 66, z: 0 }, 0.6, 1.95), 0);                  // внутри хитбокса
  near(M.boxDist(eye, { x: 3, y: 66, z: 4 }, 0.6, 1.95), Math.hypot(2.7, 3.7)); // по диагонали до угла
  near(M.boxDist(eye, { x: 2, y: 60, z: 0 }, 0.6, 1.8), Math.hypot(1.7, 67.62 - 61.8)); // цель ниже — считаем по высоте
  // белый медведь (широкий): хитбокс 1.4 -> центр в 3.6 даёт 2.9 до края — уже можно бить
  near(M.boxDist({ x: 0, y: 67, z: 0 }, { x: 3.6, y: 66, z: 0 }, 1.4, 1.4), 2.9);
  // решение на числах
  const dec = (dist, ready, o = {}) => M.decide({ dist, ready, ...o });
  assert.strictEqual(dec(2.9, true), 'hit');
  assert.strictEqual(dec(2.95, true), 'approach', 'за пределом запаса не бьём');
  assert.strictEqual(dec(1.0, true), 'hit');
  assert.strictEqual(dec(1.0, false), 'back', 'перезарядка и близко — отходим');
  assert.strictEqual(dec(2.39, false), 'back');
  assert.strictEqual(dec(2.4, false), 'hold');
  assert.strictEqual(dec(3.0, false), 'hold');
  assert.strictEqual(dec(3.2, false), 'approach');
  assert.strictEqual(dec(1.0, false, { keep: false }), 'hold', 'без удержания дистанции не отходим');
  // стрелок: не отходим, сближаемся
  assert.strictEqual(dec(2.5, false, { close: true, keep: false }), 'approach');
  assert.strictEqual(dec(1.5, false, { close: true, keep: false }), 'hold');
  assert.strictEqual(dec(2.5, true, { close: true }), 'hit');
  // кулдауны
  assert.strictEqual(M.cooldownMs('wooden_sword'), 650);
  assert.strictEqual(M.cooldownMs('diamond_sword'), 650);
  assert(M.cooldownMs('iron_axe') > M.cooldownMs('iron_sword') && M.cooldownMs('stone_axe') >= M.cooldownMs('iron_axe'));
  assert(M.cooldownMs(null) < M.cooldownMs('wooden_sword'), 'кулак быстрее меча');
  assert(M.cooldownMs('mace') > M.cooldownMs('wooden_axe'));
  // разбег
  assert(M.shouldLunge({ food: 20, dist: 2.5 }));
  assert(!M.shouldLunge({ food: 6, dist: 2.5 }), 'голодный не спринтует');
  assert(!M.shouldLunge({ food: 20, dist: 0.8 }), 'вплотную разбег не нужен');
  assert(!M.shouldLunge({ food: 20, dist: 2.5, creeper: true }));
  assert(!M.shouldLunge({ food: 20, dist: 2.5, enabled: false }));
}

const solidNames = n => !['air', 'water', 'lava'].includes(n);
function fakeBot(gen, pos = new Vec3(0.5, 66, 0.5)) {
  const calls = [];
  const bot = {
    username: 'FlyTest', health: 20, food: 20, heldItem: { name: 'wooden_sword' }, entity: { position: pos, height: 1.8, velocity: new Vec3(0, 0, 0) }, entities: {}, players: {},
    inventory: { items: () => [], slots: {} },
    blockAt(p) { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), n = gen(x, y, z); return n == null ? null : { name: n, boundingBox: solidNames(n) ? 'block' : 'empty', position: new Vec3(x, y, z) }; },
    pathfinder: { setMovements() {}, setGoal(g) { calls.push(['goal', g ? 'set' : null]); } },
    setControlState(k, v) { calls.push(['ctl', k, v]); }, clearControlStates() { calls.push(['clear']); },
    lookAt: async () => {}, attack(e) { calls.push(['attack', Date.now()]); if (bot.onAttack) bot.onAttack(e); }
  };
  bot.entities[1] = bot.entity;
  return { bot, calls };
}
const flat = (x, y) => (y <= 65 ? 'dirt' : 'air');
const zombie = (bot, x, z, extra = {}) => { const e = { id: 10, name: 'zombie', type: 'hostile', position: new Vec3(x, 66, z), height: 1.95, width: 0.6, ...extra }; bot.entities[e.id] = e; return e; };

function testBackSafety() {
  const { bot } = fakeBot(flat);
  const z = zombie(bot, 2.5, 0.5); // цель на +x, значит назад — на -x
  assert(M.backIsSafe(bot, z), 'ровный пол');
  const cliff = fakeBot((x, y) => (x < 0 ? (y <= 62 ? 'dirt' : 'air') : flat(x, y)));
  assert(!M.backIsSafe(cliff.bot, zombie(cliff.bot, 2.5, 0.5)), 'обрыв сзади');
  const step = fakeBot((x, y) => (x < 0 ? (y <= 64 ? 'dirt' : 'air') : flat(x, y)));
  assert(M.backIsSafe(step.bot, zombie(step.bot, 2.5, 0.5)), 'спуск на 1');
  const lava = fakeBot((x, y) => (x < 0 && y === 65 ? 'lava' : flat(x, y)));
  assert(!M.backIsSafe(lava.bot, zombie(lava.bot, 2.5, 0.5)), 'лава под ногами');
  const water = fakeBot((x, y) => (x < 0 && y === 66 ? 'water' : flat(x, y)));
  assert(!M.backIsSafe(water.bot, zombie(water.bot, 2.5, 0.5)), 'вода сзади');
  const wall = fakeBot((x, y) => (x < 0 && y >= 66 && y <= 67 ? 'stone' : flat(x, y)));
  assert(!M.backIsSafe(wall.bot, zombie(wall.bot, 2.5, 0.5)), 'стена сзади');
  const unl = fakeBot((x, y) => (x < -1 ? null : flat(x, y)));
  assert(!M.backIsSafe(unl.bot, zombie(unl.bot, 2.5, 0.5)), 'чанк не загружен');
}

const mkTask = () => new Task(1, 'fight', {}, 'test');
const dieAfter = (bot, k) => { let n = 0; bot.onAttack = e => { if (++n >= k) delete bot.entities[e.id]; }; };

async function testFight() {
  // 1) цель досягаема с предела (ближний край 2.9): бьём сразу, не подходя
  let { bot, calls } = fakeBot(flat); const ctx = { bot };
  zombie(bot, 3.5, 0.5); dieAfter(bot, 1);
  let r = await combat.fight(ctx, mkTask(), { sprint: false, timeout: 5, style: 'kite' });
  assert.strictEqual(r.kills, 1); assert.strictEqual(r.hits, 1);
  assert(!calls.some(c => c[0] === 'goal' && c[1] === 'set'), 'не подходили к цели в пределах досягаемости');
  assert(calls.some(c => c[0] === 'clear'), 'управление сброшено');
  // 1б) край 3.1 — за пределом: сначала подход (ставим цель пути)
  ({ bot, calls } = fakeBot(flat)); ctx.bot = bot; zombie(bot, 3.7, 0.5); dieAfter(bot, 1);
  const g = bot.pathfinder.setGoal; bot.pathfinder.setGoal = x => { g(x); if (x) bot.entities[10].position = new Vec3(3.4, 66, 0.5); };
  await combat.fight(ctx, mkTask(), { sprint: false, timeout: 5, style: 'kite' });
  assert(calls.findIndex(c => c[0] === 'goal' && c[1] === 'set') < calls.findIndex(c => c[0] === 'attack'), 'за пределом — сперва подход');
  // 2) разбег: до удара включён спринт, после удара управление сброшено
  ({ bot, calls } = fakeBot(flat)); ctx.bot = bot; zombie(bot, 3.1, 0.5); dieAfter(bot, 1);
  await combat.fight(ctx, mkTask(), { timeout: 5, style: 'kite' });
  const iSprint = calls.findIndex(c => c[0] === 'ctl' && c[1] === 'sprint' && c[2] === true), iAtk = calls.findIndex(c => c[0] === 'attack');
  assert(iSprint >= 0 && iSprint < iAtk, 'спринт включён до удара');
  assert(calls.slice(iAtk - 1).some(c => c[0] === 'clear'), 'спринт сброшен');
  // 3) перезарядка: цель вплотную — отходим назад, бьём ровно по заряду, не чаще
  ({ bot, calls } = fakeBot(flat)); ctx.bot = bot; zombie(bot, 1.5, 0.5); dieAfter(bot, 2);
  await combat.fight(ctx, mkTask(), { sprint: false, timeout: 6, style: 'kite' });
  const atk = calls.filter(c => c[0] === 'attack').map(c => c[1]);
  assert.strictEqual(atk.length, 2);
  assert(atk[1] - atk[0] >= 640, 'между ударами не меньше полного заряда: ' + (atk[1] - atk[0]));
  assert(calls.some(c => c[0] === 'ctl' && c[1] === 'back' && c[2] === true), 'при перезарядке отходит назад');
  // 4) обрыв сзади: назад не идём
  const cl = fakeBot((x, y) => (x < 0 ? (y <= 60 ? 'dirt' : 'air') : flat(x, y))); ctx.bot = cl.bot; zombie(cl.bot, 1.5, 0.5); dieAfter(cl.bot, 2);
  await combat.fight(ctx, mkTask(), { sprint: false, timeout: 6, style: 'kite' });
  assert(!cl.calls.some(c => c[0] === 'ctl' && c[1] === 'back' && c[2] === true), 'у обрыва назад не идёт');
  // 5) скелет: дистанцию не держим — вплотную при перезарядке не отходит
  ({ bot, calls } = fakeBot(flat)); ctx.bot = bot; zombie(bot, 1.5, 0.5, { name: 'skeleton' }); dieAfter(bot, 2);
  await combat.fight(ctx, mkTask(), { sprint: false, timeout: 6, style: 'kite' });
  assert(!calls.some(c => c[0] === 'ctl' && c[1] === 'back' && c[2] === true), 'скелет: не отходим');
  // 6) abort: прерванный бой сбрасывает управление и цель пути
  ({ bot, calls } = fakeBot(flat)); ctx.bot = bot; zombie(bot, 30, 0.5);
  const ta = mkTask(); setTimeout(() => ta.abort('stop'), 300);
  await assert.rejects(combat.fight(ctx, ta, { timeout: 10, radius: 32, style: 'kite' }));
  assert.deepStrictEqual(calls.slice(-2).map(c => c[0]), ['goal', 'clear']);
}

async function testDefend() {
  const { bot, calls } = fakeBot(flat); const ctx = { bot };
  zombie(bot, 3.5, 0.5); // край 2.9 — бьём, не двигаясь
  await combat.defend(ctx, new Task(1, 'defend', {}, 'test'), { duration: 3, style: 'kite' });
  assert(calls.filter(c => c[0] === 'attack').length >= 3, 'defend бьёт с предела');
  assert.strictEqual(bot.entity.position.x, 0.5);
  assert.deepStrictEqual(calls[calls.length - 1], ['clear']);
}

module.exports = async () => { testPure(); testBackSafety(); await testFight(); await testDefend(); };
if (require.main === module) module.exports().then(() => console.log('melee OK'), e => { console.error(e); process.exit(1); });
