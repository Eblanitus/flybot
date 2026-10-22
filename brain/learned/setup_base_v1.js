// версия: первая: верстак, печь, сундук у точки базы + mark home; dry=1
// setup_base — обустроить точку базы: верстак, печь, сундук (если в радиусе 6 их нет) и метка home.
// params: x,y,z — точка базы (y = где стоят ноги); avoid="x1,z1,x2,z2" — не ставить в этом прямоугольнике (место хижины);
//         dry=1 — только посчитать. Недостающее крафтит через gather_list (доски партиями).
// Возвращает {ok, home, placed:{имя:[x,y,z]}, existing:{имя:[x,y,z]}}.
const STATIONS = ['crafting_table', 'furnace', 'chest'];
const COST = { crafting_table: { spruce_planks: 4 }, chest: { spruce_planks: 8 }, furnace: { cobblestone: 8 } };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow|dead_bush|[a-z_]*flower|dandelion|poppy)$/;

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
  return m;
}
const solid = b => b && b !== '?' && !AIRLIKE.test(b) && !/water|lava|torch|fence|door|sign|_slab|carpet|rail/.test(b);

module.exports = {
  name: 'setup_base',
  description: 'Обустроить базу у точки x,y,z: поставить верстак, печь, сундук (если в радиусе 6 их нет), скрафтив недостающее, и mark name=home. dry=1 — только need/have/missing. avoid="x1,z1,x2,z2" — не занимать место хижины.',
  params: {
    x: 'точка базы x', y: 'y ног на точке базы', z: 'точка базы z',
    avoid: 'необязательно: "x1,z1,x2,z2" — прямоугольник, где ничего не ставить',
    dry: '1 — ничего не делать, вернуть need/have/missing'
  },
  async run(api, params) {
    const bx = Math.floor(Number(params.x)), by = Math.floor(Number(params.y)), bz = Math.floor(Number(params.z));
    if (![bx, by, bz].every(Number.isFinite)) return { ok: false, error: 'нужны x, y, z точки базы' };
    let avoid = null;
    if (params.avoid) {
      const a = String(params.avoid).split(/[,\s]+/).map(Number);
      if (a.length === 4 && a.every(Number.isFinite)) avoid = { x1: Math.min(a[0], a[2]), x2: Math.max(a[0], a[2]), z1: Math.min(a[1], a[3]), z2: Math.max(a[1], a[3]) };
    }
    const R = 6;
    const box = { x1: bx - R, y1: by - 3, z1: bz - R, x2: bx + R, y2: by + 3, z2: bz + R };
    const scan = async () => { const sv = await api.cmd('survey', box); return { sv, g: grid(sv) }; };
    let { sv, g } = await scan();

    const existing = {};
    const findAll = () => {
      for (const name of STATIONS) {
        let best = null;
        for (let y = box.y1; y <= box.y2; y++) for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
          if (g(x, y, z) !== name) continue;
          const d = Math.abs(x - bx) + Math.abs(z - bz) + Math.abs(y - by);
          if (!best || d < best.d) best = { d, at: [x, y, z] };
        }
        if (best) existing[name] = best.at;
      }
    };
    findAll();
    const toPlace = STATIONS.filter(n => !existing[n]);

    let inv = await invMap(api);
    const need = {}; // сколько сырья на недостающие станции, если их нет в инвентаре
    const items = {};
    for (const n of toPlace) {
      items[n] = 1;
      if ((inv[n] || 0) >= 1) continue;
      for (const [k, c] of Object.entries(COST[n])) need[k] = (need[k] || 0) + c;
    }
    const have = {}; const missing = {};
    for (const [k, c] of Object.entries(need)) {
      let h = inv[k] || 0;
      if (k === 'spruce_planks') h += 4 * (inv.spruce_log || 0); // брёвна пойдут на доски
      have[k] = h;
      if (h < c) missing[k] = c - h;
    }
    for (const n of toPlace) if ((inv[n] || 0) >= 1) have[n] = inv[n];

    // места: клетка воздух, под ней твёрдое, над ней воздух; 2..4 от точки; не на краю обрыва; не в avoid
    const edgeSet = new Set((sv.edges || []).map(e => e.x + ',' + e.z));
    const spots = [];
    for (let z = bz - 4; z <= bz + 4; z++) for (let x = bx - 4; x <= bx + 4; x++) {
      const dh = Math.abs(x - bx) + Math.abs(z - bz);
      if (dh < 2 || dh > 5) continue;
      if (avoid && x >= avoid.x1 && x <= avoid.x2 && z >= avoid.z1 && z <= avoid.z2) continue;
      if (edgeSet.has(x + ',' + z)) continue;
      for (let y = by - 1; y <= by + 1; y++) {
        const here = g(x, y, z), below = g(x, y - 1, z), above = g(x, y + 1, z);
        if (AIRLIKE.test(here) && solid(below) && AIRLIKE.test(above)) { spots.push({ x, y, z, d: dh + Math.abs(y - by) * 2 }); break; }
      }
    }
    spots.sort((a, b) => a.d - b.d);
    const plan = toPlace.length
      ? `поставить ${toPlace.join(', ')} у ${bx} ${by} ${bz} (мест найдено ${spots.length}); метка home`
      : `всё уже стоит; метка home на ${bx} ${by} ${bz}`;

    if (isDry(params)) {
      return { ok: true, dry: true, need: { ...items, ...need }, have, missing, existing, plan, spots: spots.slice(0, 6).map(s => [s.x, s.y, s.z]) };
    }
    if (Object.keys(missing).length) {
      return { ok: false, error: 'не хватает: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', '), need, have, missing, existing };
    }
    if (toPlace.length && spots.length < toPlace.length) {
      return { ok: false, error: `мало ровных мест у базы: нашёл ${spots.length}, нужно ${toPlace.length}`, existing };
    }

    // крафт недостающего
    const craftList = toPlace.filter(n => !((inv[n] || 0) >= 1));
    if (craftList.length) {
      const r = await api.skill('gather_list', { items: craftList.map(n => n + ':1').join(','), max_sec: 180 });
      if (!r || r.ok === false) return { ok: false, error: 'не скрафтил: ' + ((r && r.error) || '?'), existing };
      inv = await invMap(api);
    }

    try { await api.cmd('goto', { x: bx, y: by, z: bz, timeout: 60 }); } catch (e) { api.log('goto база: ' + e.message); }
    const placed = {}; const failed = [];
    let si = 0;
    for (const n of toPlace) {
      let done = false;
      while (!done && si < spots.length) {
        const s = spots[si++];
        try { await api.cmd('place_at', { x: s.x, y: s.y, z: s.z, item: n }); placed[n] = [s.x, s.y, s.z]; done = true; }
        catch (e) { api.log(`place ${n} ${s.x} ${s.y} ${s.z}: ${e.message}`); failed.push({ item: n, at: [s.x, s.y, s.z], why: e.message.slice(0, 120) }); }
      }
    }
    let mark = null;
    try { mark = await api.cmd('mark', { name: 'home', x: bx, y: by, z: bz, note: 'база: верстак/печь/сундук' }); }
    catch (e) { failed.push({ item: 'mark', why: e.message.slice(0, 120) }); }

    // проверка
    await api.sleep(300);
    ({ sv, g } = await scan());
    const verified = {};
    for (const [n, at] of Object.entries({ ...existing, ...placed })) verified[n] = g(at[0], at[1], at[2]) === n;
    const ok = STATIONS.every(n => verified[n]) && !!mark;
    const res = { ok, home: [bx, by, bz], placed, existing, verified };
    if (failed.length) res.failed = failed.slice(0, 8);
    if (!ok) res.error = 'не всё стоит: ' + STATIONS.filter(n => !verified[n]).join(', ') + (mark ? '' : ' (метка не поставлена)');
    return res;
  }
};
