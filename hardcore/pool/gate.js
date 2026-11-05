// Цель рядом (решение хозяина 05.11): навык, который ходит в поиске цели, предлагаем только когда муха честно видит цель рядом.
// «Честно» — тот же вид, что у мухи: блоки из survey (видно или помнится, остальное в снимок не попадает), существа из scan, сумка из снимка.
// Рядом: блоки — окно 10 по ширине и 4 по высоте (объём 3969 ≤ 4096), существа — не дальше 16 блоков.
// У навыка — список групп: выполниться должны все группы, внутри группы хватает одного варианта:
//   b — блок с таким именем рядом; e — существо рядом; i — в сумке хватает (штук по именам или регуляркам не меньше n: тогда искать не нужно);
//   f — свой признак по виду сумки (например, угля хватает на всё).
// Крафт из сумки — тоже в таблице: предлагаем, только когда материал есть (в сумке, а если навык ходит за ним сам — рядом).
// Навыков вне таблицы это не касается: пещера (своя проверка в run.js), натив.
'use strict';
const { parseSurvey } = require('./shim');

const BLOCK_R = 10, BLOCK_DY = 4, ENT_R = 16;
const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry)_log$/;
const GRASS = ['short_grass', 'tall_grass', 'grass'];   // 'grass' — старое имя короткой травы (как в shim)
const b = names => ({ b: [].concat(names) }), e = names => ({ e: [].concat(names) });   // всегда список (и для одной регулярки тоже)
const i = (names, n = 1) => ({ i: [].concat(names), n });   // в сумке хватает: сумма штук по именам не меньше n
const f = fn => ({ f: fn });   // свой признак по виду сумки
// дерево на крафт: досок нужно planks, палок sticks (палки из досок: 2 доски → 4 палки), бревно — 4 доски.
// table — навык сам крафтит верстак, если его нет в сумке (Odyssey): ещё 4 доски. Считаем всё вместе, как тратит тело.
const PLANKS = /_planks$/, WOOD_LOG = /_(log|stem)$/;
const sumOf = (inv, re) => Object.entries(inv).filter(([n]) => re.test(n)).reduce((s, [, c]) => s + c, 0);
const wood = (planks, sticks, table = false) => f(v => {
  const needSticks = Math.max(0, sticks - (v.inv.stick || 0));
  const need = planks + Math.ceil(needSticks / 4) * 2 + (table && !v.inv.crafting_table ? 4 : 0);
  return need === 0 || sumOf(v.inv, PLANKS) + 4 * sumOf(v.inv, WOOD_LOG) >= need;
});
const ARMOR = /_(helmet|chestplate|leggings|boots)$/;
const SWORD = /_sword$/, PICKAXE = /_pickaxe$/, AXE = /^(wooden|stone|iron|golden|diamond|netherite)_axe$/;

