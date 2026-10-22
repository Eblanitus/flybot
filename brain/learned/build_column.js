// build_column — колонна size×size от настила моста (from_y) вниз до воды/дна/to_y.
// Строит СНИЗУ ВВЕРХ: бот стоит на основании рядом с колонной (строительные леса — pillar_up
// в соседней клетке), ставит сечение place_at уровень за уровнем. Ничего не копает и не ломает.
// Вода в клетке не мешает (place_at ставит под водой); нижний уровень кладётся на дно/грунт.
// Стоп: лава в колонне, HP<8, кончились блоки, время. Не хватает блоков — ничего не строит.
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|glow_lichen|vine|moss_carpet|hanging_roots|torch|wall_torch|[a-z_]*flower|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|sweet_berry_bush|wheat|carrots|potatoes|beetroots)$/;
const FLUID = /water|lava|bubble_column/;
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 140);
const solid = b => b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b);
const lava = b => /lava/.test(String(b));
const water = b => /water|bubble_column/.test(String(b));

function grid(sv) {
  return (x, y, z) => {
    const rows = sv && sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
function heightOf(sv, x, z) {
  const r = sv && sv.heightmap && sv.heightmap[z - sv.origin.z];
  const v = r ? r[x - sv.origin.x] : null;
  return v === undefined ? null : v;
}
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };

module.exports = {
  name: 'build_column',
  description: 'Колонна size×size от настила моста (from_y) вниз до воды/дна/заданного y: строит снизу вверх place_at, леса — pillar_up в соседней клетке. Ничего не копает. Не хватает блоков — не начинает (missing). dry=1 — смета.',
  params: {
    x: 'центр колонны, x (по умолчанию где стою)',
    z: 'центр колонны, z (по умолчанию где стою)',
    from_y: 'верх колонны (настил моста), по умолчанию 66',
    to_y: 'низ колонны, числом (необязательно; иначе to)',
    to: 'water (по умолчанию) — до воды/дна; ground — до твёрдого дна',
    size: 'сторона сечения 1..3, по умолчанию 2',
    block: 'блок колонны, по умолчанию cobblestone',
    dry: '1 — ничего не ставить, вернуть need/have/missing и план',
    max_sec: 'потолок времени, по умолчанию 600'
  },
  async run(api, params) {
    params = params || {};
    const snap = await api.snapshot();
    const pos = snap.position || {};
    const inv = invMap(snap.inventory);
    const block = String(params.block || 'cobblestone');
    const size = Math.min(Math.max(Math.floor(num(params.size, 2)), 1), 3);
    const fromY = Math.floor(num(params.from_y, 66));
    const toParam = params.to === undefined ? 'water' : String(params.to).toLowerCase();
    const toNum = params.to_y !== undefined && Number.isFinite(Number(params.to_y)) ? Math.floor(Number(params.to_y)) : null;
    const dry = truthy(params.dry);
    const maxSec = Math.min(Math.max(num(params.max_sec, 600), 30), 1800);
    const deadline = Date.now() + maxSec * 1000;

    const cx = Math.floor(num(params.x, pos.x));
    const cz = Math.floor(num(params.z, pos.z));
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return { ok: false, error: 'нужны x и z центра колонны' };
    if (!Number.isFinite(fromY)) return { ok: false, error: 'from_y должен быть числом' };

    const x0 = cx - Math.floor((size - 1) / 2);
    const z0 = cz - Math.floor((size - 1) / 2);
    const cells = [];
    for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) cells.push({ x: x0 + dx, z: z0 + dz });

    const yTop = fromY + 1;
    const yLow = toNum != null ? Math.max(-64, Math.min(toNum - 2, fromY - 2)) : Math.max(-64, fromY - 50);
    // survey: сечение + 1 клетка вокруг (для лесов) и запас вниз
    let sv;
    try {
      sv = await api.cmd('survey', { x1: x0 - 1, y1: yLow, z1: z0 - 1, x2: x0 + size, y2: yTop, z2: z0 + size });
    } catch (e) {
      return { ok: false, error: 'survey у колонны: ' + short(e.message) };
    }
    const g0 = grid(sv);
    const known = new Map();
    const key = (x, y, z) => x + ',' + y + ',' + z;
    const g = (x, y, z) => known.has(key(x, y, z)) ? known.get(key(x, y, z)) : g0(x, y, z);
    const mark = (x, y, z, b) => known.set(key(x, y, z), b);

    // ---- низ колонны B ----
    let B = null, stopTarget = null;
    const inFootprint = (x, z) => x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
    const anyAt = (y, pred, r) => {
      const rr = r || 0;
      for (let x = x0 - rr; x < x0 + size + rr; x++)
        for (let z = z0 - rr; z < z0 + size + rr; z++) if (pred(g0(x, y, z))) return [x, y, z];
      return null;
    };
    const anySolidBelow = yFrom => {
      for (let y = yFrom; y >= yLow; y--) if (anyAt(y, solid)) return y;
      return null;
    };
    if (toNum != null) {
      B = toNum; stopTarget = 'to_y';
    } else if (toParam === 'ground') {
      const sy = anySolidBelow(fromY - 1);
      if (sy == null) return { ok: false, error: `не вижу дно под (${cx},${cz}) до y=${yLow}` };
      B = sy + 1; stopTarget = 'ground';
    } else {
      let wy = null;
      for (let y = yTop - 1; y >= yLow; y--) if (anyAt(y, water, 1)) { wy = y; break; }
      if (wy == null) return { ok: false, error: `не вижу воду под (${cx},${cz}) до y=${yLow}; задай to_y числом` };
      const sy = anySolidBelow(wy - 1);
      B = sy != null ? Math.min(wy, sy + 1) : wy;
      stopTarget = 'water';
    }
    const E = fromY - 1;
    if (!(B <= E)) return { ok: false, error: `низ ${B} не ниже верха ${E} (from_y=${fromY})` };
    // у настила бот головой упирается в from_y: выше from_y-2 ноги не поднять
    const standMax = Math.min(E, fromY - 2);
    if (B > standMax + 1) return { ok: false, error: `низ ${B} слишком высоко: до настила ${fromY} не достать` };

    // ---- смета ----
    let lavaAt = null;
    const emptyCells = [];
    for (let y = B; y <= E; y++) {
      for (const c of cells) {
        const b = g0(c.x, y, c.z);
        if (lava(b)) { lavaAt = [c.x, y, c.z]; break; }
        if (!solid(b)) emptyCells.push({ x: c.x, y, z: c.z });
      }
      if (lavaAt) break;
    }
    if (lavaAt) {
      return { ok: false, error: `лава в колонне ${lavaAt.join(' ')} — строить нельзя`, stop: 'lava', from: [cx, fromY, cz], to: [cx, B, cz] };
    }
    const levels = E - B + 1;
    const standStart = Math.min(B, standMax);
    const rises = Math.max(0, Math.min(standMax, E) - standStart);
    const need = emptyCells.length + rises;
    const have = inv[block] || 0;
    const report = {
      from: [cx, fromY, cz], to: [cx, B, cz], size, block,
      levels, cells: levels * size * size, need, have
    };
    if (have < need) {
      return Object.assign({ ok: false, missing: { [block]: need - have }, error: `не хватает блоков: ${block} ${have}/${need} — колонна не начата` }, report);
    }

    // ---- леса: клетка рядом с колонной ----
    const cand = [];
    for (let i = 0; i < size; i++) {
      cand.push({ x: x0 - 1, z: z0 + i }, { x: x0 + size, z: z0 + i });
      cand.push({ x: x0 + i, z: z0 - 1 }, { x: x0 + i, z: z0 + size });
    }
    const clearPath = c => {
      if (solid(g0(c.x, standStart - 1, c.z))) {
        for (let y = standStart; y <= E; y++) if (solid(g0(c.x, y, c.z))) return false;
        return true;
      }
      return false;
    };
    let scaffold = cand.find(clearPath) || null;
    let standBase = standStart;
    if (!scaffold) {
      // попробовать встать ниже/выше основания в соседней клетке
      for (const baseY of [standStart - 1, standStart + 1]) {
        if (baseY < -64 || baseY > standMax) continue;
        const c = cand.find(q => {
          if (!solid(g0(q.x, baseY - 1, q.z))) return false;
          for (let y = baseY; y <= E; y++) if (solid(g0(q.x, y, q.z))) return false;
          return true;
        });
        if (c) { scaffold = c; standBase = baseY; break; }
      }
    }
    if (!scaffold) return Object.assign({ ok: false, error: `некуда встать у основания колонны (${x0}..${x0 + size - 1}, ${z0}..${z0 + size - 1}) на y=${standStart}: нет твёрдого пола/места рядом` }, report);

    const plan = `колонна ${size}×${size} ${block} от y=${B} до ${E}, встать в ${scaffold.x} ${standBase} ${scaffold.z}, лестница до y=${Math.min(standMax, E)}`;
    if (dry) {
      const missing = {};
      if (have < need) missing[block] = need - have;
      return Object.assign({ ok: true, dry: true, missing, plan, scaffold: [scaffold.x, standBase, scaffold.z], stop: stopTarget }, report);
    }

    // ---- встать на основание ----
    const hpOf = s => {
      if (!s) return 20;
      const v = s.eyes && s.eyes.vitals;
      return Number.isFinite(Number(v && v.hp)) ? Number(v.hp) : num(s.health, 20);
    };
    const gotoStand = async (y, timeout) => {
      try { await api.cmd('goto', { x: scaffold.x, y, z: scaffold.z, timeout }); return true; }
      catch (e) { api.log(`build_column: goto лесов ${scaffold.x} ${y} ${scaffold.z}: ${short(e.message)}`); return false; }
    };
    if (!(await gotoStand(standBase, 120))) {
      // обход: ближайшая видимая площадка рядом, оттуда ещё раз к лесам
      let side = null, best = Infinity;
      for (let x = x0 - 4; x <= x0 + size + 3; x++) for (let z = z0 - 4; z <= z0 + size + 3; z++) {
        if (inFootprint(x, z)) continue;
        const h = heightOf(sv, x, z);
        if (h == null) continue;
        const d = Math.abs(h + 1 - standBase) + Math.hypot(x - scaffold.x, z - scaffold.z) * 0.3;
        if (d < best) { best = d; side = [x, h + 1, z]; }
      }
      if (side) {
        try { await api.cmd('goto', { x: side[0], y: side[1], z: side[2], timeout: 90 }); } catch (e) { api.log('build_column: обход: ' + short(e.message)); }
        await gotoStand(standBase, 60);
      }
      const s1 = await api.snapshot();
      const p1 = s1.position || {};
      if (Math.abs((p1.x || 0) - scaffold.x) > 2.5 || Math.abs((p1.z || 0) - scaffold.z) > 2.5 || Math.abs((p1.y || 0) - standBase) > 2.5) {
        return Object.assign({ ok: false, error: `не встала на основание ${scaffold.x} ${standBase} ${scaffold.z} (сейчас ${Math.round(p1.x)} ${Math.round(p1.y)} ${Math.round(p1.z)})`, plan }, report);
      }
    }

    // ---- стройка снизу вверх ----
    let placed = 0, scaffolds = 0, holes = [];
    const placeCell = async (c, y) => {
      try {
        await api.cmd('place_at', { x: c.x, y, z: c.z, item: block });
        mark(c.x, y, c.z, block); placed++;
        return true;
      } catch (e) {
        const msg = short(e.message);
        try {
          const one = grid(await api.cmd('survey', { x1: c.x, y1: y, z1: c.z, x2: c.x, y2: y, z2: c.z }));
          if (solid(one(c.x, y, c.z))) { mark(c.x, y, c.z, one(c.x, y, c.z)); return true; }
        } catch (e2) { /* ignore */ }
        api.log(`build_column: place_at ${c.x} ${y} ${c.z}: ${msg}`);
        return false;
      }
    };
    const orderFor = y => cells.slice().sort((a, b) => {
      const sn = c => {
        let n = 0;
        for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) if (solid(g(c.x + dx, y + dy, c.z + dz))) n++;
        return n;
      };
      return sn(b) - sn(a);
    });

    const lavaIn = y => {
      for (const c of cells) if (lava(g(c.x, y, c.z))) return [c.x, y, c.z];
      return null;
    };
    const stopAt = (why, stop) => Object.assign({
      ok: false, error: why, placed, scaffolds, holes, plan,
      stop: stop
    }, report);

    for (let y = B; y <= E; y++) {
      if (Date.now() > deadline) return stopAt('время max_sec вышло');
      const s = await api.snapshot();
      if (hpOf(s) < 8) return stopAt(`HP ${hpOf(s)} < 8 — стройка остановлена`);
      const ttdAir = s.danger && s.danger.air && Number(s.danger.air.ttdSec);
      if (Number.isFinite(ttdAir) && ttdAir > 0 && ttdAir <= 8) return stopAt(`мало воздуха под водой (ttd ${Math.round(ttdAir)} с) — стройка остановлена`);
      const lv = lavaIn(y);
      if (lv) return stopAt(`лава в колонне ${lv.join(' ')}`, 'lava');

      // подняться на уровень y (кроме уровней выше standMax — их достаём снизу)
      if (y <= standMax && Math.abs((s.position && s.position.y || 0) - y) > 1) {
        await gotoStand(y, 40);
      }
      const order = orderFor(y);
      const failed = [];
      for (const c of order) {
        const b = g(c.x, y, c.z);
        if (solid(b)) continue;
        if (lava(b)) return stopAt(`лава в колонне ${c.x} ${y} ${c.z}`, 'lava');
        if (!(await placeCell(c, y))) failed.push(c);
      }
      for (const c of failed) {
        if (Date.now() > deadline) break;
        if (!(await placeCell(c, y))) holes.push([c.x, y, c.z]);
      }

      if (y < E && y < standMax) {
        await gotoStand(y, 40);
        const sp = (await api.snapshot()).position || {};
        if (Math.abs((sp.x || 0) - scaffold.x) > 2.5 || Math.abs((sp.z || 0) - scaffold.z) > 2.5) {
          return stopAt(`ушла с лесов перед pillar_up (${Math.round(sp.x)} ${Math.round(sp.y)} ${Math.round(sp.z)}), подниматься неоткуда`);
        }
        let ok = false;
        for (let t = 0; t < 2 && !ok; t++) {
          try { await api.cmd('pillar_up', { height: 1, item: block }); scaffolds++; ok = true; }
          catch (e) { api.log(`build_column: pillar_up с y=${y}: ${short(e.message)}`); await api.sleep(400); }
        }
        if (!ok) {
          // без лесов выше не подняться — добить, что можем с этого места, и выйти
          for (let yy = y + 1; yy <= Math.min(y + 2, E); yy++) {
            for (const c of cells) {
              const b = g(c.x, yy, c.z);
              if (solid(b) || lava(b)) continue;
              if (!(await placeCell(c, yy))) holes.push([c.x, yy, c.z]);
            }
          }
          return stopAt(`pillar_up не смог поднять с y=${y} (нет блоков/тесно)`);
        }
      }
      if ((y - B) % 4 === 0) api.log(`build_column: уровень ${y}/${E}, поставлено ${placed}`);
    }

    // ---- проверка итога ----
    let filled = 0, total = 0;
    try {
      const sv2 = await api.cmd('survey', { x1: x0, y1: B, z1: z0, x2: x0 + size - 1, y2: E, z2: z0 + size - 1 });
      const g2 = grid(sv2);
      for (let y = B; y <= E; y++) for (const c of cells) {
        total++;
        if (solid(g2(c.x, y, c.z)) || solid(g0(c.x, y, c.z)) || known.has(key(c.x, y, c.z))) filled++;
        else holes.push([c.x, y, c.z]);
      }
    } catch (e) {
      api.log('build_column: итоговый survey: ' + short(e.message));
    }
    holes = holes.filter((h, i) => holes.findIndex(q => q[0] === h[0] && q[1] === h[1] && q[2] === h[2]) === i);
    if (holes.length) {
      return Object.assign({
        ok: false, error: `колонна не полная: дыр ${holes.length}`, placed, scaffolds, filled, holes,
        stop: stopTarget, plan
      }, report);
    }
    return Object.assign({
      ok: true, placed, scaffolds, filled, cells: total || levels * size * size, holes: [],
      stop: stopTarget, plan
    }, report);
  }
};
