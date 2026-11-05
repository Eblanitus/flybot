// Короткие навыки мух (хозяин 05.11): длинные навыки порезаны на шаги, каждый шаг — отдельный навык, который решатель
// (hardcore/decider.js) может выбрать сам. Длинные навыки остаются как были: муха может взять либо один длинный навык,
// либо несколько коротких, которые вместе дают тот же итог.
// Шаг = одна команда тела (collect, craft, smelt, hunt, fight, place_at, till, plant, harvest, fish, shear, sleep…).
// У каждого шага — проверка «есть из чего делать»: материал в сумке, цель в виду мухи (survey окно 10 × 4, существа ≤ 16 м).
// Нет — шаг не предлагается (как gate.js у пула). Других запретов нет: муху не ограничиваем (хозяин 05.11).
// Какие длинные навыки из каких шагов состоят — split.js. Сводка для людей — node hardcore/steps/report.js.
'use strict';

const ENT_R = 16;
const LOG = /^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_(log|stem|wood|hyphae)$/;
const PLANKS = /_planks$/;
const COBBLE = /^(cobblestone|cobbled_deepslate|blackstone)$/;
const PICKAXE = /_pickaxe$/, PICK_STONE = /^(stone|iron|diamond|netherite)_pickaxe$/, PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/;
const SWORD = /_sword$/, AXE = /^(wooden|stone|iron|golden|diamond|netherite)_axe$/, HOE = /_hoe$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const COAL = /^(coal|charcoal)$/;
const FUEL = /^(coal|charcoal|stick|coal_block)$|_(log|stem|planks)$/;
const RAW_MEAT = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/;
const EDIBLE = /^(cooked_\w+|bread|baked_potato|apple|golden_apple|carrot|melon_slice|sweet_berries|pumpkin_pie|mushroom_stew|beetroot|beetroot_soup|rabbit_stew|cookie|dried_kelp)$/;
const SEEDS = /^(wheat_seeds|beetroot_seeds|carrot|potato)$/;
const TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

// --- вид мухи ---
const sum = (v, w) => Object.entries(v.inv).filter(([n]) => (w instanceof RegExp ? w.test(n) : n === w)).reduce((a, [, c]) => a + c, 0);
const has = (v, w, n = 1) => sum(v, w) >= n;
const sees = (v, ...names) => [...v.blocks].some(b => names.some(w => (w instanceof RegExp ? w.test(b) : w === b)));
const near = (v, ...names) => v.ents.some(e => e.d <= ENT_R && names.includes(e.name));
const nearCount = (v, name) => v.ents.filter(e => e.d <= ENT_R && e.name === name).length;
const table = v => has(v, 'crafting_table') || sees(v, 'crafting_table');      // верстак в сумке — тело поставит его само
const furnace = v => has(v, 'furnace') || sees(v, 'furnace');                  // печь в сумке — тело поставит её само
const fuel = (v, except) => Object.entries(v.inv).some(([n, c]) => c > 0 && n !== except && FUEL.test(n));
const sticks = (v, n) => has(v, 'stick', n);
const planks = (v, n) => has(v, PLANKS, n);
const cobble = (v, n) => has(v, COBBLE, n);
const best = (v, re) => Object.keys(v.inv).filter(n => re.test(n) && v.inv[n] > 0)
  .sort((a, b) => TIER.indexOf(b.split('_')[0]) - TIER.indexOf(a.split('_')[0]))[0] || null;
const heldIs = (v, re) => !!v.held && re.test(v.held);
const night = v => !!(v.s && v.s.isNight);
const logName = v => Object.keys(v.inv).filter(n => LOG.test(n) && v.inv[n] > 0).sort((a, b) => v.inv[b] - v.inv[a])[0] || null;
const planksOf = log => log.replace(/^stripped_/, '').replace(/_(log|stem|wood|hyphae)$/, '_planks');
const woolColor = v => { const w = Object.keys(v.inv).find(n => /_wool$/.test(n) && v.inv[n] >= 3); return w ? w.replace(/_wool$/, '') : null; };
const rawMeat = v => Object.keys(v.inv).filter(n => RAW_MEAT.test(n) && v.inv[n] > 0).sort((a, b) => v.inv[b] - v.inv[a])[0] || null;

