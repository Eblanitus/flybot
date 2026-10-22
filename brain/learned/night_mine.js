// версия: была текущей на 22.10; как v2 + днём отказ (кроме until=blocks); при тонком потолке углубляется на 1; отказ всегда с error
// night_mine — полезная работа ночью вместо простоя: безопасный горизонтальный туннель 1×2.
// С киркой копает камень и руду в стенах; без кирки (и если не из чего скрафтить) — руками берёт только
// мягкое (земля, гравий, песок, глина...). Заделывает выходы в пещеры, закрывает туннель за собой.
// Собран из навыков тела: survey, dig_at, place_at, look/move, equip_best, craft, shelter.
// Зрение честное: survey не видит сквозь породу ('?'), поэтому после каждой выкопанной клетки смотрим заново.

const DIRS = {
  north: { dx: 0, dz: -1, yaw: 0, ru: 'север' },
  east: { dx: 1, dz: 0, yaw: -Math.PI / 2, ru: 'восток' },
  south: { dx: 0, dz: 1, yaw: Math.PI, ru: 'юг' },
  west: { dx: -1, dz: 0, yaw: Math.PI / 2, ru: 'запад' }
};
const ORDER = ['north', 'east', 'south', 'west'];

const SOFT = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'dirt_path', 'gravel', 'sand', 'red_sand', 'clay', 'snow_block', 'mud']);
const STONE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'netherrack', 'sandstone', 'red_sandstone', 'terracotta', 'basalt', 'smooth_basalt', 'blackstone', 'dripstone_block', 'packed_mud']);
const UNSTABLE = new Set(['gravel', 'sand', 'red_sand']);
const AIRS = new Set(['air', 'cave_air', 'void_air']);
const FLUIDS = new Set(['water', 'lava', 'bubble_column']);
const NONSOLID = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|kelp|kelp_plant|torch|wall_torch|redstone_torch|cobweb|fire|soul_fire|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|[a-z]+_tulip|[a-z_]*carpet|[a-z_]*sapling|[a-z_]*button|[a-z_]*pressure_plate|[a-z_]*rail|ladder|[a-z_]*sign|brown_mushroom|red_mushroom|hanging_roots|pink_petals|leaf_litter|bush|sweet_berry_bush)$/;
const ORE = /_ore$/;
const SEAL_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'coarse_dirt', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'netherrack'];
const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 3 };

// какой кирки нужно для руды (0 дерево, 1 камень, 2 железо)
function oreTier(name) {
  const n = name.replace(/^deepslate_/, '');
  if (/^(coal|nether_gold|nether_quartz)_ore$/.test(n)) return 0;
  if (/^(copper|iron|lapis)_ore$/.test(n)) return 1;
  return 2; // золото, красный камень, алмаз, изумруд и т.п.
}

// как назвать открытую клетку в причине отказа
function openLabel(n) {
  if (AIRS.has(n)) return 'воздух';
  if (n === 'water' || n === 'bubble_column') return 'вода';
  if (n === 'lava') return 'лава';
  if (n === 'snow') return 'снежный слой (поверхность)';
  return n;
}

// тип клетки по имени блока; tier: уровень кирки, -1 = нет кирки
function kind(n, tier) {
  if (n === '?' || n === undefined) return 'unknown';
  if (AIRS.has(n) || FLUIDS.has(n) || NONSOLID.test(n)) return 'open';
  if (SOFT.has(n)) return 'soft';
  if (ORE.test(n)) return oreTier(n) <= tier ? 'ore' : 'oreHigh';
  if (STONE.has(n)) return 'stone';
  return 'other'; // бедрок, спавнер, сундук, брёвна, доски... — не копаем
}
const diggable = (kd, tier) => kd === 'soft' || (tier >= 0 && (kd === 'stone' || kd === 'ore'));
const key = (x, y, z) => x + ',' + y + ',' + z;

// сетка из ответа survey: g(x,y,z) -> имя блока | 'air' | '?'
function makeGrid(r) {
  const o = r.origin;
  return (x, y, z) => {
    const layer = r.layers && r.layers['y=' + y];
    if (!layer) return '?';
    const row = layer[z - o.z];
    if (!row) return '?';
    const ch = row[x - o.x];
    if (ch === undefined || ch === '?') return '?';
    return (r.legend && r.legend[ch]) || '?';
  };
}
async function scan(api, bx, by, bz, r, down, up) {
  const res = await api.cmd('survey', { x1: bx - r, y1: by - down, z1: bz - r, x2: bx + r, y2: by + up, z2: bz + r });
  if (!res || !res.layers) throw new Error('survey не вернул layers');
  return makeGrid(res);
}

