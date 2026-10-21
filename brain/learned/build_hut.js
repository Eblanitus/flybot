// build_hut — хижина 5x5 внутри (7x7 снаружи): пол и фундамент из булыжника, стены булыжник + еловые брёвна по углам,
// плоская крыша из досок (или mixed), дверь и окно — по умолчанию на запад (на каньон).
// params: x,z — внутренний юго-западный угол (минимальные x,z), y — верхний блок пола (на нём стоят внутри);
//         door: west|east|south|north; window: та же сторона по умолчанию, none — без окна;
//         roof: planks|mixed; corners: log|cobble; dry=1 — только посчитать.
// Порядок: survey -> расчёт плана с учётом уже стоящих блоков -> нет материалов: отказ с missing ->
//          выравнивание (снять мешающее внутри) -> фундамент/пол -> стены снизу вверх -> крыша -> дверь -> survey-проверка.
// Пример для базы у каньона: x=-397 z=29 y=66 (снаружи x -398…-392, z 28…34, дверь x=-398 z=31).
const COBBLE = 'cobblestone';
const LOG = 'spruce_log';
const PLANK = 'spruce_planks';
const DOOR = 'spruce_door';
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|[a-z_]*tulip|[a-z_]*flower|sweet_berry_bush|leaf_litter)$/;
const FLUID = /water|lava|bubble_column/;
// блоки, которые в стене/полу можно оставить как есть (не ломать ради булыжника)
const KEEP_OK = /^(stone|cobblestone|mossy_cobblestone|andesite|diorite|granite|deepslate|cobbled_deepslate|tuff|calcite|[a-z_]+_planks|[a-z_]+_log|stone_bricks|polished_[a-z_]+)$/;

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';
async function invMap(api) {
  const snap = await api.snapshot(); const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return { inv: m, snap };
}

// План: список клеток {x,y,z,item,kind}; door — клетка двери; window — клетка окна; clear — что снять
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
    // окно рядом с дверью, если на той же стороне: сдвиг на 2 вдоль стены
    wc = windowSide === door ? (c.x === ox1 || c.x === ox2 ? { x: c.x, z: c.z - 2 } : { x: c.x - 2, z: c.z }) : c;
  }
  const cells = [];
  const ring = (x, z) => x === ox1 || x === ox2 || z === oz1 || z === oz2;
  for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    cells.push({ x, y: fy, z, item: COBBLE, kind: ring(x, z) ? 'foundation' : 'floor' });
  }
  for (let y = fy + 1; y <= fy + 3; y++) for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    if (!ring(x, z)) continue;
    if (x === dc.x && z === dc.z && y <= fy + 2) continue;
    if (wc && x === wc.x && z === wc.z && y === fy + 2) continue;
    const corner = (x === ox1 || x === ox2) && (z === oz1 || z === oz2);
    cells.push({ x, y, z, item: corner && y <= fy + 2 && corners === 'log' ? LOG : COBBLE, kind: 'wall' });
  }
  for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
    cells.push({ x, y: fy + 4, z, item: roof === 'mixed' && ring(x, z) ? COBBLE : PLANK, kind: 'roof' });
  }
  const clear = []; // внутренность и проёмы должны быть пустыми
  for (let y = fy + 3; y >= fy + 1; y--) for (let z = iz; z <= iz + 4; z++) for (let x = ix; x <= ix + 4; x++) clear.push({ x, y, z });
  for (const y of [fy + 2, fy + 1]) clear.push({ x: dc.x, y, z: dc.z });
  if (wc) clear.push({ x: wc.x, y: fy + 2, z: wc.z });
  return { cells, clear, door: { x: dc.x, y: fy + 1, z: dc.z }, window: wc ? { x: wc.x, y: fy + 2, z: wc.z } : null, box: { ox1, ox2, oz1, oz2 } };
}

// Клетка уже готова? (для пола/стен — любой подходящий твёрдый блок, для крыши — любой твёрдый)
function satisfied(b, cell) {
  if (b === '?' || AIRLIKE.test(b) || FLUID.test(b)) return false;
  if (b === cell.item) return true;
  if (cell.kind === 'foundation') return !/torch|door|fence|sign|leaves|_slab|carpet/.test(b); // под стеной годится любая опора
  if (cell.kind === 'roof') return !/torch|door|fence|sign|leaves/.test(b);
  return KEEP_OK.test(b);
}

