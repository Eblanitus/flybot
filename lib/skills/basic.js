// Универсальные навыки-«умения»: еда, экипировка, выбросить, смотреть, использовать, двери, столб, мост, подбор,
// факелы, метки, лук/щит, рыбалка, вёдра. Решений «когда» тут нет: каждый навык делает одно и честно сообщает итог.
'use strict';
const fs = require('fs');
const path = require('path');
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, r1, SkillError, Aborted, entName, dirName, sleep } = require('../util');
const A = require('../actions');
const vision = require('../vision');
const aggr = require('../aggressors');

const nameOf = v => String(v == null ? '' : v).toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_');
const pos3 = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
const hasXYZ = p => ['x', 'y', 'z'].every(k => p[k] !== undefined && p[k] !== null && p[k] !== '' && Number.isFinite(Number(p[k])));
const itemId = (bot, n) => bot.registry.itemsByName[n] && bot.registry.itemsByName[n].id;
const blockIds = (bot, names) => names.map(n => bot.registry.blocksByName[n]?.id).filter(x => x != null);

// Разница двух invMap: {имя: ±n}
function invDiff(a, b) {
  const d = {};
  for (const [n, c] of b) { const x = c - (a.get(n) || 0); if (x) d[n] = x; }
  for (const [n, c] of a) if (!b.has(n)) d[n] = -c;
  return d;
}
function gainedOnly(d) { const g = {}; for (const [n, c] of Object.entries(d)) if (c > 0) g[n] = c; return g; }

// Сущность по id (число) или имени (ближайшая; игрок — по нику). maxD — предел дальности.
function findEntity(bot, ref, maxD = 48) {
  if (ref === undefined || ref === null || ref === '') return null;
  const me = bot.entity.position;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) { const e = bot.entities[Number(ref)]; return e && e !== bot.entity && e.position && e.position.distanceTo(me) <= maxD ? e : null; }
  const n = nameOf(ref); let best = null, bd = maxD;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || e.name === 'item') continue;
    if (entName(e) !== n && nameOf(e.username) !== n) continue;
    const d = e.position.distanceTo(me); if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// Подойти на расстояние ≤ r до точки (центр), без лишних движений, если уже рядом
async function reach(ctx, t, p, r = 3, timeout = 40000) {
  const bot = ctx.bot;
  if (bot.entity.position.distanceTo(p) <= r) return;
  await A.goto(ctx, t, new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), Math.max(1, Math.floor(r) - 1)), { timeout });
}
// Подойти к точке, но не вставать в неё (для установки блока/факела)
function standOff(pos, near = 3.5, far = 1.5) {
  return new goals.GoalCompositeAll([new goals.GoalNear(pos.x, pos.y, pos.z, near), new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, far))]);
}

// Дождаться промиса, но прерваться сразу по stop (иначе зависший вызов mineflayer держит тело)
function raceAbort(t, pr) {
  let off;
  return Promise.race([pr, new Promise((_, rej) => { off = t.onAbort(r => rej(new Aborted(r))); })]).finally(() => { if (off) off(); });
}

// Встать в центр клетки (cx,cz — центр)
async function center(bot, t, cx, cz) {
  try {
    for (let i = 0; i < 12; i++) {
      t.check();
      const dx = cx - bot.entity.position.x, dz = cz - bot.entity.position.z;
      if (Math.hypot(dx, dz) < 0.2) break;
      await bot.look(Math.atan2(-dx, -dz), 0, true);
      bot.setControlState('forward', true); await t.sleep(i < 4 ? 80 : 40); bot.setControlState('forward', false); await t.sleep(60);
    }
  } finally { bot.setControlState('forward', false); }
}

// ---------- еда ----------
const BAD_FOOD = new Set(['poisonous_potato', 'pufferfish', 'spider_eye', 'suspicious_stew', 'chorus_fruit', 'enchanted_golden_apple', 'golden_apple', 'rotten_flesh', 'chicken']);
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit']);
// Чистая функция: какую еду съесть. items — предметы инвентаря, foods — registry.foodsByName
function pickFood(items, foods, food, { name, desperate } = {}) {
  const missing = 20 - food;
  let c = items.filter(i => foods[i.name] && !i.name.endsWith('_bucket'));
  if (name) c = c.filter(i => i.name === name);
  else c = c.filter(i => !BAD_FOOD.has(i.name) || (desperate && (i.name === 'rotten_flesh' || i.name === 'chicken')));
  const wasted = i => Math.max(0, (foods[i.name].foodPoints || 0) - missing);
  c.sort((a, b) => wasted(a) - wasted(b) || (foods[b.name].effectiveQuality || 0) - (foods[a.name].effectiveQuality || 0));
  return c[0] || null;
}

async function eat(ctx, t, p) {
  const bot = ctx.bot; const foods = bot.registry.foodsByName;
  const want = p.item || p.name ? nameOf(p.item || p.name) : null;
  const times = num(p.count, 1, 1, 20);
  const f0 = bot.food, ate = [];
  for (let k = 0; k < times; k++) {
    t.check();
    if (bot.food >= 20 && !(want && ALWAYS_EDIBLE.has(want))) {
      if (k === 0) throw new SkillError(`сыт: еда ${bot.food}/20 — есть нельзя`, { food: bot.food, saturation: bot.foodSaturation });
      break;
    }
    const item = pickFood(bot.inventory.items(), foods, bot.food, { name: want, desperate: p.desperate === true || bot.food <= 6 });
    if (!item) {
      if (k > 0) break;
      const have = bot.inventory.items().filter(i => foods[i.name]).map(i => `${i.name}×${i.count}`);
      throw new SkillError(want ? `нет в инвентаре или не еда: ${want}` : 'нет подходящей еды' + (have.length ? ` (есть сомнительное: ${have.join(', ')} — укажи item)` : ''), { food: bot.food, have });
    }
    t.progress('ем ' + item.name);
    const before = bot.food;
    try { await bot.equip(item, 'hand'); await raceAbort(t, bot.consume()); }
    catch (e) { t.check(); if (e.aborted) throw e; throw new SkillError(`не удалось съесть ${item.name}: ${e.message}`, { ate, food: bot.food }); }
    await t.sleep(150);
    ate.push(item.name);
    if (bot.food <= before && !ALWAYS_EDIBLE.has(item.name)) break; // еда не прибавилась — зависло, не крутимся
  }
  return { ate, food: [f0, bot.food], saturation: r1(bot.foodSaturation || 0), full: bot.food >= 20 };
}

