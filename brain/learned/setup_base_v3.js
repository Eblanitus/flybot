// версия: как v2; в отказе «мало мест» добавлен план
// setup_base — обустроить точку базы: верстак, печь, сундук (если в радиусе 6 их нет) и метка home.
// params: x,y,z — точка базы (y = где стоят ноги); avoid="x1,z1,x2,z2" — не ставить в этом прямоугольнике;
//         dry=1 — только смета; max_d — насколько муха может быть от базы по горизонтали (10), max_dy — по высоте (8).
// Честные отказы (ok:false + причина + числа): муха не у базы; база не видна (много «?»); рядом нет ровных мест.
// Смета (dry=1) проверяет места тем же кодом, что и дело, и тоже врёт ok:false, если мест меньше нужного.
const STATIONS = ['crafting_table', 'furnace', 'chest'];
const COST = { crafting_table: { spruce_planks: 4 }, chest: { spruce_planks: 8 }, furnace: { cobblestone: 8 } };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow|dead_bush|[a-z_]*flower|dandelion|poppy)$/;
const RADII = [4, 6, 8];      // радиусы поиска площадок: сначала 4, если мало — шире (6, потом 8)
const R_EXIST = 6;            // радиус поиска уже стоящих станций
const YSPAN = 3;              // слои вверх/вниз от точки базы
const NEAR_R = 4;             // радиус «вокруг базы», по нему считаем «муха не видит базу»
const SEEN_MIN = 0.5;         // больше половины «?» вокруг базы → база не видна

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
  description: 'Обустроить базу у точки x,y,z: поставить верстак, печь, сундук (если в радиусе 6 их нет), скрафтив недостающее, и mark name=home. dry=1 — только need/have/missing. avoid="x1,z1,x2,z2" — не занимать место хижины. Отказ с причиной, если муха не у базы, база не видна или рядом нет ровных мест.',
  params: {
    x: 'точка базы x', y: 'y ног на точке базы', z: 'точка базы z',
    avoid: 'необязательно: "x1,z1,x2,z2" — прямоугольник, где ничего не ставить',
    dry: '1 — ничего не делать, вернуть need/have/missing (мест мало — тоже ok:false)',
    max_d: 'насколько муха может быть от базы по горизонтали, по умолчанию 10',
    max_dy: 'насколько муха может быть от базы по высоте, по умолчанию 8'
  },
  async run(api, params) {
    const bx = Math.floor(Number(params.x)), by = Math.floor(Number(params.y)), bz = Math.floor(Number(params.z));
    if (![bx, by, bz].every(Number.isFinite)) return { ok: false, error: 'нужны x, y, z точки базы' };
    const dry = isDry(params);
    const maxD = Number(params.max_d) > 0 ? Number(params.max_d) : 10;
    const maxDy = Number(params.max_dy) > 0 ? Number(params.max_dy) : 8;
    let avoid = null;
    if (params.avoid) {
      const a = String(params.avoid).split(/[,\s]+/).map(Number);
      if (a.length === 4 && a.every(Number.isFinite)) avoid = { x1: Math.min(a[0], a[2]), x2: Math.max(a[0], a[2]), z1: Math.min(a[1], a[3]), z2: Math.max(a[1], a[3]) };
    }
    const inAvoid = (x, z) => !!avoid && x >= avoid.x1 && x <= avoid.x2 && z >= avoid.z1 && z <= avoid.z2;

    // --- 1. где муха: дальше базы — честный отказ, а не пустой список мест ---
    const posOf = async () => {
      const s = await api.snapshot(); const p = s.position || {};
      return { x: p.x, y: p.y, z: p.z, at: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] };
    };
    const farCheck = p => {
      const horiz = Math.hypot(p.x - bx, p.z - bz);
      const vert = (p.y || 0) - by;
      if (horiz <= maxD && Math.abs(vert) <= maxDy) return null;
      return {
        ok: false,
        error: `муха не у базы: сейчас ${p.at.join(' ')} (база ${bx} ${by} ${bz}; по горизонтали ${horiz.toFixed(1)} м, по высоте ${vert.toFixed(1)})`,
        at: p.at, base: [bx, by, bz], dist: { horiz: +horiz.toFixed(1), vert: +vert.toFixed(1) }
      };
    };
    let pos = await posOf();
    const far = farCheck(pos);
    if (far) return far;

    // --- 2. снимок окрест базы ---
    const R = RADII[RADII.length - 1];
    const box = { x1: bx - R, y1: by - YSPAN, z1: bz - R, x2: bx + R, y2: by + YSPAN, z2: bz + R };
    const scan = async () => { const sv = await api.cmd('survey', box); return { sv, g: grid(sv) }; };
    let { sv, g } = await scan();
    let edgeSet = new Set((sv.edges || []).map(e => e.x + ',' + e.z));

    const existing = {};
    for (const name of STATIONS) {
      let best = null;
      for (let y = box.y1; y <= box.y2; y++) for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
        if (Math.abs(x - bx) > R_EXIST || Math.abs(z - bz) > R_EXIST) continue;
        if (g(x, y, z) !== name) continue;
        const d = Math.abs(x - bx) + Math.abs(z - bz) + Math.abs(y - by);
        if (!best || d < best.d) best = { d, at: [x, y, z] };
      }
      if (best) existing[name] = best.at;
    }
    const toPlace = STATIONS.filter(n => !existing[n]);

    // --- 3. чего не хватает из материалов ---
    let inv = await invMap(api);
    const need = {}; // сырьё на недостающие станции
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

    // --- 4. площадки: клетка воздух, под ней твёрдое, над ней воздух; не на краю обрыва; не в avoid ---
    const collectSpots = r => {
      const out = [];
      for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
        const dh = Math.abs(x - bx) + Math.abs(z - bz);
        if (dh < 2 || dh > r + 1) continue;
        if (inAvoid(x, z)) continue;
        if (edgeSet.has(x + ',' + z)) continue;
        for (let y = by - 1; y <= by + 1; y++) {
          const here = g(x, y, z), below = g(x, y - 1, z), above = g(x, y + 1, z);
          if (AIRLIKE.test(here) && solid(below) && AIRLIKE.test(above)) { out.push({ x, y, z, d: dh + Math.abs(y - by) * 2 }); break; }
        }
      }
      out.sort((a, b) => a.d - b.d);
      return out;
    };
    const countUnknown = (r, y1, y2) => {
      let unknown = 0, total = 0;
      for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) for (let y = y1; y <= y2; y++) {
        total++; if (g(x, y, z) === '?') unknown++;
      }
      return { unknown, total };
    };
    // кандидаты: где место могло бы быть (низ неизвестен или под ним пусто) — до 5 ближайших
    const candidates = r => {
      const out = [];
      for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
        const dh = Math.abs(x - bx) + Math.abs(z - bz);
        if (dh < 1) continue;
        if (inAvoid(x, z)) continue;
        if (edgeSet.has(x + ',' + z)) continue;
        let pick = null;
        for (let y = by - 1; y <= by + 1; y++) if (AIRLIKE.test(g(x, y, z)) && AIRLIKE.test(g(x, y + 1, z))) { pick = y; break; }
        if (pick === null) continue;
        const below = g(x, pick - 1, pick);
        let why;
        if (below === '?') why = 'низ неизвестен — может быть твёрдый';
        else if (below === 'water') why = 'под водой — можно заложить';
        else if (!solid(below)) why = 'под ним пусто — можно заложить';
        else continue;
        out.push({ at: [x, pick, z], d: dh, why });
      }
      out.sort((a, b) => a.d - b.d);
      return out.slice(0, 5);
    };
    // разбор: мест хватает / база не видна / мест нет
    const analyze = () => {
      let radius = RADII[0], spots = collectSpots(RADII[0]);
      for (let i = 1; i < RADII.length && spots.length < toPlace.length; i++) { radius = RADII[i]; spots = collectSpots(radius); }
      const nearUnk = countUnknown(NEAR_R, by - 1, by + 1);
      const wideUnk = countUnknown(radius, by - 1, by + 1);
      const baseKnown = g(bx, by, bz) !== '?';
      const cantSee = !baseKnown || (nearUnk.total > 0 && nearUnk.unknown / nearUnk.total >= SEEN_MIN);
      const spotsNeed = toPlace.length, spotsFound = spots.length;
      const short = spotsNeed > 0 && spotsFound < spotsNeed;
      const error = short ? (cantSee
        ? `муха не видит базу (${nearUnk.unknown} из ${nearUnk.total} клеток вокруг неизвестно) — встать к базе; ровных мест ${spotsFound}, нужно ${spotsNeed}`
        : `рядом ровных мест нет (нашёл ${spotsFound}, нужно ${spotsNeed}) — сдвинуть точку базы или выровнять площадку`) : null;
      return { radius, spots, spotsFound, spotsNeed, short, error, nearUnk, wideUnk, baseKnown, cantSee, cands: candidates(Math.max(radius, NEAR_R)) };
    };
    let a = analyze();

    const planText = () => toPlace.length
      ? `поставить ${toPlace.join(', ')} у ${bx} ${by} ${bz} (мест найдено ${a.spotsFound}, нужно ${a.spotsNeed}${a.short ? ' — мало' : ''}); метка home`
      : `всё уже стоит; метка home на ${bx} ${by} ${bz}`;
    const plan = planText();
    const common = () => ({
      existing, spotsFound: a.spotsFound, spotsNeed: a.spotsNeed, radius: a.radius,
      need: { ...items, ...need }, have, missing,
      spots: a.spots.slice(0, 6).map(s => [s.x, s.y, s.z]),
      candidates: a.cands, at: pos.at, base: [bx, by, bz],
      unknown: { near: a.nearUnk, wide: a.wideUnk }, hidden: sv.hidden, unloaded: sv.unloaded
    });

    // --- 5. смета: проверка мест тем же кодом, что и в деле, до возврата ---
    if (dry) {
      if (a.short) return { ok: false, dry: true, error: a.error, plan, ...common() };
      return { ok: true, dry: true, plan, ...common() };
    }

    // --- 6. дело: сперва материалы, потом дорога к базе, потом площадки оттуда ---
    if (Object.keys(missing).length) {
      return { ok: false, error: 'не хватает: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', '), plan, ...common() };
    }
    const craftList = toPlace.filter(n => !((inv[n] || 0) >= 1));
    if (craftList.length) {
      const r = await api.skill('gather_list', { items: craftList.map(n => n + ':1').join(','), max_sec: 180 });
      if (!r || r.ok === false) return { ok: false, error: 'не скрафтил: ' + ((r && r.error) || '?'), plan, ...common() };
      inv = await invMap(api);
    }
    try { await api.cmd('goto', { x: bx, y: by, z: bz, timeout: 90 }); } catch (e) { api.log('goto база: ' + e.message); }
    pos = await posOf();
    const far2 = farCheck(pos);
    if (far2) return { ...far2, plan, ...common(), at: pos.at };

    // площадки пересчитываем от базы (снимок сделан оттуда, где муха стоит)
    ({ sv, g } = await scan());
    edgeSet = new Set((sv.edges || []).map(e => e.x + ',' + e.z));
    a = analyze();
    if (a.short) return { ok: false, error: a.error, plan: planText(), ...common() };

    // --- 7. постановка ---
    const placed = {}; const failed = [];
    let si = 0;
    for (const n of toPlace) {
      let done = false;
      while (!done && si < a.spots.length) {
        const s = a.spots[si++];
        try { await api.cmd('place_at', { x: s.x, y: s.y, z: s.z, item: n }); placed[n] = [s.x, s.y, s.z]; done = true; }
        catch (e) { api.log(`place ${n} ${s.x} ${s.y} ${s.z}: ${e.message}`); failed.push({ item: n, at: [s.x, s.y, s.z], why: e.message.slice(0, 160) }); }
      }
      if (!done && !failed.some(f => f.item === n)) failed.push({ item: n, at: null, why: 'свободных мест не осталось' });
    }
    let mark = null;
    try { mark = await api.cmd('mark', { name: 'home', x: bx, y: by, z: bz, note: 'база: верстак/печь/сундук' }); }
    catch (e) { failed.push({ item: 'mark', at: [bx, by, bz], why: e.message.slice(0, 160) }); }

    // --- 8. проверка: видно ли, что встало ---
    await api.sleep(300);
    ({ sv, g } = await scan());
    const verified = {}; const unverified = [];
    for (const [n, cell] of Object.entries({ ...existing, ...placed })) {
      const what = g(cell[0], cell[1], cell[2]);
      if (what === n) { verified[n] = true; continue; }
      if (what === '?') { verified[n] = placed[n] ? true : null; unverified.push({ item: n, at: cell, placed: !!placed[n] }); continue; }
      verified[n] = false;
    }
    const bad = STATIONS.filter(n => verified[n] === false);
    const ok = !bad.length && !!mark;
    const res = { ok, home: [bx, by, bz], placed, existing, verified, spotsFound: a.spotsFound, spotsNeed: a.spotsNeed, radius: a.radius, at: pos.at, base: [bx, by, bz], need: { ...items, ...need }, have, missing, candidates: a.cands };
    if (failed.length) res.failed = failed.slice(0, 8);
    if (unverified.length) res.unverified = unverified;
    if (!ok) {
      const parts = [];
      for (const n of bad) {
        const f = failed.filter(x => x.item === n).pop();
        const cell = placed[n] || existing[n] || [];
        const there = cell.length ? g(cell[0], cell[1], cell[2]) : '?';
        parts.push(`${n} @ ${cell.join(' ')}` + (f ? ` — ${f.why}` : there && there !== '?' ? ` — там ${there}` : ' — не встало'));
      }
      if (!mark) parts.push('метка home');
      res.error = 'не встали: ' + parts.join('; ');
    }
    return res;
  }
};