// Оценка направления: идём туннелем 1×2 на 3 клетки вперёд. {ok, score, reason, hard}
function evalDir(g, bx, by, bz, d, tier) {
  const px = -d.dz, pz = d.dx; // перпендикуляр
  let score = 0;
  const bad = (reason, hard) => ({ ok: false, reason, hard: !!hard });
  for (let k = 1; k <= 3; k++) {
    const cx = bx + d.dx * k, cz = bz + d.dz * k;
    for (const hy of [0, 1]) {
      const n = g(cx, by + hy, cz);
      const kd = kind(n, tier);
      if (kd === 'open') return bad(`впереди на ${k} м ${openLabel(n)} (пустота/жидкость/поверхность)`);
      if (k <= 2 && kd !== 'unknown' && !diggable(kd, tier)) {
        const hard = tier < 0 && (kd === 'stone' || kd === 'ore' || kd === 'oreHigh');
        return bad(`впереди на ${k} м ${n}: ${hard ? 'без кирки не взять' : 'не копаем'}`, hard);
      }
      if (UNSTABLE.has(n) && UNSTABLE.has(g(cx, by + 2, cz))) return bad(`над ${n} впереди сыплется ещё`);
      if (kd === 'ore') score += 5;
      else if (kd === 'stone') score += 3;
      else if (kd === 'soft') score += tier >= 0 ? 1 : 3;
      else if (kd === 'unknown') score += 1;
    }
    if (k <= 2) {
      // стенки, потолок, пол будущего туннеля: пустота/жидкость = пещера, воздух над головой = поверхность
      const around = [[cx, by + 2, cz, 'потолок'], [cx, by - 1, cz, 'пол']];
      for (const hy of [0, 1]) for (const s of [1, -1]) around.push([cx + px * s, by + hy, cz + pz * s, 'стена']);
      for (const [x, y, z, what] of around) {
        const n = g(x, y, z);
        if (kind(n, tier) === 'open') return bad(`рядом с туннелем (${what}: ${openLabel(n)}) — пещера/вода/поверхность`);
        if (what === 'потолок' && UNSTABLE.has(n)) return bad('над туннелем гравий/песок — обвалится');
      }
    }
  }
  return { ok: true, score };
}

function findSeal(inv) {
  for (const name of SEAL_ITEMS) {
    const it = inv.find(i => i.name === name && i.count > 0);
    if (it) return it.name;
  }
  return null;
}
function invMap(inv) {
  const m = {};
  for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}

