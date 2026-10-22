// версия: была текущей на 22.10; против v1: кровать ищет по survey/eyes (/_bed$/), шерсть крафтит из ниток с проверкой досок, дорога по route с обходом при таймауте
// bring_bed_home — добыть кровать (сломать в известной точке/деревне, остричь овец, скрафтить из ниток
// или шерсти), принести к базе и поставить на твёрдый блок рядом с сундуком.
// Кровати в реестре называются <цвет>_bed, блока "bed" нет — ищем только через survey/eyes по /_bed$/.
// Дорога перебежками по маршруту (route), при таймауте — обход, потом следующая точка; ночью — укрытие.
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|vine|glow_lichen|moss_carpet|[a-z_]*flower|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony)$/;
const BED_RE = /_bed$/;
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const solid = b => b && b !== '?' && !AIRLIKE.test(b) && !/water|lava/.test(b);
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}

function parsePoints(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map(a => String(a).split(/[,\s]+/).map(Number))
      .filter(a => a.length >= 3 && a.slice(0, 3).every(Number.isFinite))
      .map(a => a.slice(0, 3));
  }
  const nums = (String(v).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 2 < nums.length; i += 3) out.push([nums[i], nums[i + 1], nums[i + 2]]);
  return out;
}

async function bedInInv(api) {
  const snap = await api.snapshot();
  const m = invMap(snap.inventory);
  return Object.keys(m).find(n => BED_RE.test(n) && m[n] > 0) || null;
}

async function surveyBox(api, cx, cy, cz, r, dy) {
  return await api.cmd('survey', {
    x1: Math.round(cx - r), y1: Math.round(cy - dy), z1: Math.round(cz - r),
    x2: Math.round(cx + r), y2: Math.round(cy + dy), z2: Math.round(cz + r)
  });
}

function firstBed(sv, cx, cy, cz, r, dy) {
  if (!sv || !sv.layers) return null;
  const g = grid(sv);
  let best = null;
  for (let y = Math.round(cy - dy); y <= Math.round(cy + dy); y++)
    for (let z = Math.round(cz - r); z <= Math.round(cz + r); z++)
      for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
        const b = g(x, y, z);
        if (typeof b !== 'string' || !BED_RE.test(b)) continue;
        const d = dist2(x, z, cx, cz) + Math.abs(y - cy) * 0.5;
        if (!best || d < best.d) best = { at: [x, y, z], d, block: b };
      }
  return best;
}

async function searchBedAround(api, center, deadline) {
  const snap = await api.snapshot();
  const p = snap.position || {};
  const cx = center && center[0] != null ? center[0] : Math.round(p.x);
  const cy = center && center[1] != null ? center[1] : Math.round(p.y);
  const cz = center && center[2] != null ? center[2] : Math.round(p.z);
  for (const [r, dy] of [[6, 3], [10, 4]]) {
    try {
      const sv = await surveyBox(api, cx, cy, cz, r, dy);
      const b = firstBed(sv, cx, cy, cz, r, dy);
      if (b) return b.at;
    } catch (e) { api.log('survey кровати: ' + short(e.message)); }
  }
  const snap2 = await api.snapshot();
  const e = snap2.eyes && snap2.eyes.blocks && snap2.eyes.blocks.bed;
  return e && e.at ? e.at : null;
}

const PATROL = [[6, 0], [-6, 0], [0, 6], [0, -6], [9, 9], [-9, 9], [9, -9], [-9, -9]];

async function searchBedPatrol(api, center, deadline, budgetMs) {
  const at = await searchBedAround(api, center, deadline);
  if (at) return at;
  const t0 = Date.now();
  for (const [dx, dz] of PATROL) {
    if (Date.now() - t0 > budgetMs || Date.now() > deadline) break;
    const x = center[0] + dx, z = center[2] + dz;
    try { await api.cmd('goto', { x, z, timeout: 40 }); }
    catch (e) { api.log(`обход ${x} ${z}: ${short(e.message)}`); continue; }
    const b = await searchBedAround(api, [x, center[1], z], deadline);
    if (b) return b;
  }
  return null;
}