// ---------- экипировка / выбросить ----------
const SLOTS = { hand: 'hand', 'off-hand': 'off-hand', offhand: 'off-hand', off_hand: 'off-hand', head: 'head', torso: 'torso', chest: 'torso', legs: 'legs', feet: 'feet' };
function normSlot(s) { return SLOTS[nameOf(s)] || null; }
const SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };

async function equip(ctx, t, p) {
  const bot = ctx.bot;
  let dest = p.slot !== undefined && !/^\d+$/.test(String(p.slot)) ? normSlot(p.slot) : (p.dest ? normSlot(p.dest) : 'hand');
  if (!dest) throw new SkillError('slot: hand|off-hand|head|torso|legs|feet');
  const explicit = (p.slot !== undefined && !/^\d+$/.test(String(p.slot))) || !!p.dest;
  let item = null;
  if (p.slot !== undefined && /^\d+$/.test(String(p.slot))) item = bot.inventory.slots[Number(p.slot)]; // старый формат: номер слота инвентаря
  else { const n = nameOf(p.item || p.name); if (!n) throw new SkillError('нужен item'); item = A.findItem(bot, n); if (!item) throw new SkillError('нет в инвентаре: ' + n); }
  if (!item) throw new SkillError('в слоте пусто');
  const slotOf = A.armorSlotOf(item.name);
  if (slotOf && !explicit) dest = slotOf; // броня без явного слота — на своё место
  if (slotOf && dest !== slotOf && ['head', 'torso', 'legs', 'feet'].includes(dest)) throw new SkillError(`${item.name} надевается на ${slotOf}, а не на ${dest}`);
  const was = dest === 'hand' ? (bot.heldItem && bot.heldItem.name) : (bot.inventory.slots[SLOT_INDEX[dest]] || {}).name || null;
  try { await bot.equip(item, dest); } catch (e) { throw new SkillError(`не удалось экипировать ${item.name} в ${dest}: ${e.message}`); }
  return { equipped: item.name, slot: dest, replaced: was || null };
}

// Мусор по умолчанию: имя -> сколько оставить
const JUNK_DEFAULT = {
  rotten_flesh: 0, spider_eye: 0, poisonous_potato: 0, gravel: 0,
  dirt: 32, coarse_dirt: 32, netherrack: 32, andesite: 32, diorite: 32, granite: 32, tuff: 32, calcite: 32, cobbled_deepslate: 64
};
// Чистая функция: что выбросить. inv: Map имя->кол-во, keep: {имя:n} или [имена, которые не трогать]
function pickJunk(inv, keep, table = JUNK_DEFAULT) {
  const k = Array.isArray(keep) ? Object.fromEntries(keep.map(n => [nameOf(n), Infinity])) : Object.fromEntries(Object.entries(keep || {}).map(([n, v]) => [nameOf(n), Number(v)]));
  const out = [];
  for (const [n, c] of inv) {
    if (!(n in table)) continue;
    const left = n in k ? k[n] : table[n];
    const drop = c - Math.max(0, left);
    if (drop > 0) out.push({ name: n, count: drop });
  }
  return out;
}

async function tossStack(ctx, t, name, count) {
  const bot = ctx.bot; const id = itemId(bot, name);
  if (id == null) throw new SkillError('неизвестный предмет: ' + name);
  const have = A.invCount(bot, name);
  const n = Math.min(count, have);
  if (n <= 0) return 0;
  try { await bot.toss(id, null, n); } catch (e) { throw new SkillError(`не удалось выбросить ${name}: ${e.message}`); }
  await t.sleep(120);
  return n;
}

async function toss(ctx, t, p) {
  const bot = ctx.bot;
  const name = nameOf(p.item || p.name);
  if (!name) throw new SkillError('нужен item (мусор пачкой — навык drop_junk)');
  const have = A.invCount(bot, name);
  if (!have) throw new SkillError('нет в инвентаре: ' + name);
  const want = p.all === true ? have : num(p.count, 1, 1, 2304);
  const n = await tossStack(ctx, t, name, want);
  return { dropped: { [name]: n }, left: A.invCount(bot, name), hint: 'выброшенное подберёшь обратно через ~2 с, если останешься рядом' };
}

async function dropJunk(ctx, t, p) {
  const bot = ctx.bot;
  const inv = A.invMap(bot);
  const plan = pickJunk(inv, p.keep);
  const dropped = {};
  for (const j of plan) { t.check(); t.progress('выбрасываю ' + j.name); dropped[j.name] = await tossStack(ctx, t, j.name, j.count); }
  return { dropped, nothing: !plan.length, junkList: JUNK_DEFAULT, hint: plan.length ? 'выброшенное лежит рядом; отойди, иначе подберёшь снова' : 'мусора сверх нормы нет' };
}

