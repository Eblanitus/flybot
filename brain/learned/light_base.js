// light_base — осветить площадку вокруг базы факелами, чтобы не спавнились мобы.
// params: x,y,z — центр базы (y = где стоят ноги); r=24 (радиус, 6..32); step=6 (шаг сетки, 3..16);
//         max=40 (не больше стольких факелов); max_sec=240 (лимит времени); dry=1 — только смета.
// Факелы на полу, сеткой от центра. Пропуск: уже есть свет рядом, нет твёрдой опоры, вода/лава,
// край обрыва или перепад рельефа у соседей. Факелы кончились — крафт torch из угля и палок, если хватает;
// иначе ставит сколько может и возвращает missing.
// Возвращает {ok, placed, already, total, verified, need, have, crafted, missing?, skipped, plan} или {ok:false, error, ...}.

const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|[a-z_]*flower)$/;
const LIQUID = /water|lava/;
const LIGHT = /torch|lantern|glowstone|campfire|shroomlight|candle/;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// survey кусками (объём ≤ 4096): собирает клетки, высоты поверхности, края обрыва
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
  return { cells, heights, edges, edgeSet: new Set(edges.map(e => e.x + ',' + e.z)) };
}

async function invMap(api) {
  const snap = await api.snapshot(); const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return m;
}

// цепочка «ближайший сосед» от точки — бот идёт по площадке, а не прыгает
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

// доски-эквивалент: доски + 4 на каждое бревно (для палок и факелов)
function planksEq(inv) {
  let p = 0, l = 0;
  for (const [k, n] of Object.entries(inv)) {
    if (/_planks$/.test(k)) p += n;
    else if (/_log$/.test(k)) l += n;
  }
  return p + 4 * l;
}