async function takeBed(api, at, deadline) {
  const already = await bedInInv(api);
  if (already) return already;
  for (let i = 0; i < 3 && Date.now() < deadline; i++) {
    try { await api.cmd('dig_at', { x: at[0], y: at[1], z: at[2] }); }
    catch (e) { api.log(`dig_at кровати ${at.join(' ')}: ${short(e.message)}`); }
    try { await api.cmd('pickup', { radius: 6, max_sec: 12 }); } catch (e) { api.log('pickup: ' + short(e.message)); }
    const got = await bedInInv(api);
    if (got) return got;
    await api.sleep(400);
  }
  return await bedInInv(api);
}

async function travel(api, tx, ty, tz, deadline, tag, opts) {
  opts = opts || {};
  const step = Number(opts.step) > 0 ? Number(opts.step) : 22;
  const route = (Array.isArray(opts.route) ? opts.route : []).filter(r => r && r.length >= 3);
  const legs = route.map(r => [r[0], r[1], r[2]]);
  legs.push([tx, ty == null ? null : ty, tz]);
  const errors = [];
  let hops = 0, escapes = 0, nights = 0, sheltered = false;

  for (let li = 0; li < legs.length; li++) {
    const lx = legs[li][0], ly = legs[li][1], lz = legs[li][2];
    const isLast = li === legs.length - 1;
    const legTag = isLast ? tag : `${tag} → ${lx},${lz}`;
    const legT0 = Date.now();
    const left = Math.max(1, legs.length - li);
    const legBudget = Math.max(45000, Math.min(150000, Math.floor((deadline - Date.now()) / left)));
    let legFails = 0, done = false;

    for (let i = 0; i < 300 && Date.now() < deadline; i++) {
      if (Date.now() - legT0 > legBudget) {
        errors.push(`${legTag}: участок не пройден за ${Math.round(legBudget / 1000)} с`);
        break;
      }
      const snap = await api.snapshot();
      const p = snap.position || {};
      const eyes = snap.eyes || {};
      const vit = eyes.vitals || {};
      const time = eyes.time || {};
      const dist = dist2(p.x, p.z, lx, lz);
      if (dist <= 2.8 && (ly == null || Math.abs(ly - p.y) <= 3)) { done = true; break; }

      if ((vit.hp == null ? 20 : vit.hp) < 8) {
        if (++escapes > 5) return { arrived: false, at: [p.x, p.y, p.z], dist: dist2(p.x, p.z, tx, tz), hops, errors: errors.concat(`HP ${vit.hp}, escape не помог`) };
        api.log(`${legTag}: HP ${vit.hp} — escape`);
        try { await api.cmd('escape', { distance: 16, shelter: true }); } catch (e) { api.log('escape: ' + short(e.message)); }
        continue;
      }
      const th = (eyes.threats || []).filter(t => t.d != null && t.d <= 24)[0];
      const mobs = (eyes.enemies || []).filter(e => e.d != null && e.d <= 8);
      if (th || mobs.length) {
        if (++escapes > 5) return { arrived: false, at: [p.x, p.y, p.z], dist: dist2(p.x, p.z, tx, tz), hops, errors: errors.concat(`враги не отстают (${(th && th.name) || mobs[0].name})`) };
        api.log(`${legTag}: ${th ? 'враг-игрок ' + th.name : 'враг ' + mobs[0].name} рядом — escape`);
        try { await api.cmd('escape', {}); } catch (e) { api.log('escape: ' + short(e.message)); }
        continue;
      }

      if (time.phase === 'ночь') {
        if (++nights > 6) return { arrived: false, at: [p.x, p.y, p.z], dist: dist2(p.x, p.z, tx, tz), hops, errors: errors.concat('ночь не кончается (6 пережиданий)') };
        const carrying = await bedInInv(api);
        api.log(`${legTag}: ночь — пережидаю${carrying ? ', кровать не трачу' : ''}`);
        if (carrying) {
          if (!sheltered) {
            try { await api.cmd('shelter', {}); } catch (e) { api.log('shelter: ' + short(e.message)); }
            sheltered = true;
          }
          const t0 = Date.now();
          while (Date.now() - t0 < 240000 && Date.now() < deadline) {
            await api.sleep(8000);
            const s2 = await api.snapshot();
            const t2 = (s2.eyes && s2.eyes.time) || {};
            const v2 = (s2.eyes && s2.eyes.vitals) || {};
            if (t2.phase !== 'ночь') { sheltered = false; break; }
            if (v2.hp != null && v2.hp < 8) { try { await api.cmd('escape', {}); } catch (e) { api.log('escape: ' + short(e.message)); } }
          }
        } else {
          const sec = Math.max(60, Math.min(720, Math.floor((deadline - Date.now()) / 1000)));
          try { await api.cmd('wait_night', { max_sec: sec }); } catch (e) { api.log('wait_night: ' + short(e.message)); }
        }
        continue;
      }

      let hx, hz, hy = null;
      if (legFails >= 2) {
        const dx = lx - p.x, dz = lz - p.z;
        const d = Math.hypot(dx, dz) || 1;
        const ux = dx / d, uz = dz / d;
        const side = legFails % 2 === 0 ? 1 : -1;
        const lateral = 10 + 4 * (legFails % 3);
        const forward = Math.max(4, Math.min(12, d * 0.4));
        hx = Math.round(p.x + ux * forward - uz * lateral * side);
        hz = Math.round(p.z + uz * forward + ux * lateral * side);
        api.log(`${legTag}: обход через ${hx} ${hz}`);
      } else {
        const k = dist > step ? step / dist : 1;
        hx = Math.round(p.x + (lx - p.x) * k);
        hz = Math.round(p.z + (lz - p.z) * k);
        if (k === 1 && ly != null) hy = ly;
      }

      try {
        await api.cmd('goto', hy == null ? { x: hx, z: hz, timeout: 60 } : { x: hx, y: hy, z: hz, timeout: 60 });
        hops++; legFails = 0;
      } catch (e) {
        const msg = short(e.message);
        if (/занят|выполняется|повтори/.test(msg)) { await api.sleep(1200); continue; }
        legFails++;
        api.log(`${legTag}: goto ${hx} ${hz}: ${msg}`);
        if (legFails >= 4) { errors.push(`${legTag}: не прошла (${msg})`); break; }
        await api.sleep(600);
      }
    }

    if (done && isLast) break;
    if (!done && isLast) break;
  }

  const snap = await api.snapshot();
  const p = snap.position || {};
  const finalDist = dist2(p.x, p.z, tx, tz);
  const arrived = finalDist <= 3.2 && (ty == null || Math.abs(ty - p.y) <= 3);
  return { arrived, at: [p.x, p.y, p.z], dist: finalDist, hops, errors, near: finalDist <= 10 };
}

