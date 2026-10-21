// Офлайн-проверка постоянной памяти мира (lib/worldmem.js): кластеры, чистка, учёт сундука, смерть, сохранение/загрузка, запросы, навык goto_known
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const W = require('../lib/worldmem');
const reg = require('minecraft-data')('1.21.4');

function clock() { const c = { t: 1_000_000_000, now: () => c.t, adv: ms => { c.t += ms; } }; return c; }
const P0 = { x: 0, y: 64, z: 0 };

// ---------- кластеры, дедупликация, лимиты ----------
function testClusters() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  // жила из 5 соседних клеток + повторное наблюдение тех же клеток -> одна запись, count не растёт
  for (let i = 0; i < 5; i++) wm.observe('iron_ore', 10 + i, 12, 10, { d: 'overworld' });
  for (let i = 0; i < 5; i++) wm.observe('iron_ore', 10 + i, 12, 10, { d: 'overworld' });
  assert.strictEqual(wm.near('iron_ore', P0).length, 1);
  assert.strictEqual(wm.near('iron_ore', P0)[0].n, 5);
  // далёкая клетка и клетка другого вида — отдельные записи
  wm.observe('iron_ore', 100, 12, 100, {});
  wm.observe('coal_ore', 11, 12, 11, {});
  assert.strictEqual(wm.near('iron_ore', P0, { limit: 9 }).length, 2);
  assert.strictEqual(wm.near('coal_ore', P0)[0].n, 1);
  // deepslate-вариант — тот же вид (kindOfBlock), 'iron' -> iron_ore, 'ore' -> все руды
  assert.strictEqual(W.kindOfBlock('deepslate_iron_ore'), 'iron_ore');
  assert.strictEqual(W.kindOfBlock('oak_log'), 'tree'); assert.strictEqual(W.kindOfBlock('stripped_oak_log'), null);
  assert.deepStrictEqual(W.resolveKinds('iron'), ['iron_ore']); assert.deepStrictEqual(W.resolveKinds('wood'), ['tree']);
  assert.strictEqual(wm.near('ore', P0, { limit: 9 }).length, 3);
  // потолок клеток в записи: длинная жила делится на несколько записей, клетки не теряются
  for (let i = 0; i < 100; i++) wm.observe('gold_ore', 200 + i, 10, 0, {});
  const gold = wm.near('gold_ore', { x: 250, y: 10, z: 0 }, { limit: 20 });
  assert(gold.length >= 3, 'жила разбита: ' + gold.length);
  assert.strictEqual(gold.reduce((s, r) => s + r.n, 0), 100);
  assert(gold.every(r => r.n <= W.CFG.ore.cells));
  // разрежение воды: образцы 4x4, а не каждая клетка
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) wm.observe('water', x, 62, z, {});
  assert.strictEqual(wm.near('water', P0, { limit: 9 }).reduce((s, r) => s + r.n, 0), 16);
  // потолок записей вида: вытесняются самые старые, свежие остаются
  const wm2 = new W.WorldMem({ now: c.now });
  for (let i = 0; i < 80; i++) { c.adv(1000); wm2.observe('diamond_ore', i * 50, 5, 0, {}); }
  const dia = wm2.near('diamond_ore', P0, { limit: 200 });
  assert.strictEqual(dia.length, W.CFG.ore.cap);
  assert(dia.some(r => r.at[0] === 79 * 50) && !dia.some(r => r.at[0] === 0), 'вытеснена старая запись, свежая осталась');
  // измерения не смешиваются
  wm.observe('iron_ore', 10, 12, 10, { d: 'minecraft:the_nether' });
  assert.strictEqual(wm.near('iron_ore', P0, { limit: 9, d: 'overworld' }).length, 2);
  assert.strictEqual(wm.near('iron_ore', P0, { limit: 9, d: 'the_nether' }).length, 1);
  // дистанция и возраст
  c.adv(30000);
  const r = wm.near('coal_ore', P0)[0];
  assert(r.dist > 53 && r.dist < 55, 'dist ' + r.dist); assert(r.ageSec >= 30 && r.dir);
  console.log('worldmem: clusters OK');
}

