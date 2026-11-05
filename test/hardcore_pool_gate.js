// Офлайн-проверка «цель рядом» (решение хозяина 05.11): навык, который ходит в поиске цели, предлагается только когда цель видна рядом.
// И зависание: навык без цели кончается по времени, а не крутится без конца (был баг: цикл «пока не нашёл» в пустом мире висел навсегда).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./hardcore_pool.js');
const G = require('../hardcore/pool/gate.js');
const RUN = require('../hardcore/pool/run.js');
const shim = require('../hardcore/pool/shim.js');
const CATALOG = require('../hardcore/pool/catalog.json');
const DECIDER = require('../hardcore/decider.js');

const entryOf = id => Object.values(CATALOG).flat().find(e => e.id === id);
const STONE_IDS = ['v1.mineTenCobblestone', 'v3.mineEightCobblestone', 'o.mineCobblestone', 'o.collectCobblestone'];   // в пустом мире камень есть

// дочерний режим: навыки с поиском в пустом мире кончаются по времени (здесь — отдельный процесс, чтобы зацикливание не висело весь тест)
async function spinChild() {
  for (const id of ['v3.killThreeCows', 'o.collectWheatSeeds', 'v1.mineFiveIronOres']) {
    const t0 = Date.now();
    const r = await shim.runForeign(T.fakeBody(T.RICH, true).api, entryOf(id), { maxSec: 1 });
    assert(!r.ok, id + ' в пустом мире не должен удаваться');
    assert(Date.now() - t0 < 6000, id + ' не уложился в потолок: ' + (Date.now() - t0) + ' мс');
  }
  console.log('spin ok');
}