// клетки сетки survey: 'x,y,z' → имя блока
const at = (v, x, y, z) => v.grid.get(`${x},${y},${z}`);
const SOLID_NOT = /^(air|cave_air|water|lava|unknown|short_grass|tall_grass|snow|fern|dead_bush|torch)$|_(flower|sapling|carpet)$/;
// куда поставить блок рядом: клетка на уровне ног в 1–2 блоках, пусто в ней и над ней, под ней — твёрдое
function placeSpot(v) {
  if (!v.pos || !v.grid || !v.grid.size) return null;
  const { x, y, z } = v.pos;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const cx = x + dx, cz = z + dz;
    const c = at(v, cx, y, cz), up = at(v, cx, y + 1, cz), down = at(v, cx, y - 1, cz);
    if (c === 'air' && (up === 'air' || up === undefined) && down && !SOLID_NOT.test(down)) return { x: cx, y, z: cz };
  }
  return null;
}
// где вспахать: вода в виду и рядом с ней земля, над которой пусто (пашня держится в 4 клетках от воды)
const TILLABLE = /^(dirt|grass_block|coarse_dirt|rooted_dirt)$/;
function tillArea(v) {
  if (!v.grid || !v.grid.size) return null;
  for (const [k, n] of v.grid) {
    if (n !== 'water') continue;
    const [wx, wy, wz] = k.split(',').map(Number);
    let cells = 0;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const b = at(v, wx + dx, wy, wz + dz), up = at(v, wx + dx, wy + 1, wz + dz);
      if (b && TILLABLE.test(b) && (up === 'air' || up === 'short_grass')) cells++;
    }
    if (cells >= 2) return { x1: wx - 3, z1: wz - 3, x2: wx + 3, z2: wz + 3, y: wy, max: 16 };
  }
  return null;
}
// вход в пещеру в виду: воздух ниже y 60 (как caveInView у пула)
function caveSpot(v) {
  if (!v.grid) return null;
  for (const [k, n] of v.grid) if (n === 'air' || n === 'cave_air') { const [x, y, z] = k.split(',').map(Number); if (y < 60 && v.pos && v.pos.y >= 60) return { x, y, z }; }
  return null;
}
// перебежка к базе: точка в 12 блоках по пути к базе
function baseHop(v) {
  const b = v.s && v.s.base, p = v.pos;
  if (!b || !p || !Number.isFinite(b.x) || !Number.isFinite(b.z)) return null;
  const dx = b.x - p.x, dz = b.z - p.z, d = Math.hypot(dx, dz);
  if (d <= 16) return null;
  const k = Math.min(1, 12 / d);
  return { x: Math.round(p.x + dx * k), z: Math.round(p.z + dz * k) };
}

// --- шаги ---
// cat — категория; title — что делает (для людей); cmd — команда тела; params(v) — её параметры; need(v) — есть ли из чего делать
const craft = (item, count = 1) => () => ({ item, count });
const CATS = {
  wood: 'Дерево', stone: 'Камень', light: 'Печь, уголь и свет', food: 'Еда', farm: 'Поле и животные',
  iron: 'Железо', under: 'Подземелье и ночь', combat: 'Бой', bed: 'Кровать', move: 'Передвижение'
};
const S = [];
const step = (cat, id, title, cmd, params, need) => S.push({ cat, id, title, cmd, params: typeof params === 'function' ? params : () => params, need });

