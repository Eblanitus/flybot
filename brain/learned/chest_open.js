// версия: была текущей на 22.10; как v4 + hand=toss (нет не-блока — выбросить блок из руки)
// chest_open — подготовить муху к открытию сундука и сказать, что мешает.
// Сам контейнер не открывает: это делает навык тела (chest_take / chest_store) через этот навык.
// Что проверяет (главные причины, почему сундук не открывается):
//   • над сундуком блок — сервер не откроет сундук, пока сверху занято (можно выкопать сам: dig_above=1);
//   • сундук не виден (за стеной / чанк не загружен) или по координатам там не сундук;
//   • сбоку занято — некуда встать; муха не на уровне сундука;
//   • в руке блок: с блоком в руке сервер ставит блок вместо открытия контейнера.
// Плюс: подходит к сундуку, встаёт рядом на его уровне и смотрит на него.
// Итог: {ok:true, chest:[x,y,z], ready, blocker, fly:[x,y,z], face, faces, above, held, dugAbove, found, note}.
// blocker — причина, почему открыть нельзя (null — можно). Помеха — не поломка, поэтому ok остаётся true.
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|snow_layer|dandelion|poppy|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|blue_orchid|red_tulip|white_tulip|orange_tulip|pink_tulip|purple_tulip|white_dandelion|sugar_cane|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|cobweb|lily_pad)$/;
const CHESTS = /^(chest|trapped_chest|barrel)$/;
const CONTAINERS = /^(chest|trapped_chest|barrel|hopper|furnace|blast_furnace|smoker|dispenser|dropper|[a-z_]*shulker_box)$/;
const SIDES = [{ dx: 1, dz: 0, dir: 'В' }, { dx: -1, dz: 0, dir: 'З' }, { dx: 0, dz: 1, dir: 'Ю' }, { dx: 0, dz: -1, dir: 'С' }];
// предметы, которые можно держать в руке при открытии сундука (с блоком в руке сервер ставит блок, а не открывает)
const TOOL = /(_pickaxe|_axe|_sword|_shovel|_hoe)$|^bow$|^crossbow$/;
const FOOD = /^(cooked_[a-z_]+|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|golden_apple|golden_carrot|carrot|potato|baked_potato|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|suspicious_stew|honey_bottle)$/;
const PLAIN = /^(stick|string|coal|charcoal|bone|arrow|bucket|water_bucket|lava_bucket|egg|snowball|glowstone_dust|redstone|lapis_lazuli|quartz|diamond|emerald|iron_ingot|gold_ingot|copper_ingot|netherite_ingot|raw_iron|raw_gold|raw_copper|leather|feather|flint|gunpowder|blaze_powder|spider_eye|rotten_flesh|slime_ball|ender_pearl|paper|book|ink_sac|clay_ball|brick|nether_brick|flint_and_steel|shears|fishing_rod|wheat|wheat_seeds|lead|name_tag|saddle|experience_bottle|glass_bottle|map|compass|clock|iron_nugget|gold_nugget|music_disc_\d+)$/;

const handOk = n => TOOL.test(n) || FOOD.test(n) || PLAIN.test(n);
const solid = n => n !== '?' && !AIRLIKE.test(n) && n !== 'water' && n !== 'lava';
// мягкие блоки: их над сундуком безопасно выкопать (земля, снег, листва) — в отличие от камня/ досок постройки
const SOFT = /^(dirt|coarse_dirt|rooted_dirt|dirt_path|grass_block|sand|gravel|clay|mud|podzol|mycelium|snow|snow_block|short_grass|tall_grass|fern|large_fern|dead_bush|moss|vine)$|^[a-z_]*leaves$/;
// 1 — да, 0 — нет; если параметра нет — значение по умолчанию
const flag = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  return !(v === 0 || v === '0' || v === false || v === 'false' || v === 'no' || v === 'off');
};

// survey -> сетка: имя блока в клетке; '?' — не видно (за стеной / чанк не загружен)
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

// что взять в руку, чтобы в руке не было блока (сначала инструмент, потом еда, потом прочее)
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

