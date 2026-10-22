// Навыки крафта и плавки: craft (с промежуточными предметами и верстаком), smelt.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { num, SkillError, isLogName, Vec3 } = require('../util');
const A = require('../actions');
const vision = require('../vision');

// ---- Честный отчёт о крафте ----
// rep собирает, что тело сделало по пути: crafted — сколько каких предметов скрафчено (включая промежуточные: палки, верстак),
// placed — какие станции поставлены и где, exp — ожидаемое изменение инвентаря по рецептам и постановкам.
// Всё, что ушло из инвентаря сверх рецептов, — «пропало» (lost): тело об этом говорит, а не молчит.
function newReport() { return { crafted: {}, placed: [], exp: new Map() }; }
function expAdd(rep, name, n) { if (rep && name && n) rep.exp.set(name, (rep.exp.get(name) || 0) + n); }

function accountCraft(before, after, rep, target) {
  const out = {};
  const spent = {};
  for (const [n, c] of before) { const d = c - (after.get(n) || 0); if (d > 0 && n !== target) spent[n] = d; }
  if (Object.keys(spent).length) out.spent = spent;
  if (rep) {
    if (Object.keys(rep.crafted).length) out.crafted = { ...rep.crafted };
    if (rep.placed.length) out.placed = rep.placed.slice();
    const lost = {};
    for (const [n, e] of rep.exp) {
      const actual = (after.get(n) || 0) - (before.get(n) || 0);
      if (actual < e) lost[n] = e - actual;
    }
    if (Object.keys(lost).length) out.lost = lost;
  }
  return out;
}
const lostText = lost => 'пропало сверх рецептов: ' + Object.entries(lost).map(([n, c]) => `${n} x${c}`).join(', ') + ' (не ушло в крафт — выброшено на землю? осмотрись и подбери)';

// Сколько предметов name ещё влезет в основной инвентарь: в неполные стопки того же предмета и в пустые слоты.
// mineflayer кладёт результат крафта именно так, а если места нет — молча выбрасывает его на землю (клик -999).
function roomFor(bot, name) {
  const inv = bot.inventory, slots = inv && inv.slots;
  if (!Array.isArray(slots) || !slots.length) return Infinity; // модель слотов неизвестна — не мешаем
  const it = bot.registry.itemsByName[name];
  const stack = (it && it.stackSize) || 64;
  const start = inv.inventoryStart != null ? inv.inventoryStart : 9, end = inv.inventoryEnd != null ? inv.inventoryEnd : 45;
  let room = 0;
  for (let i = start; i < end; i++) {
    const s = slots[i];
    if (!s) room += stack;
    else if (s.name === name) room += Math.max(0, (s.stackSize || stack) - s.count);
  }
  return room;
}

// Станция рядом, о которой тело знает: видна или запомнена зрением, либо своя из памяти мира (сама поставила) —
// и в загруженном мире она всё ещё стоит. Иначе тело делало бы новый верстак рядом со своим старым (−4 доски молча).
function knownStation(ctx, stationName, radius = 24) {
  const bot = ctx.bot;
  const id = bot.registry.blocksByName[stationName].id;
  const seen = vision.nearest(ctx, id, radius);
  if (seen) return seen;
  const wm = ctx.worldmem;
  if (!wm || typeof wm.near !== 'function' || !bot.entity) return null;
  try {
    const p = bot.entity.position;
    for (const v of wm.near([stationName], { x: p.x, y: p.y, z: p.z }, { limit: 5, own: true, maxDist: radius })) {
      const b = bot.blockAt(new Vec3(v.at[0], v.at[1], v.at[2]));
      if (b && b.name === stationName) return b;
    }
  } catch (e) {}
  return null;
}

// ---- Планировщик крафта на "виртуальном" инвентаре ----
function ingredientsOf(recipe, registry) {
  const m = new Map();
  for (const d of recipe.delta) if (d.count < 0) {
    const n = registry.items[d.id]?.name; if (!n) continue;
    m.set(n, (m.get(n) || 0) + (-d.count));
  }
  return m;
}

