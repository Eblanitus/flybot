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

// Камень/землю игрок знает и под землёй: если не видно — копаем лесенку вниз (под землёй — туннель вперёд), стены станут видны
const TUNNEL_BLOCKS = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'dirt']);
const TUNNEL_STEPS = 40, TUNNEL_SEC = 150, TUNNEL_DEPTH = 24;
const isFluid = n => n === 'lava' || n === 'water' || n === 'bubble_column';
const isFalling = n => n === 'sand' || n === 'gravel' || n === 'red_sand' || n.endsWith('_concrete_powder');
function cellHazard(bot, c) {
  const b = bot.blockAt(c);
  if (!b) return 'чанк не загружен';
  if (isFluid(b.name)) return b.name;
  for (const f of A.FACES) { const nb = bot.blockAt(c.plus(f)); if (nb && isFluid(nb.name)) return nb.name + ' рядом'; }
  return null;
}
// Один шаг лесенки/туннеля. Возвращает, сколько искомых блоков выкопано по пути. Лава/вода/пустота/сыпучее над головой — другое направление.
async function tunnelStep(ctx, t, ids, tun) {
  const bot = ctx.bot;
  const cur = bot.entity.position.floored();
  const underground = [2, 3].every(k => A.isSolid(bot.blockAt(cur.offset(0, k, 0))));
  const down = !underground && cur.y > tun.startY - TUNNEL_DEPTH;
  const dirs = [tun.dir, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].filter(d => d[0] !== tun.dir[0] || d[1] !== tun.dir[1])];
  const why = [];
  for (const [dx, dz] of dirs) {
    const nx = cur.x + dx, nz = cur.z + dz, ny = down ? cur.y - 1 : cur.y;
    const cells = (down ? [cur.y + 1, cur.y, cur.y - 1] : [cur.y + 1, cur.y]).map(y => new Vec3(nx, y, nz));
    const floor = new Vec3(nx, ny - 1, nz), top = cells[0];
    const floorB = bot.blockAt(floor), roofB = bot.blockAt(top.offset(0, 1, 0));
    const bad = cells.map(c => cellHazard(bot, c)).find(Boolean) || cellHazard(bot, floor);
    if (bad) { why.push(bad); continue; }
    if (!floorB || !A.isSolid(floorB)) { why.push('пустота под ступенью'); continue; }
    if (roofB && isFalling(roofB.name)) { why.push('сыпучий блок над головой'); continue; }
    let got = 0;
    for (const c of cells) {
      t.check();
      const b = bot.blockAt(c);
      if (!A.isSolid(b)) continue;
      if (!A.canHarvest(bot, b)) throw new SkillError(`нужен инструмент для ${b.name}: ${A.neededTools(bot, b).slice(0, 3).join(' / ')}`);
      await A.equipToolFor(bot, b);
      const off = t.onAbort(() => { try { bot.stopDigging(); } catch (e) {} });
      try { await bot.dig(b, true); } finally { off(); }
      ctx.stats.blocksMined++; ctx.statsDirty = true;
      if (ids.includes(b.type)) got++;
    }
    tun.dir = [dx, dz]; tun.steps++;
    try { await A.goto(ctx, t, new goals.GoalBlock(nx, ny, nz), { timeout: 8000 }); } catch (e) { if (e.aborted) throw e; }
    try { await A.pickupDrops(ctx, t, new Vec3(nx + 0.5, ny + 0.5, nz + 0.5), 4, 2000); } catch (e) { if (e.aborted) throw e; }
    return got;
  }
  throw new SkillError('копать негде: ' + [...new Set(why)].join(', '));
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
  const canTunnel = names.some(x => TUNNEL_BLOCKS.has(x)); // логи и руды — только по видимости
  const tun = { dir: [1, 0], steps: 0, startY: bot.entity.position.floored().y, until: Date.now() + TUNNEL_SEC * 1000 };

  while (mined < count) {
    t.check();
    t.progress(`${mined}/${count} ${want}`);
    const targets = findTargets(ctx, ids, radius, skip);
    if (!targets.length) {
      if (canTunnel && tun.steps < TUNNEL_STEPS && Date.now() < tun.until) {
        t.progress(`${mined}/${count} ${want}: копаю лесенку (шаг ${tun.steps + 1})`);
        try { mined += await tunnelStep(ctx, t, ids, tun); } catch (e) {
          if (e.aborted) throw e;
          throw new SkillError(`не вижу ${want} (добыто ${mined}/${count}); копал лесенку ${tun.steps} шаг.: ${e.message}`, { mined, gained: gained(bot, before) });
        }
        continue;
      }
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
