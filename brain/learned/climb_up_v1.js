// версия: первая: лесенка вверх (dig_at + ступенька), при неудаче подъём на месте pillar_up; цель x,y,z или to_y; dry=1
// climb_up — подъём вверх из каньона/пещеры/ямы: лесенка вверх до заданной высоты.
//
// Как поднимаемся (приёмы, проверенные в проекте):
//   1) лесенка: впереди-вверху выкапываем 2 блока (dig_at) → впереди на уровне ног остаётся
//      твёрдый уступ (или ставим ступеньку place_at, при «не к чему прислонить» — подкладываем
//      опору) → goto на уступ = +1 к высоте;
//   2) лесенка не вышла — подъём на месте: dig_at над головой (feet+2 и feet+3) → pillar_up height=1
//      (тело ставит столб только из земли/булыжника/камня; брёвна и доски не годятся).
// Каждый подъём = +1 к высоте, значит до цели доходим без «долгого пути».
//
// Стоп: лава/вода в колонке, HP<8 (тогда escape), нет места/блоков, лимит ступеней или времени.
//
// params: x,z — цель по горизонтали; y (или target_y) — высота цели; to_y — на сколько вверх;
//         steps — максимум ступеней; item — из чего ступеньки; max_sec; ground=1 — взять высоту
//         поверхности рядом с (x,z) из survey; dry=1 — только смета.
// Возврат: {ok, at:[x,y,z], dug, placed, steps, pillars, why, error}.
'use strict';