function plan(bot, name, need, inv, depth, stack) {
  const have = inv.get(name) || 0;
  if (have >= need) { inv.set(name, have - need); return { steps: [] }; }
  const short = need - have;
  const item = bot.registry.itemsByName[name];
  if (!item || depth > 4 || stack.includes(name)) { return { missing: { [name]: short } }; }
  let recipes = [];
  try { recipes = bot.recipesAll(item.id, null, true) || []; } catch (e) {}
  recipes = recipes.filter(r => !ingredientsOf(r, bot.registry).has(name)).slice(0, 24);
  // сначала рецепты, ингредиенты которых уже есть
  const score = r => { let s = 0; for (const [n, c] of ingredientsOf(r, bot.registry)) s += Math.min(inv.get(n) || 0, c) / c; return -s; };
  recipes.sort((a, b) => score(a) - score(b));
  let best = { missing: { [name]: short }, total: short }; // по умолчанию — просто не хватает самого предмета
  for (const r of recipes) {
    const times = Math.ceil(short / r.result.count);
    const sim = new Map(inv); sim.set(name, 0);
    const steps = []; const miss = {};
    for (const [ing, c] of ingredientsOf(r, bot.registry)) {
      const sub = plan(bot, ing, c * times, sim, depth + 1, [...stack, name]);
      if (sub.missing) Object.assign(miss, sub.missing); else steps.push(...sub.steps);
    }
    if (!Object.keys(miss).length) {
      sim.set(name, (sim.get(name) || 0) + times * r.result.count - short);
      for (const [k, v] of sim) inv.set(k, v);
      steps.push({ recipe: r, times, name });
      return { steps };
    }
    const total = Object.values(miss).reduce((s, v) => s + v, 0);
    if (total < best.total) best = { missing: miss, total };
  }
  return { missing: best.missing };
}

function describeMissing(miss) {
  const out = []; const seen = new Set();
  for (const [n, c] of Object.entries(miss)) {
    let label = n;
    if (isLogName(n) || n.endsWith('_planks')) label = 'бревна (любые *_log)';
    else if (['cobbled_deepslate', 'blackstone', 'cobblestone'].includes(n)) label = 'cobblestone';
    if (seen.has(label)) continue; seen.add(label);
    out.push(`${label} x${c}`);
  }
  return out.join(', ');
}

// ---- Верстак / печь рядом ----
async function ensureStation(ctx, t, stationName, craftIfMissing = true, rep = null) {
  const bot = ctx.bot;
  let block = knownStation(ctx, stationName, 24); // верстак/печь — только увиденные, запомненные или свои
  if (!block) {
    if (!A.invCount(bot, stationName)) {
      if (!craftIfMissing) throw new SkillError(`нет ${stationName}`);
      t.progress('делаю ' + stationName);
      await craftItem(ctx, t, stationName, 1, rep);
    }
    let spot = A.findPlaceSpot(bot, { needHead: false });
    if (!spot) spot = await A.digPlaceSpot(bot); // в тесном туннеле — выкопать нишу
    if (!spot) throw new SkillError(`некуда поставить ${stationName}`);
    t.progress('ставлю ' + stationName);
    await A.placeBlockAt(bot, spot, stationName);
    ctx.stats.blocksPlaced++; ctx.statsDirty = true;
    if (rep) { rep.placed.push({ block: stationName, at: [spot.x, spot.y, spot.z] }); expAdd(rep, stationName, -1); }
    await t.sleep(200);
    block = bot.blockAt(spot);
    if (!block || block.name !== stationName) throw new SkillError(`не удалось поставить ${stationName}`);
  }
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4) {
    await A.goto(ctx, t, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { timeout: 40000 });
  }
  return bot.blockAt(block.position);
}

// ---- Надёжный крафт: порциями, со сверкой инвентаря и возвратом предметов из сетки ----
// mineflayer крафтит оптимистично: кликает по слотам и не сверяется с сервером, поэтому при большом count
// модель окна расходится с сервером — «missing ingredient», а стопка брёвен остаётся на курсоре/в сетке крафта
// (bot.inventory.items() их не считает, и они «пропадают»). Поэтому крафтим по CRAFT_CHUNK раз, после каждой
// порции сверяем результат с инвентарём, а при сбое закрываем окна и просим у сервера полное состояние инвентаря.
const CRAFT_CHUNK = 3;

