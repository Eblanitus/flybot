// Универсальные навыки фермы и торговли: till, plant, harvest, breed, shear, villagers, trade.
// Решений «когда» тут нет: навык делает действие и честно докладывает, что вышло и что осталось.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, r1, SkillError, entName } = require('../util');
const A = require('../actions');
const vision = require('../vision');
const B = require('./basic');
const { nameOf, hasXYZ, reach, findEntity, invDiff, gainedOnly, blockIds, pos3, raceAbort } = B;

const UP = new Vec3(0, 1, 0);
const CROPS = {
  wheat: { block: 'wheat', item: 'wheat', seed: 'wheat_seeds', age: 7 },
  carrot: { block: 'carrots', item: 'carrot', seed: 'carrot', age: 7 },
  potato: { block: 'potatoes', item: 'potato', seed: 'potato', age: 7 },
  beetroot: { block: 'beetroots', item: 'beetroot', seed: 'beetroot_seeds', age: 3 }
};
const CROP_ALIAS = { wheat: 'wheat', пшеница: 'wheat', carrot: 'carrot', carrots: 'carrot', морковь: 'carrot', potato: 'potato', potatoes: 'potato', картофель: 'potato', beetroot: 'beetroot', beetroots: 'beetroot', свёкла: 'beetroot' };
// сеялки: предмет -> блок посева
const SEEDS = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots', melon_seeds: 'melon_stem', pumpkin_seeds: 'pumpkin_stem', torchflower_seeds: 'torchflower_crop', pitcher_pod: 'pitcher_crop' };
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);

// Чистая функция: созрел ли посев. props — свойства блока ({age:'7'}), meta — запасной вариант (metadata)
function isMature(cropKey, props, meta) {
  const c = CROPS[cropKey]; if (!c) return false;
  const a = props && props.age !== undefined ? Number(props.age) : Number(meta);
  return Number.isFinite(a) && a >= c.age;
}
// Чистая функция: клетки прямоугольника (x1,z1)-(x2,z2) на высоте y, не больше cap штук
function areaCells(p, y, cap = 64) {
  const x1 = Math.floor(Math.min(Number(p.x1), Number(p.x2))), x2 = Math.floor(Math.max(Number(p.x1), Number(p.x2)));
  const z1 = Math.floor(Math.min(Number(p.z1), Number(p.z2))), z2 = Math.floor(Math.max(Number(p.z1), Number(p.z2)));
  if (![x1, x2, z1, z2].every(Number.isFinite)) return null;
  const out = [];
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) { if (out.length >= cap) return out; out.push(new Vec3(x, y, z)); }
  return out;
}
const hasArea = p => ['x1', 'z1', 'x2', 'z2'].every(k => p[k] !== undefined && Number.isFinite(Number(p[k])));
// ближайший-сосед порядок обхода от точки
function orderFrom(cells, from) {
  const left = cells.slice(), out = []; let cur = from;
  while (left.length) { let bi = 0, bd = Infinity; left.forEach((c, i) => { const d = Math.abs(c.x - cur.x) + Math.abs(c.z - cur.z) + Math.abs(c.y - cur.y) * 2; if (d < bd) { bd = d; bi = i; } }); cur = left.splice(bi, 1)[0]; out.push(cur); }
  return out;
}
const withTimeout = (t, pr, ms, msg) => { let timer; return raceAbort(t, Promise.race([pr, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); })])).finally(() => clearTimeout(timer)); };
// Ждать, пока блок в pos станет таким, как нужно pred (обновление приходит с сервера не сразу); вернуть блок как есть к концу ожидания
async function waitBlock(t, bot, pos, pred, ms = 900) {
  const end = Date.now() + ms;
  for (;;) {
    const b = bot.blockAt(pos);
    if (pred(b) || Date.now() >= end) return b;
    await t.sleep(60);
  }
}

