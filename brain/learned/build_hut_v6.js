// версия: копает только то, чем сразу заменит; углы после соседей, подпорка при «не к чему прислонить»; леса pillar_up для крыши; на крышу не хватило — строит из того, что есть; max_sec
// build_hut — хижина 5x5 внутри (7x7 снаружи) на краю каньона.
// params: x,z — внутренний юго-западный угол (минимальные x,z), y — верхний блок пола (на нём стоят внутри);
//         door: west|east|south|north (по умолчанию west); window: сторона (по умолчанию как дверь) или none;
//         roof: planks|mixed (mixed: край булыжником, середина досками); corners: log|cobble;
//         max_sec: потолок стройки (по умолчанию 900); dry=1 — только смета.
// План: 167 клеток = 49 пол/фундамент (y=fy) + 69 стены (y=fy+1..fy+3 по кольцу, без проёмов двери/окна)
//       + 49 крыша (y=fy+4).
// Порядок: survey → план с учётом уже стоящих → выравнивание (внутри копаем только то, чем сразу заменим)
//          → пол → стены (слой за слоем; угловые клетки ПОСЛЕ соседних, иначе «не к чему прислонить»)
//          → крыша (край, потом середина; при нужде муха встаёт на леса pillar_up и идёт по гребню стены)
//          → дверь и окно → проверка survey.
// Честность: копаем только то, чем сразу заполним (каждый прогон не ухудшает результат); при «не к чему
// прислонить» ставим подпорку и повторяем; не хватает материала только на крышу — строим крышу из того,
// что есть; не хватает на стены/пол — отказ с missing. Возврат: ok, built/total, doorOk, holes, placed,
// dug, need/have/missing, already, by_kind, notes, plan.
const COBBLE = 'cobblestone';
const LOG = 'spruce_log';
const PLANK = 'spruce_planks';
const DOOR = 'spruce_door';
const SIDES = ['west', 'east', 'south', 'north'];
const FACE = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const SIDE4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|deep_snow|dirt_path|dead_bush|glow_lichen|vine|moss_carpet|hanging_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|sweet_berry_bush|leaf_litter|wildflowers|brown_mushroom|red_mushroom|fire|firefly_bush)$/;
const FLUID = /water|lava|bubble_column/;
const NOTFULL = /(torch|door|slab|carpet|sign|banner|button|pressure_plate|rail|ladder|chain|flower_pot|bed|sapling|leaves|stairs|candle|flower|pot|wire)$/;
const PROTECTED = /(chest|barrel|furnace|smoker|crafting_table|spawner|anvil|beacon|enchanting_table|brewing_stand|cauldron|lectern|loom|stonecutter|grindstone|piston|observer|hopper|shulker|conduit|bell|target|note_block|jukebox)$/;
// чем затыкать клетки, если нет «родного» материала
const FILLERS = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'dirt', 'coarse_dirt', 'gravel', 'sand', 'netherrack', 'stone_bricks', 'calcite', 'dripstone_block', 'blackstone', 'mud_bricks'];
const SUPPORT_BLOCKS = FILLERS.concat([LOG]);

const isDry = p => p && (p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true');
const short = m => String(m === undefined || m === null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim().slice(0, 140);
const k3 = (x, y, z) => x + ',' + y + ',' + z;
const isHard = b => b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b) && !NOTFULL.test(b) && !PROTECTED.test(b);
const cellState = b => {
  if (b === '?') return 'unknown';
  if (AIRLIKE.test(b)) return 'air';
  if (FLUID.test(b)) return 'fluid';
  if (PROTECTED.test(b)) return 'protected';
  if (isHard(b)) return 'built';
  return 'soft';
};
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const lessKey = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] === undefined ? 0 : a[i], y = b[i] === undefined ? 0 : b[i]; if (x !== y) return x < y; } return false; };

