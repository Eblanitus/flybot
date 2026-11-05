// Офлайн-проверка коротких навыков (хозяин 05.11): длинные навыки порезаны на шаги, каждый шаг — кандидат решателя
// с проверкой «есть из чего делать». Длинные навыки остаются.
'use strict';
const assert = require('assert');
const ST = require('../hardcore/steps/steps.js');
const { SPLIT, isLong } = require('../hardcore/steps/split.js');
const REPORT = require('../hardcore/steps/report.js');
const CATALOG = require('../hardcore/pool/catalog.json');
const DECIDER = require('../hardcore/decider.js');
const { SKILLS } = require('../lib/commands.js');

// 1) порезка: каждый чужой навык и каждый свой длинный навык автопилота — в таблице; шаги существуют; каждый шаг где-то нужен
for (const e of Object.values(CATALOG).flat()) assert(SPLIT[e.id], 'чужой навык не порезан: ' + e.id);
for (const id of ['day_routine', 'hc_night_mine', 'farm_plot', 'farm_plot_v1', 'make_bed', 'bring_bed_home', 'light_base', 'gather_list', 'go_safe', 'climb_up', 'climb_stairs'])
  assert(SPLIT[id] && isLong(SPLIT[id]), 'свой длинный навык не порезан: ' + id);
for (const [id, e] of Object.entries(SPLIT)) {
  for (const s of e.steps) assert(ST.BY_ID.has(s), `${id}: нет шага ${s}`);
  if (!e.steps.length) assert(e.note, `${id}: не режется — нужна причина`);
}
const used = new Set(Object.values(SPLIT).flatMap(e => e.steps));
for (const s of ST.STEPS) assert(used.has(s.id), 'шаг ни в одном длинном навыке: ' + s.id);
assert.strictEqual(new Set(ST.STEPS.map(s => s.id)).size, ST.STEPS.length, 'id шагов повторяются');

// 2) каждый шаг — одна настоящая команда тела (goto — переход автопилота)
for (const s of ST.STEPS) assert(s.cmd === 'goto' || SKILLS[s.cmd], `${s.id}: у тела нет команды ${s.cmd}`);
for (const s of ST.STEPS) assert(ST.CATS[s.cat] && s.title, `${s.id}: нет категории или названия`);

// 3) проверка «есть из чего»: пустой вид — ничего не предлагается
const V = (inv = {}, blocks = [], ents = [], extra = {}) => ({ inv, blocks: new Set(blocks), ents, grid: extra.grid || new Map(), pos: extra.pos || { x: 0, y: 64, z: 0 },
  held: extra.held || null, food: extra.food == null ? 20 : extra.food, s: extra.s || {} });
assert.deepStrictEqual(ST.available(V()).map(s => s.id), [], 'пустая сумка и пустой мир — шагов нет');
const ids = v => ST.available(v).map(s => s.id);

// дерево: бревно видно → рубить; бревно в сумке → доски; доски → палки и верстак; верстак → кирка
assert.deepStrictEqual(ids(V({}, ['oak_log'])), ['log']);
assert(ids(V({ spruce_log: 2 })).includes('planks'));
assert.strictEqual(ST.BY_ID.get('planks').params(V({ spruce_log: 2 })).item, 'spruce_planks', 'доски — из того бревна, что в сумке');
assert(ids(V({ oak_planks: 4 })).includes('table') && ids(V({ oak_planks: 4 })).includes('sticks'));
assert(!ids(V({ oak_planks: 3, stick: 2 })).includes('wooden_pickaxe'), 'без верстака кирку не предлагаем');
assert(ids(V({ oak_planks: 3, stick: 2, crafting_table: 1 })).includes('wooden_pickaxe'), 'верстак в сумке — кирка (тело поставит верстак само)');
assert(ids(V({ oak_planks: 3, stick: 2 }, ['crafting_table'])).includes('wooden_pickaxe'), 'верстак рядом — кирка');
// камень: без кирки не копаем; с киркой и камнем рядом — копаем
assert(!ids(V({}, ['stone'])).includes('cobble') && ids(V({ wooden_pickaxe: 1 }, ['stone'])).includes('cobble'));
assert(ids(V({ cobbled_deepslate: 3, stick: 2, crafting_table: 1 })).includes('stone_pickaxe'), 'глубинный булыжник тоже годится');
// железо: деревянной киркой руду не берём
assert(!ids(V({ wooden_pickaxe: 1 }, ['iron_ore'])).includes('iron_ore') && ids(V({ stone_pickaxe: 1 }, ['iron_ore'])).includes('iron_ore'));
assert(ids(V({ raw_iron: 3, coal: 1, furnace: 1 })).includes('smelt_iron') && !ids(V({ raw_iron: 3, furnace: 1 })).includes('smelt_iron'), 'плавка — только с топливом');
// еда: животное рядом — охота; сырое + печь + топливо — жарка; сыта — не ест
assert(ids(V({}, [], [{ name: 'cow', d: 10 }])).includes('hunt_cow') && !ids(V({}, [], [{ name: 'cow', d: 30 }])).includes('hunt_cow'));
assert(ids(V({ beef: 2, oak_planks: 1 }, ['furnace'])).includes('cook'));
assert(!ids(V({ bread: 2 }, [], [], { food: 20 })).includes('eat') && ids(V({ bread: 2 }, [], [], { food: 12 })).includes('eat'));
// ночь: спать — только ночью и с кроватью; переждать — только ночью
assert(!ids(V({ white_bed: 1 })).includes('sleep') && ids(V({ white_bed: 1 }, [], [], { s: { isNight: true } })).includes('sleep'));
// в руке уже кирка — брать её снова не предлагаем
assert(!ids(V({ stone_pickaxe: 1 }, [], [], { held: 'stone_pickaxe' })).includes('equip_pickaxe'));
assert.strictEqual(ST.BY_ID.get('equip_pickaxe').params(V({ wooden_pickaxe: 1, iron_pickaxe: 1 })).item, 'iron_pickaxe', 'лучшая кирка');
// кровать: 3 шерсти одного цвета
assert.strictEqual(ST.BY_ID.get('bed').params(V({ red_wool: 3, oak_planks: 3, crafting_table: 1 })).item, 'red_bed');
assert(!ids(V({ red_wool: 2, white_wool: 1, oak_planks: 3, crafting_table: 1 })).includes('bed'), 'шерсть разных цветов — кровать не выйдет');