async function useOnTop(ctx, t, block) { // правый клик по верхней грани блока (мотыга/семена/костная мука)
  const bot = ctx.bot;
  await reach(ctx, t, block.position.offset(0.5, 1, 0.5), 4);
  await bot.lookAt(block.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(bot.blockAt(block.position) || block, UP);
  await t.sleep(200);
}
async function digPlain(ctx, t, b) { await A.equipToolFor(ctx.bot, b); await ctx.bot.dig(b, true); ctx.stats.blocksMined++; ctx.statsDirty = true; }

function waterNear(ctx, cells) { // есть ли у фермы вода в 4 клетках по горизонтали (на её уровне или на 1 выше)
  const bot = ctx.bot; if (!cells.length) return null;
  const w = vision.find(ctx, blockIds(bot, ['water']), { radius: 24, count: 200 });
  return cells.map(c => w.some(q => Math.abs(q.x - c.x) <= 4 && Math.abs(q.z - c.z) <= 4 && (q.y === c.y || q.y === c.y + 1)));
}

// ---------- till ----------
async function till(ctx, t, p) {
  const bot = ctx.bot;
  const hoes = bot.inventory.items().filter(i => i.name.endsWith('_hoe')).sort((a, b) => A.matRank(b.name) - A.matRank(a.name));
  if (!hoes.length) throw new SkillError('нет мотыги (*_hoe) — скрафти: 2 палки + 2 материала');
  const hoe = hoes[0];
  let cells;
  if (hasXYZ(p)) cells = [new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored()];
  else if (hasArea(p)) { const y = Number.isFinite(Number(p.y)) ? Math.floor(Number(p.y)) : Math.floor(bot.entity.position.y) - 1; cells = areaCells(p, y, num(p.max, 64, 1, 128)); }
  else throw new SkillError('нужны x,y,z или область x1,z1,x2,z2 (+y)');
  const res = { tilled: [], skipped: [] };
  for (const c of orderFrom(cells, bot.entity.position)) {
    t.check(); t.progress(`вспахано ${res.tilled.length}/${cells.length}`);
    let b = bot.blockAt(c);
    if (!b) { res.skipped.push({ at: pos3(c), why: 'чанк не загружен' }); continue; }
    if (b.name === 'farmland') { res.tilled.push(pos3(c)); continue; }
    if (!TILLABLE.has(b.name)) { res.skipped.push({ at: pos3(c), why: 'не вспахивается: ' + b.name }); continue; }
    try {
      const above = bot.blockAt(c.offset(0, 1, 0));
      if (above && above.name !== 'air' && above.name !== 'cave_air') {
        if (above.boundingBox === 'empty' && above.name !== 'water' && above.name !== 'lava') { await reach(ctx, t, c.offset(0.5, 1, 0.5), 4); await digPlain(ctx, t, above); }
        else { res.skipped.push({ at: pos3(c), why: 'сверху ' + above.name }); continue; }
      }
      for (let k = 0; k < 2; k++) {
        await bot.equip(hoe, 'hand');
        await useOnTop(ctx, t, bot.blockAt(c));
        b = await waitBlock(t, bot, c, x => x && x.name === 'farmland');
        if (b && b.name === 'farmland') break;
      }
      if (b && b.name === 'farmland') res.tilled.push(pos3(c)); else res.skipped.push({ at: pos3(c), why: 'осталось ' + (b ? b.name : '?') });
    } catch (e) { if (e.aborted) throw e; res.skipped.push({ at: pos3(c), why: e.message }); }
  }
  const wet = waterNear(ctx, res.tilled.map(a => new Vec3(a[0], a[1], a[2])));
  const dry = wet ? wet.filter(x => !x).length : null;
  const out = { hoe: hoe.name, tilled: res.tilled.length, skipped: res.skipped.slice(0, 10), skippedCount: res.skipped.length, ...(dry !== null ? { withoutWater: dry } : {}) };
  if (dry) out.note = `у ${dry} грядок нет воды в 4 клетках (на их уровне или выше) — без воды земля высохнет`;
  if (!res.tilled.length) throw new SkillError('ничего не вспахано: ' + (res.skipped[0] ? res.skipped[0].why : '?'), out);
  return out;
}

// ---------- plant ----------
async function plant(ctx, t, p) {
  const bot = ctx.bot;
  const seed = nameOf(p.seed || p.item);
  if (!SEEDS[seed]) throw new SkillError('seed: ' + Object.keys(SEEDS).join('|'));
  if (!A.invCount(bot, seed)) throw new SkillError('нет в инвентаре: ' + seed);
  const crop = SEEDS[seed];
  let farm;
  if (hasXYZ(p)) {
    let b = bot.blockAt(new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored());
    if (b && b.name !== 'farmland') { const below = bot.blockAt(b.position.offset(0, -1, 0)); if (below && below.name === 'farmland') b = below; }
    if (!b || b.name !== 'farmland') throw new SkillError('в точке нет грядки (farmland)');
    farm = [b.position];
  } else {
    const r = num(p.radius, 8, 2, 24), me = bot.entity.position.floored();
    farm = vision.find(ctx, blockIds(bot, ['farmland']), { radius: Math.min(32, r + 8), count: 300 });
    if (hasArea(p)) { const x1 = Math.min(+p.x1, +p.x2), x2 = Math.max(+p.x1, +p.x2), z1 = Math.min(+p.z1, +p.z2), z2 = Math.max(+p.z1, +p.z2); farm = farm.filter(q => q.x >= x1 && q.x <= x2 && q.z >= z1 && q.z <= z2); }
    else farm = farm.filter(q => Math.hypot(q.x - me.x, q.z - me.z) <= r);
  }
  farm = farm.filter(q => { const a = bot.blockAt(q.offset(0, 1, 0)); return a && (a.name === 'air' || a.name === 'cave_air'); });
  if (!farm.length) return { planted: 0, seed, note: 'нет свободных грядок (вспаханная земля с воздухом сверху) в области' };
  const cap = Math.min(num(p.max, 64, 1, 128), A.invCount(bot, seed)); let planted = 0; const fails = [];
  for (const q of orderFrom(farm, bot.entity.position).slice(0, cap)) {
    t.check(); t.progress(`посажено ${planted}`);
    const it = A.findItem(bot, seed); if (!it) break;
    try {
      await bot.equip(it, 'hand');
      await useOnTop(ctx, t, bot.blockAt(q));
      const a = await waitBlock(t, bot, q.offset(0, 1, 0), x => x && x.name === crop);
      if (a && a.name === crop) planted++; else fails.push(pos3(q));
    } catch (e) { if (e.aborted) throw e; fails.push(pos3(q)); }
  }
  const out = { seed, crop, planted, left: A.invCount(bot, seed), freeBeds: farm.length - planted, ...(fails.length ? { failed: fails.slice(0, 8) } : {}) };
  if (!planted) throw new SkillError('не удалось посадить ' + seed, out);
  return out;
}

// ---------- harvest ----------
async function harvest(ctx, t, p) {
  const bot = ctx.bot;
  const key = CROP_ALIAS[nameOf(p.crop || 'wheat')];
  if (!key) throw new SkillError('crop: wheat|carrot|potato|beetroot');
  const c = CROPS[key], radius = num(p.radius, 8, 2, 32), replant = p.replant !== false, cap = num(p.max, 64, 1, 200);
  const all = vision.find(ctx, blockIds(bot, [c.block]), { radius: Math.min(32, radius + 4), count: 400 })
    .filter(q => Math.hypot(q.x + 0.5 - bot.entity.position.x, q.z + 0.5 - bot.entity.position.z) <= radius);
  if (!all.length) return { crop: key, harvested: 0, note: `не вижу посевов ${c.block} в радиусе ${radius}` };
  const ripe = [], green = [];
  for (const q of all) {
    const b = bot.blockAt(q); if (!b || b.name !== c.block) continue;
    let pr = {}; try { pr = b.getProperties ? b.getProperties() : {}; } catch (e) {}
    (isMature(key, pr, b.metadata) ? ripe : green).push(q);
  }
  const before = A.invMap(bot); let harvested = 0, replanted = 0, noSeed = false; const fails = [];
  for (const q of orderFrom(ripe, bot.entity.position).slice(0, cap)) {
    t.check(); t.progress(`собрано ${harvested}/${ripe.length}`);
    try {
      await reach(ctx, t, q.offset(0.5, 0.5, 0.5), 4);
      const b = bot.blockAt(q); if (!b || b.name !== c.block) continue;
      await digPlain(ctx, t, b); harvested++;
      await A.pickupDrops(ctx, t, q.offset(0.5, 0.5, 0.5), 3, 1800);
      if (replant) {
        const floor = bot.blockAt(q.offset(0, -1, 0)), seed = A.findItem(bot, c.seed);
        if (!seed) noSeed = true;
        else if (floor && floor.name === 'farmland') { await bot.equip(seed, 'hand'); await useOnTop(ctx, t, floor); const a = await waitBlock(t, bot, q, x => x && x.name === c.block); if (a && a.name === c.block) replanted++; }
      }
    } catch (e) { if (e.aborted) throw e; fails.push({ at: pos3(q), why: e.message }); }
  }
  const gained = gainedOnly(invDiff(before, A.invMap(bot)));
  const out = { crop: key, harvested, replanted: replant ? replanted : 'выкл', gained, immature: green.length, ripeSeen: ripe.length, ...(noSeed ? { note: 'нет семян для пересадки' } : {}), ...(fails.length ? { failed: fails.slice(0, 5) } : {}) };
  if (!harvested && ripe.length) throw new SkillError('ничего не собрано: ' + (fails[0] ? fails[0].why : '?'), out);
  if (!ripe.length) out.note = `спелых нет (растут: ${green.length}) — приходи позже`;
  return out;
}

// ---------- breed / shear ----------
const BREED_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'], horse: ['golden_apple', 'golden_carrot'], donkey: ['golden_apple', 'golden_carrot'], llama: ['hay_block'], cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'],
  wolf: ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'rotten_flesh'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'], panda: ['bamboo'], bee: ['dandelion', 'poppy']
};
function foodFor(animal, named) { return named ? [nameOf(named)] : (BREED_FOOD[animal] || []); }