// id каталога → группы. Собрано по коду навыков: все, кто в поиске зовёт exploreUntil, и те, кто сам идёт за блоком или существом.
const NEED = {
  // дерево
  'v1.mineWoodLog': [[b(LOG)]],
  'v3.mineWoodLog': [[b(LOG)]],
  'v2.chopSpruceLogs': [[b(['spruce_log'])]],
  // камень и уголь
  'v1.mineTenCobblestone': [[b(['stone'])]],
  'v3.mineEightCobblestone': [[b(['stone'])]],
  'o.mineCobblestone': [[b(['stone'])]],
  'o.collectCobblestone': [[b(['stone'])]],
  'v2.mineFiveCoalOres': [[b(['coal_ore'])]],
  'v3.mineFourCoalOre': [[b(['coal_ore'])]],
  // еда: животные
  'v3.killThreeCows': [[e(['cow'])]],
  'v3.killThreeChickens': [[e(['chicken'])]],
  'v3.killThreeSheep': [[e(['sheep'])]],
  'v1.killTwoPigs': [[e(['pig'])]],
  // вода и рыба. Удочка: в сумке, или нитки на неё (2), или паук рядом — за нитками навык ходит сам (разбор 1-го мира этапа 2: рыбачили без удочки)
  'v2.catchThreeFish': [[b(['water'])], [i('fishing_rod'), i('string', 2), e(['spider'])]],
  'v2.fishInNearbyWaterSafely': [[b(['water'])], [i('fishing_rod'), i('string', 2), e(['spider'])]],
  'o.craftFishingRod': [[i('string', 2)]],   // за нитками не ходит: без двух ниток только пишет «убей паука» и выходит
  'o.collectWaterWithBucket': [[b(['water'])]],
  'o.collectMilkWithBucket': [[e(['cow'])]],
  // поле: семена, пашня, урожай
  'o.collectWheatSeeds': [[b(GRASS)]],
  'o.plantWheatSeeds': [[i(['wheat_seeds']), b(GRASS)], [b(['farmland'])]],
  'o.hoeFarmland': [[b(['water'])], [b(['dirt', 'grass_block'])]],
  'o.collectWheat': [[b(['wheat'])]],
  'o.collectCarrots': [[b(['carrots'])]],
  'o.collectPotatoes': [[b(['potatoes'])]],
  // готовка и еда из сумки: за сырьём эти навыки не ходят, без него — провал на первой секунде (разбор 1-го мира этапа 2)
  'v3.cookRawBeef': [[i('beef')]],
  'o.cookBeef': [[i('beef')]],
  'v3.cookChicken': [[i('chicken')]],
  'v3.cookRawMutton': [[i('mutton')]],
  'v1.cookPorkchops': [[i('porkchop')]],
  'o.cookPorkchop': [[i('porkchop')]],
  'v3.eatCookedMuttonIfHungry': [[i('cooked_mutton')]],
  'o.makeBread': [[i('wheat', 3)]],
  // разведение: животных рядом не видно — не предлагаем
  'o.breedCow': [[e(['cow'])]],
  'o.breedSheep': [[e(['sheep'])]],
  'o.breedChicken': [[e(['chicken'])]],
  // руда и глубокий камень
  'v3.mineThreeIronOre': [[b(['iron_ore'])]],
  'v1.mineFiveIronOres': [[b(['iron_ore'])]],
  'o.mineIronOre': [[b(['iron_ore', 'deepslate_iron_ore'])]],
  'v3.mineTenCobbledDeepslateBelowY0': [[b(['cobbled_deepslate'])]],
  'v3.mineDeepslateOres': [[b(['deepslate_redstone_ore', 'deepslate_gold_ore'])]],
  'o.mineFlint': [[b(['gravel'])]],
  'o.mineDiamond': [[b(['diamond_ore', 'deepslate_diamond_ore'])]],
  // бой
  'o.killOneZombie': [[e(['zombie'])]],
  'o.killOneSkeleton': [[e(['skeleton'])]],
  'o.killOneSpider': [[e(['spider'])]],
  'o.killOneCreeper': [[e(['creeper'])]],
  // шерсть и овцы
  'v2.craftWhiteBedWithExploration': [[i('white_wool', 3), e(['sheep'])]],
  'o.shearOneSheep': [[e(['sheep'])]],
  // крафт, который сам идёт за добычей, если в сумке мало (решение хозяина 05.11: «все такие навыки так же»):
  // материала хватает — крафт доступен всегда; не хватает — нужен блок рядом. Пороги — из кода навыка.
  'v3.craftWoodenPickaxe': [[i('oak_log', 4), b(['oak_log'])]],
  'v1.craftStonePickaxe': [[i('cobblestone', 3), b(['stone'])], [wood(0, 2)]],
  'v3.craftStoneTools': [[i('cobblestone', 6), b(['stone'])], [wood(0, 5)]],
  'v1.craftFurnace': [[i('cobblestone', 8), b(['stone'])]],
  'v3.craftChest': [[i('oak_planks', 8), b(['oak_log'])]],
  'v3.craftIronChestplate': [[i('iron_ingot', 8), b(['iron_ore'])]],
  'v3.craftIronHelmet': [[i('iron_ingot', 5), b(['iron_ore'])]],
  'v3.craftIronLeggingsAndBoots': [[i('iron_ingot', 11), b(['iron_ore'])],
    [f(v => (v.inv.coal || 0) >= 11 - (v.inv.iron_ingot || 0)), b(['coal_ore'])]],
  // крафт только из сумки (разбор 2-го мира этапа 2: лук без ниток 21 раз, стрелы, броня, каменные и деревянные инструменты без материалов).
  // За материалом эти навыки не ходят: без него — «ничего не прибавилось» или «не хватает». Пороги — из кода навыка.
  'v3.craftStonePickaxe': [[i('cobblestone', 3)], [wood(0, 2)]],
  'v3.craftStoneAxe': [[i('cobblestone', 3)], [wood(0, 2)]],
  'v3.craftStoneSword': [[i('cobblestone', 2)], [wood(0, 1)]],
  'o.craftStonePickaxe': [[i('cobblestone', 3), b(['stone'])], [wood(0, 2, true)]],   // за булыжником ходит сам, за деревом — нет
  'v3.craftWoodenSword': [[wood(2, 1)]],
  'v2.craftWoodenPickaxe': [[wood(3, 2)]],
  // надеть инструмент, а нет его — скрафтить деревянный: нужен инструмент в сумке или дерево на него
  'o.equipSwordOrCraftOne': [[i(SWORD), wood(2, 1, true)]],
  'o.equipPickaxeOrCraftOne': [[i(PICKAXE), wood(3, 2, true)]],
  'o.equipAxeOrCraftOne': [[i(AXE), wood(3, 2, true)]],
  // бой: лук — 3 нитки (за ними не ходит); стрелы — кремень (или гравий рядом), перо (или курица рядом: навык бьёт кур, пока нет пера)
  'o.craftBow': [[i('string', 3)], [wood(0, 3, true)]],
  'o.craftArrow': [[i('flint'), b(['gravel'])], [i('feather'), e(['chicken'])], [wood(0, 1, true)]],
  'o.equipArmor': [[i(ARMOR)]],   // надеть нечего — броня не в сумке
};

