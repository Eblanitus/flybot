// версия: по заявке учителя: на низком HP/без еды не идёт, дорога участками без обрывов, сбор малым радиусом; смерть — стоп
// gather_wood — поход в лес за брёвнами.
// Разбор смерти (brain/skill_requests/gather_wood.md, учитель): длинный goto без проверки перепада
// высот + collect с radius 48 уводили муху с обрыва, смерть ловилась как «не нашёл», поход повторялся.
//
// 1) ДО похода — снимок: при HP <= min_hp или без еды для регена -> отказ, не выходим.
// 2) Дорога участками: перед участком survey коридора + обрыв/лава из снимка.
//    Перепад вниз больше безопасного не перешагиваем: уходим вбок (обход) или отказываемся.
// 3) Сбор рядом с точкой леса: collect с малым радиусом, к цели идём короткими шагами.
// 4) Смерть или потеря HP — сразу стоп с причиной, тот же путь не повторяем.
//
// params: count, x/y/z (точка леса), step, radius, min_hp, min_food, wait_regen, arrive, max_sec
const FOREST = { x: -472, y: 69, z: 37 };
const TREE_RE = /(_log|_leaves|_wood|_sapling)$/;
const DEATH_RE = /смерт|умер|death|упал|падени|fell|killed/i;
const MAX_SURVEY = 4096;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function d2(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function clean(m) { return String(m == null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim(); }
function isDeath(m) { return DEATH_RE.test(clean(m)); }
function hpOf(s) { return Math.max(0, Math.round(Number(s && s.health) || 0)); }
function foodOf(s) { return Math.max(0, Math.round(Number(s && s.food) || 0)); }
function died(snap, deaths0) {
  const d = snap && snap.stats && Number(snap.stats.deaths);
  return Number.isFinite(d) && d > deaths0;
}
// насколько большой перепад вниз ещё переживём: урон падения = перепад - 3, запас 2 HP
function safeDrop(hp) { return Math.max(3, Math.min(16, hp + 1)); }

// ---- survey -> сетка клеток: имя блока | 'air' | '?' (не видно) ----
function gridOf(sv) {
  const legend = sv.legend || {};
  return (x, y, z) => {
    const rows = sv.layers['y=' + y];
    if (!rows) return '?';
    const row = rows[z - sv.origin.z];
    if (row == null) return '?';
    const ch = row[x - sv.origin.x];
    if (ch == null) return '?';
    if (ch === '.') return 'air';
    if (ch === '?') return '?';
    return legend[ch] || ch;
  };
}

// что видно в колонке (x,z): земля / вода / лава / дерево / ничего
function columnInfo(cell, x, z, sv) {
  let groundY = null, waterY = null, lavaY = null, treeY = null;
  for (let y = sv.origin.y + sv.size.y - 1; y >= sv.origin.y; y--) {
    const c = cell(x, y, z);
    if (c === '?' || c === 'air' || c === 'cave_air' || c === 'void_air') continue;
    if (TREE_RE.test(c)) { if (treeY === null) treeY = y; continue; }
    if (c === 'water') { if (waterY === null) waterY = y; continue; }
    if (c === 'lava') { if (lavaY === null) lavaY = y; continue; }
    if (groundY === null) groundY = y;
  }
  const walkY = groundY != null ? groundY : waterY;
  return { groundY, walkY, waterY, lavaY, treeY, kind: lavaY != null && walkY === lavaY ? 'lava' : (waterY != null && walkY === waterY ? 'water' : 'ground') };
}

// профиль поверхности вдоль участка: максимальный перепад вниз, лава, неизвестность
function profile(cell, from, to, sv) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = -uz, pz = ux;
  const n = Math.max(1, Math.round(len));
  let prev = null, maxDrop = 0, dropAt = null, unknown = false, lava = false, water = false, canopy = false;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(from.x + dx * t), cz = Math.round(from.z + dz * t);
    const center = columnInfo(cell, cx, cz, sv);
    if (center.kind === 'lava') lava = true;
    if (center.kind === 'water') water = true;
    let low = null;
    for (const b of [0, 1, -1]) {
      const col = b === 0 ? center : columnInfo(cell, Math.round(cx + px * b), Math.round(cz + pz * b), sv);
      if (col.kind === 'lava') lava = true;
      if (col.walkY != null) low = low == null ? col.walkY : Math.min(low, col.walkY);
      if (col.treeY != null) canopy = true;
    }
    if (center.groundY == null && center.waterY == null) {
      if (center.treeY != null) { canopy = true; continue; } // земля под кроной не видна — высоту пропускаем
      unknown = true;
      continue;
    }
    const here = center.walkY;
    if (prev != null && low != null) {
      const drop = prev - low;
      if (drop > maxDrop) { maxDrop = drop; dropAt = [cx, cz]; }
    }
    prev = here;
  }
  return { maxDrop, dropAt, unknown, lava, water, canopy };
}