// Что-то застряло на курсоре или в сетке крафта (слоты 1..4 окна инвентаря) либо открыто чужое окно
function craftStateDirty(bot) {
  const inv = bot.inventory;
  if (!inv) return false;
  if (inv.selectedItem) return true;
  if (bot.currentWindow && bot.currentWindow !== inv) return true;
  const slots = inv.slots || [];
  for (let i = 1; i <= 4; i++) if (slots[i]) return true;
  return false;
}

// Вернуть всё из сетки крафта и с курсора: закрыть окна (сервер возвращает предметы игроку) и
// синхронизировать инвентарь с сервером. Не бросает исключений.
async function resetCraftState(ctx) {
  const bot = ctx.bot;
  try { if (bot.currentWindow && bot.currentWindow !== bot.inventory) await Promise.race([bot.closeWindow(bot.currentWindow), sleepMs(1500)]); } catch (e) {}
  try { if (typeof bot.closeWindow === 'function') await Promise.race([bot.closeWindow(bot.inventory), sleepMs(1500)]); } catch (e) {}
  try { if (typeof bot._syncWindow === 'function') await Promise.race([bot._syncWindow(bot.inventory), sleepMs(3000)]); } catch (e) {}
  await sleepMs(150);
  // если сервер не прислал состояние, а курсор всё ещё занят — вернуть в инвентарь руками
  try {
    if (bot.inventory.selectedItem && typeof bot.putSelectedItemRange === 'function') {
      await Promise.race([bot.putSelectedItemRange(bot.inventory.inventoryStart, bot.inventory.inventoryEnd, bot.inventory, null), sleepMs(2000)]);
    }
  } catch (e) {}
}
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// Выполнить рецепт times раз порциями; возвращает число выполненных крафтов
async function craftRecipe(ctx, t, recipe, times, table, label, rep = null) {
  const bot = ctx.bot;
  const resName = bot.registry.items[recipe.result.id]?.name;
  const ings = ingredientsOf(recipe, bot.registry);
  const resCount = recipe.result.count || 1;
  let left = times, done = 0, chunk = CRAFT_CHUNK, stalls = 0, lastErr = null;
  const feasible = n => { for (const [ing, c] of ings) n = Math.min(n, Math.floor(A.invCount(bot, ing) / c)); return n; };
  while (left > 0) {
    t.check();
    let n = feasible(Math.min(left, chunk));
    if (n < 1) {
      await resetCraftState(ctx); // вдруг ингредиенты застряли в сетке/на курсоре
      n = feasible(Math.min(left, chunk));
      if (n < 1) {
        const lack = [...ings].map(([i, c]) => `${i} x${c * left} (есть ${A.invCount(bot, i)})`).join(', ');
        throw new SkillError(`крафт ${label}: не хватает ингредиентов: ${lack}${lastErr ? '; ' + lastErr : ''}`, { done });
      }
    }
    // результат должен куда-то лечь: иначе mineflayer выбросит его на землю, а ингредиенты уже потрачены
    const fit = Math.floor(roomFor(bot, resName) / resCount);
    if (fit < n) {
      if (fit < 1) throw new SkillError(`крафт ${label}: инвентарь полон — ${resName} некуда положить (крафт выбросил бы его на землю, а сырьё ушло бы). Освободи слот: сложи лишнее в сундук или выброси мусор`, { done, full: true });
      n = fit;
    }
    const before = A.invCount(bot, resName);
    let err = null;
    try { await bot.craft(recipe, n, table); } catch (e) { err = e; }
    await t.sleep(80);
    let made = Math.min(n, Math.floor((A.invCount(bot, resName) - before) / resCount));
    if (err || made < n) {
      await resetCraftState(ctx);
      made = Math.min(n, Math.max(made, Math.floor((A.invCount(bot, resName) - before) / resCount)));
    }
    if (made > 0 && rep) {
      rep.crafted[resName] = (rep.crafted[resName] || 0) + made * resCount;
      for (const d of recipe.delta) expAdd(rep, bot.registry.items[d.id]?.name, d.count * made);
    }
    if (made > 0) { done += made; left -= made; stalls = 0; } else stalls++;
    if (err || made < n) {
      lastErr = err ? String(err.message || err).replace(/^Error:\s*/, '') : `сделано ${made} из ${n}`;
      chunk = 1; // после сбоя — по одному крафту за раз
      if (stalls >= 2) throw new SkillError(`крафт ${label} не удался: ${lastErr}`, { done });
    }
  }
  return done;
}

