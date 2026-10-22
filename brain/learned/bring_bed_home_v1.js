// версия: первая: кровать — сломать в точке/деревне, остричь овец или скрафтить из ниток; дорога перебежками
// bring_bed_home — добыть кровать (сломать в известной точке/деревне, остричь овец или скрафтить из ниток),
// принести к базе и поставить на твёрдый блок рядом с сундуком. Дорога перебежками, ночью — укрытие.
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|vine|glow_lichen|moss_carpet|[a-z_]*flower|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony)$/;
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const solid = b => b && b !== '?' && !AIRLIKE.test(b) && !/water|lava/.test(b);

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
  return Object.keys(m).find(n => /_bed$/.test(n) && m[n] > 0) || null;
}

async function bedAt(api) {
  const pick = s => {
    const b = s.eyes && s.eyes.blocks && s.eyes.blocks.bed;
    return b && b.at ? b.at : null;
  };
  let snap = await api.snapshot();
  let at = pick(snap);
  if (at) return at;
  try { await api.cmd('find', { block: 'bed', steps: 6 }); }
  catch (e) { api.log('bring_bed_home: find bed: ' + short(e.message)); }
  snap = await api.snapshot();
  return pick(snap);
}

async function takeBed(api, deadline) {
  for (let i = 0; i < 4 && Date.now() < deadline; i++) {
    const at = await bedAt(api);
    if (!at) return await bedInInv(api);
    try { await api.cmd('dig_at', { x: at[0], y: at[1], z: at[2] }); }
    catch (e) { api.log(`bring_bed_home: dig_at кровати ${at.join(' ')}: ${short(e.message)}`); }
    try { await api.cmd('pickup', { radius: 6, max_sec: 12 }); } catch (e) { api.log('pickup: ' + short(e.message)); }
    const got = await bedInInv(api);
    if (got) return got;
  }
  return await bedInInv(api);
}

async function travel(api, tx, ty, tz, deadline, tag) {
  const step = 24;
  let hops = 0, fails = 0, escapes = 0, nights = 0;
  for (let i = 0; i < 400 && Date.now() < deadline; i++) {
    const snap = await api.snapshot();
    const p = snap.position || {};
    const eyes = snap.eyes || {};
    const vit = eyes.vitals || {};
    const time = eyes.time || {};
    const dist = Math.hypot(tx - p.x, tz - p.z);
    if (dist <= 2.5 && (ty == null || Math.abs(ty - p.y) <= 2)) return { at: [p.x, p.y, p.z], hops, escapes };

    if ((vit.hp == null ? 20 : vit.hp) < 8) {
      if (++escapes > 4) throw new Error(`HP ${vit.hp}, 4 бегства не помогли`);
      api.log(`${tag}: HP ${vit.hp} — escape`);
      try { await api.cmd('escape', { distance: 16, shelter: true }); } catch (e) { api.log('escape: ' + short(e.message)); }
      continue;
    }
    const th = (eyes.threats || []).filter(t => t.d != null && t.d <= 24)[0];
    const mobs = (eyes.enemies || []).filter(e => e.d != null && e.d <= 8);
    if (th || mobs.length) {
      if (++escapes > 4) throw new Error(`враги не отстают (${(th && th.name) || mobs[0].name}) — 4 бегства`);
      api.log(`${tag}: ${th ? 'враг-игрок ' + th.name : 'враг ' + mobs[0].name} рядом — escape`);
      try { await api.cmd('escape', {}); } catch (e) { api.log('escape: ' + short(e.message)); }
      continue;
    }
    const night = time.phase === 'ночь' || (typeof time.nightIn === 'number' && time.nightIn < 45);
    if (night) {
      if (++nights > 8) throw new Error('ночь не кончается (8 пережиданий)');
      api.log(`${tag}: ночь — пережидаю (${time.nightIn == null ? '?' : time.nightIn} с до утра)`);
      const carrying = await bedInInv(api);
      if (carrying) {
        try { await api.cmd('shelter', {}); } catch (e) { api.log('shelter: ' + short(e.message)); }
        const t0 = Date.now();
        while (Date.now() - t0 < 90000 && Date.now() < deadline) {
          await api.sleep(5000);
          const s2 = await api.snapshot();
          const t2 = (s2.eyes && s2.eyes.time) || {};
          const v2 = (s2.eyes && s2.eyes.vitals) || {};
          if (v2.hp != null && v2.hp < 8) { try { await api.cmd('escape', {}); } catch (e) { api.log('escape: ' + short(e.message)); } }
          if (t2.phase !== 'ночь') break;
        }
      } else {
        const sec = Math.max(60, Math.min(720, Math.floor((deadline - Date.now()) / 1000)));
        try { await api.cmd('wait_night', { max_sec: sec }); } catch (e) { api.log('wait_night: ' + short(e.message)); }
      }
      continue;
    }

    const k = dist > step ? step / dist : 1;
    const goal = { x: Math.round(p.x + (tx - p.x) * k), z: Math.round(p.z + (tz - p.z) * k), timeout: 90 };
    if (k === 1 && ty != null) goal.y = ty;
    try { await api.cmd('goto', goal); hops++; fails = 0; }
    catch (e) {
      const msg = short(e.message);
      if (dist <= 6) return { at: [p.x, p.y, p.z], hops, escapes, near: true };
      if (/занят|выполняется|повтори/.test(msg)) { await api.sleep(1200); i--; continue; }
      if (++fails >= 3) throw new Error(`не дошла до ${tx} ${tz}: ${msg}`);
      api.log(`${tag}: goto: ${msg}`);
    }
  }
  throw new Error(`не дошла до ${tx} ${tz} (перебежки/время)`);
}

