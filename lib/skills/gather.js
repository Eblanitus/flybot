// Навыки добычи и поиска: collect, find, explore.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, SkillError, resolveBlockNames, isLogName, dirName, r1 } = require('../util');
const A = require('../actions');
const vision = require('../vision');
const craft = require('./craft');

function blockIds(bot, names) { return names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id != null); }

function nearLiquidDanger(bot, pos) {
  for (const f of A.FACES) { const b = bot.blockAt(pos.plus(f)); if (b && b.name === 'lava') return true; }
  return false;
}

// Найти ближайшие подходящие блоки среди ВИДИМЫХ и запомненных (не рентген), отсортированные по удобству
// band = [yMin, yMax] — для обычных блоков (камень, земля) не лезем в пещеры далеко от стартовой высоты; цена = горизонталь + 3*|dy|
function findTargets(ctx, ids, radius, skip, band) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  const list = vision.find(ctx, ids, { radius, count: 128 })
    .filter(p => !skip.has(p.toString()) && (!band || (p.y >= band[0] && p.y <= band[1])))
    .map(p => ({ p, score: band ? Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) + 3 * Math.abs(p.y - me.y)
      : p.offset(0.5, 0.5, 0.5).distanceTo(me) + Math.max(0, p.y - me.y - 1) * 2 + Math.max(0, me.y - p.y - 2) * 1.5 }));
  list.sort((a, b) => a.score - b.score);
  return list.map(x => x.p);
}

// Камень/землю игрок знает и под землёй: если не видно — копаем лесенку вниз (под землёй — туннель вперёд), стены станут видны
const TUNNEL_BLOCKS = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'dirt']);
const TUNNEL_STEPS = 40, TUNNEL_SEC = 150, TUNNEL_DEPTH = 24;
const BAND_DOWN = 6, BAND_UP = 4; // без p.deep: цели и лесенка только в [startY-6, startY+4]
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
  const down = !underground && cur.y > tun.startY - (tun.deep ? TUNNEL_DEPTH : BAND_DOWN);
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
      await needTool(ctx, t, b);
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

// Топор для брёвен: есть — берём; нет — каменный (3 булыжника + 2 палки), иначе деревянный. Не получилось — рукой, collect не падает.
const AXE_RANK = ['wooden_axe', 'golden_axe', 'stone_axe', 'copper_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'];
async function ensureAxe(ctx, t) {
  const bot = ctx.bot;
  const have = bot.inventory.items().filter(i => /_axe$/.test(i.name)).sort((a, b) => AXE_RANK.indexOf(b.name) - AXE_RANK.indexOf(a.name))[0];
  if (have) return 'had ' + have.name;
  const stone = ['cobblestone', 'cobbled_deepslate', 'blackstone'].reduce((s, n) => s + A.invCount(bot, n), 0);
  const tries = (stone >= 3 ? ['stone_axe'] : []).concat('wooden_axe');
  const why = [];
  for (const axe of tries) {
    t.check();
    try { await craft.craftItem(ctx, t, axe, 1); return axe + ' crafted'; }
    catch (e) { if (e.aborted) throw e; why.push(`${axe}: ${e.message}`); }
  }
  const msg = why.join('; ');
  t.progress('топор не сделать: ' + msg);
  return 'нет: ' + msg;
}

// Кирка: нет подходящей (не было или сломалась) — каменная (3 булыжника + 2 палки), иначе деревянная; палки из досок/брёвен делает craftItem.
const PICK_OK = /^(wooden|stone|copper|iron|diamond)_pickaxe$/;
async function ensurePickaxe(ctx, t, block) {
  const bot = ctx.bot;
  const need = A.neededTools(bot, block).filter(n => PICK_OK.test(n)); // по возрастанию крепости
  const cobble = ['cobblestone', 'cobbled_deepslate', 'blackstone'].reduce((s, n) => s + A.invCount(bot, n), 0);
  const tries = cobble >= 3 && need.includes('stone_pickaxe') ? ['stone_pickaxe', ...need.filter(n => n !== 'stone_pickaxe')] : need;
  const why = [];
  for (const pick of tries) {
    t.check();
    try { await craft.craftItem(ctx, t, pick, 1); t.progress(`кирка: ${pick} скрафчена`); return pick; }
    catch (e) { if (e.aborted) throw e; why.push(`${pick}: ${e.message}`); }
  }
  throw new SkillError(`нужен инструмент для ${block.name}: ${A.neededTools(bot, block).slice(0, 3).join(' / ')}; скрафтить не вышло — ${why.join('; ') || 'нет подходящей кирки в рецептах'}`);
}
// Перед каждой копкой: инструмент есть? нет (или сломался) — сделать, иначе ошибка с причиной
async function needTool(ctx, t, block) {
  if (A.canHarvest(ctx.bot, block)) return;
  if (!A.neededTools(ctx.bot, block).some(n => PICK_OK.test(n))) throw new SkillError(`нужен инструмент для ${block.name}: ${A.neededTools(ctx.bot, block).slice(0, 3).join(' / ')}`);
  await ensurePickaxe(ctx, t, block);
  if (!A.canHarvest(ctx.bot, block)) throw new SkillError(`нужен инструмент для ${block.name}: ${A.neededTools(ctx.bot, block).slice(0, 3).join(' / ')}`);
}