async function breed(ctx, t, p) {
  const bot = ctx.bot;
  const animal = nameOf(p.animal);
  if (!animal) throw new SkillError('нужен animal (cow/sheep/pig/chicken/...)');
  const foods = foodFor(animal, p.food);
  if (!foods.length) throw new SkillError(`не знаю, чем кормить ${animal} — укажи food`);
  const food = bot.inventory.items().find(i => foods.includes(i.name));
  if (!food) throw new SkillError(`нет корма для ${animal}: ${foods.join('/')}`);
  const radius = num(p.radius, 16, 3, 32), me = bot.entity.position;
  const cands = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && entName(e) === animal && e.position.distanceTo(me) <= radius)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, 8);
  if (cands.length < 2) throw new SkillError(`рядом ${cands.length} шт. ${animal} (нужно 2) в ${radius} м`, { found: cands.length });
  const known = new Set(Object.keys(bot.entities)); const fed = [], rejected = [];
  for (const e of cands) {
    if (fed.length >= 2) break;
    t.check(); t.progress(`кормлю ${fed.length}/2`);
    const cur = bot.entities[e.id]; if (!cur) continue;
    const it = A.findItem(bot, food.name); if (!it) break;
    const n0 = A.invCount(bot, food.name);
    try {
      await bot.equip(it, 'hand'); await reach(ctx, t, cur.position, 2.5);
      await bot.activateEntity(bot.entities[e.id] || cur); await t.sleep(450);
    } catch (err) { if (err.aborted) throw err; rejected.push({ id: e.id, why: err.message }); continue; }
    if (A.invCount(bot, food.name) < n0) fed.push(e.id); else rejected.push({ id: e.id, why: 'не принял корм (детёныш, уже в режиме любви или ещё откат)' });
  }
  let baby = false;
  if (fed.length === 2) {
    const end = Date.now() + num(p.wait_sec, 12, 0, 40) * 1000;
    while (Date.now() < end && !baby) { await t.sleep(500); baby = Object.values(bot.entities).some(e => e && !known.has(String(e.id)) && entName(e) === animal); }
  }
  const out = { animal, food: food.name, fed, rejected, foodLeft: A.invCount(bot, food.name), baby };
  if (fed.length < 2) throw new SkillError(`накормил ${fed.length} из 2`, out);
  if (!baby) out.note = 'оба накормлены; детёныш может появиться позже, когда они сойдутся';
  return out;
}