module.exports = {
  name: 'build_hut',
  description: 'Хижина 5x5 внутри (7x7 снаружи) у края каньона: фундамент/пол булыжник, стены булыжник + брёвна по углам, крыша из досок, дверь и окно на запад. Считает блоки по survey с учётом уже стоящих; не хватает — не начинает и возвращает missing. dry=1 — только need/have/missing. Итог проверяет survey.',
  params: {
    x: 'x внутреннего юго-западного угла (минимум)',
    z: 'z внутреннего юго-западного угла (минимум)',
    y: 'y верхнего блока пола (на нём стоят внутри)',
    door: 'сторона двери: west (по умолчанию), east, south, north',
    window: 'сторона окна (по умолчанию как дверь), none — без окна; окно — проём 1x1 (или glass_pane/glass, если есть)',
    roof: 'planks (по умолчанию) или mixed (край булыжником, экономит доски)',
    corners: 'log (по умолчанию, брёвна по углам) или cobble (без дерева)',
    max_sec: 'ограничение времени стройки, по умолчанию 900',
    dry: '1 — ничего не строить, вернуть need/have/missing/plan'
  },
  async run(api, params) {
    const ix = Math.round(Number(params.x)), iz = Math.round(Number(params.z)), fy = Math.round(Number(params.y));
    if (![ix, iz, fy].every(Number.isFinite)) return { ok: false, error: 'нужны x, z (внутренний юго-западный угол) и y (пол)' };
    const SIDES = ['west', 'east', 'south', 'north'];
    const door = SIDES.includes(params.door) ? params.door : 'west';
    const windowSide = params.window === 'none' ? null : (SIDES.includes(params.window) ? params.window : door);
    const roof = params.roof === 'mixed' ? 'mixed' : 'planks';
    const corners = params.corners === 'cobble' ? 'cobble' : 'log';
    const P = makePlan(ix, iz, fy, door, windowSide, roof, corners);
    const svBox = { x1: ix - 2, y1: fy - 2, z1: iz - 2, x2: ix + 6, y2: fy + 5, z2: iz + 6 };
    const dry = isDry(params);
    const t0 = Date.now(); const maxSec = Math.min(Math.max(Number(params.max_sec) || 900, 60), 1800);

    let { inv, snap } = await invMap(api);
    if (!dry) {
      const p = snap.position || {};
      if (Math.hypot((p.x || 0) - (ix + 2), (p.z || 0) - (iz + 2)) > 12) {
        try { await api.cmd('goto', { x: ix + 2, z: iz + 7, timeout: 120 }); }
        catch (e) { return { ok: false, error: 'не дошла до площадки: ' + e.message.slice(0, 160) }; }
      }
    }
    let g = grid(await api.cmd('survey', svBox));

    // расчёт
    const need = {}; let unknown = 0; let already = 0; const todo = [];
    for (const c of P.cells) {
      const b = g(c.x, c.y, c.z);
      if (b === '?') unknown++;
      if (satisfied(b, c)) { already++; continue; }
      todo.push(c);
      need[c.item] = (need[c.item] || 0) + 1;
    }
    const doorBlock = g(P.door.x, P.door.y, P.door.z);
    const doorDone = /_door$/.test(doorBlock);
    if (!doorDone) need[DOOR] = 1;
    const glass = (inv.glass_pane || 0) > 0 ? 'glass_pane' : ((inv.glass || 0) > 0 ? 'glass' : null);
    const toClear = P.clear.filter(c => { const b = g(c.x, c.y, c.z); return b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b) && !/_door$|torch|glass/.test(b); });
    const fluids = [...P.cells, ...P.clear].filter(c => FLUID.test(g(c.x, c.y, c.z))).map(c => [c.x, c.y, c.z]);
    // в стенах/полу заменяем «некрасивое» (земля, трава, гравий) — лом + установка
    const replace = todo.filter(c => { const b = g(c.x, c.y, c.z); return b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b); });

    const have = {}; const missing = {};
    for (const [k, n] of Object.entries(need)) {
      have[k] = inv[k] || 0;
      if (have[k] < n) missing[k] = n - have[k];
    }
    // брёвна можно пустить на доски: показать это в missing честно (gather_list докрафтит)
    const plan = `хижина ${ix - 1}…${ix + 5} x ${iz - 1}…${iz + 5}, пол y=${fy}, дверь ${door} (${P.door.x} ${P.door.y} ${P.door.z})` +
      (P.window ? `, окно ${windowSide} (${P.window.x} ${P.window.y} ${P.window.z})` : '') +
      `; блоков в плане ${P.cells.length}, уже стоит ${already}, ставить ${todo.length}, снять ${toClear.length}` +
      (unknown ? `; ${unknown} клеток не видно (посчитаны как пустые)` : '');

    if (dry) {
      const r = { ok: true, dry: true, need, have, missing, plan, door: P.door, window: P.window, total: P.cells.length, already, unknown, clear: toClear.length };
      if (fluids.length) r.fluids = fluids.slice(0, 10);
      if (missing[LOG] && corners === 'log') r.hint = 'брёвен мало — corners=cobble';
      if (Object.keys(missing).length) r.hint2 = `gather_list items="${Object.entries(missing).map(([k, n]) => `${k}:${(inv[k] || 0) + n}`).join(',')}"`;
      return r;
    }
    if (Object.keys(missing).length) {
      const r = { ok: false, error: 'не хватает материалов, не начинаю: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', '), need, have, missing, plan };
      if (missing[LOG] && corners === 'log') r.hint = 'или corners=cobble (без брёвен)';
      return r;
    }
    if (fluids.length) return { ok: false, error: 'на площадке вода/лава: ' + JSON.stringify(fluids.slice(0, 5)) + ' — выбери другое место', fluids };

    const placed = {}; const failed = []; let dug = 0;
    const timeUp = () => (Date.now() - t0) / 1000 > maxSec;
    const dig = async (x, y, z) => {
      try { await api.cmd('dig_at', { x, y, z }); dug++; }
      catch (e) { if (!/нет такого блока/.test(e.message)) api.log(`dig ${x} ${y} ${z}: ${e.message.slice(0, 100)}`); }
    };
    const put = async c => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await api.cmd('place_at', { x: c.x, y: c.y, z: c.z, item: c.item }); placed[c.item] = (placed[c.item] || 0) + 1; return true; }
        catch (e) {
          if (/занято|занят/.test(e.message)) return true; // там уже что-то стоит (не видели в survey)
          if (attempt === 1) failed.push({ at: [c.x, c.y, c.z], item: c.item, why: e.message.slice(0, 100) });
          else await api.sleep(250);
        }
      }
      return false;
    };

    // 1. выравнивание: снять мешающее внутри и в проёмах (сверху вниз), заменить «некрасивое» в стенах/полу
    for (const c of toClear) { if (timeUp()) break; await dig(c.x, c.y, c.z); }
    for (const c of replace.sort((a, b) => b.y - a.y)) { if (timeUp()) break; await dig(c.x, c.y, c.z); }
    api.log(`выравнивание: снято ${dug}`);
    // 2. фундамент и пол, 3. стены снизу вверх, 4. крыша рядами (у каждого блока есть сосед)
    const order = ['foundation', 'floor', 'wall', 'roof'];
    todo.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.y - b.y || a.z - b.z || a.x - b.x);
    for (const c of todo) {
      if (timeUp()) { failed.push({ why: 'время вышло' }); break; }
      await put(c);
    }
    api.log(`поставлено: ${JSON.stringify(placed)}`);
    // 5. дверь и окно
    if (!doorDone) {
      try { await api.cmd('place_at', { x: P.door.x, y: P.door.y, z: P.door.z, item: DOOR }); placed[DOOR] = 1; }
      catch (e) { failed.push({ at: [P.door.x, P.door.y, P.door.z], item: DOOR, why: e.message.slice(0, 100) }); }
    }
    if (P.window && glass) {
      try { await api.cmd('place_at', { x: P.window.x, y: P.window.y, z: P.window.z, item: glass }); placed[glass] = 1; }
      catch (e) { api.log('окно: ' + e.message); }
    }

    // 6. проверка survey
    await api.sleep(400);
    g = grid(await api.cmd('survey', svBox));
    let built = 0; const holes = [];
    for (const c of P.cells) {
      if (satisfied(g(c.x, c.y, c.z), c)) built++;
      else if (holes.length < 30) holes.push([c.x, c.y, c.z]);
    }
    const doorOk = /_door$/.test(g(P.door.x, P.door.y, P.door.z));
    const ok = built === P.cells.length && doorOk;
    const res = { ok, built, total: P.cells.length, doorOk, holes, placed, dug, door: P.door, window: P.window, interior: { x: ix, z: iz }, floorY: fy };
    if (failed.length) res.failed = failed.slice(0, 15);
    if (!ok) res.error = `построено ${built}/${P.cells.length}${doorOk ? '' : ', двери нет'}; дыры: ${JSON.stringify(holes.slice(0, 6))}`;
    return res;
  }
};
