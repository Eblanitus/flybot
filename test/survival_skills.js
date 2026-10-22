// Офлайн-проверка составных навыков выживания на фальшивом api (без Minecraft):
// craft_gear, make_bed, smelt_all, cook_food, mine_vein, branch_mine, farm_plot — dry / отказ без ресурсов / основной путь.
'use strict';
const assert = require('assert');
const L = n => require('../brain/learned/' + n);
const fail = (action, why) => new Error(`навык тела "${action}" не удался: ${why}`);

// ---- общий фальшивый api ----
function mk({ inv = {}, eyes = {}, pos = { x: 0.5, y: 64, z: 0.5 }, armor = [], handlers = {}, health = 20 } = {}) {
  const st = { inv: { ...inv }, calls: [], pos: { ...pos }, armor: armor.slice(), eyes, health };
  const api = {
    log() {},
    async snapshot() {
      return {
        inventory: Object.entries(st.inv).filter(([, c]) => c > 0).map(([name, count], i) => ({ slot: 9 + i, name, count })),
        armor: st.armor, health: st.health, food: 20, position: st.pos,
        eyes: { time: { phase: 'день', nightIn: 900 }, enemies: [], animals: [], blocks: {}, ...st.eyes }
      };
    },
    async cmd(action, p) {
      st.calls.push(action + ':' + JSON.stringify(p || {}));
      const h = handlers[action];
      return h ? h(p || {}, st) : {};
    },
    async skill(name, p) { st.calls.push('skill:' + name + ':' + JSON.stringify(p || {})); const h = handlers['skill:' + name]; if (!h) throw new Error(`skill("${name}"): не загрузился`); return h(p || {}, st); },
    async count(n) { return st.inv[n] || 0; },
    async sleep() {}
  };
  return { api, st, has: a => st.calls.some(c => c.startsWith(a)), calls: a => st.calls.filter(c => c.startsWith(a)) };
}
const add = (st, n, c) => { st.inv[n] = (st.inv[n] || 0) + c; if (st.inv[n] <= 0) delete st.inv[n]; };

// фальшивый survey по функции мира blockAt(x,y,z) -> имя | undefined (= неизвестно)
function surveyOf(blockAt) {
  return p => {
    const x1 = Math.min(p.x1, p.x2), x2 = Math.max(p.x1, p.x2), y1 = Math.min(p.y1, p.y2), y2 = Math.max(p.y1, p.y2), z1 = Math.min(p.z1, p.z2), z2 = Math.max(p.z1, p.z2);
    const legend = { '.': 'air' }, codes = { air: '.', cave_air: '.' };
    const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%&@$+=^'; let pi = 0;
    const layers = {};
    for (let y = y2; y >= y1; y--) {
      const rows = [];
      for (let z = z1; z <= z2; z++) {
        let row = '';
        for (let x = x1; x <= x2; x++) {
          const n = blockAt(x, y, z);
          if (n === undefined || n === null) { row += '?'; continue; }
          if (!codes[n]) { codes[n] = pool[pi++]; legend[codes[n]] = n; }
          row += codes[n];
        }
        rows.push(row);
      }
      layers['y=' + y] = rows;
    }
    return { origin: { x: x1, y: y1, z: z1 }, size: { x: x2 - x1 + 1, y: y2 - y1 + 1, z: z2 - z1 + 1 }, legend, layers };
  };
}

