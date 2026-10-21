// wall_base — стена по периметру квадрата вокруг точки x,z: высота height, проём-калитка шириной 1.
// params: x,y,z — центр (y = где стоят ноги); r=10 (половина стороны квадрата, 3..20); height=2 (1..4);
//         block=cobblestone; gate=west (west|east|north|south или З|В|С|Ю — проём в середине этой стороны);
//         max_sec=300 (лимит времени); dry=1 — только смета.
// Стена идёт по рельефу: каждая колонка строится от своей поверхности (верх = поверхность + height).
// Край обрыва (survey.edges), перепад рельефа ≥3 у соседа или невидимая клетка — колонка пропускается, в skipped.
// Блоков не хватает — не начинает (missing, подсказка gather_list). Итог проверяет survey.
// Возвращает {ok, placed, already, total, verified, gate, skipped, need, have, plan} или {ok:false, error, ...}.

const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|[a-z_]*flower)$/;
const LIQUID = /water|lava/;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const GATES = { west: 'west', w: 'west', з: 'west', east: 'east', e: 'east', в: 'east', north: 'north', n: 'north', с: 'north', south: 'south', s: 'south', ю: 'south' };

const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// survey кусками (объём ≤ 4096): клетки, высоты поверхности, края обрыва
async function scanArea(api, x1, y1, z1, x2, y2, z2) {
  const cells = new Map(), heights = new Map(), edges = [];
  const width = x2 - x1 + 1, layers = y2 - y1 + 1;
  const dz = Math.max(1, Math.floor(4096 / (width * layers)));
  for (let zs = z1; zs <= z2; zs += dz) {
    const ze = Math.min(z2, zs + dz - 1);
    const sv = await api.cmd('survey', { x1, y1, z1: zs, x2, y2, z2: ze });
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
    for (const e of sv.edges || []) edges.push(e);
  }
  return { cells, heights, edgeSet: new Set(edges.map(e => e.x + ',' + e.z)) };
}

async function invMap(api) {
  const snap = await api.snapshot(); const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return m;
}

// цепочка «ближайший сосед» по x,z — бот идёт вдоль стены, а не прыгает
function chain(items, from) {
  const rest = items.slice(); const out = [];
  let cur = from;
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = Math.abs(rest[i].x - cur.x) + Math.abs(rest[i].z - cur.z); if (d < bd) { bd = d; bi = i; } }
    cur = rest.splice(bi, 1)[0]; out.push(cur);
  }
  return out;
}