module.exports = {
  name: 'night_mine',
  description: 'Ночью (после shelter) вместо простоя: безопасный туннель 1×2 под землёй. С киркой — камень и руда в стенах; без кирки — крафтит деревянную из дерева, иначе берёт руками только мягкое (земля/гравий/песок/глина). Заделывает прорывы в пещеры, закрывает туннель за собой. Останавливается днём, при HP<8 (shelter), при полном инвентаре или max_blocks.',
  params: {
    max_blocks: 'сколько блоков выкопать максимум, по умолчанию 40',
    dir: 'north|south|east|west; по умолчанию выбирается сама, где впереди надёжная порода',
    until: '"day" (по умолчанию) — стоп с рассветом; "blocks" — только по max_blocks',
    max_sec: 'потолок по времени, по умолчанию 600'
  },
  async run(api, params) {
    const maxBlocks = Math.max(1, Math.floor(Number(params.max_blocks)) || 40);
    const untilDay = params.until !== 'blocks';
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 600;
    const deadline = Date.now() + maxSec * 1000;

    let snap = await api.snapshot();
    const startInv = invMap(snap.inventory);
    let mined = 0;
    const notes = [];
    const finish = async (reason, okOverride) => {
      let gained = {};
      try {
        const now = invMap((await api.snapshot()).inventory);
        for (const n of Object.keys(now)) { const d = now[n] - (startInv[n] || 0); if (d > 0) gained[n] = d; }
      } catch (e) { /* не страшно */ }
      const ok = okOverride !== undefined ? okOverride : mined > 0;
      api.log(`night_mine: ${ok ? 'ок' : 'нет'}, выкопано ${mined}, причина: ${reason}`);
      const out = { ok, mined, gained, reason, notes };
      if (!ok) out.error = 'night_mine: ' + reason; // раньше ok:false шёл без error — раннер писал «вернул ok:false без error»
      return out;
    };
    const emergency = async why => {
      api.log('аварийно: ' + why + ' -> shelter');
      try { await api.cmd('shelter', {}); } catch (e) { api.log('shelter: ' + e.message); }
      return finish(why + ' (укрылась shelter)');
    };

    if (untilDay) {
      const phase = snap.eyes && snap.eyes.time && snap.eyes.time.phase;
      if (phase === 'день' || phase === 'рассвет') { const why = 'сейчас ' + phase + ', а не ночь — навык для ночи (until:"blocks" копает и днём)'; return { ok: false, mined: 0, gained: {}, reason: why, error: 'night_mine: ' + why }; }
    }

    // --- кирка ---
    const tierOf = inv => {
      let t = -1;
      for (const i of inv || []) if (i.name in PICK_TIER) t = Math.max(t, PICK_TIER[i.name]);
      return t;
    };
    let tier = tierOf(snap.inventory);
    if (tier < 0) {
      const m = invMap(snap.inventory);
      let wood = 0;
      for (const n of Object.keys(m)) { if (/_log$/.test(n)) wood += m[n] * 4; else if (/_planks$/.test(n)) wood += m[n]; }
      if (wood >= 5) {
        api.log('кирки нет, дерево есть — крафчу деревянную');
        try {
          await api.cmd('craft', { item: 'wooden_pickaxe' });
          notes.push('скрафтила wooden_pickaxe');
          snap = await api.snapshot();
          tier = tierOf(snap.inventory);
        } catch (e) { api.log('craft wooden_pickaxe: ' + e.message); notes.push('кирку скрафтить не вышло: ' + e.message); }
      }
    }
    if (tier >= 0) {
      try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + e.message); }
    } else {
      notes.push('без кирки: только мягкие блоки');
    }

    const tunnel = new Set(); // воздушные клетки, которые мы сами выкопали (и где стоим)
    const blocked = new Set(); // `${x,y,z}|dir` — отказы на этом месте
    let dirName = Object.prototype.hasOwnProperty.call(DIRS, params.dir) ? params.dir : null;
    let steps = 0, fails = 0, sealedBehind = 0, sunk = 0;
    let first = true;
    const maxIter = maxBlocks * 3 + 30;

    // поставить блок в клетку; false при неудаче
    const place = async (x, y, z) => {
      const inv = (await api.snapshot()).inventory;
      const item = findSeal(inv);
      if (!item) { api.log('нечем заделывать: нет блоков'); return false; }
      try { await api.cmd('place_at', { x, y, z, item }); tunnel.delete(key(x, y, z)); return true; }
      catch (e) {
        api.log(`place_at ${x} ${y} ${z}: ${e.message}`);
        // клетка уже твёрдая (survey видел её старой) — проход и так закрыт
        if (/занято/.test(e.message) && !/air|water|lava/.test(e.message)) { tunnel.delete(key(x, y, z)); return true; }
        return false;
      }
    };

    for (let iter = 0; iter < maxIter; iter++) {
      snap = await api.snapshot();
      if (mined >= maxBlocks) return finish('выкопано max_blocks');
      if (Date.now() > deadline) return finish('вышло время max_sec');
      if (untilDay) {
        const phase = snap.eyes && snap.eyes.time && snap.eyes.time.phase;
        if (phase === 'день' || phase === 'рассвет') return finish('наступил день', true);
      }
      if (typeof snap.health === 'number' && snap.health < 8) return emergency('hp < 8');
      if ((snap.inventory || []).filter(i => i.slot >= 9 && i.slot <= 44).length >= 36) return finish('инвентарь полон');

      const p = snap.position;
      const bx = Math.floor(p.x), by = Math.floor(p.y + 0.001), bz = Math.floor(p.z);
      if (first) { tunnel.add(key(bx, by, bz)); tunnel.add(key(bx, by + 1, bz)); first = false; }

      let g;
      try { g = await scan(api, bx, by, bz, 4, 3, 3); }
      catch (e) { api.log('survey: ' + e.message); if (++fails >= 4) return finish('survey не работает: ' + e.message); await api.sleep(500); continue; }

      // --- выбор направления ---
      const here = key(bx, by, bz);
      const evalAll = () => {
        const res = {};
        for (const n of ORDER) res[n] = blocked.has(here + '|' + n) ? { ok: false, reason: 'ранее отказ здесь' } : evalDir(g, bx, by, bz, DIRS[n], tier);
        return res;
      };
      let evals = evalAll();
      if (!dirName || !evals[dirName].ok) {
        if (dirName) api.log(`направление ${DIRS[dirName].ru} не годится: ${evals[dirName].reason}`);
        let best = null;
        for (const n of ORDER) if (evals[n].ok && (!best || evals[n].score > evals[best].score)) best = n;
        if (!best) {
          // потолок тонкий (над туннелем поверхность/воздух), а под ногами копаемая порода — углубиться на 1 вниз и посмотреть заново
          if (sunk < 2 && ORDER.some(n => /потолок/.test(evals[n].reason || ''))) {
            const kb = kind(g(bx, by - 1, bz), tier), kb2 = kind(g(bx, by - 2, bz), tier);
            const sideOpen = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => kind(g(bx + ox, by - 1, bz + oz), tier) === 'open');
            if (diggable(kb, tier) && kb2 !== 'open' && kb2 !== 'unknown' && !sideOpen) {
              try {
                await api.cmd('dig_at', { x: bx, y: by - 1, z: bz });
                sunk++; notes.push('потолок тонкий — углубилась на 1 вниз');
                api.log('потолок тонкий — копаю на 1 вниз и смотрю заново');
                await api.sleep(700);
                continue;
              } catch (e) { api.log('углубиться не вышло: ' + e.message); }
            }
          }
          const reasons = ORDER.map(n => `${DIRS[n].ru}: ${evals[n].reason}`).join('; ');
          if (tier < 0 && ORDER.some(n => evals[n].hard)) {
            return finish('без кирки вокруг только камень (' + reasons + ')', mined > 0);
          }
          const allOpen = ORDER.every(n => /пустота|пещера|воздух|вода|лава|поверхность|снежный/.test(evals[n].reason || ''));
          const hint = allOpen && mined === 0 ? ' [вокруг воздух/поверхность: туннель 1×2 копается только в сплошной породе — сначала спустись на 3+ блока под поверхность (mine_stairs) или выйди из пещеры]' : '';
          return finish('нет безопасного направления: ' + reasons + hint, mined > 0);
        }
        dirName = best;
        api.log(`копаю на ${DIRS[dirName].ru}, оценка ${evals[best].score}`);
      }
      const d = DIRS[dirName];
      const f = { x: bx + d.dx, z: bz + d.dz };

      // --- руда в стенах (только если кирка её берёт); не трогаем клетки пути, ими займётся основной шаг ---
      if (tier >= 0) {
        const eye = { x: bx + 0.5, y: by + 1.62, z: bz + 0.5 };
        const ores = [];
        for (let x = bx - 3; x <= bx + 3; x++) for (let z = bz - 3; z <= bz + 3; z++) for (let y = by - 2; y <= by + 3; y++) {
          const n = g(x, y, z);
          if (kind(n, tier) !== 'ore') continue;
          if (x === f.x && z === f.z && (y === by || y === by + 1)) continue;
          const dist = Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z);
          if (dist > 3.6) continue;
          const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(v => [x + v[0], y + v[1], z + v[2]]);
          if (!nb.some(c => tunnel.has(key(...c)))) continue; // ищем только руду, касающуюся нашего туннеля
          // за рудой не должно быть пустоты (кроме нашего туннеля)
          if (nb.some(c => !tunnel.has(key(...c)) && kind(g(...c), tier) === 'open')) { api.log(`руда ${n} ${x} ${y} ${z} выходит в пещеру — пропускаю`); continue; }
          ores.push({ x, y, z, n, dist });
        }
        ores.sort((a, b) => a.dist - b.dist);
        for (const o of ores.slice(0, 3)) {
          if (mined >= maxBlocks) break;
          try {
            await api.cmd('dig_at', { x: o.x, y: o.y, z: o.z });
            mined++;
            tunnel.add(key(o.x, o.y, o.z));
            api.log(`добыла ${o.n}`);
          } catch (e) { api.log(`руда ${o.n}: ${e.message}`); continue; }
          // не открылась ли дыра в пещеру
          await api.sleep(250);
          try {
            const g2 = await scan(api, bx, by, bz, 4, 3, 3);
            const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
            if (nb.some(v => { const c = [o.x + v[0], o.y + v[1], o.z + v[2]]; return !tunnel.has(key(...c)) && kind(g2(...c), tier) === 'open'; })) {
              api.log('дыра от руды выходит в пустоту — заделываю');
              if (!(await place(o.x, o.y, o.z))) return emergency('не удалось заделать дыру от руды');
            }
          } catch (e) { api.log('проверка после руды: ' + e.message); }
        }
        if (mined >= maxBlocks) continue;
      }

      // --- копаем две клетки впереди: на уровне ног и головы ---
      let digFailed = false;
      for (const hy of [0, 1]) {
        const n = g(f.x, by + hy, f.z);
        if (kind(n, tier) === 'open') continue;
        try {
          await api.cmd('dig_at', { x: f.x, y: by + hy, z: f.z });
          mined++;
        } catch (e) {
          api.log(`dig_at ${f.x} ${by + hy} ${f.z}: ${e.message}`);
          blocked.add(here + '|' + dirName);
          digFailed = true;
          if (!/лав|lava|refus|отказ/i.test(e.message) && ++fails >= 5) return finish('копание не получается: ' + e.message);
          break;
        }
      }
      if (digFailed) { dirName = null; continue; }

      // --- проверка: не прорвались ли в пещеру / воду / на поверхность ---
      await api.sleep(250);
      let g2;
      try { g2 = await scan(api, bx, by, bz, 4, 3, 3); }
      catch (e) { api.log('survey после копания: ' + e.message); if (++fails >= 4) return emergency('survey отказал'); continue; }
      const px = -d.dz, pz = d.dx;
      const cells = [
        [f.x + d.dx, by, f.z + d.dz], [f.x + d.dx, by + 1, f.z + d.dz],
        [f.x + px, by, f.z + pz], [f.x - px, by, f.z - pz],
        [f.x + px, by + 1, f.z + pz], [f.x - px, by + 1, f.z - pz],
        [f.x, by + 2, f.z], [f.x, by - 1, f.z]
      ];
      const breach = cells.find(c => kind(g2(...c), tier) === 'open');
      const f1 = g2(f.x, by, f.z), h1 = g2(f.x, by + 1, f.z);
      if (breach) {
        api.log(`прорыв: ${g2(...breach)} в ${breach.join(' ')} — заделываю и ухожу в сторону`);
        let ok = true;
        for (const hy of [0, 1]) if (kind(g2(f.x, by + hy, f.z), tier) === 'open') ok = (await place(f.x, by + hy, f.z)) && ok;
        if (!ok) return emergency('не удалось заделать прорыв');
        blocked.add(here + '|' + dirName);
        notes.push(`прорыв (${g2(...breach)}) на ${f.x} ${by} ${f.z}: заделан`);
        dirName = null;
        continue;
      }
      if (kind(f1, tier) !== 'open' || kind(h1, tier) !== 'open') {
        // сыпучий блок упал обратно или не докопали — повторим на следующем круге
        if (++fails >= 6) return finish('не получается освободить клетки впереди');
        continue;
      }
      tunnel.add(key(f.x, by, f.z)); tunnel.add(key(f.x, by + 1, f.z));

      // --- шаг вперёд: развернуться и пройти ~1 клетку (упираемся в породу впереди) ---
      let moved = false;
      for (let attempt = 0; attempt < 2 && !moved; attempt++) {
        try {
          await api.cmd('look', { yaw: d.yaw, pitch: 0 });
          await api.cmd('move', { dir: 'forward', ms: 350 });
        } catch (e) { api.log('шаг: ' + e.message); }
        const s2 = (await api.snapshot()).position;
        moved = Math.floor(s2.x) === f.x && Math.floor(s2.z) === f.z && Math.floor(s2.y + 0.001) === by;
        if (!moved && Math.floor(s2.y + 0.001) !== by) { blocked.add(here + '|' + dirName); break; }
      }
      if (!moved) {
        if (++fails >= 5) return finish('не удаётся пройти вперёд по туннелю');
        continue;
      }
      fails = 0;
      steps++;

      // --- каждые 4 шага закрываем туннель за спиной (через 2 клетки от себя) ---
      if (steps % 4 === 0) {
        const sx = f.x - d.dx * 2, sz = f.z - d.dz * 2;
        for (const hy of [0, 1]) {
          if (!tunnel.has(key(sx, by + hy, sz))) continue;
          if (await place(sx, by + hy, sz)) sealedBehind++;
        }
      }
    }
    if (sealedBehind) notes.push('закрыто за спиной блоков: ' + sealedBehind);
    return finish('исчерпан лимит шагов');
  }
};