async function ensurePlanks(api, need) {
  let have = await api.count(/planks$/);
  if (have >= need) return have;
  const snap = await api.snapshot();
  const inv = invMap(snap.inventory);
  const logName = Object.keys(inv).find(n => /_(log|stem)$/.test(n) && inv[n] > 0);
  if (!logName) return have;
  const wood = logName.replace(/_(log|stem)$/, '');
  try { await api.cmd('craft', { item: `${wood}_planks`, count: Math.max(1, need - have) }); }
  catch (e) { api.log('craft planks: ' + short(e.message)); }
  return await api.count(/planks$/);
}

async function bedFromMaterials(api, deadline) {
  const have = await bedInInv(api);
  if (have) return { bed: have, way: 'wool' };
  const strings = await api.count('string');
  const wool = await api.count(/_wool$/);
  if (!wool && strings < 12) return { error: `нет шерсти и мало ниток (string ${strings}/12)` };

  const planks = await ensurePlanks(api, 3);
  if (planks < 3) return { error: `не хватает досок: есть ${planks}/3` };

  if (strings >= 12) {
    const snap = await api.snapshot();
    const inv = invMap(snap.inventory);
    const hasWool = Object.keys(inv).some(n => /_wool$/.test(n) && inv[n] >= 3);
    if (!hasWool) {
      try { await api.cmd('craft', { item: 'white_wool', count: 3 }); }
      catch (e) { return { error: 'шерсть из ниток: ' + short(e.message) }; }
    }
  }

  const snap2 = await api.snapshot();
  const inv2 = invMap(snap2.inventory);
  const colors = Object.keys(inv2).filter(n => /_wool$/.test(n) && inv2[n] >= 3);
  if (!colors.length) return { error: 'нет 3 шерсти одного цвета' };
  const errs = [];
  for (const w of colors) {
    if (Date.now() > deadline) break;
    const it = w.replace(/_wool$/, '_bed');
    try { await api.cmd('craft', { item: it }); }
    catch (e) { errs.push(`${it}: ${short(e.message)}`); continue; }
    const b = await bedInInv(api);
    if (b) return { bed: b, way: 'wool' };
  }
  return { error: 'кровать из шерсти не скрафтилась' + (errs.length ? ': ' + errs.join(' | ') : '') };
}