// 4) места: куда поставить верстак, где вспахать
const grid = new Map();
for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) { grid.set(`${x},63,${z}`, 'grass_block'); grid.set(`${x},64,${z}`, 'air'); grid.set(`${x},65,${z}`, 'air'); }
grid.set('0,63,0', 'water');
const g = V({ crafting_table: 1, wooden_hoe: 1 }, [...new Set(grid.values())], [], { grid, pos: { x: 0, y: 64, z: 0 } });
const spot = ST.placeSpot(g);
assert(spot && spot.y === 64 && !(spot.x === 0 && spot.z === 0), 'место для верстака — рядом, не под ногами: ' + JSON.stringify(spot));
assert(ids(g).includes('table_place'));
const area = ST.tillArea(g);
assert(area && area.y === 63 && area.x1 === -3 && area.x2 === 3, 'пашня — вокруг воды: ' + JSON.stringify(area));
assert(ids(g).includes('till'));
assert.strictEqual(ST.placeSpot(V({ crafting_table: 1 })), null, 'мир не виден — ставить некуда');

// 5) решатель: шаги — кандидаты с подсказкой 0, только с пулом; HC_STEPS=0 выключает; заблокированный шаг не предлагаем
const ctx = { bot: { food: 20, entities: {}, entity: { position: { x: 0, y: 64, z: 0 } }, heldItem: null,
  inventory: { items: () => [{ name: 'oak_log', count: 3 }, { name: 'oak_planks', count: 4 }], slots: [] } } };
delete process.env.HC_POOL;
assert.deepStrictEqual(DECIDER.stepOptions(ctx, {}), [], 'без пула шагов нет');
process.env.HC_POOL = '1';
const opts = DECIDER.stepOptions(ctx, { blocked: {} });
const keys = opts.map(o => o.key);
assert(keys.includes('step:planks') && keys.includes('step:sticks') && keys.includes('step:table'), 'шаги дерева: ' + keys.join(' '));
assert(opts.every(o => o.prior === 0 && o.act.kind === 'body' && o.act.key === o.key), 'подсказка 0, команда тела');
assert(!DECIDER.stepOptions(ctx, { blocked: { 'step:planks': true } }).some(o => o.key === 'step:planks'), 'заблокированный шаг');
process.env.HC_STEPS = '0';
assert.deepStrictEqual(DECIDER.stepOptions(ctx, {}), [], 'HC_STEPS=0 — выключено');
delete process.env.HC_STEPS; delete process.env.HC_POOL;

// 6) сводка
const d = REPORT.data();
assert.strictEqual(d.total.steps, ST.STEPS.length);
assert.strictEqual(d.total.pool, Object.values(CATALOG).flat().length);
assert(/Коротких навыков вышло/.test(REPORT.markdown(d)));
console.log(`hardcore_steps: ok — было ${d.total.before} навыков (длинных ${d.total.long}), коротких вышло ${d.total.steps}`);
