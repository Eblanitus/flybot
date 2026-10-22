// версия: по заявке учителя: при HP<8 без врагов escape не зовёт — ест и ждёт регена или отказ «еды нет»
// home_path — вернуться домой по известному маршруту (точки туннелей/поверхности), без «No path».
// Идём по точкам по порядку: на каждую goto с большим timeout; провал точки не отменяет маршрут —
// пробуем обход/следующую точку. Ночью (дальше 60 м до цели) пережидаем, враг рядом — escape.
//
// Правка по заявке учителя (случай 20261022-013747-20, урок L022):
//   было: при HP<8 навык звал escape шесть раз подряд, хотя врагов рядом не было (тело отвечало
//   «fled:false, врагов рядом нет»), затем шёл дальше по маршруту и отдавал error = «не дошла до
//   -393 67 36» — провал читался как «не повезло с дорогой», а на деле условия не выполнены.
//   стало:
//   1) HP<8 и врагов рядом нет (eyes.enemies и eyes.threats пусто) — escape НЕ зовём (пустая команда).
//      Про HP решаем один раз: еда в инвентаре есть → eat и ждём регена; еды нет → явный отказ
//      «HP 2, еды нет — идти нельзя».
//   2) escape — только когда враг реально рядом (правило оставлено), не больше max_escapes раз.
//   3) причина провала — в поле error (что именно мешает), at/stuck/escapes/failed — как были.
//   4) идти нельзя — явный отказ с причиной, маршрут молча не «прокручиваем».
//   5) ночью дальше 60 м — пережидание до утра (как было).
'use strict';

const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
// еда, которую тело согласится съесть (гнилое/ядовитое/золотые яблоки pickFood отбрасывает)
const FOODS = /^(cooked_[a-z_]+|baked_potato|bread|apple|golden_carrot|carrot|beef|porkchop|mutton|rabbit|cod|salmon|melon_slice|sweet_berries|dried_kelp|pumpkin_pie|cookie|mushroom_stew|beetroot_soup|rabbit_stew)$/;
const REGEN_FOOD = 18;   // порог сытости для регена (в теле так же)

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

// ---- состояние мухи: HP, сытость, еда в инвентаре, враги рядом ----
function hpOf(snap) {
  const v = snap && snap.eyes && snap.eyes.vitals && snap.eyes.vitals.hp;
  if (Number.isFinite(Number(v))) return Number(v);
  const h = snap && snap.health;
  return Number.isFinite(Number(h)) ? Number(h) : 20;
}
function foodLevel(snap) {
  const v = snap && snap.eyes && snap.eyes.vitals && snap.eyes.vitals.food;
  if (Number.isFinite(Number(v))) return Number(v);
  const f = snap && snap.food;
  return Number.isFinite(Number(f)) ? Number(f) : 20;
}
function invFood(snap) {
  const names = [];
  let n = 0;
  for (const i of (snap && snap.inventory) || []) {
    if (i && i.name && FOODS.test(i.name)) { n += (i.count || 0); names.push(i.name); }
  }
  return { n, names };
}
// враг рядом: враг-игрок (eyes.threats) или враждебный моб (eyes.enemies). Пусто — врагов нет.
function foeNear(eyes, cfg) {
  const th = (eyes.threats || []).filter(t => t && t.d != null && t.d <= cfg.threatD)[0];
  if (th) return { name: th.name, d: th.d, kind: 'игрок' };
  const mob = (eyes.enemies || []).filter(e => e && e.d != null && e.d <= cfg.mobD)[0];
  if (mob) return { name: mob.name, d: mob.d, kind: 'моб' };
  return null;
}

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