// ---------- план ----------
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
    if (x === dc.x && z === dc.z && y <= fy + 2) continue;         // проём двери
    if (wc && x === wc.x && z === wc.z && y === fy + 2) continue;  // проём окна
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
  const clear = [];   // внутри должно быть пусто
  for (let y = fy + 3; y >= fy + 1; y--) for (let z = iz; z <= iz + 4; z++) for (let x = ix; x <= ix + 4; x++) clear.push({ x, y, z });
  clear.push({ x: dc.x, y: fy + 1, z: dc.z }, { x: dc.x, y: fy + 2, z: dc.z });
  if (wc) clear.push({ x: wc.x, y: fy + 2, z: wc.z });
  return {
    cells, clear, door: { x: dc.x, y: fy + 1, z: dc.z }, window: wc ? { x: wc.x, y: fy + 2, z: wc.z } : null,
    box: { ox1, ox2, oz1, oz2 }
  };
}

// ---------- survey -> карта клеток ----------
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
    height: (x, z) => { const v = heights.get(x + ',' + z); return v === undefined ? null : v; }
  };
}

module.exports = {
  name: 'build_hut',
  description: 'Хижина 5x5 внутри (7x7 снаружи) у края каньона: пол/фундамент булыжником, стены булыжник + брёвна по углам, плоская крыша (planks|mixed), дверь и окно на запад. Считает по survey с учётом уже стоящих; копает только то, чем сразу заменит (прогон не ухудшает результат); углы ставит после соседей, при нехватке опоры ставит подпорку. Не хватает на крышу — строит крышу из того, что есть; не хватает на стены — отказ с missing. dry=1 — смета need/have/missing и по слоям. Итог проверяет survey.',
  params: {
    x: 'x внутреннего юго-западного угла (минимум)',
    z: 'z внутреннего юго-западного угла (минимум)',
    y: 'y верхнего блока пола (на нём стоят внутри)',
    door: 'сторона двери: west (по умолчанию), east, south, north',
    window: 'сторона окна (по умолчанию как дверь), none — без окна; окно — проём 1x1 (glass_pane/glass, если есть)',
    roof: 'planks (по умолчанию) или mixed (край булыжником, середина досками)',
    corners: 'log (по умолчанию, брёвна по углам) или cobble (без дерева)',
    max_sec: 'ограничение времени стройки, по умолчанию 900',
    dry: '1 — ничего не строить, вернуть need/have/missing/по слоям/plan'
  },

  async run(api, params) {
    const pr = params || {};
    const ix = Math.round(Number(pr.x)), iz = Math.round(Number(pr.z)), fy = Math.round(Number(pr.y));
    if (![ix, iz, fy].every(Number.isFinite)) return { ok: false, error: 'нужны x, z (внутренний юго-западный угол) и y (верх пола)' };
    const door = SIDES.includes(pr.door) ? pr.door : 'west';
    const windowSide = pr.window === 'none' ? null : (SIDES.includes(pr.window) ? pr.window : door);
    const roof = pr.roof === 'mixed' ? 'mixed' : 'planks';
    const corners = pr.corners === 'cobble' ? 'cobble' : 'log';
    const dry = isDry(pr);
    const maxSec = Math.min(Math.max(Number(pr.max_sec) || 900, 60), 1800);
    const t0 = Date.now();
    const deadline = t0 + maxSec * 1000;
    const notes = [];
    const P = makePlan(ix, iz, fy, door, windowSide, roof, corners);
    const { ox1, ox2, oz1, oz2 } = P.box;
    const planMap = new Map(P.cells.map(c => [k3(c.x, c.y, c.z), c]));

    // ---- инвентарь ----
    const snap0 = await api.snapshot();
    const stock = invMap(snap0.inventory);
    const take = prefs => { for (const it of prefs) if ((stock[it] || 0) > 0) { stock[it]--; return it; } return null; };
    const give = it => { if (it) stock[it] = (stock[it] || 0) + 1; };

    // ---- подойти к площадке ----
    if (!dry) {
      const p = snap0.position || {};
      if (Math.hypot((p.x || 0) - (ix + 2), (p.z || 0) - (iz + 2)) > 10) {
        try { await api.cmd('goto', { x: ix + 2, z: iz + 7, timeout: 120 }); }
        catch (e) { return { ok: false, error: 'не дошла до площадки: ' + short(e.message) }; }
      }
    }

    // ---- survey (с запасом вокруг) ----
    const svBox = { x1: ox1 - 3, y1: fy - 3, z1: oz1 - 3, x2: ox2 + 3, y2: fy + 5, z2: oz2 + 3 };
    let sv;
    try { sv = await api.cmd('survey', svBox); }
    catch (e) { return { ok: false, error: 'survey: ' + short(e.message) }; }
    const W = makeWorld(sv);

    // ---- что уже стоит / что строить ----
    const need = {}, have = {}, missing = {};
    const byKind = { floor: { need: 0, already: 0, todo: 0 }, wall: { need: 0, already: 0, todo: 0 }, roof: { need: 0, already: 0, todo: 0 } };
    const todo = { floor: [], wall: [], roof: [] };
    const blocked = [];
    let already = 0, unknownCells = 0;
    for (const c of P.cells) {
      const b = W.get(c.x, c.y, c.z);
      const st = cellState(b);
      if (st === 'built') { already++; byKind[c.kind].already++; continue; }
      if (st === 'protected') { blocked.push({ at: [c.x, c.y, c.z], block: b }); continue; }
      if (st === 'unknown') unknownCells++;
      todo[c.kind].push(c);
      byKind[c.kind].todo++;
      byKind[c.kind].need++;
      need[c.prefs[0]] = (need[c.prefs[0]] || 0) + 1;
    }
    for (const k of Object.keys(need)) { have[k] = stock[k] || 0; if (have[k] < need[k]) missing[k] = need[k] - have[k]; }

    const doorB = W.get(P.door.x, P.door.y, P.door.z);
    const doorDone = /_door$/.test(doorB);
    const doorItem = Object.keys(stock).find(n => /_door$/.test(n) && stock[n] > 0);
    if (!doorDone && doorItem) need[doorItem] = (need[doorItem] || 0) + 1;
    const structTodo = todo.floor.length + todo.wall.length;
    const poolAll = FILLERS.concat([LOG, PLANK]).reduce((s, f) => s + (stock[f] || 0), 0);
    const todoAll = todo.floor.length + todo.wall.length + todo.roof.length;
    const plan = `хижина ${ox1}…${ox2} x ${oz1}…${oz2}, пол y=${fy}, дверь ${door} (${P.door.x} ${P.door.y} ${P.door.z})` +
      (P.window ? `, окно (${P.window.x} ${P.window.y} ${P.window.z})` : '') +
      `; клеток в плане ${P.cells.length}, уже стоит ${already}, ставить ${todoAll}` +
      ` (пол ${todo.floor.length}, стены ${todo.wall.length}, крыша ${todo.roof.length})` +
      (unknownCells ? `; ${unknownCells} клеток не видно (считаем пустыми)` : '');

    if (dry) {
      const r = { ok: true, dry: true, need, have, missing, plan, door: P.door, window: P.window, total: P.cells.length, already, unknown: unknownCells, by_kind: byKind, todo: todoAll, blocks_available: poolAll };
      if (blocked.length) r.blocked = blocked.slice(0, 8);
      if (missing[LOG] && corners === 'log') r.hint = 'брёвен мало — corners=cobble';
      if (Object.keys(missing).length) r.hint2 = `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${(stock[k] || 0) + n}`).join(',')}"`;
      return r;
    }

    // ---- хватает ли материала на стены/пол ----
    if (structTodo > 0 && poolAll < structTodo) {
      const miss = Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ');
      return { ok: false, error: 'не хватает блоков на пол и стены, не начинаю: нужно ' + structTodo + ', есть ' + poolAll + (miss ? ' (' + miss + ')' : ''), need, have, missing, plan, by_kind: byKind, blocks_available: poolAll,
        hint: `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${(stock[k] || 0) + n}`).join(',') || 'cobblestone:' + structTodo}"` };
    }
    if (todo.roof.length && Object.keys(missing).length) {
      notes.push('материала не хватает — строю из того, что есть (стены/пол важнее крыши)');
    }

    // ---- рабочие инструменты ----
    const placed = {}, dugBy = {};
    const failed = [], placedSet = new Set(), dugSet = new Set();
    let supportUsed = 0, dugTotal = 0;
    const placeOne = async (x, y, z, item) => {
      try { await api.cmd('place_at', { x, y, z, item }); return { ok: true }; }
      catch (e) { return { ok: false, err: short(e.message) }; }
    };
    const digOne = async (x, y, z) => {
      try {
        const r = await api.cmd('dig_at', { x, y, z });
        return { ok: true, dug: (r && r.dug) || '', got: (r && r.got) || null };
      } catch (e) { return { ok: false, err: short(e.message) }; }
    };
    const takeSupport = () => take(SUPPORT_BLOCKS);
    const insideHut = (x, y, z) => x >= ix && x <= ix + 4 && z >= iz && z <= iz + 4 && y >= fy + 1;
    const isDoorOrWindow = (x, y, z) =>
      (x === P.door.x && z === P.door.z && y >= fy + 1 && y <= fy + 2) ||
      (P.window && x === P.window.x && z === P.window.z && y === P.window.y);

    // Подпорка: если «не к чему прислонить» — построить опору и повторить.
    const supportCandidates = cell => {
      const out = [];
      const u = { x: cell.x, y: cell.y - 1, z: cell.z };
      if (!isHard(W.get(u.x, u.y, u.z)) && !insideHut(u.x, u.y, u.z) && !isDoorOrWindow(u.x, u.y, u.z)) out.push(u);
      for (const [dx, dz] of SIDE4) {
        const sp = { x: cell.x + dx, y: cell.y, z: cell.z + dz };
        if (insideHut(sp.x, sp.y, sp.z) || isDoorOrWindow(sp.x, sp.y, sp.z)) continue;
        const b = W.get(sp.x, sp.y, sp.z);
        if (b !== '?' && !AIRLIKE.test(b)) continue;
        if (isHard(W.get(sp.x, sp.y - 1, sp.z))) out.push(sp);
      }
      for (const [dx, dy, dz] of FACE) {
        const sp = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
        if (insideHut(sp.x, sp.y, sp.z) || isDoorOrWindow(sp.x, sp.y, sp.z)) continue;
        const b = W.get(sp.x, sp.y, sp.z);
        if (b !== '?' && !AIRLIKE.test(b)) continue;
        const has = FACE.some(([ax, ay, az]) => {
          const q = { x: sp.x + ax, y: sp.y + ay, z: sp.z + az };
          if (q.x === cell.x && q.y === cell.y && q.z === cell.z) return false;
          return isHard(W.get(q.x, q.y, q.z));
        });
        if (has) out.push(sp);
      }
      return out;
    };
    const placeWithSupport = async (cell, item) => {
      let r = await placeOne(cell.x, cell.y, cell.z, item);
      if (r.ok) return { ok: true };
      if (!/прислонить/.test(r.err)) return r;
      for (const sp of supportCandidates(cell)) {
        const planCell = planMap.get(k3(sp.x, sp.y, sp.z));
        const sit = planCell ? take(planCell.prefs.concat(SUPPORT_BLOCKS)) : takeSupport();
        if (!sit) break;
        const s = await placeOne(sp.x, sp.y, sp.z, sit);
        if (s.ok) { supportUsed++; W.set(sp.x, sp.y, sp.z, sit); }
        else {
          give(sit);
          if (!/занят/.test(s.err)) { if (!/прислонить/.test(s.err)) break; else continue; }
        }
        r = await placeOne(cell.x, cell.y, cell.z, item);
        if (r.ok) return { ok: true };
        if (!/прислонить/.test(r.err)) return r;
      }
      return r;
    };

    // Поставить/переставить одну клетку плана.
    const doCell = async (cell) => {
      const b = W.get(cell.x, cell.y, cell.z);
      const st = cellState(b);
      if (st === 'built') return 'already';
      if (st === 'protected') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + b }); return 'blocked'; }
      let item = null;
      if (st === 'soft') {
        // копаем только если есть чем заменить (иначе оставляем как есть — хуже не делаем)
        item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'не хватает блока, оставлено как было' }); return 'nomaterial'; }
        const d = await digOne(cell.x, cell.y, cell.z);
        if (!d.ok) { give(item); failed.push({ at: [cell.x, cell.y, cell.z], why: d.err }); return 'failed'; }
        dugTotal++; dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; dugSet.add(k3(cell.x, cell.y, cell.z));
        W.set(cell.x, cell.y, cell.z, 'air');
        if (d.got) for (const [n, c] of Object.entries(d.got)) if (FILLERS.includes(n) || n === PLANK || n === LOG) stock[n] = (stock[n] || 0) + c;
      } else {
        item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'нет блока: ' + cell.prefs.join('/') }); return 'nomaterial'; }
      }
      const r = await placeWithSupport(cell, item);
      if (!r.ok) { give(item); failed.push({ at: [cell.x, cell.y, cell.z], why: r.err }); return 'failed'; }
      placed[item] = (placed[item] || 0) + 1;
      W.set(cell.x, cell.y, cell.z, item);
      placedSet.add(k3(cell.x, cell.y, cell.z));
      return 'placed';
    };

    // счёт твёрдых соседей — по ним выбираем клетку с лучшей опорой
    const nbrs = c => {
      let n = 0;
      for (const [dx, dy, dz] of FACE) if (isHard(W.get(c.x + dx, c.y + dy, c.z + dz))) n++;
      return n;
    };
    const pickNext = (list, keyFn) => {
      let bi = -1, bs = null;
      for (let i = 0; i < list.length; i++) {
        const s = keyFn(list[i]);
        if (bs === null || lessKey(s, bs)) { bs = s; bi = i; }
      }
      return bi < 0 ? null : list.splice(bi, 1)[0];
    };
    const runStage = async (name, list, keyFn) => {
      const rest = list.slice();
      let n = 0, bad = 0;
      while (rest.length) {
        if (Date.now() > deadline) { notes.push(name + ': время вышло, осталось ' + rest.length); break; }
        const c = pickNext(rest, keyFn);
        if (!c) break;
        const before = failed.length;
        const r = await doCell(c);
        if (r === 'placed') n++;
        if (r === 'failed' && failed.length > before) {
          const why = failed[failed.length - 1].why || '';
          if (/недоступно|не могу подойти|подойти/.test(why)) { bad++; if (bad >= 4) { notes.push(name + ': клетки недоступны, стоп'); break; } } else bad = 0;
        }
        if (n && n % 20 === 0) api.log(name + ': поставлено ' + n);
      }
      api.log(name + ': готово, поставлено ' + n);
      return n;
    };

    // ---- леса: поднять муху на уровень крыши и встать на гребень стены ----
    const findOutsideSpot = () => {
      let best = null, bd = Infinity;
      for (let x = ox1 - 3; x <= ox2 + 3; x++) for (let z = oz1 - 3; z <= oz2 + 3; z++) {
        if (x >= ox1 && x <= ox2 && z >= oz1 && z <= oz2) continue;
        const h = W.height(x, z);
        if (h === null) continue;
        if (h < fy - 1 || h > fy + 1) continue;
        let free = true;
        for (let y = h + 1; y <= h + 3; y++) if (isHard(W.get(x, y, z))) { free = false; break; }
        if (!free) continue;
        const d = Math.abs(h + 1 - fy) * 2 + Math.hypot(x - (ix + 2), z - (iz + 2));
        if (d < bd) { bd = d; best = { x, y: h + 1, z }; }
      }
      return best;
    };
    const raiseTo = async targetY => {
      for (let i = 0; i < 6; i++) {
        if (Date.now() > deadline) return { ok: false, why: 'время вышло' };
        const snap = await api.snapshot();
        const p = snap.position || {};
        const feet = Math.floor(p.y || 0);
        if (feet >= targetY) return { ok: true, y: feet };
        const inside = p.x >= ox1 - 0.5 && p.x <= ox2 + 0.5 && p.z >= oz1 - 0.5 && p.z <= oz2 + 0.5;
        if (inside) {
          const sp = findOutsideSpot();
          if (!sp) return { ok: false, why: 'нет места снаружи для лесов' };
          try { await api.cmd('goto', { x: sp.x, y: sp.y, z: sp.z, timeout: 60 }); }
          catch (e) { notes.push('леса: не подошла: ' + short(e.message)); }
          continue;
        }
        const item = takeSupport();
        if (!item) return { ok: false, why: 'нет блоков на леса' };
        const bx = Math.floor(p.x), bz = Math.floor(p.z);
        try {
          const r = await api.cmd('pillar_up', { height: targetY - feet, item });
          const y2 = r && Number.isFinite(Number(r.y)) ? Number(r.y) : null;
          if (y2 === null || y2 >= targetY) return { ok: true, y: y2, scaffold: { x: bx, z: bz, base: feet, top: targetY - 1, item } };
        } catch (e) { notes.push('pillar_up: ' + short(e.message)); }
        await api.sleep(400);
      }
      return { ok: false, why: 'не поднялась на уровень крыши' };
    };
    // встать на гребень стены (верхний слой) — оттуда видно всю крышу
    const standOnWall = async targetY => {
      const top = P.cells.filter(c => c.kind === 'wall' && c.y === fy + 3 && isHard(W.get(c.x, c.y, c.z)));
      if (!top.length) return false;
      for (const c of top.slice(0, 6)) {
        try { await api.cmd('goto', { x: c.x, y: targetY, z: c.z, timeout: 30 }); }
        catch (e) { continue; }
        const p = (await api.snapshot()).position || {};
        if (Math.floor(p.y || 0) >= targetY - 1 && Math.abs((p.x || 0) - c.x) < 2.5 && Math.abs((p.z || 0) - c.z) < 2.5) return true;
      }
      return false;
    };
    const takeDown = async sc => {
      try { await api.cmd('goto', { x: sc.x, y: sc.top + 1, z: sc.z, timeout: 40 }); } catch (e) { /* не критично */ }
      for (let y = sc.top; y >= sc.base; y--) {
        if (Date.now() > deadline) break;
        try { const d = await api.cmd('dig_at', { x: sc.x, y, z: sc.z }); if (d && d.dug) dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; }
        catch (e) { break; }
        await api.sleep(250);
      }
      notes.push('леса убраны');
    };

    // ---- этап 0: выравнивание (внутри должно быть пусто) ----
    const interior = P.clear.filter(c => {
      const b = W.get(c.x, c.y, c.z);
      return b !== '?' && b !== 'air' && !FLUID.test(b);
    });
    if (interior.length) {
      api.log('выравнивание: внутри ' + interior.length + ' клеток');
      let bad = 0;
      for (let i = 0; i < interior.length; i++) {
        if (Date.now() > deadline) { notes.push('выравнивание не закончено (время)'); break; }
        const c = interior[i];
        if (i % 4 === 0) {
          const p = (await api.snapshot()).position || {};
          const dist = Math.hypot(c.x - (p.x || 0), (c.y + 0.5) - (p.y || 0), c.z - (p.z || 0));
          if (dist > 7) { notes.push('внутри не дотянулась до ' + c.x + ' ' + c.y + ' ' + c.z); continue; }
        }
        const d = await digOne(c.x, c.y, c.z);
        if (d.ok) {
          dugTotal++; dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; dugSet.add(k3(c.x, c.y, c.z));
          W.set(c.x, c.y, c.z, 'air');
          if (d.got) for (const [n, cc] of Object.entries(d.got)) if (FILLERS.includes(n) || n === PLANK || n === LOG) stock[n] = (stock[n] || 0) + cc;
          bad = 0;
        } else if (!/уже пусто|нет такого блока/.test(d.err)) {
          bad++;
          if (bad >= 3) { notes.push('внутри копать не вышло: ' + c.x + ' ' + c.y + ' ' + c.z + ' — ' + d.err); break; }
        }
      }
      api.log('выравнивание: снято ' + dugTotal);
    }

    // ---- этап 1: пол/фундамент, этап 2: стены, этап 3: крыша ----
    await runStage('пол', todo.floor, c => [-nbrs(c), c.y, c.z, c.x]);
    await runStage('стены', todo.wall, c => [c.y, c.corner ? 1 : 0, -nbrs(c), c.z, c.x]);
    if (todo.roof.length) {
      const roofY = fy + 4;
      const raised = await raiseTo(roofY);
      if (!raised.ok) notes.push('крыша: ' + raised.why);
      else {
        const onWall = await standOnWall(roofY);
        if (!onWall) notes.push('крыша: на гребень стены не встала, ставлю с лесов');
      }
      await runStage('крыша', todo.roof, c => [c.dist, c.corner ? 1 : 0, -nbrs(c), c.z, c.x]);
      if (raised.scaffold) await takeDown(raised.scaffold);
    }

    // ---- дверь и окно ----
    let doorOk = /_door$/.test(W.get(P.door.x, P.door.y, P.door.z));
    if (!doorOk) {
      const st = cellState(W.get(P.door.x, P.door.y, P.door.z));
      if (st === 'soft') {
        const d = await digOne(P.door.x, P.door.y, P.door.z);
        if (d.ok) { dugTotal++; dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; dugSet.add(k3(P.door.x, P.door.y, P.door.z)); W.set(P.door.x, P.door.y, P.door.z, 'air'); }
      }
      const it = take(Object.keys(stock).filter(n => /_door$/.test(n)));
      if (it) {
        const r = await placeWithSupport(P.door, it);
        if (r.ok) { placed[it] = (placed[it] || 0) + 1; W.set(P.door.x, P.door.y, P.door.z, it); doorOk = true; }
        else { give(it); failed.push({ at: [P.door.x, P.door.y, P.door.z], why: 'дверь: ' + r.err }); }
      } else {
        failed.push({ at: [P.door.x, P.door.y, P.door.z], why: 'нет двери в инвентаре (' + DOOR + ')' });
      }
    }
    if (P.window) {
      const b = W.get(P.window.x, P.window.y, P.window.z);
      if (b !== 'air' && b !== '?') { const d = await digOne(P.window.x, P.window.y, P.window.z); if (d.ok) { dugTotal++; W.set(P.window.x, P.window.y, P.window.z, 'air'); } }
      const g = Object.keys(stock).find(n => (n === 'glass_pane' || n === 'glass') && stock[n] > 0);
      if (g) {
        const r = await placeOne(P.window.x, P.window.y, P.window.z, g);
        if (r.ok) { placed[g] = (placed[g] || 0) + 1; stock[g]--; W.set(P.window.x, P.window.y, P.window.z, g); }
      }
    }

    // ---- итоговая проверка ----
    await api.sleep(400);
    let W2 = W;
    try { W2 = makeWorld(await api.cmd('survey', svBox)); } catch (e) { notes.push('итоговый survey: ' + short(e.message)); }
    let built = 0; const holes = []; let unknown = 0;
    for (const c of P.cells) {
      const b = W2.get(c.x, c.y, c.z);
      if (isHard(b)) { built++; continue; }
      const k = k3(c.x, c.y, c.z);
      if (placedSet.has(k)) { built++; unknown++; continue; }
      if (b === '?' && isHard(W.get(c.x, c.y, c.z)) && !dugSet.has(k)) { built++; unknown++; continue; }
      holes.push([c.x, c.y, c.z]);
    }
    doorOk = /_door$/.test(W2.get(P.door.x, P.door.y, P.door.z)) || /_door$/.test(W.get(P.door.x, P.door.y, P.door.z));
    const ok = built === P.cells.length && doorOk;
    const res = {
      ok, built, total: P.cells.length, doorOk, holes: holes.slice(0, 30), unknown,
      placed, dug: dugTotal, dug_by: dugBy, need, have, missing, already, by_kind: byKind,
      support: supportUsed, plan, door: P.door, window: P.window, interior: { x: ix, z: iz }, floorY: fy,
      notes, sec: Math.round((Date.now() - t0) / 1000)
    };
    if (failed.length) res.failed = failed.slice(0, 15);
    if (blocked.length) res.blocked = blocked.slice(0, 8);
    if (!ok) res.error = `построено ${built}/${P.cells.length}${doorOk ? '' : ', двери нет'}; дыры: ${JSON.stringify(holes.slice(0, 6))}`;
    else if (dugTotal === 0 && already === P.cells.length) res.status = 'уже стоит';
    return res;
  }
};