// Дерево
step('wood', 'log', 'Срубить 3 бревна (дерево видно рядом)', 'collect', { block: 'log', count: 3, radius: 16 }, v => sees(v, LOG));
step('wood', 'planks', 'Распилить бревно на 4 доски', 'craft', v => ({ item: planksOf(logName(v)), count: 4 }), v => !!logName(v));
step('wood', 'sticks', 'Сделать 4 палки из досок', 'craft', craft('stick', 4), v => planks(v, 2));
step('wood', 'table', 'Сделать верстак', 'craft', craft('crafting_table'), v => planks(v, 4) && !has(v, 'crafting_table'));
step('wood', 'table_place', 'Поставить верстак рядом', 'place_at', v => ({ ...placeSpot(v), item: 'crafting_table' }), v => has(v, 'crafting_table') && !sees(v, 'crafting_table') && !!placeSpot(v));
step('wood', 'wooden_pickaxe', 'Сделать деревянную кирку', 'craft', craft('wooden_pickaxe'), v => planks(v, 3) && sticks(v, 2) && table(v));
step('wood', 'wooden_sword', 'Сделать деревянный меч', 'craft', craft('wooden_sword'), v => planks(v, 2) && sticks(v, 1) && table(v));
step('wood', 'wooden_axe', 'Сделать деревянный топор', 'craft', craft('wooden_axe'), v => planks(v, 3) && sticks(v, 2) && table(v));
step('wood', 'wooden_shovel', 'Сделать деревянную лопату', 'craft', craft('wooden_shovel'), v => planks(v, 1) && sticks(v, 2) && table(v));
step('wood', 'wooden_hoe', 'Сделать деревянную мотыгу', 'craft', craft('wooden_hoe'), v => planks(v, 2) && sticks(v, 2) && table(v));
step('wood', 'chest', 'Сделать сундук', 'craft', craft('chest'), v => planks(v, 8) && table(v));
step('wood', 'chest_place', 'Поставить сундук рядом', 'place_at', v => ({ ...placeSpot(v), item: 'chest' }), v => has(v, 'chest') && !!placeSpot(v));
step('wood', 'equip_pickaxe', 'Взять лучшую кирку в руку', 'equip_item', v => ({ item: best(v, PICKAXE) }), v => has(v, PICKAXE) && !heldIs(v, PICKAXE));
step('wood', 'equip_axe', 'Взять лучший топор в руку', 'equip_item', v => ({ item: best(v, AXE) }), v => has(v, AXE) && !heldIs(v, AXE));

// Камень
step('stone', 'cobble', 'Добыть 3 булыжника (камень виден рядом)', 'collect', { block: 'stone', count: 3, radius: 16 }, v => has(v, PICKAXE) && sees(v, 'stone'));
step('stone', 'stone_pickaxe', 'Сделать каменную кирку', 'craft', craft('stone_pickaxe'), v => cobble(v, 3) && sticks(v, 2) && table(v));
step('stone', 'stone_sword', 'Сделать каменный меч', 'craft', craft('stone_sword'), v => cobble(v, 2) && sticks(v, 1) && table(v));
step('stone', 'stone_axe', 'Сделать каменный топор', 'craft', craft('stone_axe'), v => cobble(v, 3) && sticks(v, 2) && table(v));
step('stone', 'stone_shovel', 'Сделать каменную лопату', 'craft', craft('stone_shovel'), v => cobble(v, 1) && sticks(v, 2) && table(v));