// ---- craft_gear ----
const MATS = { wooden: 'planks', stone: 'cobblestone', copper: 'copper_ingot', iron: 'iron_ingot', diamond: 'diamond' };
const COSTS = { pickaxe: 3, axe: 3, sword: 2, shovel: 1, helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
function craftH(p, st) {
  if (p.item === 'shield') { if ((st.inv.iron_ingot || 0) < 1 || (st.inv.oak_planks || 0) < 6) throw fail('craft', 'не хватает: shield'); add(st, 'iron_ingot', -1); add(st, 'oak_planks', -6); add(st, 'shield', 1); return {}; }
  const m = p.item.match(/^(wooden|stone|copper|iron|diamond)_(\w+)$/);
  if (!m || !COSTS[m[2]]) throw fail('craft', 'неизвестный предмет ' + p.item);
  const mat = m[1] === 'wooden' ? 'oak_planks' : MATS[m[1]];
  const n = COSTS[m[2]];
  if ((st.inv[mat] || 0) < n) throw fail('craft', `не хватает: ${mat} x${n - (st.inv[mat] || 0)}`);
  add(st, mat, -n); add(st, p.item, 1); return {};
}
async function testCraftGear() {
  const skill = L('craft_gear');
  // dry: железо 10, булыжник 5, доски 30, палки 10 -> кирка, меч, ботинки, щит (железо), каменные топор и лопата
  let h = mk({ inv: { iron_ingot: 10, cobblestone: 5, oak_planks: 30, stick: 10 }, eyes: { blocks: { crafting_table: { d: 3 } } } });
  let r = await skill.run(h.api, { dry: 1 });
  assert(r.ok && r.dry, JSON.stringify(r));
  assert.deepStrictEqual(r.plan, ['iron_pickaxe', 'iron_sword', 'iron_boots', 'shield', 'stone_axe', 'stone_shovel'], 'plan ' + r.plan);
  assert(r.missing.iron_ingot > 0 && r.canCraftAll === false, 'missing ' + JSON.stringify(r.missing));
  assert.strictEqual(h.st.calls.length, 0, 'dry ничего не делает кроме snapshot');
  // отказ без ресурсов
  h = mk({ inv: { dirt: 3 } });
  r = await skill.run(h.api, {});
  assert(!r.ok && /не хватает/.test(r.error) && r.missing && r.missing.planks > 0, JSON.stringify(r));
  assert(!h.has('craft'));
  // неправильные параметры
  assert(!(await skill.run(mk().api, { tier: 'mithril' })).ok);
  assert(!(await skill.run(mk().api, { set: 'hat' })).ok);
  // основной путь: сырое железо плавится (печь рядом), всё делается, надевается
  h = mk({
    inv: { raw_iron: 8, coal: 2, oak_planks: 40, stick: 6 }, eyes: { blocks: { furnace: { d: 3 }, crafting_table: { d: 2 } } },
    handlers: {
      craft: craftH,
      smelt(p, st) { add(st, p.item, -p.count); add(st, 'iron_ingot', p.count); add(st, 'coal', -1); return { made: p.count }; },
      equip_best() { return {}; }, equip_item() { return {}; }
    }
  });
  r = await skill.run(h.api, { tier: 'iron' });
  assert(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.smelted, { raw_iron: 7 }, 'smelted ' + JSON.stringify(r.smelted));
  assert(r.crafted.includes('iron_pickaxe') && r.crafted.includes('iron_sword') && r.crafted.includes('shield') && r.crafted.includes('wooden_axe'), r.crafted.join());
  assert(h.has('equip_best') && h.has('equip_item'), 'надевает');
  assert(h.calls('smelt')[0].includes('"fuel":"coal"'), h.calls('smelt')[0]);
  // не тратит на вещь хуже имеющейся: железная кирка и меч уже есть, надета железная грудь — делает только недостающее
  h = mk({
    inv: { iron_pickaxe: 1, iron_sword: 1, iron_ingot: 2, cobblestone: 9, oak_planks: 20 }, armor: ['iron_chestplate'], eyes: { blocks: { crafting_table: { d: 2 } } },
    handlers: { craft: craftH, equip_best() { return {}; }, equip_item() { return {}; } }
  });
  r = await skill.run(h.api, { set: 'tools,armor' });
  assert(r.ok, JSON.stringify(r));
  assert(!r.crafted.some(i => /pickaxe|sword|chestplate/.test(i)), 'лишнее: ' + r.crafted);
  assert.deepStrictEqual(r.crafted.sort(), ['iron_shovel', 'stone_axe'], r.crafted.join());
  // потолок tier=stone: железо не трогаем
  h = mk({ inv: { iron_ingot: 9, cobblestone: 9, oak_planks: 20 }, eyes: { blocks: { crafting_table: { d: 2 } } }, handlers: { craft: craftH, equip_best() { return {}; } } });
  r = await skill.run(h.api, { tier: 'stone', set: 'tools', dry: 1 });
  assert(r.plan.every(i => /^stone_/.test(i)), r.plan.join());
  // уже всё лучшее
  h = mk({ inv: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_shovel: 1, cobblestone: 5, oak_planks: 5 }, eyes: { blocks: { crafting_table: { d: 2 } } } });
  r = await skill.run(h.api, { set: 'tools' });
  assert(r.ok && r.crafted.length === 0, JSON.stringify(r));
  console.log('  craft_gear: OK');
}

