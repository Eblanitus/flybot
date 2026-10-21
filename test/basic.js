// Офлайн-проверка универсальных навыков (lib/skills/basic.js, farm.js): регистрация, чистые функции, eat/toss/метки на фальшивом боте
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const basic = require('../lib/skills/basic');
const farm = require('../lib/skills/farm');
const reg = require('minecraft-data')('1.21.4');

function mkBot(items, extra) {
  const inv = items.map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id }));
  const bot = {
    registry: reg, entity: { position: new Vec3(10.5, 64, -3.5), yaw: 0 }, username: 'T', food: 10, foodSaturation: 0, health: 20, heldItem: null,
    game: { dimension: 'minecraft:overworld' }, entities: {},
    inventory: { items: () => inv.filter(i => i.count > 0), slots: [] },
    equip: async it => { bot.heldItem = it; },
    consume: async () => { const it = bot.heldItem; it.count--; bot.food = Math.min(20, bot.food + (reg.foodsByName[it.name].foodPoints || 0)); },
    toss: async (type, meta, n) => { const it = inv.find(i => i.type === type); it.count -= n; },
    lookAt: async () => {}, look: async () => {},
    blockAt: () => ({ name: 'stone' }),
    setControlState() {}, clearControlStates() {}
  };
  return Object.assign(bot, extra || {});
}
const task = () => new Task(1, 'x', {}, 'brain');