// ---- про HP решаем один раз: еда/реген. Возвращает {ok:true} (можно идти) или {ok:false, why} ----
async function resolveLowHp(api, snap, state, cfg, deadline) {
  const hp = hpOf(snap);
  const lvl = foodLevel(snap);
  const inv = invFood(snap);
  if (state.hpDecided) {
    // решение уже принято: повторно ни eat, ни ожидания — честный отказ с причиной
    const why = `HP ${hp}, регена нет — идти нельзя`;
    state.hpWhy = why;
    api.log('home_path: ' + why);
    return { ok: false, why };
  }
  state.hpDecided = true;
  const canRegen = inv.n > 0 || lvl >= REGEN_FOOD;
  if (!canRegen) {
    const why = `HP ${hp}, еды нет — идти нельзя`;
    state.hpWhy = why;
    api.log(`home_path: ${why} (сытость ${lvl}, в инвентаре еды нет)`);
    return { ok: false, why };
  }
  if (inv.n > 0) {
    api.log(`home_path: HP ${hp}, еда есть (${inv.names.join(', ')}) — ем и жду регена`);
    try {
      const r = await api.cmd('eat', { count: 1 });
      api.log('home_path: eat: ' + JSON.stringify(r || {}).slice(0, 100));
    } catch (e) { api.log('home_path: eat: ' + short(e.message)); }
  } else {
    api.log(`home_path: HP ${hp}, сытость ${lvl} — жду регена (еды в инвентаре нет)`);
  }
  const end = Math.min(deadline, Date.now() + cfg.regenSec * 1000);
  let last = hp;
  while (Date.now() < end) {
    await api.sleep(5000);
    let s = null;
    try { s = await api.snapshot(); } catch (e) { continue; }
    if (!s) continue;
    const h2 = hpOf(s);
    if (h2 >= cfg.minHp) {
      api.log(`home_path: HP восстановился ${last} → ${h2} — иду дальше`);
      return { ok: true };
    }
    if (h2 < last) {
      const why = `HP ${h2} и падает${inv.n ? '' : ', еды нет'} — идти нельзя`;
      state.hpWhy = why;
      api.log('home_path: ' + why);
      return { ok: false, why };
    }
    last = h2;
    const f = foeNear(s.eyes || {}, cfg);
    if (f) {
      api.log(`home_path: жду регена, рядом враг ${f.name} ${f.d} м — escape`);
      try { await api.cmd('escape', { distance: 16, shelter: true }); }
      catch (e) { api.log('escape: ' + short(e.message)); }
    }
  }
  const lvl2 = foodLevel(snap);
  const why = `HP ${hp}, регена не было за ${cfg.regenSec} с (сытость ${lvl2}${inv.n ? '' : ', еды нет'}) — идти нельзя`;
  state.hpWhy = why;
  api.log('home_path: ' + why);
  return { ok: false, why };
}

