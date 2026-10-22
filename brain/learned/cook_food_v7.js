// версия: из истории 20261022072026-703; отличие: см. код, не описано
// cook_food — довести запас готовой еды до min: пожарить сырое мясо (smelt), нет мяса — охота (hunt), потом жарка.
// Готовая еда = cooked_*, хлеб, печёная картошка, морковь, яблоки, ягоды и т.п. Итог всегда содержит ready. Не ест сама.
//
// Новый вариант «охота у леса»:
//  1) первая охота — обычная, рядом с текущей точкой; пусто → сама идёт к известному месту с дичью;
//  2) дорога — перебежками по step м с survey перед каждой (обрыв перешагиваем ≤3 м вниз, ≤2 м вверх),
//     не ночью (ночь — сразу стоп с адресом) и при HP ниже min_hp (стоп с адресом);
//  3) на месте 1–2 охоты (между ними короткая безопасная смена точки); и у леса пусто —
//     честный отказ «дичи нет и здесь: <место> <адрес>», без «смен мест» и без «выбрать сторону самому»;
//  4) в пещере/под землёй (крыша над головой не из листвы/брёвен) — отказ сразу, без спуска и без охоты.
const RAW = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
const READY = /^(cooked_|bread$|baked_potato$|carrot$|apple$|golden_carrot$|golden_apple$|melon_slice$|sweet_berries$|glow_berries$|pumpkin_pie$|cookie$|mushroom_stew$|rabbit_stew$|beetroot_soup$|dried_kelp$|beetroot$)/;
const FUEL = /^(coal|charcoal|coal_block|blaze_rod)$|_planks$|_(log|stem)$/;
const ANIMAL_RE = /cow|pig|sheep|chicken|rabbit|mooshroom|goat/;
const TREEISH = /leaves|(_log|_stem|_wood)$/;
const PLACE = { name: 'лес', x: -352, y: 66, z: 74 }; // лес -352 66 74 (notes.md: «Лес, 57 м ЮВ от базы»)
const ARRIVE = 16;        // считать «дошла до места», м (hunt сам достанет в радиусе)
const MAX_HOPS = 40;      // перебежек за прогон
const MAX_LOCAL_HUNTS = 1; // охот рядом со стартом (пусто — уходим к месту)
const MAX_PLACE_RELOC = 1; // смен точки на месте охоты
const MAX_HUNTS = 4;      // всего охот за прогон
const HUNT_GAP = 6;       // минимум метров между точками охот
const MAX_DROP = 3;       // перепад вниз, который перешагиваем
const MAX_UP = 2;         // перепад вверх, который перешагиваем
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const readyOf = m => Object.keys(m).filter(n => READY.test(n)).reduce((s, n) => s + m[n], 0);
const hasFuel = m => Object.keys(m).some(n => FUEL.test(n) && m[n] > 0);
const clean = e => String((e && e.message) || e || '').replace(/^навык тела "[^"]+" не удался: /, '').trim();
const d2 = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.z || 0) - (b.z || 0));
const fmtPos = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
const addr = (name, at) => `${name} (${at})`;
const seenAnimals = snap => ((snap.eyes && snap.eyes.animals) || []).some(a => ANIMAL_RE.test(a.name));
const isNight = snap => ((snap.eyes && snap.eyes.time) || {}).phase === 'ночь';
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 160);

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
  return DIRS8[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8].n;
};

// ---- survey -> сетка высот ----
function heightAt(sv, x, z) {
  const hm = sv && sv.heightmap; if (!hm) return undefined;
  const dx = Math.floor(x) - sv.origin.x, dz = Math.floor(z) - sv.origin.z;
  if (dx < 0 || dz < 0 || dx >= sv.size.x || dz >= sv.size.z) return undefined;
  return hm[dz][dx];
}

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