// ---------- чистка ----------
function testCleanup() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  for (let i = 0; i < 4; i++) wm.observe('copper_ore', 20 + i, 30, 5, {});
  // добыла сама: запись уменьшается, при нуле исчезает
  wm.removeCell(20, 30, 5, 'overworld', { mined: true });
  let r = wm.near('copper_ore', P0)[0]; assert.strictEqual(r.n, 3); assert.strictEqual(r.mined, 1);
  // чистка по зрению: на месте воздух и клетка видна -> убрана; не видна -> остаётся; на месте руда -> свежесть подтверждена
  const world = { '21,30,5': 'air', '22,30,5': 'copper_ore', '23,30,5': 'stone' };
  c.adv(60000);
  const seen = new Set(['21,30,5', '22,30,5']);
  const res = wm.sweep({ pos: { x: 22, y: 30, z: 0 }, nameAt: (x, y, z) => world[x + ',' + y + ',' + z] || null, visible: (x, y, z) => seen.has(x + ',' + y + ',' + z) });
  assert.strictEqual(res.removed, 1); assert.strictEqual(res.confirmed, 1);
  r = wm.near('copper_ore', P0)[0]; assert.strictEqual(r.n, 2); assert(r.ageSec < 5, 'подтверждена видимой клеткой');
  seen.add('23,30,5'); world['23,30,5'] = 'air';
  wm.sweep({ pos: { x: 22, y: 30, z: 0 }, nameAt: (x, y, z) => world[x + ',' + y + ',' + z] || null, visible: (x, y, z) => seen.has(x + ',' + y + ',' + z) });
  assert.strictEqual(wm.near('copper_ore', P0)[0].n, 1);
  wm.removeCell(22, 30, 5, 'overworld', { mined: true });
  assert.strictEqual(wm.near('copper_ore', P0).length, 0, 'выработанная жила убрана');
  // лес: вырубили -> пометка cleared, в обычной выдаче нет, с cleared=1 есть и помнит сколько было
  for (let i = 0; i < 6; i++) wm.observe('tree', 50, 64 + i, 50, { block: 'birch_log' });
  assert.strictEqual(wm.near('tree', P0)[0].species, 'birch');
  for (let i = 0; i < 6; i++) wm.removeCell(50, 64 + i, 50, 'overworld', { mined: true });
  assert.strictEqual(wm.near('tree', P0).length, 0);
  const cl = wm.near('tree', P0, { includeCleared: true });
  assert(cl.length === 1 && cl[0].cleared && cl[0].was === 6, JSON.stringify(cl));
  // новые деревья на том же месте — пометка исчезает
  wm.observe('tree', 51, 64, 50, {});
  assert.strictEqual(wm.near('tree', P0, { includeCleared: true }).length, 1);
  assert(!wm.near('tree', P0)[0].cleared);
  console.log('worldmem: cleanup OK');
}

// ---------- сундуки: открытие через bot.openBlock, положили/взяли ----------
function fakeWindow(items) {
  const w = new EventEmitter(); w.slots = items.map(([name, count]) => ({ name, count }));
  w.containerItems = () => w.slots.filter(s => s.count > 0);
  w.close = () => w.emit('close');
  return w;
}
async function testChest() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  const win = fakeWindow([['cobblestone', 40], ['coal', 3]]);
  const bot = new EventEmitter();
  bot.game = { dimension: 'minecraft:overworld' }; bot.heldItem = { name: 'chest' };
  bot.openBlock = async () => win; // как в mineflayer: openContainer идёт через openBlock
  bot.openContainer = async b => bot.openBlock(b);
  bot.placeBlock = async () => {};
  bot.dig = async () => {};
  const ctx = { worldmem: wm, bot, events: { push() {} } };
  W.hookBot(ctx, bot);
  W.hookBot(ctx, bot); // повторно — без двойной обёртки
  const block = { name: 'chest', position: new Vec3(5, 64, 5) };
  await bot.openContainer(block);
  let r = wm.near('chest', P0)[0];
  assert.deepStrictEqual(r.items, { cobblestone: 40, coal: 3 }); assert(!r.own, 'чужой, пока ничего не клала');
  // положила 20 земли и взяла уголь -> по закрытию содержимое обновлено, сундук «мой»
  win.slots.push({ name: 'dirt', count: 20 }); win.slots[1].count = 0;
  win.emit('updateSlot'); win.close();
  r = wm.near('chest', P0)[0];
  assert.deepStrictEqual(r.items, { cobblestone: 40, dirt: 20 }); assert(r.own, 'клала -> мой');
  const where = wm.itemsWhere('cobblestone', P0);
  assert.strictEqual(where.length, 1); assert.deepStrictEqual([where[0].where, where[0].count, where[0].at], ['chest', 40, [5, 64, 5]]);
  assert.strictEqual(wm.itemsWhere('coal', P0).length, 0, 'угля в сундуке больше нет');
  assert.strictEqual(wm.itemsWhere('dir', P0)[0].item, 'dirt', 'подстрока');
  // поставила сундук сама -> свой
  await bot.placeBlock({ position: new Vec3(9, 63, 9) }, new Vec3(0, 1, 0));
  const own = wm.near('chest', { x: 9, y: 64, z: 9 })[0]; assert.deepStrictEqual(own.at, [9, 64, 9]); assert(own.own && own.src === 'touched');
  // добыла лог через bot.dig -> клетка убрана
  wm.observe('tree', 7, 64, 7, {}); wm.observe('tree', 7, 65, 7, {});
  await bot.dig({ name: 'oak_log', position: new Vec3(7, 65, 7) });
  assert.strictEqual(wm.near('tree', P0)[0].n, 1);
  // верстак открыт -> запомнен
  bot.openBlock = async () => fakeWindow([]); W.hookBot(ctx, bot);
  // (повторная обёртка не нужна — openBlock уже обёрнут старой функцией; проверим прямым вызовом)
  W.onOpened(ctx, bot, { name: 'crafting_table', position: new Vec3(3, 64, 3) }, fakeWindow([]));
  assert.strictEqual(wm.near('table', P0)[0].src, 'touched');
  console.log('worldmem: chest OK');
}