// ---- проверка участка пути: можно ли по нему идти ----
async function checkSegment(api, snap, from, to, hp) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;

  // 1) локальная проверка из снимка: обрыв в 1-2 м по направлению шага, лава рядом
  const hz = (((snap.eyes && snap.eyes.hazards) || [])).join(' ');
  const travel = [];
  if (Math.abs(ux) >= 0.34) travel.push(ux > 0 ? 'В' : 'З');
  if (Math.abs(uz) >= 0.34) travel.push(uz > 0 ? 'Ю' : 'С');
  const cliff = /обрыв\s+([СЮЗВ]+)/.exec(hz);
  if (cliff) {
    const hit = cliff[1].split('').filter(d => travel.includes(d));
    if (hit.length) return { safe: false, reason: `обрыв ${hit.join(',')} в 1-2 м (шаг ${travel.join('') || '—'})`, drop: 0 };
  }
  if (/лава/.test(hz)) return { safe: false, reason: 'лава рядом', drop: 0 };

  // 2) survey коридора: земля, обрывы, лава на всём участке
  const w = 3;
  const px = -uz, pz = ux;
  const corners = [];
  for (const s of [-2, len + 3]) for (const t of [-w, w]) corners.push({ x: from.x + ux * s + px * t, z: from.z + uz * s + pz * t });
  const xs = corners.map(c => c.x), zs = corners.map(c => c.z);
  const x1 = Math.floor(Math.min.apply(null, xs)), x2 = Math.floor(Math.max.apply(null, xs));
  const z1 = Math.floor(Math.min.apply(null, zs)), z2 = Math.floor(Math.max.apply(null, zs));
  const cols = (x2 - x1 + 1) * (z2 - z1 + 1);
  let depth = 30;
  while (cols * (depth + 4) > MAX_SURVEY && depth > 8) depth -= 2;
  const y = Math.floor(from.y);
  let sv;
  try {
    sv = await api.cmd('survey', { x1, y1: y - depth, z1, x2, y2: y + 3, z2 });
  } catch (e) {
    return { safe: false, reason: 'survey не удался: ' + clean(e.message), drop: 0 };
  }
  if (!sv || !sv.layers) return { safe: false, reason: 'survey без слоёв', drop: 0 };
  const prof = profile(gridOf(sv), from, to, sv);
  const allow = safeDrop(hp);
  if (prof.lava) return { safe: false, reason: 'лава на пути', drop: prof.maxDrop };
  if (prof.unknown) return { safe: false, reason: 'под ногами не видно (возможен обрыв)', drop: prof.maxDrop };
  if (prof.maxDrop > allow) return { safe: false, reason: `обрыв ${prof.maxDrop} м (предел ${allow} м) у ${prof.dropAt}`, drop: prof.maxDrop };
  return { safe: true, drop: prof.maxDrop, water: prof.water, canopy: prof.canopy };
}