// Печь, уголь и свет
step('light', 'furnace', 'Сделать печь из 8 булыжников', 'craft', craft('furnace'), v => cobble(v, 8) && table(v) && !has(v, 'furnace'));
step('light', 'furnace_place', 'Поставить печь рядом', 'place_at', v => ({ ...placeSpot(v), item: 'furnace' }), v => has(v, 'furnace') && !sees(v, 'furnace') && !!placeSpot(v));
step('light', 'coal', 'Добыть 2 угля (руда видна рядом)', 'collect', { block: 'coal_ore', count: 2, radius: 16 }, v => has(v, PICKAXE) && sees(v, 'coal_ore', 'deepslate_coal_ore'));
step('light', 'torches', 'Сделать 4 факела', 'craft', craft('torch', 4), v => has(v, COAL) && sticks(v, 1));
step('light', 'campfire', 'Сделать костёр', 'craft', craft('campfire'), v => has(v, LOG, 3) && sticks(v, 3) && has(v, COAL) && table(v));
step('light', 'light_here', 'Расставить факелы вокруг', 'light', { radius: 8, max: 6 }, v => has(v, 'torch'));

// Еда
for (const [a, ru] of [['cow', 'корову'], ['pig', 'свинью'], ['chicken', 'курицу'], ['sheep', 'овцу']])
  step('food', 'hunt_' + a, `Убить ${ru} на еду (видна рядом)`, 'hunt', { animal: a, count: 1 }, v => near(v, a));
step('food', 'cook', 'Пожарить сырое мясо или рыбу в печи', 'smelt', v => { const r = rawMeat(v); return { item: r, count: Math.min(8, v.inv[r] || 1) }; },
  v => !!rawMeat(v) && furnace(v) && fuel(v, rawMeat(v)));
step('food', 'eat', 'Поесть из сумки', 'eat', {}, v => has(v, EDIBLE) && v.food != null && v.food < 20);
step('food', 'bread', 'Испечь хлеб из 3 пшеницы', 'craft', craft('bread'), v => has(v, 'wheat', 3) && table(v));

// Поле и животные
step('farm', 'seeds', 'Нарвать травы на семена', 'collect', { block: 'short_grass', count: 4, radius: 12 }, v => sees(v, 'short_grass', 'tall_grass'));
step('farm', 'till', 'Вспахать землю у воды мотыгой', 'till', v => tillArea(v), v => has(v, HOE) && !!tillArea(v));
step('farm', 'plant', 'Посадить семена на пашню', 'plant', v => ({ seed: Object.keys(v.inv).find(n => SEEDS.test(n) && v.inv[n] > 0), radius: 8 }), v => has(v, SEEDS) && sees(v, 'farmland'));
for (const [c, b, ru] of [['wheat', 'wheat', 'пшеницу'], ['carrot', 'carrots', 'морковь'], ['potato', 'potatoes', 'картошку']])
  step('farm', 'harvest_' + c, `Собрать спелую ${ru} (грядка видна)`, 'harvest', { crop: c, radius: 8 }, v => sees(v, b));
for (const [a, food, ru] of [['cow', 'wheat', 'коров'], ['sheep', 'wheat', 'овец'], ['chicken', 'wheat_seeds', 'кур']])
  step('farm', 'breed_' + a, `Покормить двух ${ru}, чтобы был приплод`, 'breed', { animal: a, radius: 16 }, v => has(v, food, 2) && nearCount(v, a) >= 2);
step('farm', 'fishing_rod', 'Сделать удочку (3 палки + 2 нитки)', 'craft', craft('fishing_rod'), v => sticks(v, 3) && has(v, 'string', 2) && table(v));
step('farm', 'fish', 'Порыбачить (вода видна)', 'fish', { casts: 3, max_sec: 90 }, v => has(v, 'fishing_rod') && sees(v, 'water'));
step('farm', 'shears', 'Сделать ножницы из 2 слитков', 'craft', craft('shears'), v => has(v, 'iron_ingot', 2) && !has(v, 'shears'));
step('farm', 'shear', 'Остричь овцу ножницами', 'shear', { animal: 'sheep', radius: 16, max: 2 }, v => has(v, 'shears') && near(v, 'sheep'));
step('farm', 'bucket', 'Сделать ведро из 3 слитков', 'craft', craft('bucket'), v => has(v, 'iron_ingot', 3) && table(v));
step('farm', 'water_bucket', 'Набрать воды в ведро', 'bucket', { action: 'fill', liquid: 'water' }, v => has(v, 'bucket') && sees(v, 'water'));