// ---- make_bed ----
async function testMakeBed() {
  const skill = L('make_bed');
  let h = mk({ inv: { red_bed: 1 } });
  let r = await skill.run(h.api, {});
  assert(r.ok && r.already);
  // нет досок
  h = mk({ inv: { white_wool: 3 } });
  r = await skill.run(h.api, {});
  assert(!r.ok && r.missing && r.missing.planks > 0 && /досок/.test(r.error), JSON.stringify(r));
  // dry
  h = mk({ inv: { oak_planks: 10, shears: 1 }, eyes: { blocks: { crafting_table: { d: 2 } } } });
  r = await skill.run(h.api, { dry: 1 });
  assert(r.ok && r.dry && r.missing.white_wool === 3 && r.shears === true, JSON.stringify(r));
  // ножницы: шерсть стрижётся, потом крафт
  h = mk({
    inv: { oak_planks: 10, shears: 1 }, eyes: { blocks: { crafting_table: { d: 2 } } },
    handlers: {
      shear(p, st) { add(st, 'white_wool', 2); return { sheared: 2 }; },
      craft(p, st) { assert.strictEqual(p.item, 'white_bed'); add(st, 'white_wool', -3); add(st, 'oak_planks', -3); add(st, 'white_bed', 1); return {}; }
    }
  });
  r = await skill.run(h.api, {});
  assert(r.ok && r.bed === 'white_bed' && r.sheared === 4 && h.st.inv.white_bed === 1, JSON.stringify(r));
  assert(!h.has('hunt'));
  // без ножниц: охота
  h = mk({
    inv: { oak_planks: 10 }, eyes: { blocks: { crafting_table: { d: 2 } } },
    handlers: { hunt(p, st) { add(st, 'white_wool', 1); return {}; }, craft(p, st) { add(st, p.item, 1); return {}; } }
  });
  r = await skill.run(h.api, { color: 'white' });
  assert(r.ok && h.has('hunt') && !h.has('shear'), JSON.stringify(r));
  // овец нет: отказ с missing
  h = mk({ inv: { oak_planks: 10, shears: 1 }, eyes: { blocks: { crafting_table: { d: 2 } } }, handlers: { shear() { return { sheared: 0, note: 'нет овец' }; }, hunt() { throw fail('hunt', 'нет овец'); } } });
  r = await skill.run(h.api, {});
  assert(!r.ok && r.missing.white_wool === 3 && !h.has('craft'), JSON.stringify(r));
  assert(!(await skill.run(mk().api, { color: 'ultraviolet' })).ok);
  console.log('  make_bed: OK');
}