const DV = { east: [1, 0], south: [0, 1], west: [-1, 0], north: [0, -1] };
const ORDER = ['east', 'south', 'west', 'north'];
const AIRY = /^(air|cave_air|void_air)$/;
const FLUID = /water|lava|bubble_column/;
const LAVA = /lava/;
const WATER = /water|bubble_column/;
// что тело умеет ставить столбом (lib/skills/basic.js PLACE_ORDER) — брёвна и доски не годятся
const PILLAR_OK = ['cobblestone', 'stone', 'deepslate', 'cobbled_deepslate', 'dirt', 'coarse_dirt',
  'netherrack', 'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'blackstone', 'end_stone'];
// вообще любые блоки для ступеньки (place_at берёт что угодно из инвентаря)
const ANY_BLOCK = PILLAR_OK.concat(['spruce_planks', 'oak_planks', 'spruce_log', 'oak_log', 'birch_log',
  'sand', 'gravel', 'prismarine', 'stone_bricks', 'cobblestone_wall', 'snow_block']);

const key = (x, y, z) => `${x},${y},${z}`;
const isSolid = b => !!b && b !== '?' && !AIRY.test(b) && !FLUID.test(b);
const isOpen = b => !!b && b !== '?' && AIRY.test(b);
const floorPos = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

function gridOf(sv) {
  const o = (sv && sv.origin) || { x: 0, y: 0, z: 0 };
  return (x, y, z) => {
    const layer = sv.layers && sv.layers['y=' + y];
    if (!layer) return '?';
    const row = layer[z - o.z];
    if (row === undefined) return '?';
    const ch = row[x - o.x];
    if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}

function invCount(inv, name) {
  return (inv || []).filter(i => i.name === name).reduce((s, i) => s + (i.count || 0), 0);
}
function placeableCount(inv) {
  return (inv || []).filter(i => ANY_BLOCK.indexOf(i.name) >= 0).reduce((s, i) => s + (i.count || 0), 0);
}
function pickBlock(inv, want, list) {
  const order = want ? [want].concat(list.filter(n => n !== want)) : list.slice();
  for (const n of order) if (invCount(inv, n) > 0) return n;
  return null;
}
const short = m => String(m || '').replace(/\s+/g, ' ').slice(0, 140);

// Копнуть клетку. Пустая клетка — не ошибка (dig_at так и отвечает), лава — отдельный отказ.
async function digCell(api, x, y, z) {
  try {
    const r = await api.cmd('dig_at', { x, y, z });
    return { ok: true, dug: true, got: r && r.got };
  } catch (e) {
    const m = short(e.message);
    if (/уже пусто|нет такого блока/.test(m)) return { ok: true, dug: false, kind: 'empty', why: m };
    if (/лава|огонь/.test(m)) return { ok: false, kind: 'lava', why: m };
    if (/пропаст|под ним/.test(m)) return { ok: false, kind: 'danger', why: m };
    return { ok: false, kind: 'error', why: m };
  }
}

// Выкопать место впереди-вверху: cells = [y1, y2] над уровнем ног.
async function digHeadroom(api, g, x, z, cells) {
  let dug = 0;
  for (const y of cells) {
    const nm = g(x, y, z);
    if (nm !== '?' && !isSolid(nm)) continue;      // воздух — копать нечего
    const r = await digCell(api, x, y, z);
    if (r.ok) { if (r.dug) dug++; continue; }
    if (r.kind === 'empty') continue;
    return { ok: false, why: `не выкопал ${x},${y},${z}: ${r.why}`, dug };
  }
  return { ok: true, dug };
}

// Опора под ступеньку: твёрдый сосед нужен самому place_at.
async function putSupport(api, g, T, cur, item) {
  const cands = [
    { x: T.x, y: T.y - 1, z: T.z },
    { x: T.x - 1, y: T.y, z: T.z }, { x: T.x + 1, y: T.y, z: T.z },
    { x: T.x, y: T.y, z: T.z - 1 }, { x: T.x, y: T.y, z: T.z + 1 }
  ];
  const tried = [];
  for (const c of cands) {
    if (c.x === cur.x && c.z === cur.z) { tried.push(`${key(c.x, c.y, c.z)} — клетка мухи`); continue; }
    const nm = g(c.x, c.y, c.z);
    if (isSolid(nm)) { tried.push(`${key(c.x, c.y, c.z)} — занята`); continue; }
    if (FLUID.test(String(nm))) { tried.push(`${key(c.x, c.y, c.z)} — жидкость`); continue; }
    try {
      await api.cmd('place_at', { x: c.x, y: c.y, z: c.z, item });
      return { ok: true, placed: 1, at: key(c.x, c.y, c.z) };
    } catch (e) {
      const m = short(e.message);
      if (/занято/.test(m)) return { ok: true, placed: 0, at: key(c.x, c.y, c.z) };
      tried.push(`${key(c.x, c.y, c.z)} — ${m}`);
    }
  }
  return { ok: false, placed: 0, why: 'опору поставить не удалось: ' + tried.join('; ') };
}

// Пол ступеньки: твёрдый уступ — уже готов; иначе ставим блок (с опорой, если не к чему прислонить).
async function ensurePlatform(api, g, T, cur, inv, want) {
  const nm = g(T.x, T.y, T.z);
  if (isSolid(nm)) return { ok: true, placed: 0, why: '' };
  if (FLUID.test(String(nm))) return { ok: false, placed: 0, why: 'жидкость на месте ступеньки' };
  const item = pickBlock(inv, want, ANY_BLOCK);
  if (!item) return { ok: false, placed: 0, why: 'нет блоков для ступеньки (нужен dirt/cobblestone/камень)' };
  try {
    await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item });
    return { ok: true, placed: 1, why: 'ступенька ' + item };
  } catch (e) {
    const m = short(e.message);
    if (/занято/.test(m)) return { ok: true, placed: 0, why: 'место ступеньки уже занято' };
    if (!/не к чему прислонить/.test(m)) return { ok: false, placed: 0, why: 'place_at: ' + m };
    const sup = await putSupport(api, g, T, cur, item);
    if (!sup.ok) return { ok: false, placed: 0, why: sup.why };
    try {
      await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item });
      return { ok: true, placed: 1 + sup.placed, why: 'опора ' + sup.at + ' + ступенька ' + item };
    } catch (e2) {
      return { ok: false, placed: sup.placed, why: 'опора поставлена, но ступенька не поставилась: ' + short(e2.message) };
    }
  }
}

