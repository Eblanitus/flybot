// Постоянная память мира: что муха ВИДЕЛА честным зрением (vision.js) или трогала сама (добыла, поставила, открыла).
// Файл data/world.json (атомарная запись раз в ~30 с и при выходе, переживает перезапуск тела).
// Записи двух семейств:
//  - кластеры клеток (руды, деревья, вода, лава, камень, сундуки, верстаки, печи, кровати): n = число известных клеток,
//    соседние клетки одного вида склеиваются в одну запись (link — предел цепочки, cells — потолок клеток в записи);
//  - точки (смерть, возрождение, пещера, деревня, игрок).
// Чистка: клетка исчезает, когда муха видит на её месте другой блок или сама его добыла; вырубленный лес остаётся пометкой cleared.
// Никакого рентгена: в память идёт только то, что уже в vision.mem / visibleLiquids / «под ногами», плюс свои действия.
'use strict';
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { isLogName, dirName, entName, num, SkillError, r1 } = require('./util');

const SAVE_MS = 30000;
const DEATH_DESPAWN_MS = 5 * 60 * 1000;
const MAX_TOTAL = 1500;
const VERSION = 1;

// ---- Виды ----
// link — максимальная цепочка (по Чебышёву) между клетками одной записи; cells — потолок клеток; cap — потолок записей вида
const CFG = {
  tree: { link: 6, cells: 48, cap: 120, label: 'лес' },
  ore: { link: 4, cells: 40, cap: 50, label: 'руда' }, // любой *_ore
  water: { link: 8, cells: 32, cap: 50, label: 'вода', thin: 4 },
  lava: { link: 6, cells: 32, cap: 30, label: 'лава', thin: 2, danger: true },
  stone: { link: 6, cells: 24, cap: 40, label: 'камень', thin: 4, thinY: true },
  chest: { link: 1, cells: 4, cap: 80, label: 'сундук' },
  crafting_table: { link: 1, cells: 2, cap: 30, label: 'верстак' },
  furnace: { link: 1, cells: 2, cap: 30, label: 'печь' },
  bed: { link: 1, cells: 2, cap: 40, label: 'кровать' }
};
const POINT_CAP = { cave: 40, village: 12, death: 30, spawn: 4, player: 60 };
const POINT_KINDS = new Set(Object.keys(POINT_CAP));
const PROTECTED_POINT = new Set(['death', 'spawn', 'village', 'player']);
const ORE_NAMES = ['coal', 'iron', 'copper', 'gold', 'diamond', 'emerald', 'lapis', 'redstone', 'nether_gold', 'nether_quartz'];
const ALIAS = {
  log: 'tree', logs: 'tree', wood: 'tree', forest: 'tree', tree: 'tree', trees: 'tree', grove: 'tree', лес: 'tree', дерево: 'tree',
  table: 'crafting_table', workbench: 'crafting_table', craftingtable: 'crafting_table', верстак: 'crafting_table',
  barrel: 'chest', сундук: 'chest', печь: 'furnace', кровать: 'bed', вода: 'water', лава: 'lava', камень: 'stone',
  деревня: 'village', village: 'village', пещера: 'cave', cave: 'cave', смерть: 'death', death: 'death',
  spawn: 'spawn', respawn: 'spawn', игрок: 'player', player: 'player', players: 'player',
  lapis: 'lapis_ore', lapis_lazuli: 'lapis_ore', quartz: 'nether_quartz_ore', debris: 'ancient_debris'
};

const cfgOf = kind => CFG[kind.endsWith('_ore') ? 'ore' : kind] || null;
const labelOf = kind => (CFG[kind] && CFG[kind].label) || (kind.endsWith('_ore') ? kind.replace(/_ore$/, '') + ' (руда)' : kind);

// Вид по имени блока (или null, если блок память не интересует)
function kindOfBlock(name) {
  if (!name) return null;
  if (isLogName(name)) return 'tree';
  if (name.endsWith('_ore')) return name.replace('deepslate_', '');
  switch (name) {
    case 'water': case 'lava': case 'crafting_table': case 'furnace': return name;
    case 'chest': case 'trapped_chest': case 'barrel': return 'chest';
    case 'stone': case 'deepslate': return 'stone';
    case 'bell': return 'bell';
  }
  if (name.endsWith('_bed')) return 'bed';
  return null;
}
// Виды запроса: 'iron' -> ['iron_ore'], 'ore' -> все руды, 'wood' -> ['tree']
function resolveKinds(q, known) {
  const s = String(q || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
  if (!s) return [];
  if (s === 'ore' || s === 'ores' || s === 'руда') return [...new Set([...(known || []).filter(k => k.endsWith('_ore')), ...ORE_NAMES.map(n => n + '_ore')])];
  if (ALIAS[s]) return [ALIAS[s]];
  if (ORE_NAMES.includes(s)) return [s + '_ore'];
  if (s.startsWith('deepslate_') && s.endsWith('_ore')) return [s.replace('deepslate_', '')];
  return [s];
}
const dimName = d => String(d || 'overworld').replace(/^minecraft:/, '');
const key3 = (d, x, y, z) => d + '|' + x + ',' + y + ',' + z;
const dist3 = (a, x, y, z) => Math.hypot(a.x - x, a.y - y, a.z - z);

class WorldMem {
  constructor({ file = null, now = Date.now } = {}) {
    this.file = file; this.now = now;
    this.recs = new Map();        // id -> запись
    this.byKind = new Map();      // вид -> [записи]
    this.cellIdx = new Map();     // 'dim|x,y,z' -> запись (только кластеры)
    this.nextId = 1; this.dirty = false; this.saving = false;
    this.lastVisT = 0; this.lastTerrT = 0; this.cursor = 0;
    this.dim = 'overworld';
  }

  // ---------- Записи ----------
  _list(kind) { let l = this.byKind.get(kind); if (!l) this.byKind.set(kind, l = []); return l; }
  _add(rec) {
    rec.id = this.nextId++;
    this.recs.set(rec.id, rec); this._list(rec.k).push(rec);
    if (rec.cells) for (let i = 0; i < rec.cells.length; i += 3) this.cellIdx.set(key3(rec.d, rec.cells[i], rec.cells[i + 1], rec.cells[i + 2]), rec);
    this.dirty = true;
    return rec;
  }
  _drop(rec) {
    this.recs.delete(rec.id);
    const l = this.byKind.get(rec.k); if (l) { const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); }
    if (rec.cells) for (let i = 0; i < rec.cells.length; i += 3) { const k = key3(rec.d, rec.cells[i], rec.cells[i + 1], rec.cells[i + 2]); if (this.cellIdx.get(k) === rec) this.cellIdx.delete(k); }
    this.dirty = true;
  }
  byId(id) { return this.recs.get(Number(id)) || null; }
  get size() { return this.recs.size; }

  _bbox(rec) {
    const c = rec.cells; let a = Infinity, b = Infinity, cc = Infinity, A = -Infinity, B = -Infinity, C = -Infinity;
    for (let i = 0; i < c.length; i += 3) { if (c[i] < a) a = c[i]; if (c[i] > A) A = c[i]; if (c[i + 1] < b) b = c[i + 1]; if (c[i + 1] > B) B = c[i + 1]; if (c[i + 2] < cc) cc = c[i + 2]; if (c[i + 2] > C) C = c[i + 2]; }
    rec.bb = [a, b, cc, A, B, C];
  }

  // Потолок записей вида: выкинуть самую старую (вырубленный лес — первым)
  _makeRoom(kind) {
    const cfg = cfgOf(kind); const cap = cfg ? cfg.cap : (POINT_CAP[kind] || 50);
    const l = this._list(kind);
    while (l.length >= cap) {
      let worst = null;
      for (const r of l) {
        if (worst === null) { worst = r; continue; }
        const w = r.cleared ? -1 : r.t, ww = worst.cleared ? -1 : worst.t;
        if (this._prio(r) < this._prio(worst) || (this._prio(r) === this._prio(worst) && w < ww)) worst = r;
      }
      if (!worst) break;
      this._drop(worst);
    }
  }
  _prio(r) { return (r.own ? 2 : 0) + (PROTECTED_POINT.has(r.k) ? 3 : 0) + (r.items && Object.keys(r.items).length ? 1 : 0); }
  _trimTotal() {
    while (this.recs.size > MAX_TOTAL) {
      let worst = null;
      for (const r of this.recs.values()) {
        if (!worst) { worst = r; continue; }
        const a = this._prio(r), b = this._prio(worst);
        if (a < b || (a === b && (r.cleared ? -1 : r.t) < (worst.cleared ? -1 : worst.t))) worst = r;
      }
      this._drop(worst);
    }
  }

  // ---------- Клетки ----------
  // Увидели/потрогали блок вида kind в (x,y,z). o: d (измерение), t, src ('seen'|'touched'), own, exact (без разрежения), block
  observe(kind, x, y, z, o = {}) {
    const cfg = cfgOf(kind); if (!cfg) return null;
    const d = dimName(o.d || this.dim), t = o.t || this.now();
    if (!o.exact && cfg.thin && ((x % cfg.thin) !== 0 || (z % cfg.thin) !== 0 || (cfg.thinY && (y % cfg.thin) !== 0))) return null; // вода/лава/камень: образцы, а не каждая клетка
    let ex = this.cellIdx.get(key3(d, x, y, z));
    if (ex && ex.k !== kind) { this.removeCell(x, y, z, d); ex = null; } // на этой клетке теперь другой блок
    if (ex) {
      if (t > ex.t) { ex.t = t; this.dirty = true; }
      if (o.own && !ex.own) { ex.own = true; this.dirty = true; }
      if (o.src === 'touched' && ex.src !== 'touched') { ex.src = 'touched'; this.dirty = true; }
      return ex;
    }
    // ближайшая запись того же вида, до которой цепочка клеток ≤ link
    let best = null, bd = Infinity;
    for (const r of this._list(kind)) {
      if (r.d !== d || r.cleared || r.n >= cfg.cells) continue;
      const bb = r.bb; if (!bb || x < bb[0] - cfg.link || x > bb[3] + cfg.link || y < bb[1] - cfg.link || y > bb[4] + cfg.link || z < bb[2] - cfg.link || z > bb[5] + cfg.link) continue;
      const c = r.cells;
      for (let i = 0; i < c.length; i += 3) {
        const dd = Math.max(Math.abs(c[i] - x), Math.abs(c[i + 1] - y), Math.abs(c[i + 2] - z));
        if (dd <= cfg.link && dd < bd) { bd = dd; best = r; if (dd <= 1) break; }
      }
      if (bd <= 1) break;
    }
    if (best) {
      best.cells.push(x, y, z); best.n = best.cells.length / 3;
      const bb = best.bb; bb[0] = Math.min(bb[0], x); bb[3] = Math.max(bb[3], x); bb[1] = Math.min(bb[1], y); bb[4] = Math.max(bb[4], y); bb[2] = Math.min(bb[2], z); bb[5] = Math.max(bb[5], z);
      if (t > best.t) best.t = t;
      if (o.own) best.own = true;
      if (o.src === 'touched') best.src = 'touched';
      if (best.n > (best.peak || 0)) best.peak = best.n;
      this.cellIdx.set(key3(d, x, y, z), best);
      this.dirty = true;
      return best;
    }
    // новая запись; вырубленные пометки в этой области больше не нужны
    if (kind === 'tree') for (const r of this._list('tree').slice()) if (r.cleared && r.d === d && r.bb && x >= r.bb[0] - cfg.link && x <= r.bb[3] + cfg.link && z >= r.bb[2] - cfg.link && z <= r.bb[5] + cfg.link) this._drop(r);
    this._makeRoom(kind);
    const rec = { k: kind, d, x, y, z, cells: [x, y, z], n: 1, peak: 1, t0: t, t, src: o.src || 'seen' };
    if (o.own) rec.own = true;
    if (o.block && kind === 'tree') rec.species = o.block.replace(/_(log|stem)$/, '');
    this._bbox(rec);
    this._add(rec);
    this._trimTotal();
    return rec;
  }

  // Блок в клетке исчез (видим воздух вместо него или сами добыли). Возвращает запись или null
  removeCell(x, y, z, d, { mined = false } = {}) {
    const dd = dimName(d || this.dim), k = key3(dd, x, y, z);
    const r = this.cellIdx.get(k); if (!r) return null;
    this.cellIdx.delete(k);
    const c = r.cells;
    for (let i = 0; i < c.length; i += 3) if (c[i] === x && c[i + 1] === y && c[i + 2] === z) { c.splice(i, 3); break; }
    r.n = c.length / 3;
    if (mined) r.mined = (r.mined || 0) + 1;
    r.tClean = this.now();
    this.dirty = true;
    if (r.n === 0) {
      if (r.k === 'tree') { r.cleared = true; r.t = this.now(); } // лес вырубили — пометка остаётся
      else this._drop(r);
    } else this._bbox(r);
    return r;
  }

  // Проверка клеток рядом: блок на месте — подтвердить свежесть, другой блок и мы это видим — убрать.
  // nameAt(x,y,z) -> имя блока | null (чанк не загружен); visible(x,y,z) -> виден ли сейчас
  sweep({ pos, d, radius = 28, limit = 40, nameAt, visible, maxVisible = 15 }) {
    const dd = dimName(d || this.dim), now = this.now(), r2 = radius * radius;
    const cand = [];
    for (const r of this.recs.values()) {
      if (!r.cells || r.d !== dd || !r.bb) continue;
      const bb = r.bb;
      if (bb[0] - pos.x > radius || pos.x - bb[3] > radius || bb[2] - pos.z > radius || pos.z - bb[5] > radius) continue;
      const c = r.cells;
      for (let i = 0; i < c.length; i += 3) {
        const ex = c[i] + 0.5 - pos.x, ey = c[i + 1] + 0.5 - pos.y, ez = c[i + 2] + 0.5 - pos.z;
        if (ex * ex + ey * ey + ez * ez <= r2) cand.push([r, c[i], c[i + 1], c[i + 2]]);
      }
    }
    let confirmed = 0, removed = 0, vis = 0;
    const n = cand.length; if (!n) return { checked: 0, confirmed, removed };
    const start = this.cursor % n; const todo = Math.min(limit, n);
    this.cursor += todo;
    for (let i = 0; i < todo; i++) {
      const [r, x, y, z] = cand[(start + i) % n];
      if (!this.recs.has(r.id)) continue;
      const name = nameAt(x, y, z); if (name === null || name === undefined) continue;
      const same = kindOfBlock(name) === r.k;
      if (same) {
        if (now - r.t > 5000 && vis < maxVisible) { vis++; if (visible(x, y, z)) { r.t = now; this.dirty = true; confirmed++; } }
      } else if (vis < maxVisible) {
        vis++;
        if (visible(x, y, z)) { this.removeCell(x, y, z, dd); removed++; }
      }
    }
    return { checked: todo, confirmed, removed };
  }

  // ---------- Точки ----------
  _point(kind, o) {
    this._makeRoom(kind);
    const rec = { k: kind, d: dimName(o.d || this.dim), x: o.x, y: o.y, z: o.z, t0: o.t || this.now(), t: o.t || this.now(), src: o.src || 'seen', ...o.extra };
    this._add(rec); this._trimTotal();
    return rec;
  }
  _nearPoint(kind, d, x, y, z, r) {
    let best = null, bd = r;
    for (const p of this._list(kind)) { if (p.d !== d) continue; const dd = dist3(p, x, y, z); if (dd <= bd) { bd = dd; best = p; } }
    return best;
  }

  addDeath({ x, y, z, d, t, cause = null, inv = {} }) {
    t = t || this.now(); d = dimName(d || this.dim);
    const prev = this._nearPoint('death', d, x, y, z, 2);
    if (prev && Math.abs(prev.t - t) < 5000) return prev;
    const names = Object.entries(inv).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
    const loot = Object.fromEntries(names.slice(0, 30));
    return this._point('death', { x, y, z, d, t, src: 'touched', extra: { cause, loot, lootKinds: names.length, status: 'lying' } });
  }
  setDeathCause(cause, at) {
    const l = this._list('death'); const r = l[l.length - 1];
    if (r && !r.cause && this.now() - r.t < 15000) { r.cause = cause; if (at && at.length === 3 && Math.hypot(r.x - at[0], r.z - at[2]) < 6) { r.x = at[0]; r.y = at[1]; r.z = at[2]; } this.dirty = true; }
    return r || null;
  }
  deathStatus(r) {
    if (r.status === 'lying' && this.now() - r.t > DEATH_DESPAWN_MS) return 'expired';
    return r.status;
  }
  // recover закончился: вещи подобраны (gained) или нет
  markRecovered(gained, itemsLeft) {
    const l = this._list('death');
    for (let i = l.length - 1; i >= 0; i--) {
      const r = l[i];
      if (r.status !== 'lying') continue;
      r.status = itemsLeft > 0 ? 'partial' : (gained && Object.keys(gained).length ? 'recovered' : 'gone');
      r.got = gained || {}; r.tRec = this.now(); this.dirty = true;
      return r;
    }
    return null;
  }

  setSpawn(x, y, z, d, src) {
    d = dimName(d || this.dim);
    const ex = this._list('spawn').find(p => p.d === d && p.src === src);
    if (ex) { if (ex.x !== x || ex.y !== y || ex.z !== z) { ex.x = x; ex.y = y; ex.z = z; this.dirty = true; } ex.t = this.now(); return ex; }
    return this._point('spawn', { x, y, z, d, src });
  }

  sight(name, x, y, z, d, t) {
    d = dimName(d || this.dim); t = t || this.now();
    const ex = this._list('player').find(p => p.name === name);
    if (ex) { ex.x = x; ex.y = y; ex.z = z; ex.d = d; ex.t = t; this.dirty = true; return ex; }
    return this._point('player', { x, y, z, d, t, extra: { name } });
  }

  cave(x, y, z, d, size) {
    d = dimName(d || this.dim);
    const ex = this._nearPoint('cave', d, x, y, z, 14);
    if (ex) { ex.t = this.now(); if (size > (ex.size || 0)) { ex.size = size; } this.dirty = true; return ex; }
    return this._point('cave', { x, y, z, d, extra: { size } });
  }

  // деревня: bell — [x,y,z] | null, villagers — сколько жителей видно сейчас
  village(x, y, z, d, { bell = null, villagers = 0 } = {}) {
    d = dimName(d || this.dim);
    const ex = this._nearPoint('village', d, x, y, z, 48);
    if (ex) {
      ex.t = this.now();
      if (bell && !ex.bell) { ex.bell = bell; ex.x = bell[0]; ex.y = bell[1]; ex.z = bell[2]; }
      if (villagers > (ex.villagers || 0)) ex.villagers = villagers;
      this.dirty = true; return ex;
    }
    return this._point('village', { x, y, z, d, extra: { bell, villagers } });
  }

  // ---------- Сундуки ----------
  // Содержимое контейнера в (x,y,z): items — {имя: число}; mine — муха клала туда вещи или сама поставила
  setChestItems(x, y, z, d, items, { t, mine = false, block = 'chest' } = {}) {
    d = dimName(d || this.dim); t = t || this.now();
    const rec = this.observe('chest', x, y, z, { d, t, src: 'touched', own: mine, exact: true });
    if (!rec) return null;
    rec.items = {}; for (const [k, v] of Object.entries(items || {})) if (v > 0) rec.items[k] = v;
    rec.itemsT = t; rec.t = Math.max(rec.t, t); rec.opened = (rec.opened || 0) + 1; rec.block = block;
    this.dirty = true;
    return rec;
  }

  // ---------- Запросы ----------
  _view(rec, pos) {
    const cfg = cfgOf(rec.k);
    let at = [rec.x, rec.y, rec.z], dist;
    if (rec.cells && rec.cells.length) {
      let bd = Infinity; const c = rec.cells;
      for (let i = 0; i < c.length; i += 3) { const dd = dist3(pos, c[i] + 0.5, c[i + 1] + 0.5, c[i + 2] + 0.5); if (dd < bd) { bd = dd; at = [c[i], c[i + 1], c[i + 2]]; } }
      dist = bd;
    } else dist = dist3(pos, rec.x + 0.5, rec.y + 0.5, rec.z + 0.5);
    const v = { id: rec.id, kind: rec.k, at, dist: r1(dist), dir: dirName(pos, { x: at[0], y: at[1], z: at[2] }), ageSec: Math.round((this.now() - rec.t) / 1000), src: rec.src };
    if (rec.cells) { v.n = rec.n; if (rec.peak && rec.peak > rec.n) v.was = rec.peak; }
    if (rec.cleared) v.cleared = true;
    if (rec.own) v.own = true;
    if (cfg && cfg.danger) v.danger = true;
    if (rec.mined) v.mined = rec.mined;
    switch (rec.k) {
      case 'tree': if (rec.species) v.species = rec.species; break;
      case 'chest':
        v.items = rec.items || null; v.itemsAgeSec = rec.itemsT ? Math.round((this.now() - rec.itemsT) / 1000) : null; break;
      case 'death': v.cause = rec.cause || null; v.status = this.deathStatus(rec); v.loot = rec.loot; if (v.status === 'lying') v.expiresInSec = Math.max(0, Math.round((DEATH_DESPAWN_MS - (this.now() - rec.t)) / 1000)); if (rec.got) v.got = rec.got; break;
      case 'village': v.bell = !!rec.bell; v.villagers = rec.villagers || 0; v.beds = this._bedsNear(rec); break;
      case 'cave': v.size = rec.size; break;
      case 'player': v.name = rec.name; v.dim = rec.d; break;
      case 'spawn': v.from = rec.src; break;
    }
    return v;
  }
  _bedsNear(v) { let n = 0; for (const b of this._list('bed')) if (b.d === v.d && Math.hypot(b.x - v.x, b.z - v.z) <= 48) n += b.n || 1; return n; }

  // Ближайшие известные записи видов kinds (строка/массив) к точке pos ({x,y,z}); d — измерение
  near(kinds, pos, { limit = 5, d, name, own, includeCleared = false, maxDist } = {}) {
    const dd = dimName(d || this.dim);
    const ks = Array.isArray(kinds) ? kinds : resolveKinds(kinds, [...this.byKind.keys()]);
    const out = [];
    for (const k of ks) for (const r of this._list(k)) {
      if (r.d !== dd) continue;
      if (r.cleared && !includeCleared) continue;
      if (name && String(r.name || '').toLowerCase() !== String(name).toLowerCase()) continue;
      if (own && !r.own) continue;
      const v = this._view(r, pos);
      if (maxDist && v.dist > maxDist) continue;
      out.push(v);
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, limit);
  }

  counts(d) {
    const dd = dimName(d || this.dim); const o = {};
    for (const [k, l] of this.byKind) { const n = l.filter(r => r.d === dd && !r.cleared).length; if (n) o[k] = n; }
    return o;
  }

  // Где лежит предмет: сундуки (с количеством) и дроп со смерти. Подстрока имени, если точного совпадения нет.
  itemsWhere(item, pos, { d, all = false } = {}) {
    const q = String(item || '').toLowerCase().trim().replace(/[\s\-]+/g, '_').replace(/^minecraft:/, '');
    if (!q) return [];
    const dd = dimName(d || this.dim);
    const pick = items => {
      const names = Object.keys(items || {});
      const exact = names.filter(n => n === q);
      return (exact.length ? exact : names.filter(n => q.length >= 3 && n.includes(q))).map(n => [n, items[n]]);
    };
    const out = [];
    for (const r of this._list('chest')) {
      if (r.d !== dd || !r.items) continue;
      for (const [n, c] of pick(r.items)) { const v = this._view(r, pos); out.push({ where: 'chest', item: n, count: c, at: v.at, dist: v.dist, dir: v.dir, ageSec: v.itemsAgeSec, own: !!r.own }); }
    }
    for (const r of this._list('death')) {
      if (r.d !== dd) continue;
      const st = this.deathStatus(r);
      if (st !== 'lying' && !all) continue;
      for (const [n, c] of pick(r.loot)) {
        const v = this._view(r, pos);
        out.push({ where: 'death', item: n, count: c, at: v.at, dist: v.dist, dir: v.dir, ageSec: v.ageSec, status: st, cause: r.cause || null, ...(st === 'lying' ? { expiresInSec: v.expiresInSec } : {}) });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // Короткая выжимка (≤ ~400 символов) для /snapshot
  brief(pos, d) {
    const dd = dimName(d || this.dim);
    const one = (kinds, opts) => this.near(kinds, pos, { limit: 1, d: dd, ...opts })[0];
    const fmt = (label, v, extra = '') => `${label} ${Math.round(v.dist)}м ${v.dir} ${v.at.join(',')}${extra}`;
    const parts = [];
    const slot = (label, kinds, opts, fn) => { const v = one(kinds, opts); parts.push(v ? fmt(label, v, fn ? fn(v) : '') : label + ' нет'); };
    slot('лес', 'tree', null, v => (v.n >= 12 ? '' : ' (мало)'));
    slot('камень', 'stone');
    slot('уголь', 'coal_ore');
    slot('железо', 'iron_ore');
    slot('медь', 'copper_ore');
    slot('вода', 'water');
    slot('кровать', 'bed');
    slot('сундук', 'chest', { own: true }, v => v.items ? ' [' + Object.entries(v.items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => n + c).join(' ') + ']' : '');
    const lava = one('lava'); if (lava && lava.dist <= 24) parts.push(fmt('ЛАВА', lava));
    const dth = this.near('death', pos, { limit: 3, d: dd }).find(v => v.status === 'lying'); if (dth) parts.push(fmt('вещи со смерти', dth, ` (ещё ${dth.expiresInSec}с)`));
    let s = parts.join('; ');
    if (s.length > 400) { while (parts.length && parts.join('; ').length > 399) parts.pop(); s = parts.join('; '); }
    return s;
  }

  // ---------- Файл ----------
  _serialize() {
    const recs = [];
    for (const r of this.recs.values()) {
      const o = { ...r }; if (!r.cleared) delete o.bb;
      if (r.cells) { const c = []; for (let i = 0; i < r.cells.length; i += 3) c.push(r.cells[i] - r.x, r.cells[i + 1] - r.y, r.cells[i + 2] - r.z); o.cells = c; }
      recs.push(o);
    }
    return '{"v":' + VERSION + ',"saved":' + this.now() + ',"nextId":' + this.nextId + ',"recs":[\n' + recs.map(r => JSON.stringify(r)).join(',\n') + '\n]}\n';
  }
  saveSync() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, this._serialize());
      fs.renameSync(tmp, this.file);
      this.dirty = false; return true;
    } catch (e) { console.log('[worldmem] не записалась:', e.message); return false; }
  }
  async save(force = false) {
    if (!this.file || this.saving || (!this.dirty && !force)) return false;
    this.saving = true; this.dirty = false;
    const tmp = this.file + '.' + process.pid + '.tmp';
    try {
      const text = this._serialize();
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, this.file);
      return true;
    } catch (e) { this.dirty = true; console.log('[worldmem] не записалась:', e.message); return false; }
    finally { this.saving = false; }
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return false;
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) {
      try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (er) {}
      console.log('[worldmem] файл повреждён, начинаю с чистого:', e.message); return false;
    }
    if (!j || !Array.isArray(j.recs)) return false;
    this.recs.clear(); this.byKind.clear(); this.cellIdx.clear();
    let maxId = 0;
    for (const r of j.recs) {
      if (!r || typeof r.k !== 'string' || !Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z) || !Number.isFinite(r.id)) continue;
      r.d = dimName(r.d); r.t = Number(r.t) || 0;
      if (r.cells) {
        const c = []; for (let i = 0; i + 2 < r.cells.length; i += 3) c.push(r.cells[i] + r.x, r.cells[i + 1] + r.y, r.cells[i + 2] + r.z);
        r.cells = c; r.n = c.length / 3;
        if (c.length) this._bbox(r); else if (!r.cleared) continue;
      }
      this.recs.set(r.id, r); this._list(r.k).push(r);
      if (r.cells) for (let i = 0; i < r.cells.length; i += 3) this.cellIdx.set(key3(r.d, r.cells[i], r.cells[i + 1], r.cells[i + 2]), r);
      if (r.id > maxId) maxId = r.id;
    }
    this.nextId = Math.max(Number(j.nextId) || 1, maxId + 1);
    this.dirty = false;
    return true;
  }
}

// ======================================================================================
// Подключение к телу
// ======================================================================================
const STORES = new Set();
let exitHooked = false, saveTimer = null;

function get(ctx) {
  if (ctx.worldmem) return ctx.worldmem;
  const wm = new WorldMem({ file: ctx.dataDir ? path.join(ctx.dataDir, 'world.json') : null }); // без dataDir (тесты) — только в памяти
  wm.load();
  ctx.worldmem = wm; STORES.add(wm);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => { for (const s of STORES) if (s.dirty) s.saveSync(); });
  }
  if (!saveTimer) {
    saveTimer = setInterval(() => { for (const s of STORES) s.save().catch(() => {}); }, SAVE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }
  return wm;
}

const dimOf = bot => dimName(bot && bot.game && bot.game.dimension);
const posOf = bot => bot.entity.position;
function nameAtFactory(bot) {
  const v = new Vec3(0, 0, 0);
  return (x, y, z) => {
    v.x = x; v.y = y; v.z = z;
    if (!bot.world.getColumnAt(v)) return null; // чанк не загружен
    const b = bot.registry.blocksByStateId[bot.world.getBlockStateId(v)];
    return b ? b.name : null;
  };
}
function invCounts(bot) {
  const m = {}; try { for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; } catch (e) {}
  return m;
}
function containerCounts(win) {
  const m = {};
  try { for (const i of win.containerItems()) m[i.name] = (m[i.name] || 0) + i.count; } catch (e) {}
  return m;
}
// есть ли в b больше любого предмета, чем в a (муха положила)
function gainedAny(a, b) { for (const [k, v] of Object.entries(b)) if (v > (a[k] || 0)) return true; return false; }

// 26 направлений зрения для пещер
const RAYS = (() => {
  const out = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (!x && !y && !z) continue;
    const l = Math.hypot(x, y, z); out.push([x / l, y / l, z / l]);
  }
  return out;
})();

// Пещера = мы под землёй и видим вокруг большой свободный объём (лучи взгляда из глаз уходят далеко). Возвращает оценку объёма или 0.
function caveSize(bot, ctx) {
  const vision = require('./vision');
  const T = vision.tables(bot);
  const p = posOf(bot);
  const ex = p.x, ey = p.y + (bot.entity.eyeHeight || 1.62), ez = p.z;
  const v = new Vec3(0, 0, 0);
  const op = (x, y, z) => { v.x = Math.floor(x); v.y = Math.floor(y); v.z = Math.floor(z); return T.opaque[bot.world.getBlockStateId(v)] === 1; };
  // над головой скала, а не небо/листва
  let ceil = false;
  for (let k = 2; k <= 30; k++) { if (op(ex, ey + k, ez)) { v.x = Math.floor(ex); v.y = Math.floor(ey + k); v.z = Math.floor(ez); const b = bot.registry.blocksByStateId[bot.world.getBlockStateId(v)]; ceil = !!b && !/leaves|_log$|_wood$/.test(b.name); break; } }
  if (!ceil) return 0;
  try { const b = bot.blockAt(p); if (b && b.skyLight != null && b.skyLight > 0) return 0; } catch (e) {}
  let sum = 0, far = 0;
  for (const [dx, dy, dz] of RAYS) {
    let len = 0;
    for (let s = 0.5; s <= 24; s += 0.5) { if (op(ex + dx * s, ey + dy * s, ez + dz * s)) break; len = s; }
    sum += len; if (len >= 7) far++;
  }
  return far >= 10 && sum / RAYS.length >= 6 ? Math.round(sum) : 0;
}