// ---- smelt_all ----
function smeltH(p, st) {
  const OUTS = { raw_iron: 'iron_ingot', raw_copper: 'copper_ingot', sand: 'glass', cobblestone: 'stone', beef: 'cooked_beef', porkchop: 'cooked_porkchop' };
  const per = { coal: 8, charcoal: 8 }[p.fuel] || 1.5;
  if (!(st.inv[p.fuel] > 0)) throw fail('smelt', 'нет топлива');
  add(st, p.item, -p.count); add(st, OUTS[p.item], p.count); add(st, p.fuel, -Math.ceil(p.count / per));
  return { made: p.count };
}
async function testSmeltAll() {
  const skill = L('smelt_all');
  let h = mk({ inv: { dirt: 5 } });
  let r = await skill.run(h.api, {});
  assert(!r.ok && /нечего плавить/.test(r.error), JSON.stringify(r));
  h = mk({ inv: { raw_iron: 3 } });
  r = await skill.run(h.api, {});
  assert(!r.ok && r.missing.fuel && !h.has('smelt'), JSON.stringify(r));
  assert(!(await skill.run(mk({ inv: { raw_iron: 1 } }).api, { what: 'diamond' })).ok);
  // dry
  h = mk({ inv: { raw_iron: 5, cobblestone: 40, coal: 1 }, eyes: { blocks: { furnace: { d: 2 } } } });
  r = await skill.run(h.api, { dry: 1 });
  assert(r.ok && r.dry && r.plan.find(p => p.item === 'cobblestone').count === 24 && r.plan.find(p => p.item === 'raw_iron').count === 5, JSON.stringify(r));
  // основной путь: топливо — уголь, потом доски; булыжник последним, запас 16 остаётся
  h = mk({
    inv: { raw_iron: 5, raw_copper: 3, sand: 4, cobblestone: 40, coal: 1, oak_planks: 40 }, eyes: { blocks: { furnace: { d: 2 } } },
    handlers: { smelt: smeltH }
  });
  r = await skill.run(h.api, {});
  assert(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.smelted, { iron_ingot: 5, copper_ingot: 3, glass: 4, stone: 24 }, JSON.stringify(r.smelted));
  assert.strictEqual(h.st.inv.cobblestone, 16);
  const order = h.calls('smelt').map(c => JSON.parse(c.slice(6)).item);
  assert.strictEqual(order[order.length - 1], 'cobblestone', order.join());
  assert(h.calls('smelt')[0].includes('"fuel":"coal"'), h.calls('smelt')[0]);
  // печи не видно: булыжник придержан ещё на 8 (на печь)
  h = mk({ inv: { cobblestone: 30, coal: 3 }, handlers: { smelt: smeltH } });
  r = await skill.run(h.api, {});
  assert(r.ok && r.smelted.stone === 6, JSON.stringify(r));
  // топливо кончилось на середине: частичный успех с missing
  h = mk({ inv: { raw_iron: 20, coal: 1 }, eyes: { blocks: { furnace: { d: 2 } } }, handlers: { smelt: smeltH } });
  r = await skill.run(h.api, { fuel: 'coal' });
  assert(r.ok && r.smelted.iron_ingot === 8 && r.missing.fuel, JSON.stringify(r));
  console.log('  smelt_all: OK');
}

// ---- cook_food ----
async function testCookFood() {
  const skill = L('cook_food');
  let h = mk({ inv: { cooked_beef: 9 } });
  let r = await skill.run(h.api, {});
  assert(r.ok && r.ready === 9 && r.cooked === 0 && !h.has('smelt'));
  h = mk({ inv: { beef: 4 } });
  r = await skill.run(h.api, {});
  assert(!r.ok && r.missing.fuel && r.ready === 0 && !h.has('hunt'), JSON.stringify(r));
  h = mk({ inv: { beef: 4 }, handlers: {} });
  r = await skill.run(h.api, { dry: 1 });
  assert(r.ok && r.dry && r.raw === 4 && r.fuel === false);
  // жарка того, что есть
  const cookH = (p, st) => { add(st, p.item, -p.count); add(st, 'cooked_' + p.item, p.count); return { made: p.count }; };
  h = mk({ inv: { beef: 5, porkchop: 3, coal: 2, bread: 1 }, handlers: { smelt: cookH } });
  r = await skill.run(h.api, { min: 8 });
  assert(r.ok && r.ready >= 8 && !h.has('hunt'), JSON.stringify(r));
  // мяса нет — охота, потом жарка
  h = mk({
    inv: { coal: 2 }, eyes: { animals: [{ name: 'cow', d: 6 }] },
    handlers: { hunt(p, st) { add(st, 'beef', 3); return {}; }, smelt: cookH }
  });
  r = await skill.run(h.api, { min: 3 });
  assert(r.ok && r.ready === 3 && r.hunted >= 1 && h.has('hunt') && h.has('smelt'), JSON.stringify(r));
  // животных нет: explore, потом отказ
  h = mk({ inv: { coal: 2 }, handlers: { hunt() { throw fail('hunt', 'не вижу животных'); } } });
  r = await skill.run(h.api, { min: 4 });
  assert(!r.ok && r.missing.food === 4 && /не вижу животных/.test(r.error), JSON.stringify(r));
  // вторая охота — только после смены места (навык brain/learned, правка 22.10: шаг по survey, разведка — запасной путь)
  assert(r.attempts && r.attempts.relocate >= 1 && (h.has('explore') || h.has('survey')), JSON.stringify(r));
  console.log('  cook_food: OK');
}

