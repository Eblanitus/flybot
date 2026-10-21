// "Зрение": бот знает только то, что мог бы увидеть игрок на его месте (никакого рентгена).
// Блок виден, если он в пределах RANGE, хотя бы одна его грань открыта (рядом воздух/жидкость/прозрачный блок)
// и луч от глаз к этой грани не упирается в непрозрачные блоки (проверяем несколько точек на гранях).
// Увиденное запоминается (позиция -> имя, время) и забывается, когда блок меняется.
// blockAt для блока под ногами/рядом/своих проверок безопасности — не рентген, их здесь не трогаем.
'use strict';
const { Vec3 } = require('vec3');
const { isLogName } = require('./util');

const RANGE = 32;          // дальность зрения, блоков
const MEM_CAP = 20000;     // память о полезных блоках (руды, брёвна, станции, кровати)
const TERRAIN_CAP = 60000; // память об остальных увиденных блоках (камень, земля...), пополняется find/survey
const SCAN_MIN_GAP = 1000; // не чаще раза в секунду (кэш на «тик»)
const SCAN_MAX_AGE = 10000;

// Шесть граней: нормаль наружу
const DIRS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
// Точки на грани: центр и четыре смещения (чтобы блоки, видимые под углом, тоже находились)
const OFFS = [[0, 0], [0.32, 0.32], [-0.32, 0.32], [0.32, -0.32], [-0.32, -0.32]];

// Категория полезного блока (или null)
function usefulKey(name) {
  if (isLogName(name)) return 'log';
  if (name.endsWith('_ore')) return name.replace('deepslate_', '');
  if (name === 'water' || name === 'lava' || name === 'crafting_table' || name === 'furnace' || name === 'chest' || name === 'barrel') return name;
  if (name === 'trapped_chest') return 'chest';
  if (name.endsWith('_bed')) return 'bed';
  return null;
}
// Запоминаем надолго всё полезное, кроме жидкостей (их поверхность слишком велика — смотрим их по месту)
function isTracked(name) { const k = usefulKey(name); return k !== null && k !== 'water' && k !== 'lava'; }

// ---- Таблицы по состояниям блоков (на реестр) ----
const TABLES = new WeakMap();
function tables(bot) {
  const reg = bot.registry;
  let T = TABLES.get(reg);
  if (T) return T;
  let max = 0;
  for (const b of reg.blocksArray) if (b.maxStateId > max) max = b.maxStateId;
  const seeThrough = new Uint8Array(max + 1); // сосед пропускает взгляд (воздух, жидкость, стекло, листва...)
  const liquid = new Uint8Array(max + 1);
  const opaque = new Uint8Array(max + 1);     // блокирует луч
  const trackedMask = new Uint8Array(max + 1);
  const liquidSrc = new Uint8Array(max + 1);  // только источники воды/лавы (уровень 0)
  const trackedIds = [];
  for (const b of reg.blocksArray) {
    const full = b.boundingBox === 'block';
    const st = !full || !!b.transparent;
    const lq = b.name === 'water' || b.name === 'lava';
    // стекло и лёд пропускают взгляд; листва, ступени и плиты — нет; лава — нет
    const glassy = /glass|^ice$|^frosted_ice$/.test(b.name);
    const op = b.name === 'lava' || (full && (!b.transparent || /_leaves$|_stairs$|_slab$/.test(b.name)) && !glassy);
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
      seeThrough[s] = st ? 1 : 0; liquid[s] = lq ? 1 : 0; opaque[s] = op ? 1 : 0;
      if (isTracked(b.name)) trackedMask[s] = 1;
    }
    if (lq) liquidSrc[b.minStateId] = 1;
    if (isTracked(b.name)) trackedIds.push(b.id);
  }
  T = { seeThrough, liquid, opaque, trackedMask, liquidSrc, trackedIds, max, masks: new Map() };
  TABLES.set(reg, T);
  return T;
}
function maskFor(bot, ids) {
  const T = tables(bot);
  const key = ids.slice().sort((a, b) => a - b).join(',');
  let m = T.masks.get(key);
  if (m) return m;
  m = new Uint8Array(T.max + 1);
  for (const id of ids) { const b = bot.registry.blocks[id]; if (b) for (let s = b.minStateId; s <= b.maxStateId; s++) m[s] = 1; }
  if (T.masks.size > 200) T.masks.clear();
  T.masks.set(key, m);
  return m;
}

// ---- Состояние ----
function st(ctx) {
  if (!ctx.vision) ctx.vision = {
    mem: new Map(), terrain: new Map(), dim: null,
    lastScan: 0, lastPos: null, dirty: true, lastDur: 0, scans: 0,
    liq: { t: 0, list: [] }, sweepAt: new Map()
  };
  return ctx.vision;
}
const keyOf = (x, y, z) => x + ',' + y + ',' + z;
function mapFor(s, name) { return isTracked(name) ? s.mem : s.terrain; }

function put(ctx, x, y, z, name) {
  const s = st(ctx);
  const m = mapFor(s, name), cap = m === s.mem ? MEM_CAP : TERRAIN_CAP;
  const k = keyOf(x, y, z);
  if (!m.has(k) && m.size >= cap) { // выкинуть самые старые (порядок вставки)
    let n = Math.ceil(cap / 10);
    for (const kk of m.keys()) { m.delete(kk); if (--n <= 0) break; }
  }
  m.set(k, { x, y, z, n: name, t: Date.now() });
}
function forget(ctx, x, y, z) { const s = st(ctx), k = keyOf(x, y, z); s.mem.delete(k); s.terrain.delete(k); }

function eyeOf(bot) { const p = bot.entity.position; return { x: p.x, y: p.y + (bot.entity.eyeHeight || 1.62), z: p.z }; }

const _v = new Vec3(0, 0, 0);
function sid(bot, x, y, z) { _v.x = x; _v.y = y; _v.z = z; return bot.world.getBlockStateId(_v); }

// ---- Луч (DDA по вокселям): чист ли путь от глаз до блока t, когда целимся в точку p внутри него ----
function rayClear(bot, T, e, px, py, pz, tx, ty, tz) {
  let x = Math.floor(e.x), y = Math.floor(e.y), z = Math.floor(e.z);
  const dx = px - e.x, dy = py - e.y, dz = pz - e.z;
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const tdx = ax > 1e-9 ? 1 / ax : Infinity, tdy = ay > 1e-9 ? 1 / ay : Infinity, tdz = az > 1e-9 ? 1 / az : Infinity;
  let tmx = ax > 1e-9 ? (sx > 0 ? x + 1 - e.x : e.x - x) * tdx : Infinity;
  let tmy = ay > 1e-9 ? (sy > 0 ? y + 1 - e.y : e.y - y) * tdy : Infinity;
  let tmz = az > 1e-9 ? (sz > 0 ? z + 1 - e.z : e.z - z) * tdz : Infinity;
  for (let i = 0; i < 160; i++) {
    if (x === tx && y === ty && z === tz) return true;
    if (i > 0 && T.opaque[sid(bot, x, y, z)]) return false;
    if (tmx <= tmy && tmx <= tmz) { if (tmx > 1) return false; x += sx; tmx += tdx; }
    else if (tmy <= tmz) { if (tmy > 1) return false; y += sy; tmy += tdy; }
    else { if (tmz > 1) return false; z += sz; tmz += tdz; }
  }
  return false;
}

// Открыта ли хоть одна грань (дёшево, без луча). liq — цель жидкость: соседняя жидкость не считается
function isExposed(bot, T, x, y, z, liq) {
  for (let i = 0; i < 6; i++) {
    const d = DIRS[i];
    const s = sid(bot, x + d[0], y + d[1], z + d[2]);
    if (!T.seeThrough[s]) continue;
    if (liq && T.liquid[s]) continue;
    return true;
  }
  return false;
}

// Виден ли блок (x,y,z) из точки e: открытая грань, обращённая к глазам, + луч в одну из точек грани
function lineOfSight(bot, T, e, x, y, z, liq) {
  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
  const ddx = e.x - cx, ddy = e.y - cy, ddz = e.z - cz;
  if (ddx * ddx + ddy * ddy + ddz * ddz > (RANGE + 1) * (RANGE + 1)) return false;
  for (let i = 0; i < 6; i++) {
    const [nx, ny, nz] = DIRS[i];
    const s = sid(bot, x + nx, y + ny, z + nz);
    if (!T.seeThrough[s]) continue;
    if (liq && T.liquid[s]) continue;
    if (ddx * nx + ddy * ny + ddz * nz < 0.5) continue; // грань смотрит от глаз (глаза за плоскостью грани)
    for (const [u, v] of OFFS) {
      let px = cx + nx * 0.49, py = cy + ny * 0.49, pz = cz + nz * 0.49;
      if (nx !== 0) { py += u; pz += v; } else if (ny !== 0) { px += u; pz += v; } else { px += u; py += v; }
      if (rayClear(bot, T, e, px, py, pz, x, y, z)) return true;
    }
  }
  return false;
}

// Виден ли воздух/жидкость в клетке (для survey): один луч в центр
function cellVisible(bot, T, e, x, y, z) {
  const dx = e.x - (x + 0.5), dy = e.y - (y + 0.5), dz = e.z - (z + 0.5);
  if (dx * dx + dy * dy + dz * dz > RANGE * RANGE) return false;
  return rayClear(bot, T, e, x + 0.5, y + 0.5, z + 0.5, x, y, z);
}

// Виден ли блок в позиции pos (публичный помощник)
function isVisible(ctx, pos) {
  const bot = ctx.bot; const T = tables(bot);
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  const b = bot.blockAt(new Vec3(x, y, z), false);
  if (!b) return false;
  const liq = b.name === 'water' || b.name === 'lava';
  return lineOfSight(bot, T, eyeOf(bot), x, y, z, liq);
}

// ---- Перебор секций чанков: кандидаты с открытой гранью, ближайшие первыми ----
function sweep(bot, mask, radius, cap, budgetMs, liq) {
  const T = tables(bot);
  const p = bot.entity.position;
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
  const minY = bot.game.minY || 0, nSec = (bot.game.height || 384) >> 4;
  const r2 = radius * radius;
  const secs = [];
  for (let cx = (px - radius) >> 4; cx <= (px + radius) >> 4; cx++) {
    for (let cz = (pz - radius) >> 4; cz <= (pz + radius) >> 4; cz++) {
      const col = bot.world.getColumn(cx, cz);
      if (!col) continue;
      for (let sy = 0; sy < nSec; sy++) {
        const sec = col.sections[sy];
        if (!sec) continue;
        const y0 = minY + sy * 16;
        if (y0 > py + radius || y0 + 15 < py - radius) continue;
        if (sec.palette) { let any = false; for (const s of sec.palette) if (mask[s]) { any = true; break; } if (!any) continue; }
        const mx = cx * 16 + 8 - px, my = y0 + 8 - py, mz = cz * 16 + 8 - pz;
        secs.push({ col, cx, cz, y0, d: mx * mx + my * my + mz * mz });
      }
    }
  }
  secs.sort((a, b) => a.d - b.d);
  const t0 = Date.now();
  const out = [];
  const v = new Vec3(0, 0, 0);
  for (const sc of secs) {
    if (Date.now() - t0 > budgetMs) break;
    for (let dx = 0; dx < 16; dx++) {
      const x = sc.cx * 16 + dx, ddx = x - px;
      if (ddx > radius || ddx < -radius) continue;
      for (let dz = 0; dz < 16; dz++) {
        const z = sc.cz * 16 + dz, ddz = z - pz;
        if (ddx * ddx + ddz * ddz > r2) continue;
        for (let dy = 0; dy < 16; dy++) {
          const y = sc.y0 + dy;
          v.x = dx; v.y = y; v.z = dz;
          const s = sc.col.getBlockStateId(v);
          if (!mask[s]) continue;
          const ddy = y - py;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > r2) continue;
          if (!isExposed(bot, T, x, y, z, liq)) continue;
          out.push({ x, y, z, d2, s });
        }
      }
    }
  }
  out.sort((a, b) => a.d2 - b.d2);
  if (out.length > cap) out.length = cap;
  return out;
}

// Просмотр маски блоков: найти видимые, запомнить новые. Возвращает число увиденных (новых и старых).
function seeAndRemember(ctx, mask, { radius = RANGE, cap = 3000, sweepMs = 60, losMs = 40 } = {}) {
  const bot = ctx.bot; const T = tables(bot); const s = st(ctx);
  const cands = sweep(bot, mask, radius, cap, sweepMs, false);
  const e = eyeOf(bot);
  const t0 = Date.now();
  let seen = 0;
  for (let i = 0; i < cands.length; i++) {
    if ((i & 7) === 0 && Date.now() - t0 > losMs) break;
    const c = cands[i];
    const blk = bot.registry.blocksByStateId[c.s]; if (!blk) continue;
    const k = keyOf(c.x, c.y, c.z);
    const m = mapFor(s, blk.name);
    const old = m.get(k);
    if (old && old.n === blk.name) { seen++; continue; } // уже знаем
    if (lineOfSight(bot, T, e, c.x, c.y, c.z, false)) { put(ctx, c.x, c.y, c.z, blk.name); seen++; }
  }
  return seen;
}

// Проверить память вокруг: блок поменялся — забыть
function validateMemory(ctx) {
  const bot = ctx.bot; const s = st(ctx);
  const p = bot.entity.position; const reg = bot.registry;
  const lim = (RANGE + 8) * (RANGE + 8);
  for (const m of [s.mem, s.terrain]) {
    for (const [k, e] of m) {
      const dx = e.x - p.x, dy = e.y - p.y, dz = e.z - p.z;
      if (dx * dx + dy * dy + dz * dz > lim) continue;
      _v.x = e.x; _v.y = e.y; _v.z = e.z;
      if (!bot.world.getColumnAt(_v)) continue; // чанк не загружен — не проверить, помним
      const b = reg.blocksByStateId[bot.world.getBlockStateId(_v)];
      if (!b || b.name !== e.n) m.delete(k);
    }
  }
}

// Периодическое обновление «увиденного». force — игнорировать кэш.
function refresh(ctx, force = false) {
  const bot = ctx.bot;
  if (!bot || !bot.entity || !ctx.ready) return;
  const s = st(ctx);
  const dim = bot.game && bot.game.dimension;
  if (s.dim !== dim) { s.mem.clear(); s.terrain.clear(); s.sweepAt.clear(); s.dim = dim; s.dirty = true; }
  const now = Date.now();
  const p = bot.entity.position;
  const moved = s.lastPos ? p.distanceTo(s.lastPos) : 99;
  const gap = Math.max(SCAN_MIN_GAP, s.lastDur * 8);
  if (!force) {
    if (now - s.lastScan < gap) return;
    if (!s.dirty && moved < 1.5 && now - s.lastScan < SCAN_MAX_AGE) return;
  }
  const t0 = Date.now();
  try {
    validateMemory(ctx);
    const T = tables(bot);
    seeAndRemember(ctx, maskFor(bot, T.trackedIds));
  } finally {
    s.lastScan = Date.now(); s.lastPos = p.clone(); s.dirty = false; s.lastDur = s.lastScan - t0; s.scans++;
    if (s.lastDur > 120) console.log(`[vision] медленный просмотр: ${s.lastDur} мс, память ${s.mem.size}/${s.terrain.size}`);
  }
}

// Видимые сейчас источники воды/лавы (не запоминаем, кэш ~1 с)
function visibleLiquids(ctx, radius = 24, cap = 200) {
  const bot = ctx.bot; const s = st(ctx); const T = tables(bot);
  const now = Date.now();
  if (now - s.liq.t < SCAN_MIN_GAP && s.liq.radius === radius) return s.liq.list;
  const cands = sweep(bot, T.liquidSrc, radius, cap, 30, true);
  const e = eyeOf(bot);
  const list = [];
  const t0 = Date.now();
  for (let i = 0; i < cands.length; i++) {
    if ((i & 7) === 0 && Date.now() - t0 > 25) break;
    const c = cands[i];
    if (lineOfSight(bot, T, e, c.x, c.y, c.z, true)) list.push({ name: bot.registry.blocksByStateId[c.s].name, pos: new Vec3(c.x, c.y, c.z) });
  }
  s.liq = { t: now, radius, list };
  return list;
}

// Известные (увиденные/запомненные) полезные блоки в радиусе — для «глаз»
function nearbyKnown(ctx, radius = 24) {
  const bot = ctx.bot; const s = st(ctx); const p = bot.entity.position;
  const out = [];
  const r2 = radius * radius;
  for (const e of s.mem.values()) {
    const dx = e.x + 0.5 - p.x, dy = e.y + 0.5 - p.y, dz = e.z + 0.5 - p.z;
    if (dx * dx + dy * dy + dz * dz <= r2) out.push({ name: e.n, pos: new Vec3(e.x, e.y, e.z) });
  }
  return out;
}