// ---------- смерть, дроп, recover ----------
function testDeath() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  const ctx = { worldmem: wm, bot: null };
  wm.addDeath({ x: 100, y: 60, z: -40, inv: { iron_pickaxe: 1, cobblestone: 64, bread: 3 } });
  W.onEvent(ctx, 'death', { cause: 'zombie', at: [100, 60, -40] });
  let d = wm.near('death', P0)[0];
  assert.strictEqual(d.cause, 'zombie'); assert.strictEqual(d.status, 'lying'); assert.strictEqual(d.loot.cobblestone, 64);
  let w = wm.itemsWhere('cobblestone', P0);
  assert.strictEqual(w[0].where, 'death'); assert.strictEqual(w[0].count, 64); assert(w[0].expiresInSec > 250);
  assert(/вещи со смерти/.test(wm.brief(P0)));
  // recover отработал: вещи подобраны
  W.onEvent(ctx, 'task_done', { name: 'recover', result: { gained: { cobblestone: 64 }, itemsLeft: 0 } });
  d = wm.near('death', P0)[0]; assert.strictEqual(d.status, 'recovered'); assert.deepStrictEqual(d.got, { cobblestone: 64 });
  assert.strictEqual(wm.itemsWhere('cobblestone', P0).length, 0, 'подобранное больше не «лежит»');
  assert.strictEqual(wm.itemsWhere('cobblestone', P0, { all: true }).length, 1);
  // вторая смерть: через 5 минут вещи исчезли
  c.adv(60000); wm.addDeath({ x: 5, y: 60, z: 5, inv: { diamond: 2 } });
  assert.strictEqual(wm.itemsWhere('diamond', P0).length, 1);
  c.adv(6 * 60 * 1000);
  assert.strictEqual(wm.itemsWhere('diamond', P0).length, 0); assert.strictEqual(wm.near('death', P0, { limit: 5 }).find(v => v.at[0] === 5).status, 'expired');
  // тот же сдвоенный сигнал смерти не плодит записи
  const n = wm.near('death', P0, { limit: 9 }).length; wm.addDeath({ x: 5, y: 60, z: 5, inv: {} }); assert(wm.near('death', P0, { limit: 9 }).length <= n + 1);
  // игроки и точка возрождения
  wm.sight('Steve', 10, 64, 10); c.adv(5000); wm.sight('Steve', 12, 64, 10); wm.sight('Alex', -30, 64, 0);
  assert.strictEqual(wm.near('player', P0, { limit: 9 }).length, 2);
  const st = wm.near('player', P0, { name: 'steve' })[0]; assert.deepStrictEqual(st.at, [12, 64, 10]); assert(st.ageSec <= 5);
  wm.setSpawn(0, 70, 0, 'overworld', 'world'); wm.setSpawn(1, 70, 1, 'overworld', 'world');
  assert.strictEqual(wm.near('spawn', P0).length, 1);
  // деревня
  wm.observe('bed', 200, 64, 200, {}); wm.village(205, 64, 205, 'overworld', { bell: [205, 64, 205], villagers: 3 }); wm.village(210, 64, 210, 'overworld', { villagers: 5 });
  const v = wm.near('village', P0); assert.strictEqual(v.length, 1); assert.deepStrictEqual([v[0].bell, v[0].villagers, v[0].beds], [true, 5, 1]);
  // пещера
  wm.cave(40, 20, 40, 'overworld', 300); wm.cave(44, 20, 40, 'overworld', 500);
  assert.strictEqual(wm.near('cave', P0)[0].size, 500); assert.strictEqual(wm.near('cave', P0, { limit: 9 }).length, 1);
  console.log('worldmem: death/players/village OK');
}

