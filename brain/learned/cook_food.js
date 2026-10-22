// версия: была текущей на 22.10; как v3, но к краю ближе 4 м не идёт, перебирает 5 направлений, goto 20 с
// cook_food — довести запас готовой еды до min: пожарить сырое мясо (smelt), нет мяса — охота (hunt), потом жарка.
// Готовая еда = cooked_*, хлеб, печёная картошка, морковь, яблоки, ягоды и т.п. (то, что можно есть без плавки).
// Итог всегда содержит ready (сколько готовой еды) — даже при ok:false. Не ест сама.
//
// Правка по заявке учителя brain/skill_requests/cook_food.md (случай 20261022-040632-39, урок L030):
//  1) вторая охота — только после смены места (шаг в безопасную сторону): из той же точки второй раз не охотимся;
//  2) разведка короткая (16 м) и не к краю: край смотрим через survey.edges/heightmap, рядом с краем ищем в пределах нескольких метров;
//  3) отказ — с причиной, подсказкой, где искали и сколько было попыток (урок L002: тот же вызов не повторять).
const RAW = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
const READY = /^(cooked_|bread$|baked_potato$|carrot$|apple$|golden_carrot$|golden_apple$|melon_slice$|sweet_berries$|glow_berries$|pumpkin_pie$|cookie$|mushroom_stew$|rabbit_stew$|beetroot_soup$|dried_kelp$|beetroot$)/;
const FUEL = /^(coal|charcoal|coal_block|blaze_rod)$|_planks$|_(log|stem)$/;
const ANIMAL_RE = /cow|pig|sheep|chicken|rabbit|mooshroom|goat/;
const EDGE_SCAN = 8;      // радиус просмотра края вокруг мухи, м
const HUNT_GAP = 6;       // минимум метров между точками охот (иначе это «та же точка»)
const MAX_HUNTS = 3;      // сколько охот за прогон
const MAX_RELOC = 3;      // сколько раз меняем место
const EXPLORE_DIST = 16;  // разведка короткая (не 40 м)
const MAX_DROP = 3;       // перепад вниз, который перешагиваем
const MAX_UP = 2;         // перепад вверх, который перешагиваем
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const readyOf = m => Object.keys(m).filter(n => READY.test(n)).reduce((s, n) => s + m[n], 0);
const hasFuel = m => Object.keys(m).some(n => FUEL.test(n) && m[n] > 0);
const clean = e => String((e && e.message) || e || '').replace(/^навык тела "[^"]+" не удался: /, '').trim();
const d2 = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.z || 0) - (b.z || 0));
const fmtPos = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;

// стороны света: С = -z, В = +x (как в теле)
const DIRS8 = [
  { n: 'С', dx: 0, dz: -1 }, { n: 'СВ', dx: Math.SQRT1_2, dz: -Math.SQRT1_2 },
  { n: 'В', dx: 1, dz: 0 }, { n: 'ЮВ', dx: Math.SQRT1_2, dz: Math.SQRT1_2 },
  { n: 'Ю', dx: 0, dz: 1 }, { n: 'ЮЗ', dx: -Math.SQRT1_2, dz: Math.SQRT1_2 },
  { n: 'З', dx: -1, dz: 0 }, { n: 'СЗ', dx: -Math.SQRT1_2, dz: -Math.SQRT1_2 }
];
const dir8 = (from, to) => {
  const dx = to.x - from.x, dz = to.z - from.z;
  if (Math.abs(dx) < 1.5 && Math.abs(dz) < 1.5) return 'тут';
  const ang = Math.atan2(dx, -dz);
  const i = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS8[i].n;
};

// ---- survey -> сетка высот: y верхнего твёрдого блока в колонке, null = нет твёрдого в объёме ----
function heightAt(sv, x, z) {
  const hm = sv && sv.heightmap; if (!hm) return undefined;
  const dx = Math.floor(x) - sv.origin.x, dz = Math.floor(z) - sv.origin.z;
  if (dx < 0 || dz < 0 || dx >= sv.size.x || dz >= sv.size.z) return undefined;
  return hm[dz][dx];
}

