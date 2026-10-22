// версия: как chest_open_v6, но ok:false когда сундука нет (не ok с blocker), и один отказ на один факт; если контейнер найден по памяти/глазам — отвечает subst и что в нём, не выдавая за успех; всегда факт о реально сделано: контейнер открыт / только подготовка / не найден
// chest_open — подготовить муху к открытию сундука и сказать, что мешает (или найти, где сундук).
// Сам контейнер не открывает: это делают навыки chest_take / chest_store через этот навык.
// Что проверяет (главные причины, почему сундук не открывается):
//   • над сундуком блок — сервер не откроет сундук, пока сверху занято (можно выкопать сам: dig_above=1);
//   • сбоку занято — некуда встать; муха не на уровне сундука;
//   • в руке блок: с блоком в руке сервер ставит блок вместо открытия контейнера.
// Что изменилось против v6:
//   • ok:false когда контейнер не найден по координатам — счет версии не растёт от подготовок;
//   • один факт на отказ: «по координатам X Y Z сундука нет» + что известно о клетке + что делать;
//   • если контейнер найден Eyes/память — в ответе subst: какой контейнер, что внутри, не считается успехом;
//   • в note всегда указано: контейнер открыт / только подготовка / не найден;
//   • blocker — только реальные препятствия, а не «pomaha ne polomka».
// Итог: {ok:false, error, chest, ready, blocker, fly, faces, above, held, dugAbove, found, note, subst?} при провале;
//         {ok:true, chest, ready, blocker, fly, faces, above, held, dugAbove, found, note, subst?} когда контейнер готов к взятию.

const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|snow_layer|dandelion|poppy|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|blue_orchid|red_tulip|white_tulip|orange_tulip|pink_tulip|purple_tulip|white_dandelion|sugar_cane|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|cobweb|lily_pad)$/;
const CHESTS = /^(chest|trapped_chest|barrel)$/;
const CONTAINERS = /^(chest|trapped_chest|barrel|hopper|furnace|blast_furnace|smoker|dispenser|dropper|[a-z_]*shulker_box)$/;
const SIDES = [{ dx: 1, dz: 0, dir: 'В' }, { dx: -1, dz: 0, dir: 'З' }, { dx: 0, dz: 1, dir: 'Ю' }, { dx: 0, dz: -1, dir: 'С' }];
const TOOL = /(_pickaxe|_axe|_sword|_shovel|_hoe)$|^bow$|^crossbow$/;
const FOOD = /^(cooked_[a-z_]+|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|golden_apple|golden_carrot|carrot|potato|baked_potato|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|suspicious_stew|honey_bottle)$/;
const PLAIN = /^(stick|string|coal|charcoal|bone|arrow|bucket|water_bucket|lava_bucket|egg|snowball|glowstone_dust|redstone|lapis_lazuli|quartz|diamond|emerald|iron_ingot|gold_ingot|copper_ingot|netherite_ingot|raw_iron|raw_gold|raw_copper|leather|feather|flint|gunpowder|blaze_powder|spider_eye|rotten_flesh|slime_ball|ender_pearl|paper|book|ink_sac|clay_ball|brick|nether_brick|flint_and_steel|shears|fishing_rod|wheat|wheat_seeds|lead|name_tag|saddle|experience_bottle|glass_bottle|map|compass|clock|iron_nugget|gold_nugget|music_disc_\d+)$/;

const handOk = n => TOOL.test(n) || FOOD.test(n) || PLAIN.test(n);
const solid = n => n !== '?' && !AIRLIKE.test(n) && n !== 'water' && n !== 'lava';
const flag = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  return !(v === 0 || v === '0' || v === false || v === 'false' || v === 'no' || v === 'off');
};
const sameAt = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function grid(sv) {
  const org = (sv && sv.origin) || { x: 0, y: 0, z: 0 };
  return (x, y, z) => {
    const rows = sv && sv.layers && sv.layers['y=' + y];
    if (!rows) return '?';
    const row = rows[z - org.z];
    if (!row) return '?';
    const ch = row[x - org.x];
    if (ch === undefined || ch === '?') return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}

function pickHand(inv) {
  const list = Array.isArray(inv) ? inv : [];
  const score = n => (TOOL.test(n) ? 0 : FOOD.test(n) ? 1 : PLAIN.test(n) ? 2 : 9);
  let best = null;
  for (const it of list) {
    if (!it || !it.name) continue;
    const s = score(it.name);
    if (s === 9) continue;
    if (!best || s < best.s) best = { name: it.name, s };
    if (s === 0) break;
  }
  return best ? best.name : null;
}

// список известных контейнеров из памяти тела
async function knownList(api, snap, item, log) {
  const out = [];
  const seen = new Set();
  const push = (at, d, dir, src, extra) => {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return;
    const ati = at.map(v => Math.floor(v));
    const key = ati.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign({ at: ati, src }, d != null && Number.isFinite(d) ? { d: Math.round(d) } : {}, dir ? { dir } : {}, extra || {}));
  };
  const b = snap && snap.eyes && snap.eyes.blocks && snap.eyes.blocks.chest;
  if (b && Array.isArray(b.at) && b.at.length === 3) push(b.at.map(v => Math.floor(Number(v))), Number(b.d), b.dir, 'глаза');
  const mem = String((snap && snap.memory) || '');
  for (const m of mem.matchAll(/сундук\s+(\d+)м\s+\S+\s+(-?\d+),(-?\d+),(-?\d+)/g)) {
    push([Number(m[2]), Number(m[3]), Number(m[4])], Number(m[1]), undefined, 'память');
  }
  if (item) {
    try {
      const w = await api.cmd('where', { item: String(item) });
      for (const p of (w && w.places) || []) {
        if (p && p.where === 'chest') push(p.at, Number(p.dist), p.dir, 'память предметов', { item: p.item, count: p.count });
      }
    } catch (e) { log('where: ' + String(e.message).slice(0, 100)); }
  }
  return out.slice(0, 6);
}

// найти ближайший известный контейнер (один проход, без перебора)
async function seek(api, snap, excludeAt, log) {
  const b = snap && snap.eyes && snap.eyes.blocks && snap.eyes.blocks.chest;
  if (b && Array.isArray(b.at) && b.at.length === 3) {
    const at = b.at.map(v => Math.floor(Number(v)));
    if (at.every(Number.isFinite) && !sameAt(at, excludeAt)) {
      return { at, d: Number.isFinite(Number(b.d)) ? Number(b.d) : null, how: 'вижу глазами' };
    }
  }
  try {
    const g = await api.cmd('goto_known', { kind: 'chest', timeout: 30 });
    if (g && Array.isArray(g.at) && g.at.length === 3) {
      const at = g.at.map(v => Math.floor(Number(v)));
      if (at.every(Number.isFinite) && !sameAt(at, excludeAt)) {
        return { at, d: Number.isFinite(Number(g.distNow)) ? Number(g.distNow) : null, how: 'по памяти тела' };
      }
    }
  } catch (e) { log('goto_known chest: ' + String(e.message).slice(0, 120)); }
  return null;
}

module.exports = {
  name: 'chest_open',
  description: 'Вспомогательный: найти сундук, подойти, осмотреть вокруг и сказать, что мешает (над сундумом блок / сбоку занято / муха не на уровне / в руке блок). Если по заданным координатам сундука нет — возвращает ok:false с error о мире; нашёл ближайший известный — готовит его с subst; сундук не найден вовсе — known из памяти тела. Сам контейнер не открывает — зови chest_take или chest_store.',
  params: {
    x: 'x сундука (необязательно; иначе — найдёт глазами или известный)',
    y: 'y сундука', z: 'z сундука',
    search: '1 (по умолчанию) — ищет ближайший известный контейнер при отсутствии по координатам; 0 — сразу отказ',
    item: 'что хотим из сундука (необязательно; — чтобы в known написать, где предмет лежит по памяти)',
    dig_above: '0 — не копать; 1 (по умолчанию) — выкопать мягкий блок над сундуком (земля/снег/листва); 2 любой (кроме контейнера)',
    hand: 'auto (по умолчанию) — взять в руку не-блок (с блоком в руке сервер ставит блок вместо открытия); toss — если не-блока нет, выбросить блок из руки (рука пустая); skip — руку не трогать',
    walk_sec: 'сколько секунд идти к сундуку, по умолчанию 20'
  },
  async run(api, params) {
    const log = m => { try { api.log(m); } catch (e) {} };
    const flyOf = async () => {
      try {
        const s = await api.snapshot();
        const p = (s && s.position) || {};
        return [Math.floor(Number(p.x) || 0), Math.floor(Number(p.y) || 0), Math.floor(Number(p.z) || 0)];
      } catch (e) { return []; }
    };

    // --- 1. снимок: где муха, что в руке, занято ли тело ---
    let snap = null;
    try { snap = await api.snapshot(); }
    catch (e) { return { ok: false, error: 'снимок не получился: ' + String(e.message).slice(0, 120) }; }
    let fly = await flyOf();
    if (fly.length !== 3) {
      return { ok: false, error: 'не знаю, где муха (снимок не получился) — повтори', blocker: 'нет позиции мухи' };
    }
    const busy = snap.task || null;
    if (busy && busy.source !== 'autopilot') {
      const err = `тело занято навыком ${busy.name} (taskId ${busy.id}) — сундук не трогаю, повтори, когда тело освободится`;
      return { ok: false, error: err, fly, blocker: err, busy: busy.name };
    }

    // --- 2. где сундук ---
    const px = Number(params.x), py = Number(params.y), pz = Number(params.z);
    let chest = null, found = '';
    if ([px, py, pz].every(Number.isFinite)) { chest = [Math.floor(px), Math.floor(py), Math.floor(pz)]; found = 'координаты из заявки'; }
    if (!chest) {
      const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.chest;
      if (b && Array.isArray(b.at) && b.at.length === 3) { chest = b.at.map(v => Math.floor(Number(v))); found = 'сундук виден глазами'; }
    }
    if (!chest) {
      try {
        const g = await api.cmd('goto_known', { kind: 'chest', timeout: 12 });
        if (g && Array.isArray(g.at) && g.at.length === 3) {
          chest = g.at.map(v => Math.floor(Number(v)));
          found = 'по памяти тела';
        }
      } catch (e) { log('goto_known chest: ' + String(e.message).slice(0, 120)); }
    }

    // --- 3. если контейнер найден — готовь его, иначе честный ok:false ---
    if (chest) {
      const [cx, cy, cz] = chest;
      const walkSec = Math.min(Math.max(Number(params.walk_sec) || 20, 3), 60);
      let f = await flyOf();
      let dist = Math.max(Math.abs(f[0] - cx), Math.abs(f[2] - cz));
      if (dist > 25) {
        return { ok: false, error: `сундук ${cx} ${cy} ${cz} в ${dist} м от мухи — так далеко не дойду; сходи к базе (go_safe) и повтори`, blocker: err, fly: f };
      }
      if (dist > 3 || Math.abs(f[1] - cy) > 1) {
        const dx = Math.sign(f[0] - cx) || 1;
        const dz = f[0] === cx ? 0 : Math.sign(f[2] - cz);
        try { await api.cmd('goto', { x: cx + dx * 1.5, y: cy, z: cz + dz * 1.5, timeout: walkSec }); }
        catch (e) { log('goto к сундуку: ' + String(e.message).slice(0, 100)); }
        f = await flyOf();
        dist = Math.max(Math.abs(f[0] - cx), Math.abs(f[2] - cz));
      }
      if (dist > 4) {
        return { ok: false, error: `сундук ${cx} ${cy} ${cz} в ${dist} м от мухи — подойти не удалось; сходи к базе (go_safe) и повтори`, blocker: err, fly: f };
      }

      // что вокруг сундука
      let g;
      try {
        const sv = await api.cmd('survey', { x1: cx - 1, y1: cy - 1, z1: cz - 1, x2: cx + 1, y2: cy + 2, z2: cz + 1 });
        g = grid(sv);
      } catch (e) {
        return { ok: false, error: `не смогла осмотреть вокруг сундука ${cx} ${cy} ${cz}: ${String(e.message).slice(0, 100)}`, blocker: err, fly: f };
      }
      const here = g(cx, cy, cz);
      const sides = {};
      for (const s of SIDES) sides[s.dir] = g(cx + s.dx, cy, cz + s.dz);
      let above = g(cx, cy + 1, cz);

      // блок над сундуком
      let blocker = null;
      let dugAbove = null;
      if (solid(above)) {
        const digMode = Number(params.dig_above);
        const mode = Number.isFinite(digMode) && digMode > 0 ? digMode : 1;
        if (CONTAINERS.test(above)) {
          blocker = `над сундуком ${cx} ${cy + 1} ${cz} стоит контейнер (${above}) — не копаю (это потеря контейнера); убери его сам`;
        } else if (!flag(params.dig_above, true)) {
          blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — сервер не откроет сундук, пока сверху занято; выкопай его (dig_at ${cx} ${cy + 1} ${cz}) и повтори`;
        } else if (mode < 2 && !SOFT.test(above)) {
          blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — не копаю (это может быть часть постройки); скажи dig_above=2 или убери блок сам`;
        } else {
          try {
            await api.cmd('dig_at', { x: cx, y: cy + 1, z: cz });
            dugAbove = above;
            try {
              const sv = await api.cmd('survey', { x1: cx - 1, y1: cy - 1, z1: cz - 1, x2: cx + 1, y2: cy + 2, z2: cz + 1 });
              g = grid(sv);
              above = g(cx, cy + 1, cz);
            } catch (e) { /* оставим как было */ }
          } catch (e) {
            blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — выкопать не удалось: ${String(e.message).slice(0, 120)}`;
          }
          if (!blocker && solid(above)) blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — выкопал, а он на месте`;
        }
      }

      // куда встать: боком к сундуку, на его уровне
      const cands = [];
      for (const s of SIDES) {
        const cell = [cx + s.dx, cy, cz + s.dz];
        const c = g(cell[0], cell[1], cell[2]);
        if (c !== '?' && !AIRLIKE.test(c)) continue;
        const below = g(cell[0], cell[1] - 1, cell[2]);
        const head = g(cell[0], cell[1] + 1, cell[2]);
        const canStand = (below === '?' || solid(below)) && (head === '?' || AIRLIKE.test(head));
        cands.push({ dir: s.dir, dx: s.dx, dz: s.dz, cell, canStand, d: Math.abs(f[0] - cell[0]) + Math.abs(f[1] - cell[1]) + Math.abs(f[2] - cell[2]) });
      }
      cands.sort((a, b) => (a.canStand === b.canStand ? a.d - b.d : (a.canStand ? -1 : 1)));
      let target = cands[0] || null;
      if (!blocker && !target) {
        if (above === '?' || AIRLIKE.test(above)) {
          target = { dir: 'верх', dx: 0, dz: 0, cell: [cx, cy + 1, cz], canStand: true, d: 99 };
        } else {
          return { ok: false, error: `к сундуку ${cx} ${cy} ${cz} не подойти: сбоку занято (${SIDES.map(s => `${s.dir}:${sides[s.dir]}`).join(' ')}) — ищи другой сундук`, blocker: err, fly: f };
        }
      }
      let face = null;
      if (!blocker && target) {
        const at = target.cell;
        if (!(f[0] === at[0] && f[1] === at[1] && f[2] === at[2])) {
          try { await api.cmd('goto', { x: at[0], y: at[1], z: at[2], timeout: 12 }); }
          catch (e) { log('встать у сундука: ' + String(e.message).slice(0, 100)); }
          f = await flyOf();
        }
        face = target.dir;
        try { await api.cmd('look_at', { x: cx + 0.5, y: cy + 0.5, z: cz + 0.5 }); }
        catch (e) { log('look_at: ' + String(e.message).slice(0, 100)); }
        const far = Math.max(Math.abs(f[0] - cx), Math.abs(f[2] - cz));
        if (far > 2.5 || Math.abs(f[1] - cy) > 1) {
          return { ok: false, error: `встать рядом с сундуком ${cx} ${cy} ${cz} не выšlo (муха ${f.join(' ')}) — подойди ближе и повтори`, blocker: err, fly: f };
        }
      }

      // рука: с блоком в руке сервер ставит блок, а не открывает сундук
      const snap2 = await (async () => { try { return await api.snapshot(); } catch (e) { return snap; } })();
      let held = (snap2.heldItem && snap2.heldItem.name) || null;
      const handMode = String(params.hand || 'auto').toLowerCase();
      if (!blocker && handMode !== 'skip' && held && !handOk(held)) {
        const cand = pickHand(snap2.inventory);
        if (cand) {
          try { await api.cmd('equip_item', { item: cand }); held = cand; }
          catch (e) { log('equip_item: ' + String(e.message).slice(0, 100)); }
        } else if (handMode === 'toss') {
          const n = (snap2.heldItem && Number(snap2.heldItem.count)) || 1;
          try { await api.cmd('toss', { item: held, count: n }); held = null; }
          catch (e) { log('toss: ' + String(e.message).slice(0, 100)); }
        }
      }
      if (!blocker && handMode !== 'skip' && held && !handOk(held)) {
        return { ok: false, error: `в руке блок (${held}) — с блоком в руке сервер ставит блок вместо открытия сундука; возьми в руку не-блок (equip_item) или скажи hand=toss (выброшу блок, рука пустая)`, blocker: err };
      }

      const note = blocker
        ? 'не открыть: ' + blocker
        : (target && target.dir === 'верх'
          ? 'сундук открыт сверху (сбоку не подойти) — муха встала на сундук'
          : `муха на уровне сундука (${target.cell.join(' ')}), смотрит на грань ${target.dir}`);
      return {
        ok: true, chest, ready: !blocker, blocker: blocker || null, fly: f, face, faces,
        above, held, dugAbove, found, note
      };
    }

    // --- 4. контейнера нет по координатам — честный отказ с known ---
    const known = await knownList(api, snap, params.item, log);
    const knownDesc = known.length ? ` — известные мне контейнеры: ${known.map(k => `${k.at.join(' ')}${k.d ? ` (${k.d} м)` : ''}${k.item ? ` [${k.item} ${k.count}]` : ''}`).join('; ')}` : '';
    const fact = `по координатам ${px} ${py} ${pz} сундука нет`;
    const whatKnown = px || py || pz ? `, ${found || 'клетки не видно'}` : '';
    const err = `сундук не виден nearby${knownDesc} — ${fact}${whatKnown} — назови настоящие координаты контейнера или найди сам (survey/explore)`;
    return {
      ok: false, error: err, chest: null, ready: false, blocker: found ? `клетка: ${found}` : null,
      known, fly, note: 'сундук не найден'
    };
  }
};