// версия: как v2 + до подъёма считает блоки (~1.5 на уровень + 5): не хватает — не начинает (missing); на столб — только земля/булыжник/камень
// climb_up — подъём вверх из каньона/пещеры/ямы: лесенка вверх до заданной высоты.
//
// Как поднимаемся (приёмы, проверенные в проекте):
//   1) лесенка: впереди-вверху выкапываем 2 блока (dig_at) → впереди на уровне ног остаётся
//      твёрдый уступ (или ставим ступеньку place_at, при «не к чему прислонить» — подкладываем
//      опору) → goto на уступ = +1 к высоте;
//   2) лесенка не вышла — подъём на месте: dig_at над головой (feet+2 и feet+3) → pillar_up height=1;
//   3) блоков совсем нет — пробуем добыть один рядом (не больше одного раза на уровень).
//
// Материал (главная правка): ПЕРЕД подъёмом считаем блоки — нужно ≈1.5 блока на уровень
// (ступенька + опора) + 5 в запас. Не хватает — НЕ начинаем: ok:false с числами
// «нужно ~N, есть M» и missing:{blocks}. Кончились в середине — тоже с числами:
// «блоки кончились: поднялась до y=38 из 67, осталось 29 уровней, нужно ~50 блоков».
//
// Правила блоков:
//   - столб (pillar_up) — только блок, который берёт тело (PLACE_ORDER в lib/skills/basic.js:267:
//     земля/булыжник/камень и т.п.); сперва тратим dirt/cobblestone/stone;
//   - гранит/андезит/брёвна/доски идут на ступеньки (place_at) — столбом их не тратим;
//   - инвентарь перечитывается после КАЖДОЙ установки блока — иначе «нет в инвентаре: granite»
//     на уже поставленном блоке.
//
// Стоп: лава/вода в колонке, HP<8 (тогда escape), нет места/блоков, лимит ступеней или времени.
//
// params: x,z — цель по горизонтали; y (или target_y) — высота цели; to_y — на сколько вверх;
//         steps — максимум ступеней; item — из чего ступеньки; max_sec; ground=1 — взять высоту
//         поверхности рядом с (x,z) из survey; dry=1 — только смета; need — явное число блоков;
//         min_ratio — доля сметы, при которой ещё можно начинать; strict=0 — не проверять запас.
// Возврат: {ok, at:[x,y,z], dug, placed, steps, pillars, need, have, missing, why, error}.
'use strict';

const DV = { east: [1, 0], south: [0, 1], west: [-1, 0], north: [0, -1] };
const ORDER = ['east', 'south', 'west', 'north'];
const AIRY = /^(air|cave_air|void_air)$/;
const FLUID = /water|lava|bubble_column/;
const LAVA = /lava/;
const WATER = /water|bubble_column/;
// Что тело берёт для столба (lib/skills/basic.js:267 PLACE_ORDER) — pillar_up только с этими.
const PILLAR_BODY_OK = ['dirt', 'coarse_dirt', 'netherrack', 'tuff', 'andesite', 'diorite', 'granite',
  'calcite', 'sandstone', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'blackstone', 'end_stone'];
// Столб строим сперва из земли/булыжника/камня — их тело берёт всегда.
const PILLAR_PREF = ['dirt', 'cobblestone', 'stone'];
// Эти — только на ступеньки (place_at): на столб их не тратим.
const STEP_ONLY = ['spruce_planks', 'oak_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
  'spruce_log', 'oak_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'sand', 'red_sand', 'gravel',
  'prismarine', 'stone_bricks', 'cobblestone_wall', 'snow_block', 'glass', 'terracotta', 'mud', 'packed_mud',
  'bricks', 'quartz_block', 'obsidian', 'hay_block', 'sponge', 'grass_block'];
const ANY_BLOCK = PILLAR_BODY_OK.concat(STEP_ONLY.filter(n => PILLAR_BODY_OK.indexOf(n) < 0));

const key = (x, y, z) => `${x},${y},${z}`;
const isSolid = b => !!b && b !== '?' && !AIRY.test(b) && !FLUID.test(b);
const isOpen = b => !!b && b !== '?' && AIRY.test(b);
const floorPos = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').replace(/\s+/g, ' ').slice(0, 160);

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