async function acquireWool(api, deadline, maxMs) {
  const until = Math.min(deadline, Date.now() + (Number(maxMs) > 0 ? Number(maxMs) : 180000));
  const errors = [];

  const planks = await ensurePlanks(api, 3);
  if (planks < 3) errors.push(`досок ${planks}/3`);

  let strings = await api.count('string');
  for (let i = 0; i < 3 && strings < 12 && Date.now() < until; i++) {
    const snap = await api.snapshot();
    const sp = ((snap.eyes && snap.eyes.enemies) || []).find(e => /spider/.test(e.name) && e.d != null && e.d <= 12);
    if (!sp) break;
    api.log(`bring_bed_home: паук ${sp.d} м — добываю нитки (${strings}/12)`);
    try { await api.cmd('fight', { target: 'spider', radius: 16, flee_hp: 8 }); }
    catch (e) { errors.push('паук: ' + short(e.message)); break; }
    try { await api.cmd('pickup', { radius: 6, max_sec: 8 }); } catch (e) { api.log('pickup: ' + short(e.message)); }
    strings = await api.count('string');
  }

  if (strings >= 12 && Date.now() < until) {
    const r = await bedFromMaterials(api, until);
    if (r.bed) return r;
    if (r.error) errors.push(r.error);
  }

  if (Date.now() >= until) return { error: errors.join(' | ') || 'время на шерсть вышло' };

  const sec = Math.max(45, Math.min(240, Math.floor((until - Date.now()) / 1000)));
  try {
    const r = await api.skill('make_bed', { max_sec: sec });
    if (r && r.ok) {
      const b = await bedInInv(api);
      if (b) return { bed: b, way: 'wool' };
      errors.push('make_bed: ok, но кровати в инвентаре нет');
    } else if (r && r.error) errors.push('make_bed: ' + r.error);
  } catch (e) { errors.push('make_bed: ' + short(e.message)); }

  return { error: errors.join(' | ') || 'шерсть/кровать не добыты' };
}

