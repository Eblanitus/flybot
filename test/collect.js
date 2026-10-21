// Офлайн-проверка collect stone: камня не видно (под землёй) -> копает лесенку вниз и добывает
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const A = require('../lib/actions');
const vision = require('../lib/vision');
const gather = require('../lib/skills/gather');
const reg = require('minecraft-data')('1.21.4');

function mkWorld(lavaAt) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const name = (x, y, z) => { const k = key(x, y, z); if (blocks.has(k)) return blocks.get(k); if (lavaAt && lavaAt(x, y, z)) return 'lava'; return y > 65 ? 'air' : y === 65 ? 'grass_block' : y >= 63 ? 'dirt' : 'stone'; };
  const mk = (x, y, z) => { const n = name(x, y, z); const d = reg.blocksByName[n]; return { name: n, type: d.id, boundingBox: d.boundingBox, position: new Vec3(x, y, z) }; };
  const inv = new Map();
  const bot = {
    registry: reg, entity: { position: new Vec3(0.5, 66, 0.5) }, username: 'T', heldItem: null,
    blockAt: p => mk(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    dig: async b => { const k = key(b.position.x, b.position.y, b.position.z); blocks.set(k, 'air'); const it = b.name === 'stone' ? 'cobblestone' : b.name; inv.set(it, (inv.get(it) || 0) + 1); },
    stopDigging() {}, clearControlStates() {},
    inventory: { items: () => [...inv].map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) }
  };
  return { bot, inv, blocks, name };
}

module.exports = async () => {
  const w = mkWorld();
  // «честное зрение»: видны только блоки камня, соседствующие с воздухом, в радиусе
  vision.find = (ctx, ids) => {
    const out = []; const p = w.bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (!ids.includes(w.bot.blockAt(new Vec3(x, y, z)).type)) continue;
      if (A.FACES.some(f => w.bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  vision.forget = () => {};
  A.goto = async (ctx, t, goal) => { if (goal.constructor.name !== 'GoalBlock') return true; w.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
  A.pickupDrops = async () => {};
  const ctx = { bot: w.bot, stats: { blocksMined: 0 }, tasks: {} };
  const r = await gather.collect(ctx, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 12 });
  assert(r.mined >= 12, 'mined ' + r.mined);
  assert(w.bot.entity.position.y < 66, 'спустился');
  console.log('collect stone OK', JSON.stringify(r), 'y=' + w.bot.entity.position.y);
  // лава под землёй вокруг -> понятная ошибка, а не провал в лаву
  const w2 = mkWorld((x, y) => y <= 62); w.bot = w2.bot;
  w2.bot.entity.position = new Vec3(0.5, 66, 0.5);
  await assert.rejects(gather.collect({ bot: w2.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(2, 'collect', {}, 'brain'), { block: 'stone', count: 5 }), e => { console.log('lava ->', e.message); return /копал|копать|лава|lava/.test(e.message); });
  // брёвна: топора нет, ничего не скрафтить (нет досок/верстака) -> collect не падает, axe = «нет: …»; есть топор -> had
  const w3 = mkWorld((x, y) => false);
  const logId = reg.blocksByName.oak_log.id;
  w3.bot.recipesAll = () => []; w3.bot.pathfinder = {};
  const oldFind = vision.find;
  vision.find = () => [new Vec3(3, 66, 3)];
  w3.bot.blockAt = p => ({ name: 'oak_log', type: logId, position: p, boundingBox: 'block' });
  w3.bot.dig = async b => { w3.inv.set('oak_log', (w3.inv.get('oak_log') || 0) + 1); };
  const r3 = await gather.collect({ bot: w3.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(3, 'collect', {}, 'brain'), { block: 'oak_log', count: 4 });
  assert(/^нет:/.test(r3.axe), 'axe ' + r3.axe);
  w3.inv.set('iron_axe', 1);
  const r4 = await gather.collect({ bot: w3.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(4, 'collect', {}, 'brain'), { block: 'oak_log', count: 4 });
  assert.strictEqual(r4.axe, 'had iron_axe');
  vision.find = oldFind;
  console.log('collect log axe OK', r3.axe, '|', r4.axe);
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