// путь по поверхности: перепад вниз/вверх между соседними колонками
function pathOk(sv, from, to) {
  const n = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.z - from.z)));
  let prev = heightAt(sv, from.x, from.z);
  if (prev === undefined) return { ok: false, why: 'своя клетка не видна' };
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(from.x + (to.x - from.x) * t);
    const cz = Math.round(from.z + (to.z - from.z) * t);
    const h = heightAt(sv, cx, cz);
    if (h === undefined) return { ok: false, why: `край обзора (${cx} ${cz})` };
    if (h === null) return { ok: false, why: `под ногами не видно (${cx} ${cz}) — возможен обрыв` };
    if (prev !== null) {
      const drop = prev - h;
      if (drop > MAX_DROP) return { ok: false, why: `обрыв ${drop} м у ${cx} ${cz}` };
      if (-drop > MAX_UP) return { ok: false, why: `подъём ${-drop} м у ${cx} ${cz}` };
    }
    prev = h;
  }
  return { ok: true, why: 'ровно' };
}

// ---- куда сдвинуться: край рядом — короткий шаг в сторону, где края нет ----
function planStep(sv, pos, step) {
  const near = [];
  for (const e of (sv.edges || [])) {
    const dx = e.x - pos.x, dz = e.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= EDGE_SCAN) near.push({ d, ux: d ? dx / d : 0, uz: d ? dz / d : 0, drop: e.drop });
  }
  const cand = DIRS8.map(dir => {
    let clr = Infinity;
    for (const n of near) {
      const align = n.ux * dir.dx + n.uz * dir.dz;   // край в этом направлении?
      if (align > 0.35) clr = Math.min(clr, n.d);
    }
    return { dir, clr };
  }).sort((a, b) => b.clr - a.clr);
  const out = [];
  for (const c of cand.slice(0, 5)) {
    if (c.clr !== Infinity && c.clr - 1 < 4) { out.push({ name: c.dir.n, ok: false, why: `край ${c.clr} м в сторону ${c.dir.n} — туда не идём` }); continue; }
    const dist = c.clr === Infinity ? step : Math.min(step, c.clr - 1);
    const tx = Math.round(pos.x + c.dir.dx * dist);
    const tz = Math.round(pos.z + c.dir.dz * dist);
    const chk = pathOk(sv, pos, { x: tx, z: tz });
    const clrTxt = c.clr === Infinity ? 'края рядом нет' : `край ${c.clr} м в сторону ${c.dir.n}`;
    out.push({ name: c.dir.n, x: tx, z: tz, ok: chk.ok, why: chk.ok ? clrTxt : chk.why });
  }
  return out;
}

// ---- шаг к цели: тело «goto», занят навыком — подождать и повторить ----
async function tryGoto(api, x, z, timeout) {
  for (let i = 0; i < 2; i++) {
    try { await api.cmd('goto', { x, z, timeout }); return { ok: true }; }
    catch (e) {
      const msg = clean(e);
      if (/занят/.test(msg) && i === 0) { await api.sleep(2000); continue; }
      return { ok: false, err: msg };
    }
  }
  return { ok: false, err: 'занят навыком' };
}