async function placeBed(api, item, base, deadline) {
  const [bx, by, bz] = base;
  let sv;
  try { sv = await api.cmd('survey', { x1: bx - 7, y1: by - 2, z1: bz - 7, x2: bx + 7, y2: by + 2, z2: bz + 7 }); }
  catch (e) { return { ok: false, error: 'survey у базы: ' + short(e.message) }; }
  const g = grid(sv);

  let chest = null;
  for (let y = by - 2; y <= by + 2; y++) for (let z = bz - 7; z <= bz + 7; z++) for (let x = bx - 7; x <= bx + 7; x++) {
    if (!/^(chest|trapped_chest|barrel)$/.test(g(x, y, z))) continue;
    const d = Math.abs(x - bx) + Math.abs(y - by) + Math.abs(z - bz);
    if (!chest || d < chest.d) chest = { d, at: [x, y, z] };
  }

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const spots = [];
  for (let z = bz - 6; z <= bz + 6; z++) for (let x = bx - 6; x <= bx + 6; x++) {
    const dh = Math.abs(x - bx) + Math.abs(z - bz);
    if (dh < 1) continue;
    for (let y = by - 1; y <= by + 1; y++) {
      if (!AIRLIKE.test(g(x, y, z)) || !AIRLIKE.test(g(x, y + 1, z))) continue;
      if (!solid(g(x, y - 1, z))) continue;
      let okDir = false;
      for (const [dx, dz] of dirs) {
        const nh = g(x + dx, y, z + dz), na = g(x + dx, y + 1, z + dz), nb = g(x + dx, y - 1, z + dz);
        if (AIRLIKE.test(nh) && AIRLIKE.test(na) && solid(nb)) { okDir = true; break; }
      }
      if (!okDir) continue;
      const d = chest ? Math.abs(x - chest.at[0]) + Math.abs(z - chest.at[2]) + Math.abs(y - chest.at[1]) : dh;
      spots.push({ x, y, z, d });
      break;
    }
  }
  spots.sort((a, b) => a.d - b.d);
  if (!spots.length) return { ok: false, error: `нет ровного места под кровать у базы ${bx} ${by} ${bz} (survey hidden ${sv.hidden == null ? '?' : sv.hidden})` };

  const failed = [];
  for (const s of spots.slice(0, 10)) {
    if (Date.now() > deadline) break;
    try { await api.cmd('place_at', { x: s.x, y: s.y, z: s.z, item }); }
    catch (e) { failed.push(short(e.message)); api.log(`place_at bed ${s.x} ${s.y} ${s.z}: ${short(e.message)}`); continue; }
    await api.sleep(300);
    const at = await searchBedAround(api, [s.x, s.y, s.z], deadline);
    if (at && Math.abs(at[0] - s.x) <= 2 && Math.abs(at[2] - s.z) <= 2) return { ok: true, at };
    failed.push(`${s.x},${s.y},${s.z}: не видно кровати после place_at`);
  }
  return { ok: false, error: 'не удалось поставить кровать: ' + failed.slice(0, 3).join(' | ') };
}