// ---------- сохранение и загрузка ----------
async function testPersist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-')); const file = path.join(dir, 'data', 'world.json');
  const c = clock(); const wm = new W.WorldMem({ file, now: c.now });
  for (let i = 0; i < 7; i++) wm.observe('iron_ore', -10 - i, 20, -5, {});
  wm.observe('tree', 30, 64, 30, { block: 'oak_log' });
  wm.setChestItems(1, 64, 1, 'overworld', { cobblestone: 12, dirt: 3 }, { mine: true });
  wm.addDeath({ x: 7, y: 60, z: 7, inv: { stick: 4 } });
  wm.sight('Bob', 3, 64, 3);
  wm.observe('tree', 90, 64, 90, {}); wm.removeCell(90, 64, 90, 'overworld', { mined: true });
  assert(await wm.save(), 'запись'); assert(!wm.dirty);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).sort(), ['world.json'], 'временный файл не остался');
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); assert.strictEqual(j.v, 1); assert(j.recs.length >= 6);
  const wm2 = new W.WorldMem({ file, now: c.now }); assert(wm2.load());
  assert.strictEqual(wm2.size, wm.size);
  const a = wm.near('iron_ore', P0)[0], b = wm2.near('iron_ore', P0)[0];
  assert.deepStrictEqual([b.n, b.at, b.kind], [a.n, a.at, a.kind]);
  assert.deepStrictEqual(wm2.itemsWhere('cobblestone', P0)[0].count, 12); assert(wm2.near('chest', P0)[0].own);
  assert.strictEqual(wm2.itemsWhere('stick', P0)[0].where, 'death');
  assert.strictEqual(wm2.near('player', P0)[0].name, 'Bob');
  assert.strictEqual(wm2.near('tree', P0, { includeCleared: true }).filter(r => r.cleared).length, 1, 'пометка вырубленного пережила перезапуск');
  // после загрузки клетки не задваиваются, а новые id не пересекаются со старыми
  wm2.observe('iron_ore', -10, 20, -5, {}); assert.strictEqual(wm2.near('iron_ore', P0)[0].n, 7);
  const ids = new Set([...wm2.recs.keys()]); wm2.observe('coal_ore', 500, 5, 500, {}); assert.strictEqual(wm2.recs.size, ids.size + 1);
  // синхронная запись (при выходе) и битый файл
  wm2.observe('coal_ore', 600, 5, 600, {}); assert(wm2.saveSync()); assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recs.length, wm2.size);
  fs.writeFileSync(file, '{"v":1,"recs":[{"k":"iron');
  const wm3 = new W.WorldMem({ file, now: c.now }); assert(!wm3.load()); assert.strictEqual(wm3.size, 0);
  assert(fs.readdirSync(path.dirname(file)).some(f => f.includes('corrupt')), 'битый файл отложен, а не затёрт молча');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('worldmem: persist OK');
}

