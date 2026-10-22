// версия: по заявке учителя: прекращает стройку при мобе ближе mob_d, ночи (night_margin), HP ниже min_hp; пустые клетки не копает (max_empty); не ставит блок под себя; дверь над обрывом не вешает
// build_hut — хижина 5x5 внутри (7x7 снаружи) на краю каньона.
// params: x,z — внутренний юго-западный угол (минимальные x,z), y — верхний блок пола (на нём стоят внутри);
//         door: west|east|south|north (по умолчанию west); window: сторона (по умолчанию как дверь) или none;
//         roof: planks|mixed (mixed: край булыжником, середина досками); corners: log|cobble;
//         max_sec: потолок стройки (по умолчанию 900); dry=1 — только смета;
//         mob_d: ближе какого расстояния моб = опасность (8);
//         night_margin: не начинать/прекратить, если до ночи меньше (30; 0 — только когда уже ночь);
//         min_hp: ниже этого HP не строим (8); max_empty: сколько «уже пусто» подряд — прекратить копку (3).
// План: 167 клеток = 49 пол (y=fy) + 69 стены (y=fy+1..fy+3) + 49 крыша (y=fy+4).
// Порядок: безопасность → survey → план → выравнивание (внутри) → пол → стены → крыша → окно → дверь → итоговый survey.
//
// Правила (заявка учителя, brain/skill_requests/build_hut.md):
//   • пустую клетку НЕ копаем: сначала взгляд (look_at) и survey, счётчик «уже пусто» — после max_empty
//     подряд копка прекращается, в лог идёт одна строка с причиной, дальше — то, что ещё можно поставить;
//   • дверь в клетку, за которой пусто (край обрыва), НЕ пробуем: «дверь (x y z): за стеной пусто, опоры нет»;
//   • блок не ставим в клетку, на которой стоит муха: сходим на соседнюю клетку с твёрдой опорой и ставим сбоку;
//   • на краю обрыва муху не оставляем: после неудачи уходим на клетку с твёрдым верхом;
//   • моб ближе mob_d или ночь → прекращаем стройку и отдаём тело (короткий отказ, а не минута работы);
//   • «построено N/167» считаем по реально стоящим блокам плана, в лог пишем, что осталось и почему
//     («крыша: готово, поставлено N», «крыша: X/Y», «дверь: <причина>»);
//   • прогон не ухудшает хижину: стоящие блоки плана не копаем никогда, леса убираем только свои.
const COBBLE = 'cobblestone';
const LOG = 'spruce_log';
const PLANK = 'spruce_planks';
const SIDES = ['west', 'east', 'south', 'north'];
const FACE = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const SIDE4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OUT_DIR = { west: [-1, 0], east: [1, 0], south: [0, 1], north: [0, -1] };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|deep_snow|dirt_path|dead_bush|glow_lichen|vine|moss_carpet|hanging_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|sweet_berry_bush|leaf_litter|wildflowers|brown_mushroom|red_mushroom|fire|firefly_bush)$/;
const FLUID = /water|lava|bubble_column/;
const NOTFULL = /(torch|door|slab|carpet|sign|banner|button|pressure_plate|rail|ladder|chain|flower_pot|bed|sapling|leaves|stairs|candle|flower|pot|wire)$/;
const PROTECTED = /(chest|barrel|furnace|smoker|crafting_table|spawner|anvil|beacon|enchanting_table|brewing_stand|cauldron|lectern|loom|stonecutter|grindstone|piston|observer|hopper|shulker|conduit|bell|target|note_block|jukebox)$/;
const FILLERS = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'dirt', 'coarse_dirt', 'gravel', 'sand', 'netherrack', 'stone_bricks', 'calcite', 'dripstone_block', 'blackstone', 'mud_bricks'];
const SUPPORT_BLOCKS = FILLERS.concat([LOG]);
// блоки, которыми тело умеет растить леса (pillar_up): доски и брёвна не берёт
const SCAFFOLD_ITEMS = ['dirt', 'coarse_dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'blackstone'];

const isDry = p => p && (p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true');
const short = m => String(m === undefined || m === null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim().slice(0, 160);
const k3 = (x, y, z) => x + ',' + y + ',' + z;
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isAirName = n => typeof n === 'string' && /^(air|cave_air|void_air)$/.test(n);
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
  description: 'Хижина 5x5 внутри (7x7 снаружи) у края каньона: пол/фундамент булыжником, стены булыжник + брёвна по углам, плоская крыша (planks|mixed), дверь и окно на запад. Считает по survey с учётом уже стоящих; стоящие блоки плана не копает никогда (прогон не ухудшает хижину). Пустые клетки не копает: после 3 отказов «уже пусто» подряд копка прекращается с одной строкой в лог. Блок не ставит в клетку, на которой стоит муха — сходит вбок; на краю обрыва муху не оставляет. Дверь в клетку, за которой пусто (край обрыва), не пробует: пишет «за стеной пусто, опоры нет» и заканчивает. При мобе ближе mob_d или ночью прекращает стройку и отдаёт тело. «Построено N/167» считается по реально стоящим блокам; в лог пишется, что осталось и почему. Не хватает на стены — отказ с missing. dry=1 — смета.',
  params: {
    x: 'x внутреннего юго-западного угла (минимум)',
    z: 'z внутреннего юго-западного угла (минимум)',
    y: 'y верхнего блока пола (на нём стоят внутри)',
    door: 'сторона двери: west (по умолчанию), east, south, north',
    window: 'сторона окна (по умолчанию как дверь), none — без окна; окно — проём 1x1 (glass_pane/glass, если есть)',
    roof: 'planks (по умолчанию) или mixed (край булыжником, середина досками)',
    corners: 'log (по умолчанию, брёвна по углам) или cobble (без дерева)',
    max_sec: 'ограничение времени стройки, по умолчанию 900',
    dry: '1 — ничего не строить, вернуть need/have/missing/по слоям/plan',
    mob_d: 'ближе какого расстояния враждебный моб = опасность (отказ), по умолчанию 8 м',
    night_margin: 'не начинать и прекратить, если до ночи меньше (по умолчанию 30 с; 0 — только когда уже ночь)',
    min_hp: 'ниже этого HP не строим (отказ), по умолчанию 8',
    max_empty: 'сколько отказов «уже пусто (air)» подряд считать пустой работой и прекратить копку, по умолчанию 3'
  },

  async run(api, params) {
    const pr = params || {};
    const ix = Math.round(numOr(pr.x, NaN)), iz = Math.round(numOr(pr.z, NaN)), fy = Math.round(numOr(pr.y, NaN));
    if (![ix, iz, fy].every(Number.isFinite)) return { ok: false, error: 'нужны x, z (внутренний юго-западный угол) и y (верх пола)' };
    const door = SIDES.includes(pr.door) ? pr.door : 'west';
    const windowSide = pr.window === 'none' ? null : (SIDES.includes(pr.window) ? pr.window : door);
    const roof = pr.roof === 'mixed' ? 'mixed' : 'planks';
    const corners = pr.corners === 'cobble' ? 'cobble' : 'log';
    const dry = isDry(pr);
    const maxSec = Math.min(Math.max(numOr(pr.max_sec, 900), 60), 1800);
    const mobD = Math.max(numOr(pr.mob_d, 8), 0);
    const nightMargin = pr.night_margin === undefined ? 30 : Math.max(numOr(pr.night_margin, 30), 0);
    const minHp = pr.min_hp === undefined ? 8 : Math.max(numOr(pr.min_hp, 8), 0);
    const maxEmpty = Math.max(numOr(pr.max_empty, 3), 1);
    const t0 = Date.now();
    const deadline = t0 + maxSec * 1000;
    const notes = [];
    const stages = {};
    const P = makePlan(ix, iz, fy, door, windowSide, roof, corners);
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
      } catch (e) { /* инвентарь останется как есть */ }
    };
    await refreshStock();
    const stockOf = k => stock[k] || 0;
    const take = prefs => { for (const it of prefs) if ((stock[it] || 0) > 0) { stock[it]--; return it; } return null; };
    const give = it => { if (it) stock[it] = (stock[it] || 0) + 1; };

    // ---------- снимок, позиция, безопасность ----------
    let snap = null, lastPos = null;
    const takeSnap = async () => {
      try { snap = await api.snapshot(); lastPos = (snap && snap.position) || lastPos; return snap; }
      catch (e) { return null; }
    };
    const refreshPos = async () => { await takeSnap(); return lastPos || {}; };
    const distOf = e => (e && e.d !== null && e.d !== undefined && Number.isFinite(Number(e.d))) ? Number(e.d) : Infinity;
    // Ночь, моб рядом, мало HP → стройку не ведём, тело отдаём сразу (короткий отказ).
    const safety = async () => {
      const s = await takeSnap();
      if (!s) return null;                       // снимок не получился — не мешаем стройке
      const eyes = s.eyes || {}, tm = eyes.time || {};
      const nightIn = Number.isFinite(Number(tm.nightIn)) ? Number(tm.nightIn) : null;
      if (nightIn !== null && nightIn <= nightMargin) {
        const why = nightIn === 0 ? ('ночь (' + tm.phase + ')') : ('до ночи ' + nightIn + ' с');
        return { why: 'night', error: why + ' — стройку прекращаю, тело отдаю' };
      }
      const en = (eyes.enemies || []).filter(e => distOf(e) <= mobD);
      if (en.length) return { why: 'mob', error: 'моб рядом: ' + en[0].name + ' ' + distOf(en[0]) + ' м — стройку прекращаю, тело отдаю' };
      const th = (eyes.threats || []).filter(e => distOf(e) <= mobD);
      if (th.length) return { why: 'mob', error: 'враг-игрок рядом: ' + th[0].name + ' ' + distOf(th[0]) + ' м — стройку прекращаю, тело отдаю' };
      const hp = Number(s.health);
      if (Number.isFinite(hp) && minHp > 0 && hp < minHp) return { why: 'hp', error: 'HP ' + hp + ' — стройку прекращаю, тело отдаю' };
      return null;
    };

    // ночью/при мобе стройку не начинаем
    if (!dry) {
      const bad = await safety();
      if (bad) {
        api.log('build_hut: ' + bad.error);
        return { ok: false, error: bad.error, why: bad.why, built: 0, total: P.cells.length, sec: Math.round((Date.now() - t0) / 1000) };
      }
    }

    // ---------- подойти к площадке ----------
    if (!dry) {
      const p = lastPos || (await refreshPos());
      if (Math.hypot((p.x || 0) - (ix + 2), (p.z || 0) - (iz + 2)) > 9) {
        try { await api.cmd('goto', { x: ix + 2, z: iz + 6, timeout: 20 }); }
        catch (e) { return { ok: false, error: 'не дошла до площадки: ' + short(e.message), sec: Math.round((Date.now() - t0) / 1000) }; }
        await refreshPos();
      }
    }

    // ---------- survey (с запасом вокруг) ----------
    const svBox = { x1: ox1 - 3, y1: fy - 3, z1: oz1 - 3, x2: ox2 + 3, y2: fy + 5, z2: oz2 + 3 };
    let sv;
    try { sv = await api.cmd('survey', svBox); }
    catch (e) { return { ok: false, error: 'survey: ' + short(e.message), sec: Math.round((Date.now() - t0) / 1000) }; }
    const W = makeWorld(sv);

    // ---------- что уже стоит / что строить ----------
    const need = {}, have = {}, missing = {};
    const byKind = { floor: { need: 0, already: 0, todo: 0, placed: 0 }, wall: { need: 0, already: 0, todo: 0, placed: 0 }, roof: { need: 0, already: 0, todo: 0, placed: 0 } };
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
    for (const k of Object.keys(need)) { have[k] = stockOf(k); if (have[k] < need[k]) missing[k] = need[k] - have[k]; }

    const doorB = W.get(P.door.x, P.door.y, P.door.z);
    const doorItem = Object.keys(stock).find(n => /_door$/.test(n) && stock[n] > 0);
    if (!/_door$/.test(doorB) && doorItem) need[doorItem] = (need[doorItem] || 0) + 1;
    const structTodo = todo.floor.length + todo.wall.length;
    const poolAll = FILLERS.concat([LOG, PLANK]).reduce((s, f) => s + (stock[f] || 0), 0);
    const todoAll = todo.floor.length + todo.wall.length + todo.roof.length;
    const plan = `хижина ${ox1}…${ox2} x ${oz1}…${oz2}, пол y=${fy}, дверь ${door} (${P.door.x} ${P.door.y} ${P.door.z})` +
      (P.window ? `, окно (${P.window.x} ${P.window.y} ${P.window.z})` : '') +
      `; клеток в плане ${P.cells.length}, уже стоит ${already}, ставить ${todoAll}` +
      ` (пол ${todo.floor.length}, стены ${todo.wall.length}, крыша ${todo.roof.length})` +
      (unknownCells ? `; ${unknownCells} клеток не видно (считаем пустыми, но не копаем их — пробуем поставить)` : '');

    if (dry) {
      const r = { ok: true, dry: true, need, have, missing, plan, door: P.door, window: P.window, total: P.cells.length, already, unknown: unknownCells, by_kind: byKind, todo: todoAll, blocks_available: poolAll };
      if (blocked.length) r.blocked = blocked.slice(0, 8);
      if (missing[LOG] && corners === 'log') r.hint = 'брёвен мало — corners=cobble';
      if (Object.keys(missing).length) r.hint2 = `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${stockOf(k) + n}`).join(',')}"`;
      const s = await takeSnap();
      if (s && s.eyes && s.eyes.time && Number(s.eyes.time.nightIn) <= nightMargin) r.note = 'сейчас ночь (или скоро) — стройку лучше не начинать';
      return r;
    }

    // ---------- хватает ли материала на пол/стены ----------
    if (structTodo > 0 && poolAll < structTodo) {
      const miss = Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ');
      return { ok: false, error: 'не хватает блоков на пол и стены, не начинаю: нужно ' + structTodo + ', есть ' + poolAll + (miss ? ' (' + miss + ')' : ''), need, have, missing, plan, by_kind: byKind, blocks_available: poolAll, sec: Math.round((Date.now() - t0) / 1000),
        hint: `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${stockOf(k) + n}`).join(',') || 'cobblestone:' + structTodo}"` };
    }
    if (todo.roof.length && Object.keys(missing).length) {
      notes.push('материала не хватает — строю из того, что есть (стены/пол важнее крыши)');
    }

    // ---------- рабочее ----------
    const placed = {}, dugBy = {};
    const failed = [], placedSet = new Set();
    let dugTotal = 0;

    const placeOne = async (x, y, z, item) => {
      try { await api.cmd('place_at', { x, y, z, item }); return { ok: true }; }
      catch (e) { return { ok: false, err: short(e.message) }; }
    };
    // Взгляд в клетку: настоящий блок там или воздух (тело двигаться не должно).
    const probe = async (x, y, z) => {
      try {
        const r = await api.cmd('look_at', { x, y, z });
        return (r && typeof r.looking === 'string') ? r.looking : null;
      } catch (e) { return null; }
    };
    // Муха стоит на этой клетке? (та же геометрия, что у тела: хитбокс 0.6 x 1.8)
    const botOverlaps = (x, y, z) => {
      const p = lastPos;
      if (!p) return false;
      const px = Number(p.x), py = Number(p.y), pz = Number(p.z);
      if (![px, py, pz].every(Number.isFinite)) return false;
      return x < px + 0.3 && x + 1 > px - 0.3 && z < pz + 0.3 && z + 1 > pz - 0.3 && y < py + 1.8 && y + 1 > py;
    };
    // Столб под ногами твёрдый? (null — колонки в survey не видно: стоять нельзя)
    // Клетка без твёрдого верха — край обрыва: муху там не оставляем.
    const isVoidColumn = (x, z) => W.height(x, z) === null;
    const onEdge = (x, y, z) => {
      const below = W.get(x, y - 1, z);
      if (below !== '?' && !isHard(below)) return true;                                  // под ногами пусто
      if (isVoidColumn(x, z) && x >= ox1 && x <= ox2 && z >= oz1 && z <= oz2) return true; // внутри хижины над пустотой
      return false;
    };

    // Сойти с клетки установки: встать рядом на твёрдое и поставить сбоку.
    const stepAside = async cell => {
      await refreshPos();
      if (!botOverlaps(cell.x, cell.y, cell.z)) return true;
      const cands = [];
      for (const [dx, dz] of SIDE4) {
        for (const d of [0, 1]) {
          const nx = cell.x + dx * (1 + d), nz = cell.z + dz * (1 + d);
          const ny = cell.y;
          if (botOverlaps(nx, ny, nz)) continue;
          if (!isHard(W.get(nx, ny - 1, nz))) continue;     // под ногами должно быть твёрдо
          if (isVoidColumn(nx, nz)) continue;               // на краю обрыва не встаём
          cands.push({ x: nx, y: ny, z: nz });
        }
      }
      for (const s of cands) {
        try { await api.cmd('goto', { x: s.x, y: s.y, z: s.z, timeout: 12 }); }
        catch (e) { continue; }
        await refreshPos();
        if (!botOverlaps(cell.x, cell.y, cell.z)) return true;
      }
      return false;
    };
    // Поставить блок, не вставая на клетку установки.
    const placeSafe = async (cell, item) => {
      let r = await placeOne(cell.x, cell.y, cell.z, item);
      if (r.ok) return { ok: true };
      if (!/стоит на месте установки/.test(String(r.err || ''))) return r;
      const moved = await stepAside(cell);
      if (!moved) return r;
      r = await placeOne(cell.x, cell.y, cell.z, item);
      return r;
    };
    // Уйти с края: если муха стоит над пустотой — отвести её на твёрдую клетку.
    const leaveEdge = async why => {
      const p = await refreshPos();
      if (!p || !Number.isFinite(Number(p.x))) return false;
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      if (!onEdge(bx, by, bz)) return false;
      const spot = safeSpot();
      if (!spot) { notes.push('край: ' + why + ' — уйти некуда'); return false; }
      try {
        await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 12 });
        await refreshPos();
        notes.push('край (' + bx + ' ' + bz + '): ' + why + ' — ушла на ' + spot.x + ' ' + spot.y + ' ' + spot.z);
        return true;
      } catch (e) {
        notes.push('край (' + bx + ' ' + bz + '): ' + why + ' — уйти не удалось: ' + short(e.message));
        return false;
      }
    };
    // Где безопасно стоять: сначала внутри хижины, потом снаружи на твёрдом.
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

    // Точная причина, почему клетка не закрылась.
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

    // Поставить/проверить одну клетку плана. Стоящие блоки НЕ копаем никогда.
    const doCell = async cell => {
      const b = W.get(cell.x, cell.y, cell.z);
      const st = cellState(b);
      if (st === 'built') return 'already';
      if (st === 'protected') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'занято: ' + b }); return 'blocked'; }
      if (st === 'fluid') { failed.push({ at: [cell.x, cell.y, cell.z], why: 'вода/лава — строить нельзя' }); return 'blocked'; }
      let item = take(cell.prefs.concat(FILLERS, [PLANK]));
      if (!item) { failed.push({ at: [cell.x, cell.y, cell.z], why: 'нет блока в инвентаре (' + cell.prefs.join('/') + ')' }); return 'nomaterial'; }
      let r = await placeSafe(cell, item);
      if (!r.ok && /нет в инвентаре/.test(String(r.err || ''))) {
        await refreshStock();                        // инвентарь разошёлся — пересчитать и повторить раз
        give(item);
        item = take(cell.prefs.concat(FILLERS, [PLANK]));
        if (item) r = await placeSafe(cell, item);
      }
      if (!r.ok) {
        const err = String(r.err || '');
        if (/занят/.test(err)) {
          // блок уже стоит — считаем клетку занятой и НЕ копаем (хижину не ухудшаем)
          give(item);
          W.set(cell.x, cell.y, cell.z, 'cobblestone');
          placedSet.add(k3(cell.x, cell.y, cell.z));
          byKind[cell.kind].placed++;
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
      placedSet.add(k3(cell.x, cell.y, cell.z));
      byKind[cell.kind].placed++;
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
    let stopped = null;                       // причина остановки (моб/ночь/время)
    const stageStart = async name => {
      if (stopped) return false;
      const bad = await safety();
      if (bad) { stopped = bad; api.log(name + ': стоп — ' + bad.error); return false; }
      if (Date.now() > deadline) { stopped = { why: 'time', error: 'время вышло (' + name + ')' }; api.log(name + ': стоп — время вышло'); return false; }
      return true;
    };

    // ---- муха внутри: на полу хижины (ноги y=fy+1) ----
    const botInside = () => {
      const p = lastPos || {};
      return p.x >= ox1 && p.x <= ox2 + 1 && p.z >= oz1 && p.z <= oz2 + 1 && Math.floor(p.y || 0) >= fy && Math.floor(p.y || 0) <= fy + 3;
    };
    const enterHut = async () => {
      await refreshPos();
      if (botInside()) return { ok: true, how: 'уже внутри' };
      const tryGoto = async (x, y, z) => {
        try { await api.cmd('goto', { x, y, z, timeout: 20 }); await refreshPos(); return true; }
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
    // Пустые клетки НЕ копаем: сначала взгляд (look_at), и только потом копка.
    await stage('выравнивание', async () => {
      if (!await stageStart('выравнивание')) return { dug: 0, stopped: true };
      const interior = P.clear.filter(c => W.get(c.x, c.y, c.z) !== 'air');
      if (!interior.length) { stages['выравнивание'] = 'выравнивание: готово, чисто'; api.log('выравнивание: готово, чисто'); return { dug: 0 }; }
      const inHut = await enterHut();
      if (!inHut.ok) notes.push('выравнивание: ' + inHut.why);
      let dug = 0, empties = 0, bad = 0;
      for (const c of interior) {
        if (Date.now() > deadline) { notes.push('выравнивание не закончено (время)'); break; }
        if (empties >= maxEmpty) break;
        const seen = await probe(c.x, c.y, c.z);
        if (seen !== null && isAirName(seen)) {
          empties++;
          W.set(c.x, c.y, c.z, 'air');
          if (empties >= maxEmpty) {
            api.log('выравнивание: ' + empties + ' клеток подряд уже пусто (воздух) — копать нечего, перехожу к стройке');
            notes.push('выравнивание: клетки уже пусто — копка прекращена');
            break;
          }
          continue;
        }
        if (seen === null && isAirName(W.get(c.x, c.y, c.z))) { empties++; continue; }
        // клетка не воздух — пробуем убрать
        let d;
        try { d = await api.cmd('dig_at', { x: c.x, y: c.y, z: c.z }); }
        catch (e) {
          const err = short(e.message);
          if (/уже пусто|нет такого блока|пусто/.test(err)) {
            empties++;
            W.set(c.x, c.y, c.z, 'air');
            if (empties >= maxEmpty) { api.log('выравнивание: ' + empties + ' клеток подряд уже пусто — копать нечего, перехожу к стройке'); break; }
            continue;
          }
          bad++;
          if (bad >= 3) { notes.push('внутри копать не вышло: ' + c.x + ' ' + c.y + ' ' + c.z + ' — ' + err); break; }
          continue;
        }
        dug++;
        if (d && d.dug) dugBy[d.dug] = (dugBy[d.dug] || 0) + 1;
        W.set(c.x, c.y, c.z, 'air');
        if (d && d.got) for (const [n, cc] of Object.entries(d.got)) if (FILLERS.includes(n) || n === PLANK || n === LOG) stock[n] = (stock[n] || 0) + cc;
      }
      stages['выравнивание'] = 'выравнивание: готово, снято ' + dug;
      api.log(stages['выравнивание']);
      return { dug };
    });

    // ---- этап 1: пол/фундамент, этап 2: стены ----
    const runStage = async (name, list, keyFn) => {
      const rest = list.slice();
      const total = list.length;
      const failedBefore = failed.length;
      let n = 0, bad = 0, seen = 0;
      while (rest.length) {
        if (Date.now() > deadline) { notes.push(name + ': время вышло, осталось ' + rest.length); break; }
        if (seen++ % 6 === 0) {
          const bad2 = await safety();
          if (bad2) { stopped = bad2; api.log(name + ': стоп — ' + bad2.error); break; }
        }
        const c = pickNext(rest, keyFn);
        if (!c) break;
        const before = failed.length;
        const r = await doCell(c);
        if (r === 'placed' || r === 'occupied') n++;
        if (r === 'failed' && failed.length > before) {
          const why = failed[failed.length - 1].why || '';
          if (/недоступно|не могу подойти|подойти/.test(why)) { bad++; if (bad >= 4) { notes.push(name + ': клетки недоступны, стоп'); break; } } else bad = 0;
        }
        if (n && n % 20 === 0) api.log(name + ': поставлено ' + n);
      }
      const notPlaced = failed.length - failedBefore;
      const text = name + ': готово, поставлено ' + n + (notPlaced ? ', не поставлено ' + notPlaced : '') + ' из ' + total;
      stages[name] = text;
      api.log(text);
      return n;
    };

    await stage('пол', async () => {
      if (!await stageStart('пол')) return 0;
      await refreshStock();
      return runStage('пол', todo.floor, c => [-nbrs(c), c.y, c.z, c.x]);
    });
    await stage('стены', async () => {
      if (!await stageStart('стены')) return 0;
      await refreshStock();
      return runStage('стены', todo.wall, c => [c.y, c.corner ? 1 : 0, -nbrs(c), c.z, c.x]);
    });

    // ---- этап 3: крыша ----
    const roofInfo = await stage('крыша', async () => {
      if (!await stageStart('крыша')) return { placed: 0, failed: [], planned: todo.roof.length };
      if (!todo.roof.length) { stages['крыша'] = 'крыша: готово, ставить нечего'; api.log(stages['крыша']); return { placed: 0, failed: [], planned: 0 }; }
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
        try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 15 }); await refreshPos(); return { ok: true }; }
        catch (e) { return { ok: false, why: 'не встала (' + spot.how + '): ' + short(e.message) }; }
      };
      // Опора под клеткой крыши: стена (roofY-1) под клеткой над стеной. Нет — достроить.
      const ensureBelow = async cell => {
        const bx = cell.x, by = roofY - 1, bz = cell.z;
        if (!isWallCell(bx, bz)) return false;
        if (isHard(W.get(bx, by, bz))) return true;
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
          const h = W.height(nx, nz);
          if (h === null || h < fy) continue;            // там пустота/обрыв — леса не строим
          outs.push({ x: nx, z: nz, y: h + 1 });
        }
        if (!outs.length) return { ok: false, why: 'нет места снаружи для лесов (везде обрыв)' };
        const spot = outs[0];
        try { await api.cmd('goto', { x: spot.x, y: spot.y, z: spot.z, timeout: 20 }); }
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

      let n = 0, seen = 0;
      const roofFailed = [];
      for (const cell of cells) {
        if (Date.now() > deadline) { notes.push('крыша: время вышло, осталось ' + (cells.length - n - roofFailed.length)); break; }
        if (seen++ % 5 === 0) {
          const bad2 = await safety();
          if (bad2) { stopped = bad2; api.log('крыша: стоп — ' + bad2.error); break; }
        }
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
          let r = await placeSafe(cell, item);
          if (r.ok) { done = true; break; }
          last = whyNot(cell.x, cell.y, cell.z, r.err);
          if (/прислонить/.test(String(r.err || '')) && await ensureBelow(cell)) {
            r = await placeSafe(cell, item);
            if (r.ok) { done = true; break; }
            last = whyNot(cell.x, cell.y, cell.z, r.err);
          }
          if (/занят/.test(String(r.err || ''))) { done = true; break; }   // блок уже стоит — не копаем
        }
        if (!done && !inHut.ok) {
          // внутри нет — пробуем леса снаружи (только для клеток над стеной)
          const sc = await scaffoldFor(cell);
          if (sc.ok) {
            const r = await placeSafe(cell, item);
            if (r.ok) done = true;
            else last = whyNot(cell.x, cell.y, cell.z, r.err);
          } else last = last + '; ' + sc.why;
        }
        if (done) {
          n++;
          placed[item] = (placed[item] || 0) + 1;
          W.set(cell.x, cell.y, cell.z, item);
          placedSet.add(k3(cell.x, cell.y, cell.z));
          byKind.roof.placed++;
          if (n % 10 === 0) api.log('крыша: поставлено ' + n);
        } else {
          give(item);
          roofFailed.push({ at: [cell.x, cell.y, cell.z], why: last });
          api.log('крыша: ' + cell.x + ' ' + cell.y + ' ' + cell.z + ' — ' + last);
          if (onEdge(cell.x, cell.y, cell.z)) await leaveEdge(last);
        }
      }
      const standing = byKind.roof.already + (todo.roof.length - roofFailed.length);
      stages['крыша'] = 'крыша: готово, поставлено ' + n + (roofFailed.length ? ', не поставлено ' + roofFailed.length : '');
      api.log(stages['крыша']);
      api.log('крыша: ' + standing + '/' + (byKind.roof.already + todo.roof.length));
      if (scaffold) {
        // убираем ТОЛЬКО свои леса (ниже основания — земля, её не трогаем)
        try { await api.cmd('goto', { x: scaffold.x, z: scaffold.z, timeout: 20 }); } catch (e) { /* может не дойти */ }
        for (let y = scaffold.top; y > scaffold.base; y--) {
          if (Date.now() > deadline) break;
          try { const d = await api.cmd('dig_at', { x: scaffold.x, y, z: scaffold.z }); if (d && d.dug) dugBy[d.dug] = (dugBy[d.dug] || 0) + 1; }
          catch (e) { break; }
          await api.sleep(200);
        }
        notes.push('леса убраны');
      }
      return { placed: n, failed: roofFailed, planned: cells.length };
    });

    // ---- окно ----
    let windowOk = false;
    await stage('окно', async () => {
      if (!P.window) return;
      if (!await stageStart('окно')) return;
      const b = W.get(P.window.x, P.window.y, P.window.z);
      if (b !== 'air' && b !== '?') {
        api.log('окно: место занято (' + b + ')');
        stages['окно'] = 'окно: место занято (' + b + ')';
        return;
      }
      const g = Object.keys(stock).find(n => (n === 'glass_pane' || n === 'glass') && stock[n] > 0);
      if (!g) { stages['окно'] = 'окно: нет стекла — проём оставлен пустым'; api.log(stages['окно']); return; }
      const r = await placeSafe(P.window, g);
      if (r.ok) {
        placed[g] = (placed[g] || 0) + 1; stock[g]--; W.set(P.window.x, P.window.y, P.window.z, g);
        windowOk = true;
        stages['окно'] = 'окно: поставлено';
      } else {
        stages['окно'] = 'окно: ' + whyNot(P.window.x, P.window.y, P.window.z, r.err);
      }
      api.log(stages['окно']);
    });

    // ---- дверь ----
    let doorWhy = '';
    let doorOk = /_door$/.test(W.get(P.door.x, P.door.y, P.door.z));
    await stage('дверь', async () => {
      if (doorOk) { stages['дверь'] = 'дверь: уже стоит'; api.log(stages['дверь']); return; }
      if (!await stageStart('дверь')) return;
      const at = P.door;
      // За стеной (вне хижины) пусто? — дверь туда вешать не на что: опоры нет.
      const od = OUT_DIR[door] || [-1, 0];
      const bx = at.x + od[0], bz = at.z + od[1];
      const behind = await probe(bx, at.y, bz);
      const behindEmpty = behind !== null ? isAirName(behind) : isAirName(W.get(bx, at.y, bz));
      let support = 0;
      for (const [dx, dy, dz] of FACE) if (isHard(W.get(at.x + dx, at.y + dy, at.z + dz))) support++;
      if (behindEmpty) {
        doorWhy = 'за стеной пусто, опоры нет';
        stages['дверь'] = 'дверь (' + at.x + ' ' + at.y + ' ' + at.z + '): ' + doorWhy;
        api.log(stages['дверь']);
        failed.push({ at: [at.x, at.y, at.z], why: doorWhy });
        notes.push('дверь (' + at.x + ' ' + at.y + ' ' + at.z + '): ' + doorWhy + ' — не пробую');
        return;   // ту же клетку не повторяем
      }
      if (support === 0) {
        doorWhy = 'нет опоры (снизу и сбоку пусто)';
        stages['дверь'] = 'дверь (' + at.x + ' ' + at.y + ' ' + at.z + '): ' + doorWhy;
        api.log(stages['дверь']);
        failed.push({ at: [at.x, at.y, at.z], why: doorWhy });
        return;
      }
      const it = take(Object.keys(stock).filter(n => /_door$/.test(n)));
      if (!it) { doorWhy = 'нет двери в инвентаре (spruce_door)'; stages['дверь'] = 'дверь: ' + doorWhy; api.log(stages['дверь']); failed.push({ at: [at.x, at.y, at.z], why: doorWhy }); return; }
      // дверь ставим снаружи и смотрим на неё — тогда она откроется наружу-внутрь как надо
      const outX = at.x + od[0], outZ = at.z + od[1];
      try { await api.cmd('goto', { x: outX, z: outZ, timeout: 15 }); } catch (e) { /* может не дойти — поставим как есть */ }
      try { await api.cmd('look_at', { x: at.x, y: at.y, z: at.z }); } catch (e) { /* не критично */ }
      const r = await placeSafe(at, it);
      if (r.ok) {
        placed[it] = (placed[it] || 0) + 1; W.set(at.x, at.y, at.z, it); doorOk = true;
        stages['дверь'] = 'дверь: поставлена';
      } else {
        give(it);
        doorWhy = whyNot(at.x, at.y, at.z, r.err);
        stages['дверь'] = 'дверь (' + at.x + ' ' + at.y + ' ' + at.z + '): ' + doorWhy;
        failed.push({ at: [at.x, at.y, at.z], why: doorWhy });
      }
      api.log(stages['дверь']);
    });

    // ---- итоговая проверка ----
    await api.sleep(400);
    let W2 = W;
    try { W2 = makeWorld(await api.cmd('survey', svBox)); } catch (e) { notes.push('итоговый survey: ' + short(e.message)); }
    let built = 0; const holes = [], holeWhy = []; let unknown = 0;
    for (const c of P.cells) {
      const b = W2.get(c.x, c.y, c.z);
      if (isHard(b)) { built++; continue; }              // снег/трава за блок плана не считаются
      const k = k3(c.x, c.y, c.z);
      if (placedSet.has(k)) { built++; unknown++; continue; }
      holes.push([c.x, c.y, c.z]);
      const f = failed.find(x => x.at[0] === c.x && x.at[1] === c.y && x.at[2] === c.z);
      if (f) holeWhy.push({ at: [c.x, c.y, c.z], why: f.why });
    }
    doorOk = doorOk || /_door$/.test(W2.get(P.door.x, P.door.y, P.door.z));
    // муху не оставляем на краю
    await leaveEdge('конец стройки');
    const ok = built === P.cells.length && doorOk;
    const res = {
      ok, built, total: P.cells.length, doorOk, doorWhy, windowOk,
      placed, dug: dugTotal, dug_by: dugBy, need, have, missing, already, by_kind: byKind,
      holes: holes.slice(0, 30), holes_why: holeWhy.slice(0, 20),
      plan, door: P.door, window: P.window, interior: { x: ix, z: iz }, floorY: fy,
      stages, notes, sec: Math.round((Date.now() - t0) / 1000)
    };
    if (roofInfo) res.roof = roofInfo;
    if (stageErrors.length) res.stage_errors = stageErrors;
    if (failed.length) res.failed = failed.slice(0, 15);
    if (blocked.length) res.blocked = blocked.slice(0, 8);
    if (stopped) res.stopped = stopped;
    if (!ok) {
      const parts = [];
      if (stopped) parts.push(stopped.error);
      const roofTotal = byKind.roof.already + todo.roof.length;
      let roofStanding = byKind.roof.already;
      if (roofInfo && roofInfo.failed) roofStanding = byKind.roof.already + Math.max(0, (roofInfo.planned || 0) - roofInfo.failed.length);
      if (roofStanding < roofTotal) parts.push('крыша: ' + roofStanding + '/' + roofTotal);
      if (!doorOk) parts.push('дверь: ' + (doorWhy || 'не поставлена'));
      if (holes.length) parts.push('дыры: ' + holes.slice(0, 6).map(h => h.join(' ')).join(', '));
      res.error = 'построено ' + built + '/' + P.cells.length + (parts.length ? '; ' + parts.join('; ') : '');
    } else if (dugTotal === 0 && already === P.cells.length) res.status = 'уже стоит';
    return res;
  }
};