module.exports = {
  name: 'bring_bed_home',
  description: 'Добыть кровать (сломать кровать в points/деревне, скрафтить из ниток/шерсти, остричь овец), принести к базе x,y,z и поставить рядом с сундуком. Дорога перебежками по route, обход таймаутов, ночью укрытие/ожидание. Возвращает bed, at, way.',
  params: {
    x: 'куда нести кровать, x (по умолчанию -393)', y: 'y ног на базе (по умолчанию 67)', z: 'z (по умолчанию 36)',
    points: 'известные точки с кроватью: "-378,54,28;-558,71,41" (через ; или подряд x,y,z)',
    route: 'необязательно: промежуточные точки маршрута "-378,54,28;-350,50,37" (применяются для дальних целей, назад — в обратном порядке)',
    village_x: 'если точек нет/не вышло — где искать кровать/овец, x',
    village_z: 'то же, z', village_y: 'y деревни (необязательно)',
    prefer: 'bed (по умолчанию) — ломать кровать; wool — только шерсть, кровати не трогать',
    place: '1 (по умолчанию) — поставить кровать у базы; 0 — только принести',
    max_sec: 'потолок по времени, по умолчанию 900'
  },
  async run(api, params) {
    params = params || {};
    const base = [
      Math.floor(Number.isFinite(Number(params.x)) ? Number(params.x) : -393),
      Math.floor(Number.isFinite(Number(params.y)) ? Number(params.y) : 67),
      Math.floor(Number.isFinite(Number(params.z)) ? Number(params.z) : 36)
    ];
    const preferWool = String(params.prefer || 'bed').toLowerCase() === 'wool';
    const doPlace = params.place === undefined ? true : truthy(params.place);
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 900;
    const deadline = Date.now() + maxSec * 1000;

    const points = parsePoints(params.points);
    const route = parsePoints(params.route);
    const vx = Number(params.village_x), vz = Number(params.village_z);
    const vy = Number.isFinite(Number(params.village_y)) ? Number(params.village_y) : null;
    const village = Number.isFinite(vx) && Number.isFinite(vz) ? [vx, vy, vz] : null;

    const snapStart = await api.snapshot();
    const start = snapStart.position || {};
    const routeFor = target => (route.length && dist2(start.x, start.z, target[0], target[2]) > 60 ? route : []);

    let bedItem = await bedInInv(api);
    let way = bedItem ? 'inventory' : null;
    const tried = [];

    if (!bedItem) {
      const m = await bedFromMaterials(api, deadline);
      if (m.bed) { bedItem = m.bed; way = 'wool'; }
      else if (m.error) tried.push('свои запасы: ' + m.error);
    }

    if (!bedItem && !preferWool) {
      for (const pt of points) {
        if (Date.now() >= deadline) break;
        api.log(`bring_bed_home: ищу кровать в ${pt.join(' ')}`);
        const tr = await travel(api, pt[0], pt[1], pt[2], deadline, 'к точке', { route: routeFor(pt) });
        if (!tr.arrived && !tr.near) {
          tried.push(`точка ${pt.join(' ')}: ${(tr.errors || []).slice(-1)[0] || 'не дошла'}`);
          continue;
        }
        const at = await searchBedPatrol(api, tr.at || pt, deadline, 60000);
        if (!at) { tried.push(`точка ${pt.join(' ')}: кровати нет`); continue; }
        const got = await takeBed(api, at, deadline);
        if (got) { bedItem = got; way = 'point_bed'; break; }
        tried.push(`точка ${pt.join(' ')}: кровать ${at.join(' ')} не подобралась`);
      }
    }

    if (!bedItem && !preferWool) {
      const maxWool = Math.min(240000, Math.max(60000, Math.floor((deadline - Date.now()) * 0.45)));
      const w = await acquireWool(api, deadline, maxWool);
      if (w.bed) { bedItem = w.bed; way = 'wool'; }
      else if (w.error) tried.push('шерсть: ' + w.error);
    }

    if (!bedItem && preferWool && Date.now() < deadline) {
      const w = await acquireWool(api, deadline, Math.floor((deadline - Date.now()) * 0.6));
      if (w.bed) { bedItem = w.bed; way = 'wool'; }
      else if (w.error) tried.push('шерсть: ' + w.error);
    }

    if (!bedItem && village && !preferWool) {
      api.log(`bring_bed_home: иду в деревню ${village[0]} ${village[2]}`);
      const tr = await travel(api, village[0], village[1], village[2], deadline, 'в деревню', { route: routeFor(village) });
      if (!tr.arrived && !tr.near) tried.push(`деревня ${village[0]},${village[2]}: ${(tr.errors || []).slice(-1)[0] || 'не дошла'}`);
      else {
        const at = await searchBedPatrol(api, tr.at || [village[0], village[1], village[2]], deadline, 90000);
        if (at) {
          const got = await takeBed(api, at, deadline);
          if (got) { bedItem = got; way = 'village_bed'; }
          else tried.push(`деревня: кровать ${at.join(' ')} не подобралась`);
        } else tried.push('деревня: кровати не нашла');
      }
    }

    if (!bedItem) return { ok: false, error: 'кровать/шерсть не найдены: ' + (tried.join(' | ') || 'негде искать (дай points или village_x/village_z)'), tried };

    const snap0 = await api.snapshot();
    const p0 = snap0.position || {};
    if (Date.now() >= deadline) return { ok: false, error: 'вышло время max_sec, кровать ' + bedItem + ' при себе', bed: false, carrying: bedItem, way };

    api.log(`bring_bed_home: кровать ${bedItem} (${way}), иду на базу ${base.join(' ')}`);
    const distBase = dist2(p0.x, p0.z, base[0], base[2]);
    if (distBase > 4) {
      const backRoute = route.length && distBase > 60 ? route.slice().reverse() : [];
      const tr = await travel(api, base[0], base[1], base[2], deadline, 'к базе', { route: backRoute });
      if (!tr.arrived && !tr.near) {
        return { ok: false, error: `кровать ${bedItem} есть, но до базы не дошла: ${(tr.errors || []).slice(-1)[0] || 'не дошла'}`, bed: false, carrying: bedItem, way, at: tr.at };
      }
    }

    if (!doPlace) return { ok: true, bed: true, placed: false, item: bedItem, at: [Math.round(p0.x), Math.round(p0.y), Math.round(p0.z)], way };

    const pr = await placeBed(api, bedItem, base, deadline);
    if (!pr.ok) return { ok: false, error: pr.error + ` (кровать ${bedItem} в инвентаре)`, bed: false, carrying: bedItem, way };
    return { ok: true, bed: true, placed: true, at: pr.at, item: bedItem, way, from: [Math.round(p0.x), Math.round(p0.y), Math.round(p0.z)] };
  }
};