// ---- mine_vein ----
async function testMineVein() {
  const skill = L('mine_vein');
  // мир: камень, жила железа из 5 связных блоков (часть по диагонали), отдельный блок вдали, блок рядом с лавой
  const ore = new Set(['10,60,10', '11,60,10', '12,61,11', '12,62,12', '12,62,13', '10,60,13', '20,60,20', '13,61,10']);
  const lava = new Set(['14,61,10']); // рядом с 13,61,10 (но 13,61,10 связан с жилой через 12,61,11)
  const gone = new Set();
  const world = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    if (gone.has(k)) return 'air';
    if (lava.has(k)) return 'lava';
    if (ore.has(k)) return 'iron_ore';
    return 'stone';
  };
  const handlers = {
    survey: surveyOf(world),
    dig_at(p, st) { const k = p.x + ',' + p.y + ',' + p.z; if (!ore.has(k) || gone.has(k)) throw fail('dig_at', 'нечего копать'); gone.add(k); add(st, 'raw_iron', 1); return {}; },
    equip_best() { return {}; }, pickup() { return {}; }
  };
  const eyes = { blocks: { iron_ore: { d: 5, n: 8, at: [10, 60, 10] } } };
  // нет кирки
  let h = mk({ inv: {}, eyes, handlers });
  let r = await skill.run(h.api, { ore: 'iron' });
  assert(!r.ok && r.missing && r.missing.pickaxe, JSON.stringify(r));
  // кирка слабая для алмаза
  h = mk({ inv: { stone_pickaxe: 1 }, eyes: { blocks: { diamond_ore: { d: 5, at: [1, 1, 1] } } }, handlers });
  r = await skill.run(h.api, { ore: 'diamond' });
  assert(!r.ok && /железная/.test(r.error), JSON.stringify(r));
  // руды не видно
  h = mk({ inv: { stone_pickaxe: 1 }, eyes: {}, handlers });
  r = await skill.run(h.api, { ore: 'iron' });
  assert(!r.ok && r.seen === false && !h.has('dig_at'), JSON.stringify(r));
  assert(!(await skill.run(mk({ inv: { stone_pickaxe: 1 } }).api, { ore: 'unobtainium' })).ok);
  // основной путь: связная жила (без отдельного блока вдали), блок у лавы пропущен
  h = mk({ inv: { stone_pickaxe: 1 }, eyes, handlers, pos: { x: 9.5, y: 60, z: 9.5 } });
  r = await skill.run(h.api, { ore: 'iron', max: 16 });
  assert(r.ok && r.mined === 5, JSON.stringify(r));
  assert(!gone.has('20,60,20'), 'отдельная жила не тронута');
  assert(!gone.has('13,61,10'), 'блок у лавы пропущен');
  assert.strictEqual(r.gained.raw_iron, 5);
  assert(r.skipped && r.skipped.some(s => /лава/.test(s.why)));
  // max ограничивает
  gone.clear();
  h = mk({ inv: { stone_pickaxe: 1 }, eyes, handlers, pos: { x: 9.5, y: 60, z: 9.5 } });
  r = await skill.run(h.api, { ore: 'iron', max: 2 });
  assert(r.ok && r.mined === 2 && /max/.test(r.reason), JSON.stringify(r));
  console.log('  mine_vein: OK');
}