// rep (необязательно) — отчёт newReport(): что скрафчено и поставлено по пути (для честного итога craft)
async function craftItem(ctx, t, name, count, rep = null) {
  const bot = ctx.bot;
  if (!bot.registry.itemsByName[name]) throw new SkillError(`неизвестный предмет: ${name}`);
  if (craftStateDirty(bot)) await resetCraftState(ctx); // вернуть застрявшее после прошлого сбоя
  const target = A.invCount(bot, name) + count;
  let res = plan(bot, name, target, A.invMap(bot), 0, []);
  // если нужен верстак, а его нет ни рядом, ни в инвентаре — заложить его в план заранее,
  // чтобы доски на верстак не "съели" доски, нужные для самого предмета
  if (!res.missing && name !== 'crafting_table' && res.steps.some(s => s.recipe.requiresTable) &&
      !A.invCount(bot, 'crafting_table') && !knownStation(ctx, 'crafting_table', 24)) {
    const inv = A.invMap(bot);
    const tbl = plan(bot, 'crafting_table', 1, inv, 0, []);
    const main = tbl.missing ? tbl : plan(bot, name, target, inv, 0, []);
    if (tbl.missing || main.missing) {
      res = { missing: { ...(tbl.missing || {}), ...(main.missing || {}) } };
    } else {
      res = { steps: [...tbl.steps, ...main.steps] };
    }
  }
  if (res.missing) throw new SkillError(`не хватает: ${describeMissing(res.missing)}`, { missing: res.missing });
  for (const step of res.steps) {
    t.check();
    t.progress(`крафт ${step.name} x${step.times}`);
    let table = null;
    if (step.recipe.requiresTable) table = await ensureStation(ctx, t, 'crafting_table', step.name !== 'crafting_table', rep);
    await craftRecipe(ctx, t, step.recipe, step.times, table, step.name, rep);
    await t.sleep(100);
  }
  const have = A.invCount(bot, name);
  if (have < target) throw new SkillError(`крафт ${name}: сделано не всё (есть ${have}, нужно ${target})`, { have, target });
  return have;
}

// Итог craft честный: made/have — как раньше, плюс spent (что ушло из инвентаря, кроме самого предмета), crafted (всё, что
// скрафчено по пути: палки, верстак...), placed (поставленные станции с координатами) и lost (ушло сверх рецептов — если было).
async function craft(ctx, t, params) {
  const bot = ctx.bot;
  const name = String(params.item || params.name || '').replace(/^minecraft:/, '');
  const count = num(params.count, 1, 1, 256);
  const before = A.invMap(bot);
  const rep = newReport();
  let now;
  try {
    now = await craftItem(ctx, t, name, count, rep);
  } catch (e) {
    if (e && e.name === 'SkillError') {
      const acc = accountCraft(before, A.invMap(bot), rep, name);
      e.extra = { ...(e.extra || {}), ...acc };
      if (acc.lost) e.message += '; ' + lostText(acc.lost);
    }
    throw e;
  }
  const acc = accountCraft(before, A.invMap(bot), rep, name);
  const res = { item: name, made: now - (before.get(name) || 0), have: now, ...acc };
  if (acc.lost) res.warning = lostText(acc.lost);
  return res;
}

// ---- Плавка ----
const SMELT = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', iron_ore: 'iron_ingot', gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot', deepslate_iron_ore: 'iron_ingot', deepslate_gold_ore: 'gold_ingot', sand: 'glass', red_sand: 'glass',
  cobblestone: 'stone', stone: 'smooth_stone', clay_ball: 'brick', netherrack: 'nether_brick', kelp: 'dried_kelp', cactus: 'green_dye',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', cobbled_deepslate: 'deepslate', wet_sponge: 'sponge'
};
const FUEL_VALUE = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100, stick: 0.5, dried_kelp_block: 20 };
function fuelValue(n) { if (FUEL_VALUE[n]) return FUEL_VALUE[n]; if (n.endsWith('_planks') || isLogName(n)) return 1.5; return 0; }