// Подъём на месте: выкопать место над головой (feet+2, feet+3) и поставить столб под себя.
async function pillarClimb(api, cur, inv, want) {
  let dug = 0;
  let g = () => '?';
  try {
    g = gridOf(await api.cmd('survey', { x1: cur.x - 1, y1: cur.y + 1, z1: cur.z - 1, x2: cur.x + 1, y2: cur.y + 4, z2: cur.z + 1 }));
  } catch (e) { api.log('survey перед столбом не получился: ' + short(e.message)); }

  for (const y of [cur.y + 2, cur.y + 3]) {
    const nm = g(cur.x, y, cur.z);
    if (nm !== '?' && !isSolid(nm)) continue;
    const r = await digCell(api, cur.x, y, cur.z);
    if (r.ok) { if (r.dug) dug++; continue; }
    if (r.kind === 'empty') continue;
    return { ok: false, why: `не выкопал место над головой (${cur.x},${y},${cur.z}): ${r.why}`, dug };
  }

  let item = pickBlock(inv, want, PILLAR_OK);
  if (!item) {
    // блока нет — попробовать добыть рядом (камень → булыжник)
    for (const d of [['east', 'west'], ['south', 'north']]) {
      for (const nm2 of d) {
        const c = { x: cur.x + DV[nm2][0], z: cur.z + DV[nm2][1] };
        for (const y of [cur.y + 1, cur.y + 2]) {
          const b = g(c.x, y, c.z);
          if (b !== '?' && !isSolid(b)) continue;
          const r = await digCell(api, c.x, y, c.z);
          if (r.ok && r.dug) dug++;
          if (r.ok) break;
        }
        let inv2 = inv;
        try { const s2 = await api.snapshot(); inv2 = s2.inventory || inv; } catch (e) { /* пусто */ }
        item = pickBlock(inv2, want, PILLAR_OK);
        if (item) break;
      }
      if (item) break;
    }
  }
  if (!item) return { ok: false, why: 'нечем ставить столб (нет земли/булыжника/камня и добыть не вышло)', dug };

  try {
    const r = await api.cmd('pillar_up', { height: 1, item });
    const y = r && Number.isFinite(Number(r.y)) ? Math.floor(Number(r.y)) : cur.y + 1;
    return { ok: true, y, dug, placed: 0, item };
  } catch (e) {
    return { ok: false, why: 'pillar_up: ' + short(e.message), dug };
  }
}

// Насколько «стена» впереди (сколько твёрдого блока в колонке) — для выбора стороны без цели.
function wallScore(g, cur, dx, dz) {
  let s = 0;
  for (let y = cur.y - 1; y <= cur.y + 3; y++) if (isSolid(g(cur.x + dx, y, cur.z + dz))) s++;
  return s;
}

// Порядок сторон: к цели — сначала по большей оси, потом по другой, потом остальные (по твёрдости).
function dirsFor(cur, tx, tz, lastDir, g) {
  const list = [];
  const push = n => { if (!list.find(c => c.name === n)) list.push({ name: n, dx: DV[n][0], dz: DV[n][1] }); };
  if (tx !== null && tz !== null) {
    const dx = tx - cur.x, dz = tz - cur.z;
    if (Math.abs(dx) >= Math.abs(dz)) { if (dx) push(dx > 0 ? 'east' : 'west'); if (dz) push(dz > 0 ? 'south' : 'north'); }
    else { if (dz) push(dz > 0 ? 'south' : 'north'); if (dx) push(dx > 0 ? 'east' : 'west'); }
  } else if (lastDir) {
    push(lastDir);
  }
  const rest = ORDER.filter(n => !list.find(c => c.name === n))
    .map(n => ({ name: n, score: wallScore(g, cur, DV[n][0], DV[n][1]) }))
    .sort((a, b) => b.score - a.score);
  for (const r of rest) push(r.name);
  return list;
}