// Железо
step('iron', 'iron_ore', 'Добыть 2 железной руды (видна рядом)', 'collect', { block: 'iron_ore', count: 2, radius: 16 }, v => has(v, PICK_STONE) && sees(v, 'iron_ore', 'deepslate_iron_ore'));
step('iron', 'smelt_iron', 'Переплавить руду в железные слитки', 'smelt', v => ({ item: 'iron_ingot', count: Math.min(8, v.inv.raw_iron || 1) }), v => has(v, 'raw_iron') && furnace(v) && fuel(v));
step('iron', 'iron_pickaxe', 'Сделать железную кирку', 'craft', craft('iron_pickaxe'), v => has(v, 'iron_ingot', 3) && sticks(v, 2) && table(v));
step('iron', 'iron_sword', 'Сделать железный меч', 'craft', craft('iron_sword'), v => has(v, 'iron_ingot', 2) && sticks(v, 1) && table(v));
for (const [p, n, ru] of [['helmet', 5, 'шлем'], ['chestplate', 8, 'нагрудник'], ['leggings', 7, 'поножи'], ['boots', 4, 'ботинки']])
  step('iron', 'iron_' + p, `Сделать железный ${ru} (${n} слитков)`, 'craft', craft('iron_' + p), v => has(v, 'iron_ingot', n) && table(v));
step('iron', 'shield', 'Сделать щит (6 досок + слиток)', 'craft', craft('shield'), v => planks(v, 6) && has(v, 'iron_ingot') && table(v));
step('iron', 'equip_armor', 'Надеть броню из сумки', 'equip_best', { for: 'fight' }, v => has(v, ARMOR));
step('iron', 'equip_shield', 'Взять щит во вторую руку', 'equip_item', { item: 'shield', slot: 'off-hand' }, v => has(v, 'shield'));

// Подземелье и ночь
step('under', 'dirt', 'Накопать 6 земли на укрытие', 'collect', { block: 'dirt', count: 6, radius: 12 }, v => sees(v, 'dirt', 'grass_block'));
step('under', 'shelter', 'Укрыться на месте стенами', 'shelter', {}, v => v.s && v.s.blocks >= 10 && !v.s.sheltered);
step('under', 'go_down', 'Спуститься под землю на 4 блока', 'descend', { depth: 4 }, v => has(v, PICKAXE) && !(v.s && v.s.inWater));
step('under', 'go_up', 'Подняться на 4 блока вверх', 'climb', { height: 4 }, v => !!(v.s && v.s.underground));
step('under', 'cave', 'Дойти до входа в пещеру (виден рядом)', 'goto', v => ({ ...caveSpot(v), r: 3, timeout: 60, label: 'к пещере', fail: 'до пещеры не дошла' }), v => !!caveSpot(v));
step('under', 'deepslate', 'Добыть 3 глубинного сланца', 'collect', { block: 'deepslate', count: 3, radius: 12 }, v => has(v, PICKAXE) && sees(v, 'deepslate'));
step('under', 'gold_ore', 'Добыть золотую руду (видна рядом)', 'collect', { block: 'gold_ore', count: 1, radius: 16 }, v => has(v, PICK_IRON) && sees(v, 'gold_ore', 'deepslate_gold_ore'));
step('under', 'redstone_ore', 'Добыть красную руду (видна рядом)', 'collect', { block: 'redstone_ore', count: 1, radius: 16 }, v => has(v, PICK_IRON) && sees(v, 'redstone_ore', 'deepslate_redstone_ore'));
step('under', 'diamond_ore', 'Добыть алмаз (виден рядом)', 'collect', { block: 'diamond_ore', count: 1, radius: 16 }, v => has(v, PICK_IRON) && sees(v, 'diamond_ore', 'deepslate_diamond_ore'));
step('under', 'gravel', 'Накопать 3 гравия (на кремень)', 'collect', { block: 'gravel', count: 3, radius: 12 }, v => sees(v, 'gravel'));
step('under', 'wait_night', 'Переждать ночь на месте', 'wait_night', {}, v => night(v));
step('under', 'sleep', 'Лечь спать (кровать в сумке или рядом)', 'sleep', {}, v => night(v) && (has(v, /_bed$/) || sees(v, /_bed$/)));