// ---- смена места: короткий шаг в безопасную сторону (край смотрим через survey) ----
async function relocate(api, snap, st, step) {
  const pos = snap.position;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  let sv = null, svErr = '';
  try {
    sv = await api.cmd('survey', { x1: fx - EDGE_SCAN, y1: fy - 6, z1: fz - EDGE_SCAN, x2: fx + EDGE_SCAN, y2: fy + 3, z2: fz + EDGE_SCAN });
  } catch (e) { svErr = clean(e); }
  if (!sv || !sv.heightmap) {
    // край не виден — по снимку: обрыв прямо рядом?
    const hz = (((snap.eyes && snap.eyes.hazards) || [])).join(' ');
    const m = /обрыв\s+([СЮЗВ,]+)/.exec(hz);
    if (m) {
      const bad = m[1].split('').filter(c => 'СЮЗВ'.indexOf(c) >= 0);
      const away = DIRS8.find(d => !bad.includes(d.n)) || { n: 'Ю', dx: 0, dz: 1 };
      const tx = Math.round(pos.x + away.dx * 6), tz = Math.round(pos.z + away.dz * 6);
      const g = await tryGoto(api, tx, tz, 20);
      if (g.ok) {
        const s2 = await api.snapshot();
        if (d2(s2.position, pos) >= 4) {
          const dy = fy - Math.floor(s2.position.y);
          const fell = dy >= 8;
          st.searched.push({ at: fmtPos(s2.position), side: away.n, how: 'смена места', result: `обрыв рядом, шаг в сторону ${away.n}, y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)}` });
          if (fell) st.fell = true;
          return { moved: true, snap: s2, side: away.n, at: fmtPos(s2.position), fell, dy };
        }
      }
    }
    return { moved: false, why: 'край не виден (survey: ' + (svErr || 'без высот') + ') — вслепую не иду' };
  }
  const plan = planStep(sv, pos, step);
  const why = [];
  for (const c of plan) {
    if (!c.ok) { why.push(`${c.name}: ${c.why}`); continue; }
    const g = await tryGoto(api, c.x, c.z, 20);
    if (!g.ok) { why.push(`${c.name}: ${g.err}`); continue; }
    const s2 = await api.snapshot();
    const moved = d2(s2.position, pos);
    if (moved < 4) { why.push(`${c.name}: не сдвинулись`); continue; }
    const dy = fy - Math.floor(s2.position.y);
    const fell = dy >= 8;
    st.searched.push({ at: fmtPos(s2.position), side: c.name, how: 'смена места', result: `сдвиг ${Math.round(moved)} м, y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)}` + (fell ? ', упали вниз' : '') });
    api.log(`cook_food: смена места ${c.name} → ${fmtPos(s2.position)} (${Math.round(moved)} м; ${c.why}; y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)})`);
    if (fell) { st.fell = true; api.log(`cook_food: упали на ${dy} м вниз — дальше вниз не иду`); }
    return { moved: true, snap: s2, side: c.name, at: fmtPos(s2.position), fell, dy };
  }
  // шаг не получился — короткая разведка, только если рядом нет края (край в EDGE_SCAN м — разведку не делаем)
  const nearEdge = (sv.edges || []).some(e => Math.hypot(e.x - pos.x, e.z - pos.z) <= EDGE_SCAN);
  if (!nearEdge) {
    try {
      const r = await api.cmd('explore', { distance: EXPLORE_DIST });
      const s2 = await api.snapshot();
      const moved = d2(s2.position, pos);
      if (moved >= 4) {
        const dy = fy - Math.floor(s2.position.y);
        const fell = dy >= 8;
        st.searched.push({ at: fmtPos(s2.position), side: (r && r.dir) || '?', how: 'разведка', result: `сдвиг ${Math.round(moved)} м, y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)}` });
        api.log(`cook_food: разведка ${EXPLORE_DIST} м → ${fmtPos(s2.position)} (${(r && r.dir) || '?'}; y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)})`);
        if (fell) { st.fell = true; api.log(`cook_food: разведка ушла вниз на ${dy} м — дальше вниз не иду`); }
        return { moved: true, snap: s2, side: (r && r.dir) || '?', at: fmtPos(s2.position), fell, dy };
      }
    } catch (e) { why.push('разведка: ' + clean(e)); }
  } else why.push(`край в ${EDGE_SCAN} м — разведку не делаю`);
  return { moved: false, why: 'сменить место не вышло: ' + (why.slice(0, 2).join('; ') || 'некуда') };
}

