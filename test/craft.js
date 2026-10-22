// Крафт без молчаливых потерь: честный итог (spent / crafted / placed / lost), свой верстак из памяти мира вместо нового,
// полный инвентарь — отказ ДО траты сырья (mineflayer при нехватке места молча выбрасывает результат на землю).
// Фальшивый бот повторяет живые условия: слоты 9..44 со стопками, крафт по рецепту как в mineflayer (результат — в стопку
// с местом, иначе в пустой слот, иначе на землю), постановка блока по грани соседа.
// Запуск: node test/craft.js (входит в node test/offline.js)
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const craft = require('../lib/skills/craft');
const worldmem = require('../lib/worldmem');

const task = () => new Task(1, 'craft', {}, 'brain');

// предметы и рецепты (как в minecraft-data: delta включает результат со знаком +)
const ITEMS = {
  spruce_log: { id: 1, stackSize: 64 }, spruce_planks: { id: 2, stackSize: 64 }, stick: { id: 3, stackSize: 64 },
  cobblestone: { id: 4, stackSize: 64 }, crafting_table: { id: 5, stackSize: 64 }, stone_pickaxe: { id: 6, stackSize: 1 },
  dirt: { id: 7, stackSize: 64 }, torch: { id: 8, stackSize: 64 }, andesite: { id: 9, stackSize: 64 }
};
const R = {
  table: { result: { id: 5, count: 1 }, delta: [{ id: 2, count: -4 }, { id: 5, count: 1 }], requiresTable: false },
  stick: { result: { id: 3, count: 4 }, delta: [{ id: 2, count: -2 }, { id: 3, count: 4 }], requiresTable: false },
  planks: { result: { id: 2, count: 4 }, delta: [{ id: 1, count: -1 }, { id: 2, count: 4 }], requiresTable: false },
  pickaxe: { result: { id: 6, count: 1 }, delta: [{ id: 4, count: -3 }, { id: 3, count: -2 }, { id: 6, count: 1 }], requiresTable: true }
};
const RECIPES = { 5: [R.table], 3: [R.stick], 2: [R.planks], 6: [R.pickaxe] };

function makeWorld(stacks, { groundY = 63 } = {}) {
  const reg = { itemsByName: {}, items: {}, blocksByName: { crafting_table: { id: 105 }, furnace: { id: 106 } }, blocks: {} };
  for (const [name, it] of Object.entries(ITEMS)) { reg.itemsByName[name] = { name, ...it }; reg.items[it.id] = reg.itemsByName[name]; }
  const slots = new Array(46).fill(null);
  let i = 9;
  for (const [name, count] of stacks) slots[i++] = { name, count, type: ITEMS[name].id, stackSize: ITEMS[name].stackSize };
  const blocks = new Map(); // "x,y,z" -> name
  const tossed = []; const crafts = [];
  const key = p => `${p.x},${p.y},${p.z}`;
  const blockAt = p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const n = blocks.get(key(q)) || (q.y <= groundY ? 'stone' : 'air');
    return { name: n, position: q, boundingBox: n === 'air' ? 'empty' : 'block', diggable: n !== 'air' };
  };
  const take = (id, n) => { for (let s = 9; s < 45 && n > 0; s++) { const it = slots[s]; if (it && it.type === id) { const k = Math.min(n, it.count); it.count -= k; n -= k; if (!it.count) slots[s] = null; } } };
  const count = id => slots.slice(9, 45).filter(s => s && s.type === id).reduce((a, s) => a + s.count, 0);
  const put = (id, n) => { // как putSelectedItemRange: в стопку с местом, иначе в пустой слот, иначе — на землю
    const it = reg.items[id];
    for (let s = 9; s < 45 && n > 0; s++) { const x = slots[s]; if (x && x.type === id && x.count < it.stackSize) { const k = Math.min(n, it.stackSize - x.count); x.count += k; n -= k; } }
    for (let s = 9; s < 45 && n > 0; s++) if (!slots[s]) { const k = Math.min(n, it.stackSize); slots[s] = { name: it.name, count: k, type: id, stackSize: it.stackSize }; n -= k; }
    if (n > 0) tossed.push({ name: it.name, count: n });
  };
  const bot = {
    registry: reg,
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, eyeHeight: 1.62 },
    entities: {}, game: { dimension: 'overworld' },
    inventory: { slots, inventoryStart: 9, inventoryEnd: 45, selectedItem: null, items: () => slots.slice(9, 45).filter(Boolean) },
    currentWindow: null, heldItem: null,
    recipesAll: id => RECIPES[id] || [],
    blockAt,
    craft: async (rec, n, table) => {
      if (rec.requiresTable && !table) throw new Error('Recipe requires craftingTable');
      for (let k = 0; k < n; k++) {
        for (const d of rec.delta) if (d.count < 0 && count(d.id) < -d.count) throw new Error(new Error('missing ingredient'));
        for (const d of rec.delta) if (d.count < 0) take(d.id, -d.count);
        put(rec.result.id, rec.result.count);
        crafts.push(reg.items[rec.result.id].name);
      }
    },
    equip: async (item) => { bot.heldItem = item; },
    lookAt: async () => {}, look: async () => {},
    placeBlock: async (ref, face) => {
      const p = ref.position.plus(face);
      if (blockAt(p).name !== 'air') throw new Error('occupied');
      blocks.set(key(p), bot.heldItem.name); take(bot.heldItem.type, 1);
      if (!count(bot.heldItem.type)) bot.heldItem = null;
    },
    setControlState() {}, clearControlStates() {},
    closeWindow: async () => {}, _syncWindow: async () => {}, putSelectedItemRange: async () => {}
  };
  return { bot, slots, blocks, tossed, crafts, count: name => count(ITEMS[name].id) };
}
const mkctx = w => ({ bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {}, vision: undefined });

