// Навыки добычи и поиска: collect, find, explore.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, SkillError, resolveBlockNames, isLogName, dirName, r1 } = require('../util');
const A = require('../actions');
const vision = require('../vision');

function blockIds(bot, names) { return names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id != null); }

function nearLiquidDanger(bot, pos) {
  for (const f of A.FACES) { const b = bot.blockAt(pos.plus(f)); if (b && b.name === 'lava') return true; }
  return false;
}

// Найти ближайшие подходящие блоки среди ВИДИМЫХ и запомненных (не рентген), отсортированные по удобству
function findTargets(ctx, ids, radius, skip) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  const list = vision.find(ctx, ids, { radius, count: 128 })
    .filter(p => !skip.has(p.toString()))
    .map(p => ({ p, score: p.offset(0.5, 0.5, 0.5).distanceTo(me) + Math.max(0, p.y - me.y - 1) * 2 + Math.max(0, me.y - p.y - 2) * 1.5 }));
  list.sort((a, b) => a.score - b.score);
  return list.map(x => x.p);
}

async function collect(ctx, t, params) {
  const bot = ctx.bot;
  const want = String(params.block || params.type || params.name || '');
  const names = resolveBlockNames(bot.registry, want);
  if (!names.length) throw new SkillError(`неизвестный блок: ${want}`);
  const ids = blockIds(bot, names);
  const count = num(params.count, 1, 1, 64);
  const radius = num(params.radius, 48, 8, 96);
  const before = A.invMap(bot);
  const skip = new Set();
  let mined = 0; let fails = 0;

  while (mined < count) {
    t.check();
    t.progress(`${mined}/${count} ${want}`);
    const targets = findTargets(ctx, ids, radius, skip);
    if (!targets.length) {
      throw new SkillError(`не вижу ${want} (добыто ${mined}/${count}) — исследуй (explore) или копай туннель: руда в стене туннеля станет видна`, { mined, gained: gained(bot, before) });
    }
    const pos = targets[0];
    const block = bot.blockAt(pos);
    if (!block || !ids.includes(block.type)) { skip.add(pos.toString()); if (block) vision.forget(ctx, pos.x, pos.y, pos.z); continue; }
    if (!A.canHarvest(bot, block)) {
      throw new SkillError(`нужен инструмент для ${block.name}: ${A.neededTools(bot, block).slice(0, 3).join(' / ')}`, { mined, gained: gained(bot, before) });
    }
    if (nearLiquidDanger(bot, pos)) { skip.add(pos.toString()); continue; }
    try {
      await A.goto(ctx, t, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { timeout: 45000 });
      const b2 = bot.blockAt(pos);
      if (!b2 || !ids.includes(b2.type)) continue; // уже сломан (например, пока шли)
      if (bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5.2) throw new SkillError('не дотянулся');
      await A.equipToolFor(bot, b2);
      t.check();
      const off = t.onAbort(() => { try { bot.stopDigging(); } catch (e) {} });
      try { await bot.dig(b2, true); } finally { off(); }
      mined++; ctx.stats.blocksMined++; ctx.statsDirty = true;
      await A.pickupDrops(ctx, t, pos.offset(0.5, 0.5, 0.5), 6, 6000);
      fails = 0;
    } catch (e) {
      if (e.aborted) throw e;
      skip.add(pos.toString());
      if (++fails >= 6) throw new SkillError(`не получается добраться до ${want}: ${e.message}`, { mined, gained: gained(bot, before) });
    }
  }
  // подобрать остатки рядом
  try { await A.pickupDrops(ctx, t, bot.entity.position, 5, 3000); } catch (e) { if (e.aborted) throw e; }
  return { mined, gained: gained(bot, before) };
}

function gained(bot, before) {
  const after = A.invMap(bot); const out = {};
  for (const [k, v] of after) { const d = v - (before.get(k) || 0); if (d > 0) out[k] = d; }
  return out;
}

// ---- Исследование ----
const CELL = 16;
function cellKey(x, z) { return Math.floor(x / CELL) + ',' + Math.floor(z / CELL); }

async function explore(ctx, t, params) {
  const bot = ctx.bot;
  const dist = num(params.distance, 48, 16, 160);
  const start = bot.entity.position.clone();
  // выбрать направление, где меньше всего посещённых клеток
  const dirs = [];
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + (Math.random() - 0.5) * 0.3;
    const dx = Math.sin(a), dz = -Math.cos(a);
    let visited = 0;
    for (let s = CELL; s <= dist; s += CELL) if (ctx.visited.has(cellKey(start.x + dx * s, start.z + dz * s))) visited++;
    dirs.push({ dx, dz, visited, r: Math.random() });
  }
  dirs.sort((a, b) => a.visited - b.visited || a.r - b.r);
  let lastErr = null;
  for (const d of dirs.slice(0, 3)) {
    t.check();
    const tx = Math.round(start.x + d.dx * dist), tz = Math.round(start.z + d.dz * dist);
    t.progress(`иду к ${tx} ${tz}`);
    try {
      await A.goto(ctx, t, new goals.GoalNearXZ(tx, tz, 3), { timeout: dist * 1500 });
    } catch (e) {
      if (e.aborted) throw e;
      lastErr = e.message;
    }
    const moved = bot.entity.position.distanceTo(start);
    if (moved >= dist * 0.5) break;
  }
  const p = bot.entity.position;
  const moved = r1(p.distanceTo(start));
  if (moved < 6) throw new SkillError('не удалось уйти исследовать: ' + (lastErr || 'путь заблокирован'));
  return { moved, dir: dirName(start, p), at: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] };
}

// ---- Найти блок (с исследованием) ----
async function find(ctx, t, params) {
  const bot = ctx.bot;
  const want = String(params.block || params.name || '');
  const names = resolveBlockNames(bot.registry, want);
  if (!names.length) throw new SkillError(`неизвестный блок: ${want}`);
  const ids = blockIds(bot, names);
  const steps = num(params.steps, 4, 1, 12);
  const goNear = params.go !== false;
  for (let i = 0; i <= steps; i++) {
    t.check();
    t.progress(`поиск ${want}, шаг ${i}/${steps}`);
    const seen = vision.find(ctx, ids, { radius: 64, count: 1 })[0];
    const found = seen ? bot.blockAt(seen) : null;
    if (found) {
      const p0 = bot.entity.position;
      const res = { block: found.name, at: [found.position.x, found.position.y, found.position.z], d: r1(found.position.distanceTo(p0)), dir: dirName(p0, found.position) };
      if (goNear) {
        try { await A.goto(ctx, t, new goals.GoalNear(found.position.x, found.position.y, found.position.z, 3), { timeout: 60000 }); res.reached = true; }
        catch (e) { if (e.aborted) throw e; res.reached = false; res.note = e.message; }
      }
      return res;
    }
    if (i < steps) await explore(ctx, t, { distance: num(params.distance, 48, 16, 160) }).catch(e => { if (e.aborted) throw e; });
  }
  throw new SkillError(`не вижу ${want} после ${steps} вылазок — исследуй дальше (explore) или копай туннель`);
}

module.exports = { collect, explore, find, cellKey, isLogName, Vec3 };