async function acquireWool(api, deadline) {
  let err = '';
  const strings = await api.count('string');
  if (strings >= 12) {
    try {
      await api.cmd('craft', { item: 'white_wool', count: 3 });
      await api.cmd('craft', { item: 'white_bed' });
      const b = await bedInInv(api);
      if (b) return { bed: b, way: 'wool' };
    } catch (e) { err = 'нитки: ' + short(e.message); }
  }
  const sec = Math.max(45, Math.min(240, Math.floor((deadline - Date.now()) / 1000)));
  try {
    const r = await api.skill('make_bed', { max_sec: sec });
    if (r && r.ok && r.bed) { const b = await bedInInv(api); if (b) return { bed: b, way: 'wool' }; }
    if (r && r.error) err = (err ? err + ' | ' : '') + 'make_bed: ' + r.error;
  } catch (e) { err = (err ? err + ' | ' : '') + 'make_bed: ' + short(e.message); }
  if (/досок|planks|бревн|wood/i.test(err)) {
    try {
      await api.cmd('collect', { block: 'log', count: 2 });
      const sec2 = Math.max(45, Math.min(180, Math.floor((deadline - Date.now()) / 1000)));
      const r2 = await api.skill('make_bed', { max_sec: sec2 });
      if (r2 && r2.ok && r2.bed) { const b = await bedInInv(api); if (b) return { bed: b, way: 'wool' }; }
    } catch (e) { err = (err ? err + ' | ' : '') + short(e.message); }
  }
  return { error: err || 'шерсть/кровать не добыты' };
}

async function bedNear(api, s) {
  try {
    const sv = await api.cmd('survey', { x1: s.x - 2, y1: s.y - 1, z1: s.z - 2, x2: s.x + 2, y2: s.y + 1, z2: s.z + 2 });
    const g = grid(sv);
    for (let y = s.y - 1; y <= s.y + 1; y++)
      for (let z = s.z - 2; z <= s.z + 2; z++)
        for (let x = s.x - 2; x <= s.x + 2; x++)
          if (/_bed$/.test(g(x, y, z))) return [x, y, z];
  } catch (e) { api.log('survey bed: ' + short(e.message)); }
  const snap = await api.snapshot();
  const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.bed;
  return b && b.at ? b.at : null;
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
  if (!spots.length) return { ok: false, error: `нет ровного места под кровать у базы ${bx} ${by} ${bz} (survey ${sv.hidden == null ? '' : 'hidden ' + sv.hidden})` };

  const failed = [];
  for (const s of spots.slice(0, 10)) {
    if (Date.now() > deadline) break;
    try { await api.cmd('place_at', { x: s.x, y: s.y, z: s.z, item }); }
    catch (e) { failed.push(short(e.message)); api.log(`place_at bed ${s.x} ${s.y} ${s.z}: ${short(e.message)}`); continue; }
    await api.sleep(300);
    const at = await bedNear(api, s);
    if (at) return { ok: true, at };
    failed.push(`${s.x},${s.y},${s.z}: не видно кровати после place_at`);
  }
  return { ok: false, error: 'не удалось поставить кровать: ' + failed.slice(0, 3).join(' | ') };
}