module.exports = async function () {
  // 1) как в заявке 21.10 06:46: 15 досок, 3 палки, 150 булыжника, верстака рядом нет. Две кирки подряд.
  let w = makeWorld([['spruce_planks', 15], ['stick', 3], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 22], ['torch', 16], ['spruce_log', 7]]);
  let ctx = mkctx(w);
  worldmem.hookBot(ctx, w.bot); // как в живом теле: память мира запоминает свои поставленные станции
  let r = await craft.craft(ctx, task(), { item: 'stone_pickaxe' });
  assert.strictEqual(r.made, 1); assert.strictEqual(r.have, 1);
  assert.deepStrictEqual(r.spent, { spruce_planks: 4, stick: 2, cobblestone: 3 }, 'spent: ' + JSON.stringify(r.spent));
  assert.deepStrictEqual(r.crafted, { crafting_table: 1, stone_pickaxe: 1 });
  assert(r.placed && r.placed.length === 1 && r.placed[0].block === 'crafting_table', 'верстак поставлен и назван: ' + JSON.stringify(r.placed));
  assert(!r.lost, 'ничего не пропало');
  const tableAt = r.placed[0].at;
  // зрение верстак не помнит (у фальшивого бота зрение пустое — как когда верстак за спиной/за углом), но память мира знает:
  // поставила сама. Нового верстака не делаем.
  assert.strictEqual(worldmem.get(ctx).near(['crafting_table'], { x: 0, y: 64, z: 0 }, { own: true })[0].at.join(','), tableAt.join(','), 'память мира записала свой верстак');
  r = await craft.craft(ctx, task(), { item: 'stone_pickaxe' });
  assert.strictEqual(r.made, 1); assert.strictEqual(r.have, 2);
  assert.deepStrictEqual(r.crafted, { stick: 4, stone_pickaxe: 1 }, 'второй верстак не делался: ' + JSON.stringify(r.crafted));
  assert(!r.placed, 'ничего нового не ставили');
  assert.deepStrictEqual(r.spent, { spruce_planks: 2, cobblestone: 3 });
  assert.strictEqual(w.count('spruce_planks'), 9, 'досок осталось 9 (15 - 4 верстак - 2 палки)');
  assert.strictEqual(w.count('stick'), 3);
  assert.strictEqual(w.crafts.filter(n => n === 'crafting_table').length, 1, 'верстак скрафчен один раз');

  // 2) полный инвентарь (36 слотов заняты), кирка не складывается в стопку: раньше mineflayer выбрасывал кирку на землю,
  //    сырьё уходило, а повтор выбрасывал вторую. Теперь — отказ до траты, сырьё на месте.
  const full = [['spruce_planks', 10], ['stick', 5], ['cobblestone', 64]];
  for (let k = full.length; k < 36; k++) full.push(['dirt', 64]);
  w = makeWorld(full);
  ctx = mkctx(w);
  w.blocks.set('1,64,0', 'crafting_table'); // верстак рядом и виден? зрение у фальшивого бота пустое — кладём в память мира как свой
  worldmem.get(ctx).observe('crafting_table', 1, 64, 0, { src: 'touched', own: true, exact: true });
  await assert.rejects(() => craft.craft(ctx, task(), { item: 'stone_pickaxe' }), e => /инвентарь полон/.test(e.message) && e.extra && e.extra.full);
  assert.strictEqual(w.tossed.length, 0, 'на землю ничего не ушло: ' + JSON.stringify(w.tossed));
  assert.strictEqual(w.count('cobblestone'), 64); assert.strictEqual(w.count('stick'), 5);

  // 3) результат ложится в стопку с местом — полный инвентарь не мешает (доски из брёвен)
  const full2 = [['spruce_log', 4], ['spruce_planks', 20]];
  for (let k = full2.length; k < 36; k++) full2.push(['dirt', 64]);
  w = makeWorld(full2); ctx = mkctx(w);
  r = await craft.craft(ctx, task(), { item: 'spruce_planks', count: 8 });
  assert.strictEqual(r.have, 28); assert.deepStrictEqual(r.spent, { spruce_log: 2 }); assert(!r.lost);

  // 4) пропажа сверх рецепта видна: сервер «съел» сырьё, а результат упал на землю (модель мира разошлась) — итог говорит об этом
  w = makeWorld([['spruce_planks', 15], ['stick', 3], ['cobblestone', 64]]); ctx = mkctx(w);
  w.blocks.set('1,64,0', 'crafting_table');
  worldmem.get(ctx).observe('crafting_table', 1, 64, 0, { src: 'touched', own: true, exact: true });
  const realCraft = w.bot.craft;
  let once = true;
  w.bot.craft = async (rec, n, table) => { await realCraft(rec, n, table); if (once && rec === R.stick) { once = false; w.slots.forEach((s, i) => { if (s && s.name === 'spruce_planks' && i >= 9) { s.count -= 4; } }); } };
  r = await craft.craft(ctx, task(), { item: 'stone_pickaxe', count: 2 });
  assert.strictEqual(r.have, 2);
  assert(r.lost && r.lost.spruce_planks === 4, 'пропажа названа: ' + JSON.stringify(r));
  assert(/пропало сверх рецептов: spruce_planks x4/.test(r.warning));

  // 5) не хватает — ошибка с честным итогом: что успели скрафтить и потратить
  w = makeWorld([['spruce_planks', 2], ['cobblestone', 2]]); ctx = mkctx(w);
  w.blocks.set('1,64,0', 'crafting_table');
  worldmem.get(ctx).observe('crafting_table', 1, 64, 0, { src: 'touched', own: true, exact: true });
  await assert.rejects(() => craft.craft(ctx, task(), { item: 'stone_pickaxe' }), e => /не хватает/.test(e.message));
  assert.strictEqual(w.count('spruce_planks'), 2, 'план не сошёлся — ничего не тратили');

  // 6) память мира помнит свой верстак, а его уже нет (сломали) — не верим памяти: делаем и ставим новый, и итог это говорит
  w = makeWorld([['spruce_planks', 15], ['stick', 3], ['cobblestone', 64]]); ctx = mkctx(w);
  worldmem.get(ctx).observe('crafting_table', 1, 64, 0, { src: 'touched', own: true, exact: true });
  r = await craft.craft(ctx, task(), { item: 'stone_pickaxe' });
  assert(r.placed && r.placed.length === 1, 'новый верстак поставлен: ' + JSON.stringify(r));
  assert.strictEqual(r.crafted.crafting_table, 1); assert.strictEqual(r.spent.spruce_planks, 4);

  console.log('craft (честный итог, свой верстак, полный инвентарь): OK');
};
if (require.main === module) module.exports().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
