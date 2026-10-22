// версия: была текущей на 22.10; как v2 + если ступень не дала подъёма — поднимается на месте
// climb_stairs — подъём из ямы/пещеры вверх ступень 1x1 в выбранном направлении.
//
// Ступень: пол в клетке (tx, y, tz) — на уровне ног мухи; выше (y+1, y+2) должно быть
// свободно; муха залезает на пол — ноги на y+1.
//
// План ступени (по порядку):
//   1) пол уже твёрдый (уступ или стена) — выкопать место в стене (dig_at) и залезть;
//   2) пол пустой — поставить его (place_at); если «не к чему прислонить» — сначала
//      поставить опору (снизу или сбоку, у опоры должен быть твёрдый сосед) и повторить;
//   3) опоры нет — подняться на месте (pillar_up) либо сменить направление.
//
// Каждая отказавшая клетка запоминается и больше не повторяется. Если высота не растёт
// stuck_limit шагов подряд — провал с причиной (поле error), а не кружение до конца steps.
//
// params: steps (40), dir (east|west|north|south), target_y (66), item (cobblestone),
//         from_y (стартовая высота ног), stuck_limit (3)
const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const ORDER = ['east', 'south', 'west', 'north'];
const PERP = { east: ['north', 'south'], west: ['north', 'south'], north: ['east', 'west'], south: ['east', 'west'] };
const ALIAS = { в: 'east', з: 'west', ю: 'south', с: 'north' };
const AIRY = /^(air|cave_air|void_air)$/;
const FLUID = /water|lava/;
const BLOCKS = ['cobblestone', 'dirt', 'coarse_dirt', 'stone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'sand', 'gravel', 'netherrack', 'spruce_log', 'spruce_planks'];

const cellKey = c => `${c.x},${c.y},${c.z}`;
const isSolid = b => !!b && b !== '?' && !AIRY.test(b) && !FLUID.test(b);

function n6(x, y, z) {
  return [
    { x: x + 1, y, z }, { x: x - 1, y, z }, { x, y: y + 1, z },
    { x, y: y - 1, z }, { x, y, z: z + 1 }, { x, y, z: z - 1 }
  ];
}

// Чтение survey: cell(x,y,z) -> имя блока | '?' (не видно)
function gridOf(sv) {
  const o = sv.origin || { x: 0, y: 0, z: 0 };
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

// Из чего строить пол: просят item — берём его, но если его нет, берём любой блок
// (на месте часто только spruce_log/dirt) и честно пишем об этом в лог.
function pickBlock(inv, want) {
  const count = n => inv.reduce((s, i) => s + (i.name === n ? (i.count || 0) : 0), 0);
  if (want && count(want) > 0) return { item: want, swapped: false };
  const alt = BLOCKS.find(n => count(n) > 0);
  if (!alt) return null;
  return { item: alt, swapped: !!want };
}

// Опора под ступень: поставить блок рядом/снизу, чтобы у клетки пола появился твёрдый сосед.
async function putSupport(api, g, T, pos, item) {
  const cands = [
    { x: T.x, y: T.y - 1, z: T.z },
    { x: T.x - 1, y: T.y, z: T.z },
    { x: T.x + 1, y: T.y, z: T.z },
    { x: T.x, y: T.y, z: T.z - 1 },
    { x: T.x, y: T.y, z: T.z + 1 }
  ];
  const tried = [];
  for (const c of cands) {
    if (c.x === pos.x && c.y === pos.y && c.z === pos.z) { tried.push(`${cellKey(c)} — клетка мухи`); continue; }
    const nm = g(c.x, c.y, c.z);
    if (isSolid(nm)) { tried.push(`${cellKey(c)} — занята (${nm})`); continue; }
    if (FLUID.test(String(nm))) { tried.push(`${cellKey(c)} — жидкость`); continue; }
    let anchor = null;
    for (const n of n6(c.x, c.y, c.z)) {
      const nb = g(n.x, n.y, n.z);
      if (isSolid(nb)) { anchor = nb; break; }
    }
    if (!anchor) { tried.push(`${cellKey(c)} — нет твёрдого соседа`); continue; }
    try {
      await api.cmd('place_at', { x: c.x, y: c.y, z: c.z, item });
      return { ok: true, at: cellKey(c) };
    } catch (e) {
      tried.push(`${cellKey(c)} — ${e.message}`);
    }
  }
  return { ok: false, why: 'опору поставить не удалось: ' + tried.join('; ') };
}

// Подъём на месте: столб под собой. Возвращает новую высоту ног или 0.
async function pillarUp(api) {
  try {
    const r = await api.cmd('pillar_up', { height: 1 });
    const yy = r && Number.isFinite(Number(r.y)) ? Math.floor(Number(r.y)) : 0;
    return yy > 0 ? yy : 0;
  } catch (e) {
    api.log('pillar_up не сработал: ' + e.message);
    return 0;
  }
}

module.exports = {
  name: 'climb_stairs',
  description: 'Подняться из ямы/пещеры вверх ступень 1x1 в выбранном направлении: ставит пол (с опорой, если «не к чему прислонить»), копает место в стене, при неудаче поднимается на месте (pillar_up) или меняет направление. Отказавшие клетки не повторяет, при застревании возвращает причину.',
  params: {
    steps: 'сколько ступеней максимум (по умолчанию 40)',
    dir: 'направление: east|west|north|south (по умолчанию east)',
    target_y: 'остановиться, когда ноги >= target_y (по умолчанию 66)',
    item: 'материал пола (по умолчанию cobblestone); если его нет в инвентаре — берётся любой блок (dirt, spruce_log…) и пишется в лог',
    from_y: 'стартовая высота ног, если муха стоит в яме (по умолчанию — из снимка)',
    stuck_limit: 'сколько шагов подряд без роста высоты считать застреванием (по умолчанию 3)'
  },
  async run(api, params) {
    const maxSteps = Math.max(1, Math.floor(Number(params.steps)) || 40);
    const targetY = Number.isFinite(Number(params.target_y)) ? Number(params.target_y) : 66;
    const stuckLimit = Math.max(1, Math.floor(Number(params.stuck_limit)) || 3);
    const wantItem = params.item ? String(params.item).trim() : 'cobblestone';
    const dirArg = params.dir ? String(params.dir).trim().toLowerCase() : '';
    const dirKey = DIRS[dirArg] ? dirArg : (ALIAS[dirArg] || '');
    const order = dirKey ? [dirKey].concat(PERP[dirKey]) : ORDER.slice();
    let dirIdx = 0;
    const fromY = (params.from_y !== undefined && params.from_y !== null && Number.isFinite(Number(params.from_y)))
      ? Number(params.from_y) : null;

    const failed = new Map();   // клетка -> причина отказа
    let noProgress = 0;
    let placed = 0, supports = 0, dug = 0, pillars = 0;
    let usedItem = null;
    let lastWhy = '';
    let curY = null, lastAt = null;

    const curDir = () => order[dirIdx % order.length];

    for (let step = 0; step < maxSteps; step++) {
      let snap;
      try { snap = await api.snapshot(); }
      catch (e) { return { ok: false, error: 'снимок тела не получился: ' + e.message, y: curY, targetY }; }
      const pos = { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) };
      let y = pos.y;
      if (step === 0 && fromY !== null) {
        if (Math.abs(fromY - pos.y) <= 1) y = fromY;
        else api.log(`from_y=${fromY}, а муха на ${pos.y} — беру реальную высоту`);
      }
      curY = y;
      lastAt = { x: pos.x, y, z: pos.z };
      if (y >= targetY) {
        return {
          ok: true, y, targetY, steps: step, at: lastAt, dir: curDir(), item: usedItem,
          placed, supports, dug, pillars
        };
      }

      // клетка ступени: не повторяем отклонённую
      let T = null;
      for (let k = 0; k < order.length; k++) {
        const d = order[(dirIdx + k) % order.length];
        const dv = DIRS[d];
        const cand = { x: pos.x + dv[0], y, z: pos.z + dv[1] };
        const ck = cellKey(cand);
        if (!failed.has(ck)) { T = cand; dirIdx = (dirIdx + k) % order.length; break; }
        api.log(`шаг ${step}: клетка ${ck} отклонена (${failed.get(ck)}) — беру другую`);
      }
      if (!T) {
        const why = [...failed.values()].slice(0, 3).join('; ');
        return {
          ok: false,
          error: `шаг ${step}: все клетки впереди отклонены (${why}); высота ${y}/${targetY}`,
          y, targetY, steps: step, at: lastAt, dir: curDir(), item: usedItem, placed, supports, dug, pillars
        };
      }
      const tk = cellKey(T);

      // осмотр места ступени
      let g;
      try {
        g = gridOf(await api.cmd('survey', {
          x1: T.x - 2, y1: T.y - 2, z1: T.z - 2, x2: T.x + 2, y2: T.y + 3, z2: T.z + 2
        }));
      } catch (e) {
        lastWhy = 'survey не удался: ' + e.message;
        api.log(`шаг ${step}: ${lastWhy}`);
        failed.set(tk, lastWhy);
        continue;
      }
      const below = g(T.x, T.y - 1, T.z);
      const floor = g(T.x, T.y, T.z);
      const head1 = g(T.x, T.y + 1, T.z);
      const head2 = g(T.x, T.y + 2, T.z);
      const fluidAt = [below, floor, head1, head2].find(b => FLUID.test(String(b)));
      if (fluidAt) {
        return {
          ok: false,
          error: `лава/вода (${fluidAt}) в колонке ${tk} — стоп, высота ${y}/${targetY}`,
          y, targetY, steps: step, at: lastAt, dir: curDir(), item: usedItem, placed, supports, dug, pillars
        };
      }

      // пол ступени
      let how = '';
      if (isSolid(floor)) {
        how = 'пол уже есть';
      } else {
        const pick = pickBlock(snap.inventory || [], wantItem);
        if (!pick) {
          lastWhy = `нет блоков для пола (хотели ${wantItem})`;
          api.log(`шаг ${step}: ${lastWhy} — клетка ${tk} отклонена`);
          failed.set(tk, lastWhy);
          continue;
        }
        if (pick.swapped) api.log(`шаг ${step}: ${wantItem} в инвентаре нет — беру ${pick.item}`);
        if (usedItem !== pick.item) { usedItem = pick.item; api.log(`материал пола: ${usedItem}`); }
        let ok = false, why = '';
        try {
          await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item: pick.item });
          ok = true; placed++; how = `поставил пол ${pick.item}`;
        } catch (e) {
          why = e.message;
          if (/не к чему прислонить/.test(why)) {
            const sup = await putSupport(api, g, T, pos, pick.item);
            if (sup.ok) {
              supports++;
              try {
                await api.cmd('place_at', { x: T.x, y: T.y, z: T.z, item: pick.item });
                ok = true; placed++; how = `поставил опору ${sup.at} и пол ${pick.item}`;
              } catch (e2) {
                why = 'опора поставлена, но пол не поставился: ' + e2.message;
              }
            } else {
              why = sup.why;
            }
          } else if (/занят/.test(why)) {
            ok = true; how = 'место пола занято — ступень готова';
          }
        }
        if (!ok) {
          api.log(`шаг ${step}: пол ${tk} не поставился — ${why}`);
          const up = await pillarUp(api);
          if (up > 0) {
            pillars++; noProgress = 0; lastWhy = '';
            api.log(`шаг ${step}: поднялась на месте до ${up}`);
            continue;
          }
          lastWhy = why;
          failed.set(tk, why);
          continue;
        }
      }

      // место над ступенью
      let digWhy = '';
      for (const yy of [T.y + 1, T.y + 2]) {
        const nm = g(T.x, yy, T.z);
        if (!isSolid(nm)) continue;
        try {
          await api.cmd('dig_at', { x: T.x, y: yy, z: T.z });
          dug++;
          api.log(`шаг ${step}: выкопал ${T.x},${yy},${T.z}`);
        } catch (e) {
          digWhy = `не выкопал ${T.x},${yy},${T.z}: ${e.message}`;
          api.log(`шаг ${step}: ${digWhy}`);
        }
      }
      if (digWhy) {
        const up = await pillarUp(api);
        if (up > 0) {
          pillars++; noProgress = 0; lastWhy = '';
          api.log(`шаг ${step}: поднялась на месте до ${up}`);
          continue;
        }
        lastWhy = digWhy;
        failed.set(tk, digWhy);
        continue;
      }

      // залезть на ступень
      try {
        await api.cmd('goto', { x: T.x, y: T.y + 1, z: T.z, timeout: 12 });
      } catch (e) {
        lastWhy = `не залезла на ступень ${tk}: ${e.message}`;
        api.log(`шаг ${step}: ${lastWhy}`);
        const up = await pillarUp(api);
        if (up > 0) {
          pillars++; noProgress = 0; lastWhy = '';
          api.log(`шаг ${step}: поднялась на месте до ${up}`);
          continue;
        }
        failed.set(tk, lastWhy);
        continue;
      }

      // итог шага
      let after;
      try { after = await api.snapshot(); }
      catch (e) {
        return {
          ok: false, error: `шаг ${step}: снимок после подъёма не получился: ${e.message}`,
          y, targetY, steps: step + 1, at: lastAt, dir: curDir(), item: usedItem, placed, supports, dug, pillars
        };
      }
      const ny = Math.floor(after.position.y);
      lastAt = { x: Math.floor(after.position.x), y: ny, z: Math.floor(after.position.z) };
      if (dirKey && dirIdx !== 0) dirIdx = 0;   // вернуться к запрошенному направлению
      if (ny > y) {
        noProgress = 0;
        api.log(`шаг ${step}: ступень ${tk} — ${how}; ноги ${ny} (было ${y})`);
      } else {
        // goto прошёл, а ноги не выросли — поднимаемся на месте (проверенный приём мухи)
        const up = await pillarUp(api);
        if (up > 0) {
          pillars++; noProgress = 0; lastWhy = '';
          api.log(`шаг ${step}: ступень ${tk} не дала подъёма (ноги ${ny}) — поднялась на месте до ${up}`);
          continue;
        }
        noProgress++;
        lastWhy = `не поднялась: ноги ${ny}, было ${y} (клетка ${tk})`;
        api.log(`шаг ${step}: ${lastWhy}`);
        if (noProgress >= stuckLimit) {
          return {
            ok: false,
            error: `застряла: шаг ${step}, клетка ${tk}, ${lastWhy}; высота ${ny}/${targetY}, подряд без роста ${noProgress}`,
            y: ny, targetY, steps: step + 1, at: lastAt, dir: curDir(), item: usedItem,
            placed, supports, dug, pillars, failed: [...failed.entries()].slice(-5)
          };
        }
      }
    }

    return {
      ok: false,
      error: `за ${maxSteps} шагов поднялась только до ${curY}/${targetY}${lastWhy ? '; последняя причина: ' + lastWhy : ''}`,
      y: curY, targetY, steps: maxSteps, at: lastAt, dir: curDir(), item: usedItem,
      placed, supports, dug, pillars, failed: [...failed.entries()].slice(-5)
    };
  }
};