// ---------- смотреть / использовать / активировать ----------
async function lookAt(ctx, t, p) {
  const bot = ctx.bot;
  if (p.entity !== undefined) {
    const e = findEntity(bot, p.entity);
    if (!e) throw new SkillError('не вижу существо: ' + p.entity);
    await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.85, 0), true);
    return { looking: entName(e), id: e.id, d: r1(bot.entity.position.distanceTo(e.position)), dir: dirName(bot.entity.position, e.position) };
  }
  if (!hasXYZ(p)) throw new SkillError('нужны x,y,z или entity');
  const at = new Vec3(Number(p.x), Number(p.y), Number(p.z));
  await bot.lookAt(at.offset(p.exact ? 0 : 0.5, p.exact ? 0 : 0.5, p.exact ? 0 : 0.5), true);
  const b = bot.blockAt(at.floored());
  return { looking: b ? b.name : null, at: pos3(at), d: r1(bot.entity.position.distanceTo(at)) };
}

const FACE_VEC = { up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) };

async function useItem(ctx, t, p) {
  const bot = ctx.bot;
  if (p.item || p.name) {
    const it = A.findItem(bot, nameOf(p.item || p.name));
    if (!it) throw new SkillError('нет в инвентаре: ' + nameOf(p.item || p.name));
    try { await bot.equip(it, 'hand'); } catch (e) { throw new SkillError('не взять в руку: ' + e.message); }
  }
  if (!bot.heldItem) throw new SkillError('в руке пусто — укажи item');
  const held = bot.heldItem.name, before = A.invMap(bot);
  let target = 'воздух';
  if (p.entity !== undefined) {
    const e = findEntity(bot, p.entity, 24);
    if (!e) throw new SkillError('не вижу существо: ' + p.entity);
    await reach(ctx, t, e.position, 3);
    await bot.activateEntity(findEntity(bot, e.id, 24) || e);
    target = `${entName(e)}#${e.id}`;
  } else if (hasXYZ(p)) {
    const bp = new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored();
    await reach(ctx, t, bp.offset(0.5, 0.5, 0.5), 4);
    const b = bot.blockAt(bp);
    if (!b) throw new SkillError('блок не загружен');
    const face = FACE_VEC[nameOf(p.face)] || FACE_VEC.up;
    await bot.lookAt(bp.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
    if (p.sneak) bot.setControlState('sneak', true);
    try { await bot.activateBlock(b, face); } finally { if (p.sneak) bot.setControlState('sneak', false); }
    target = `${b.name}@${bp.x},${bp.y},${bp.z}`;
  } else {
    bot.activateItem();
    const hold = num(p.hold_ms, 0, 0, 30000);
    if (hold) { try { await t.sleep(hold); } finally { try { bot.deactivateItem(); } catch (e) {} } }
  }
  await t.sleep(350);
  const changed = invDiff(before, A.invMap(bot));
  return { used: held, target, inventoryChange: changed, heldNow: bot.heldItem ? bot.heldItem.name : null, ...(Object.keys(changed).length ? {} : { note: 'инвентарь не изменился — эффект мог быть без предмета (или действие не сработало)' }) };
}

const props = b => { try { return b && b.getProperties ? b.getProperties() : {}; } catch (e) { return {}; } };
function blockState(b) {
  const pr = props(b);
  if ('open' in pr) return String(pr.open) === 'true' ? 'open' : 'closed';
  if ('powered' in pr) return String(pr.powered) === 'true' ? 'on' : 'off';
  return null;
}
async function activate(ctx, t, p) {
  const bot = ctx.bot;
  if (!hasXYZ(p)) throw new SkillError('нужны x,y,z');
  const bp = new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored();
  let b = bot.blockAt(bp);
  if (!b || A.isAirLike(b)) throw new SkillError('в точке нет блока');
  const before = blockState(b);
  const want = p.want ? nameOf(p.want) : null; // open|closed|on|off
  const norm = { close: 'closed', closed: 'closed', open: 'open', on: 'on', off: 'off' }[want];
  if (want && !norm) throw new SkillError('want: open|close|on|off');
  if (norm && before === norm) return { block: b.name, state: before, changed: false, note: 'уже в нужном состоянии' };
  await reach(ctx, t, bp.offset(0.5, 0.5, 0.5), 4);
  await bot.lookAt(bp.offset(0.5, 0.5, 0.5), true);
  try { await bot.activateBlock(bot.blockAt(bp)); } catch (e) { throw new SkillError('не получилось: ' + e.message); }
  await t.sleep(250);
  b = bot.blockAt(bp);
  const after = blockState(b);
  return { block: b ? b.name : null, at: pos3(bp), before, after, changed: before === null ? null : before !== after,
    ...(before !== null && before === after ? { note: 'состояние не поменялось: железная дверь/закрыто на сигнал/кнопка уже нажата' } : {}) };
}

// ---------- столб / мост ----------
const PLACE_ORDER = ['dirt', 'coarse_dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'blackstone', 'end_stone'];
// Чистая функция: чем ставить (мусор первым, булыжник последним; доски/брёвна/сыпучие — никогда)
function pickPlaceable(items, only) {
  if (only) return items.find(i => i.name === only && i.count > 0) || null;
  for (const n of PLACE_ORDER) { const it = items.find(i => i.name === n && i.count > 0); if (it) return it; }
  return null;
}

async function pillarUp(ctx, t, p) {
  const bot = ctx.bot;
  const height = num(p.height, 3, 1, 32);
  const only = p.item ? nameOf(p.item) : null;
  const start = bot.entity.position.floored();
  if (!pickPlaceable(bot.inventory.items(), only)) throw new SkillError('нечем ставить: нужны земля/булыжник/камень' + (only ? ` (${only})` : ''));
  await center(bot, t, start.x + 0.5, start.z + 0.5);
  const used = {}; let raised = 0, fails = 0, stopped = null;
  try {
    while (raised < height) {
      t.check();
      const feet = bot.entity.position.floored();
      if (A.isSolid(bot.blockAt(feet.offset(0, 2, 0))) || A.isSolid(bot.blockAt(feet.offset(0, 3, 0)))) { stopped = 'потолок над головой'; break; }
      const ref = bot.blockAt(feet.offset(0, -1, 0));
      if (!A.isSolid(ref)) { stopped = 'не на чем стоять'; break; }
      const item = pickPlaceable(bot.inventory.items(), only);
      if (!item) { stopped = 'кончились блоки'; break; }
      t.progress(`столб ${raised}/${height}`);
      await bot.equip(item, 'hand');
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.setControlState('jump', true);
      const t0 = Date.now();
      while (Date.now() - t0 < 900 && bot.entity.position.y < feet.y + 1.0) { await sleep(25); t.check(); }
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); } catch (e) { await sleep(80); }
      bot.setControlState('jump', false);
      const t1 = Date.now();
      while (Date.now() - t1 < 900 && !(bot.entity.onGround && bot.entity.position.y >= feet.y + 0.99)) { await sleep(30); t.check(); }
      if (bot.entity.position.floored().y === feet.y + 1 && A.isSolid(bot.blockAt(feet))) { raised++; fails = 0; used[item.name] = (used[item.name] || 0) + 1; ctx.stats.blocksPlaced++; ctx.statsDirty = true; }
      else if (++fails >= 3) { stopped = 'блок не ставится (3 неудачи подряд)'; break; }
      else await sleep(150);
    }
  } finally { bot.setControlState('jump', false); }
  const res = { raised, wanted: height, used, y: Math.floor(bot.entity.position.y), at: pos3(bot.entity.position), ...(stopped ? { stopped } : {}) };
  if (stopped && !raised) throw new SkillError('столб не вышел: ' + stopped, res);
  return res;
}

// направление из dir (С/Ю/В/З, north…) или цели x,z (по большей оси)
const CARD = { n: [0, -1], north: [0, -1], 'с': [0, -1], s: [0, 1], south: [0, 1], 'ю': [0, 1], e: [1, 0], east: [1, 0], 'в': [1, 0], w: [-1, 0], west: [-1, 0], 'з': [-1, 0] };
function parseDir(p, pos) {
  if (p.dir) { const v = CARD[nameOf(p.dir)]; if (!v) throw new SkillError('dir: С|Ю|В|З (north/south/east/west)'); return { dx: v[0], dz: v[1], stopAt: null }; }
  if (p.x !== undefined && p.z !== undefined && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) {
    const tx = Math.floor(Number(p.x)), tz = Math.floor(Number(p.z)), ddx = tx - Math.floor(pos.x), ddz = tz - Math.floor(pos.z);
    if (!ddx && !ddz) throw new SkillError('уже в этой точке');
    if (Math.abs(ddx) >= Math.abs(ddz)) return { dx: Math.sign(ddx), dz: 0, stopAt: tx };
    return { dx: 0, dz: Math.sign(ddz), stopAt: tz };
  }
  throw new SkillError('нужен dir (С|Ю|В|З) или x,z');
}

async function bridge(ctx, t, p) {
  const bot = ctx.bot;
  const { dx, dz, stopAt } = parseDir(p, bot.entity.position);
  const max = num(p.max, 10, 1, 64), only = p.item ? nameOf(p.item) : null;
  const yaw = Math.atan2(-dx, -dz);
  let placed = 0, moved = 0, stopped = null; const startY = Math.floor(bot.entity.position.y);
  const start = bot.entity.position.floored();
  await center(bot, t, start.x + 0.5, start.z + 0.5);
  bot.setControlState('sneak', true);
  try {
    for (let step = 0; step < max; step++) {
      t.check();
      const cx = Math.floor(bot.entity.position.x), cz = Math.floor(bot.entity.position.z), fy = Math.floor(bot.entity.position.y);
      if (fy < startY - 1) { stopped = 'упал вниз'; break; }
      if (stopAt !== null && (dx ? cx : cz) === stopAt) { stopped = 'дошёл до цели'; break; }
      const nx = cx + dx, nz = cz + dz;
      const feetB = bot.blockAt(new Vec3(nx, fy, nz)), headB = bot.blockAt(new Vec3(nx, fy + 1, nz)), floorB = bot.blockAt(new Vec3(nx, fy - 1, nz));
      if (A.isSolid(feetB) || A.isSolid(headB)) { stopped = 'преграда: ' + (A.isSolid(feetB) ? feetB : headB).name; break; }
      if ([feetB, headB, floorB].some(b => b && b.name === 'lava')) { stopped = 'впереди лава'; break; }
      if (!A.isSolid(floorB)) {
        const ref = bot.blockAt(new Vec3(cx, fy - 1, cz));
        if (!A.isSolid(ref)) { stopped = 'нет опоры под ногами'; break; }
        const item = pickPlaceable(bot.inventory.items(), only);
        if (!item) { stopped = 'кончились блоки'; break; }
        t.progress(`мост: поставлено ${placed}, пройдено ${moved}`);
        await bot.equip(item, 'hand');
        await bot.lookAt(ref.position.offset(0.5 + dx * 0.5, 0.5, 0.5 + dz * 0.5), true);
        try { await bot.placeBlock(ref, new Vec3(dx, 0, dz)); } catch (e) { await sleep(120); }
        const nb = bot.blockAt(new Vec3(nx, fy - 1, nz));
        if (!A.isSolid(nb)) { stopped = 'блок не встал'; break; }
        placed++; ctx.stats.blocksPlaced++; ctx.statsDirty = true;
      }
      // шаг вперёд: до центра следующей клетки
      await bot.look(yaw, 0, true);
      bot.setControlState('forward', true);
      const t0 = Date.now(); const ccx = nx + 0.5, ccz = nz + 0.5;
      while (Date.now() - t0 < 1800) {
        await sleep(30); t.check();
        const q = bot.entity.position;
        if ((dx ? Math.abs(q.x - ccx) : Math.abs(q.z - ccz)) < 0.3) break;
      }
      bot.setControlState('forward', false);
      await t.sleep(80);
      if (Math.floor(bot.entity.position.x) === cx && Math.floor(bot.entity.position.z) === cz) { stopped = 'не удалось шагнуть вперёд'; break; }
      moved++;
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('sneak', false); }
  if (!stopped) stopped = 'прошёл заданное число клеток';
  const res = { placed, moved, stopped, at: pos3(bot.entity.position), dir: dirName(new Vec3(0, 0, 0), new Vec3(dx, 0, dz)), blocksLeft: bot.inventory.items().filter(i => pickPlaceable([i], null)).reduce((s, i) => s + i.count, 0) };
  if (!moved && !placed) throw new SkillError('мост не вышел: ' + stopped, res);
  return res;
}

// ---------- подбор ----------
async function pickup(ctx, t, p) {
  const bot = ctx.bot;
  const radius = num(p.radius, 8, 1, 16);
  const near = () => Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) <= radius);
  const n0 = near().length;
  if (!n0) return { picked: {}, itemsSeen: 0, left: 0, note: 'в радиусе нет предметов' };
  const before = A.invMap(bot);
  t.progress(`подбираю (${n0})`);
  await A.pickupDrops(ctx, t, bot.entity.position.clone(), radius, num(p.max_sec, 15, 3, 60) * 1000);
  const picked = gainedOnly(invDiff(before, A.invMap(bot)));
  const left = near().length;
  return { picked, itemsSeen: n0, left, ...(left && !Object.keys(picked).length ? { note: 'не подобрал: инвентарь полон или предметы недосягаемы' } : {}) };
}

// ---------- факелы ----------
const TORCHES = ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern', 'redstone_torch', 'copper_torch'];
function lightAt(bot, pos) {
  const b = bot.blockAt(pos);
  if (!b) return null;
  return { l: typeof b.light === 'number' ? b.light : null, s: typeof b.skyLight === 'number' ? b.skyLight : null };
}
// Чистая функция: тёмная ли клетка. level — порог света блоков; sky=true — считать и клетки под открытым небом.
function isDark(lt, level, sky) {
  if (!lt || lt.l === null) return null;
  if (lt.l >= level) return false;
  if (!sky && lt.s !== null && lt.s >= level) return false;
  return true;
}
// Чистая функция: выбрать места для факелов не ближе every друг к другу и к уже стоящим
function pickTorchSpots(cands, existing, every, max) {
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= max) break;
    const d = q => Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z);
    if (existing.some(q => d(q) < every) || chosen.some(q => d(q) < every)) continue;
    chosen.push(c);
  }
  return chosen;
}

async function light(ctx, t, p) {
  const bot = ctx.bot;
  const radius = num(p.radius, 8, 2, 16), every = num(p.every, 6, 2, 16), level = num(p.level, 8, 1, 15), max = num(p.max, 8, 1, 32), sky = p.sky === true;
  const have0 = A.invCount(bot, 'torch');
  if (!have0) throw new SkillError('нет факелов (torch) — скрафти: палка + уголь');
  const placed = [];
  const tryPlace = async (spot) => {
    await A.goto(ctx, t, standOff(spot), { timeout: 30000 });
    await A.placeBlockAt(bot, spot, 'torch');
    ctx.stats.blocksPlaced++; ctx.statsDirty = true;
    placed.push([spot.x, spot.y, spot.z]);
    await t.sleep(200);
  };
  if (p.x !== undefined && p.z !== undefined && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z))) {
    // вдоль пути: идём к (x,z) отрезками по every клеток, в тёмном месте ставим факел рядом
    const from = bot.entity.position.clone(), tx = Number(p.x), tz = Number(p.z);
    const dist = Math.hypot(tx - from.x, tz - from.z), steps = Math.min(40, Math.ceil(dist / every));
    let unknown = false, reached = false, err = null;
    try {
      for (let i = 1; i <= steps && placed.length < max && A.invCount(bot, 'torch'); i++) {
        t.check(); t.progress(`путь ${i}/${steps}, факелов поставлено ${placed.length}`);
        const f = i / steps;
        await A.goto(ctx, t, new goals.GoalNearXZ(from.x + (tx - from.x) * f, from.z + (tz - from.z) * f, 2), { timeout: 60000 });
        const here = bot.entity.position.floored();
        const dk = isDark(lightAt(bot, here), level, sky);
        if (dk === null) { unknown = true; continue; }
        if (!dk) continue;
        const near = bot.findBlocks ? bot.findBlocks({ matching: blockIds(bot, TORCHES), maxDistance: every - 1, count: 1 }) : [];
        if (near.length) continue;
        const spot = A.findPlaceSpot(bot);
        if (spot) { try { await A.placeBlockAt(bot, spot, 'torch'); placed.push([spot.x, spot.y, spot.z]); ctx.stats.blocksPlaced++; ctx.statsDirty = true; } catch (e) { if (e.aborted) throw e; } }
      }
      reached = Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z) <= 4;
    } catch (e) { if (e.aborted) throw e; err = e.message; }
    return { mode: 'путь', placed, torchesLeft: A.invCount(bot, 'torch'), reached, ...(unknown ? { note: 'свет части чанков неизвестен' } : {}), ...(err ? { stopped: err } : {}) };
  }
  // вокруг: тёмные клетки пола в радиусе, видимые мне
  const base = bot.entity.position.floored(), cands = []; let known = 0, unknown = 0; const existing = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (dx * dx + dz * dz > radius * radius) continue;
    for (let dy = -3; dy <= 3; dy++) {
      const c = base.offset(dx, dy, dz), b = bot.blockAt(c);
      if (!b) continue;
      if (TORCHES.includes(b.name)) { existing.push(c); continue; }
      if (!A.isAirLike(b) || !A.isSolid(bot.blockAt(c.offset(0, -1, 0))) || !A.isAirLike(bot.blockAt(c.offset(0, 1, 0)))) continue;
      const dk = isDark(lightAt(bot, c), level, sky);
      if (dk === null) { unknown++; continue; }
      known++;
      if (dk) cands.push(c);
    }
  }
  if (!known && unknown) throw new SkillError('сервер не прислал освещение чанков (block.light) — не вижу, где темно', { unknown });
  const vis = cands.filter(c => vision.isVisible(ctx, c.offset(0, -1, 0))).sort((a, b) => a.distanceTo(base) - b.distanceTo(base));
  const spots = pickTorchSpots(vis, existing, every, Math.min(max, have0));
  let err = null;
  for (const s of spots) {
    t.check(); t.progress(`факел ${placed.length + 1}/${spots.length}`);
    try { await tryPlace(s); } catch (e) { if (e.aborted) throw e; err = e.message; }
  }
  return { mode: 'вокруг', darkSpots: cands.length, placed, torchesLeft: A.invCount(bot, 'torch'), ...(err ? { lastError: err } : {}), ...(!cands.length ? { note: 'тёмных мест в радиусе нет' } : {}) };
}

// ---------- метки ----------
function wpFile(ctx) { return path.join(ctx.dataDir || path.join(__dirname, '..', '..', 'data'), 'waypoints.json'); }
function loadWp(file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
function saveWp(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, file); }
const wpName = v => (nameOf(v) || 'home').slice(0, 32);
const dimOf = bot => String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '');

async function mark(ctx, t, p) {
  const bot = ctx.bot, file = wpFile(ctx), name = wpName(p.name), all = loadWp(file);
  const q = hasXYZ(p) ? { x: Math.floor(Number(p.x)), y: Math.floor(Number(p.y)), z: Math.floor(Number(p.z)) } : { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };
  const replaced = all[name] || null;
  all[name] = { ...q, dim: dimOf(bot), t: Date.now(), ...(p.note ? { note: String(p.note).slice(0, 100) } : {}) };
  saveWp(file, all);
  return { marked: name, at: [q.x, q.y, q.z], dim: all[name].dim, ...(replaced ? { replaced: [replaced.x, replaced.y, replaced.z] } : {}), total: Object.keys(all).length };
}

async function goHome(ctx, t, p) {
  const bot = ctx.bot, name = wpName(p.name), all = loadWp(wpFile(ctx)), w = all[name];
  if (!w) throw new SkillError(`нет метки «${name}»`, { have: Object.keys(all) });
  if (w.dim !== dimOf(bot)) throw new SkillError(`метка «${name}» в измерении ${w.dim}, я в ${dimOf(bot)}`);
  const target = new Vec3(w.x + 0.5, w.y, w.z + 0.5), d0 = bot.entity.position.distanceTo(target);
  t.progress(`иду к «${name}» (${Math.round(d0)} м)`);
  let err = null;
  try { await A.goto(ctx, t, new goals.GoalNear(w.x, w.y, w.z, num(p.near, 2, 1, 10)), { timeout: num(p.timeout, 120, 5, 600) * 1000, sprint: p.sprint !== false }); }
  catch (e) { if (e.aborted) throw e; err = e.message; }
  const d1 = bot.entity.position.distanceTo(target);
  const res = { name, at: [w.x, w.y, w.z], distBefore: Math.round(d0), distNow: Math.round(d1), arrived: d1 <= num(p.near, 2, 1, 10) + 2 };
  if (err && !res.arrived) throw new SkillError(`не дошёл до «${name}»: ${err} (осталось ${res.distNow} м)`, res);
  return res;
}

async function waypoints(ctx, t, p) {
  const bot = ctx.bot, file = wpFile(ctx), all = loadWp(file);
  if (p.remove) { const n = wpName(p.remove); const had = n in all; delete all[n]; saveWp(file, all); return { removed: had ? n : null, total: Object.keys(all).length }; }
  const me = bot.entity.position, dim = dimOf(bot);
  const list = Object.entries(all).map(([name, w]) => {
    const same = w.dim === dim, q = new Vec3(w.x + 0.5, w.y, w.z + 0.5);
    return { name, at: [w.x, w.y, w.z], dim: w.dim, ...(same ? { d: Math.round(me.distanceTo(q)), dir: dirName(me, q) } : { d: null, note: 'другое измерение' }), ...(w.note ? { note: w.note } : {}) };
  }).sort((a, b) => (a.d == null) - (b.d == null) || a.d - b.d);
  return { dim, waypoints: list };
}

// ---------- лук / щит ----------
const ARROWS = ['arrow', 'spectral_arrow', 'tipped_arrow'];
// Чистая функция: угол вверх (рад), чтобы стрела со скоростью speed (бл/тик) попала на horiz по горизонтали и dy по высоте
function aimPitch(horiz, dy, speed = 3) {
  let best = null, bestErr = Infinity;
  for (let th = -0.6; th <= 1.2; th += 0.004) {
    let x = 0, y = 0, vx = speed * Math.cos(th), vy = speed * Math.sin(th);
    for (let k = 0; k < 400; k++) {
      const nx = x + vx, ny = y + vy;
      if (nx >= horiz) { const f = (horiz - x) / (nx - x || 1); const yy = y + (ny - y) * f; const err = Math.abs(yy - dy); if (err < bestErr) { bestErr = err; best = th; } break; }
      x = nx; y = ny; vx *= 0.99; vy = (vy) * 0.99 - 0.05;
      if (y < dy - 80) break;
    }
  }
  return bestErr < 2 ? best : null;
}
function bowSpeed(chargeMs) { const s = Math.min(1, chargeMs / 1000); const f = Math.min(1, (s * s + 2 * s) / 3); return 3 * f; }

function hasLine(bot, e) {
  try {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0), to = e.position.offset(0, (e.height || 1) * 0.6, 0), v = to.minus(eye), d = v.norm();
    if (!bot.world.raycast) return true;
    const hit = bot.world.raycast(eye, v.normalize(), d);
    return !hit || hit.position.offset(0.5, 0.5, 0.5).distanceTo(eye) >= d - 1;
  } catch (err) { return true; }
}
async function aimAt(bot, e, speed) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  let to = e.position.offset(0, (e.height || 1) * 0.6, 0);
  const v = e.velocity || new Vec3(0, 0, 0);
  for (let i = 0; i < 2; i++) { const ticks = eye.distanceTo(to) / Math.max(1, speed * 0.9); to = e.position.offset(0, (e.height || 1) * 0.6, 0).plus(new Vec3(v.x, 0, v.z).scaled(ticks)); }
  const dx = to.x - eye.x, dz = to.z - eye.z, h = Math.hypot(dx, dz);
  const pitch = aimPitch(h, to.y - eye.y, speed);
  await bot.look(Math.atan2(-dx, -dz), pitch == null ? Math.atan2(to.y - eye.y, h) : pitch, true);
  return { dist: r1(eye.distanceTo(to)), pitchSolved: pitch != null };
}

async function shoot(ctx, t, p) {
  const bot = ctx.bot;
  const e = findEntity(bot, p.target !== undefined ? p.target : p.entity, 64);
  if (!e) throw new SkillError('не вижу цель: ' + (p.target !== undefined ? p.target : p.entity));
  if (e.type === 'player' && !aggr.isAggressorEntity(ctx, e)) throw new SkillError('в игроков стреляю только агрессоров');
  const bow = A.findItem(bot, 'bow'), xbow = A.findItem(bot, 'crossbow');
  const weapon = (nameOf(p.weapon) === 'crossbow' ? xbow : nameOf(p.weapon) === 'bow' ? bow : (bow || xbow));
  if (!weapon) throw new SkillError('нет лука или арбалета');
  const arrows = () => ARROWS.reduce((s, n) => s + A.invCount(bot, n), 0);
  if (!arrows() && !(weapon.name === 'crossbow' && A.invCount(bot, 'firework_rocket'))) throw new SkillError('нет стрел', { weapon: weapon.name });
  if (!hasLine(bot, e)) throw new SkillError('цель закрыта блоками — нет линии стрельбы');
  const isX = weapon.name === 'crossbow', shots = num(p.shots, 1, 1, 8);
  const charge = num(p.charge_ms, isX ? 1300 : 1000, 150, 3000);
  const d0 = bot.entity.position.distanceTo(e.position), a0 = arrows();
  if (d0 > 60) throw new SkillError(`слишком далеко: ${Math.round(d0)} м (до ~60)`);
  await bot.equip(weapon, 'hand');
  let fired = 0, solved = true;
  const offShoot = t.onAbort(() => { try { bot.deactivateItem(); } catch (e) {} });
  try {
  for (let k = 0; k < shots; k++) {
    t.check();
    const cur = bot.entities[e.id];
    if (!cur || !cur.position) break;
    t.progress(`стреляю ${k + 1}/${shots}`);
    const speed = bowSpeed(isX ? 1000 : charge);
    await aimAt(bot, cur, speed);
    bot.activateItem();
    await t.sleep(charge);
    const c2 = bot.entities[e.id] || cur;
    solved = (await aimAt(bot, c2, speed)).pitchSolved && solved;
    bot.deactivateItem();
    if (isX) { await t.sleep(250); bot.activateItem(); await t.sleep(150); bot.deactivateItem(); }
    fired++;
    await t.sleep(isX ? 300 : 350);
  }
  } finally { offShoot(); try { bot.deactivateItem(); } catch (e) {} }
  const now = bot.entities[e.id];
  return { weapon: weapon.name, target: `${entName(e)}#${e.id}`, shots: fired, arrowsUsed: Math.max(0, a0 - arrows()), arrowsLeft: arrows(), dist: r1(d0), targetStillThere: !!(now && now.position), ...(solved ? {} : { note: 'цель дальше расчётной дальности — мог не долететь' }) };
}

async function shield(ctx, t, p) {
  const bot = ctx.bot;
  const sh = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield' ? bot.inventory.slots[45] : A.findItem(bot, 'shield');
  if (!sh) throw new SkillError('нет щита');
  if (!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')) { try { await bot.equip(sh, 'off-hand'); } catch (e) { throw new SkillError('не взять щит в левую руку: ' + e.message); } }
  const ms = num(p.ms, 3000, 200, 15000), hp0 = bot.health;
  bot.activateItem(true);
  const off = t.onAbort(() => { try { bot.deactivateItem(); } catch (e) {} });
  try { await t.sleep(ms); } finally { off(); try { bot.deactivateItem(); } catch (e) {} }
  const cur = bot.inventory.slots[45];
  return { heldMs: ms, hp: [r1(hp0), r1(bot.health)], damageTaken: r1(Math.max(0, hp0 - bot.health)), shieldDurability: cur && cur.durabilityUsed != null ? cur.durabilityUsed : null };
}

// ---------- рыбалка ----------
async function fish(ctx, t, p) {
  const bot = ctx.bot;
  const rod = A.findItem(bot, 'fishing_rod');
  if (!rod) throw new SkillError('нет удочки (fishing_rod)');
  const casts = num(p.casts, 5, 1, 30), deadline = Date.now() + num(p.max_sec, 120, 10, 900) * 1000;
  const wid = blockIds(bot, ['water']);
  const water = vision.find(ctx, wid, { radius: 16, count: 60 }).filter(w => { const up = bot.blockAt(w.offset(0, 1, 0)); return up && A.isAirLike(up); });
  if (!water.length) throw new SkillError('не вижу открытой воды рядом (≤16 м)');
  // берег: подойти к воде и встать так, чтобы до неё было 2–4 клетки
  const me = bot.entity.position;
  const w = water.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))[0];
  t.progress('иду к воде');
  if (Math.hypot(w.x + 0.5 - me.x, w.z + 0.5 - me.z) > 4.5) await A.goto(ctx, t, new goals.GoalNear(w.x, w.y, w.z, 3), { timeout: 40000 });
  await bot.equip(rod, 'hand');
  const before = A.invMap(bot); let done = 0, errs = 0, last = null;
  while (done < casts && Date.now() < deadline) {
    t.check(); t.progress(`заброс ${done + 1}/${casts}`);
    await bot.lookAt(w.offset(0.5, 0.9, 0.5), true);
    const off = t.onAbort(() => { try { bot.activateItem(); } catch (e) {} });
    let timer;
    try {
      await Promise.race([bot.fish(), new Promise((_, rej) => { timer = setTimeout(() => { try { bot.activateItem(); } catch (e) {} rej(new Error('поклёвки нет за 45 с')); }, Math.min(45000, Math.max(5000, deadline - Date.now()))); })]);
      done++;
    } catch (e) { t.check(); last = e.message; if (++errs >= 3) break; await t.sleep(800); }
    finally { clearTimeout(timer); off(); }
    await t.sleep(700);
  }
  const caught = gainedOnly(invDiff(before, A.invMap(bot)));
  const res = { casts: done, caught, errors: errs, ...(last ? { lastError: last } : {}) };
  if (!done && errs) throw new SkillError('рыбалка не идёт: ' + last, res);
  return res;
}

// ---------- вёдра ----------
const LIQ_BUCKET = { water: 'water_bucket', lava: 'lava_bucket' };
async function bucket(ctx, t, p) {
  const bot = ctx.bot, action = nameOf(p.action || 'fill');
  if (action === 'fill') {
    const liquid = nameOf(p.liquid || 'water');
    if (!LIQ_BUCKET[liquid]) throw new SkillError('liquid: water|lava');
    const empty = A.findItem(bot, 'bucket');
    if (!empty) throw new SkillError('нет пустого ведра (bucket)');
    let src = null;
    const isSrc = b => b && b.name === liquid && b.metadata === 0;
    if (hasXYZ(p)) { src = bot.blockAt(new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored()); if (!isSrc(src)) throw new SkillError(`в точке не источник ${liquid} (${src ? src.name : '?'}${src && src.name === liquid ? ', течёт' : ''})`); }
    else {
      const list = vision.find(ctx, blockIds(bot, [liquid]), { radius: 16, count: 80 }).map(v => bot.blockAt(v)).filter(isSrc);
      if (!list.length) throw new SkillError(`не вижу источника ${liquid} в 16 м`);
      src = list[0];
    }
    const c = src.position.offset(0.5, 0.5, 0.5);
    await reach(ctx, t, c, 4);
    await bot.equip(empty, 'hand');
    await bot.lookAt(c.offset(0, 0.4, 0), true);
    bot.activateItem();
    await t.sleep(500);
    const full = LIQ_BUCKET[liquid];
    if (!A.invCount(bot, full)) throw new SkillError(`ведро не наполнилось (${liquid} в ${src.position.x},${src.position.y},${src.position.z})`);
    return { filled: full, from: pos3(src.position), buckets: A.invCount(bot, full), emptyLeft: A.invCount(bot, 'bucket') };
  }
  if (action === 'place') {
    const want = p.item ? nameOf(p.item) : null;
    const full = want ? A.findItem(bot, want) : bot.inventory.items().find(i => i.name.endsWith('_bucket') && i.name !== 'bucket' && i.name !== 'milk_bucket');
    if (!full || !full.name.endsWith('_bucket') || full.name === 'bucket') throw new SkillError('нет полного ведра (water_bucket/lava_bucket/...)');
    let ref = null, dirFace = null;
    if (hasXYZ(p)) {
      const cell = new Vec3(Number(p.x), Number(p.y), Number(p.z)).floored();
      for (const f of A.FACES) { const rb = bot.blockAt(cell.plus(f)); if (A.isSolid(rb)) { ref = rb; dirFace = f.scaled(-1); break; } }
      if (!ref) throw new SkillError('рядом с точкой нет твёрдого блока, чтобы целиться');
      await reach(ctx, t, cell.offset(0.5, 0.5, 0.5), 4);
      await bot.equip(full, 'hand');
      await bot.lookAt(ref.position.offset(0.5 + dirFace.x * 0.5, 0.5 + dirFace.y * 0.5, 0.5 + dirFace.z * 0.5), true);
    } else {
      await bot.equip(full, 'hand');
      const c = bot.blockAtCursor(5);
      if (!c) throw new SkillError('в прицеле нет блока (укажи x,y,z)');
    }
    const emptyBefore = A.invCount(bot, 'bucket');
    bot.activateItem();
    await t.sleep(500);
    if (A.invCount(bot, 'bucket') <= emptyBefore) throw new SkillError('жидкость не вылилась (место занято или цель вне досягаемости)');
    return { placed: full.name.replace('_bucket', ''), at: hasXYZ(p) ? pos3(new Vec3(Number(p.x), Number(p.y), Number(p.z))) : null, emptyBuckets: A.invCount(bot, 'bucket') };
  }
  throw new SkillError('action: fill|place');
}

module.exports = {
  eat, equip, toss, dropJunk, lookAt, useItem, activate, pillarUp, bridge, pickup, light, mark, goHome, waypoints, shoot, shield, fish, bucket,
  // чистые части и помощники (для тестов и farm.js)
  raceAbort, pickFood, pickJunk, JUNK_DEFAULT, pickPlaceable, parseDir, aimPitch, bowSpeed, isDark, pickTorchSpots, loadWp, saveWp, wpName, invDiff, gainedOnly, findEntity, reach, standOff, nameOf, hasXYZ, blockState, normSlot, hasLine, blockIds, pos3
};