module.exports = {
  name: 'bring_bed_home',
  description: 'Добыть кровать (сломать кровать в points/деревне, остричь овец или скрафтить), принести к базе x,y,z и поставить рядом с сундуком. Дорога перебежками, ночью укрытие/ожидание. Возвращает bed, at, way.',
  params: {
    x: 'куда нести кровать, x (по умолчанию -393)', y: 'y ног на базе (по умолчанию 67)', z: 'z (по умолчанию 36)',
    points: 'известные точки с кроватью: "-558,71,41" (несколько — через ; или подряд x,y,z)',
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

    const targets = [];
    for (const at of parsePoints(params.points)) targets.push({ at, kind: 'point' });
    const vx = Number(params.village_x), vz = Number(params.village_z);
    if (Number.isFinite(vx) && Number.isFinite(vz) && !targets.some(t => t.at[0] === vx && t.at[2] === vz)) {
      const vy = Number.isFinite(Number(params.village_y)) ? Number(params.village_y) : null;
      targets.push({ at: [vx, vy, vz], kind: 'village' });
    }

    let bedItem = await bedInInv(api);
    let way = bedItem ? 'inventory' : null;
    const tried = [];

    if (!bedItem) {
      if (!targets.length) return { ok: false, error: 'негде искать кровать: дай points="-558,71,41" или village_x/village_z' };
      for (const t of targets) {
        if (Date.now() >= deadline) break;
        const [px, py, pz] = t.at;
        api.log(`bring_bed_home: иду в ${px} ${py == null ? '' : py} ${pz} (${t.kind})`);
        try { await travel(api, px, py == null ? null : py, pz, deadline, t.kind); }
        catch (e) { tried.push(`${t.kind} ${px},${pz}: ${short(e.message)}`); continue; }

        if (!preferWool) {
          const at = await bedAt(api);
          if (at) {
            const got = await takeBed(api, deadline);
            if (got) { bedItem = got; way = t.kind === 'village' ? 'village_bed' : 'point_bed'; break; }
            tried.push(`${t.kind}: кровать ${at.join(' ')} не подобралась`);
          }
        }
        const w = await acquireWool(api, deadline);
        if (w.bed) { bedItem = w.bed; way = w.way; break; }
        tried.push(`${t.kind}: ${w.error}`);
      }
    }
    if (!bedItem) return { ok: false, error: 'кровать/шерсть не найдены: ' + (tried.join(' | ') || 'все точки недоступны'), tried };

    const snap0 = await api.snapshot();
    const p0 = snap0.position || {};
    if (Date.now() >= deadline) return { ok: false, error: 'вышло время max_sec, кровать ' + bedItem + ' при себе', bed: false, carrying: bedItem, way };

    api.log(`bring_bed_home: кровать ${bedItem} (${way}), иду на базу ${base.join(' ')}`);
    try { await travel(api, base[0], base[1], base[2], deadline, 'к базе'); }
    catch (e) { return { ok: false, error: `кровать ${bedItem} есть, но до базы не дошла: ${short(e.message)}`, bed: false, carrying: bedItem, way }; }

    if (!doPlace) return { ok: true, bed: true, placed: false, item: bedItem, at: [Math.round(p0.x), Math.round(p0.y), Math.round(p0.z)], way };

    const pr = await placeBed(api, bedItem, base, deadline);
    if (!pr.ok) return { ok: false, error: pr.error + ` (кровать ${bedItem} в инвентаре)`, bed: false, carrying: bedItem, way };
    return { ok: true, bed: true, placed: true, at: pr.at, item: bedItem, way, from: [Math.round(p0.x), Math.round(p0.y), Math.round(p0.z)] };
  }
};
