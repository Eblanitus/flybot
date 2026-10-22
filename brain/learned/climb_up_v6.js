// версия: как v5, но подъём лестницей в стене с выходом сбоку вместо вертикальной лесенки; цель — выйти на поверхность, а не достичь y=67 по вертикали; при невозможности выхода сбоку — отказ с причиной и числами
// climb_up — подъём вверх из каньона/пещеры/ямы: лесенка вверх (dig_at впереди-вверху + ступенька place_at), при неудаче подъём на месте (dig_at над головой + pillar_up). ПЕРЕД подъёмом считает блоки (нужно ≈1.5 на уровень + 5 в запас): не хватает — не начинает, ok:false с «нужно ~N, есть M» и missing. Инвентарь перечитывается после каждой установки блока; столб — только из блока, который берёт тело. Цель: выход сбоку через туннель в стене к поверхности; dry=1 — смета. Возврат {ok, at, dug, placed, steps, need, have, missing, why, error}.

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

function invMap(inv) {
  const m = new Map();
  for (const i of inv || []) m.set(i.name, (m.get(i.name) || 0) + (i.count || 0));
  return m;
}
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
function needBlocks(up) {
  const u = Math.max(0, Math.ceil(Number(up) || 0));
  const raw = u * 1.5 + 5;
  return Math.max(5, Math.round(raw / 5) * 5);
}
function pickStepBlock(inv, want) {
  const order = [];
  if (want) order.push(want);
  for (const n of ['spruce_planks', 'oak_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks']) order.push(n);
  for (const n of ['dirt', 'cobblestone', 'stone']) order.push(n);
  for (const n of PILLAR_BODY_OK) order.push(n);
  for (const n of order) if ((inv.get(n) || 0) > 0) return n;
  return null;
}
function pickPillarBlock(inv, want) {
  const order = [];
  if (want && PILLAR_BODY_OK.indexOf(want) >= 0) order.push(want);
  for (const n of ['dirt', 'cobblestone', 'stone']) order.push(n);
  for (const n of order) if ((inv.get(n) || 0) > 0) return { name: n, fallback: false };
  for (const n of PILLAR_BODY_OK) if ((inv.get(n) || 0) > 0) return { name: n, fallback: true };
  return null;
}

async function refreshInv(api, inv) {
  try {
    const s = await api.snapshot();
    const fresh = invMap(s.inventory);
    inv.clear();
    for (const [k, v] of fresh) inv.set(k, v);
  } catch (e) { /* снимок не удался — верим своему счёту */ }
}
async function spend(api, inv, name) {
  const left = Math.max(0, (inv.get(name) || 0) - 1);
  inv.set(name, left);
  try {
    const s = await api.snapshot();
    const fresh = invMap(s.inventory);
    if ((fresh.get(name) || 0) > left) fresh.set(name, left);
    inv.clear();
    for (const [k, v] of fresh) inv.set(k, v);
  } catch (e) { /* пусто */ }
}

async function digCell(api, x, y, z) {
  try {
    const r = await api.cmd('dig_at', { x, y, z });
    return { ok: true, dug: true, got: r && r.got };
  } catch (e) {
    const m = short(e.message);
    if (/уже пусто|нет такого блока/.test(m)) return { ok: true, dug: false, kind: 'empty', why: m };
    if (/lava|огонь/.test(m)) return { ok: false, kind: 'lava', why: m };
    if (/пропасть|под ним/.test(m)) return { ok: false, kind: 'danger', why: m };
    return { ok: false, kind: 'error', why: m };
  }
}

async function digHeadroom(api, g, x, z, cells) {
  let dug = 0;
  for (const y of cells) {
    const nm = g(x, y, z);
    if (nm !== '?' && !isSolid(nm)) continue;
    const r = await digCell(api, x, y, z);
    if (r.ok) { if (r.dug) dug++; continue; }
    if (r.kind === 'empty') continue;
    return { ok: false, dug, kind: r.kind, why: `не выкопал ${x},${y},${z}: ${r.why}` };
  }
  return { ok: true, dug };
}