module.exports = async () => {
  // регистрация в SKILLS
  const { SKILLS } = require('../lib/commands');
  const names = ['eat', 'equip_item', 'toss', 'drop_junk', 'look_at', 'use_item', 'activate', 'pillar_up', 'bridge', 'pickup', 'light', 'mark', 'go_home', 'waypoints', 'shoot', 'shield', 'fish', 'bucket',
    'till', 'plant', 'harvest', 'breed', 'shear', 'villagers', 'trade'];
  for (const n of names) assert.strictEqual(typeof SKILLS[n], 'function', 'не зарегистрирован навык ' + n);
  for (const n of ['collect', 'craft', 'follow', 'recover']) assert.strictEqual(typeof SKILLS[n], 'function', 'старый навык пропал: ' + n);
  assert(!('equip' in SKILLS), 'equip занят старой командой');

  // чистые функции
  const items = [['rotten_flesh', 3], ['bread', 2], ['cooked_beef', 4], ['golden_apple', 1]].map(([name, count]) => ({ name, count }));
  assert.strictEqual(basic.pickFood(items, reg.foodsByName, 18).name, 'bread', 'почти сыт — меньше переплаты');
  assert.strictEqual(basic.pickFood(items, reg.foodsByName, 4).name, 'cooked_beef', 'голоден — самая сытная');
  assert.strictEqual(basic.pickFood([{ name: 'rotten_flesh', count: 1 }], reg.foodsByName, 10), null);
  assert.strictEqual(basic.pickFood([{ name: 'rotten_flesh', count: 1 }], reg.foodsByName, 10, { desperate: true }).name, 'rotten_flesh');
  const junk = basic.pickJunk(new Map([['dirt', 40], ['gravel', 5], ['wheat_seeds', 9], ['iron_ingot', 3]]), ['gravel']);
  assert.deepStrictEqual(junk, [{ name: 'dirt', count: 8 }], 'dirt сверх 32; gravel в keep; семена и слитки не мусор');
  assert.strictEqual(basic.pickPlaceable([{ name: 'oak_planks', count: 9 }, { name: 'cobblestone', count: 9 }, { name: 'dirt', count: 1 }]).name, 'dirt');
  assert.strictEqual(basic.pickPlaceable([{ name: 'oak_planks', count: 9 }]), null);
  assert.deepStrictEqual(basic.parseDir({ dir: 'С' }, new Vec3(0, 0, 0)), { dx: 0, dz: -1, stopAt: null });
  assert.deepStrictEqual(basic.parseDir({ x: 0, z: 10 }, new Vec3(0.5, 0, 0.5)), { dx: 0, dz: 1, stopAt: 10 });
  const pitch = basic.aimPitch(20, 0, 3); assert(pitch !== null && pitch > 0 && pitch < 0.2, 'pitch ' + pitch);
  assert.strictEqual(basic.isDark({ l: 3, s: 0 }, 8, false), true);
  assert.strictEqual(basic.isDark({ l: 3, s: 15 }, 8, false), false);
  assert.strictEqual(farm.isMature('wheat', { age: 7 }), true);
  assert.strictEqual(farm.isMature('wheat', { age: 6 }), false);
  assert.strictEqual(farm.isMature('beetroot', { age: 3 }), true);
  assert.strictEqual(farm.areaCells({ x1: 0, z1: 0, x2: 2, z2: 1 }, 64).length, 6);

  // eat: до сытости, ошибка при сытости
  const b1 = mkBot([['bread', 3]]);
  const ctx1 = { bot: b1, stats: {} };
  const r1 = await basic.eat(ctx1, task(), { count: 2 });
  assert.deepStrictEqual(r1.ate, ['bread', 'bread']); assert.deepStrictEqual(r1.food, [10, 20]); assert(r1.full);
  await assert.rejects(basic.eat(ctx1, task(), {}), /сыт/);
  await assert.rejects(basic.eat({ bot: mkBot([['cobblestone', 1]]), stats: {} }, task(), {}), /нет подходящей еды/);
  // прерванная задача не ест
  const ta = task(); ta.abort('stop');
  await assert.rejects(basic.eat({ bot: mkBot([['bread', 3]]), stats: {} }, ta, {}), e => e.aborted === true);

  // toss: по умолчанию 1, all — всё
  const b2 = mkBot([['dirt', 10]]); const ctx2 = { bot: b2, stats: {} };
  assert.deepStrictEqual((await basic.toss(ctx2, task(), { item: 'dirt' })).dropped, { dirt: 1 });
  assert.deepStrictEqual((await basic.toss(ctx2, task(), { item: 'dirt', count: 4 })).dropped, { dirt: 4 });
  assert.strictEqual((await basic.toss(ctx2, task(), { item: 'dirt', all: true })).left, 0);
  await assert.rejects(basic.toss(ctx2, task(), { item: 'dirt' }), /нет в инвентаре/);

  // метки: mark -> waypoints -> go_home (путь подменён) -> remove
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-wp-'));
  try {
    const ctx3 = { bot: mkBot([]), stats: {}, dataDir: dir };
    const m = await basic.mark(ctx3, task(), { name: 'Дом', note: 'база' });
    assert.deepStrictEqual(m.at, [10, 64, -4]); assert.strictEqual(m.total, 1);
    await basic.mark(ctx3, task(), { name: 'mine', x: 100, y: 12, z: 5 });
    const w = await basic.waypoints(ctx3, task(), {});
    assert.deepStrictEqual(w.waypoints.map(x => x.name), ['дом', 'mine']);
    assert.strictEqual(w.waypoints[0].note, 'база');
    const A = require('../lib/actions'); const oldGoto = A.goto;
    A.goto = async (c, t, goal) => { c.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
    try { const g = await basic.goHome(ctx3, task(), { name: 'mine' }); assert(g.arrived && g.distNow <= 1, JSON.stringify(g)); } finally { A.goto = oldGoto; }
    await assert.rejects(basic.goHome(ctx3, task(), { name: 'нет_такой' }), /нет метки/);
    assert.strictEqual((await basic.waypoints(ctx3, task(), { remove: 'mine' })).total, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // look_at: ошибка без цели, ответ с координатами
  const ctx4 = { bot: mkBot([]), stats: {} };
  await assert.rejects(basic.lookAt(ctx4, task(), {}), /x,y,z|entity/);
  const l = await basic.lookAt(ctx4, task(), { x: 12, y: 64, z: -3 }); assert.deepStrictEqual(l.at, [12, 64, -3]);
  console.log('basic skills OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