// Идти к одной точке. Возвращает {ok, at, why, blocked}; при провале маршрут продолжается со следующей точки,
// но blocked=true — это «идти нельзя»: отказ с причиной, маршрут останавливается.
async function goTo(api, pt, deadline, state, cfg) {
  const [tx, ty, tz] = pt;
  let lastMsg = '';
  for (let attempt = 0; attempt < 6 && Date.now() < deadline; attempt++) {
    let snap;
    try { snap = await api.snapshot(); }
    catch (e) { return { ok: false, blocked: true, why: 'снимок тела не получился: ' + short(e.message) }; }
    const p = snap.position || {};
    const eyes = snap.eyes || {};
    const hp = hpOf(snap);
    const dh = dist2(p.x, p.z, tx, tz);
    const dy = ty == null ? 0 : ty - p.y;
    if (dh <= 2.5 && Math.abs(dy) <= 2) return { ok: true, at: [p.x, p.y, p.z] };

    const foe = foeNear(eyes, cfg);

    // 1) HP ниже порога. Escape — только если враг реально рядом; иначе решаем про HP один раз.
    if (hp < cfg.minHp) {
      if (foe) {
        if (state.escapes >= cfg.maxEscapes) {
          const why = `HP ${hp}, враг ${foe.name} рядом (${foe.d} м) — бегства не помогли, идти нельзя`;
          state.hpWhy = why;
          return { ok: false, blocked: true, why };
        }
        state.escapes++;
        api.log(`home_path: HP ${hp}, враг ${foe.name} ${foe.d} м — escape`);
        try { await api.cmd('escape', { distance: 16, shelter: true }); }
        catch (e) { api.log('escape: ' + short(e.message)); }
        await api.sleep(600);
        continue;
      }
      // врагов рядом нет — escape от врагов, которых нет, звать нельзя
      const r = await resolveLowHp(api, snap, state, cfg, deadline);
      if (!r.ok) return { ok: false, blocked: true, why: r.why };
      continue;
    }

    // 2) враг рядом (HP в норме) — escape, как было
    if (foe) {
      if (state.escapes >= cfg.maxEscapes) {
        const why = `враг ${foe.name} не отстаёт — бегства не помогли, идти нельзя`;
        return { ok: false, blocked: true, why };
      }
      state.escapes++;
      api.log(`home_path: враг ${foe.name} ${foe.d} м рядом — escape`);
      try { await api.cmd('escape', {}); }
      catch (e) { api.log('escape: ' + short(e.message)); }
      await api.sleep(600);
      continue;
    }

    if (isNight(eyes.time) && dh > cfg.nightDist) {
      const w = await restAtNight(api, deadline, state);
      if (!w.ok) return { ok: false, blocked: true, why: w.why };
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
      lastMsg = `goto дошёл не в точку ${tx} ${ty == null ? '?' : ty} ${tz}`;
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
  return { ok: false, why: lastMsg || 'goto не сработал (причина неизвестна)' };
}

module.exports = {
  name: 'home_path',
  description: 'Вернуться домой по известному маршруту точек (туннели/поверхность): goto по каждой точке с запасом времени, провал точки не отменяет маршрут (обход, следующая точка), ночью дальше 60 м — укрытие/ожидание, враг рядом — escape. При HP<8 и отсутствии врагов escape не зовём: про HP решаем один раз (еда есть — eat и ждём регена, еды нет — отказ «HP N, еды нет — идти нельзя»). Причина отказа — в поле error, а at/stuck/escapes/failed — как были.',
  params: {
    route: 'точки маршрута "x,y,z;x,y,z;…" (по умолчанию известный туннельный маршрут тайга→база)',
    points: 'то же, что route (синоним)',
    x: 'финальная цель x (по умолчанию -393)', y: 'финальная цель y (по умолчанию 67)', z: 'финальная цель z (по умолчанию 36)',
    surface: '1 — идти по поверхности (-330 68 36 -> база), 0 — по туннелям (по умолчанию)',
    min_hp: 'ниже этого HP не идём (отказ с причиной), по умолчанию 8',
    regen_sec: 'сколько ждать регена при низком HP, по умолчанию 60 (0 — не ждать)',
    max_sec: 'потолок времени, по умолчанию 900'
  },
  async run(api, params) {
    params = params || {};
    const maxSec = Math.max(60, Math.min(num(params.max_sec, 900), 1800));
    const deadline = Date.now() + maxSec * 1000;
    const surface = truthy(params.surface);
    const cfg = {
      minHp: Math.max(1, Math.min(20, Math.round(num(params.min_hp, 8)))),
      regenSec: Math.max(0, Math.min(300, Math.round(num(params.regen_sec, 60)))),
      nightDist: 60,
      threatD: 24,
      mobD: 8,
      maxEscapes: 5
    };

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

    const state = { hops: 0, escapes: 0, nights: 0, hpDecided: false, hpWhy: null };
    const failed = [];
    let stuck = null;
    let blockWhy = null;      // причина, по которой идти нельзя (показываем в error)
    let lastWhy = '';         // причина последнего непройденного отрезка

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (Date.now() >= deadline) {
        failed.push(`${pt.join(' ')}: время вышло`);
        stuck = pt;
        blockWhy = blockWhy || `время вышло (${maxSec} с) — до ${goal.join(' ')} не дошла`;
        break;
      }
      const legsLeft = pts.length - i;
      const legMs = Math.max(90000, Math.min(300000, Math.floor((deadline - Date.now()) / legsLeft)));
      const legDeadline = Math.min(deadline, Date.now() + legMs);
      api.log(`home_path: точка ${i + 1}/${pts.length} → ${pt[0]} ${pt[1] == null ? '?' : pt[1]} ${pt[2]}`);

      let r;
      try { r = await goTo(api, pt, legDeadline, state, cfg); }
      catch (e) { r = { ok: false, why: short(e.message) }; }
      if (!r.ok) {
        failed.push(`${pt.join(' ')}: ${r.why}`);
        stuck = pt;
        lastWhy = r.why;
        if (r.blocked) {
          // идти нельзя — явный отказ с причиной, маршрут дальше не крутим
          blockWhy = r.why;
          api.log(`home_path: отказ: ${r.why} (точка ${pt.join(' ')}) — маршрут остановлен`);
          break;
        }
        api.log(`home_path: точка ${pt.join(' ')} не пройдена: ${r.why} — иду дальше по маршруту`);
      }
    }

    const snap = await api.snapshot();
    const p = snap.position || {};
    const arrived = near(p, goal[0], goal[2]) && Math.abs(goal[1] - p.y) <= 3;
    const at = [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
    if (arrived) return { ok: true, at, route: pts, hops: state.hops, arrived: true, escapes: state.escapes, nights: state.nights };
    // error = что именно мешает (а не «не повезло с дорогой»)
    const error = blockWhy
      || `не дошла до ${(stuck || goal).join(' ')}` + (lastWhy ? ` — ${lastWhy}` : '');
    return {
      ok: false,
      error,
      at, stuck: stuck || goal, route: pts, hops: state.hops, arrived: false,
      escapes: state.escapes, nights: state.nights, failed
    };
  }
};