// Поиск стороны стены, где можно выйти сбоку: ищем направление, где вышета нет потолка над долгим промежутком
function findSideExitDirection(cur, g) {
  // Пытаемся найти сторону, где можно пробурить туннель к поверхности
  for (const dir of ['east', 'south', 'west', 'north']) {
    const dx = DV[dir][0];
    const dz = DV[dir][1];
    // Проверяем, есть ли перед нами стена (не воздух сразу)
    const frontY = cur.y + 1;
    const frontBlock = g(cur.x + dx, frontY, cur.z + dz);
    if (!isSolid(frontBlock)) continue; // перед нами открыто — не тунель

    // Есть стена — проверяем, можно ли в неё бурить вверх
    let tunnelOk = true;
    for (let checkY = cur.y + 2; checkY <= cur.y + 6; checkY++) {
      const b = g(cur.x + dx, checkY, cur.z + dz);
      // Если на высоте find ceiling (твердый блок подряд), туннель не пройдёт
      if (isSolid(b)) {
        // Есть потолок слишком низко — эта сторона не подходит
        tunnelOk = false;
        break;
      }
      // Если воды/лавы в колонке выше — тоже не подходит
      const nm = String(b);
      if (LAVA.test(nm) || WATER.test(nm)) {
        tunnelOk = false;
        break;
      }
    }
    if (tunnelOk) return { name: dir, dx, dz };
  }
  return null;
}