// ---- поход к лесу участками ----
async function travel(api, target, o) {
  let detour = 0;
  for (let iter = 0; iter < 60; iter++) {
    if (Date.now() - o.t0 > o.maxSec * 1000) return { ok: false, reason: `время вышло (${o.maxSec} с) — до леса не дошла` };
    const snap = await api.snapshot();
    if (died(snap, o.deaths0)) return { ok: false, reason: 'смерть по дороге к лесу' };
    const p = snap.position;
    const hp = hpOf(snap);
    if (hp < o.minHp) return { ok: false, reason: `мало HP по дороге (${hp}/20) — поход отменён` };
    const d = d2(p, target);
    if (d <= o.arrive) return { ok: true, at: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], steps: iter };
    const ux = (target.x - p.x) / d, uz = (target.z - p.z) / d;
    const px = -uz, pz = ux;
    const len = Math.min(o.step, d);
    const shrink = Math.min(1, d / 24);
    const cands = [];
    for (const off of [detour, detour + 8, detour - 8, detour + 16, detour - 16, 0]) {
      const c = Math.max(-24, Math.min(24, off));
      if (cands.indexOf(c) < 0) cands.push(c);
    }
    let moved = false;
    const why = [];
    for (const off of cands) {
      const offEff = off * shrink;
      const wx = Math.round(p.x + ux * len + px * offEff);
      const wz = Math.round(p.z + uz * len + pz * offEff);
      const chk = await checkSegment(api, snap, p, { x: wx, z: wz }, hp);
      if (!chk.safe) { why.push(chk.reason); continue; }
      try {
        await api.cmd('goto', { x: wx, z: wz, timeout: 45 });
        detour = off;
        moved = true;
        api.log(`шаг ${iter + 1}: → ${wx} ${wz} (${Math.round(d2({ x: wx, z: wz }, target))} м до леса, перепад ${chk.drop} м, HP ${hp})`);
        break;
      } catch (e) {
        if (isDeath(e.message)) return { ok: false, reason: 'смерть: ' + clean(e.message) };
        why.push('goto: ' + clean(e.message));
        if (/занят/.test(clean(e.message))) await api.sleep(2000);
      }
    }
    if (!moved) return { ok: false, reason: `не пройти к лесу ${target.x} ${target.z}: ${why.slice(0, 3).join('; ')}` };
  }
  return { ok: false, reason: 'не дошла за 60 участков' };
}

// ---- сбор рядом с точкой леса: малый радиус, короткие подходы ----
async function collectNear(api, target, want, o) {
  const spots = [
    { dx: 0, dz: 0 }, { dx: 6, dz: 0 }, { dx: 0, dz: 6 }, { dx: -6, dz: 0 }, { dx: 0, dz: -6 },
    { dx: 6, dz: 6 }, { dx: -6, dz: 6 }, { dx: 6, dz: -6 }, { dx: -6, dz: -6 }
  ];
  let got = await api.count(/_log$/);
  let calls = 0;
  for (const s of spots) {
    if (got >= want) break;
    const spot = { x: target.x + s.dx, z: target.z + s.dz };
    const snap = await api.snapshot();
    if (died(snap, o.deaths0)) return { ok: false, reason: 'смерть при сборе', got };
    const hp = hpOf(snap);
    if (hp < o.minHp) return { ok: false, reason: `мало HP при сборе (${hp}/20) — сбор остановлен`, got };
    if (d2(snap.position, spot) > 4) {
      const chk = await checkSegment(api, snap, snap.position, spot, hp);
      if (!chk.safe) { api.log(`к ${spot.x} ${spot.z} не иду: ${chk.reason}`); continue; }
      try { await api.cmd('goto', { x: spot.x, z: spot.z, timeout: 40 }); }
      catch (e) {
        if (isDeath(e.message)) return { ok: false, reason: 'смерть: ' + clean(e.message), got };
        api.log(`подход к ${spot.x} ${spot.z} не удался: ${clean(e.message)}`);
        continue;
      }
    }
    calls++;
    try {
      const res = await api.cmd('collect', { block: 'log', count: Math.min(12, want - got), radius: o.radius });
      api.log('collect: ' + JSON.stringify(res || {}).slice(0, 120));
    } catch (e) {
      if (isDeath(e.message)) return { ok: false, reason: 'смерть при сборе: ' + clean(e.message), got };
      api.log('collect не удался: ' + clean(e.message));
    }
    got = await api.count(/_log$/);
    api.log(`брёвна: ${got}/${want}`);
    if (got < want && calls < 3) {
      // короткий осмотр рядом (не широкий поиск по склону)
      try { await api.cmd('explore', { distance: 12 }); } catch (e) { if (isDeath(e.message)) return { ok: false, reason: 'смерть при осмотре: ' + clean(e.message), got }; }
      got = await api.count(/_log$/);
      api.log(`после осмотра брёвна: ${got}/${want}`);
    }
  }
  return { ok: got >= want, got, calls };
}