module.exports = {
  name: 'climb_up',
  description: 'Подъём вверх из каньона/пещеры/ямы: лесенка вверх (dig_at впереди-вверху + ступенька place_at), при неудаче подъём на месте (dig_at над головой + pillar_up). Цель: x,y,z или y/to_y; ground=1 — взять высоту поверхности у цели; dry=1 — смета. Стоп: лава/вода, HP<8 (escape), нет места. Возврат {ok, at, dug, placed, steps, why}.',
  params: {
    x: 'x цели (горизонтальная привязка, необязательно)',
    z: 'z цели (горизонтальная привязка, необязательно)',
    y: 'высота цели (ноги) — абсолютная',
    target_y: 'то же, что y — абсолютная высота цели',
    to_y: 'на сколько блоков вверх (относительно текущей высоты)',
    ground: '1 — цель по высоте = поверхность рядом с (x,z) из survey (перекрывает y)',
    steps: 'максимум ступеней (по умолчанию 40)',
    item: 'из чего ставить ступеньки (по умолчанию cobblestone; если нет — любой блок)',
    max_sec: 'ограничение времени в секундах (по умолчанию 240)',
    dry: '1 — ничего не копать: вернуть смету (сколько блоков нужно и где примерно копать)'
  },
  async run(api, params) {
    const t0 = Date.now();
    const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    const maxSec = Math.min(Math.max(num(params.max_sec, 240), 30), 1500);
    const maxSteps = Math.min(Math.max(Math.floor(num(params.steps, 40)), 1), 200);
    const dry = params.dry === true || params.dry === 1 || params.dry === '1' || params.dry === 'true';
    const want = params.item ? String(params.item).trim().toLowerCase() : '';

    let snap;
    try { snap = await api.snapshot(); }
    catch (e) { return { ok: false, error: 'снимок тела не получился: ' + short(e.message), at: null, dug: 0, placed: 0, steps: 0, why: 'снимок не получился' }; }

    let cur = floorPos(snap.position || { x: 0, y: 0, z: 0 });
    const start = cur;
    const tx = params.x === undefined || params.x === null || !Number.isFinite(Number(params.x)) ? null : Math.floor(Number(params.x));
    const tz = params.z === undefined || params.z === null || !Number.isFinite(Number(params.z)) ? null : Math.floor(Number(params.z));

    // высота цели
    let goalY = null;
    if (params.ground === 1 || params.ground === '1' || params.ground === true) {
      if (tx === null || tz === null) return { ok: false, error: 'ground=1 нужны x и z', at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, why: 'ground без x,z' };
      try {
        const sv = await api.cmd('survey', { x1: tx - 4, y1: cur.y - 4, z1: tz - 4, x2: tx + 4, y2: cur.y + 16, z2: tz + 4 });
        const o = sv.origin || { x: tx, y: 0, z: tz };
        const hm = sv.heightmap || [];
        const row = hm[tz - o.z];
        const h = row ? row[tx - o.x] : null;
        goalY = (h === null || h === undefined) ? null : h + 1;
        if (goalY === null) api.log('ground=1: поверхность у цели не видна — беру y');
      } catch (e) { api.log('ground=1: survey не получился: ' + short(e.message)); }
    }
    if (goalY === null) {
      if (params.y !== undefined && params.y !== null && Number.isFinite(Number(params.y))) goalY = Math.floor(Number(params.y));
      else if (params.target_y !== undefined && params.target_y !== null && Number.isFinite(Number(params.target_y))) goalY = Math.floor(Number(params.target_y));
      else if (params.to_y !== undefined && params.to_y !== null && Number.isFinite(Number(params.to_y))) goalY = cur.y + Math.floor(Number(params.to_y));
    }
    if (goalY === null) {
      return {
        ok: false, error: 'нужна высота цели: y (абсолютная) или to_y (на сколько вверх)',
        at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, why: 'не указана высота цели'
      };
    }
    if (goalY <= cur.y && cur.y - goalY <= 2) {
      return {
        ok: true, at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, pillars: 0,
        why: `уже на высоте ${cur.y} (цель ${goalY}) — подниматься не нужно`
      };
    }

    // ---- смета (dry): ничего не копаем, только считаем ----
    if (dry) {
      let g = () => '?';
      try { g = gridOf(await api.cmd('survey', { x1: cur.x - 3, y1: cur.y - 2, z1: cur.z - 3, x2: cur.x + 3, y2: cur.y + 8, z2: cur.z + 3 })); }
      catch (e) { api.log('survey для сметы не получился: ' + short(e.message)); }
      const inv = snap.inventory || [];
      const cands = dirsFor(cur, tx, tz, null, g);
      const c = cands[0];
      const T = { x: cur.x + c.dx, y: cur.y, z: cur.z + c.dz };
      const up = Math.max(0, goalY - cur.y);
      const dig = [];
      for (const y of [cur.y + 1, cur.y + 2]) { const nm = g(T.x, y, T.z); if (nm === '?' || isSolid(nm)) dig.push([T.x, y, T.z]); }
      for (const y of [cur.y + 2, cur.y + 3]) { const nm = g(cur.x, y, cur.z); if (nm === '?' || isSolid(nm)) dig.push([cur.x, y, cur.z]); }
      let open = 0;
      for (let y = cur.y + 2; y < cur.y + 2 + up; y++) { const nm = g(cur.x, y, cur.z); if (isOpen(nm)) open++; else break; }
      const needBlocks = open + 1;                       // столбы на открытых уровнях + запас
      const haveBlocks = placeableCount(inv);
      const plat = g(T.x, cur.y, T.z);
      const plan = `подъём на ${up} блок(ов) до y=${goalY}` +
        (tx !== null && tz !== null ? ` к цели ${tx} ${tz}` : '') +
        `; сторона ${c.name}: выкопать ${dig.length} блок(ов) [${dig.map(d => d.join(' ')).join('; ')}]` +
        (isSolid(plat) ? '; ступенька готова (твёрдый уступ)' : '; ступеньку надо ставить') +
        `; блоков нужно ~${needBlocks}, есть ${haveBlocks}` +
        (open ? ` (сверху ${open} уровн(ей) открыто — столбы нечем ставить, нужен запас)` : ' (сверху твёрдо — копаем и берём булыжник)');
      return {
        ok: true, dry: true, at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0,
        up, goalY, dir: c.name, dig, need: { blocks: needBlocks }, have: { blocks: haveBlocks },
        missing: { blocks: Math.max(0, needBlocks - haveBlocks) }, plan
      };
    }

    // ---- подъём ----
    let dug = 0, placed = 0, steps = 0, pillars = 0, lastDir = null, noProgress = 0;
    let stopWhy = '';
    const tried = new Map();       // клетка -> сколько раз пробовали
    const notes = [];

    for (let step = 0; step < maxSteps; step++) {
      if ((Date.now() - t0) / 1000 > maxSec) { stopWhy = `время вышло (${maxSec} с)`; break; }
      try { snap = await api.snapshot(); } catch (e) { stopWhy = 'снимок не получился: ' + short(e.message); break; }
      cur = floorPos(snap.position || cur);
      const hp = num(snap.health, 20);
      if (hp < 8) {
        try { await api.cmd('escape', { distance: 16, shelter: true }); } catch (e) { api.log('escape: ' + short(e.message)); }
        return {
          ok: false, error: `HP ${hp} (<8) — убежала`, at: [cur.x, cur.y, cur.z],
          dug, placed, steps, pillars, why: `HP ${hp} (<8) — убежала`
        };
      }
      if (cur.y >= goalY) {
        const why = `поднялась до ${cur.y} (цель ${goalY})`;
        api.log(why);
        return { ok: true, at: [cur.x, cur.y, cur.z], dug, placed, steps, pillars, why };
      }

      const inv = snap.inventory || [];
      let g = () => '?';
      try {
        g = gridOf(await api.cmd('survey', {
          x1: cur.x - 2, y1: cur.y - 2, z1: cur.z - 2,
          x2: cur.x + 2, y2: cur.y + 4, z2: cur.z + 2
        }));
      } catch (e) { stopWhy = 'survey не получился: ' + short(e.message); break; }

      const cands = dirsFor(cur, tx, tz, lastDir, g);
      let climbed = false;
      const dirNotes = [];

      for (const c of cands.slice(0, 3)) {
        const T = { x: cur.x + c.dx, y: cur.y, z: cur.z + c.dz };
        const ck = key(T.x, T.y, T.z);
        if ((tried.get(ck) || 0) >= 2) { dirNotes.push(`${c.name}: клетка ${ck} уже пробовали`); continue; }

        // лава/вода в колонке — сторону пропускаем
        let fluid = null;
        for (let y = cur.y - 1; y <= cur.y + 3; y++) {
          const nm = String(g(T.x, y, T.z));
          if (LAVA.test(nm)) { fluid = 'лава'; break; }
          if (WATER.test(nm)) { fluid = 'вода'; break; }
        }
        if (fluid) {
          tried.set(ck, (tried.get(ck) || 0) + 1);
          dirNotes.push(`${c.name}: ${fluid} в колонке ${ck}`);
          continue;
        }

        // место впереди-вверху
        const dr = await digHeadroom(api, g, T.x, T.z, [cur.y + 1, cur.y + 2]);
        dug += dr.dug;
        if (!dr.ok) {
          tried.set(ck, (tried.get(ck) || 0) + 1);
          dirNotes.push(`${c.name}: ${dr.why}`);
          continue;
        }

        // пол ступеньки
        const pr = await ensurePlatform(api, g, T, cur, inv, want);
        placed += pr.placed;
        if (!pr.ok) {
          tried.set(ck, (tried.get(ck) || 0) + 1);
          dirNotes.push(`${c.name}: ${pr.why}`);
          continue;
        }

        // залезть на ступеньку
        let goWhy = '';
        try { await api.cmd('goto', { x: T.x, y: cur.y + 1, z: T.z, timeout: 25 }); }
        catch (e) { goWhy = 'не залезла на ступеньку: ' + short(e.message); }
        let ny = cur.y;
        try { const after = await api.snapshot(); ny = floorPos(after.position).y; } catch (e) { ny = cur.y; }
        if (ny > cur.y) {
          steps++; noProgress = 0; lastDir = c.name;
          api.log(`шаг ${step}: ступенька ${c.name} ${T.x},${T.y},${T.z} (${pr.why || 'уступ'}) → ноги ${ny}`);
          climbed = true;
          break;
        }
        tried.set(ck, (tried.get(ck) || 0) + 1);
        dirNotes.push(`${c.name}: ${goWhy || 'ступенька не дала подъёма'}`);
      }

      if (climbed) continue;

      // запасной путь — подъём на месте
      const pc = await pillarClimb(api, cur, inv, want);
      dug += pc.dug;
      if (pc.ok) {
        steps++; noProgress = 0; pillars++;
        api.log(`шаг ${step}: подъём на месте → ${pc.y}`);
        continue;
      }
      noProgress++;
      notes.push(...dirNotes);
      api.log(`шаг ${step}: подъём не вышел: ${pc.why}${dirNotes.length ? ' | ' + dirNotes.join(' | ') : ''}`);
      if (noProgress >= 3) { stopWhy = 'подняться не вышло: ' + pc.why; break; }
    }

    try { snap = await api.snapshot(); cur = floorPos(snap.position || cur); } catch (e) { /* пусто */ }
    const reached = cur.y >= goalY;
    const why = reached ? `поднялась до ${cur.y} (цель ${goalY})` : (stopWhy || `поднялась только до ${cur.y} из ${goalY}`);
    const out = {
      ok: reached,
      at: [cur.x, cur.y, cur.z],
      dug, placed, steps, pillars,
      goalY, start: [start.x, start.y, start.z], why,
      notes: notes.slice(-6)
    };
    if (tx !== null && tz !== null) out.dist = { x: Math.abs(tx - cur.x), z: Math.abs(tz - cur.z) };
    if (!reached) out.error = why;
    return out;
  }
};