(async () => {
  if (process.argv[2] === '--spin') { await spinChild(); return; }

  // 1) зависания нет: дочерний процесс должен закончиться сам (таймаут 60 с — иначе тест провален)
  const child = spawnSync(process.execPath, [__filename, '--spin'], { timeout: 60000, encoding: 'utf8' });
  assert(child.status === 0 && /spin ok/.test(child.stdout || ''), 'навык без цели завис или упал: ' + (child.signal || '') + ' ' + (child.stderr || child.stdout || '').slice(0, 400));

  // 2) вид мухи: пустой мир — целей рядом нет (кроме камня и того, что есть в сумке); полный мир — цели рядом есть
  const bare = await G.viewOfApi(T.fakeBody(T.RICH, true).api);
  const full = await G.viewOfApi(T.fakeBody(T.RICH, false).api);
  for (const id of Object.keys(G.NEED)) {
    const usesBag = G.NEED[id].some(g => g.some(a => a.i || a.f));
    if (STONE_IDS.includes(id)) assert(G.present(bare, id), 'в пустом мире камень рядом: ' + id);
    else if (!usesBag) assert.strictEqual(G.present(bare, id), false, 'в пустом мире без цели рядом: ' + id);
  }
  for (const id of ['v3.killThreeCows', 'v1.killTwoPigs', 'o.breedCow', 'o.breedSheep', 'o.collectWheatSeeds', 'o.hoeFarmland',
    'o.collectWheat', 'o.collectCarrots', 'o.collectPotatoes', 'o.mineIronOre', 'v1.mineFiveIronOres', 'v3.mineThreeIronOre',
    'o.killOneZombie', 'o.killOneSpider', 'o.mineFlint', 'o.collectWaterWithBucket', 'v2.catchThreeFish', 'v2.mineFiveCoalOres',
    'o.shearOneSheep', 'o.plantWheatSeeds']) assert(G.present(full, id), 'рядом должна быть цель: ' + id);
  // а этих рядом нет: алмаз на 12 блоков ниже (вне окна 4 по высоте), булыжного глубинного сланца и ели в поддельном мире нет
  for (const id of ['o.mineDiamond', 'v3.mineTenCobbledDeepslateBelowY0', 'v2.chopSpruceLogs']) assert.strictEqual(G.present(full, id), false, 'целей рядом нет: ' + id);

  // 2а) крафт с добычей: материала в сумке хватает — доступен всегда; не хватает — нужен блок рядом
  const V = (grid, inv) => G.makeView(new Map(grid), [], inv);
  assert(G.present(V([], { oak_log: 4 }), 'v3.craftWoodenPickaxe'), '4 бревна в сумке — крафт доступен');
  assert(!G.present(V([], { oak_log: 3 }), 'v3.craftWoodenPickaxe'), '3 бревна и ни одного рядом — не предлагаю');
  assert(G.present(V([['0,64,0', 'oak_log']], { oak_log: 3 }), 'v3.craftWoodenPickaxe'), '3 бревна в сумке и бревно рядом — доступен');
  assert(!G.present(V([], { iron_ingot: 7 }), 'v3.craftIronChestplate'), '7 слитков, руды рядом нет — не предлагаю');
  assert(G.present(V([['1,64,1', 'iron_ore']], { iron_ingot: 7 }), 'v3.craftIronChestplate'), '7 слитков и руда рядом — доступен');
  assert(G.present(V([], { iron_ingot: 11 }), 'v3.craftIronLeggingsAndBoots'), '11 слитков — сапоги и поножи без руды и угля рядом');
  assert(G.present(V([['1,64,1', 'iron_ore'], ['2,64,2', 'coal_ore']], { iron_ingot: 5 }), 'v3.craftIronLeggingsAndBoots'), '5 слитков, руда и уголь рядом — доступны');
  assert(!G.present(V([['1,64,1', 'iron_ore']], { iron_ingot: 5 }), 'v3.craftIronLeggingsAndBoots'), 'угля мало и рядом нет — не предлагаю');

  // 2б) готовка и рыбалка (разбор 1-го мира этапа 2): без сырья в сумке готовку не предлагаем, без удочки (ниток, паука рядом) — рыбалку
  for (const [id, item] of [['v3.cookRawBeef', 'beef'], ['o.cookBeef', 'beef'], ['v3.cookChicken', 'chicken'], ['v3.cookRawMutton', 'mutton'],
    ['v1.cookPorkchops', 'porkchop'], ['o.cookPorkchop', 'porkchop'], ['v3.eatCookedMuttonIfHungry', 'cooked_mutton']]) {
    assert(!G.present(V([], {}), id), 'без сырья не предлагаю: ' + id);
    assert(G.present(V([], { [item]: 1 }), id), 'сырьё в сумке — предлагаю: ' + id);
  }
  assert(!G.present(V([], { wheat: 2 }), 'o.makeBread') && G.present(V([], { wheat: 3 }), 'o.makeBread'), 'хлеб — от 3 пшеницы');
  const W = [['1,63,1', 'water']];
  assert(!G.present(V(W, {}), 'v2.catchThreeFish'), 'вода есть, удочки нет — не предлагаю');
  assert(G.present(V(W, { fishing_rod: 1 }), 'v2.catchThreeFish'), 'вода и удочка — предлагаю');
  assert(G.present(V(W, { string: 2 }), 'v2.fishInNearbyWaterSafely'), 'вода и нитки на удочку — предлагаю');
  assert(G.present(G.makeView(new Map(W), [{ name: 'spider', d: 10 }], {}), 'v2.catchThreeFish'), 'вода и паук рядом (нитки) — предлагаю');
  assert(!G.present(V([], { fishing_rod: 1 }), 'v2.catchThreeFish'), 'удочка без воды — не предлагаю');
  assert(!G.present(V([], { string: 1 }), 'o.craftFishingRod') && G.present(V([], { string: 2 }), 'o.craftFishingRod'), 'удочка — от 2 ниток');

  // 2в) крафт только из сумки (разбор 2-го мира этапа 2): лук, стрелы, броня, каменные и деревянные инструменты — только при материале
  const NOWOOD = { cobblestone: 3 };
  assert(!G.present(V([], { stick: 3 }), 'o.craftBow'), 'лук без ниток — не предлагаю');
  assert(!G.present(V([], { string: 3 }), 'o.craftBow'), 'лук без дерева на палки и верстак — не предлагаю');
  assert(G.present(V([], { string: 3, stick: 3, crafting_table: 1 }), 'o.craftBow'), 'нитки, палки и верстак — предлагаю');
  assert(G.present(V([], { string: 3, oak_log: 2 }), 'o.craftBow'), 'нитки и 2 бревна (палки и верстак) — предлагаю');
  assert(!G.present(V([], { string: 3, oak_log: 1 }), 'o.craftBow'), 'нитки и 1 бревно: на верстак и палки мало — не предлагаю');
  assert(!G.present(V([], { stick: 1, crafting_table: 1 }), 'o.craftArrow'), 'стрелы без кремня, гравия, пера и кур — не предлагаю');
  assert(G.present(V([['1,64,1', 'gravel']], { feather: 1, stick: 1, crafting_table: 1 }), 'o.craftArrow'), 'гравий рядом, перо и палка — предлагаю');
  assert(G.present(G.makeView(new Map(), [{ name: 'chicken', d: 8 }], { flint: 1, stick: 1, crafting_table: 1 }), 'o.craftArrow'), 'кремень и курица рядом — предлагаю');
  assert(!G.present(V([], {}), 'o.equipArmor') && G.present(V([], { leather_helmet: 1 }), 'o.equipArmor'), 'броня — только когда она в сумке');
  for (const id of ['v3.craftStonePickaxe', 'v3.craftStoneAxe', 'v3.craftStoneSword', 'o.craftStonePickaxe', 'v1.craftStonePickaxe']) {
    assert(!G.present(V([], { stick: 2, crafting_table: 1 }), id), 'без булыжника не предлагаю: ' + id);
    assert(!G.present(V([], NOWOOD), id), 'без палок и досок не предлагаю: ' + id);
    assert(G.present(V([], { cobblestone: 3, oak_planks: 2, crafting_table: 1 }), id), 'булыжник и доски — предлагаю: ' + id);
  }
  assert(!G.present(V([], { oak_planks: 1 }), 'v3.craftWoodenSword') && G.present(V([], { oak_planks: 2, stick: 1 }), 'v3.craftWoodenSword'), 'деревянный меч — от 2 досок и палки');
  assert(!G.present(V([], {}), 'v2.craftWoodenPickaxe') && G.present(V([], { spruce_log: 2 }), 'v2.craftWoodenPickaxe'), 'деревянная кирка — от 2 брёвен');
  assert(G.present(V([], { stone_sword: 1 }), 'o.equipSwordOrCraftOne') && !G.present(V([], {}), 'o.equipSwordOrCraftOne'), 'меч: есть в сумке — предлагаю, нет ни меча, ни дерева — нет');
  assert(!G.present(V([], { stone_pickaxe: 1 }), 'o.equipAxeOrCraftOne'), 'кирка — не топор');
  assert(!G.present(V([], { oak_log: 2 }), 'o.equipPickaxeOrCraftOne') && G.present(V([], { oak_log: 3 }), 'o.equipPickaxeOrCraftOne'), 'кирки нет: верстак, доски и палки — от 3 брёвен');

  // 3) кандидаты: в пустом мире животных нет — охота и разведение не предлагаются; натив и готовка остаются
  const kept = G.withTarget(bare, RUN.candidates('food', 'day_routine_v6')).map(c => c.id);
  for (const id of ['v3.killThreeCows', 'v3.killThreeChickens', 'v3.killThreeSheep', 'v1.killTwoPigs', 'o.breedCow', 'o.breedSheep', 'o.breedChicken'])
    assert(!kept.includes(id), 'без животных рядом не предлагаю: ' + id);
  assert(kept.includes('day_routine_v6') && kept.includes('v3.cookRawBeef'), 'натив и готовка остаются в списке');

  // 4) таблица покрывает всех, кто ходит в поиске цели (exploreUntil) и всех разводящих; пещеры — своя проверка (run.js)
  for (const list of Object.values(CATALOG)) for (const e of list) {
    if (RUN.CAVE.has(e.id)) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', 'hardcore', 'pool', e.lib, e.file || e.fn + '.js'), 'utf8');
    if (/exploreUntil/.test(src) || /^breed/.test(e.fn)) assert(G.NEED[e.id], 'нет цели для навыка, который ходит в поиске: ' + e.id);
  }

  // 5) решатель: та же таблица. Вид пустой (тела нет в этом тесте) — навыки с целью не предлагаются, крафт из сумки — да
  process.env.HC_POOL = '1';
  const ctx = { bot: { food: 20, entities: {}, entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }], slots: [] } } };
  const offered = DECIDER.poolOptions(ctx, { isNight: false, blocked: {} }).map(o => o.act.params.id);
  assert(offered.every(id => G.present({ blocks: new Set(), ents: [], inv: { wooden_pickaxe: 1 } }, id)), 'решатель предлагает только навыки с целью рядом: ' + offered.join(' '));
  assert(!offered.includes('v1.mineTenCobblestone'), 'камень без камня рядом — не предлагаю');
  assert(!offered.includes('v1.craftStonePickaxe'), 'крафт с добычей камня без камня в сумке и рядом — не предлагаю');
  assert(!offered.includes('v3.craftStonePickaxe'), 'крафт из сумки без булыжника — не предлагаю (разбор 2-го мира)');
  const ctx2 = { bot: { ...ctx.bot, inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }, { name: 'cobblestone', count: 3 }, { name: 'stick', count: 2 }], slots: [] } } };   // новая муха: вид решателя кэшируется по мухе
  const offered2 = DECIDER.poolOptions(ctx2, { isNight: false, blocked: {} }).map(o => o.act.params.id);
  assert(offered2.includes('v3.craftStonePickaxe'), 'булыжник и палки в сумке — крафт предлагается: ' + offered2.join(' '));
  delete process.env.HC_POOL;

  console.log('hardcore_pool_gate: ok');
})().catch(e => { console.error(e); process.exit(1); });