// ---- под землёй / под крышей: крыша над головой в 5×5, материал смотрим по legend (листва/брёвна — «под деревьями», охоте не мешает) ----
async function coverCheck(api, snap) {
  const p = snap.position, fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  let sv = null;
  try { sv = await api.cmd('survey', { x1: fx - 2, y1: fy + 1, z1: fz - 2, x2: fx + 2, y2: fy + 7, z2: fz + 2 }); } catch (e) {}
  if (sv && sv.heightmap) {
    let roofs = 0, other = 0;
    for (let dz = 0; dz < sv.size.z; dz++) for (let dx = 0; dx < sv.size.x; dx++) {
      const top = sv.heightmap[dz][dx];
      if (top == null || top <= fy) continue;
      roofs++;
      const row = sv.layers['y=' + top] && sv.layers['y=' + top][dz];
      const name = row ? (sv.legend[row[dx]] || '') : '';
      if (!TREEISH.test(name)) other++;
    }
    if (roofs >= 20 && other >= Math.ceil(roofs / 2)) return 'под крышей/потолком';
    return null;
  }
  // высот нет — как в версии по заявке cook_food: по sheltered (крыша & стены)
  const sh = snap.sheltered;
  if (sh && sh.closed) return 'в закрытом укрытии';
  if (sh && sh.roof) return 'под крышей';
  return null;
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

// ---- одна охот-попытка в точке at (запись в журнал места hunts) ----
async function huntOnce(api, st, need, radius, placeName, at, side) {
  const entry = st.places[st.places.length - 1];
  st.hunts++;
  try {
    const res = await api.cmd('hunt', { count: Math.min(6, Math.max(1, Math.ceil(need / 2))), radius });
    const k = (res && Number(res.kills)) || 0;
    st.kills += k;
    if (entry && entry.name === placeName) { entry.hunts++; entry.kills += k; entry.results.push(`${fmtPos(at)}: ${k ? 'убито ' + k : 'нет'}`); }
    api.log(`cook_food: hunt ${st.hunts} у ${placeName} ${fmtPos(at)} (${side}): убито ${k}`);
    return { kills: k };
  } catch (e) {
    const why = clean(e);
    if (entry && entry.name === placeName) { entry.hunts++; entry.results.push(`${fmtPos(at)}: нет (${short(why, 60)})`); }
    api.log(`cook_food: hunt ${st.hunts} у ${placeName} ${fmtPos(at)} (${side}) — ${why}`);
    return { kills: 0, err: why };
  }
}

// ---- смена точки на месте охоты: короткий шаг в безопасную сторону (survey) ----
async function relocate(api, snap, st, step) {
  const pos = snap.position;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  let sv = null;
  try { sv = await api.cmd('survey', { x1: fx - 8, y1: fy - 6, z1: fz - 8, x2: fx + 8, y2: fy + 3, z2: fz + 8 }); } catch (e) {}
  const near = [];
  for (const e of (sv && sv.edges) || []) {
    const d = Math.hypot(e.x - pos.x, e.z - pos.z);
    if (d <= 8) near.push({ d, ux: d ? (e.x - pos.x) / d : 0, uz: d ? (e.z - pos.z) / d : 0 });
  }
  const cand = DIRS8.map(dir => {
    let clr = Infinity;
    for (const n of near) {
      const align = n.ux * dir.dx + n.uz * dir.dz;
      if (align > 0.35) clr = Math.min(clr, n.d);
    }
    return { dir, clr };
  }).sort((a, b) => b.clr - a.clr).slice(0, 5);
  const why = [];
  for (const c of cand) {
    if (c.clr !== Infinity && c.clr - 1 < 4) { why.push(`${c.dir.n}: край ${c.clr} м`); continue; }
    const dist = c.clr === Infinity ? step : Math.min(step, c.clr - 1);
    const tx = Math.round(pos.x + c.dir.dx * dist), tz = Math.round(pos.z + c.dir.dz * dist);
    const chk = sv && sv.heightmap ? pathOk(sv, pos, { x: tx, z: tz }) : { ok: true, why: 'без высот' };
    if (!chk.ok) { why.push(`${c.dir.n}: ${chk.why}`); continue; }
    const g = await tryGoto(api, tx, tz, 20);
    if (!g.ok) { why.push(`${c.dir.n}: ${g.err}`); continue; }
    const s2 = await api.snapshot();
    if (d2(s2.position, pos) < 4) { why.push(`${c.dir.n}: не сдвинулись`); continue; }
    const dy = fy - Math.floor(s2.position.y);
    if (dy >= 8) return { moved: false, why: `${c.dir.n}: шаг свалил на ${dy} м вниз` };
    api.log(`cook_food: сменила точку охоты ${c.dir.n} → ${fmtPos(s2.position)} (${Math.round(d2(s2.position, pos))} м)`);
    return { moved: true, snap: s2 };
  }
  return { moved: false, why: why.slice(0, 2).join('; ') || 'некуда' };
}

module.exports = {
  name: 'cook_food',
  description: 'Доводит запас готовой еды до min: жарит сырое мясо в печи; первая охота — рядом, пусто — сама перебежками (не ночью, HP-контроль) идёт к известному месту с дичью (лес -352 66 74, задать можно place/x/y/z) и охотится оттуда; и там пусто — честный отказ с адресом места. Под крышей/под землёй охота не идёт. Возвращает ready, cooked, killed, places (имя+адрес+охоты), lastSpot. Нужно топливо (уголь/доски/бревна).',
  params: {
    min: 'сколько готовой еды нужно, по умолчанию 8',
    dry: '1 — только посчитать (ready, сырого мяса, топливо)',
    hunt_radius: 'радиус поиска животных при охоте, м (16..64), по умолчанию 48',
    place: 'имя известного места с дичью (для журнала/отказа), по умолчанию «лес»',
    x: 'координата места охоты, по умолчанию -352',
    y: 'высота места (только для адреса), по умолчанию 66',
    z: 'координата места охоты, по умолчанию 74',
    step: 'длина перебежки и смены точки, м (4..24), по умолчанию 14',
    min_hp: 'ниже этого HP идти к месту не буду, по умолчанию 10',
    min_food: 'ниже этого сытости далеко не пойду, по умолчанию 6',
    max_sec: 'потолок по времени, по умолчанию 480'
  },
  async run(api, params) {
    params = params || {};
    const min = Math.max(1, Math.floor(Number(params.min)) || 8);
    const huntRadius = Math.max(16, Math.min(64, Number(params.hunt_radius) || 48));
    const step = Math.max(4, Math.min(24, Number(params.step) || 14));
    const minHp = Math.max(0, Math.min(20, Number(params.min_hp) != null ? Number(params.min_hp) : 10));
    const minFood = Math.max(0, Math.min(20, Number(params.min_food) != null ? Number(params.min_food) : 6));
    const place = {
      name: String(params.place || PLACE.name),
      x: Number(params.x) != null && isFinite(Number(params.x)) ? Math.round(Number(params.x)) : PLACE.x,
      y: Number(params.y) != null && isFinite(Number(params.y)) ? Math.round(Number(params.y)) : PLACE.y,
      z: Number(params.z) != null && isFinite(Number(params.z)) ? Math.round(Number(params.z)) : PLACE.z
    };
    const placeAddr = `${Math.floor(place.x)} ${place.y || '—'} ${Math.floor(place.z)}`;
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 480) * 1000;

    let snap = await api.snapshot();
    const startAt = snap.position;
    const startPos = fmtPos(startAt);
    let m = invMap(snap.inventory);
    const ready0 = readyOf(m);
    const rawCount = mm => RAW.reduce((s, n) => s + (mm[n] || 0), 0);
    const st = { cooked: 0, kills: 0, hunts: 0, wentFar: false, fell: false, places: [], errors: [] };
    const fail = (reason, hint) => {
      const p = st.places[st.places.length - 1];
      const where = p ? addr(p.name, p.at) : posLabel(startAt);
      api.log(`cook_food: отказ — ${short(reason, 120)}; место ${where}`);
      return {
        ok: false, ready: readyOf(m), min, cooked: st.cooked, kills: st.kills, rawLeft: rawCount(m),
        places: st.places.map(e => ({ name: e.name, at: e.at, hunts: e.hunts, kills: e.kills })),
        lastSpot: p ? p.at : startPos, ...(errors0() ? { errors: st.errors.slice(0, 4) } : {}),
        missing: { food: Math.max(0, min - readyOf(m)) },
        error: `готовой еды ${readyOf(m)} из ${min}: ${reason}; охоты: ${
          st.places.map(e => `${e.name} (${e.at}) — ${e.hunts} охот, убито ${e.kills}`).join('; ') || 'не начинались'}; старт ${startPos}; ${hint}`
      };
    };
    const errors0 = () => st.errors.length;
    const posLabel = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;

    if (truthy(params.dry)) return { ok: true, dry: true, ready: ready0, min, raw: rawCount(m), fuel: hasFuel(m), needToCook: Math.max(0, min - ready0) };
    if (ready0 >= min) return { ok: true, ready: ready0, min, cooked: 0, kills: 0, note: 'готовой еды уже достаточно' };
    if (!hasFuel(m)) return { ok: false, error: 'нет топлива для печи (coal/charcoal/доски/бревна) — жарить нечем', missing: { fuel: 'coal/charcoal/planks/logs' }, ready: ready0, min, places: [], hint: 'сначала добудь топливо (gather_wood / collect coal), потом повтори cook_food' };

    // НЕ охота ночью вообще и не охотимся под крышей/под землёй — отказ сразу, без спуска и без дороги
    if (isNight(snap)) return fail('ночь: охота не идёт вообще (ни рядом, ни у леса)', 'пережидать ночь (wait_night или sleep); охота — утром');
    const cover = await coverCheck(api, snap);
    if (cover) return fail(`${cover}: охота не идёт`, 'сначала выбраться на открытое место (goto/explore/climb_up), потом зови cook_food');
    if (snap.health < minHp) return fail(`HP ${Math.round(snap.health)} ниже ${minHp} — идти к месту с дичью не буду`, 'сначала полечиться/поохотиться недалеко; когда HP восстановится — зови cook_food снова');
    if (snap.food < minFood) return fail(`сытость ${snap.food} ниже ${minFood} — далеко не пойду`, 'сначала поесть что есть (eat) или охота рядом; повтори cook_food при сытости повыше');

    let stop = null; // {reason, hint}

    for (let pass = 0; pass < 14 && Date.now() < deadline && !stop; pass++) {
      snap = await api.snapshot();
      m = invMap(snap.inventory);
      const need = min - readyOf(m);
      if (need <= 0) break;

      if (isNight(snap)) { stop = { reason: `ночь: охота не идёт (осталась в ${posLabel(snap.position)})`, hint: 'пережидать ночь (wait_night или sleep); охота — утром' }; break; }

      // 1. жарка того, что есть
      const raws = RAW.filter(n => m[n] > 0).sort((a, b) => m[b] - m[a]);
      if (raws.length) {
        let progressed = false;
        for (const r of raws) {
          snap = await api.snapshot();
          const left = min - readyOf(invMap(snap.inventory));
          if (left <= 0 || Date.now() > deadline) break;
          const cnt = Math.min(invMap(snap.inventory)[r], left);
          try {
            const res = await api.cmd('smelt', { item: r, count: cnt });
            st.cooked += (res && Number(res.made)) || cnt; progressed = true;
            api.log(`cook_food: пожарила ${r} x${cnt}`);
          } catch (e) { st.errors.push(`${r}: ${clean(e)}`); api.log(`cook_food: smelt ${r}: ${e.message}`); }
        }
        if (!progressed) stop = { reason: 'жарка не идёт (нет печи/топлива) — добытое мясо не приготовится', hint: 'нужна печь и топливо (craft furnace / collect coal); мясо уже в инвентаре — потом повтори cook_food' };
        continue;
      }

      // 2. охота: пока под крышей/под землёй не очутились — проверка (пещеру могли найти по дороге)
      const cover2 = await coverCheck(api, snap);
      if (cover2) { stop = { reason: `${cover2}: охота не идёт (текущая точка ${posLabel(snap.position)})`, hint: 'сначала выбраться на открытое место (goto/explore/climb_up), потом зови cook_food' }; break; }

      // 3. где охотимся: пока не дошли до места — максимум MAX_LOCAL_HUNTS охот у старта
      const atPlace = d2(snap.position, place) <= ARRIVE;
      const localHunts = st.places.filter(e => e.kind === 'local').reduce((s, e) => s + e.hunts, 0);
      if (!atPlace && !st.wentFar && localHunts >= MAX_LOCAL_HUNTS) {
        // рядом пусто (или уже охотились) — идём к известному месту с дичью
        api.log(`cook_food: рядом (${startPos}) животных не добыла — иду к месту ${addr(place.name, placeAddr)}`);
        const travel = await walkTo(api, st, place, step, minHp, deadline);
        if (!travel.ok) {
          const s2 = await api.snapshot();
          stop = { reason: `не добралась до ${place.name} (${placeAddr}): ${travel.why}; осталась в ${posLabel(s2.position)}`, hint: travel.night ? 'пережидать ночь (wait_night или sleep); утром зови cook_food снова' : 'сначала доведи тело goto до места охоты (или выбери другое место в x/y/z), потом зови cook_food' };
          break;
        }
        st.wentFar = true;
        snap = await api.snapshot();
      }

      const curName = st.wentFar || atPlace ? place.name : 'у старта';
      const curKind = st.wentFar || atPlace ? 'place' : 'local';
      const lastPlace = st.places[st.places.length - 1];
      if (!lastPlace || lastPlace.kind !== curKind) st.places.push({ kind: curKind, name: curName, at: posLabel(snap.position), hunts: 0, kills: 0, results: [] });

      // охота из текущей точки
      const huntAt = { x: snap.position.x, y: snap.position.y, z: snap.position.z };
      const side = dir8(startAt, huntAt);
      const r = await huntOnce(api, st, min - readyOf(invMap(snap.inventory)), huntRadius, curName, huntAt, side);
      if (r.kills > 0) { continue; } // есть мясо — на следующий виток (жарка)

      // пусто. У старта — на следующий виток уход к месту; на месте — одна безопасная смена точки и вторая охота
      const placeEntry = st.places[st.places.length - 1];
      if (atPlace || st.wentFar) {
        const sameSpotHunts = placeEntry.hunts;
        const placeReloc = st.placeReloc || (st.placeReloc = 0);
        if (sameSpotHunts < 2 || placeReloc >= MAX_PLACE_RELOC || st.hunts >= MAX_HUNTS) {
          stop = { reason: `дичи нет и здесь: ${curName} ${placeAddr} (${placeEntry.hunts} охот, убито ${placeEntry.kills})`, hint: 'зови cook_food из другой точки (можно передать x/y/z другого места с дичью); тот же вызов из тех же точек не повторять' };
          break;
        }
        st.placeReloc++;
        api.log(`cook_food: у ${curName} пусто — меняю точку охоты (${placeReloc}/${MAX_PLACE_RELOC})`);
        const rel = await relocate(api, snap, st, step);
        if (!rel.moved) {
          api.log(`cook_food: точку охоты сменить не вышло (${short(rel.why || '', 90)}) — вторая охота оттуда же`);
        } else snap = rel.snap;
        continue;
      }
    }

    // итог
    snap = await api.snapshot();
    m = invMap(snap.inventory);
    const ready = readyOf(m);
    if (ready >= min) {
      return {
        ok: true, ready, min, cooked: st.cooked, kills: st.kills, rawLeft: rawCount(m),
        places: st.places.map(e => ({ name: e.name, at: e.at, hunts: e.hunts, kills: e.kills })),
        lastSpot: posLabel(snap.position), at: posLabel(snap.position), note: 'готово'
      };
    }
    if (stop) return fail(stop.reason, stop.hint);
    const lastErr = st.errors.length ? short(st.errors[st.errors.length - 1], 90) : 'мяса нет';
    return fail(lastErr, 'зови cook_food из другой точки (передав x/y/z места); тот же вызов не повторять');
  }
};