// инвентарь: имя → количество
function invMap(inv) {
  const m = new Map();
  for (const i of inv || []) m.set(i.name, (m.get(i.name) || 0) + (i.count || 0));
  return m;
}
// сколько ставимых блоков в кармане
function blocksTotal(m) {
  let n = 0;
  for (const [name, c] of m) if (ANY_BLOCK.indexOf(name) >= 0) n += c;
  return n;
}
function blocksByType(m) {
  const o = {};
  for (const [name, c] of m) if (ANY_BLOCK.indexOf(name) >= 0 && c > 0) o[name] = c;
  return o;
}
// Сколько блоков нужно на подъём: ~1.5 на уровень + 5 в запас, округляем до 5.
function needBlocks(up) {
  const u = Math.max(0, Math.ceil(Number(up) || 0));
  const raw = u * 1.5 + 5;
  return Math.max(5, Math.round(raw / 5) * 5);
}
// Блок для ступеньки: сначала «нестолбовые» (брёвна/доски/гранит), столбовые — в конце.
function pickStepBlock(inv, want) {
  const order = [];
  if (want) order.push(want);
  for (const n of STEP_ONLY) order.push(n);
  for (const n of PILLAR_PREF) order.push(n);
  for (const n of PILLAR_BODY_OK) order.push(n);
  for (const n of order) if ((inv.get(n) || 0) > 0) return n;
  return null;
}
// Блок для столба: только то, что тело берёт (PLACE_ORDER тела), сперва земля/булыжник/камень.
function pickPillarBlock(inv, want) {
  const order = [];
  if (want && PILLAR_BODY_OK.indexOf(want) >= 0) order.push(want);
  for (const n of PILLAR_PREF) order.push(n);
  for (const n of PILLAR_BODY_OK) order.push(n);
  for (const n of order) if ((inv.get(n) || 0) > 0) return n;
  return null;
}

// Перечитать инвентарь (после установки блока он меняется).
async function refreshInv(api, inv) {
  try {
    const s = await api.snapshot();
    const fresh = invMap(s.inventory);
    inv.clear();
    for (const [k, v] of fresh) inv.set(k, v);
  } catch (e) { /* снимок не удался — верим своему счёту */ }
}
// Потратить 1 блок и сразу перечитать инвентарь (иначе «нет в инвентаре» на поставленном блоке).
async function spend(api, inv, name) {
  const left = Math.max(0, (inv.get(name) || 0) - 1);
  inv.set(name, left);
  try {
    const s = await api.snapshot();
    const fresh = invMap(s.inventory);
    if ((fresh.get(name) || 0) > left) fresh.set(name, left);   // снимок ещё не обновился
    inv.clear();
    for (const [k, v] of fresh) inv.set(k, v);
  } catch (e) { /* пусто */ }
}

// Копнуть клетку. Пустая клетка — не ошибка (dig_at так и отвечает), лава — отдельный отказ.
async function digCell(api, x, y, z) {
  try {
    const r = await api.cmd('dig_at', { x, y, z });
    return { ok: true, dug: true, got: r && r.got };
  } catch (e) {
    const m = short(e.message);
    if (/уже пусто|нет такого блока/.test(m)) return { ok: true, dug: false, kind: 'empty', why: m };
    if (/лава|огонь/.test(m)) return { ok: false, kind: 'lava', why: m };
    if (/пропасть|под ним/.test(m)) return { ok: false, kind: 'danger', why: m };
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
    return { ok: false, dug, kind: r.kind, why: `не выкопал ${x},${y},${z}: ${r.why}` };
  }
  return { ok: true, dug };
}

// Опора под ступеньку: твёрдый сосед нужен самому place_at.
async function putSupport(api, g, T, cur, item, inv) {
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
      await spend(api, inv, item);
      return { ok: true, placed: 1, at: key(c.x, c.y, c.z) };
    } catch (e) {
      const m = short(e.message);
      if (/занято/.test(m)) return { ok: true, placed: 0, at: key(c.x, c.y, c.z) };
      if (/нет в инвентаре/.test(m)) {
        await refreshInv(api, inv);
        return { ok: false, placed: 0, kind: 'blocks', why: `блока ${item} нет в инвентаре` };
      }
      tried.push(`${key(c.x, c.y, c.z)} — ${m}`);
    }
  }
  return { ok: false, placed: 0, kind: 'place', why: 'опору поставить не удалось: ' + tried.join('; ') };
}

