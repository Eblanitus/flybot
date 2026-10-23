// Офлайн-проверка collect stone: камня не видно (под землёй) -> не копает лесенку, а падает с ошибкой
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
  // Камень на уровне 65-66 (видно), грязь ниже
  const name = (x, y, z) => { const k = key(x, y, z); if (blocks.has(k)) return blocks.get(k); if (lavaAt && lavaAt(x, y, z)) return 'lava'; return y > 66 ? 'air' : y === 66 ? 'stone' : y === 65 ? 'stone' : y >= 63 ? 'dirt' : 'stone'; };
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

function makeOwnBlocks(map) {
  return {
    has: (pos) => map.has(pos.toString()),
    get: (pos) => map.get(pos.toString())
  };
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
  // НЕТ спуска вниз — collect не копает лесенку
  assert(w.bot.entity.position.y >= 66, 'не спустился, y=' + w.bot.entity.position.y);
  console.log('collect stone OK (no tunneling)', JSON.stringify(r), 'y=' + w.bot.entity.position.y);

  // --- собственные блоки не целятся ---
  const wOwn = mkWorld();
  const ownBlocks = new Map();
  ownBlocks.set('1,65,0', { name: 'cobblestone', t: Date.now(), by: 'autopilot' }); // свой блок рядом
  wOwn.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = (ctx, ids) => {
    const out = []; const p = wOwn.bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (!ids.includes(wOwn.bot.blockAt(new Vec3(x, y, z)).type)) continue;
      if (A.FACES.some(f => wOwn.bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  const ctxOwn = { bot: wOwn.bot, stats: { blocksMined: 0 }, tasks: {}, ownBlocks: makeOwnBlocks(ownBlocks) };
  // Камень есть рядом (не свой), должен добыть его, а не свой блок
  const rOwn = await gather.collect(ctxOwn, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 5 });
  assert(rOwn.mined >= 5, 'mined ownBlocks ' + rOwn.mined);
  console.log('collect skips own blocks OK');

  // --- моб рядом: сбор прекращается ---
  const wMob = mkWorld();
  wMob.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = (ctx, ids) => {
    const out = []; const p = wMob.bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (!ids.includes(wMob.bot.blockAt(new Vec3(x, y, z)).type)) continue;
      if (A.FACES.some(f => wMob.bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  // Мок danger.state — моб в 5 м
  const danger = require('../lib/danger');
  const origState = danger.state;
  danger.state = () => ({
    mobs: { mobs: [{ name: 'zombie', d: 5 }, { name: 'creeper', d: 8 }] }
  });
  const ctxMob = { bot: wMob.bot, stats: { blocksMined: 0 }, tasks: {} };
  await assert.rejects(gather.collect(ctxMob, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 5 }),
    e => { console.log('mob near ->', e.message); return /моб.*рядом: сбор прекращён/.test(e.message); });
  danger.state = origState;
  console.log('collect stops for mob OK');

  // --- approachKnownLimited: лимит 16 м, гейт ночи/мобов/HP ---
  const wm = require('../lib/worldmem');
  const wm2 = wm.get({ dataDir: null });
  wm2.recs.clear(); wm2.byKind.clear(); wm2.cellIdx.clear();
  // Добавить известный камень в 8 м (кратно 4 для thin)
  wm2.observe('stone', 8, 64, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });
  // Добавить известный камень в 32 м (должен игнорироваться)
  wm2.observe('stone', 32, 64, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });

  const ctxKnown = { bot: w.bot, stats: { blocksMined: 0 }, tasks: {}, dataDir: null, worldmem: wm2 };
  w.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = () => []; // ничего не видно

  // Мок danger.state — день, нет мобов, HP высокое
  danger.state = () => ({
    mobs: { mobs: [] },
    hp: 20
  });
  const tun = { dir: [1, 0], deep: false, steps: 0, startY: 66, until: Date.now() + 150000 };
  const resKnown = await gather.approachKnownLimited(ctxKnown, new Task(1, 'test', {}, 'test'), ['stone'], tun);
  assert(resKnown === true, 'дошла до известного камня в 8 м');
  console.log('approachKnownLimited within 16m OK');

  // Гейт: ночь + HP < 10 + нет оружия -> отказ
  w.bot.entity.position = new Vec3(0.5, 66, 0.5);
  w.bot.health = 8;
  w.bot.inventory.items = () => []; // нет оружия
  danger.state = () => ({
    mobs: { mobs: [{ name: 'zombie', d: 12 }] }, // ночь — есть зомби
    hp: 8
  });
  await assert.rejects(gather.approachKnownLimited(ctxKnown, new Task(2, 'test', {}, 'test'), ['stone'], tun),
    e => { console.log('night gate ->', e.message); return /ночь.*HP.*нет оружия/.test(e.message); });

  // Гейт: моб ближе 10 м -> отказ
  w.bot.health = 20;
  danger.state = () => ({
    mobs: { mobs: [{ name: 'creeper', d: 5 }] },
    hp: 20
  });
  await assert.rejects(gather.approachKnownLimited(ctxKnown, new Task(3, 'test', {}, 'test'), ['stone'], tun),
    e => { console.log('mob gate ->', e.message); return /моб.*м рядом: не иду/.test(e.message); });

  // Гейт: блок дальше 16 м -> false (не идёт)
  w.bot.entity.position = new Vec3(0.5, 66, 0.5);
  wm2.recs.clear(); wm2.byKind.clear(); wm2.cellIdx.clear();
  wm2.observe('stone', 30, 66, 0, { d: 'overworld', t: Date.now(), src: 'seen' });
  danger.state = () => ({ mobs: { mobs: [] }, hp: 20 });
  const resFar = await gather.approachKnownLimited(ctxKnown, new Task(4, 'test', {}, 'test'), ['stone'], tun);
  assert(resFar === false, 'блок в 30 м игнорируется');
  console.log('approachKnownLimited distance limit OK');

  danger.state = origState;
  console.log('approachKnownLimited gates OK');

  // --- checkMobNear ---
  const ctxMob2 = { bot: wMob.bot, stats: { blocksMined: 0 }, tasks: {} };
  danger.state = () => ({ mobs: { mobs: [{ name: 'spider', d: 10.1 }] } });
  assert.doesNotThrow(() => gather.checkMobNear(ctxMob2), 'моб в 10.1 м не останавливает');
  danger.state = () => ({ mobs: { mobs: [{ name: 'spider', d: 11 }] } });
  assert.doesNotThrow(() => gather.checkMobNear(ctxMob2), 'моб в 11 м не останавливает');
  danger.state = () => ({ mobs: { mobs: [{ name: 'spider', d: 10 }] } });
  assert.throws(() => gather.checkMobNear(ctxMob2), /моб spider 10\.0 м рядом/, 'моб в 10 м останавливает');
  danger.state = () => ({ mobs: { mobs: [{ name: 'spider', d: 9.9 }] } });
  assert.throws(() => gather.checkMobNear(ctxMob2), /моб spider 9\.9 м рядом/, 'моб в 9.9 м останавливает');
  danger.state = () => ({ mobs: { mobs: [] } });
  assert.doesNotThrow(() => gather.checkMobNear(ctxMob2), 'нет мобов — ок');
  danger.state = origState;
  console.log('checkMobNear OK');

  // --- isOwnBlock ---
  const ownMap = new Map();
  ownMap.set('5,66,0', { name: 'cobblestone', t: Date.now(), by: 'autopilot' });
  const ctxOwn2 = { ownBlocks: makeOwnBlocks(ownMap) };
  assert(gather.isOwnBlock(ctxOwn2, new Vec3(5, 66, 0)) === true, 'свой блок определяется');
  assert(gather.isOwnBlock(ctxOwn2, new Vec3(6, 66, 0)) === false, 'чужой блок не свой');
  assert(gather.isOwnBlock({}, new Vec3(5, 66, 0)) === false, 'нет ownBlocks — false');
  console.log('isOwnBlock OK');

  console.log('ALL COLLECT TESTS PASSED');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });