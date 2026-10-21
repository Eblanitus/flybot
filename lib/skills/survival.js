// Навыки выживания: shelter (укрытие из блоков или закопаться), sleep (кровать), wait_night.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, SkillError, isBuildBlock } = require('../util');
const A = require('../actions');
const { timeInfo } = require('../perception');
const vision = require('../vision');

function buildItem(bot) {
  const items = bot.inventory.items().filter(i => isBuildBlock(i.name));
  // сначала мусор (земля, булыжник), доски — в последнюю очередь
  items.sort((a, b) => (a.name.endsWith('_planks') ? 1 : 0) - (b.name.endsWith('_planks') ? 1 : 0) || b.count - a.count);
  return items[0] || null;
}
function buildCount(bot) { return bot.inventory.items().filter(i => isBuildBlock(i.name)).reduce((s, i) => s + i.count, 0); }

// Позиции, которые надо закрыть вокруг бота, стоящего в base
function shellPositions(base) {
  const out = [];
  for (const h of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push(base.offset(dx, h, dz));
  out.push(base.offset(0, 2, 0));
  return out;
}
function needsFill(bot, p) { const b = bot.blockAt(p); return !b || !A.isSolid(b); }

// Встать точно в центр клетки: иначе хитбокс бота заходит в соседнюю и блок туда не ставится («бот стоит на месте установки»)
async function centerOn(bot, t, base) {
  const cx = base.x + 0.5, cz = base.z + 0.5;
  try {
    for (let i = 0; i < 40; i++) {
      t.check();
      const p = bot.entity.position, dx = cx - p.x, dz = cz - p.z;
      if (Math.hypot(dx, dz) < 0.12) break;
      await bot.look(Math.atan2(-dx, -dz), 0, true);
      bot.setControlState('sneak', true); bot.setControlState('forward', true); // на корточках: медленно и не свалиться
      await t.sleep(Math.hypot(dx, dz) > 0.3 ? 120 : 50);
      bot.setControlState('forward', false);
    }
  } finally { bot.clearControlStates(); }
  await t.sleep(150);
}

// Поставить блок в p; не вышло — подложить опору снизу или сбоку (потолок над одиночной клеткой не к чему прислонить)
async function putBlock(bot, p, noUnder) {
  const it = buildItem(bot);
  if (!it) return 0;
  try { await A.placeBlockAt(bot, p, it.name); return 1; } catch (e) {}
  let n = 0;
  const under = p.offset(0, -1, 0);
  if (needsFill(bot, under) && !noUnder) { try { await A.placeBlockAt(bot, under, it.name); n++; await A.placeBlockAt(bot, p, buildItem(bot).name); return n + 1; } catch (e) {} }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { // опора рядом с p, которая сама стоит на стене/земле
    const sp = p.offset(dx, 0, dz);
    if (!needsFill(bot, sp) || A.blockHitsBot(bot, sp) || needsFill(bot, sp.offset(0, -1, 0))) continue;
    try { await A.placeBlockAt(bot, sp, buildItem(bot).name); n++; putBlock.scaffold = sp; await A.placeBlockAt(bot, p, buildItem(bot).name); return n + 1; } catch (e) {}
  }
  return n;
}

// Уже в укрытии?
function isSheltered(bot) {
  const base = bot.entity.position.floored();
  return shellPositions(base).every(p => !needsFill(bot, p));
}

async function shelter(ctx, t, params) {
  const bot = ctx.bot;
  if (isSheltered(bot)) return { mode: 'already', placed: 0 };
  // встать в центр блока
  const c = bot.entity.position.floored();
  try { await A.goto(ctx, t, new goals.GoalBlock(c.x, c.y, c.z), { timeout: 5000 }); } catch (e) { if (e.aborted) throw e; }
  bot.clearControlStates();
  await t.sleep(300);
  await centerOn(bot, t, bot.entity.position.floored());
  const base = bot.entity.position.floored();
  const below = bot.blockAt(base.offset(0, -1, 0));
  const todo = shellPositions(base).filter(p => needsFill(bot, p));
  // потолку не к чему прислониться (открытая местность) — нужен ещё один блок-опора сбоку
  const roof = base.offset(0, 2, 0);
  const scaffold = todo.some(p => p.equals(roof)) && !A.FACES.some(f => A.isSolid(bot.blockAt(roof.plus(f)))) ? 1 : 0;
  const mode = params.mode || (buildCount(bot) >= todo.length + (A.isSolid(below) ? 0 : 1) ? 'walls' : 'dig');
  let placed = 0;
  if (mode === 'walls') {
    if (!A.isSolid(below)) { const it = buildItem(bot); if (it) { try { await A.placeBlockAt(bot, base.offset(0, -1, 0), it.name); placed++; } catch (e) {} } }
    // с опорой под потолок блоков может не хватить на целую стену: последнюю высокую стену откладываем, опору потом выкапываем обратно
    const deferred = scaffold ? todo.find(p => p.equals(base.offset(-1, 1, 0))) : null;
    const order = deferred ? [...todo.filter(p => p !== deferred), deferred] : todo;
    for (const p of order) {
      t.check();
      if (!needsFill(bot, p)) continue;
      const it = buildItem(bot);
      if (!it) throw new SkillError('кончились блоки для укрытия', { placed });
      t.progress(`стены ${placed}/${todo.length}`);
      putBlock.scaffold = null;
      placed += await putBlock(bot, p, p.y > base.y + 1);
      const sc = putBlock.scaffold;
      if (sc && deferred && !buildItem(bot) && !needsFill(bot, p) && needsFill(bot, deferred)) { // опора стала лишней — вернуть блок
        try { const b = bot.blockAt(sc); await A.equipToolFor(bot, b); await bot.dig(b, true); await t.sleep(900); } catch (e) { if (e.aborted) throw e; }
      }
    }
  } else {
    // закопаться: выкопать 2 блока вниз и закрыть голову
    for (let i = 1; i <= 2; i++) {
      t.check();
      const b = bot.blockAt(base.offset(0, -i, 0));
      const under = bot.blockAt(base.offset(0, -i - 1, 0));
      if (!b || ['bedrock', 'obsidian', 'water', 'lava'].includes(b.name)) throw new SkillError('нельзя копать вниз: ' + (b ? b.name : '?'));
      if (!under || !A.isSolid(under) || under.name === 'lava') throw new SkillError('под ногами пустота/лава — копать вниз опасно');
      t.progress('копаю вниз ' + i + '/2');
      if (A.isSolid(b)) { await A.equipToolFor(bot, b); await bot.dig(b, true); ctx.stats.blocksMined++; }
      await t.sleep(600);
    }
    const nb = bot.entity.position.floored();
    const fills = shellPositions(nb).filter(p => needsFill(bot, p));
    for (const p of fills) {
      t.check();
      const it = buildItem(bot);
      if (!it) throw new SkillError('нечем закрыть яму', { placed });
      placed += await putBlock(bot, p, p.y > nb.y + 1);
    }
  }
  ctx.stats.blocksPlaced += placed; ctx.statsDirty = true;
  const ok = isSheltered(bot);
  ctx.shelterPos = bot.entity.position.floored();
  if (!ok) throw new SkillError('укрытие не до конца закрыто', { mode, placed });
  return { mode, placed };
}

// Выйти из укрытия: сломать два блока стены
async function leaveShelter(ctx, t) {
  const bot = ctx.bot;
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const lo = bot.blockAt(base.offset(dx, 0, dz)), hi = bot.blockAt(base.offset(dx, 1, dz));
    const out = bot.blockAt(base.offset(dx * 2, 0, dz * 2));
    if (!lo || !hi || lo.name === 'lava' || (out && (out.name === 'lava' || out.name === 'water'))) continue;
    for (const b of [hi, lo]) if (A.isSolid(b)) { t.check(); await A.equipToolFor(bot, b); await bot.dig(b, true); }
    return true;
  }
  return false;
}

async function sleep(ctx, t, params) {
  const bot = ctx.bot;
  const bedIds = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id);
  // в деревне ночью кровати занимают жители — пробуем свободные по очереди, от ближней к дальней
  const me = bot.entity.position;
  // кровати — только те, что бот видел или помнит (не сквозь стены)
  const free = vision.find(ctx, bedIds, { radius: 48, count: 40 })
    .map(p => bot.blockAt(p))
    .filter(b => b && !(b.getProperties && b.getProperties().occupied))
    .filter(b => !(b.getProperties && b.getProperties().part === 'foot'))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  let lastErr = null;
  for (const b of free.slice(0, 6)) {
    try {
      await A.goto(ctx, t, new goals.GoalNear(b.position.x, b.position.y, b.position.z, 2), { timeout: 60000 });
      await bot.sleep(bot.blockAt(b.position));
      return await sleepUntilMorning(ctx, t);
    } catch (e) {
      if (e.aborted) throw e;
      lastErr = e;
      if (!/occupied|far|not a bed/i.test(e.message)) throw new SkillError('не получилось лечь: ' + e.message);
    }
  }
  let bed = null;
  const hasBedItem = () => bot.inventory.items().some(i => i.name.endsWith('_bed'));
  if (!hasBedItem()) {
    // свободных нет (в кроватях спят жители) — сломать ближнюю кровать, забрать её и поставить себе
    // ломать именно изголовье (part=head): при сломе изножья кровать пропадает без предмета
    const taken = vision.find(ctx, bedIds, { radius: 48, count: 40 })
      .map(p => bot.blockAt(p))
      .filter(b => b && (!b.getProperties || b.getProperties().part !== 'foot'))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!taken) throw new SkillError(lastErr ? 'не получилось лечь: ' + lastErr.message : 'не вижу кровати и нет в инвентаре — найди дом/кровать (explore) или скрафти');
    t.progress('кровать занята — забираю её себе');
    // подойти так, чтобы кровать была в прямой видимости: не ломать сквозь стены, и предмет потом можно подобрать
    await A.goto(ctx, t, new goals.GoalLookAtBlock(taken.position, bot.world, { reach: 4 }), { timeout: 60000 });
    const blk = bot.blockAt(taken.position);
    if (!blk || !blk.name.endsWith('_bed')) throw new SkillError('кровать пропала, пока шёл');
    if (!bot.canSeeBlock(blk)) throw new SkillError('кровать за стеной — не ломаю сквозь блоки');
    await bot.dig(blk);
    await A.pickupDrops(ctx, t, taken.position.offset(0.5, 0.5, 0.5), 6, 8000);
    if (!hasBedItem()) throw new SkillError('сломал кровать, но не подобрал её');
  }
  {
    const item = bot.inventory.items().find(i => i.name.endsWith('_bed'));
    if (!item) throw new SkillError('нет кровати рядом и в инвентаре');
    const spot = A.findPlaceSpot(bot);
    if (!spot) throw new SkillError('некуда поставить кровать');
    await A.placeBlockAt(bot, spot, item.name).catch(() => {});
    await t.sleep(300);
    const placed = bot.blockAt(spot);
    bed = placed && placed.name.endsWith('_bed') ? placed : vision.nearest(ctx, bedIds, 6);
    if (!bed) throw new SkillError('не удалось поставить кровать');
  }
  await A.goto(ctx, t, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { timeout: 60000 });
  try { await bot.sleep(bot.blockAt(bed.position)); }
  catch (e) { throw new SkillError('не получилось лечь: ' + e.message); }
  return sleepUntilMorning(ctx, t);
}

async function sleepUntilMorning(ctx, t) {
  const bot = ctx.bot;
  t.progress('сплю');
  const off = t.onAbort(() => { bot.wake().catch(() => {}); });
  try {
    const end = Date.now() + 120000;
    while (bot.isSleeping && Date.now() < end) await t.sleep(500);
  } finally { off(); }
  return { slept: true, phase: timeInfo(bot).phase };
}

async function waitNight(ctx, t, params) {
  const bot = ctx.bot;
  let ti = timeInfo(bot);
  if (!ti.isNight && ti.nightIn > num(params.min_wait, 60, 0, 600)) return { waited: 0, note: 'ещё не ночь', nightIn: ti.nightIn };
  // сначала попробовать поспать
  const bedIds = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id);
  if (ti.isNight && (vision.nearest(ctx, bedIds, 32) || bot.inventory.items().some(i => i.name.endsWith('_bed')))) {
    try { const r = await sleep(ctx, t, {}); return { ...r, mode: 'sleep' }; } catch (e) { if (e.aborted) throw e; }
  }
  const sh = await shelter(ctx, t, {});
  const start = Date.now();
  const maxMs = num(params.max_sec, 720, 30, 1200) * 1000;
  while (Date.now() - start < maxMs) {
    ti = timeInfo(bot);
    t.progress(`жду утра, ${ti.isNight ? 'день через ' + ti.dayIn + 'с' : 'до ночи ' + ti.nightIn + 'с'}`);
    if (!ti.isNight && ti.nightIn > 60 && ti.tod < 12000) break;
    await t.sleep(2000);
  }
  let left = false;
  if (params.leave !== false) { try { left = await leaveShelter(ctx, t); } catch (e) { if (e.aborted) throw e; } }
  return { waitedSec: Math.round((Date.now() - start) / 1000), shelter: sh.mode, left, phase: timeInfo(bot).phase };
}

module.exports = { shelter, sleep, waitNight, leaveShelter, isSheltered, Vec3 };