// ---- branch_mine ----
function mineWorld({ topY = 80, lavaAt = null, ores = [] } = {}) {
  const gone = new Set(), oreSet = new Map(ores.map(o => [o.join(','), 'iron_ore']));
  const lava = new Set(lavaAt ? lavaAt.map(c => c.join(',')) : []);
  const at = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    if (gone.has(k)) return 'air';
    if (lava.has(k)) return 'lava';
    if (oreSet.has(k)) return oreSet.get(k);
    if (y > topY) return 'air';
    return 'stone';
  };
  return { gone, at, oreSet };
}
function mineHandlers(w, st, extra = {}) {
  return {
    survey: surveyOf(w.at),
    dig_at(p) { const k = p.x + ',' + p.y + ',' + p.z; const n = w.at(p.x, p.y, p.z); if (n === 'lava') throw fail('dig_at', 'рядом лава'); w.gone.add(k); if (n === 'iron_ore') add(st, 'raw_iron', 1); return {}; },
    goto(p) { st.pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }; return {}; },
    place_at(p) { w.gone.delete(p.x + ',' + p.y + ',' + p.z); return {}; },
    equip_best() { return {}; }, craft() { throw fail('craft', 'нет'); },
    ...extra
  };
}
async function testBranchMine() {
  const skill = L('branch_mine');
  // нет кирки
  let w = mineWorld();
  let h = mk({ inv: {}, handlers: mineHandlers(w, { inv: {} }) });
  let r = await skill.run(h.api, {});
  assert(!r.ok && r.missing && r.missing.pickaxe, JSON.stringify(r));
  assert(!(await skill.run(mk({ inv: { stone_pickaxe: 1 } }).api, { dir: 'up' })).ok);
  // основной путь на текущем уровне: старт (0,50,0) выкопан; главный туннель на юг 6, ветки по 3
  w = mineWorld({ ores: [[1, 50, 2], [2, 50, 2], [-3, 50, 6]] });
  const start = { x: 0.5, y: 50, z: 0.5 };
  h = mk({ inv: { stone_pickaxe: 1, torch: 6 }, pos: start });
  Object.assign(h.api, {});
  const hs = mineHandlers(w, h.st);
  hs.survey = surveyOf(w.at);
  const h2 = mk({ inv: { stone_pickaxe: 1, torch: 6 }, pos: start, handlers: hs });
  Object.assign(hs, mineHandlers(w, h2.st));
  for (const y of [50, 51]) w.gone.add(`0,${y},0`);
  r = await skill.run(h2.api, { length: 6, branches: 2, branch_len: 3, torch_every: 3 });
  assert(r.ok, JSON.stringify(r));
  assert.strictEqual(r.main.done, 6, JSON.stringify(r.main));
  assert.strictEqual(r.cells, 12, 'клеток ' + r.cells + ' ' + JSON.stringify(r.branches));
  assert.deepStrictEqual(r.branches.map(b => b.done), [3, 3]);
  assert.deepStrictEqual(r.branches.map(b => b.side).sort(), ['лево', 'право']);
  assert(r.ores.iron_ore >= 2, 'руда у туннеля и по жиле: ' + JSON.stringify(r.ores));
  assert(r.torchesPlaced >= 3, 'факелы ' + r.torchesPlaced);
  assert(h2.has('place_at') && h2.calls('place_at').every(c => c.includes('torch')));
  assert.strictEqual(r.gained.raw_iron, r.ores.iron_ore);
  assert(r.returned);
  // лава на z=4: главный стоп на 2 (смотрит на клетку вперёд), ветки (позиция 6) пропущены, ok:true
  w = mineWorld({ lavaAt: [[0, 50, 4]] });
  for (const y of [50, 51]) w.gone.add(`0,${y},0`);
  const h3 = mk({ inv: { stone_pickaxe: 1 }, pos: start });
  Object.assign(h3.st, {});
  const hs3 = mineHandlers(w, h3.st);
  const hh = mk({ inv: { stone_pickaxe: 1 }, pos: start, handlers: hs3 });
  Object.assign(hs3, mineHandlers(w, hh.st));
  r = await skill.run(hh.api, { length: 6, branches: 2, branch_len: 3, torch_every: 0 });
  assert(r.ok && r.main.done === 2 && /лав/.test(r.main.stopped) && r.branchesSkipped.length === 2, JSON.stringify(r));
  assert(r.hazards >= 1);
  // лава в первой же клетке: ok:false
  w = mineWorld({ lavaAt: [[0, 50, 1]] });
  for (const y of [50, 51]) w.gone.add(`0,${y},0`);
  const h4 = { st: { inv: { stone_pickaxe: 1 }, calls: [], pos: { ...start }, armor: [], eyes: {}, health: 20 } };
  const hh4 = mk({ inv: { stone_pickaxe: 1 }, pos: start });
  const hs4 = mineHandlers(w, hh4.st);
  const hh44 = mk({ inv: { stone_pickaxe: 1 }, pos: start, handlers: hs4 });
  Object.assign(hs4, mineHandlers(w, hh44.st));
  r = await skill.run(hh44.api, { length: 4, branches: 0, torch_every: 0 });
  assert(!r.ok && /лав/.test(r.error), JSON.stringify(r));
  void h4;
  // спуск через mine_stairs
  w = mineWorld();
  for (const y of [45, 46]) w.gone.add(`0,${y},0`);
  const hd = mk({ inv: { stone_pickaxe: 1 }, pos: { x: 0.5, y: 50, z: 0.5 } });
  const hsd = mineHandlers(w, hd.st, {
    'skill:mine_stairs': (p, st) => { st.pos = { x: 0.5, y: 50 - p.steps, z: 0.5 }; return { ok: true, steps: p.steps }; }
  });
  const hdd = mk({ inv: { stone_pickaxe: 1 }, pos: { x: 0.5, y: 50, z: 0.5 }, handlers: hsd });
  Object.assign(hsd, mineHandlers(w, hdd.st), { 'skill:mine_stairs': (p, st) => { st.pos = { x: 0.5, y: 50 - p.steps, z: 0.5 }; return { ok: true, steps: p.steps }; } });
  r = await skill.run(hdd.api, { y: 45, length: 3, branches: 0, torch_every: 0 });
  assert(r.ok && r.y === 45 && r.startY === 50 && hdd.calls('skill:mine_stairs')[0].includes('"steps":5'), JSON.stringify(r));
  // спуск не дошёл
  const hse = mk({ inv: { stone_pickaxe: 1 }, pos: { x: 0.5, y: 50, z: 0.5 }, handlers: { 'skill:mine_stairs': (p, st) => { st.pos.y = 47; return { ok: true, steps: 3, stopped: 'лава впереди' }; } } });
  r = await skill.run(hse.api, { y: 40 });
  assert(!r.ok && /спуск остановился/.test(r.error), JSON.stringify(r));
  // mine_stairs нет
  const hsn = mk({ inv: { stone_pickaxe: 1 }, pos: { x: 0.5, y: 50, z: 0.5 } });
  r = await skill.run(hsn.api, { y: 40 });
  assert(!r.ok && /mine_stairs/.test(r.error), JSON.stringify(r));
  // выше текущего
  r = await skill.run(mk({ inv: { stone_pickaxe: 1 }, pos: { x: 0.5, y: 50, z: 0.5 } }).api, { y: 60 });
  assert(!r.ok && /выше/.test(r.error));
  console.log('  branch_mine: OK');
}

