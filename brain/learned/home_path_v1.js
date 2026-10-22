// версия: первая: идёт по точкам маршрута, при HP<8 или враге — escape
// home_path — вернуться домой по известному маршруту (точки туннелей/поверхности), без «No path».
// Идём по точкам по порядку: на каждую goto с большим timeout; провал точки не отменяет маршрут —
// пробуем обход/следующую точку. Ночью (дальше 60 м до цели) пережидаем, HP<8 или враг рядом — escape.
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

const TAIGA = [[-64, 78, 9], [-73, 70, 12], [-60, 78, 23]];
const TUNNEL = [[-367, 48, 37], [-350, 50, 37], [-378, 54, 28]];
const SURFACE_POINT = [-330, 68, 36];

function parsePoints(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map(a => String(a).split(/[,\s]+/).map(Number))
      .filter(a => a.length >= 3 && a.slice(0, 3).every(Number.isFinite))
      .map(a => a.slice(0, 3).map(Math.round));
  }
  const nums = (String(v).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 2 < nums.length; i += 3) out.push([nums[i], nums[i + 1], nums[i + 2]].map(Math.round));
  return out;
}

function near(p, x, z) { return dist2(p.x, p.z, x, z) <= 2.5; }

function isNight(t) {
  if (!t) return false;
  if (t.phase === 'ночь') return true;
  return t.phase === 'закат' && Number.isFinite(Number(t.nightIn)) && Number(t.nightIn) <= 60;
}