module.exports = {
  name: 'chest_open',
  description: 'Вспомогательный: найти сундук, подойти, осмотреть вокруг и сказать, что мешает (над сундуком блок / сундук не виден / сбоку занято / муха не на уровне сундука / в руке блок). Может выкопать блок над сундуком и убрать блок из руки. Сам контейнер не открывает — зови chest_take или chest_store.',
  params: {
    x: 'x сундука (необязательно; иначе — видимый глазами или известный)',
    y: 'y сундука', z: 'z сундука',
    dig_above: '0 — не копать; 1 (по умолчанию) — выкопать мягкий блок над сундуком (земля/снег/листва); 2 — выкопать любой блок над сундуком (кроме контейнера)',
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
    let knownErr = '';
    if (!chest) {
      // спросить у тела, где оно помнит сундук (и подойти к нему)
      try {
        const g = await api.cmd('goto_known', { kind: 'chest', timeout: 12 });
        if (g && Array.isArray(g.at) && g.at.length === 3) { chest = g.at.map(v => Math.floor(Number(v))); found = 'помню такой сундук'; }
      } catch (e) { knownErr = String(e.message).slice(0, 120); log('goto_known chest: ' + knownErr); }
      fly = await flyOf();
    }
    if (!chest) {
      const err = knownErr
        ? `сундук не виден рядом, к известному не дошла: ${knownErr} — дай x,y,z или подойди сама (go_safe)`
        : 'сундук не виден рядом и я такого места не помню — дай x,y,z или найди (find/explore)';
      return { ok: true, chest: null, ready: false, blocker: err, fly, note: 'сундук не найден' };
    }
    const [cx, cy, cz] = chest;

    // --- 3. подойти, если далеко (иначе survey не покажет ничего) ---
    const walkSec = Math.min(Math.max(Number(params.walk_sec) || 20, 3), 60);
    let dist = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
    if (dist > 25) {
      const err = `сундук ${cx} ${cy} ${cz} в ${dist} м от мухи (муха ${fly.join(' ')}) — так далеко не дойду; сходи к базе (go_safe) и повтори`;
      return { ok: true, chest, ready: false, blocker: err, fly, note: 'далеко' };
    }
    if (found !== 'помню такой сундук' && (dist > 3 || Math.abs(fly[1] - cy) > 1)) {
      const dx = Math.sign(fly[0] - cx) || 1;
      const dz = fly[0] === cx ? 0 : Math.sign(fly[2] - cz);
      try { await api.cmd('goto', { x: cx + dx * 1.5, y: cy, z: cz + dz * 1.5, timeout: walkSec }); }
      catch (e) { log('goto к сундуку: ' + String(e.message).slice(0, 100)); }
      fly = await flyOf();
      dist = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
    }
    if (dist > 4) {
      const err = `сундук ${cx} ${cy} ${cz} в ${dist} м от мухи (муха ${fly.join(' ')}) — подойти не удалось; сходи к базе (go_safe) и повтори`;
      return { ok: true, chest, ready: false, blocker: err, fly, note: 'далеко' };
    }

    // --- 4. что вокруг сундука ---
    const survey = async () => {
      const sv = await api.cmd('survey', { x1: cx - 1, y1: cy - 1, z1: cz - 1, x2: cx + 1, y2: cy + 2, z2: cz + 1 });
      return grid(sv);
    };
    let g;
    try { g = await survey(); }
    catch (e) {
      const err = `не смогла осмотреть вокруг сундука ${cx} ${cy} ${cz}: ${String(e.message).slice(0, 100)}`;
      return { ok: true, chest, ready: false, blocker: err, fly, note: 'survey не удался' };
    }
    const here = g(cx, cy, cz);
    const sides = {};
    for (const s of SIDES) sides[s.dir] = g(cx + s.dx, cy, cz + s.dz);
    let above = g(cx, cy + 1, cz);
    const faces = { here, above, sides };
    let blocker = null;

    if (here === '?') {
      blocker = `сундук ${cx} ${cy} ${cz} не вижу (за стеной или чанк не загружен) — муха ${fly.join(' ')} не подошла; подойди и повтори`;
    } else if (!CHESTS.test(here)) {
      blocker = `в точке ${cx} ${cy} ${cz} не сундук, а ${here} — дай координаты сундука`;
    }

    // --- 5. блок над сундуком: главная причина «не открывается» ---
    let dugAbove = null;
    if (!blocker && solid(above)) {
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
            g = await survey();
            above = g(cx, cy + 1, cz);
            faces.above = above;
          } catch (e) { /* оставим как было */ }
        } catch (e) {
          blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — выкопать не удалось: ${String(e.message).slice(0, 120)}`;
        }
        if (!blocker && solid(above)) blocker = `над сундуком ${cx} ${cy + 1} ${cz} блок ${above} — выкопал, а он на месте`;
      }
    }

    // --- 6. куда встать: боком к сундуку, на его уровне ---
    const cands = [];
    for (const s of SIDES) {
      const cell = [cx + s.dx, cy, cz + s.dz];
      const c = g(cell[0], cell[1], cell[2]);
      if (c !== '?' && !AIRLIKE.test(c)) continue;                 // сбоку занято
      const below = g(cell[0], cell[1] - 1, cell[2]);
      const head = g(cell[0], cell[1] + 1, cell[2]);
      const canStand = (below === '?' || solid(below)) && (head === '?' || AIRLIKE.test(head));
      cands.push({ dir: s.dir, dx: s.dx, dz: s.dz, cell, canStand, d: Math.abs(fly[0] - cell[0]) + Math.abs(fly[1] - cell[1]) + Math.abs(fly[2] - cell[2]) });
    }
    cands.sort((a, b) => (a.canStand === b.canStand ? a.d - b.d : (a.canStand ? -1 : 1)));
    let target = cands[0] || null;
    if (!blocker && !target) {
      if (above === '?' || AIRLIKE.test(above)) {
        target = { dir: 'верх', dx: 0, dz: 0, cell: [cx, cy + 1, cz], canStand: true, d: 99 };
      } else {
        blocker = `к сундуку ${cx} ${cy} ${cz} не подойти: сбоку занято (${SIDES.map(s => `${s.dir}:${sides[s.dir]}`).join(' ')}) — ищи другой сундук`;
      }
    }
    let face = null;
    if (!blocker && target) {
      const at = target.cell;
      if (!(fly[0] === at[0] && fly[1] === at[1] && fly[2] === at[2])) {
        try { await api.cmd('goto', { x: at[0], y: at[1], z: at[2], timeout: 12 }); }
        catch (e) { log('встать у сундука: ' + String(e.message).slice(0, 100)); }
        fly = await flyOf();
      }
      face = target.dir;
      try { await api.cmd('look_at', { x: cx + 0.5, y: cy + 0.5, z: cz + 0.5 }); }
      catch (e) { log('look_at: ' + String(e.message).slice(0, 100)); }
      const far = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
      if (far > 2.5 || Math.abs(fly[1] - cy) > 1) {
        blocker = `встать рядом с сундуком ${cx} ${cy} ${cz} не вышло (муха ${fly.join(' ')}) — подойди ближе и повтори`;
      }
    }

    // --- 7. рука: с блоком в руке сервер ставит блок, а не открывает сундук ---
    let held = (snap.heldItem && snap.heldItem.name) || null;
    const handMode = String(params.hand || 'auto').toLowerCase();
    if (!blocker && handMode !== 'skip' && held && !handOk(held)) {
      const cand = pickHand(snap.inventory);
      if (cand) {
        try { await api.cmd('equip_item', { item: cand }); held = cand; }
        catch (e) { log('equip_item: ' + String(e.message).slice(0, 100)); }
      } else if (handMode === 'toss') {
        const n = (snap.heldItem && Number(snap.heldItem.count)) || 1;
        try { await api.cmd('toss', { item: held, count: n }); held = null; }
        catch (e) { log('toss: ' + String(e.message).slice(0, 100)); }
      }
    }
    if (!blocker && handMode !== 'skip' && held && !handOk(held)) {
      blocker = `в руке блок (${held}) — с блоком в руке сервер ставит блок вместо открытия сундука; возьми в руку не-блок (equip_item) или скажи hand=toss (выброшу блок, рука пустая)`;
    }

    const note = blocker
      ? 'не открыть: ' + blocker
      : (target && target.dir === 'верх'
        ? 'сундук открыт сверху (сбоку не подойти) — муха встала на сундук'
        : `муха на уровне сундука (${target.cell.join(' ')}), смотрит на грань ${target.dir}`);
    return {
      ok: true, chest, ready: !blocker, blocker: blocker || null, fly, face, faces,
      above, held, dugAbove, found, note
    };
  }
};