function resolveSmeltInput(bot, item) {
  if (SMELT[item]) return item;
  if (isLogName(item) && item !== 'charcoal') return item;
  // по результату: выбрать вход, который есть в инвентаре
  const inputs = Object.keys(SMELT).filter(k => SMELT[k] === item);
  if (item === 'charcoal') inputs.push(...bot.inventory.items().filter(i => isLogName(i.name)).map(i => i.name));
  const have = inputs.find(n => A.invCount(bot, n) > 0);
  return have || inputs[0] || null;
}

async function smelt(ctx, t, params) {
  const bot = ctx.bot;
  const want = String(params.item || params.name || '');
  const input = resolveSmeltInput(bot, want);
  if (!input) throw new SkillError(`не знаю, что плавить для ${want}`);
  const haveIn = A.invCount(bot, input);
  if (!haveIn) throw new SkillError(`нет сырья: ${input}`);
  const count = Math.min(num(params.count, haveIn, 1, 64), haveIn);
  const output = isLogName(input) ? 'charcoal' : SMELT[input];
  // топливо
  let fuel = params.fuel ? String(params.fuel) : null;
  if (!fuel) {
    const cands = bot.inventory.items().filter(i => fuelValue(i.name) > 0 && i.name !== input)
      .sort((a, b) => fuelValue(b.name) - fuelValue(a.name));
    fuel = cands.length ? cands[0].name : null;
  }
  if (!fuel || !A.invCount(bot, fuel)) throw new SkillError('нет топлива (coal/charcoal/доски/бревна)');
  const fuelNeed = Math.min(A.invCount(bot, fuel), Math.ceil(count / fuelValue(fuel)));
  const before = A.invCount(bot, output);

  const block = await ensureStation(ctx, t, 'furnace');
  t.progress('загружаю печь');
  const furnace = await bot.openFurnace(block);
  const off = t.onAbort(() => { try { furnace.close(); } catch (e) {} });
  let taken = 0;
  try {
    if (furnace.outputItem()) { const o = await furnace.takeOutput(); if (o && o.name === output) taken += o.count; }
    const fuelItem = bot.registry.itemsByName[fuel];
    const inItem = bot.registry.itemsByName[input];
    if (!furnace.fuelItem() || furnace.fuelItem().name === fuel) await furnace.putFuel(fuelItem.id, null, fuelNeed);
    if (furnace.inputItem() && furnace.inputItem().name !== input) throw new SkillError('в печи чужое сырьё: ' + furnace.inputItem().name);
    await furnace.putInput(inItem.id, null, count);
    const deadline = Date.now() + count * 11000 + 15000;
    while (taken < count && Date.now() < deadline) {
      await t.sleep(1000);
      const o = furnace.outputItem();
      if (o && (o.count >= Math.min(8, count - taken) || !furnace.inputItem())) {
        const got = await furnace.takeOutput(); if (got) taken += got.count;
      }
      t.progress(`плавлю ${input}: ${taken}/${count}`);
      if (!furnace.inputItem() && !furnace.outputItem()) break;
      if (!furnace.fuelItem() && furnace.fuel === 0 && furnace.inputItem()) throw new SkillError('кончилось топливо', { taken });
    }
    if (furnace.outputItem()) { const got = await furnace.takeOutput(); if (got) taken += got.count; }
  } finally {
    off(); try { furnace.close(); } catch (e) {}
  }
  const made = A.invCount(bot, output) - before;
  if (made <= 0) throw new SkillError('ничего не выплавилось', { output });
  return { output, made, have: A.invCount(bot, output) };
}

module.exports = { craft, craftItem, smelt, ensureStation, plan, craftRecipe, resetCraftState, craftStateDirty, knownStation, roomFor, accountCraft, newReport };