function nearest(p, list) {
  let best = list[0], bd = Infinity;
  for (const q of list) {
    const d = dist2(p.x, p.z, q[0], q[2]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function defaultRoute(p, surface) {
  if (surface) {
    const pts = [];
    const d = dist2(p.x, p.z, SURFACE_POINT[0], SURFACE_POINT[2]);
    if (d > 60) {
      const n = Math.min(12, Math.ceil(d / 48));
      for (let i = 1; i < n; i++) {
        const k = i / n;
        pts.push([Math.round(p.x + (SURFACE_POINT[0] - p.x) * k), null, Math.round(p.z + (SURFACE_POINT[2] - p.z) * k)]);
      }
    }
    pts.push(SURFACE_POINT);
    return pts;
  }
  const pts = [];
  const taiga = nearest(p, TAIGA);
  if (dist2(p.x, p.z, taiga[0], taiga[2]) <= 80) pts.push(taiga);
  for (const q of TUNNEL) pts.push(q);
  return pts;
}

async function restAtNight(api, deadline, state) {
  state.nights++;
  const remain = Math.floor((deadline - Date.now()) / 1000);
  if (remain < 90) return { ok: false, why: 'ночь, а max_sec кончается' };
  if (state.nights > 6) return { ok: false, why: 'ночь не кончается (6 пережиданий)' };
  const sec = Math.max(60, Math.min(720, remain - 20));
  api.log(`home_path: ночь — пережидаю до утра (до ${sec} с)`);
  try { await api.cmd('wait_night', { max_sec: sec }); return { ok: true }; }
  catch (e) { api.log('wait_night: ' + short(e.message)); }
  try { await api.cmd('shelter', {}); } catch (e) { api.log('shelter: ' + short(e.message)); }
  const until = Math.min(deadline, Date.now() + 180000);
  while (Date.now() < until) {
    await api.sleep(5000);
    const s = await api.snapshot();
    if (!isNight(s.eyes && s.eyes.time)) return { ok: true };
  }
  return { ok: false, why: 'ночь не удалось переждать (нет укрытия)' };
}

// Идти к одной точке. Возвращает {ok, at, why}; при провале маршрут продолжается со следующей точки.
async function goTo(api, pt, deadline, state) {
  const [tx, ty, tz] = pt;
  let lastMsg = '';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    const snap = await api.snapshot();
    const p = snap.position || {};
    const eyes = snap.eyes || {};
    const vit = eyes.vitals || {};
    const hp = Number.isFinite(vit.hp) ? vit.hp : 20;
    const dh = dist2(p.x, p.z, tx, tz);
    const dy = ty == null ? 0 : ty - p.y;
    if (dh <= 2.5 && Math.abs(dy) <= 2) return { ok: true, at: [p.x, p.y, p.z] };

    if (hp < 8) {
      if (++state.escapes > 6) return { ok: false, why: `HP ${hp}, escape не помог` };
      api.log(`home_path: HP ${hp} — escape`);
      try { await api.cmd('escape', { distance: 16, shelter: true }); }
      catch (e) { api.log('escape: ' + short(e.message)); }
      continue;
    }
    const th = (eyes.threats || []).filter(t => t.d != null && t.d <= 24)[0];
    const mob = (eyes.enemies || []).filter(e => e.d != null && e.d <= 5)[0];
    if ((th || mob) && state.escapes < 8) {
      state.escapes++;
      api.log(`home_path: ${th ? 'враг-игрок ' + th.name : 'враг ' + mob.name} рядом — escape`);
      try { await api.cmd('escape', {}); }
      catch (e) { api.log('escape: ' + short(e.message)); }
      continue;
    }

    if (isNight(eyes.time) && dh > 60) {
      const w = await restAtNight(api, deadline, state);
      if (!w.ok) return { ok: false, why: w.why };
      continue;
    }

    const remain = (deadline - Date.now()) / 1000;
    if (remain < 20) return { ok: false, why: 'время на точку вышло' };
    const timeout = Math.round(Math.max(30, Math.min(180, remain - 8)));
    const goal = { x: tx, z: tz, timeout };
    if (ty != null) goal.y = ty;
    try {
      await api.cmd('goto', goal);
      state.hops++;
      const s2 = await api.snapshot();
      const q = s2.position || {};
      if (near(q, tx, tz) && (ty == null || Math.abs(ty - q.y) <= 2.5)) return { ok: true, at: [q.x, q.y, q.z] };
      lastMsg = 'goto пришёл не в точку';
      api.log(`home_path: ${tx} ${ty == null ? '?' : ty} ${tz}: ${lastMsg}`);
    } catch (e) {
      lastMsg = short(e.message);
      if (/занят|выполняется|прерван|abort/i.test(lastMsg)) { await api.sleep(1500); continue; }
      state.hops++;
      api.log(`home_path: ${tx} ${ty == null ? '?' : ty} ${tz}: ${lastMsg}`);
    }

    if (dh <= 14) {
      if (dy >= 1.5) {
        try {
          const h = Math.max(1, Math.min(3, Math.round(dy)));
          const r = await api.cmd('pillar_up', { height: h });
          api.log(`home_path: pillar_up +${r && r.raised != null ? r.raised : h}`);
        } catch (e) { api.log('pillar_up: ' + short(e.message)); }
      } else {
        try {
          await api.cmd('dig_at', { x: tx, y: ty == null ? Math.round(p.y) : ty, z: tz });
          state.hops++;
        } catch (e) { api.log('dig_at: ' + short(e.message)); }
      }
    } else {
      const k = Math.min(1, 28 / dh);
      const nx = Math.round(p.x + (tx - p.x) * k);
      const nz = Math.round(p.z + (tz - p.z) * k);
      const ny = ty == null ? null : Math.round(p.y + (ty - p.y) * k);
      api.log(`home_path: обход к ${nx} ${ny == null ? '?' : ny} ${nz}`);
      try {
        await api.cmd('goto', ny == null ? { x: nx, z: nz, timeout: 70 } : { x: nx, y: ny, z: nz, timeout: 70 });
        state.hops++;
      } catch (e) { api.log('обход: ' + short(e.message)); }
    }
    await api.sleep(400);
  }
  return { ok: false, why: lastMsg || 'не дошла' };
}

module.exports = {
  name: 'home_path',
  description: 'Вернуться домой по известному маршруту точек (туннели/поверхность): goto по каждой точке с запасом времени, провал точки не отменяет маршрут (обход, следующая точка), ночью — укрытие/ожидание, HP<8 или враг рядом — escape. Возвращает at, route, hops, arrived.',
  params: {
    route: 'точки маршрута "x,y,z;x,y,z;…" (по умолчанию известный туннельный маршрут тайга→база)',
    points: 'то же, что route (синоним)',
    x: 'финальная цель x (по умолчанию -393)', y: 'финальная цель y (по умолчанию 67)', z: 'финальная цель z (по умолчанию 36)',
    surface: '1 — идти по поверхности (-330 68 36 -> база), 0 — по туннелям (по умолчанию)',
    max_sec: 'потолок времени, по умолчанию 900'
  },
  async run(api, params) {
    params = params || {};
    const maxSec = Math.max(60, Math.min(num(params.max_sec, 900), 1800));
    const deadline = Date.now() + maxSec * 1000;
    const surface = truthy(params.surface);

    const snap0 = await api.snapshot();
    const start = snap0.position || { x: 0, y: 64, z: 0 };

    let route = parsePoints(params.route || params.points);
    const hasGoal = Number.isFinite(Number(params.x)) || Number.isFinite(Number(params.y)) || Number.isFinite(Number(params.z));
    let goal;
    if (hasGoal) goal = [Math.round(num(params.x, -393)), Math.round(num(params.y, 67)), Math.round(num(params.z, 36))];
    else if (route.length) goal = route[route.length - 1].slice();
    else goal = [-393, 67, 36];

    if (!route.length) route = defaultRoute(start, surface);

    // Убрать повторные точки и точку старта, затем гарантировать финальную цель в конце.
    const pts = [];
    for (const q of route) {
      if (pts.length && dist2(pts[pts.length - 1][0], pts[pts.length - 1][2], q[0], q[2]) < 3) continue;
      pts.push(q);
    }
    const last = pts[pts.length - 1];
    if (!last || dist2(last[0], last[2], goal[0], goal[2]) > 3 || Math.abs((last[1] == null ? goal[1] : last[1]) - goal[1]) > 2) pts.push(goal);

    const state = { hops: 0, escapes: 0, nights: 0 };
    const failed = [];
    let stuck = null;

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (Date.now() >= deadline) { failed.push(`${pt.join(' ')}: время вышло`); stuck = pt; break; }
      const legsLeft = pts.length - i;
      const legMs = Math.max(90000, Math.min(300000, Math.floor((deadline - Date.now()) / legsLeft)));
      const legDeadline = Math.min(deadline, Date.now() + legMs);
      api.log(`home_path: точка ${i + 1}/${pts.length} → ${pt[0]} ${pt[1] == null ? '?' : pt[1]} ${pt[2]}`);

      let r;
      try { r = await goTo(api, pt, legDeadline, state); }
      catch (e) { r = { ok: false, why: short(e.message) }; }
      if (!r.ok) {
        failed.push(`${pt.join(' ')}: ${r.why}`);
        stuck = pt;
        api.log(`home_path: точка ${pt.join(' ')} не взята (${r.why}) — иду дальше по маршруту`);
      }
    }

    const snap = await api.snapshot();
    const p = snap.position || {};
    const arrived = near(p, goal[0], goal[2]) && Math.abs(goal[1] - p.y) <= 3;
    const at = [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
    if (arrived) return { ok: true, at, route: pts, hops: state.hops, arrived: true, escapes: state.escapes, nights: state.nights };
    return {
      ok: false,
      error: `не дошла до ${(stuck || goal).join(' ')}`,
      at, stuck: stuck || goal, route: pts, hops: state.hops, arrived: false,
      escapes: state.escapes, nights: state.nights, failed
    };
  }
};