// ---------- выжимка и запросы ----------
function testBriefAndQuery() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  assert(/железо нет/.test(wm.brief(P0)));
  ['iron_ore', 'coal_ore', 'copper_ore'].forEach((k, j) => { for (let i = 0; i < 30; i++) wm.observe(k, 100 + i * 20, 12, 100 + j * 50, {}); });
  for (let i = 0; i < 15; i++) wm.observe('tree', 300, 64 + i, 20, { block: 'oak_log' });
  wm.observe('water', 40, 62, 40, {}); wm.observe('lava', 10, 60, 10, { exact: true });
  wm.observe('bed', 50, 64, 50, {}); wm.setChestItems(60, 64, 60, 'overworld', { cobblestone: 64, dirt: 30, coal: 5, stick: 1 }, { mine: true });
  const b = wm.brief(P0);
  assert(b.length <= 400, 'длина ' + b.length);
  for (const w of ['лес', 'камень', 'уголь', 'железо', 'медь', 'вода', 'кровать', 'сундук', 'ЛАВА', 'cobblestone64']) assert(!/(лес|уголь|железо|медь) нет/.test(b) && b.includes(w), w + ' в «' + b + '»');
  // near=x,y,z и limit в запросе
  const ctx = { worldmem: wm, bot: { entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' }, inventory: { items: () => [{ name: 'cobblestone', count: 5 }] } } };
  const q = new URLSearchParams('kind=iron_ore&near=500,12,100&limit=3');
  const res = W.handleMemory(ctx, q);
  assert(res.ok && res.results.length === 3 && res.results[0].dist <= res.results[1].dist && res.results[0].at[0] >= 480, JSON.stringify(res.results[0]));
  const items = W.handleItems(ctx, new URLSearchParams('name=cobblestone'));
  assert(items.ok && items.places[0].where === 'chest' && items.places[0].count === 64 && items.inInventory === 5, JSON.stringify(items));
  assert(!W.handleItems(ctx, new URLSearchParams('')).ok);
  const sum = W.handleMemory(ctx, new URLSearchParams('')); assert(sum.kinds.iron_ore && sum.total > 0);
  // /snapshot.memory
  const snap = W.decorate(ctx, { ready: true }); assert.strictEqual(typeof snap.memory, 'string');
  console.log('worldmem: brief/query OK');
}

// ---------- tick: зрение -> память; goto_known / approachKnown на фальшивом боте ----------
async function testBodyIntegration() {
  const c = clock(); const wm = new W.WorldMem({ now: c.now });
  const air = reg.blocksByName.air.minStateId;
  const bot = new EventEmitter();
  Object.assign(bot, {
    registry: reg, username: 'T', entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8 }, game: { dimension: 'minecraft:overworld' },
    entities: {}, players: {}, inventory: { items: () => [{ name: 'dirt', count: 3 }] },
    world: { getColumnAt: () => ({}), getBlockStateId: () => air },
    blockAt: () => null
  });
  const mem = new Map(); const terrain = new Map();
  const put = (m, x, y, z, n) => m.set(x + ',' + y + ',' + z, { x, y, z, n, t: Date.now() });
  put(mem, 30, 20, 0, 'deepslate_iron_ore'); put(mem, 31, 20, 0, 'iron_ore'); put(mem, 5, 64, 8, 'spruce_log'); put(mem, 8, 64, 8, 'chest'); put(terrain, 4, 64, 4, 'stone');
  const ctx = { worldmem: wm, bot, ready: true, dataDir: os.tmpdir(), vision: { mem, terrain, dim: 'minecraft:overworld', lastScan: Date.now(), dirty: false, lastPos: bot.entity.position.clone(), liq: { t: 0, list: [] }, sweepAt: new Map() }, events: { push() {} }, tasks: { info() {} } };
  W.tick(ctx, bot);
  assert.strictEqual(wm.near('iron_ore', P0)[0].n, 2, 'руды из зрения, deepslate = тот же вид');
  assert.strictEqual(wm.near('tree', P0)[0].species, 'spruce');
  assert.strictEqual(wm.near('chest', P0).length, 1); assert.strictEqual(wm.near('stone', P0).length, 1);
  W.tick(ctx, bot); assert.strictEqual(wm.near('iron_ore', P0)[0].n, 2, 'повторный tick не задваивает');
  // на месте всего этого по миру воздух, но видимости нет (isVisible падает на фальшивом мире) — память не стирается вслепую
  assert.strictEqual(wm.near('iron_ore', P0)[0].n, 2);

  // goto_known: идёт к ближайшему, возвращает arrived
  bot.pathfinder = { goto: async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }, setGoal() {}, setMovements() {}, movements: null };
  ctx.movements = {}; ctx.sprintMovements = {};
  const t = new Task(1, 'goto_known', {}, 'brain');
  const r = await W.gotoKnown(ctx, t, { kind: 'iron' });
  assert(r.arrived && r.kind === 'iron_ore' && r.at[1] === 20, JSON.stringify(r));
  await assert.rejects(() => W.gotoKnown(ctx, t, { kind: 'emerald' }), /не дошла|не помню/);
  // approachKnown (подсказка для collect): ближе 12 м не ходит; далеко — идёт и true
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  const st = {};
  assert.strictEqual(await W.approachKnown(ctx, t, ['iron_ore', 'deepslate_iron_ore'], st), true);
  assert.strictEqual(await W.approachKnown(ctx, t, ['iron_ore'], st), false, 'рядом (<12 м) уже стоит у известного — не гоняет по кругу');
  assert.strictEqual(await W.approachKnown(ctx, t, ['cobblestone_unknown_block'], {}), false);
  // реестр навыков и legacy-команды
  const { SKILLS } = require('../lib/commands'); assert.strictEqual(typeof SKILLS.goto_known, 'function');
  console.log('worldmem: body OK');
}

module.exports = async () => {
  testClusters(); testCleanup(); await testChest(); testDeath(); await testPersist(); testBriefAndQuery(); await testBodyIntegration();
  console.log('worldmem: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