async function shear(ctx, t, p) {
  const bot = ctx.bot;
  const sh = A.findItem(bot, 'shears');
  if (!sh) throw new SkillError('нет ножниц (shears)');
  const animal = nameOf(p.animal || 'sheep');
  if (!['sheep', 'mooshroom'].includes(animal)) throw new SkillError('animal: sheep|mooshroom');
  const radius = num(p.radius, 12, 2, 32), me = bot.entity.position, max = num(p.max, 12, 1, 40);
  const list = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position && entName(e) === animal && e.position.distanceTo(me) <= radius)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, max);
  if (!list.length) return { sheared: 0, tried: 0, note: `рядом нет ${animal} в ${radius} м` };
  const before = A.invMap(bot); let sheared = 0, tried = 0; const fails = [];
  for (const e of list) {
    t.check(); t.progress(`стригу ${tried + 1}/${list.length}`);
    const cur = bot.entities[e.id]; if (!cur) continue;
    tried++;
    const snap = A.invMap(bot);
    try {
      await bot.equip(sh, 'hand'); await reach(ctx, t, cur.position, 2.5);
      await bot.activateEntity(bot.entities[e.id] || cur); await t.sleep(500);
      await A.pickupDrops(ctx, t, cur.position, 4, 2500);
    } catch (err) { if (err.aborted) throw err; fails.push(err.message); continue; }
    if (Object.keys(gainedOnly(invDiff(snap, A.invMap(bot)))).length) sheared++;
  }
  return { animal, sheared, tried, gained: gainedOnly(invDiff(before, A.invMap(bot))), ...(tried > sheared ? { note: `${tried - sheared} без результата: уже острижены, детёныши или дроп не подобран` } : {}), ...(fails.length ? { errors: fails.slice(0, 3) } : {}) };
}

