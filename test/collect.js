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
    has: (pos) => map.has(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`),
    get: (pos) => map.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`)
  };
}

// Генератор мира с заданной функцией блоков
function mkWorldCustom(blockFn, harvest) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const name = (x, y, z) => { const k = key(x, y, z); if (blocks.has(k)) return blocks.get(k); return blockFn(x, y, z); };
  const mk = (x, y, z) => { const n = name(x, y, z); const d = reg.blocksByName[n]; return { name: n, type: d.id, boundingBox: d.boundingBox, position: new Vec3(x, y, z), harvestTools: harvest ? d.harvestTools : undefined }; };
  const inv = new Map();
  const bot = {
    registry: reg, entity: { position: new Vec3(0.5, 66, 0.5) }, username: 'T', heldItem: null,
    blockAt: p => mk(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    dig: async b => { const k = key(b.position.x, b.position.y, b.position.z); blocks.set(k, 'air'); const it = b.name === 'stone' ? 'cobblestone' : b.name; inv.set(it, (inv.get(it) || 0) + 1); },
    stopDigging() {}, clearControlStates() {},
    inventory: { items: () => [...inv].map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) }
  };
  return { bot, inv, blocks, name, key };
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
  w.bot.time = 14000; // ночь
  w.bot.health = 8;
  w.bot.inventory.items = () => []; // нет оружия
  danger.state = () => ({
    mobs: { mobs: [] }, // мобы не нужны для определения ночи
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

  // --- hasDropBelow (через проверку в collect) ---
  // Мир: камень на y=66, под ним воздух до y=60 (перепад 6 блоков)
  const wDrop = mkWorldCustom((x, y, z) => {
    if (x === 5 && y === 66 && z === 0) return 'stone';
    if (y < 66 && y >= 60) return 'air';
    if (y < 60) return 'stone';
    return y > 66 ? 'air' : 'stone';
  });
  wDrop.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = (ctx, ids) => {
    const out = []; const p = wDrop.bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (!ids.includes(wDrop.bot.blockAt(new Vec3(x, y, z)).type)) continue;
      if (A.FACES.some(f => wDrop.bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  vision.forget = () => {};
  A.goto = async (ctx, t, goal) => { if (goal.constructor.name !== 'GoalBlock') return true; ctx.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
  A.pickupDrops = async () => {};
  const ctxDrop = { bot: wDrop.bot, stats: { blocksMined: 0 }, tasks: {} };
  // Цель в 5,66,0 — под ней перепад 6 блоков, collect должен пропустить и выбросить ошибку (нет целей)
  await assert.rejects(gather.collect(ctxDrop, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 5 }),
    e => { console.log('drop below ->', e.message); return /не вижу stone/.test(e.message); });
  console.log('collect skips block with drop below OK');

  // --- цель под ногами ---
  // Мир: только блок (0,66,0) — камень с воздухом сверху; везде воздух или не-камень
  const wFeet = mkWorldCustom((x, y, z) => {
    if (x === 0 && y === 66 && z === 0) return 'stone'; // только этот блок — камень
    if (y === 67 && x === 0 && z === 0) return 'air'; // над ним воздух
    return 'air'; // всё остальное воздух (не камень)
  });
  wFeet.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = (ctx, ids) => {
    const out = []; const p = wFeet.bot.entity.position.floored();
    for (let x = p.x - 8; x <= p.x + 8; x++) for (let y = p.y - 12; y <= p.y + 4; y++) for (let z = p.z - 8; z <= p.z + 8; z++) {
      if (!ids.includes(wFeet.bot.blockAt(new Vec3(x, y, z)).type)) continue;
      if (A.FACES.some(f => wFeet.bot.blockAt(new Vec3(x, y, z).plus(f)).name === 'air')) out.push(new Vec3(x, y, z));
    }
    return out;
  };
  const ctxFeet = { bot: wFeet.bot, stats: { blocksMined: 0 }, tasks: {} };
  // Блок под ногами (0,66,0) — collect должен его пропустить и не находить других -> ошибка
  await assert.rejects(gather.collect(ctxFeet, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 5 }),
    e => { console.log('under feet ->', e.message); return /не вижу stone/.test(e.message); });
  console.log('collect skips block under feet OK');

  // --- approachKnownLimited: гейт ночи по времени/свете ---
  wm2.recs.clear(); wm2.byKind.clear(); wm2.cellIdx.clear();
  wm2.observe('stone', 10, 64, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });

  const ctxKnown2 = { bot: w.bot, stats: { blocksMined: 0 }, tasks: {}, dataDir: null, worldmem: wm2 };
  w.bot.entity.position = new Vec3(0.5, 66, 0.5);
  vision.find = () => [];

  // Ночь по времени (time=14000), HP < 10, нет оружия -> отказ
  w.bot.time = 14000;
  w.bot.health = 8;
  w.bot.inventory.items = () => [];
  danger.state = () => ({ mobs: { mobs: [] }, hp: 8 });
  const tun2 = { dir: [1, 0], deep: false, steps: 0, startY: 66, until: Date.now() + 150000 };
  await assert.rejects(gather.approachKnownLimited(ctxKnown2, new Task(5, 'test', {}, 'test'), ['stone'], tun2),
    e => { console.log('night time gate ->', e.message); return /ночь.*HP.*нет оружия/.test(e.message); });

  // День (time=6000), HP < 10, нет оружия -> проходит (день)
  w.bot.time = 6000;
  w.bot.health = 8;
  danger.state = () => ({ mobs: { mobs: [] }, hp: 8 });
  const resDay = await gather.approachKnownLimited(ctxKnown2, new Task(6, 'test', {}, 'test'), ['stone'], tun2);
  assert(resDay === true, 'днем гейт ночи не срабатывает');
  console.log('approachKnownLimited night gate by time OK');

  // Тёмное место (light level < 7), HP < 10, нет оружия -> отказ
  w.bot.time = 6000; // день
  w.bot.health = 8;
  w.bot.world = { getLightLevel: () => 4 }; // тёмно
  danger.state = () => ({ mobs: { mobs: [] }, hp: 8 });
  await assert.rejects(gather.approachKnownLimited(ctxKnown2, new Task(7, 'test', {}, 'test'), ['stone'], tun2),
    e => { console.log('dark gate ->', e.message); return /ночь.*HP.*нет оружия/.test(e.message); });
  console.log('approachKnownLimited dark gate OK');

  danger.state = origState;

  // --- спокойный день: известный камень до радиуса задачи (48 м), не только 16 м ---
  wm2.recs.clear(); wm2.byKind.clear(); wm2.cellIdx.clear();
  wm2.observe('stone', 40, 64, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });
  w.bot.entity.position = new Vec3(0.5, 66, 0.5);
  w.bot.time = 6000; w.bot.health = 20;
  w.bot.inventory.items = () => [];
  vision.find = () => [];
  danger.state = () => ({ mobs: { mobs: [] }, hp: 20 });
  delete w.bot.world;
  const tunCalm = { dir: [1, 0], deep: false, steps: 0, startY: 66, until: Date.now() + 150000, maxDist: 48 };
  const resCalm = await gather.approachKnownLimited(ctxKnown, new Task(8, 'test', {}, 'test'), ['stone'], tunCalm);
  assert(resCalm === true, 'спокойный день: дошла до известного камня в 40 м');
  console.log('approachKnownLimited calm day radius OK');

  // --- ночь при HP >= 10: предел 16 м остаётся, камень в 30 м игнорируется ---
  wm2.recs.clear(); wm2.byKind.clear(); wm2.cellIdx.clear();
  wm2.observe('stone', 30, 64, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });
  w.bot.time = 14000;
  danger.state = () => ({ mobs: { mobs: [] }, hp: 20 });
  const resNight = await gather.approachKnownLimited(ctxKnown, new Task(9, 'test', {}, 'test'), ['stone'], tunCalm);
  assert(resNight === false, 'ночь: не иду к известному камню в 30 м (лимит 16 м)');
  console.log('approachKnownLimited night 16m limit OK');

  // --- день, но HP < 10: предел 16 м остаётся ---
  w.bot.time = 6000; w.bot.health = 8;
  danger.state = () => ({ mobs: { mobs: [] }, hp: 8 });
  const resLowHp = await gather.approachKnownLimited(ctxKnown, new Task(10, 'test', {}, 'test'), ['stone'], tunCalm);
  assert(resLowHp === false, 'низкое HP: не иду к известному камню в 30 м (лимит 16 м)');
  console.log('approachKnownLimited low HP 16m limit OK');

  // --- известный камень вне полосы [startY-6, startY+4] добывается после подхода к нему ---
  const wBand = mkWorldCustom((x, y, z) => {
    if (x === 5 && y === 61 && z === 0) return 'stone';
    if (x === 5 && y === 60 && z === 0) return 'stone'; // опора под целью
    return 'air';
  });
  wBand.bot.entity.position = new Vec3(0.5, 68, 0.5);
  vision.find = (ctx, ids) => {
    const b = wBand.bot.blockAt(new Vec3(5, 61, 0));
    return ids.includes(b.type) ? [new Vec3(5, 61, 0)] : [];
  };
  vision.forget = () => {};
  // подходит рядом с блоком, но не на него (настоящий поиск пути так и ходит)
  A.goto = async (ctx, t, goal) => { if (goal.x != null) ctx.bot.entity.position = new Vec3(goal.x - 1.5, goal.y, goal.z + 0.5); return true; };
  A.pickupDrops = async () => {};
  const wmBand = wm.get({ dataDir: null });
  wmBand.recs.clear(); wmBand.byKind.clear(); wmBand.cellIdx.clear();
  wmBand.observe('stone', 5, 61, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });
  const ctxBand = { bot: wBand.bot, stats: { blocksMined: 0 }, tasks: {}, dataDir: null, worldmem: wmBand };
  w.bot.time = 6000; w.bot.health = 20;
  danger.state = () => ({ mobs: { mobs: [] }, hp: 20 });
  const resBand = await gather.collect(ctxBand, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 1 });
  assert(resBand.mined >= 1, 'известный камень вне полосы добыт после подхода, mined=' + resBand.mined);
  console.log('collect mines known block outside band OK');

  // --- отказ называет проверенное: подошёл к известному, но не виден после подхода ---
  const wMsg = mkWorldCustom(() => 'air');
  wMsg.bot.entity.position = new Vec3(0.5, 68, 0.5);
  vision.find = () => [];
  vision.forget = () => {};
  A.goto = async (ctx, t, goal) => { if (goal.x != null) ctx.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
  A.pickupDrops = async () => {};
  const wmMsg = wm.get({ dataDir: null });
  wmMsg.recs.clear(); wmMsg.byKind.clear(); wmMsg.cellIdx.clear();
  wmMsg.observe('stone', 5, 61, 0, { d: 'overworld', t: Date.now(), src: 'seen', exact: true });
  const ctxMsg = { bot: wMsg.bot, stats: { blocksMined: 0 }, tasks: {}, dataDir: null, worldmem: wmMsg };
  w.bot.time = 6000; w.bot.health = 20;
  danger.state = () => ({ mobs: { mobs: [] }, hp: 20 });
  await assert.rejects(gather.collect(ctxMsg, new Task(1, 'collect', {}, 'brain'), { block: 'stone', count: 5 }),
    e => { console.log('refusal ->', e.message); return /не вижу stone; подошёл к stone \(5, 61, 0\) — не виден после подхода; обошёл 1 из 1/.test(e.message); });
  console.log('collect refusal message OK');

  danger.state = origState;

  console.log('ALL COLLECT TESTS PASSED');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });