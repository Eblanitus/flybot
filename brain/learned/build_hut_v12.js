// версия: вариант «достройка по остатку» на основе build_hut (текущая): не пересобирает план целиком, а ставит только недостающие клетки плана (крыша/стены/пол) и дверь с опорой; отчёт «осталось: крыша N/M, дверь: …»; прогон не ухудшает хижину (стоящие блоки плана не трогает, не копает); под дверью ставит опору cobblestone/dirt, а при обрыве — отказывает в двери и предлагает door=north/south/east; материала не хватает — отказ «не хватает: …, осталось N клеток: …», ничего не ломать. По заявке brain/skill_requests/build_hut_alt_finish.md.

const COBBLE = 'cobblestone';
const LOG = 'spruce_log';
const PLANK = 'spruce_planks';
const DOOR = 'spruce_door';
const SIDES = ['west', 'east', 'south', 'north'];
const FACE = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const SIDE4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OUT_DIR = { west: [-1, 0], east: [1, 0], south: [0, 1], north: [0, -1] };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|deep_snow|dirt_path|dead_bush|glow_lichen|vine|moss_carpet|hanging_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|sweet_berry_bush|leaf_litter|wildflowers|brown_mushroom|red_mushroom|fire|firefly_bush)$/;
const FLUID = /water|lava|bubble_column/;
const NOTFULL = /(torch|door|slab|carpet|sign|banner|button|pressure_plate|rail|ladder|chain|flower_pot|bed|sapling|leaves|stairs|candle|flower|pot|wire)$/;
const PROTECTED = /(chest|barrel|furnace|smoker|crafting_table|spawner|anvil|beacon|enchanting_table|brewing_stand|cauldron|lectern|loom|stonecutter|grindstone|piston|observer|hopper|shulker|conduit|bell|target|note_block|jukebox)$/;
const FILLERS = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'dirt', 'coarse_dirt', 'gravel', 'sand', 'netherrack', 'stone_bricks', 'calcite', 'dripstone_block', 'blackstone', 'mud_bricks'];
const SCAFFOLD_ITEMS = ['dirt', 'coarse_dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'blackstone'];

const isDry = p => p && (p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true');
const short = m => String(m === undefined || m === null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim().slice(0, 160);
const k3 = (x, y, z) => x + ',' + y + ',' + z;
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isAirName = n => typeof n === 'string' && /^(air|cave_air|void_air)$/.test(n);
const isHard = b => b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b) && !NOTFULL.test(b) && !PROTECTED.test(b);
const cellState = b => {
  if (b === '?' || b === undefined || b === null) return 'unknown';
  if (AIRLIKE.test(b)) return 'air';
  if (FLUID.test(b)) return 'fluid';
  if (PROTECTED.test(b)) return 'protected';
  if (isHard(b)) return 'built';
  return 'soft';
};
// блок плана: снег на месте крыши — не крыша (под ним дыра, крышу надо ставить)
const isPlanBlock = (kind, name) => {
  if (kind === 'roof' && /^(snow|snow_block|ice|packed_ice)$/.test(name)) return false;
  return isHard(name);
};
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const lessKey = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] === undefined ? 0 : a[i], y = b[i] === undefined ? 0 : b[i]; if (x !== y) return x < y; } return false; };

// ---------- план (та же геометрия, что у build_hut) ----------
function makePlan(ix, iz, fy, door, windowSide, roof, corners) {
  const ox1 = ix - 1, ox2 = ix + 5, oz1 = iz - 1, oz2 = iz + 5;
  const sideCell = side => ({
    west: { x: ox1, z: iz + 2 }, east: { x: ox2, z: iz + 2 },
    south: { x: ix + 2, z: oz2 }, north: { x: ix + 2, z: oz1 }
  })[side];
  const dc = sideCell(door);
  let wc = null;
  if (windowSide) {
    const c = sideCell(windowSide);
    wc = windowSide === door ? (c.x === ox1 || c.x === ox2 ? { x: c.x, z: c.z - 2 } : { x: c.x - 2, z: c.z }) : c;
  }
  const ring = (x, z) => x === ox1 || x === ox2 || z === oz1 || z === oz2;
  const isCorner = (x, z) => (x === ox1 || x === ox2) && (z === oz1 || z === oz2);
  const cells = [];
  for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    cells.push({ x, y: fy, z, kind: 'floor', ring: ring(x, z), corner: false, prefs: [COBBLE] });
  }
  for (let y = fy + 1; y <= fy + 3; y++) for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    if (!ring(x, z)) continue;
    if (x === dc.x && z === dc.z && y <= fy + 2) continue;
    if (wc && x === wc.x && z === wc.z && y === fy + 2) continue;
    const corner = isCorner(x, z);
    const prefs = (corner && y <= fy + 2 && corners === 'log') ? [LOG, COBBLE] : [COBBLE];
    cells.push({ x, y, z, kind: 'wall', ring: true, corner, prefs });
  }
  const cx = ix + 2, cz = iz + 2;
  for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    const r = ring(x, z);
    const prefs = (roof === 'mixed' && r) ? [COBBLE, PLANK] : [PLANK, COBBLE];
    cells.push({ x, y: fy + 4, z, kind: 'roof', ring: r, corner: isCorner(x, z), prefs, dist: Math.max(Math.abs(x - cx), Math.abs(z - cz)) });
  }
  return { cells, door: { x: dc.x, y: fy + 1, z: dc.z }, window: wc ? { x: wc.x, y: fy + 2, z: wc.z } : null, box: { ox1, ox2, oz1, oz2 } };
}

// ---------- survey -> карта ----------
function makeWorld(sv) {
  const cells = new Map(), heights = new Map();
  const ox = sv.origin.x, oz = sv.origin.z;
  for (const key of Object.keys(sv.layers || {})) {
    const y = Number(key.slice(2));
    (sv.layers[key] || []).forEach((row, zi) => {
      for (let xi = 0; xi < row.length; xi++) {
        const name = (sv.legend && sv.legend[row[xi]]) || '?';
        cells.set((ox + xi) + ',' + y + ',' + (oz + zi), name);
      }
    });
  }
  (sv.heightmap || []).forEach((row, zi) => row.forEach((h, xi) => {
    if (h !== null && h !== undefined) heights.set((ox + xi) + ',' + (oz + zi), h);
  }));
  return {
    get: (x, y, z) => { const v = cells.get(k3(x, y, z)); return v === undefined ? '?' : v; },
    set: (x, y, z, n) => cells.set(k3(x, y, z), n),
    height: (x, z) => { const v = heights.get(x + ',' + z); return v === undefined ? null : v; },
    each: fn => { for (const [k, v] of cells) fn(k, v); }
  };
}

module.exports = {
  name: 'build_hut',
  description: 'Достройка хижины по остатку: НЕ пересобирает план целиком, а ставит только недостающие клетки (крыша/стены/пол) и дверь с опорой. Подходит, когда хижина уже почти готова (финальный штрих); не подходит, если хижины ещё нет — тогда обычный build_hut. Прогон не ухудшает хижину: стоящие блоки плана не трогает, не копает. Под дверью ставит опору cobblestone/dirt, а если обрыв — отказывает в двери и предлагает door=north/south/east. Материала не хватает — отказ «не хватает: …, осталось N клеток: …», ничего не ломать.',
  params: {
    x: 'x внутреннего юго-западного угла (минимум)',
    z: 'z внутреннего юго-западного угла (минимум)',
    y: 'y верхнего блока пола (на нём стоят внутри)',
    door: 'сторона двери: west (по умолчанию), east, south, north — при обрыве предлагает другие',
    window: 'none (окно не ставится)',
    roof: 'planks (по умолчанию) или mixed (край булыжником, середина досками)',
    corners: 'log (по умолчанию) или cobble',
    max_sec: 'ограничение времени, по умолчанию 900',
    dry: '1 — только расчёт need/have/missing, ничего не строить',
    cells: 'список клеток остатка [{"x","y","z","kind"?}] — если задан, ставим только их, иначе считаем по survey'
  },

  async run(api, params) {
    try { return await runInner(api, params); }
    catch (e) { return { ok: false, error: 'достройка недоступна: ' + short(e && e.message ? e.message : e), sec: 0 }; }
  }
};