// Пол ступеньки: твёрдый уступ — уже готов; иначе ставим блок (с опорой, если не к чему прислонить).
async function ensurePlatform(api, g, T, cur, inv, want) {
  const nm = g(T.x, T.y, T.z);
  if (isSolid(nm)) return { ok: true, placed: 0, why: '' };
  if (FLUID.test(String(nm))) return { ok: false, placed: 0, kind: 'fluid', why: 'жидкость на месте ступеньки' };
  const item = pickStepBlock(inv, want);
  if (!item) return { ok: false, placed: 0, kind: 'blocks', why: 'нет блоков для ступеньки' };
  try {
    await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item });
    await spend(api, inv, item);
    return { ok: true, placed: 1, why: 'ступенька ' + item };
  } catch (e) {
    const m = short(e.message);
    if (/занято/.test(m)) return { ok: true, placed: 0, why: 'место ступеньки уже занято' };
    if (/нет в инвентаре/.test(m)) {
      await refreshInv(api, inv);
      return { ok: false, placed: 0, kind: 'blocks', why: `блока ${item} нет в инвентаре` };
    }
    if (!/не к чему прислонить/.test(m)) return { ok: false, placed: 0, kind: 'place', why: 'place_at: ' + m };
    const sup = await putSupport(api, g, T, cur, item, inv);
    if (!sup.ok) return { ok: false, placed: 0, kind: sup.kind || 'place', why: sup.why };
    try {
      await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item });
      await spend(api, inv, item);
      return { ok: true, placed: 1 + sup.placed, why: 'опора ' + sup.at + ' + ступенька ' + item };
    } catch (e2) {
      const m2 = short(e2.message);
      if (/нет в инвентаре/.test(m2)) {
        await refreshInv(api, inv);
        return { ok: false, placed: sup.placed, kind: 'blocks', why: `блока ${item} нет в инвентаре` };
      }
      return { ok: false, placed: sup.placed, kind: 'place', why: 'опора поставлена, но ступенька не поставилась: ' + m2 };
    }
  }
}

// Добыть один блок рядом (не больше одного раза на уровень) — когда блоков в кармане нет.
async function mineNearby(api, ctx, cur, g) {
  const level = cur.y;
  if (ctx.minedAt.has(level)) return { ok: false, why: 'рядом уже копали на этом уровне' };
  ctx.minedAt.add(level);
  api.log(`блоков нет — пробую добыть один рядом (уровень y=${level})`);
  for (const dn of ['east', 'west', 'south', 'north']) {
    const c = { x: cur.x + DV[dn][0], z: cur.z + DV[dn][1] };
    for (const y of [cur.y + 1, cur.y + 2]) {
      const b = g(c.x, y, c.z);
      if (b !== '?' && !isSolid(b)) continue;
      const r = await digCell(api, c.x, y, c.z);
      if (!r.ok) break;
      if (r.dug) {
        ctx.dug++;
        await refreshInv(api, ctx.inv);
        return { ok: true, why: `выкопала ${c.x},${y},${c.z}` };
      }
      break;
    }
  }
  await refreshInv(api, ctx.inv);
  return { ok: false, why: 'рядом добыть не вышло' };
}