// ---------- торговля ----------
const it2 = (i, n) => i && i.name ? { name: i.name, count: n != null ? n : i.count } : null;
function describeTrade(bot, tr, i) {
  const give = [it2(tr.inputItem1, tr.realPrice)];
  if (tr.hasItem2) give.push(it2(tr.inputItem2));
  const left = (tr.maximumNbTradeUses || 0) - (tr.nbTradeUses || 0);
  const afford = Math.min(...give.filter(Boolean).map(g => Math.floor(A.invCount(bot, g.name) / Math.max(1, g.count))));
  return { index: i, give: give.filter(Boolean), get: it2(tr.outputItem), usesLeft: left, disabled: !!tr.tradeDisabled || left <= 0, canAfford: Number.isFinite(afford) ? afford : 0 };
}
async function openTrader(ctx, t, e) {
  const bot = ctx.bot;
  await reach(ctx, t, e.position, 3);
  let w;
  try { w = await withTimeout(t, bot.openVillager(bot.entities[e.id] || e), 8000, 'не открылось окно торговли (спит/детёныш/без профессии?)'); }
  catch (err) { try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (e2) {} throw err; }
  return w;
}
function closeWin(bot, w) { try { bot.closeWindow(w); } catch (e) {} }

async function villagers(ctx, t, p) {
  const bot = ctx.bot, radius = num(p.radius, 16, 2, 48), me = bot.entity.position;
  const list = Object.values(bot.entities).filter(e => e && e.position && entName(e) === 'villager' && e.position.distanceTo(me) <= radius)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me)).slice(0, num(p.max, 6, 1, 12));
  if (!list.length) return { villagers: [], note: `жителей в ${radius} м нет` };
  const out = [];
  for (const e of list) {
    t.check(); t.progress(`смотрю жителя ${out.length + 1}/${list.length}`);
    const info = { id: e.id, at: pos3(e.position), d: r1(e.position.distanceTo(bot.entity.position)) };
    try {
      const w = await openTrader(ctx, t, e);
      info.trades = (w.trades || []).map((tr, i) => describeTrade(bot, tr, i));
      closeWin(bot, w);
    } catch (err) { if (err.aborted) throw err; info.error = err.message; }
    out.push(info);
    await t.sleep(250);
  }
  return { villagers: out };
}

async function trade(ctx, t, p) {
  const bot = ctx.bot;
  const id = p.villager !== undefined ? p.villager : p.id;
  const e = findEntity(bot, id, 48);
  if (!e || entName(e) !== 'villager') throw new SkillError('не вижу жителя id ' + id + ' (список: навык villagers)');
  const index = num(p.index, NaN), times = num(p.times, 1, 1, 64);
  if (!Number.isInteger(index) || index < 0) throw new SkillError('нужен index сделки (из villagers)');
  const before = A.invMap(bot);
  let w;
  try { w = await openTrader(ctx, t, e); } catch (err) { if (err.aborted) throw err; throw new SkillError('не открыть торговлю: ' + err.message); }
  try {
    const tr = (w.trades || [])[index];
    if (!tr) throw new SkillError(`нет сделки ${index} (всего ${(w.trades || []).length})`);
    const d = describeTrade(bot, tr, index);
    if (d.disabled) throw new SkillError('сделка закрыта (лимит исчерпан — житель пополнит позже)', d);
    if (d.canAfford < 1) throw new SkillError(`не хватает: ${d.give.map(g => g.name + '×' + g.count).join(' + ')}`, d);
    const n = Math.min(times, d.usesLeft, d.canAfford);
    await withTimeout(t, bot.trade(w, index, n), 15000, 'сервер не подтвердил сделку');
    const diff = invDiff(before, A.invMap(bot));
    const out = { traded: n, asked: times, gave: Object.fromEntries(Object.entries(diff).filter(([, c]) => c < 0).map(([k, c]) => [k, -c])), got: gainedOnly(diff) };
    if (n < times) out.note = `сделано ${n} из ${times}: ${n === d.usesLeft ? 'лимит сделки' : 'не хватило предметов'}`;
    if (!Object.keys(out.got).length) throw new SkillError('сделка не прошла: предметов не прибавилось', out);
    return out;
  } catch (err) {
    if (err instanceof SkillError || err.aborted) throw err;
    throw new SkillError('торговля не удалась: ' + err.message);
  } finally { closeWin(bot, w); }
}

module.exports = { till, plant, harvest, breed, shear, villagers, trade, isMature, areaCells, orderFrom, foodFor, CROPS, SEEDS, BREED_FOOD };
