// версия: крышу ставит от края к центру, стоя внутри на полу; этапы независимы (сбой двери не роняет крышу); у каждой непоставленной клетки — причина
// build_hut — хижина 5x5 внутри (7x7 снаружи) на краю каньона.
// params: x,z — внутренний юго-западный угол (минимальные x,z), y — верхний блок пола (на нём стоят внутри);
//         door: west|east|south|north (по умолчанию west); window: сторона (по умолчанию как дверь) или none;
//         roof: planks|mixed (mixed: край булыжником, середина досками); corners: log|cobble;
//         max_sec: потолок стройки (по умолчанию 900); dry=1 — только смета.
// План: 167 клеток = 49 пол/фундамент (y=fy) + 69 стены (y=fy+1..fy+3 по кольцу, без проёмов двери/окна)
//       + 49 крыша (y=fy+4).
// Порядок: survey → план → выравнивание (внутри пусто) → пол → стены (слой за слоем, угловые ПОСЛЕ соседних)
//          → крыша (от края к центру) → дверь и окно → итоговый survey.
// КРЫША: муха встаёт ВНУТРИ хижины на пол (ноги y=fy+1=67) — под клеткой или вплотную к ней — и ставит
//        блок СВЕРХУ: опора снизу (стена под клеткой) или сбоку (уже поставленный блок крыши).
//        Почему так: place_at (lib/skills/build.js:36) ищет путь, только если расстояние от НОГ до клетки
//        больше 4; с пола ноги на 67, клетка крыши на 70 → 3.5, путь не ищется, блок ставится сразу.
//        Снаружи с земли ноги на 66 → 4.5, place_at уходит искать путь к клетке над головой и не находит
//        (там «нет к чему прислонить»/«недоступно»). Если внутрь не попасть — леса pillar_up снаружи.
// Этапы изолированы: дверь не поставилась — крыша всё равно строится (и наоборот); каждый сбой этапа
//        пишется в notes, а не роняет весь навык.
// Честность: каждая непоставленная клетка — с точной причиной (и в логе, и в ответе); «построено»
//        считается только по реальным блокам плана (снег/трава за блок не считаются).
// Возврат: ok, built/total, doorOk, doorWhy, roof {placed,failed}, holes, placed, dug, need/have/missing,
//        already, by_kind, notes, plan.
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
// блоки, которыми тело умеет растить леса (pillar_up): доски и брёвна не берёт
const SCAFFOLD_ITEMS = ['dirt', 'coarse_dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'blackstone'];

const isDry = p => p && (p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true');
const short = m => String(m === undefined || m === null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim().slice(0, 160);
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
  description: 'Хижина 5x5 внутри (7x7 снаружи) у края каньона: пол/фундамент булыжником, стены булыжник + брёвна по углам, плоская крыша (planks|mixed), дверь и окно на запад. Считает по survey с учётом уже стоящих; копает только то, чем сразу заменит (прогон не ухудшает результат); углы ставит после соседних. Крыша строится от края к центру: муха встаёт внутри на пол под клеткой (или на гребень стены) и ставит блок сверху — опора снизу или сбоку; если внутрь не попасть — леса снаружи. Этапы изолированы: дверь не поставилась — крыша всё равно строится. Каждая непоставленная клетка — с точной причиной в логе. Снег за блок плана не считается. Не хватает на крышу — строит крышу из того, что есть; не хватает на стены — отказ с missing. dry=1 — смета.',
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
    const roofY = fy + 4;
    const insideFloor = (x, z) => x >= ix && x <= ix + 4 && z >= iz && z <= iz + 4;
    const isWallCell = (x, z) => x >= ox1 && x <= ox2 && z >= oz1 && z <= oz2 && (x === ox1 || x === ox2 || z === oz1 || z === oz2);

    // ---- инвентарь ----
    const snap0 = await api.snapshot();
    const stock = invMap(snap0.inventory);
    const take = prefs => { for (const it of prefs) if ((stock[it] || 0) > 0) { stock[it]--; return it; } return null; };
    const give = it => { if (it) stock[it] = (stock[it] || 0) + 1; };
    const refreshStock = async () => {
      try {
        const s = await api.snapshot();
        Object.keys(stock).forEach(k => delete stock[k]);
        Object.assign(stock, invMap(s.inventory));
      } catch (e) { /* инвентарь останется как есть */ }
    };

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

    // Точная причина, почему клетка не закрылась (по миру и по тексту ошибки тела).
    const whyNot = (x, y, z, err) => {
      const e = String(err || '');
      if (/занят/.test(e)) return 'место занято: ' + W.get(x, y, z);
      if (/нет в инвентаре/.test(e)) return 'нет блока в инвентаре';
      if (/стоит на месте установки/.test(e)) return 'муха стоит на этой клетке';
      if (/не к чему прислонить/.test(e)) {
        const below = W.get(x, y - 1, z), above = W.get(x, y + 1, z);
        let sides = 0;
        for (const [dx, dz] of SIDE4) if (isHard(W.get(x + dx, y, z + dz))) sides++;
        return `не к чему прислонить (снизу ${below}, сверху ${above}, сбоку твёрдых ${sides}/4)`;
      }
      if (/недоступно|не могу подойти|подойти|нет пути|путь не найден|слишком долго/.test(e)) return 'не подошла: ' + short(e);
      return short(e) || 'причина неизвестна';
    };

    // Убрать мягкий блок (снег/трава) — иначе под наш блок он не встанет.
    const clearSoft = async (x, y, z) => {
      let d = await digOne(x, y, z);
      if (d.ok) {
        dugTotal++; dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; dugSet.add(k3(x, y, z));
        W.set(x, y, z, 'air');
        if (d.got) for (const [n, cc] of Object.entries(d.got)) if (FILLERS.includes(n) || n === PLANK || n === LOG) stock[n] = (stock[n] || 0) + cc;
        return { ok: true };
      }
      const err = String(d.err || '');
      if (/нет такого блока|уже пусто|пусто/.test(err)) { W.set(x, y, z, 'air'); return { ok: true, wasEmpty: true }; }
      if (/недоступно|не могу подойти|подойти/.test(err)) {
        try { await api.cmd('goto', { x, y, z, timeout: 20 }); } catch (e) { /* может не дойти */ }
        d = await digOne(x, y, z);
        if (d.ok) {
          dugTotal++; dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; dugSet.add(k3(x, y, z));
          W.set(x, y, z, 'air');
          if (d.got) for (const [n, cc] of Object.entries(d.got)) if (FILLERS.includes(n) || n === PLANK || n === LOG) stock[n] = (stock[n] || 0) + cc;
          return { ok: true };
        }
        if (/нет такого блока|уже пусто|пусто/.test(String(d.err || ''))) { W.set(x, y, z, 'air'); return { ok: true, wasEmpty: true }; }
        return { ok: false, why: whyNot(x, y, z, d.err) };
      }
      return { ok: false, why: whyNot(x, y, z, d.err) };
    };

    // Подпорка: если «не к чему прислонить» — построить опору и повторить.
    const supportCandidates = cell => {
      const out = [];
      const u = { x: cell.x, y: cell.y - 1, z: cell.z };
      if (!isHard(W.get(u.x, u.y, u.z)) && !insideFloor(u.x, u.z) && !isDoorOrWindow(u.x, u.y, u.z)) out.push(u);
      for (const [dx, dz] of SIDE4) {
        const sp = { x: cell.x + dx, y: cell.y, z: cell.z + dz };
        if (insideFloor(sp.x, sp.z) || isDoorOrWindow(sp.x, sp.y, sp.z)) continue;
        const b = W.get(sp.x, sp.y, sp.z);
        if (b !== '?' && !AIRLIKE.test(b)) continue;
        if (isHard(W.get(sp.x, sp.y - 1, sp.z))) out.push(sp);
      }
      for (const [dx, dy, dz] of FACE) {
        const sp = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
        if (insideFloor(sp.x, sp.z) || isDoorOrWindow(sp.x, sp.y, sp.z)) continue;
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
    const isDoorOrWindow = (x, y, z) =>
      (x === P.door.x && z === P.door.z && y >= fy + 1 && y <= fy + 2) ||
      (P.window && x === P.window.x && z === P.window.z && y === P.window.y);

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

    // Поставить/переставить одну клетку плана (пол, стены).
    const doCell = async cell => {
      const b = W.get(cell.x, cell.y, cell.z);
      const st = cellState(b);
      if (st === 'built') return 'already';
      if (st === 'protected') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + b }); return 'blocked'; }
      let item = null;
      if (st === 'soft') {
        item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'не хватает блока, оставлено как было' }); return 'nomaterial'; }
        const d = await clearSoft(cell.x, cell.y, cell.z);
        if (!d.ok) { give(item); failed.push({ at: [cell.x, cell.y, cell.z], why: d.why }); return 'failed'; }
      } else {
        item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'нет блока: ' + cell.prefs.join('/') }); return 'nomaterial'; }
      }
      const r = await placeWithSupport(cell, item);
      if (!r.ok) { give(item); failed.push({ at: [cell.x, cell.y, cell.z], why: whyNot(cell.x, cell.y, cell.z, r.err) }); return 'failed'; }
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

    // Изоляция этапов: сбой одного этапа не роняет остальные.
    const stageErrors = [];
    const stage = async (name, fn) => {
      try { return await fn(); }
      catch (e) {
        const why = short(e.message);
        notes.push(name + ': сбой — ' + why);
        stageErrors.push({ stage: name, why });
        api.log(name + ': сбой — ' + why);
        return null;
      }
    };

    // ---- муха внутри: на полу хижины (ноги y=fy+1) ----
    const botInside = () => {
      const p = (lastPos || {});
      return p.x >= ox1 && p.x <= ox2 + 1 && p.z >= oz1 && p.z <= oz2 + 1 && Math.floor(p.y || 0) >= fy && Math.floor(p.y || 0) <= fy + 3;
    };
    let lastPos = null;
    const refreshPos = async () => {
      try { const s = await api.snapshot(); lastPos = s.position || lastPos; } catch (e) { /* ignore */ }
      return lastPos || {};
    };
    const enterHut = async () => {
      await refreshPos();
      if (botInside()) return { ok: true, how: 'уже внутри' };
      const tryGoto = async (x, y, z) => {
        try { await api.cmd('goto', { x, y, z, timeout: 30 }); await refreshPos(); return true; }
        catch (e) { return false; }
      };
      // 1) прямо в проём двери, 2) в центр
      const doorIn = { x: P.door.x + (P.door.x === ox1 ? 1 : P.door.x === ox2 ? -1 : 0), y: fy + 1, z: P.door.z + (P.door.z === oz1 ? 1 : P.door.z === oz2 ? -1 : 0) };
      if (await tryGoto(doorIn.x, doorIn.y, doorIn.z)) return { ok: true, how: 'через проём двери' };
      if (await tryGoto(ix + 2, fy + 1, iz + 2)) return { ok: true, how: 'в центр' };
      // 3) дверь закрыта — открыть её и попробовать снова
      if (/door/.test(String(W.get(P.door.x, P.door.y, P.door.z) || ''))) {
        try { await api.cmd('activate', { x: P.door.x, y: P.door.y, z: P.door.z }); }
        catch (e) { notes.push('дверь: не открылась — ' + short(e.message)); }
        await api.sleep(400);
        if (await tryGoto(doorIn.x, doorIn.y, doorIn.z)) return { ok: true, how: 'через открытую дверь' };
        if (await tryGoto(ix + 2, fy + 1, iz + 2)) return { ok: true, how: 'через открытую дверь' };
      }
      return { ok: false, why: 'муха не может попасть внутрь хижины (дверь закрыта или путь не найден)' };
    };

    // ---- этап 0: выравнивание (внутри должно быть пусто) ----
    await stage('выравнивание', async () => {
      const interior = P.clear.filter(c => {
        const b = W.get(c.x, c.y, c.z);
        return b !== '?' && b !== 'air' && !FLUID.test(b);
      });
      if (!interior.length) return 0;
      api.log('выравнивание: внутри ' + interior.length + ' клеток');
      const inHut = await enterHut();
      if (!inHut.ok) notes.push('выравнивание: ' + inHut.why);
      let dug = 0, bad = 0;
      for (const c of interior) {
        if (Date.now() > deadline) { notes.push('выравнивание не закончено (время)'); break; }
        const d = await clearSoft(c.x, c.y, c.z);
        if (d.ok) dug++;
        else {
          bad++;
          if (bad >= 3) { notes.push('внутри копать не вышло: ' + c.x + ' ' + c.y + ' ' + c.z + ' — ' + d.why); break; }
        }
      }
      api.log('выравнивание: снято ' + dug);
      return dug;
    });

    // ---- этап 1: пол/фундамент, этап 2: стены ----
    await stage('пол', async () => {
      await refreshStock();
      return runStage('пол', todo.floor, c => [-nbrs(c), c.y, c.z, c.x]);
    });
    await stage('стены', async () => {
      await refreshStock();
      return runStage('стены', todo.wall, c => [c.y, c.corner ? 1 : 0, -nbrs(c), c.z, c.x]);
    });

    // ---- этап 3: крыша ----
    const roofInfo = await stage('крыша', async () => {
      if (!todo.roof.length) { api.log('крыша: нечего строить'); return { placed: 0, failed: [] }; }
      await refreshStock();
      const cells = todo.roof.slice().sort((a, b) => a.dist - b.dist || a.z - b.z || a.x - b.x);
      const inHut = await enterHut();
      if (!inHut.ok) api.log('крыша: внутрь не попала (' + inHut.why + ') — ставлю с лесов снаружи');

      // Где встать, чтобы поставить клетку крыши: сначала внутри на полу (ноги fy+1),
      // потом на гребне стены (ноги roofY), потом — леса снаружи.
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
          if (isHard(W.get(nx, roofY, nz))) continue;       // над этой стеной крыша уже стоит — там не встать
          if (!isHard(W.get(nx, roofY - 1, nz))) continue;   // на стену встают, только если она есть
          out.push({ x: nx, y: roofY, z: nz, how: 'на гребне стены' });
        }
        return out;
      };
      const standAt = async spot => {
        const p = await refreshPos();
        const dx = Math.abs((p.x || 0) - (spot.x + 0.5)), dz = Math.abs((p.z || 0) - (spot.z + 0.5));
        const dy = Math.abs(Math.floor(p.y || 0) - spot.y);
        if (dx < 0.9 && dz < 0.9 && dy <= 1) return { ok: true };
        try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 25 }); await refreshPos(); return { ok: true }; }
        catch (e) { return { ok: false, why: 'не встала (' + spot.how + '): ' + short(e.message) }; }
      };
      // Опора под клеткой крыши: стена (roofY-1) под клеткой над стеной. Нет — достроить.
      const ensureBelow = async cell => {
        const bx = cell.x, by = roofY - 1, bz = cell.z;
        if (!isWallCell(bx, bz)) return false;
        if (isHard(W.get(bx, by, bz))) return true;
        if (cellState(W.get(bx, by, bz)) === 'soft') {
          const d = await clearSoft(bx, by, bz);
          if (!d.ok) return false;
          if (isHard(W.get(bx, by, bz))) return true;
        }
        const item = take([COBBLE, LOG, PLANK].concat(FILLERS));
        if (!item) return false;
        const r = await placeOne(bx, by, bz, item);
        if (r.ok) { placed[item] = (placed[item] || 0) + 1; W.set(bx, by, bz, item); return true; }
        give(item);
        return false;
      };
      // Леса снаружи (если внутрь не попали): встать на землю рядом с клеткой и вырастить столб.
      let scaffold = null;
      const scaffoldFor = async cell => {
        const p = await refreshPos();
        const feet = Math.floor(p.y || 0);
        if (scaffold && feet >= roofY - 1 && Math.abs((p.x || 0) - (scaffold.x + 0.5)) < 3 && Math.abs((p.z || 0) - (scaffold.z + 0.5)) < 3) return { ok: true };
        const outs = [];
        for (const [dx, dz] of SIDE4) {
          const nx = cell.x + dx, nz = cell.z + dz;
          if (nx >= ox1 && nx <= ox2 && nz >= oz1 && nz <= oz2) continue;
          outs.push({ x: nx, z: nz });
        }
        if (!outs.length) return { ok: false, why: 'нет места снаружи для лесов' };
        const spot = outs[0];
        try { await api.cmd('goto', { x: spot.x, z: spot.z, timeout: 25 }); }
        catch (e) { return { ok: false, why: 'не подошла к месту лесов: ' + short(e.message) }; }
        const item = take(SCAFFOLD_ITEMS);
        if (!item) return { ok: false, why: 'нет блоков на леса (нужен dirt/cobblestone/stone)' };
        const here = await refreshPos();
        const need = Math.max(1, roofY - Math.floor((here.y || 0)));
        try {
          await api.cmd('pillar_up', { height: need, item });
          scaffold = { x: spot.x, z: spot.z, top: roofY - 1, base: Math.floor((here.y || 0)), item };
          return { ok: true };
        } catch (e) { give(item); return { ok: false, why: 'леса не выросли: ' + short(e.message) }; }
      };

      let n = 0;
      const roofFailed = [];
      for (const cell of cells) {
        if (Date.now() > deadline) { notes.push('крыша: время вышло, осталось ' + (cells.length - n - roofFailed.length)); break; }
        const item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (!item) {
          const why = 'нет блока в инвентаре (' + cell.prefs.join('/') + ')';
          roofFailed.push({ at: [cell.x, cell.y, cell.z], why });
          api.log('крыша: ' + cell.x + ' ' + cell.y + ' ' + cell.z + ' — ' + why);
          continue;
        }
        const spots = inHut.ok ? standSpots(cell) : [];
        let last = 'не нашлось места, откуда поставить';
        let done = false;
        for (const spot of spots) {
          const st = await standAt(spot);
          if (!st.ok) { last = st.why; continue; }
          let r = await placeOne(cell.x, cell.y, cell.z, item);
          if (r.ok) { done = true; break; }
          last = whyNot(cell.x, cell.y, cell.z, r.err);
          if (/прислонить/.test(r.err) && await ensureBelow(cell)) {
            r = await placeOne(cell.x, cell.y, cell.z, item);
            if (r.ok) { done = true; break; }
            last = whyNot(cell.x, cell.y, cell.z, r.err);
          }
        }
        if (!done && !inHut.ok) {
          // внутри нет — пробуем леса снаружи (только для клеток над стеной)
          const sc = await scaffoldFor(cell);
          if (sc.ok) {
            const r = await placeOne(cell.x, cell.y, cell.z, item);
            if (r.ok) done = true;
            else last = whyNot(cell.x, cell.y, cell.z, r.err);
          } else last = last + '; ' + sc.why;
        }
        if (done) {
          n++;
          placed[item] = (placed[item] || 0) + 1;
          W.set(cell.x, cell.y, cell.z, item);
          placedSet.add(k3(cell.x, cell.y, cell.z));
          if (n % 10 === 0) api.log('крыша: поставлено ' + n);
        } else {
          give(item);
          roofFailed.push({ at: [cell.x, cell.y, cell.z], why: last });
          api.log('крыша: ' + cell.x + ' ' + cell.y + ' ' + cell.z + ' — ' + last);
        }
      }
      api.log('крыша: поставлено ' + n + ' из ' + cells.length);
      if (scaffold) {
        try { await api.cmd('goto', { x: scaffold.x, z: scaffold.z, timeout: 25 }); } catch (e) { /* может не дойти */ }
        for (let y = scaffold.top; y >= scaffold.base; y--) {
          if (Date.now() > deadline) break;
          try { const d = await api.cmd('dig_at', { x: scaffold.x, y, z: scaffold.z }); if (d && d.dug) dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; }
          catch (e) { break; }
          await api.sleep(200);
        }
        notes.push('леса убраны');
      }
      return { placed: n, failed: roofFailed, planned: cells.length };
    });

    // ---- дверь и окно ----
    let doorWhy = '';
    let doorOk = /_door$/.test(W.get(P.door.x, P.door.y, P.door.z));
    await stage('дверь', async () => {
      if (doorOk) { api.log('дверь: уже стоит'); return; }
      const st = cellState(W.get(P.door.x, P.door.y, P.door.z));
      if (st === 'soft') {
        const d = await clearSoft(P.door.x, P.door.y, P.door.z);
        if (!d.ok) { doorWhy = 'проём двери занят: ' + d.why; api.log('дверь: ' + doorWhy); failed.push({ at: [P.door.x, P.door.y, P.door.z], why: doorWhy }); return; }
      } else if (st === 'built') {
        doorWhy = 'место двери занято: ' + W.get(P.door.x, P.door.y, P.door.z);
        api.log('дверь: ' + doorWhy);
        failed.push({ at: [P.door.x, P.door.y, P.door.z], why: doorWhy });
        return;
      }
      const it = take(Object.keys(stock).filter(n => /_door$/.test(n)));
      if (!it) { doorWhy = 'нет двери в инвентаре (' + DOOR + ')'; api.log('дверь: ' + doorWhy); failed.push({ at: [P.door.x, P.door.y, P.door.z], why: doorWhy }); return; }
      // дверь ставим снаружи и смотрим на неё — тогда она откроется наружу-внутрь как надо
      const outX = P.door.x + (P.door.x === ox1 ? -1 : P.door.x === ox2 ? 1 : 0);
      const outZ = P.door.z + (P.door.z === oz1 ? -1 : P.door.z === oz2 ? 1 : 0);
      try { await api.cmd('goto', { x: outX, z: outZ, timeout: 25 }); } catch (e) { /* может не дойти — поставим как есть */ }
      try { await api.cmd('look_at', { x: P.door.x, y: P.door.y, z: P.door.z }); } catch (e) { /* не критично */ }
      const r = await placeWithSupport(P.door, it);
      if (r.ok) {
        placed[it] = (placed[it] || 0) + 1; W.set(P.door.x, P.door.y, P.door.z, it); doorOk = true;
        api.log('дверь: поставлена');
      } else {
        give(it);
        doorWhy = whyNot(P.door.x, P.door.y, P.door.z, r.err);
        api.log('дверь: ' + doorWhy);
        failed.push({ at: [P.door.x, P.door.y, P.door.z], why: doorWhy });
      }
    });
    await stage('окно', async () => {
      if (!P.window) return;
      const b = W.get(P.window.x, P.window.y, P.window.z);
      if (b !== 'air' && b !== '?') {
        const d = await clearSoft(P.window.x, P.window.y, P.window.z);
        if (!d.ok) { notes.push('окно: проём занят — ' + d.why); return; }
      }
      const g = Object.keys(stock).find(n => (n === 'glass_pane' || n === 'glass') && stock[n] > 0);
      if (!g) { notes.push('окно: нет стекла — проём оставлен пустым'); api.log('окно: нет стекла, проём пустой'); return; }
      const r = await placeOne(P.window.x, P.window.y, P.window.z, g);
      if (r.ok) { placed[g] = (placed[g] || 0) + 1; stock[g]--; W.set(P.window.x, P.window.y, P.window.z, g); api.log('окно: поставлено'); }
      else { notes.push('окно: ' + whyNot(P.window.x, P.window.y, P.window.z, r.err)); api.log('окно: ' + whyNot(P.window.x, P.window.y, P.window.z, r.err)); }
    });

    // ---- итоговая проверка ----
    await api.sleep(400);
    let W2 = W;
    try { W2 = makeWorld(await api.cmd('survey', svBox)); } catch (e) { notes.push('итоговый survey: ' + short(e.message)); }
    let built = 0; const holes = []; let unknown = 0;
    for (const c of P.cells) {
      const b = W2.get(c.x, c.y, c.z);
      if (isHard(b)) { built++; continue; }              // снег/трава за блок плана не считаются
      const k = k3(c.x, c.y, c.z);
      if (placedSet.has(k)) { built++; unknown++; continue; }
      if (b === '?' && isHard(W.get(c.x, c.y, c.z)) && !dugSet.has(k)) { built++; unknown++; continue; }
      holes.push([c.x, c.y, c.z]);
    }
    doorOk = /_door$/.test(W2.get(P.door.x, P.door.y, P.door.z)) || /_door$/.test(W.get(P.door.x, P.door.y, P.door.z));
    const ok = built === P.cells.length && doorOk;
    const res = {
      ok, built, total: P.cells.length, doorOk, doorWhy, holes: holes.slice(0, 30), unknown,
      placed, dug: dugTotal, dug_by: dugBy, need, have, missing, already, by_kind: byKind,
      support: supportUsed, plan, door: P.door, window: P.window, interior: { x: ix, z: iz }, floorY: fy,
      notes, sec: Math.round((Date.now() - t0) / 1000)
    };
    if (roofInfo) res.roof = roofInfo;
    if (stageErrors.length) res.stage_errors = stageErrors;
    if (failed.length) res.failed = failed.slice(0, 15);
    if (blocked.length) res.blocked = blocked.slice(0, 8);
    if (!ok) res.error = `построено ${built}/${P.cells.length}${doorOk ? '' : ', двери нет'}; дыры: ${JSON.stringify(holes.slice(0, 6))}`;
    else if (dugTotal === 0 && already === P.cells.length) res.status = 'уже стоит';
    return res;
  }
};