// ---- дорога к месту: перебежки по step м с survey, без ночи и обрывов (как go_safe) ----
async function walkTo(api, st, place, step, minHp, deadline) {
  for (let hop = 0; hop < MAX_HOPS && Date.now() < deadline; hop++) {
    const snap = await api.snapshot();
    if (isNight(snap)) return { ok: false, why: 'ночь — идти больше не буду', night: true };
    if (snap.health < minHp) return { ok: false, why: `HP ${Math.round(snap.health)} ниже ${minHp}` };
    const pos = snap.position;
    const left = d2(pos, place);
    if (left <= ARRIVE) return { ok: true };
    let sv = null;
    try { sv = await api.cmd('survey', { x1: Math.floor(pos.x) - 8, y1: Math.floor(pos.y) - 8, z1: Math.floor(pos.z) - 8, x2: Math.floor(pos.x) + 8, y2: Math.floor(pos.y) + 3, z2: Math.floor(pos.z) + 8 }); } catch (e) {}
    if (!sv || !sv.heightmap) return { ok: false, why: 'край не виден (survey без высот) — вслепую не иду' };
    // направление прямо к цели, потом ±45°/±90°
    const baseAng = Math.atan2(place.x - pos.x, place.z - pos.z);
    let chosen = null, why = '';
    const offs = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
    for (const off of offs) {
      const tx = Math.round(pos.x + Math.sin(baseAng + off) * step);
      const tz = Math.round(pos.z + Math.cos(baseAng + off) * step);
      const chk = pathOk(sv, pos, { x: tx, z: tz });
      if (chk.ok) chosen = { tx, tz, off };
      else if (!why || off === 0) why = chk.why;
      if (chosen) break;
    }
    if (!chosen) return { ok: false, why: `путь не виден: ${short(why, 90)}` };
    const g = await tryGoto(api, chosen.tx, chosen.tz, 25);
    if (!g.ok) {
      // не дошли — сдвинулись? если да и не упали, продолжаем
      const s2 = await api.snapshot();
      const moved = d2(s2.position, pos);
      const dy = Math.floor(pos.y) - Math.floor(s2.position.y);
      if (motion(moved, dy)) { api.log(`cook_food: перебежка прервана (${short(g.err, 60)}), сдвиг ${Math.round(moved)} м, y ${dy >= 0 ? '-' : '+'}${Math.abs(dy)}`); continue; }
      return { ok: false, why: `перебежка не удалась: ${short(g.err, 90)}` };
    } else {
      const s2 = await api.snapshot();
      const dy = Math.floor(pos.y) - Math.floor(s2.position.y);
      if (dy >= 8) { st.fell = true; return { ok: false, why: `перебежка свалила на ${dy} м вниз` }; }
      const rest = d2(s2.position, place);
      api.log(`cook_food: перебежка ${hop + 1} → ${fmtPos(s2.position)} (до ${place.name} осталось ${Math.round(rest)} м)`);
    }
  }
  return { ok: false, why: `за ${hop} перебежек не дошла (лимит по шагам/времени)` };
}

function motion(moved, dy) { return moved >= 3 && dy < 8; }