// Подъём на месте: выкопать место над головой (feet+2, feet+3) и поставить столб под себя.
async function pillarClimb(api, ctx, cur, want) {
  const inv = ctx.inv;
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
    return { ok: false, dug, kind: r.kind === 'lava' ? 'lava' : 'head', why: `не выкопал место над головой (${cur.x},${y},${cur.z}): ${r.why}` };
  }

  let item = pickPillarBlock(inv, want);
  if (!item) {
    const mined = await mineNearby(api, ctx, cur, g);
    dug += 0;
    item = pickPillarBlock(inv, want);
    if (!item) return { ok: false, dug, kind: 'blocks', why: 'нечем ставить столб: ' + mined.why };
  }
  try {
    const r = await api.cmd('pillar_up', { height: 1, item });
    await spend(api, inv, item);
    const y = r && Number.isFinite(Number(r.y)) ? Math.floor(Number(r.y)) : cur.y + 1;
    return { ok: true, y, dug, placed: 0, item };
  } catch (e) {
    const m = short(e.message);
    if (/кончились блоки|нечем ставить/.test(m)) {
      await refreshInv(api, inv);
      return { ok: false, dug, kind: 'blocks', why: 'pillar_up: ' + m };
    }
    return { ok: false, dug, kind: 'pillar', why: 'pillar_up: ' + m };
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
  description: 'Подъём вверх из каньона/пещеры/ямы: лесенка вверх (dig_at впереди-вверху + ступенька place_at), при неудаче подъём на месте (dig_at над головой + pillar_up). ПЕРЕД подъёмом считает блоки (нужно ≈1.5 на уровень + 5 в запас): не хватает — не начинает, ok:false с «нужно ~N, есть M» и missing. Инвентарь перечитывается после каждой установки блока; столб — только из блока, который берёт тело. Цель: x,y,z или y/to_y; ground=1 — поверхность у цели (не видна — отказ с причиной о мире); dry=1 — смета. Возврат {ok, at, dug, placed, steps, need, have, missing, why, error}.',
  params: {
    x: 'x цели (горизонтальная привязка, необязательно)',
    z: 'z цели (горизонтальная привязка, необязательно)',
    y: 'высота цели (ноги) — абсолютная',
    target_y: 'то же, что y — абсолютная высота цели',
    to_y: 'на сколько блоков вверх (относительно текущей высоты)',
    ground: '1 — цель по высоте = поверхность рядом с (x,z) из survey (перекрывает y)',
    steps: 'максимум ступеней (по умолчанию 40)',
    item: 'из чего ставить ступеньки (по умолчанию — любой блок, но не столбовый, если есть другие)',
    need: 'явное число блоков на подъём (перекрывает смету)',
    min_ratio: 'доля сметы, при которой ещё можно начинать (по умолчанию 0.6 — часть добудем по дороге)',
    strict: '1 (по умолчанию) — не начинать без блоков; 0 — начинать и разбираться по ходу',
    max_sec: 'ограничение времени в секундах (по умолчанию 240)',
    dry: '1 — ничего не копать: вернуть смету (сколько блоков нужно, сколько есть, где примерно копать)'
  },
  async run(api, params) {
    const t0 = Date.now();
    params = params || {};
    const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    const truthy = v => v === true || v === 1 || v === '1' || v === 'true';
    const maxSec = Math.min(Math.max(num(params.max_sec, 240), 30), 1500);
    const maxSteps = Math.min(Math.max(Math.floor(num(params.steps, 40)), 1), 200);
    const dry = truthy(params.dry);
    const strict = params.strict === undefined ? true : truthy(params.strict);
    const minRatio = Math.min(Math.max(num(params.min_ratio, 0.6), 0), 1);
    const want = params.item ? String(params.item).trim().toLowerCase() : '';

    let snap;
    try { snap = await api.snapshot(); }
    catch (e) { return { ok: false, error: 'снимок тела не получился: ' + short(e.message), at: null, dug: 0, placed: 0, steps: 0, why: 'снимок не получился' }; }

    let cur = floorPos(snap.position || { x: 0, y: 0, z: 0 });
    const start = cur;
    const tx = params.x === undefined || params.x === null || !Number.isFinite(Number(params.x)) ? null : Math.floor(Number(params.x));
    const tz = params.z === undefined || params.z === null || !Number.isFinite(Number(params.z)) ? null : Math.floor(Number(params.z));
    const inv = invMap(snap.inventory);

    // ---- высота цели ----
    let goalY = null;
    let groundWhy = '';
    if (truthy(params.ground)) {
      if (tx === null || tz === null) {
        return {
          ok: false, error: 'ground=1 нужны x и z цели (без них высоту поверхности не найти)',
          at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, why: 'ground без x,z'
        };
      }
      const tries = [
        { x1: tx - 4, y1: cur.y - 4, z1: tz - 4, x2: tx + 4, y2: cur.y + 16, z2: tz + 4 },
        { x1: tx - 1, y1: cur.y - 4, z1: tz - 1, x2: tx + 1, y2: cur.y + 48, z2: tz + 1 }
      ];
      for (const box of tries) {
        let sv = null, err = '';
        try { sv = await api.cmd('survey', box); } catch (e) { err = short(e.message); }
        let h = null;
        if (sv) {
          const o = sv.origin || { x: tx, y: 0, z: tz };
          const hm = sv.heightmap || [];
          const row = hm[tz - o.z];
          const v = row ? row[tx - o.x] : null;
          h = (v === null || v === undefined) ? null : v;
        }
        if (h !== null) { goalY = h + 1; break; }
        if (err) groundWhy = `поверхность у цели (${tx},${tz}) не видна (survey: ${err})`;
        else groundWhy = `поверхность у цели (${tx},${tz}) не видна — не видно колонки`;
      }
      if (goalY === null) api.log('ground=1: ' + groundWhy + ' — беру y');
    }
    if (goalY === null) {
      if (params.y !== undefined && params.y !== null && Number.isFinite(Number(params.y))) goalY = Math.floor(Number(params.y));
      else if (params.target_y !== undefined && params.target_y !== null && Number.isFinite(Number(params.target_y))) goalY = Math.floor(Number(params.target_y));
      else if (params.to_y !== undefined && params.to_y !== null && Number.isFinite(Number(params.to_y))) goalY = cur.y + Math.floor(Number(params.to_y));
    }
    if (goalY === null) {
      return {
        ok: false,
        error: groundWhy
          ? `${groundWhy} — задай y (абсолютная высота цели) или to_y (на сколько вверх)`
          : 'нужна высота цели: y (абсолютная) или to_y (на сколько вверх)',
        at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0,
        why: groundWhy ? groundWhy : 'не указана высота цели'
      };
    }
    if (goalY <= cur.y && cur.y - goalY <= 2) {
      return {
        ok: true, at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, pillars: 0,
        need: { blocks: 0 }, have: { blocks: blocksTotal(inv) }, missing: { blocks: 0 },
        why: `уже на высоте ${cur.y} (цель ${goalY}) — подниматься не нужно`
      };
    }

    const up = Math.max(0, goalY - cur.y);
    const need = params.need !== undefined && params.need !== null && Number.isFinite(Number(params.need))
      ? Math.max(0, Math.floor(Number(params.need)))
      : needBlocks(up);
    const have = blocksTotal(inv);
    const missing = Math.max(0, need - have);
    const collectName = want || 'cobblestone';

    // ---- смета (dry): ничего не копаем, только считаем по всей высоте подъёма ----
    if (dry) {
      let g = () => '?';
      try { g = gridOf(await api.cmd('survey', { x1: cur.x - 3, y1: cur.y - 2, z1: cur.z - 3, x2: cur.x + 3, y2: cur.y + 8, z2: cur.z + 3 })); }
      catch (e) { api.log('survey для сметы не получился: ' + short(e.message)); }
      const cands = dirsFor(cur, tx, tz, null, g);
      const c = cands[0];
      const T = { x: cur.x + c.dx, y: cur.y, z: cur.z + c.dz };
      const dig = [];
      for (const y of [cur.y + 1, cur.y + 2]) { const nm = g(T.x, y, T.z); if (nm === '?' || isSolid(nm)) dig.push([T.x, y, T.z]); }
      for (const y of [cur.y + 2, cur.y + 3]) { const nm = g(cur.x, y, cur.z); if (nm === '?' || isSolid(nm)) dig.push([cur.x, y, cur.z]); }
      const plat = g(T.x, cur.y, T.z);
      const byType = blocksByType(inv);
      const typeStr = Object.keys(byType).length
        ? Object.keys(byType).map(k => `${k} ${byType[k]}`).join(', ')
        : 'ничего';
      const plan = `подъём на ${up} уровней (y=${cur.y} → ${goalY})` +
        (tx !== null && tz !== null ? ` к цели ${tx} ${tz}` : '') +
        `; блоков нужно ~${need} (по 1.5 на уровень + 5 в запас), есть ${have}, не хватает ${missing}` +
        `; блоки в кармане: ${typeStr}` +
        `; столбы (pillar_up) — из ${PILLAR_PREF.join('/')}, ступеньки (place_at) — из брёвен/досок/камня` +
        `; копать: ${dig.length} клеток впереди-вверху (ступенька + опора) на уровень, примерно ${dig.length * up} всего` +
        (isSolid(plat) ? '; ступенька готова (твёрдый уступ)' : '; ступеньку надо ставить') +
        `; сторона ${c.name}`;
      return {
        ok: true, dry: true, at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0,
        up, goalY, dir: c.name, dig, need: { blocks: need }, have: { blocks: have },
        missing: { blocks: missing }, by_type: byType, plan
      };
    }

    // ---- проверка материала ДО подъёма ----
    if (strict && missing > 0 && have < Math.ceil(need * minRatio)) {
      const msg = `не хватает блоков: нужно ~${need}, есть ${have} (не хватает ${missing}) — сначала собери (collect ${collectName} ${missing})`;
      api.log(msg);
      return {
        ok: false, error: msg, at: [cur.x, cur.y, cur.z], dug: 0, placed: 0, steps: 0, pillars: 0,
        goalY, up, need: { blocks: need }, have: { blocks: have }, missing: { blocks: missing },
        by_type: blocksByType(inv),
        why: `материала не хватит: нужно ~${need}, есть ${have}`
      };
    }
    if (strict && missing > 0) {
      api.log(`блоков меньше сметы: нужно ~${need}, есть ${have} — часть добудем по дороге (копим стену)`);
    }

    // ---- подъём ----
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + short(e.message)); }
    let dug = 0, placed = 0, steps = 0, pillars = 0, lastDir = null, noProgress = 0;
    let stopWhy = '';
    const tried = new Map();       // клетка -> сколько раз пробовали
    const notes = [];
    const ctx = { api, inv, minedAt: new Set(), dug: 0 };
    let blockFail = false;         // блоки кончились — нужен отказ с цифрами

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
        return {
          ok: true, at: [cur.x, cur.y, cur.z], dug, placed, steps, pillars, why,
          need: { blocks: need }, have: { blocks: blocksTotal(inv) }, missing: { blocks: 0 }
        };
      }

      await refreshInv(api, inv);   // инвентарь мог измениться (собрали/потратили)

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
        let pr = await ensurePlatform(api, g, T, cur, inv, want);
        if (!pr.ok && pr.kind === 'blocks') {
          // блоков нет — добыть один рядом (раз на уровень) и попробовать снова
          const mined = await mineNearby(api, ctx, cur, g);
          dug += ctx.dug; ctx.dug = 0;
          if (mined.ok) {
            pr = await ensurePlatform(api, g, T, cur, inv, want);
          } else {
            dirNotes.push(`${c.name}: ${pr.why} (${mined.why})`);
          }
        }
        placed += pr.placed;
        if (!pr.ok) {
          tried.set(ck, (tried.get(ck) || 0) + 1);
          dirNotes.push(`${c.name}: ${pr.why}`);
          if (pr.kind === 'blocks') blockFail = true;
          continue;
        }

        // залезть на ступеньку
        let goWhy = '';
        try { await api.cmd('goto', { x: T.x, y: cur.y + 1, z: T.z, timeout: 15 }); }
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
      const pc = await pillarClimb(api, ctx, cur, want);
      dug += pc.dug;
      if (pc.ok) {
        steps++; noProgress = 0; pillars++;
        api.log(`шаг ${step}: подъём на месте → ${pc.y}`);
        continue;
      }
      if (pc.kind === 'blocks') blockFail = true;
      noProgress++;
      notes.push(...dirNotes);
      api.log(`шаг ${step}: подъём не вышел: ${pc.why}${dirNotes.length ? ' | ' + dirNotes.join(' | ') : ''}`);
      if (blockFail) { stopWhy = 'blocks'; break; }
      if (noProgress >= 3) { stopWhy = 'подняться не вышло: ' + pc.why; break; }
    }

    try { snap = await api.snapshot(); cur = floorPos(snap.position || cur); } catch (e) { /* пусто */ }
    await refreshInv(api, inv);
    const reached = cur.y >= goalY;
    const rest = Math.max(0, goalY - cur.y);
    const needRest = needBlocks(rest);
    const haveNow = blocksTotal(inv);
    let why;
    if (reached) why = `поднялась до ${cur.y} (цель ${goalY})`;
    else if (stopWhy === 'blocks') {
      why = `блоки кончились: поднялась до y=${cur.y} из ${goalY}, осталось ${rest} уровней, нужно ~${needRest} блоков (есть ${haveNow}, не хватает ${Math.max(0, needRest - haveNow)})`;
    } else why = stopWhy || `поднялась только до ${cur.y} из ${goalY}`;
    const out = {
      ok: reached,
      at: [cur.x, cur.y, cur.z],
      dug, placed, steps, pillars,
      goalY, start: [start.x, start.y, start.z], why,
      need: { blocks: need }, have: { blocks: haveNow },
      missing: { blocks: reached ? 0 : Math.max(0, needRest - haveNow) },
      notes: notes.slice(-6)
    };
    if (tx !== null && tz !== null) out.dist = { x: Math.abs(tx - cur.x), z: Math.abs(tz - cur.z) };
    if (!reached) out.error = why;
    return out;
  }
};