// Бой
for (const [m, ru] of [['zombie', 'зомби'], ['skeleton', 'скелета'], ['spider', 'паука'], ['creeper', 'крипера']])
  step('combat', 'fight_' + m, `Убить ${ru} (виден рядом)`, 'fight', { target: m, radius: ENT_R, flee_hp: 6, timeout: 40 }, v => near(v, m));
step('combat', 'bow', 'Сделать лук (3 нитки + 3 палки)', 'craft', craft('bow'), v => has(v, 'string', 3) && sticks(v, 3) && table(v));
step('combat', 'arrows', 'Сделать стрелы (кремень, палка, перо)', 'craft', craft('arrow', 4), v => has(v, 'flint') && sticks(v, 1) && has(v, 'feather') && table(v));
step('combat', 'equip_sword', 'Взять лучший меч в руку', 'equip_item', v => ({ item: best(v, SWORD) }), v => has(v, SWORD) && !heldIs(v, SWORD));

// Кровать
step('bed', 'wool_from_string', 'Сделать шерсть из 4 ниток', 'craft', craft('white_wool'), v => has(v, 'string', 4));
step('bed', 'bed', 'Сделать кровать (3 шерсти одного цвета + 3 доски)', 'craft', v => ({ item: woolColor(v) + '_bed' }), v => !!woolColor(v) && planks(v, 3) && table(v));

// Передвижение
step('move', 'base_hop', 'Перебежка к базе на 12 блоков', 'goto', v => ({ ...baseHop(v), r: 3, timeout: 60, label: 'к базе', fail: 'до точки к базе не дошла' }), v => !!baseHop(v));

const STEPS = S;
const BY_ID = new Map(S.map(x => [x.id, x]));

// вид мухи для шагов: сумка, блоки рядом (с местами), существа, что в руке, сытость и состояние автопилота
function viewOf(ctx, s) {
  const G = require('../pool/gate.js');
  const gv = G.viewOfCtx(ctx);
  const bot = ctx.bot;
  let pos = null, held = null, food = null;
  try { const p = bot.entity.position; pos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; } catch (e) { /* нет позиции */ }
  try { held = bot.heldItem ? bot.heldItem.name : null; } catch (e) { /* пусто */ }
  try { food = bot.food; } catch (e) { /* пусто */ }
  return { ...gv, grid: gv.grid || new Map(), pos, held, food, s: s || {} };
}

// какие шаги можно делать сейчас
function available(v) {
  const out = [];
  for (const x of STEPS) { let ok = false; try { ok = !!x.need(v); } catch (e) { ok = false; } if (ok) out.push(x); }
  return out;
}

// шаги — кандидаты решателя с подсказкой 0 (как навыки пула): новичков пробуем первыми, дальше — средние очки
function options(ctx, s) {
  const v = viewOf(ctx, s);
  return available(v).filter(x => !(s && s.blocked && s.blocked['step:' + x.id])).map(x => {
    let params; try { params = x.params(v); } catch (e) { return null; }
    if (!params) return null;
    return { key: 'step:' + x.id, prior: 0, act: { key: 'step:' + x.id, kind: 'body', name: x.cmd, params, why: `шаг: ${x.title}` } };
  }).filter(Boolean);
}

module.exports = { STEPS, BY_ID, CATS, viewOf, available, options, placeSpot, tillArea, caveSpot, baseHop };