async function runInner(api, params) {
  const pr = params || {};
  const ix = Math.round(numOr(pr.x, NaN)), iz = Math.round(numOr(pr.z, NaN)), fy = Math.round(numOr(pr.y, NaN));
  const t0 = Date.now();
  const sec = () => Math.round((Date.now() - t0) / 1000);
  if (![ix, iz, fy].every(Number.isFinite)) return { ok: false, error: 'нужны x, z (внутренний юго-западный угол) и y (верх пола)', sec: sec() };
  const door = SIDES.includes(pr.door) ? pr.door : 'west';
  const roof = pr.roof === 'mixed' ? 'mixed' : 'planks';
  const corners = pr.corners === 'cobble' ? 'cobble' : 'log';
  const dry = isDry(pr);
  const maxSec = Math.min(Math.max(numOr(pr.max_sec, 900), 60), 1800);
  const deadline = t0 + maxSec * 1000;
  const notes = [];
  const stages = {};
  const P = makePlan(ix, iz, fy, door, null, roof, corners);
  const { ox1, ox2, oz1, oz2 } = P.box;
  const roofY = fy + 4;
  const insideFloor = (x, z) => x >= ix && x <= ix + 4 && z >= iz && z <= iz + 4;
  const isWallCell = (x, z) => x >= ox1 && x <= ox2 && z >= oz1 && z <= oz2 && (x === ox1 || x === ox2 || z === oz1 || z === oz2);

  // ---------- инвентарь ----------
  const stock = {};
  const refreshStock = async () => {
    try {
      const s = await api.snapshot();
      Object.keys(stock).forEach(k => delete stock[k]);
      Object.assign(stock, invMap(s.inventory));
    } catch (e) { /* оставим как есть */ }
  };
  await refreshStock();
  const stockOf = k => stock[k] || 0;
  const take = prefs => { for (const it of prefs) if ((stock[it] || 0) > 0) { stock[it]--; return it; } return null; };
  const give = it => { if (it) stock[it] = (stock[it] || 0) + 1; };

  // ---------- знание о клетках ----------
  const known = new Map();
  const kindByKey = new Map();
  for (const c of P.cells) kindByKey.set(k3(c.x, c.y, c.z), c.kind);
  const stOf = (x, y, z) => { const e = known.get(k3(x, y, z)); return e ? e.st : 'unknown'; };
  const blockOf = (x, y, z) => { const e = known.get(k3(x, y, z)); return e ? e.block : 'неизвестно'; };
  const setSt = (x, y, z, st, block) => known.set(k3(x, y, z), { st, block: block || '', seen: true });
  const stateOf = (key, name) => {
    const st = cellState(name);
    if (st !== 'built') return st;
    const kind = kindByKey.get(key);
    return (kind && !isPlanBlock(kind, name)) ? 'air' : st;
  };
  const applyWorld = world => {
    const seen = new Set();
    world.each((k, name) => {
      const st = stateOf(k, name);
      if (st === 'unknown') return;
      seen.add(k);
      known.set(k, { st, block: name, seen: true });
    });
    for (const c of P.cells) {
      const e = known.get(k3(c.x, c.y, c.z));
      if (e && !seen.has(k3(c.x, c.y, c.z))) e.seen = false;
    }
  };

  // ---------- снимок, позиция ----------
  let snap = null, lastPos = null;
  const takeSnap = async () => { try { snap = await api.snapshot(); lastPos = (snap && snap.position) || lastPos; return snap; } catch (e) { return null; } };
  const refreshPos = async () => { await takeSnap(); return lastPos || {}; };
  const distOf = e => (e && e.d != null && Number.isFinite(Number(e.d))) ? Number(e.d) : Infinity;

  // быстрая безопасность: не держать тело на краю при мобе/ночи/низком HP — отдать тело сразу
  const s0 = await takeSnap();
  if (s0) {
    const eyes = s0.eyes || {}, tm = eyes.time || {};
    const nightIn = Number.isFinite(Number(tm.nightIn)) ? Number(tm.nightIn) : null;
    if (nightIn != null && nightIn <= 30) return { ok: false, error: 'ночь (или скоро) — достройку не начинаю, тело отдаю', why: 'night', sec: sec() };
    const en = (eyes.enemies || []).filter(e => distOf(e) <= 8);
    if (en.length) return { ok: false, error: 'моб рядом: ' + en[0].name + ' ' + distOf(en[0]) + ' м — тело отдаю', why: 'mob', sec: sec() };
    const hp = Number(s0.health);
    if (Number.isFinite(hp) && hp < 8) return { ok: false, error: 'HP ' + hp + ' — тело отдаю', why: 'hp', sec: sec() };
  }

  // ---------- подойти к площадке ----------
  const p0 = lastPos || (await refreshPos());
  if (Math.hypot((p0.x || 0) - (ix + 2), (p0.z || 0) - (iz + 2)) > 9) {
    try { await api.cmd('goto', { x: ix + 2, z: iz + 6, timeout: 20 }); await refreshPos(); }
    catch (e) { return { ok: false, error: 'не дошла до площадки: ' + short(e.message), sec: sec() }; }
  }

  // ---------- survey ----------
  const svBox = { x1: ox1 - 3, y1: fy - 3, z1: oz1 - 3, x2: ox2 + 3, y2: fy + 5, z2: oz2 + 3 };
  let sv;
  try { sv = await api.cmd('survey', svBox); }
  catch (e) { return { ok: false, error: 'survey: ' + short(e.message), sec: sec() }; }
  const W = makeWorld(sv);
  applyWorld(W);

  // ---------- список остатка (только недостающие клетки плана) ----------
  const todo = [];
  if (Array.isArray(pr.cells) && pr.cells.length) {
    for (const c of pr.cells) {
      const k = k3(c.x, c.y, c.z);
      if (kindByKey.has(k) && !(c.x === P.door.x && c.z === P.door.z && c.y <= fy + 2)) {
        todo.push({ x: c.x, y: c.y, z: c.z, kind: c.kind || kindByKey.get(k), prefs: c.prefs || [COBBLE] });
      }
    }
  } else {
    for (const c of P.cells) {
      if (stOf(c.x, c.y, c.z) !== 'built') todo.push(c);
    }
  }
  const todoAll = todo.length;
  const alreadyAtStart = P.cells.length - todoAll;
  const roofTotal = P.cells.filter(c => c.kind === 'roof').length;
  const wallTotal = P.cells.filter(c => c.kind === 'wall').length;
  const floorTotal = P.cells.filter(c => c.kind === 'floor').length;

  const already = {};
  for (const c of P.cells) {
    const st = stOf(c.x, c.y, c.z);
    if (st === 'built') { already[c.kind] = (already[c.kind] || 0) + 1; }
  }

  // ---------- нужно материала ----------
  const need = {};
  const addNeed = (item, n = 1) => { if (item) need[item] = (need[item] || 0) + n; };
  for (const c of todo) addNeed((c.prefs && c.prefs[0]) || COBBLE);

  // дверь + опора под дверь
  const doorAlready = /_door$/.test(blockOf(P.door.x, P.door.y, P.door.z));
  let doorSupportNeed = false;
  if (!doorAlready) {
    addNeed(DOOR);
    const supSt = stOf(P.door.x, fy, P.door.z);
    if (supSt !== 'built') { doorSupportNeed = true; addNeed(COBBLE); }
  }
  const missing = {};
  for (const k of Object.keys(need)) { const h = stockOf(k); if (h < need[k]) missing[k] = need[k] - h; }
  const notBuiltCells = [];
  for (const c of todo) notBuiltCells.push([c.x, c.y, c.z].join(' '));
  if (!doorAlready) notBuiltCells.push([P.door.x, P.door.y, P.door.z].join(' '));

  if (dry) {
    const r = { ok: true, dry: true, need, have: {}, missing, plan: 'достройка остатка', door: P.door, todo: todoAll, already: alreadyAtStart, already_by_kind: already, not_built: notBuiltCells };
    for (const k of Object.keys(need)) r.have[k] = stockOf(k);
    if (Object.keys(missing).length) r.hint = `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${stockOf(k) + n}`).join(',')}"`;
    return r;
  }

  if (Object.keys(missing).length) {
    return { ok: false, error: 'не хватает: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ') + '; осталось ' + notBuiltCells.length + ' клеток: ' + notBuiltCells.slice(0, 12).join(', '), need, have: {}, missing, already: alreadyAtStart, already_by_kind: already, not_built: notBuiltCells, sec: sec() };
  }
  for (const k of Object.keys(need)) { /* have already in stock */ }

  // ---------- размещение ----------
  const placed = {};
  const failed = [];
  const nbrs = c => { let n = 0; for (const [dx, dy, dz] of FACE) if (isHard(W.get(c.x + dx, c.y + dy, c.z + dz))) n++; return n; };
  const isVoidColumn = (x, z) => W.height(x, z) === null;
  const onEdge = (x, y, z) => {
    const below = W.get(x, y - 1, z);
    if (below !== '?' && !isHard(below)) return true;
    if (isVoidColumn(x, z) && x >= ox1 && x <= ox2 && z >= oz1 && z <= oz2) return true;
    return false;
  };
  const botOverlaps = (x, y, z) => {
    const p = lastPos;
    if (!p) return false;
    const px = Number(p.x), py = Number(p.y), pz = Number(p.z);
    if (![px, py, pz].every(Number.isFinite)) return false;
    return x < px + 0.3 && x + 1 > px - 0.3 && z < pz + 0.3 && z + 1 > pz - 0.3 && y < py + 1.8 && y + 1 > py;
  };
  const stepAside = async cell => {
    await refreshPos();
    if (!botOverlaps(cell.x, cell.y, cell.z)) return true;
    const cands = [];
    for (const [dx, dz] of SIDE4) {
      for (const d of [0, 1]) {
        const nx = cell.x + dx * (1 + d), nz = cell.z + dz * (1 + d);
        const ny = cell.y;
        if (botOverlaps(nx, ny, nz)) continue;
        if (!isHard(W.get(nx, ny - 1, nz))) continue;
        if (isVoidColumn(nx, nz)) continue;
        cands.push({ x: nx, y: ny, z: nz });
      }
    }
    for (const s of cands) {
      try { await api.cmd('goto', { x: s.x, y: s.y, z: s.z, timeout: 12 }); } catch (e) { continue; }
      await refreshPos();
      if (!botOverlaps(cell.x, cell.y, cell.z)) return true;
    }
    return false;
  };
  const placeOne = async (x, y, z, item) => { try { await api.cmd('place_at', { x, y, z, item }); return { ok: true }; } catch (e) { return { ok: false, err: short(e.message) }; } };
  const placeSafe = async (cell, item) => {
    let r = await placeOne(cell.x, cell.y, cell.z, item);
    if (r.ok) return { ok: true };
    if (!/стоит на месте установки/.test(String(r.err || ''))) return r;
    const moved = await stepAside(cell);
    if (!moved) return r;
    r = await placeOne(cell.x, cell.y, cell.z, item);
    return r;
  };
  const whyNot = (x, y, z, err) => {
    const e = String(err || '');
    if (/занят/.test(e)) return 'место занято: ' + W.get(x, y, z);
    if (/нет в инвентаре/.test(e)) return 'нет блока в инвентаре';
    if (/стоит на месте установки/.test(e)) return 'муха стоит на этой клетке — сойти некуда';
    if (/не к чему прислонить/.test(e)) {
      const below = W.get(x, y - 1, z), above = W.get(x, y + 1, z);
      let sides = 0;
      for (const [dx, dz] of SIDE4) if (isHard(W.get(x + dx, y, z + dz))) sides++;
      return `не к чему прислонить (снизу ${below}, сверху ${above}, сбоку твёрдых ${sides}/4)`;
    }
    if (/недоступно|не могу подойти|подойти|нет пути|путь не найден|слишком долго/.test(e)) return 'не подошла: ' + short(e);
    return short(e) || 'причина неизвестна';
  };
  const probe = async (x, y, z) => { try { const r = await api.cmd('look_at', { x, y, z }); return (r && typeof r.looking === 'string') ? r.looking : null; } catch (e) { return null; } };
  const probeCell = async cell => {
    const st = stOf(cell.x, cell.y, cell.z);
    if (st === 'built') return 'built';
    if (st === 'protected' || st === 'fluid') return 'blocked';
    if (st === 'unknown') {
      const seen = await probe(cell.x, cell.y, cell.z);
      if (seen !== null) {
        const s2 = stateOf(k3(cell.x, cell.y, cell.z), seen);
        setSt(cell.x, cell.y, cell.z, s2, seen);
        if (s2 === 'built') return 'built';
        if (s2 === 'protected' || s2 === 'fluid') return 'blocked';
      }
    }
    return 'todo';
  };

  // опора под дверь
  let doorOk = doorAlready;
  let doorWhy = '';
  let doorSupportPlaced = false;
  if (!doorAlready && doorSupportNeed) {
    const r = await placeOne(P.door.x, fy, P.door.z, COBBLE);
    if (r.ok) {
      placed[COBBLE] = (placed[COBBLE] || 0) + 1;
      W.set(P.door.x, fy, P.door.z, COBBLE);
      setSt(P.door.x, fy, P.door.z, 'built', COBBLE);
      doorSupportPlaced = true;
      notes.push('опора под дверь поставлена ' + P.door.x + ' ' + fy + ' ' + P.door.z);
    } else {
      const r2 = await placeOne(P.door.x, fy, P.door.z, 'dirt');
      if (r2.ok) {
        placed['dirt'] = (placed['dirt'] || 0) + 1;
        W.set(P.door.x, fy, P.door.z, 'dirt');
        setSt(P.door.x, fy, P.door.z, 'built', 'dirt');
        doorSupportPlaced = true;
        notes.push('опора под дверь (dirt) поставлена ' + P.door.x + ' ' + fy + ' ' + P.door.z);
      } else {
        doorWhy = 'под дверью обрыв, опору не поставить (' + whyNot(P.door.x, fy, P.door.z, r2.err) + ')';
      }
    }
  }

  // встать внутри хижины для крыши
  const botInside = () => { const p = lastPos || {}; return p.x >= ox1 && p.x <= ox2 + 1 && p.z >= oz1 && p.z <= oz2 + 1 && Math.floor(p.y || 0) >= fy && Math.floor(p.y || 0) <= fy + 3; };
  const enterHut = async () => {
    await refreshPos();
    if (botInside()) return { ok: true, how: 'уже внутри' };
    const tryGoto = async (x, y, z) => { try { await api.cmd('goto', { x, y, z, timeout: 20 }); await refreshPos(); return true; } catch (e) { return false; } };
    const doorIn = { x: P.door.x + (P.door.x === ox1 ? 1 : P.door.x === ox2 ? -1 : 0), y: fy + 1, z: P.door.z + (P.door.z === oz1 ? 1 : P.door.z === oz2 ? -1 : 0) };
    if (await tryGoto(doorIn.x, doorIn.y, doorIn.z)) return { ok: true, how: 'через проём двери' };
    if (await tryGoto(ix + 2, fy + 1, iz + 2)) return { ok: true, how: 'в центр' };
    return { ok: false, why: 'не попала внутрь' };
  };

  const safeSpot = () => {
    const inner = [];
    for (let x = ix; x <= ix + 4; x++) for (let z = iz; z <= iz + 4; z++) {
      const h = W.height(x, z);
      if (h !== null && h >= fy) inner.push({ x, y: h + 1, z });
    }
    inner.sort((a, b) => (Math.abs(a.x - (ix + 2)) + Math.abs(a.z - (iz + 2))) - (Math.abs(b.x - (ix + 2)) + Math.abs(b.z - (iz + 2))));
    if (inner.length) return inner[0];
    const outer = [];
    for (const [dx, dz] of SIDE4) {
      for (const d of [0, 1, 2]) {
        const nx = ix + 2 + dx * (3 + d), nz = iz + 2 + dz * (3 + d);
        const h = W.height(nx, nz);
        if (h !== null && h >= fy) outer.push({ x: nx, y: h + 1, z });
      }
    }
    return outer.length ? outer[0] : null;
  };
  const leaveEdge = async why => {
    const p = await refreshPos();
    if (!p || !Number.isFinite(Number(p.x))) return false;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    if (!onEdge(bx, by, bz)) return false;
    const spot = safeSpot();
    if (!spot) { notes.push('край: ' + why + ' — уйти некуда'); return false; }
    try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 12 }); await refreshPos(); notes.push('край (' + bx + ' ' + bz + '): ' + why + ' — ушла на ' + spot.x + ' ' + spot.y + ' ' + spot.z); return true; }
    catch (e) { notes.push('край (' + bx + ' ' + bz + '): ' + why + ' — уйти не удалось: ' + short(e.message)); return false; }
  };

  // поставить одну клетку (стоящие не трогаем)
  const doCell = async cell => {
    const st = stOf(cell.x, cell.y, cell.z);
    if (st === 'built') { byKindPlace(cell.kind).already++; return 'already'; }
    if (st === 'protected') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + blockOf(cell.x, cell.y, cell.z) }); return 'blocked'; }
    if (st === 'fluid') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'вода/лава — строить нельзя' }); return 'blocked'; }
    const pr2 = await probeCell(cell);
    if (pr2 === 'built') { byKindPlace(cell.kind).already++; return 'already'; }
    if (pr2 === 'blocked') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + blockOf(cell.x, cell.y, cell.z) }); return 'blocked'; }
    let item = take((cell.prefs || [COBBLE]).concat(FILLERS, [PLANK]));
    if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'нет блока в инвентаре (' + ((cell.prefs || [COBBLE]).join('/')) + ')' }); return 'nomaterial'; }
    let r = await placeSafe(cell, item);
    if (!r.ok && /нет в инвентаре/.test(String(r.err || ''))) {
      await refreshStock();
      give(item);
      item = take((cell.prefs || [COBBLE]).concat(FILLERS, [PLANK]));
      if (item) r = await placeSafe(cell, item);
    }
    if (!r.ok) {
      const err = String(r.err || '');
      if (/занят/.test(err)) {
        give(item);
        W.set(cell.x, cell.y, cell.z, 'cobblestone');
        setSt(cell.x, cell.y, cell.z, 'built', 'cobblestone');
        byKindPlace(cell.kind).placed++;
        return 'occupied';
      }
      give(item);
      const why = whyNot(cell.x, cell.y, cell.z, err);
      failed.push({ at: [cell.x, cell.y, cell.z], why });
      if (onEdge(cell.x, cell.y, cell.z)) await leaveEdge(why);
      return 'failed';
    }
    placed[item] = (placed[item] || 0) + 1;
    W.set(cell.x, cell.y, cell.z, item);
    setSt(cell.x, cell.y, cell.z, 'built', item);
    byKindPlace(cell.kind).placed++;
    return 'placed';
  };
  const byKindPlace = { floor: { already: 0, todo: 0, placed: 0 }, wall: { already: 0, todo: 0, placed: 0 }, roof: { already: 0, todo: 0, placed: 0 } };

  // порядок: крыша (от края к центру), стены, пол — только недостающие
  const roofCells = todo.filter(c => c.kind === 'roof').sort((a, b) => a.dist - b.dist || a.z - b.z || a.x - b.x);
  const wallCells = todo.filter(c => c.kind === 'wall');
  const floorCells = todo.filter(c => c.kind === 'floor');

  const placeList = async list => {
    for (const cell of list) {
      if (Date.now() > deadline) { notes.push('достройка: время вышло, осталось ' + (list.length)); break; }
      await doCell(cell);
    }
  };

  // крыша: пробуем встать внутри/на гребне стены, при需要 леса
  const floorSolid = (x, z) => isHard(W.get(x, fy, z));
  const standSpots = cell => {
    const out = [];
    const pushFloor = (x, z, how) => {
      if (out.some(s => s.x === x && s.z === z)) return;
      if (!floorSolid(x, z)) return;
      out.push({ x, y: fy + 1, z, how });
    };
    if (insideFloor(cell.x, cell.z)) pushFloor(cell.x, cell.z, 'под клеткой, на полу');
    for (const [dx, dz] of SIDE4) {
      const nx = cell.x + dx, nz = cell.z + dz;
      if (insideFloor(nx, nz)) pushFloor(nx, nz, 'рядом с клеткой, на полу');
    }
    for (const [dx, dz] of SIDE4) {
      const nx = cell.x + dx, nz = cell.z + dz;
      if (!isWallCell(nx, nz)) continue;
      if (isHard(W.get(nx, roofY, nz))) continue;
      if (!isHard(W.get(nx, roofY - 1, nz))) continue;
      out.push({ x: nx, y: roofY, z: nz, how: 'на гребне стены' });
    }
    return out;
  };
  const standAt = async spot => {
    const p = await refreshPos();
    const dx = Math.abs((p.x || 0) - (spot.x + 0.5)), dz = Math.abs((p.z || 0) - (spot.z + 0.5));
    const dy = Math.abs(Math.floor(p.y || 0) - spot.y);
    if (dx < 0.9 && dz < 0.9 && dy <= 1) return { ok: true };
    try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 15 }); await refreshPos(); return { ok: true }; }
    catch (e) { return { ok: false, why: 'не встала (' + spot.how + '): ' + short(e.message) }; }
  };
  const ensureBelow = async cell => {
    const bx = cell.x, by = roofY - 1, bz = cell.z;
    if (!isWallCell(bx, bz)) return false;
    if (isHard(W.get(bx, by, bz))) return true;
    const item = take([COBBLE, LOG, PLANK].concat(FILLERS));
    if (!item) return false;
    const r = await placeOne(bx, by, bz, item);
    if (r.ok) { placed[item] = (placed[item] || 0) + 1; W.set(bx, by, bz, item); setSt(bx, by, bz, 'built', item); return true; }
    give(item);
    return false;
  };
  let scaffold = null;
  const scaffoldFor = async cell => {
    const p = await refreshPos();
    const feet = Math.floor(p.y || 0);
    if (scaffold && feet >= roofY - 1 && Math.abs((p.x || 0) - (scaffold.x + 0.5)) < 3 && Math.abs((p.z || 0) - (scaffold.z + 0.5)) < 3) return { ok: true };
    const outs = [];
    for (const [dx, dz] of SIDE4) {
      const nx = cell.x + dx, nz = cell.z + dz;
      if (nx >= ox1 && nx <= ox2 && nz >= oz1 && nz <= oz2) continue;
      const h = W.height(nx, nz);
      if (h === null || h < fy) continue;
      outs.push({ x: nx, z: nz, y: h + 1 });
    }
    if (!outs.length) return { ok: false, why: 'нет места снаружи для лесов (везде обрыв)' };
    const spot = outs[0];
    try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 20 }); }
    catch (e) { return { ok: false, why: 'не подошла к месту лесов: ' + short(e.message) }; }
    const item = take(SCAFFOLD_ITEMS);
    if (!item) return { ok: false, why: 'нет блоков на леса (нужен dirt/cobblestone/stone)' };
    const here = await refreshPos();
    const needH = Math.max(1, roofY - Math.floor((here.y || 0)));
    try {
      await api.cmd('pillar_up', { height: needH, item });
      scaffold = { x: spot.x, z: spot.z, top: roofY - 1, base: Math.floor((here.y || 0)), item };
      return { ok: true };
    } catch (e) { give(item); return { ok: false, why: 'леса не выросли: ' + short(e.message) }; }
  };

  const placeRoof = async cell => {
    if (Date.now() > deadline) return 'failed';
    const st = stOf(cell.x, cell.y, cell.z);
    if (st === 'built') { byKindPlace.roof.already++; return 'already'; }
    const pr2 = await probeCell(cell);
    if (pr2 === 'built') { byKindPlace.roof.already++; return 'already'; }
    if (pr2 === 'blocked') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + blockOf(cell.x, cell.y, cell.z) }); return 'blocked'; }
    let item = take(cell.prefs.concat(FILLERS, [PLANK]));
    if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'нет блока в инвентаре (' + cell.prefs.join('/') + ')' }); return 'nomaterial'; }
    const inHut = await enterHut();
    let done = false, last = 'не нашлось места, откуда поставить';
    const spots = inHut.ok ? standSpots(cell) : [];
    for (const spot of spots) {
      const st2 = await standAt(spot);
      if (!st2.ok) { last = st2.why; continue; }
      let r = await placeSafe(cell, item);
      if (r.ok) { done = true; break; }
      last = whyNot(cell.x, cell.y, cell.z, r.err);
      if (/прислонить/.test(String(r.err || '')) && await ensureBelow(cell)) {
        r = await placeSafe(cell, item);
        if (r.ok) { done = true; break; }
        last = whyNot(cell.x, cell.y, cell.z, r.err);
      }
      if (/занят/.test(String(r.err || ''))) { done = true; break; }
    }
    if (!done && !inHut.ok) {
      const sc = await scaffoldFor(cell);
      if (sc.ok) {
        const r = await placeSafe(cell, item);
        if (r.ok) done = true;
        else last = whyNot(cell.x, cell.y, cell.z, r.err);
      } else last = last + '; ' + sc.why;
    }
    if (done) {
      placed[item] = (placed[item] || 0) + 1;
      W.set(cell.x, cell.y, cell.z, item);
      setSt(cell.x, cell.y, cell.z, 'built', item);
      byKindPlace.roof.placed++;
      return 'placed';
    }
    give(item);
    failed.push({ at: [cell.x, cell.y, cell.z], why: last });
    if (onEdge(cell.x, cell.y, cell.z)) await leaveEdge(last);
    return 'failed';
  };

  await stageRun('крыша', roofCells, placeRoof);
  await stageRun('стены', wallCells, placeList);
  await stageRun('пол', floorCells, placeList);

  // дверь (после опоры)
  if (!doorAlready && !doorWhy) {
    const it = take(Object.keys(stock).filter(n => /_door$/.test(n)));
    if (!it) { doorWhy = 'нет двери в инвентаре (spruce_door)'; }
    else {
      const od = OUT_DIR[door] || [-1, 0];
      const outX = P.door.x + od[0], outZ = P.door.z + od[1];
      const outH = W.height(outX, outZ);
      if (outH !== null && outH >= fy) {
        try { await api.cmd('goto', { x: outX, z: outZ, timeout: 15 }); } catch (e) { /* поставим как есть */ }
      } else {
        notes.push('дверь: снаружи обрыв (' + outX + ' ' + outZ + ') — не иду туда, ставлю изнутри');
      }
      try { await api.cmd('look_at', { x: P.door.x, y: P.door.y, z: P.door.z }); } catch (e) { /* не критично */ }
      const r = await placeSafe(P.door, it);
      if (r.ok) {
        placed[it] = (placed[it] || 0) + 1;
        W.set(P.door.x, P.door.y, P.door.z, it);
        setSt(P.door.x, P.door.y, P.door.z, 'built', it);
        doorOk = true;
      } else {
        give(it);
        doorWhy = whyNot(P.door.x, P.door.y, P.door.z, r.err);
        failed.push({ at: [P.door.x, P.door.y, P.door.z], why: doorWhy });
        if (onEdge(P.door.x, P.door.y, P.door.z)) await leaveEdge(doorWhy);
      }
    }
  }

  // ---------- итоговый survey (что на самом деле стоит) ----------
  await api.sleep(400);
  try { applyWorld(makeWorld(await api.cmd('survey', svBox))); }
  catch (e) { notes.push('итоговый survey: ' + short(e.message)); }
  let probed = 0;
  for (const c of P.cells) {
    if (probed >= 60) { notes.push('проверено глазами ' + probed + ' клеток'); break; }
    const st = stOf(c.x, c.y, c.z);
    if (st === 'built') continue;
    if (st !== 'unknown') continue;
    const seen = await probe(c.x, c.y, c.z);
    probed++;
    if (seen === null) continue;
    const s2 = stateOf(k3(c.x, c.y, c.z), seen);
    setSt(c.x, c.y, c.z, s2, seen);
  }
  const kindStat = { floor: { stand: 0, total: floorTotal }, wall: { stand: 0, total: wallTotal }, roof: { stand: 0, total: roofTotal } };
  const holes = {};
  for (const c of P.cells) {
    kindStat[c.kind].total++;
    if (stOf(c.x, c.y, c.z) === 'built') kindStat[c.kind].stand++;
    else { if (!holes[c.kind]) holes[c.kind] = []; holes[c.kind].push([c.x, c.y, c.z].join(' ')); }
  }
  doorOk = doorOk || /_door$/.test(blockOf(P.door.x, P.door.y, P.door.z));
  await leaveEdge('конец достройки');

  const allNonDoorPlaced = kindStat.floor.stand >= floorTotal && kindStat.wall.stand >= wallTotal && kindStat.roof.stand >= roofTotal;
  const roofLeft = roofTotal - kindStat.roof.stand;
  const wallLeft = wallTotal - kindStat.wall.stand;
  const floorLeft = floorTotal - kindStat.floor.stand;
  const doorSuggest = SIDES.filter(s => s !== door);
  const doorText = doorOk ? 'поставлена' : (doorWhy ? 'не поставить: ' + doorWhy : 'уже стоит');
  const message = 'осталось: крыша ' + roofLeft + '/' + roofTotal + '; стены ' + wallLeft + '/' + wallTotal + '; пол ' + floorLeft + '/' + floorTotal + '; дверь: ' + doorText + (doorSuggest.length && !doorOk ? ' (попробуйте door=' + doorSuggest.join('/') + ')' : '');
  const res = {
    ok: allNonDoorPlaced,
    left: { крыша: { left: roofLeft, total: roofTotal }, стены: { left: wallLeft, total: wallTotal }, пол: { left: floorLeft, total: floorTotal }, дверь: { placed: doorOk, reason: doorWhy || null, suggest: doorSuggest } },
    message,
    message_ru: message,
    placed, dug: 0, need, have: stock, missing: Object.keys(missing).length ? missing : null,
    already: alreadyAtStart, already_by_kind: already, by_kind: byKindPlace,
    holes, holes_list: (holes.roof || []).concat(holes.wall || []).concat(holes.floor || []).slice(0, 20),
    door: P.door, window: P.window, floorY: fy,
    stages, notes, sec: sec()
  };
  if (doorSupportPlaced) res.door_support = { x: P.door.x, y: fy, z: P.door.z };
  if (!allNonDoorPlaced || !doorOk) {
    const parts = [];
    if (roofLeft > 0) parts.push('крыша ' + roofLeft + '/' + roofTotal + ' не хватает: ' + (holes.roof || []).slice(0, 8).join(', '));
    if (wallLeft > 0) parts.push('стены ' + wallLeft + '/' + wallTotal);
    if (floorLeft > 0) parts.push('пол ' + floorLeft + '/' + floorTotal);
    if (!doorOk) parts.push('дверь: ' + (doorWhy || 'не поставлена'));
    res.error = 'осталось: ' + parts.join('; ');
  }
  return res;
}

async function stageRun(name, list, fn) {
  let n = 0;
  for (const cell of list) {
    const r = await fn(cell);
    if (r === 'placed' || r === 'occupied') n++;
  }
  api.log(name + ': поставлено ' + n + ' из ' + list.length);
}