function tick(ctx, bot, { full = false } = {}) {
  const wm = get(ctx);
  const vision = require('./vision');
  const now = Date.now();
  const d = dimOf(bot); wm.dim = d;
  const p = posOf(bot);
  const S = ctx.wmState || (ctx.wmState = { liq: 0, vill: 0, cave: 0, stoneSeen: 0 });
  const vs = vision.st(ctx);

  // 1. то, что зрение уже увидело и запомнило (руды, брёвна, станции, сундуки, кровати), и образцы камня
  let maxT = wm.lastVisT;
  for (const e of vs.mem.values()) {
    if (e.t < wm.lastVisT) continue;
    const k = kindOfBlock(e.n); if (!k) continue;
    wm.observe(k, e.x, e.y, e.z, { d, t: e.t, src: 'seen', block: e.n });
    if (e.t > maxT) maxT = e.t;
  }
  wm.lastVisT = maxT;
  let maxTT = wm.lastTerrT;
  for (const e of vs.terrain.values()) {
    if (e.t < wm.lastTerrT) continue;
    if (e.t > maxTT) maxTT = e.t;
    if (e.n === 'stone' || e.n === 'deepslate') wm.observe('stone', e.x, e.y, e.z, { d, t: e.t, src: 'seen' });
  }
  wm.lastTerrT = maxTT;

  // 2. под ногами и вплотную (то, что чувствуешь) — камень
  try {
    const nameAt = nameAtFactory(bot);
    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 2, 0]]) {
      const n = nameAt(fx + dx, fy + dy, fz + dz);
      if (n === 'stone' || n === 'deepslate') wm.observe('stone', fx + dx, fy + dy, fz + dz, { d, src: 'seen', exact: true });
    }
  } catch (e) {}

  // 3. видимые источники воды и лавы
  if (full || now - S.liq > 4000) {
    S.liq = now;
    try { for (const l of vision.visibleLiquids(ctx, 24, 200)) wm.observe(l.name, l.pos.x, l.pos.y, l.pos.z, { d, src: 'seen' }); } catch (e) {}
  }

  // 4. колокол, жители, кровати рядом -> деревня; игроки
  if (full || now - S.vill > 6000) {
    S.vill = now;
    try { sensePeople(ctx, bot, wm, vision, d); } catch (e) {}
  }
  try { sensePlayers(ctx, bot, wm, vision, d); } catch (e) {}

  // 5. пещера
  if (full || now - S.cave > 10000) {
    S.cave = now;
    try { const sz = caveSize(bot, ctx); if (sz) wm.cave(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), d, sz); } catch (e) {}
  }

  // 6. чистка: на месте руды воздух — убрать; блок на месте — подтвердить свежесть
  try { wm.sweep({ pos: p, d, radius: 28, limit: full ? 400 : 40, nameAt: nameAtFactory(bot), visible: (x, y, z) => vision.isVisible(ctx, { x, y, z }), maxVisible: full ? 100 : 15 }); } catch (e) {}

  // 7. инвентарь для места смерти
  S.inv = invCounts(bot);
  S.invT = now;
}

function sensePeople(ctx, bot, wm, vision, d) {
  const p = posOf(bot);
  // колокол
  let bell = null;
  const id = bot.registry.blocksByName.bell && bot.registry.blocksByName.bell.id;
  if (id != null) { const f = vision.find(ctx, [id], { radius: 32, count: 1 }); if (f.length) bell = [f[0].x, f[0].y, f[0].z]; }
  // жители, которых реально видно
  const vil = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || entName(e) !== 'villager') continue;
    if (p.distanceTo(e.position) > 40) continue;
    if (vision.isVisible(ctx, { x: e.position.x, y: e.position.y + (e.height || 1.9) * 0.8, z: e.position.z })) vil.push(e);
  }
  if (bell) { wm.village(bell[0], bell[1], bell[2], d, { bell, villagers: vil.length }); return; }
  if (vil.length >= 2) { const c = vil[0].position; wm.village(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z), d, { villagers: vil.length }); return; }
  if (vil.length === 1) {
    const c = vil[0].position;
    const bedNear = wm.near('bed', c, { limit: 1, d, maxDist: 30 }).length;
    if (bedNear || wm._nearPoint('village', d, c.x, c.y, c.z, 48)) wm.village(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z), d, { villagers: 1 });
  }
}

function sensePlayers(ctx, bot, wm, vision, d) {
  const p = posOf(bot);
  for (const pl of Object.values(bot.players || {})) {
    const e = pl && pl.entity; if (!e || !e.position || pl.username === bot.username) continue;
    if (p.distanceTo(e.position) > 48) continue;
    if (!vision.isVisible(ctx, { x: e.position.x, y: e.position.y + 1.6, z: e.position.z })) continue; // видим глазами, а не по списку сервера
    wm.sight(pl.username, Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), d);
  }
}

// Обёртка метода бота: before(args) -> state, after(state, result, args). Ошибки памяти поведение метода не меняют
function wrapMethod(bot, name, before, after) {
  const orig = bot[name];
  if (typeof orig !== 'function' || orig.__wm) return false;
  const w = function (...args) {
    let st; try { st = before ? before(args) : null; } catch (e) {}
    const r = orig.apply(this, args);
    if (r && typeof r.then === 'function') return r.then(v => { try { after(st, v, args); } catch (e) {} return v; });
    return r;
  };
  w.__wm = true; bot[name] = w;
  return true;
}