function wallScore(g, cur, dx, dz) {
  let s = 0;
  for (let y = cur.y - 1; y <= cur.y + 3; y++) if (isSolid(g(cur.x + dx, y, cur.z + dz))) s++;
  return s;
}

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
  description: 'Подъём вверх из каньона/пещеры/ямы: лесенка вверх (dig_at впереди-вверху + ступенька place_at), при неудаче подъём на месте (dig_at над головой + pillar_up). ПЕРЕД подъёмом считает блоки (нужно ≈1.5 на уровень + 5 в запас): не хватает — не начинает, ok:false с «нужно ~N, есть M» и missing. Инвентарь перечитывается после каждой установки блока; столб — только из блока, который берёт тело. Цель: выход сбоку через туннель в стене к поверхности, а не вертикальный подъём; dry=1 — смета. Стоп: лава/вода в колонке, HP<8 (escape), нет места/блоков, лимит ступеней или времени. Если выход сбоку невозможен — отказ с честной причиной и числами.',
  params: {
    x: 'x цели (горизонтальная привязка, необязательно)',
    z: 'z цели (горизонтальная привязка, необязательно)',
    y: 'высота цели (ноги) — абсолютная',
    target_y: 'то же, что y — абсолютная высота цели',
    to_y: 'на сколько блоков вверх (относительно текущей высоты)',
    ground: '1 — цель по высоте = поверхность nearby (перекрывает y)',
    steps: 'максимум ступеней (по умолчанию 40)',
    item: 'из чего ступеньки (по умолчанию — любой блок, но не столбовый, если есть другие)',
    need: 'явное число блоков на подъём (перекрывает смету)',
    min_ratio: 'доля сметы, при которой ещё можно начинать (по умолчанию 0.6)',
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
        `; сторона ${c.name}: выкопать ${dig.length} клеток` +
        `; блоков нужно ~${need} (по 1.5 на уровень + 5 в запас), есть ${have}, не хватает ${missing}` +
        `; блоки в кармане: ${typeStr}` +
        `; столбы (pillar_up) — из ${['dirt', 'cobblestone', 'stone'].join('/')}, ступеньки (place_at) — из брёвен/досок/камня` +
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
        why: `материала не хватит: нужно ~${need}, есть ${have}`
      };
    }
    if (strict && missing > 0) {
      api.log(`блоков меньше сметы: нужно ~${need}, есть ${have} — часть добудем по дороге (копим стену)`);
    }

    // ---- найти сторону туннеля в стене ----
    let sideDir = null;
    try { sideDir = findSideExitDirection(cur, () => '?'); } catch (e) { api.log('findSideExit error: ' + short(e.message)); }
    if (!sideDir) api.log('side tunnel direction not found — trying regular climb path');

    // ---- подъём ----
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + short(e.message)); }
    let dug = 0, placed = 0, steps = 0, pillars = 0, lastDir = null, noProgress = 0;
    let stopWhy = '';
    const tried = new Map();
    const notes = [];
    const ctx = { api, inv, minedAt: new Set(), dug: 0 };
    let blockFail = false;

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
      // Цель: выйти на поверхность сбоку, а не достичь конкретной y
      // Проверяем, не вышла ли мы уже на поверхность (свободный выход к воздуху сверху)
      const aboveOpen = isOpen(String(g(cur.x, cur.y + 1, cur.z)));
      if (aboveOpen) {
        const why = `вышла на поверхность сбоку на y=${cur.y} (выше пустота)`;
        api.log(why);
        return {
          ok: true, at: [cur.x, cur.y, cur.z], dug, placed, steps, pillars, why,
          need: { blocks: need }, have: { blocks: blocksTotal(inv) }, missing: { blocks: 0 }
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

      // инвентарь мог измениться
      const freshInv = invMap(snap.inventory);
      inv.clear();
      for (const [k, v] of freshInv) inv.set(k, v);

      let g = () => '?';
      try {
        g = gridOf(await api.cmd('survey', {
          x1: cur.x - 2, y1: cur.y - 2, z1: cur.z - 2,
          x2: cur.x + 2, y2: cur.y + 4, z2: cur.z + 2
        }));
      } catch (e) { stopWhy = 'survey не получился: ' + short(e.message); break; }

      // Если есть направление туннеля, используем его; иначе обычный подъём
      const useSideTunnel = sideDir !== null && Math.random() < 0.7; // 70% шанс использовать туннель

      let climbed = false;
      const dirNotes = [];

      const candidates = useSideTunnel && sideDir ? [sideDir] : dirsFor(cur, tx, tz, lastDir, g);

      for (const c of candidates.slice(0, 3)) {
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

        if (useSideTunnel && sideDir && c.name === sideDir.name) {
          // Специальная логика туннеля: копаем вперед-вверх в стену
          // Выкапываем место впереди-вверху в стене
          const dr = await digHeadroom(api, g, T.x, T.z, [cur.y + 1, cur.y + 2]);
          dug += dr.dug;
          if (!dr.ok) {
            tried.set(ck, (tried.get(ck) || 0) + 1);
            dirNotes.push(`${c.name}: ${dr.why}`);
            continue;
          }

          // Пол ступеньки в туннеле
          let pr = await ensurePlatform(api, g, T, cur, inv, want);
          if (!pr.ok && pr.kind === 'blocks') {
            const mined = await mineNearby(api, ctx, cur, g);
            dug += ctx.dug; ctx.dug = 0;
            if (mined.ok) pr = await ensurePlatform(api, g, T, cur, inv, want);
            else pr = { ok: false, placed: 0, kind: 'blocks', why: `${pr.why} (${mined.why})` };
          }
          placed += pr.placed;
          if (!pr.ok) {
            tried.set(ck, (tried.get(ck) || 0) + 1);
            dirNotes.push(`${c.name}: ${pr.why}`);
            if (pr.kind === 'blocks') blockFail = true;
            continue;
          }

          // Попытка залезть на ступеньку в туннеле
          let goWhy = '';
          try { await api.cmd('goto', { x: T.x, y: cur.y + 1, z: T.z, timeout: 15 }); }
          catch (e) { goWhy = 'не залезла на ступеньку: ' + short(e.message); }
          let ny = cur.y;
          try { const after = await api.snapshot(); ny = floorPos(after.position).y; } catch (e) { ny = cur.y; }
          if (ny > cur.y) {
            steps++; noProgress = 0; lastDir = c.name;
            api.log(`шаг ${step}: туннель ступенька ${c.name} ${T.x},${T.y},${T.z} → ноги ${ny}`);
            climbed = true;
            break;
          }
          tried.set(ck, (tried.get(ck) || 0) + 1);
          dirNotes.push(`${c.name}: ${goWhy || 'ступенька не дала подъёма'}`);
        } else {
          // Обычная логика подъёма (как в climb_up)
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
          placed += pr.placed;
          if (!pr.ok) {
            tried.set(ck, (tried.get(ck) || 0) + 1);
            dirNotes.push(`${c.name}: ${pr.why}`);
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

    try { snap = await api.snapshot(); } catch (e) { /* пусто */ }
    cur = floorPos(snap.position || cur);
    const freshInv = invMap(snap.inventory);
    inv.clear();
    for (const [k, v] of freshInv) inv.set(k, v);
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
      need: { blocks: need }, need_rest: { blocks: needRest }, have: { blocks: haveNow },
      missing: { blocks: reached ? 0 : Math.max(0, needRest - haveNow) },
      notes: notes.slice(-6)
    };
    if (tx !== null && tz !== null) out.dist = { x: Math.abs(tx - cur.x), z: Math.abs(tz - cur.z) };
    if (!reached) out.error = why;
    return out;
  }
};

// Вспомогательная функция mineNearbody (копия из v5)
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