module.exports = {
  name: 'wall_base',
  description: 'Стена вокруг базы: периметр квадрата радиуса r от центра x,z, высота height по рельефу, калитка шириной 1 в середине стороны gate (west|east|north|south или З/В/С/Ю). Над обрывом сегмент пропускается. Блоков не хватает — не начинает (missing). dry=1 — смета.',
  params: {
    x: 'центр квадрата x', y: 'y ног в центре', z: 'центр квадрата z',
    r: 'половина стороны квадрата, по умолчанию 10 (3..20)',
    height: 'высота стены над поверхностью, по умолчанию 2 (1..4)',
    block: 'блок стены, по умолчанию cobblestone',
    gate: 'сторона калитки: west|east|north|south (или З|В|С|Ю), по умолчанию west',
    max_sec: 'лимит времени, по умолчанию 300 с',
    dry: '1 — ничего не ставить, вернуть need/have/missing'
  },
  async run(api, params) {
    const cx = Math.floor(Number(params.x)), cy = Math.floor(Number(params.y)), cz = Math.floor(Number(params.z));
    if (![cx, cy, cz].every(Number.isFinite)) return { ok: false, error: 'нужны x, y, z центра' };
    const r = clamp(Math.floor(Number(params.r)) || 10, 3, 20);
    const height = clamp(Math.floor(Number(params.height)) || 2, 1, 4);
    const block = String(params.block || 'cobblestone');
    const side = GATES[String(params.gate || 'west').trim().toLowerCase()];
    if (!side) return { ok: false, error: 'gate: west|east|north|south (или З|В|С|Ю)' };
    const limitMs = clamp(Number(params.max_sec) || 300, 20, 900) * 1000;
    const t0 = Date.now();
    const gx = side === 'west' ? cx - r : side === 'east' ? cx + r : cx;
    const gz = side === 'north' ? cz - r : side === 'south' ? cz + r : cz;

    // 1. скан: периметр + соседние колонки снаружи, по высоте от -4 до height+6
    const box = { x1: cx - r - 1, y1: cy - 4, z1: cz - r - 1, x2: cx + r + 1, y2: cy + height + 6, z2: cz + r + 1 };
    const scan = () => scanArea(api, box.x1, box.y1, box.z1, box.x2, box.y2, box.z2);
    const { cells, heights, edgeSet } = await scan();

    // 2. периметр
    const ring = [];
    for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) {
      if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) === r) ring.push({ x, z });
    }

    // 3. колонки → клетки стены (снизу вверх)
    const cols = []; const skipped = []; let already = 0;
    for (const c of ring) {
      if (c.x === gx && c.z === gz) continue; // калитка
      const key = c.x + ',' + c.z;
      const top = heights.get(key);
      if (top === undefined) { skipped.push({ at: [c.x, c.z], why: 'рельеф не виден' }); continue; }
      if (edgeSet.has(key) || NB.some(([dx, dz]) => edgeSet.has((c.x + dx) + ',' + (c.z + dz)))) { skipped.push({ at: [c.x, c.z], why: 'край обрыва' }); continue; }
      if (NB.some(([dx, dz]) => { const h = heights.get((c.x + dx) + ',' + (c.z + dz)); return h === undefined || top - h >= 3; })) { skipped.push({ at: [c.x, c.z], why: 'перепад рельефа' }); continue; }
      const ground = cells.get(c.x + ',' + top + ',' + c.z);
      if (!ground || ground === '?' || LIQUID.test(ground)) { skipped.push({ at: [c.x, c.z], why: 'опора не твёрдая (' + (ground || '?') + ')' }); continue; }
      const levels = []; let bad = null;
      for (let h = 1; h <= height; h++) {
        const yy = top + h;
        const name = cells.get(c.x + ',' + yy + ',' + c.z);
        if (name === undefined || name === '?') { bad = 'не видно'; break; }
        if (LIQUID.test(name)) { bad = 'вода/лава'; break; }
        if (AIRLIKE.test(name)) levels.push({ x: c.x, y: yy, z: c.z });
        else already++;
      }
      if (bad) { skipped.push({ at: [c.x, c.z], why: bad }); continue; }
      if (levels.length) cols.push({ x: c.x, z: c.z, levels });
    }
    const todo = [];
    for (const col of chain(cols, { x: cx, z: cz })) todo.push(...col.levels);
    const skipCount = skipped.length;
    const plan = `периметр r=${r}, высота ${height}, калитка ${side} у ${gx} ${gz}: ставить ${todo.length} (${block}), уже стоит ${already}, пропуск колонок ${skipCount}`;

    // 4. смета
    const inv = await invMap(api);
    const have = inv[block] || 0;
    const need = todo.length;
    const missing = have < need ? { [block]: need - have } : {};

    if (isDry(params)) {
      return {
        ok: true, dry: true, need: { [block]: need }, have: { [block]: have }, missing, plan,
        gate: { side, at: [gx, gz] }, already, cells: todo.slice(0, 30).map(c => [c.x, c.y, c.z]), skipped: skipped.slice(0, 12)
      };
    }
    if (!need) {
      if (already > 0) return { ok: true, placed: 0, already, total: 0, gate: { side, at: [gx, gz] }, skipped: skipped.slice(0, 12), plan };
      return { ok: false, error: 'нечего строить по периметру', skipped: skipped.slice(0, 12), plan };
    }
    if (Object.keys(missing).length) {
      return { ok: false, error: `не хватает ${block}: ${have}/${need} (gather_list items="${block}:${need}")`, need: { [block]: need }, have: { [block]: have }, missing, plan, skipped: skipped.slice(0, 12) };
    }

    // 5. постановка
    const placed = []; const failed = [];
    for (const b of todo) {
      if (Date.now() - t0 > limitMs) { failed.push({ at: [b.x, b.y, b.z], why: 'время вышло' }); break; }
      try { await api.cmd('place_at', { x: b.x, y: b.y, z: b.z, item: block }); placed.push([b.x, b.y, b.z]); }
      catch (e) {
        failed.push({ at: [b.x, b.y, b.z], why: e.message.slice(0, 100) });
        if (failed.length >= 6 && !placed.length) break;
      }
    }

    // 6. проверка по скану
    await api.sleep(300);
    const after = await scan();
    const verified = placed.filter(([x, y, z]) => after.cells.get(x + ',' + y + ',' + z) === block).length;
    const ok = placed.length === todo.length && verified === placed.length;

    const res = { ok, placed: placed.length, already, total: todo.length, verified, gate: { side, at: [gx, gz] }, need: { [block]: need }, have: { [block]: have }, plan };
    if (skipped.length) res.skipped = skipped.slice(0, 12);
    if (failed.length) res.failed = failed.slice(0, 8);
    if (!ok) {
      if (failed.length) res.error = `поставлено ${placed.length} из ${todo.length}; ошибок ${failed.length}: ${failed[0].why}`;
      else res.error = `проверка: стоит ${verified} из ${placed.length}`;
    }
    return res;
  }
};