module.exports = {
  name: 'light_base',
  description: 'Осветить площадку вокруг базы факелами сеткой (torch на полу) от центра x,y,z, радиус r, шаг step. Пропускает места со светом рядом, воду, обрывы. Факелы кончились — крафт из угля и палок, если хватает. dry=1 — смета need/have/missing.',
  params: {
    x: 'центр базы x', y: 'y ног на центре базы', z: 'центр базы z',
    r: 'радиус освещения, по умолчанию 24 (6..32)',
    step: 'шаг сетки факелов, по умолчанию 6 (3..16)',
    max: 'не больше стольких факелов за раз, по умолчанию 40',
    max_sec: 'лимит времени, по умолчанию 240 с',
    dry: '1 — ничего не ставить и не крафтить, вернуть need/have/missing'
  },
  async run(api, params) {
    const bx = Math.floor(Number(params.x)), by = Math.floor(Number(params.y)), bz = Math.floor(Number(params.z));
    if (![bx, by, bz].every(Number.isFinite)) return { ok: false, error: 'нужны x, y, z центра базы' };
    const r = clamp(Math.floor(Number(params.r)) || 24, 6, 32);
    const step = clamp(Math.floor(Number(params.step)) || 6, 3, 16);
    const max = clamp(Math.floor(Number(params.max)) || 40, 1, 120);
    const limitMs = clamp(Number(params.max_sec) || 240, 20, 900) * 1000;
    const t0 = Date.now();

    // 1. скан площадки
    const box = { x1: bx - r - 1, y1: by - 4, z1: bz - r - 1, x2: bx + r + 1, y2: by + 5, z2: bz + r + 1 };
    const area = await scanArea(api, box.x1, box.y1, box.z1, box.x2, box.y2, box.z2);
    const { cells, heights, edgeSet } = area;
    const lights = [];
    for (const [k, name] of cells) if (LIGHT.test(name)) { const [x, y, z] = k.split(',').map(Number); lights.push([x, y, z]); }
    const R = Math.max(2, Math.floor(step / 2));
    const nearLight = (x, y, z) => lights.some(([lx, ly, lz]) => Math.abs(ly - y) <= 2 && Math.hypot(lx - x, lz - z) <= R);

    // 2. кандидаты: сетка от центра, в радиусе r
    const K = Math.floor(r / step) + 1;
    const cand = [];
    for (let i = -K; i <= K; i++) for (let j = -K; j <= K; j++) {
      const cx = bx + i * step, cz = bz + j * step;
      const d = Math.hypot(cx - bx, cz - bz);
      if (d <= r) cand.push({ x: cx, z: cz, d });
    }
    cand.sort((a, b) => a.d - b.d);

    // 3. отбор клеток
    const todo = []; const skip = {}; let already = 0;
    const why = k => { skip[k] = (skip[k] || 0) + 1; };
    for (const c of cand) {
      const top = heights.get(c.x + ',' + c.z);
      if (top === undefined) { why('рельеф не виден'); continue; }
      const ground = cells.get(c.x + ',' + top + ',' + c.z);
      if (!ground || ground === '?' || AIRLIKE.test(ground) || LIQUID.test(ground)) { why('нет твёрдой опоры'); continue; }
      const above = cells.get(c.x + ',' + (top + 1) + ',' + c.z);
      if (above === undefined || above === '?') { why('не видно'); continue; }
      if (LIGHT.test(above)) { already++; continue; }
      if (LIQUID.test(above)) { why('вода/лава'); continue; }
      if (!AIRLIKE.test(above)) { why('занято'); continue; }
      if (nearLight(c.x, top + 1, c.z)) { already++; continue; }
      if (edgeSet.has(c.x + ',' + c.z) || NB.some(([dx, dz]) => edgeSet.has((c.x + dx) + ',' + (c.z + dz)))) { why('край обрыва'); continue; }
      if (NB.some(([dx, dz]) => { const h = heights.get((c.x + dx) + ',' + (c.z + dz)); return h === undefined || Math.abs(h - top) > 1; })) { why('перепад рельефа'); continue; }
      todo.push({ x: c.x, y: top + 1, z: c.z });
      lights.push([c.x, top + 1, c.z]);
    }
    const work = todo.slice(0, max);
    if (todo.length > max) skip['сверх max'] = todo.length - max;
    const skipped = Object.entries(skip).map(([k, n]) => `${k}: ${n}`);

    // 4. смета
    const inv = await invMap(api);
    const have = inv.torch || 0;
    const coal = inv.coal || 0;
    const sticks = (inv.stick || 0) + 2 * Math.floor(planksEq(inv) / 2);
    const craftable = 4 * Math.min(coal, sticks);
    const need = work.length;
    const shortage = Math.max(0, need - have);
    const craftNow = Math.min(shortage, craftable);
    const missingN = shortage - craftNow;
    const missing = missingN > 0 ? { torch: missingN } : {};
    const plan = `сетка ${step}, радиус ${r}: ставить факелов ${need}, уже светло ${already}` +
      (skipped.length ? `; пропуск ${skipped.join(', ')}` : '') +
      (need ? `; от ${work[0].x} ${work[0].y} ${work[0].z}` : '');

    if (isDry(params)) {
      return {
        ok: true, dry: true, need: { torch: need }, have: { torch: have, coal, stick: inv.stick || 0 },
        craftable: { torch: craftable }, missing, plan,
        cells: work.slice(0, 30).map(c => [c.x, c.y, c.z]), already, skipped
      };
    }
    if (!need) {
      if (already > 0) return { ok: true, placed: 0, already, total: 0, skipped, plan };
      return { ok: false, error: 'некуда ставить факелы: ' + (skipped.join(', ') || 'нет кандидатов'), skipped, plan };
    }

    // 5. крафт недостающих факелов из угля и палок (только то, что есть в инвентаре)
    let crafted = 0, craftErr = null;
    if (craftNow > 0) {
      try { await api.cmd('craft', { item: 'torch', count: craftNow }); crafted = craftNow; }
      catch (e) { craftErr = e.message.slice(0, 120); api.log('craft torch: ' + craftErr); }
    }
    const avail = (await invMap(api)).torch || 0;

    // 6. постановка (ближайшие первыми, по цепочке)
    const place = chain(work, { x: bx, z: bz }).slice(0, avail);
    const placed = []; const failed = [];
    for (const c of place) {
      if (Date.now() - t0 > limitMs) { failed.push({ at: [c.x, c.y, c.z], why: 'время вышло' }); break; }
      try { await api.cmd('place_at', { x: c.x, y: c.y, z: c.z, item: 'torch' }); placed.push([c.x, c.y, c.z]); }
      catch (e) {
        failed.push({ at: [c.x, c.y, c.z], why: e.message.slice(0, 100) });
        if (failed.length >= 6 && !placed.length) break;
      }
    }

    // 7. проверка по скану
    await api.sleep(300);
    const after = await scanArea(api, box.x1, box.y1, box.z1, box.x2, box.y2, box.z2);
    const verified = placed.filter(([x, y, z]) => /torch/.test(after.cells.get(x + ',' + y + ',' + z) || '')).length;
    const ok = placed.length === work.length && verified === placed.length;

    const res = { ok, placed: placed.length, verified, already, total: work.length, need: { torch: need }, have: { torch: have }, crafted, plan };
    if (skipped.length) res.skipped = skipped;
    if (missingN > 0) res.missing = { torch: missingN };
    if (failed.length) res.failed = failed.slice(0, 8);
    if (!ok) {
      if (missingN > 0) res.error = `не хватает факелов: не хватило ${missingN}` + (craftErr ? ` (крафт: ${craftErr})` : '') + `; поставлено ${placed.length} из ${work.length}`;
      else if (failed.length) res.error = `поставлено ${placed.length} из ${work.length}; ошибок ${failed.length}: ${failed[0].why}`;
      else res.error = `проверка: стоит ${verified} из ${placed.length}`;
    }
    return res;
  }
};