// ---- подсказка мозгу: что делать дальше (урок L001/L002) ----
function makeHint(st, stopWhy) {
  if (/жарка/.test(stopWhy || '')) return 'нужна печь и топливо (craft furnace / collect coal) — мясо есть, но пожарить нечем; тот же вызов не повторять';
  if (st.fell) return 'подняться наверх (climb_up) или вернуться к базе (home_path) — вниз больше не идти; тот же вызов не повторять';
  if (!st.sawAnimals) return 'животных не видно ни разу — искать в другую сторону (выбрать сторону самому) или подняться наверх (climb_up); тот же вызов не повторять';
  if (st.hunts >= 2) return `охота без мяса в ${st.hunts} местах — дальше искать в стороне от базы (выбрать сторону) или добыть еду иначе; тот же вызов не повторять`;
  return 'смени точку/сторону и повтори; тот же вызов не повторять';
}

module.exports = {
  name: 'cook_food',
  description: 'Доводит запас готовой еды до min: жарит сырое мясо в печи; мяса нет — охотится (hunt) и жарит. Вторая охота — только после смены места (шаг в безопасную сторону, край смотрит через survey), разведка короткая (16 м) и не к обрыву. Возвращает ready, cooked, hunted, searched (где искали), attempts. Нужно топливо (уголь/доски/бревна).',
  params: {
    min: 'сколько готовой еды нужно, по умолчанию 8',
    dry: '1 — только посчитать (ready, сырого мяса, топливо)',
    hunt_radius: 'радиус поиска животных при охоте, м (16..64), по умолчанию 48',
    step: 'длина смены места, м (4..24), по умолчанию 12',
    max_sec: 'потолок по времени, по умолчанию 420'
  },
  async run(api, params) {
    params = params || {};
    const min = Math.max(1, Math.floor(Number(params.min)) || 8);
    const huntRadius = Math.max(16, Math.min(64, Number(params.hunt_radius) || 48));
    const step = Math.max(4, Math.min(24, Number(params.step) || 12));
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 420) * 1000;
    let snap = await api.snapshot();
    let m = invMap(snap.inventory);
    const ready0 = readyOf(m);
    const rawCount = mm => RAW.reduce((s, n) => s + (mm[n] || 0), 0);
    if (truthy(params.dry)) return { ok: true, dry: true, ready: ready0, min, raw: rawCount(m), fuel: hasFuel(m), needToCook: Math.max(0, min - ready0) };
    if (ready0 >= min) return { ok: true, ready: ready0, min, cooked: 0, hunted: 0, note: 'готовой еды уже достаточно' };

    // без топлива жарить нечего — не гоняем животных зря
    if (!hasFuel(m)) return { ok: false, error: 'нет топлива для печи (coal/charcoal/доски/бревна) — жарить нечем', missing: { fuel: 'coal/charcoal/planks/logs' }, ready: ready0, min, cooked: 0, hunted: 0, hint: 'сначала добудь топливо (gather_wood / collect coal), потом повтори cook_food' };

    const start = { x: snap.position.x, y: snap.position.y, z: snap.position.z };
    const st = { cooked: 0, hunted: 0, kills: 0, hunts: 0, relocations: 0, fell: false, sawAnimals: false, lastHuntAt: null, searched: [], errors: [] };
    const errors = st.errors;
    let stopWhy = '';

    for (let pass = 0; pass < 10 && Date.now() < deadline; pass++) {
      m = invMap(snap.inventory);
      const need = min - readyOf(m);
      if (need <= 0) break;

      // 1. жарка того, что есть (чего больше — первым)
      const raws = RAW.filter(n => m[n] > 0).sort((a, b) => m[b] - m[a]);
      if (raws.length) {
        let progressed = false;
        for (const r of raws) {
          const left = min - readyOf(invMap((snap = await api.snapshot()).inventory));
          if (left <= 0 || Date.now() > deadline) break;
          const cnt = Math.min(invMap(snap.inventory)[r], left);
          try {
            const res = await api.cmd('smelt', { item: r, count: cnt });
            st.cooked += (res && Number(res.made)) || cnt; progressed = true;
            api.log(`cook_food: пожарила ${r} x${cnt}`);
          } catch (e) { errors.push(`${r}: ${clean(e)}`); api.log(`cook_food: smelt ${r}: ${e.message}`); }
        }
        snap = await api.snapshot();
        if (!progressed) { stopWhy = 'жарка не идёт (нет печи/топлива) — охота мяса не спасёт'; break; }
        continue;
      }

      // 2. мяса нет — охота. Правило: из той же точки второй раз не охотимся (урок L030/L002)
      if (st.hunts >= MAX_HUNTS) { stopWhy = `охота кончилась: ${st.hunts} попыток в разных местах`; break; }
      if (st.lastHuntAt && d2(snap.position, st.lastHuntAt) < HUNT_GAP) {
        api.log(`cook_food: охота из той же точки (${fmtPos(st.lastHuntAt)}) — сначала меняю место`);
        if (st.relocations >= MAX_RELOC) { stopWhy = 'сменить место больше некуда — охота в тех же местах бессмысленна'; break; }
        st.relocations++;
        const rel = await relocate(api, snap, st, step);
        if (!rel.moved) { stopWhy = 'сменить место не вышло: ' + rel.why; break; }
        snap = rel.snap || await api.snapshot();
        st.lastHuntAt = null;   // место сменилось — охотаемся отсюда
        if (rel.fell) { stopWhy = `смена места свалила вниз (${rel.dy} м) — вниз больше не идём`; break; }
        continue;
      }

      // 3. охота (животных видно или нет — ищем сами в радиусе hunt_radius)
      const animals = ((snap.eyes && snap.eyes.animals) || []).filter(a => ANIMAL_RE.test(a.name));
      if (animals.length) st.sawAnimals = true;
      st.hunts++;
      const huntAt = { x: snap.position.x, y: snap.position.y, z: snap.position.z };
      st.lastHuntAt = huntAt;
      const side = dir8(start, huntAt);
      try {
        const res = await api.cmd('hunt', { count: Math.min(6, Math.max(1, Math.ceil(need / 2))), radius: huntRadius });
        const k = (res && Number(res.kills)) || 0;
        st.hunted++; st.kills += k;
        st.searched.push({ at: fmtPos(huntAt), side, how: 'hunt', result: k ? `убито ${k}` : 'нет' });
        api.log(`cook_food: hunt (попытка ${st.hunts}) в точке ${fmtPos(huntAt)} (${side}): убито ${k}`);
      } catch (e) {
        const why = clean(e);
        errors.push('hunt: ' + why);
        st.searched.push({ at: fmtPos(huntAt), side, how: 'hunt', result: 'нет: ' + why });
        api.log(`cook_food: hunt (попытка ${st.hunts}) в точке ${fmtPos(huntAt)} (${side}) — ${why}`);
      }
      snap = await api.snapshot();
      if (readyOf(invMap(snap.inventory)) >= min) break;
    }

    m = invMap((snap = await api.snapshot()).inventory);
    const ready = readyOf(m);
    const last = st.searched[st.searched.length - 1];
    const lastSide = last ? last.side : dir8(start, snap.position);
    const lastSpot = last ? last.at : fmtPos(snap.position);
    const attempts = { hunt: st.hunts, relocate: st.relocations };
    const out = {
      ready, min, cooked: st.cooked, hunted: st.hunted, kills: st.kills, rawLeft: rawCount(m),
      searched: st.searched.slice(-6), attempts, lastSpot, lastSide,
      ...(errors.length ? { errors: errors.slice(0, 4) } : {})
    };
    if (ready >= min) return { ok: true, ...out, hint: 'готово' };

    const reason = errors.length
      ? errors[errors.length - 1].replace(/:\s*/, ' — ')
      : (stopWhy || 'мяса нет');
    const hint = makeHint(st, stopWhy);
    return {
      ok: false, ...out, missing: { food: min - ready },
      error: `готовой еды ${ready} из ${min}: ${reason}; искали ${attempts.hunt} раз (попыток охоты), смен места ${attempts.relocate}, последняя точка ${lastSpot} (${lastSide}); ${hint}`,
      hint, why: stopWhy || undefined
    };
  }
};