// Камень: прогресс = чистый прирост дропа в инвентаре (потраченное на подпорки не считается), на время задачи булыжник в запасе
const STONE_DROP = { stone: 'cobblestone', cobblestone: 'cobblestone', deepslate: 'cobbled_deepslate', cobbled_deepslate: 'cobbled_deepslate' };
async function collect(ctx, t, params) {
  const prev = ctx.blockReserve;
  try { return await collectRun(ctx, t, params); } finally { ctx.blockReserve = prev; }
}
async function collectRun(ctx, t, params) {
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
  const trackNames = [...new Set(names.map(n => STONE_DROP[n]).filter(Boolean))];
  if (trackNames.length) ctx.blockReserve = count;
  const net = () => trackNames.reduce((s, n) => s + A.invCount(bot, n) - (before.get(n) || 0), 0);
  const done = () => trackNames.length ? Math.max(0, net()) : mined;
  let axe;
  if (count >= 4 && names.some(n => /_(log|wood|stem|hyphae)$/.test(n))) { axe = await ensureAxe(ctx, t); t.progress(`${want}: топор — ${axe}`); }
  const canTunnel = names.some(x => TUNNEL_BLOCKS.has(x)); // логи и руды — только по видимости
  const deep = !!params.deep;
  const tun = { dir: [1, 0], deep, steps: 0, startY: bot.entity.position.floored().y, until: Date.now() + TUNNEL_SEC * 1000 };

  while (done() < count) {
    t.check();
    t.progress(`${done()}/${count} ${want}`);
    const band = canTunnel && !deep ? [tun.startY - BAND_DOWN, tun.startY + BAND_UP] : null;
    const targets = findTargets(ctx, ids, radius, skip, band);
    if (!targets.length) {
      if (canTunnel && tun.steps < TUNNEL_STEPS && Date.now() < tun.until) {
        t.progress(`${done()}/${count} ${want}: копаю лесенку (шаг ${tun.steps + 1})`);
        try { mined += await tunnelStep(ctx, t, ids, tun); } catch (e) {
          if (e.aborted) throw e;
          throw new SkillError(`не вижу ${want} (добыто ${done()}/${count}); копал лесенку ${tun.steps} шаг.: ${e.message}`, { mined, gained: gained(bot, before) });
        }
        continue;
      }
      throw new SkillError(`не вижу ${want} (добыто ${done()}/${count}) — исследуй (explore) или копай туннель: руда в стене туннеля станет видна`, { mined, gained: gained(bot, before) });
    }
    const pos = targets[0];
    const block = bot.blockAt(pos);
    if (!block || !ids.includes(block.type)) { skip.add(pos.toString()); if (block) vision.forget(ctx, pos.x, pos.y, pos.z); continue; }
    try { await needTool(ctx, t, block); } catch (e) { if (e.aborted) throw e; throw new SkillError(e.message, { mined, gained: gained(bot, before) }); }
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
  const res = { mined, gained: gained(bot, before) };
  if (trackNames.length && mined > net()) res.spent = mined - net();
  if (axe) res.axe = axe;
  return res;
}

function gained(bot, before) {
  const after = A.invMap(bot); const out = {};
  for (const [k, v] of after) { const d = v - (before.get(k) || 0); if (d > 0) out[k] = d; }
  return out;
}

// ---- Исследование ----
const CELL = 16;
function cellKey(x, z) { return Math.floor(x / CELL) + ',' + Math.floor(z / CELL); }

// Память неудачных направлений explore: ctx.exploreFails = [{ox, oz, tx, tz, ang, t, why}], живёт EXPLORE_MEMORY_MS
const EXPLORE_MEMORY_MS = 10 * 60 * 1000;
const EXPLORE_MAX_TRIES = 6;
function angDiff(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }
function exploreFails(ctx) {
  const now = Date.now();
  ctx.exploreFails = (ctx.exploreFails || []).filter(f => now - f.t < EXPLORE_MEMORY_MS).slice(-40);
  return ctx.exploreFails;
}
// Штраф направления/точки: рядом уже была неудача (из близкой точки старта в близком направлении, либо цель почти там же)
function exploreFailPenalty(fails, sx, sz, ang, tx, tz, dist) {
  let pen = 0;
  for (const f of fails) {
    if (Math.hypot(tx - f.tx, tz - f.tz) < 12) pen += 100; // та же точка
    else if (Math.hypot(sx - f.ox, sz - f.oz) < 24 && angDiff(ang, f.ang) < Math.PI / 5 && dist >= f.dist * 0.8) pen += 60; // то же направление не короче
  }
  return pen;
}

async function explore(ctx, t, params) {
  const bot = ctx.bot;
  const dist = num(params.distance, 48, 16, 160);
  const start = bot.entity.position.clone();
  const fails = exploreFails(ctx);
  const base = Math.random() * Math.PI / 4;
  const budget = Date.now() + Math.max(60000, dist * 3000); // общий потолок на все попытки
  const tried = [];
  let lastErr = null;
  const cands = [];
  // сначала полная дальность по всем 8 направлениям, потом половина и треть — «ближе» вместо провала
  for (const f of [1, 0.5, 0.3]) {
    const d = Math.max(12, Math.round(dist * f));
    for (let i = 0; i < 8; i++) {
      const ang = base + i * Math.PI / 4 + (Math.random() - 0.5) * 0.3;
      const dx = Math.sin(ang), dz = -Math.cos(ang);
      let visited = 0;
      for (let s = CELL; s <= d; s += CELL) if (ctx.visited.has(cellKey(start.x + dx * s, start.z + dz * s))) visited++;
      const tx = Math.round(start.x + dx * d), tz = Math.round(start.z + dz * d);
      cands.push({ ang, dx, dz, d, tx, tz, visited, r: Math.random(), f });
    }
  }
  const rank = c => exploreFailPenalty(fails, start.x, start.z, c.ang, c.tx, c.tz, c.d) + c.visited;
  const order = [];
  for (const f of [1, 0.5, 0.3]) order.push(...cands.filter(c => c.f === f).sort((a, b) => rank(a) - rank(b) || a.r - b.r).slice(0, f === 1 ? 3 : 2));
  for (const c of order) {
    if (tried.length >= EXPLORE_MAX_TRIES || Date.now() > budget) break;
    t.check();
    // цель, рядом с которой только что провалились в этой же попытке, пропускаем
    if (tried.some(x => Math.hypot(x.tx - c.tx, x.tz - c.tz) < 12)) continue;
    if (exploreFailPenalty(fails, start.x, start.z, c.ang, c.tx, c.tz, c.d) >= 100) continue; // сюда уже не пройти
    t.progress(`иду к ${c.tx} ${c.tz}`);
    tried.push(c);
    let failed = false;
    try {
      await A.goto(ctx, t, new goals.GoalNearXZ(c.tx, c.tz, 3), { timeout: c.d * 1500 });
    } catch (e) {
      if (e.aborted) throw e;
      lastErr = e.message; failed = true;
    }
    const moved = bot.entity.position.distanceTo(start);
    if (failed && moved < c.d * 0.5) {
      fails.push({ ox: start.x, oz: start.z, tx: c.tx, tz: c.tz, ang: c.ang, dist: c.d, t: Date.now(), why: lastErr });
      if (moved >= 6) break; // сдвинулись заметно — это уже исследование, не будем гонять дальше
      continue;
    }
    if (moved >= c.d * 0.5 || moved >= 6) break;
  }
  const p = bot.entity.position;
  const moved = r1(p.distanceTo(start));
  if (moved < 6) {
    const listing = tried.map(c => `${dirName(start, { x: c.tx, y: start.y, z: c.tz })} ${c.d}`).join(', ');
    throw new SkillError('не удалось уйти исследовать: ' + (lastErr || 'путь заблокирован') + (listing ? ` (пробовал: ${listing}; эти направления на 10 мин запомнены как закрытые)` : ''), { tried: tried.length });
  }
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

module.exports = { collect, explore, find, exploreFailPenalty, cellKey, isLogName, Vec3 };
