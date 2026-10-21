// Офлайн-проверка collect stone: камня не видно (под землёй) -> копает лесенку вниз и добывает
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const A = require('../lib/actions');
const vision = require('../lib/vision');
const gather = require('../lib/skills/gather');
const reg = require('minecraft-data')('1.21.4');

function mkWorld(lavaAt, harvest) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const name = (x, y, z) => { const k = key(x, y, z); if (blocks.has(k)) return blocks.get(k); if (lavaAt && lavaAt(x, y, z)) return 'lava'; return y > 65 ? 'air' : y === 65 ? 'grass_block' : y >= 63 ? 'dirt' : 'stone'; };
  const mk = (x, y, z) => { const n = name(x, y, z); const d = reg.blocksByName[n]; return { name: n, type: d.id, boundingBox: d.boundingBox, position: new Vec3(x, y, z), harvestTools: harvest ? d.harvestTools : undefined }; };
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
  A.goto = async (ctx, t, goal) => { if (goal.constructor.name !== 'GoalBlock') return true; ctx.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
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

  // --- высота: цель далеко внизу (пещера) пропускается в пользу туннеля у стартовой высоты; deep:true разрешает
  const honest = bot => (ctx, ids) => {
    const out = []; const p = bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (ids.includes(bot.blockAt(new Vec3(x, y, z)).type) && A.FACES.some(f => bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  const far = new Vec3(3, 40, 3);
  const w5 = mkWorld();
  vision.find = (c, ids) => [...honest(w5.bot)(c, ids), far];
  const r5 = await gather.collect({ bot: w5.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(5, 'collect', {}, 'brain'), { block: 'stone', count: 8 });
  assert(r5.mined >= 8 && !w5.blocks.has('3,40,3'), 'далёкая цель не должна браться');
  assert(w5.bot.entity.position.y >= 60, 'остался у стартовой высоты, y=' + w5.bot.entity.position.y);
  const w6 = mkWorld();
  vision.find = (c, ids) => [...honest(w6.bot)(c, ids), far];
  const goto0 = A.goto; A.goto = async (c, t, g) => { if (g.constructor.name === 'GoalLookAtBlock') c.bot.entity.position = new Vec3(g.pos ? g.pos.x : 3, 39, 3); else return goto0(c, t, g); return true; };
  await gather.collect({ bot: w6.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(6, 'collect', {}, 'brain'), { block: 'stone', count: 1, deep: true });
  A.goto = goto0;
  assert.strictEqual(w6.blocks.get('3,40,3'), 'air', 'deep:true берёт далёкую цель');
  console.log('collect height band OK y=' + w5.bot.entity.position.y);
  // --- кирка сломалась посреди задачи -> скрафчена каменная, добыча продолжается
  const w7 = mkWorld(null, true);
  w7.inv.set('wooden_pickaxe', 1); w7.inv.set('cobblestone', 61); w7.inv.set('stick', 4);
  vision.find = honest(w7.bot);
  let digs = 0; const dig0 = w7.bot.dig;
  w7.bot.dig = async b => { await dig0(b); if (++digs === 3) w7.inv.delete('wooden_pickaxe'); };
  let cw = w7; const crafted = []; const craft0 = require('../lib/skills/craft').craftItem;
  require('../lib/skills/craft').craftItem = async (c, t, name) => {
    crafted.push(name);
    if (name !== 'stone_pickaxe' || (cw.inv.get('cobblestone') || 0) < 3 || (cw.inv.get('stick') || 0) < 2) throw new Error('не хватает палок');
    cw.inv.set('cobblestone', cw.inv.get('cobblestone') - 3); cw.inv.set('stick', cw.inv.get('stick') - 2); cw.inv.set(name, 1); return 1;
  };
  try {
    const r7 = await gather.collect({ bot: w7.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(7, 'collect', {}, 'brain'), { block: 'stone', count: 8 });
    assert(r7.mined >= 8, 'mined ' + r7.mined);
    assert.deepStrictEqual(crafted, ['stone_pickaxe']);
    assert(w7.inv.get('stone_pickaxe') === 1);
    // крафт невозможен (палок нет) -> ошибка с причиной
    const w8 = mkWorld(null, true); w8.inv.set('cobblestone', 61); cw = w8;
    vision.find = honest(w8.bot);
    await assert.rejects(gather.collect({ bot: w8.bot, stats: { blocksMined: 0 }, tasks: {} }, new Task(8, 'collect', {}, 'brain'), { block: 'stone', count: 3 }), e => { return /нужен инструмент[^]*скрафтить не вышло/.test(e.message); });
  } finally { require('../lib/skills/craft').craftItem = craft0; vision.find = oldFind; }
  console.log('collect pickaxe auto-craft OK', crafted.join());
  // --- подпорки: булыжник только сверх запаса, доски никогда; учёт чистого прироста и spent
  const fake = inv => ({ inventory: { items: () => Object.entries(inv).map(([name, count]) => ({ name, count })) }, registry: reg });
  const sn = (inv, r) => A.scaffoldNames(fake(inv), r);
  assert(!sn({ cobblestone: 32, oak_planks: 64 }).includes('cobblestone') && !sn({ oak_planks: 64 }).includes('oak_planks'));
  assert(sn({ cobblestone: 33 }).includes('cobblestone') && sn({ cobblestone: 33 }).includes('dirt'));
  assert(!sn({ cobblestone: 40 }, 40).includes('cobblestone') && sn({ cobbled_deepslate: 41 }, 40).includes('cobbled_deepslate'));
  assert(sn({}).includes('andesite') && sn({}).includes('netherrack') && !sn({}).includes('cobblestone'));
  const w9 = mkWorld(); w9.inv.set('cobblestone', 10);
  vision.find = honest(w9.bot);
  const goto1 = A.goto; let seenReserve;
  A.goto = async (c, t, g) => { seenReserve = c.blockReserve; if (g.constructor.name === 'GoalBlock') { w9.inv.set('cobblestone', Math.max(0, w9.inv.get('cobblestone') - 1)); } return goto1(c, t, g); };
  const ctx9 = { bot: w9.bot, stats: { blocksMined: 0 }, tasks: {} };
  const r9 = await gather.collect(ctx9, new Task(9, 'collect', {}, 'brain'), { block: 'stone', count: 5 });
  A.goto = goto1; vision.find = oldFind;
  assert.strictEqual(seenReserve, 5); assert.strictEqual(ctx9.blockReserve, undefined);
  assert(r9.spent >= 1 && r9.mined > 5 - 0 && w9.inv.get('cobblestone') - 10 >= 5, JSON.stringify(r9));
  console.log('scaffold reserve + net gain OK', JSON.stringify(r9));
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