function hookBot(ctx, bot) {
  const wm = get(ctx);
  // открыт контейнер/станция: openBlock — единый вход (bot.openContainer, openChest и все навыки идут через него)
  wrapMethod(bot, 'openBlock', args => ({ block: args[0] }), (st, win) => onOpened(ctx, bot, st.block, win));
  // поставлено: сундук, верстак, печь, кровать — свои
  wrapMethod(bot, 'placeBlock', args => ({ held: bot.heldItem && bot.heldItem.name, ref: args[0], face: args[1] }), (st) => {
    const k = kindOfBlock(st.held); if (!k || !['chest', 'crafting_table', 'furnace', 'bed'].includes(k) || !st.ref || !st.face) return;
    const pp = st.ref.position;
    wm.observe(k, pp.x + st.face.x, pp.y + st.face.y, pp.z + st.face.z, { d: dimOf(bot), src: 'touched', own: true, exact: true });
  });
  // добыто: клетка пропала (лес, руда) — убрать/уменьшить запись
  wrapMethod(bot, 'dig', args => ({ pos: args[0] && args[0].position && { x: args[0].position.x, y: args[0].position.y, z: args[0].position.z }, name: args[0] && args[0].name }), (st) => {
    if (!st.pos) return;
    wm.removeCell(st.pos.x, st.pos.y, st.pos.z, dimOf(bot), { mined: true });
  });
  // легла спать: кровать моя
  wrapMethod(bot, 'sleep', args => ({ block: args[0] }), (st) => {
    const b = st.block; if (!b || !b.position || !/_bed$/.test(b.name || '')) return;
    wm.observe('bed', b.position.x, b.position.y, b.position.z, { d: dimOf(bot), src: 'touched', own: true, exact: true });
  });
}

function onOpened(ctx, bot, block, win) {
  const wm = get(ctx);
  if (!block || !block.position || !win) return;
  const { x, y, z } = block.position; const d = dimOf(bot);
  const k = kindOfBlock(block.name);
  if (k === 'crafting_table' || k === 'furnace') { wm.observe(k, x, y, z, { d, src: 'touched', exact: true }); return; }
  if (k !== 'chest' || block.name === 'ender_chest') return;
  let before = containerCounts(win), finished = false, timer = null;
  wm.setChestItems(x, y, z, d, before, { block: block.name });
  const snap = () => {
    const after = containerCounts(win);
    const mine = gainedAny(before, after); // что-то положили — сундук наш
    wm.setChestItems(x, y, z, d, after, { mine, block: block.name });
    before = after;
  };
  const fin = () => { if (finished) return; finished = true; clearTimeout(timer); try { snap(); } catch (e) {} };
  try {
    if (typeof win.on === 'function') {
      win.on('updateSlot', () => { clearTimeout(timer); timer = setTimeout(() => { if (!finished) { try { snap(); } catch (e) {} } }, 300); if (timer.unref) timer.unref(); });
      win.once('close', fin);
    }
  } catch (e) {}
}

function onEvent(ctx, type, data) {
  const wm = get(ctx);
  if (type === 'death') wm.setDeathCause(data.cause || null, data.at || null);
  else if (type === 'task_done' && data.name === 'recover') {
    const r = data.result || {};
    wm.markRecovered(r.gained || {}, r.itemsLeft || 0);
  }
}

function attach(ctx, bot, session) {
  const wm = get(ctx);
  if (!ctx.wmEventsHooked && ctx.events && typeof ctx.events.push === 'function') {
    ctx.wmEventsHooked = true;
    const orig = ctx.events.push.bind(ctx.events);
    ctx.events.push = (type, data) => { const ev = orig(type, data); try { onEvent(ctx, type, data || {}); } catch (e) {} return ev; };
  }
  const wrapNow = () => { try { hookBot(ctx, bot); } catch (e) {} };
  wrapNow();
  for (const ev of ['inject_allowed', 'login', 'spawn']) bot.once ? bot.once(ev, wrapNow) : null; // плагины mineflayer ставятся чуть позже createBot
  let wasDead = false;
  bot.on('death', () => {
    wasDead = true;
    try {
      const p = bot.entity && bot.entity.position ? bot.entity.position.floored() : null; if (!p) return;
      let inv = invCounts(bot);
      const S = ctx.wmState || {};
      if (!Object.keys(inv).length && S.inv) inv = S.inv; // инвентарь уже пуст — берём последний снимок
      wm.addDeath({ x: p.x, y: p.y, z: p.z, d: dimOf(bot), cause: null, inv });
    } catch (e) {}
  });
  bot.on('spawn', () => {
    try {
      if (bot.spawnPoint) wm.setSpawn(bot.spawnPoint.x, bot.spawnPoint.y, bot.spawnPoint.z, dimOf(bot), 'world');
      if (wasDead && bot.entity) { wasDead = false; const q = bot.entity.position.floored(); wm.setSpawn(q.x, q.y, q.z, dimOf(bot), 'respawn'); }
    } catch (e) {}
  });
  bot.on('blockUpdate', (oldB, newB) => {
    try {
      if (!newB || !newB.position) return;
      const { x, y, z } = newB.position;
      const r = wm.cellIdx.get(key3(dimOf(bot), x, y, z)); if (!r) return;
      if (kindOfBlock(newB.name) === r.k) return;
      if (require('./vision').isVisible(ctx, newB.position)) wm.removeCell(x, y, z, dimOf(bot)); // видим, что блока нет — убрать
    } catch (e) {}
  });
  session.timers.push(setInterval(() => { try { if (ctx.ready && ctx.bot === bot && bot.entity) tick(ctx, bot); } catch (e) { /* память не должна ронять тело */ } }, 2500));
  return wm;
}

// ======================================================================================
// API: /memory, /memory/items, /snapshot.memory, навыки goto_known / where
// ======================================================================================
const NO_BOT = { ok: false, error: 'бот не подключён' };
function parseNear(s, bot) {
  if (s) { const a = String(s).split(/[,\s]+/).map(Number); if (a.length >= 3 && a.every(Number.isFinite)) return { x: a[0], y: a[1], z: a[2] }; }
  const p = bot && bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
}

// GET /memory?kind=iron_ore&near=x,y,z&limit=5[&name=игрок][&own=1][&cleared=1]
function handleMemory(ctx, q) {
  const wm = get(ctx); const bot = ctx.bot;
  const get1 = k => (q && typeof q.get === 'function') ? q.get(k) : (q ? q[k] : null);
  const near = parseNear(get1('near'), bot);
  const d = get1('dim') || dimOf(bot);
  const kind = get1('kind');
  const limit = num(get1('limit'), 5, 1, 50);
  if (!kind) return { ok: true, dim: dimName(d), near: [Math.round(near.x), Math.round(near.y), Math.round(near.z)], kinds: wm.counts(d), total: wm.size, brief: wm.brief(near, d) };
  const kinds = resolveKinds(kind, [...wm.byKind.keys()]);
  const res = wm.near(kinds, near, { limit, d, name: get1('name'), own: ['1', 'true'].includes(String(get1('own'))), includeCleared: ['1', 'true'].includes(String(get1('cleared'))), maxDist: num(get1('maxdist'), 0, 0, 1e6) || undefined });
  return { ok: true, kind: kinds.join(','), dim: dimName(d), near: [Math.round(near.x), Math.round(near.y), Math.round(near.z)], count: res.length, results: res, ...(res.length ? {} : { note: 'не помню такого: сначала найди глазами (explore), память пополняется только увиденным' }) };
}