const matches = (want, name) => (want instanceof RegExp ? want.test(name) : want === name);
function invOf(snap) { const m = {}; for (const it of (snap && snap.inventory) || []) m[it.name] = (m[it.name] || 0) + it.count; return m; }
function makeView(grid, ents, inv) { return { blocks: new Set(grid.values()), ents, inv, grid }; }   // grid — где что лежит (короткие навыки hardcore/steps ищут место по нему)

// есть ли один вариант группы в виде мухи
function hasAlt(a, view) {
  if (a.b) return [...view.blocks].some(n => a.b.some(w => matches(w, n)));
  if (a.e) return view.ents.some(x => x.d <= ENT_R && a.e.includes(x.name));
  if (a.i) return Object.entries(view.inv).filter(([n]) => a.i.some(w => matches(w, n))).reduce((s, [, c]) => s + c, 0) >= (a.n || 1);
  if (a.f) return !!a.f(view);
  return false;
}

// цель рядом у навыка: выполнены все группы (навык вне таблицы — цель не нужна)
function present(view, id) {
  const groups = NEED[id];
  if (!groups) return true;
  return groups.every(g => g.some(a => hasAlt(a, view)));
}

// кандидаты, у которых цель рядом (остальные не предлагаем)
function withTarget(view, cands) { return cands.filter(c => present(view, c.id)); }

// вид для программы с командами тела (learned-навык, диспетчер): survey, scan и сумка через api
async function viewOfApi(api, snap) {
  const s = snap || await api.snapshot();
  let grid = new Map(), ents = [];
  try { grid = parseSurvey(await api.cmd('survey', { radius: BLOCK_R, dy: BLOCK_DY })); } catch (err) { /* не видно — пусто */ }
  try {
    const sc = await api.cmd('scan', {});
    ents = ((sc && sc.entities) || []).map(x => ({ name: x.name, d: Number(x.distance) }));
  } catch (err) { /* существ не видно — пусто */ }
  return makeView(grid, ents, invOf(s));
}

// вид для решателя (он живёт в одной программе с телом): survey и существа — как у команд тела.
// Кэш на 2 с и ту же клетку: опрос мира дорогой, а решатель выбирает часто.
const viewCache = new WeakMap();
function viewOfCtx(ctx) {
  const bot = ctx.bot;
  const p = bot.entity && bot.entity.position;
  const cell = p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : '';
  const hit = viewCache.get(bot);
  if (hit && hit.cell === cell && Date.now() - hit.t < 2000) return hit.view;
  let grid = new Map(); try { grid = parseSurvey(require('../../lib/survey').survey(ctx, { radius: BLOCK_R, dy: BLOCK_DY })); } catch (err) { /* не видно — пусто */ }
  const ents = [];
  try { for (const x of Object.values(bot.entities || {})) if (x && x !== bot.entity && x.position) ents.push({ name: x.name, d: bot.entity.position.distanceTo(x.position) }); } catch (err) { /* пусто */ }
  const inv = {};
  try { for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count; } catch (err) { /* пусто */ }
  const view = makeView(grid, ents, inv);
  viewCache.set(bot, { cell, t: Date.now(), view });
  return view;
}

module.exports = { NEED, present, withTarget, makeView, viewOfApi, viewOfCtx, invOf };