// ---- farm_plot ----
function farmWorld({ water = true, farmland = [], crops = {} } = {}) {
  const state = { farmland: new Set(farmland.map(c => c.join(','))), crops: new Map(Object.entries(crops)) };
  const at = (x, y, z) => {
    const k = x + ',' + y + ',' + z;
    if (y > 65) return 'air';
    if (y === 65) { if (state.crops.has(k)) return state.crops.get(k).block; return 'air'; }
    if (y === 64) {
      if (water && x === 10 && z === 10) return 'water';
      if (state.farmland.has(k)) return 'farmland';
      return 'grass_block';
    }
    return 'dirt';
  };
  return { state, at };
}
async function testFarmPlot() {
  const skill = L('farm_plot');
  const farmHandlers = (w, st, extra = {}) => ({
    survey: surveyOf(w.at),
    goto(p) { st.pos = { x: p.x + 0.5, y: 65, z: p.z + 0.5 }; return {}; },
    till(p) {
      let n = 0;
      for (let x = p.x1; x <= p.x2; x++) for (let z = p.z1; z <= p.z2; z++) { if (w.at(x, p.y, z) === 'grass_block') { w.state.farmland.add(x + ',' + p.y + ',' + z); n++; } }
      if (!n) throw fail('till', 'ничего не вспахано');
      return { tilled: n };
    },
    plant(p, s) {
      let n = 0;
      for (const k of w.state.farmland) { const [x, y, z] = k.split(',').map(Number); if (x < p.x1 || x > p.x2 || z < p.z1 || z > p.z2) continue; const ck = x + ',65,' + z; if (w.state.crops.has(ck) || (s.inv[p.seed] || 0) <= 0) continue; w.state.crops.set(ck, { block: 'wheat', ripe: false }); add(s, p.seed, -1); n++; }
      return { planted: n, freeBeds: 0 };
    },
    harvest(p, s) {
      let hv = 0, rp = 0;
      for (const [k, c] of [...w.state.crops]) { if (!c.ripe) continue; hv++; add(s, 'wheat', 1); add(s, 'wheat_seeds', 1); c.ripe = false; rp++; }
      return { harvested: hv, replanted: rp, immature: w.state.crops.size - hv };
    },
    ...extra
  });
  const eyes = { blocks: { water: { d: 3, n: 1, at: [10, 64, 10] } } };
  const pos = { x: 10.5, y: 65, z: 12.5 };
  // воды не видно и x,z не заданы
  let h = mk({ inv: { wheat_seeds: 3 } });
  let r = await skill.run(h.api, {});
  assert(!r.ok && r.missing && r.missing.water, JSON.stringify(r));
  assert(!(await skill.run(mk().api, { seed: 'melon_seeds' })).ok);
  // x,z заданы, а воды рядом нет
  let w = farmWorld({ water: false });
  h = mk({ inv: { wheat_seeds: 3, wooden_hoe: 1 }, pos });
  Object.assign(h.api, {});
  let hs = farmHandlers(w, h.st);
  h = mk({ inv: { wheat_seeds: 3, wooden_hoe: 1 }, pos, handlers: hs });
  Object.assign(hs, farmHandlers(w, h.st));
  r = await skill.run(h.api, { x: 10, z: 10, size: 3 });
  assert(!r.ok && r.missing.water && !h.has('till'), JSON.stringify(r));
  // основной путь: мотыги нет — крафт; 8 клеток вокруг воды, семян 5
  w = farmWorld();
  const mkFarm = (inv, world, extra) => { const hs2 = {}; const hh = mk({ inv, eyes, pos, handlers: hs2 }); Object.assign(hs2, farmHandlers(world, hh.st, extra)); return hh; };
  h = mkFarm({ wheat_seeds: 5, oak_planks: 4, stick: 2 }, w, { craft(p, st) { add(st, 'wooden_hoe', 1); return {}; } });
  r = await skill.run(h.api, { size: 3 });
  assert(r.ok && r.tilled === 8 && r.planted === 5, JSON.stringify(r));
  assert(h.has('craft') && r.plot.y === 64 && r.plot.x1 === 9 && r.plot.x2 === 11, JSON.stringify(r.plot));
  assert.strictEqual(h.calls('till').length, 4, 'по строкам: ' + h.calls('till').join(' | '));
  // повторный вызов: часть спелая — собирает, пересаживает; вспахано всё; семена после сбора идут в посадку
  for (const c of w.state.crops.values()) c.ripe = true;
  h = mkFarm({ wheat_seeds: 3, wooden_hoe: 1 }, w);
  r = await skill.run(h.api, { size: 3 });
  assert(r.ok && r.harvested === 5 && h.has('harvest') && r.planted === 3, JSON.stringify(r));
  assert(!h.has('till'), 'всё уже вспахано');
  // мотыги нет и скрафтить нельзя
  w = farmWorld();
  h = mkFarm({ wheat_seeds: 5 }, w, { craft() { throw fail('craft', 'не хватает: oak_planks x2'); } });
  r = await skill.run(h.api, { size: 3 });
  assert(!r.ok && r.missing.hoe && !h.has('plant'), JSON.stringify(r));
  // семян нет: вскопала, но сажать нечего
  w = farmWorld();
  h = mkFarm({ wooden_hoe: 1 }, w);
  r = await skill.run(h.api, { size: 3 });
  assert(r.ok && r.tilled === 8 && r.planted === 0 && r.missing.wheat_seeds, JSON.stringify(r));
  console.log('  farm_plot: OK');
}

module.exports = async () => {
  await testCraftGear();
  await testMakeBed();
  await testSmeltAll();
  await testCookFood();
  await testMineVein();
  await testBranchMine();
  await testFarmPlot();
  console.log('survival_skills: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