module.exports = {
  name: 'gather_wood',
  description: 'Сходить в лес за брёвнами: сначала проверка HP/еды (на низком HP не идёт), дорога участками с проверкой перепада высот (обрыв не перешагиваем, обход вбок), сбор рядом с точкой леса малым радиусом; смерть или потеря HP — сразу стоп с причиной.',
  params: {
    count: 'сколько брёвен, по умолчанию 8',
    x: 'x точки леса, по умолчанию -472',
    y: 'y точки леса, по умолчанию 69',
    z: 'z точки леса, по умолчанию 37',
    step: 'длина участка пути, м (4..16), по умолчанию 10',
    radius: 'радиус сбора вокруг текущей точки, м (8..24), по умолчанию 12',
    min_hp: 'минимальный HP для похода, по умолчанию 3 (ниже — отказ «мало HP/нет еды»)',
    min_food: 'минимальная еда для регена, по умолчанию 18',
    wait_regen: 'ждать регена до N с при низком HP, по умолчанию 45 (0 — не ждать)',
    arrive: 'лес считается достигнутым в N м, по умолчанию 6',
    max_sec: 'потолок времени навыка, по умолчанию 240'
  },
  async run(api, params) {
    const t0 = Date.now();
    const want = Math.max(1, Math.min(64, Math.round(num(params.count, 8))));
    const target = { x: num(params.x, FOREST.x), y: num(params.y, FOREST.y), z: num(params.z, FOREST.z) };
    const o = {
      step: Math.max(4, Math.min(16, num(params.step, 10))),
      radius: Math.max(8, Math.min(24, num(params.radius, 12))),
      minHp: Math.max(1, num(params.min_hp, 3)),
      minFood: Math.max(0, num(params.min_food, 18)),
      waitRegen: Math.max(0, num(params.wait_regen, 45)),
      arrive: Math.max(2, num(params.arrive, 6)),
      maxSec: Math.max(60, num(params.max_sec, 240)),
      t0, deaths0: 0
    };

    const start = await api.count(/_log$/);
    if (start >= want) return { ok: true, collected: start, gained: 0, note: 'брёвна уже есть' };

    let snap = await api.snapshot();
    o.deaths0 = (snap.stats && Number(snap.stats.deaths)) || 0;
    let hp = hpOf(snap), food = foodOf(snap);
    const dist = Math.round(d2(snap.position, target));
    api.log(`лес ${target.x} ${target.y} ${target.z}: ${dist} м, HP ${hp}/20, еда ${food}/20, брёвен ${start}/${want}`);

    // 1) HP/еда до похода
    if (hp < o.minHp) {
      const sat = snap.danger && snap.danger.hunger && Number(snap.danger.hunger.saturation);
      const canRegen = food >= o.minFood && (sat == null || sat > 0);
      const hp0 = hp;
      if (canRegen && o.waitRegen > 0) {
        const end = Date.now() + o.waitRegen * 1000;
        while (Date.now() < end && hp < o.minHp) {
          await api.sleep(5000);
          const s2 = await api.snapshot();
          hp = hpOf(s2); food = foodOf(s2);
          if (died(s2, o.deaths0)) return { ok: false, error: 'мало HP/нет еды — сначала еда', note: 'смерть во время ожидания регена' };
        }
        if (hp >= o.minHp) api.log(`подождал регена: HP ${hp0} → ${hp}`);
        else api.log(`регена не было: HP ${hp0} → ${hp} за ${o.waitRegen} с`);
      }
      if (hp < o.minHp) {
        api.log(`не иду: HP ${hp}/20 (нужно ≥ ${o.minHp}), еда ${food}/20`);
        return { ok: false, error: 'мало HP/нет еды — сначала еда', hp, food, dist };
      }
    }
    if (hp < 20 && food < o.minFood && dist > 60) {
      api.log(`не иду: еды ${food}/20 — регена нет, а дорога ${dist} м`);
      return { ok: false, error: 'мало HP/нет еды — сначала еда', hp, food, dist };
    }

    // 2) поход
    const trip = await travel(api, target, o);
    if (!trip.ok) {
      api.log('поход не удался: ' + trip.reason);
      return { ok: false, error: trip.reason, hp, food, dist, steps: trip.steps || 0 };
    }
    api.log(`лес достигнут: ${trip.at.join(' ')}`);

    // 3) сбор
    const res = await collectNear(api, target, want, o);
    if (!res.ok) {
      const got = res.got;
      api.log(`сбор не закончен: ${res.reason || 'мало брёвен'}`);
      return { ok: false, error: res.reason || `в лесу брёвен мало (${got}/${want}) — смени точку леса`, collected: got, gained: got - start, hp };
    }
    return { ok: true, collected: res.got, gained: res.got - start, at: trip.at, calls: res.calls, sec: Math.round((Date.now() - t0) / 1000) };
  }
};