// Найти блоки по id среди видимых сейчас и запомненных. Возвращает Vec3, ближайшие первыми.
function find(ctx, ids, { radius = 48, count = 128, fresh = true } = {}) {
  const bot = ctx.bot; const s = st(ctx);
  if (!bot || !bot.entity) return [];
  ids = [].concat(ids);
  const names = new Set(ids.map(id => bot.registry.blocks[id] && bot.registry.blocks[id].name).filter(Boolean));
  if (fresh) {
    const key = ids.slice().sort((a, b) => a - b).join(',');
    const last = s.sweepAt.get(key);
    const p = bot.entity.position;
    if (!last || Date.now() - last.t > 800 || last.pos.distanceTo(p) > 1 || s.dirty) {
      try { seeAndRemember(ctx, maskFor(bot, ids), { radius: Math.min(RANGE, radius) }); } catch (e) {}
      if (s.sweepAt.size > 100) s.sweepAt.clear();
      s.sweepAt.set(key, { t: Date.now(), pos: p.clone() });
    }
  }
  const p = bot.entity.position; const reg = bot.registry;
  const found = [];
  const r2 = radius * radius;
  for (const m of [s.mem, s.terrain]) {
    for (const [k, e] of m) {
      if (!names.has(e.n)) continue;
      const dx = e.x + 0.5 - p.x, dy = e.y + 0.5 - p.y, dz = e.z + 0.5 - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      _v.x = e.x; _v.y = e.y; _v.z = e.z;
      if (bot.world.getColumnAt(_v)) { // загружен — проверим, что блок всё ещё там
        const b = reg.blocksByStateId[bot.world.getBlockStateId(_v)];
        if (!b || b.name !== e.n) { m.delete(k); continue; }
      }
      found.push({ d2, e });
    }
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.slice(0, count).map(f => new Vec3(f.e.x, f.e.y, f.e.z));
}

// Ближайший известный блок (Block) или null
function nearest(ctx, ids, radius = 32) {
  const list = find(ctx, ids, { radius, count: 1 });
  return list.length ? ctx.bot.blockAt(list[0]) : null;
}

// Для survey: функция known(x,y,z,blk) -> true/false. Видимое запоминается.
function makeProbe(ctx, budgetMs = 700) {
  const bot = ctx.bot; const T = tables(bot); const s = st(ctx);
  const e = eyeOf(bot);
  const p = bot.entity.position;
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  const deadline = Date.now() + budgetMs;
  let n = 0;
  return (x, y, z, blk) => {
    // рядом с ботом всё «чувствуется»: стоит внутри и вплотную
    if (Math.abs(x - fx) <= 1 && Math.abs(z - fz) <= 1 && y >= fy - 1 && y <= fy + 2) return true;
    const m = mapFor(s, blk.name);
    const old = m.get(keyOf(x, y, z));
    if (old && old.n === blk.name) return true;
    if ((++n & 15) === 0 && Date.now() > deadline) return false;
    const full = blk.boundingBox === 'block';
    if (!full && blk.name !== 'water' && blk.name !== 'lava') return cellVisible(bot, T, e, x, y, z); // воздух и т.п.
    const liq = blk.name === 'water' || blk.name === 'lava';
    if (!lineOfSight(bot, T, e, x, y, z, liq)) return false;
    if (!liq) put(ctx, x, y, z, blk.name);
    return true;
  };
}

// Подключение к боту: слушаем изменения блоков и периодически обновляем увиденное
function attach(ctx, bot, session) {
  const s = st(ctx);
  s.dirty = true; s.lastPos = null;
  bot.on('blockUpdate', (oldB, newB) => {
    try {
      if (!newB || !newB.position) return;
      const { x, y, z } = newB.position;
      const k = keyOf(x, y, z);
      const e = s.mem.get(k) || s.terrain.get(k);
      if (e && e.n !== newB.name) forget(ctx, x, y, z);
      const p = bot.entity && bot.entity.position;
      if (p && Math.abs(x - p.x) < RANGE && Math.abs(z - p.z) < RANGE) s.dirty = true;
      // поставленное рядом (верстак, печь, кровать...) — сразу в память, если видно
      if (p && isTracked(newB.name) && p.distanceTo(newB.position) <= 16 && isVisible(ctx, newB.position)) put(ctx, x, y, z, newB.name);
    } catch (err) {}
  });
  session.timers.push(setInterval(() => { try { refresh(ctx); } catch (err) { /* зрение не должно ронять тело */ } }, 1500));
}

module.exports = {
  RANGE, usefulKey, isTracked, attach, refresh, find, nearest, nearbyKnown, visibleLiquids,
  isVisible, makeProbe, forget, tables, st
};