// GET /memory/items?name=cobblestone — сундуки (с количеством) и дроп со смерти; плюс сколько у меня в инвентаре
function handleItems(ctx, q) {
  const wm = get(ctx); const bot = ctx.bot;
  const get1 = k => (q && typeof q.get === 'function') ? q.get(k) : (q ? q[k] : null);
  const name = get1('name') || get1('item');
  if (!name) return { ok: false, error: 'нет name: пример /memory/items?name=cobblestone' };
  const near = parseNear(get1('near'), bot);
  const found = wm.itemsWhere(name, near, { d: get1('dim') || dimOf(bot), all: ['1', 'true'].includes(String(get1('all'))) });
  let inv = null;
  if (bot && bot.inventory) { const m = invCounts(bot); const q2 = String(name).toLowerCase().replace(/[\s\-]+/g, '_'); inv = m[q2] != null ? m[q2] : Object.entries(m).filter(([n]) => q2.length >= 3 && n.includes(q2)).reduce((s, [, c]) => s + c, 0); }
  return { ok: true, item: String(name), inInventory: inv, count: found.length, total: found.reduce((s, f) => s + f.count, 0), places: found.slice(0, 20), ...(found.length ? {} : { note: 'нигде не вижу в памяти (сундуки учитываются, когда я их открывала)' }) };
}

// навык where: то же, что /memory/items
function where(ctx, p) { return handleItems(ctx, { item: p.item || p.name, near: p.near, all: p.all, dim: p.dim }); }

const ARRIVE = { lava: 7, water: 3, village: 6, player: 4, cave: 3, tree: 3, bed: 2, chest: 2, crafting_table: 2, furnace: 2, death: 2, spawn: 2 };
// навык goto_known kind=iron_ore: идти к ближайшему известному месту вида kind
async function gotoKnown(ctx, t, p) {
  const bot = ctx.bot; const wm = get(ctx);
  const A = require('./actions');
  const kind = String(p.kind || p.block || p.what || '');
  if (!kind) throw new SkillError('нет kind: пример goto_known kind=iron_ore (деревья: tree, ещё water, chest, bed, village, cave, death, player name=…)');
  const kinds = resolveKinds(kind, [...wm.byKind.keys()]);
  const tried = new Set(); let lastErr = null;
  const maxTries = num(p.tries, 3, 1, 6);
  for (let i = 0; i < maxTries; i++) {
    t.check();
    const pos = posOf(bot), d = dimOf(bot);
    const pick = wm.near(kinds, pos, { limit: 10, d, name: p.name, own: p.own === true || p.own === 1 || p.own === '1' }).find(r => !tried.has(r.id) && !(r.kind === 'death' && r.status !== 'lying'));
    if (!pick) break;
    tried.add(pick.id);
    t.progress(`иду к ${labelOf(pick.kind)} ${pick.at.join(' ')} (${pick.dist}м, запись ${Math.round(pick.ageSec / 60)} мин назад)`);
    const rad = ARRIVE[pick.kind] || (pick.kind.endsWith('_ore') ? 3 : 3);
    try {
      await A.goto(ctx, t, new goals.GoalNear(pick.at[0], pick.at[1], pick.at[2], rad), { timeout: num(p.timeout, 90, 10, 300) * 1000, sprint: true });
    } catch (e) { if (e.aborted) throw e; lastErr = e.message; continue; }
    try { require('./vision').refresh(ctx, true); tick(ctx, bot, { full: true }); } catch (e) {}
    const rec = wm.byId(pick.id);
    const still = !!rec && !rec.cleared;
    if (!still && i < maxTries - 1) { lastErr = 'на месте уже ничего нет'; continue; }
    const v = still ? wm._view(rec, posOf(bot)) : null;
    return { kind: pick.kind, at: pick.at, arrived: true, stillThere: still, ...(v ? { n: v.n, distNow: v.dist } : { note: 'пришла, а там уже пусто — запись убрана' }) };
  }
  throw new SkillError(`не дошла ни до одного известного «${kind}»: ${lastErr || 'не помню такого — сначала найди (explore/find)'}`);
}

// collect не нашёл блок вокруг: сходить к ближайшей известной точке (дальше 12 м). true — дошла, ищи снова
async function approachKnown(ctx, t, names, state) {
  try {
    const wm = get(ctx); const bot = ctx.bot;
    const kinds = [...new Set((names || []).map(kindOfBlock).filter(k => k && cfgOf(k) && k !== 'water' && k !== 'lava'))];
    if (!kinds.length) return false;
    const A = require('./actions');
    const tried = state.wmTried || (state.wmTried = new Set());
    while (tried.size < 3) {
      t.check();
      const pos = posOf(bot);
      const pick = wm.near(kinds, pos, { limit: 8, d: dimOf(bot) }).find(r => !tried.has(r.id) && r.dist >= 12 && r.dist <= 400);
      if (!pick) return false;
      tried.add(pick.id);
      t.progress(`в зоне видимости нет, иду к известному (${pick.kind} ${pick.at.join(' ')}, ${pick.dist}м)`);
      try { await A.goto(ctx, t, new goals.GoalNear(pick.at[0], pick.at[1], pick.at[2], 4), { timeout: Math.min(120000, Math.max(30000, pick.dist * 1500)), sprint: true }); }
      catch (e) { if (e.aborted) throw e; continue; }
      try { require('./vision').refresh(ctx, true); tick(ctx, bot, { full: true }); } catch (e) {}
      return true;
    }
  } catch (e) { if (e && e.aborted) throw e; }
  return false;
}

// в /snapshot: короткая выжимка memory (до ~400 символов)
function decorate(ctx, snap) {
  try {
    if (!snap || !snap.ready || !ctx.bot || !ctx.bot.entity) return snap;
    const wm = get(ctx);
    snap.memory = wm.brief(posOf(ctx.bot), dimOf(ctx.bot));
  } catch (e) {}
  return snap;
}

module.exports = {
  WorldMem, get, attach, tick, hookBot, onOpened, onEvent, kindOfBlock, resolveKinds, labelOf,
  handleMemory, handleItems, where, gotoKnown, approachKnown, decorate, caveSize,
  CFG, DEATH_DESPAWN_MS
};
