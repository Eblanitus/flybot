// версия: как текущая chest_open (22.10), но после подготовки сама открывает контейнер навыком тела chest_take БЕЗ item (тело читает содержимое и ничего не берёт) и возвращает полный список {предмет: количество} + координаты сундука; параметр item — «есть ли X?» (have) без единого взятия; по заявке учителя — «содержимое сундука нельзя посмотреть, не взяв что-то»
// chest_open_v5 — открыть сундук и ПРОЧИТАТЬ его содержимое, ничего не беря, не ломая и не переставляя.
// Основа — chest_open (вспомогательная подготовка): находит сундук (координаты / глазами / память тела), подходит,
// проверяет помехи для открытия (главные причины «не открывается»):
//   • над сундуком блок — сервер не откроет сундук, пока сверху занято (dig_above=1 по умолчанию выкапывает мягкий блок);
//   • сундук не виден (за стеной / чанк не загружен) или по координатам там не сундук;
//   • сбоку занято — некуда встать; муха не на уровне сундука;
//   • в руке блок: с блоком в руке сервер ставит блок вместо открытия контейнера.
// Если всё чисто — Навыка тела chest_take зовётся БЕЗ item: тело открывает окно сундука,
// сокращает таблицу содержимого ({имя: количество}) и закрывает окно, взяв ровно 0 предметов (lib/skills/build.js chestTake).
// Успех: {ok:true, chest:[x,y,z], content:{имя:шт}, took:0, types, total, item?, have?, fly, faces, above, held, dugAbove, found, note}.
// Отказ (не найден/помеха/не открылся/не читается): {ok:false, error:'…'} с chest, fly, blocker, faces, above, held — смотреть было нечем.
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

// содержимое одной строкой для error/note (не расползается в длинные тексты)
function contentStr(content, max) {
  const parts = Object.entries(content || {}).map(([n, c]) => `${n} ${c}`);
  if (!parts.length) return 'пусто';
  const s = parts.join(', ');
  return s.length > (max || 160) ? s.slice(0, max || 160) + '…' : s;
}

module.exports = {
  name: 'chest_open',
  description: 'Открыть сундук и показать ПОЛНОЕ содержимое {предмет: количество} + координаты сундука, ничего не беря и не ломая (взято 0). item — «есть ли X?» (have: шт или 0). Отказ честным ok:false, если сундука не видно, что-то мешает или окно не открылось.',
  params: {
    x: 'x сундука (необязательно; иначе — видимый глазами или известный)',
    y: 'y сундука', z: 'z сундука',
    item: 'имя предмета (точное, как в содержимом: bread, charcoal, cobblestone): «есть ли X?» — вернёт have (0 = нет), ничего не беря',
    dig_above: '0 — не копать; 1 (по умолчанию) — выкопать мягкий блок над сундуком (земля/снег/листва); 2 — выкопать любой блок над сундуком (кроме контейнера)',
    hand: 'auto (по умолчанию) — взять в руку не-блок (с блоком в руке сервер ставит блок вместо открытия); toss — если не-блока нет, выбросить блок из руки (рука пустая); skip — руку не трогать',
    walk_sec: 'сколько секунд идти к сундуку, по умолчанию 20',
    open_sec: 'сколько ждать окно сундука, по умолчанию 5 (минимум 2, максимум 20)'
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
      return { ok: false, error: 'не знаю, где муха (снимок не получился) — повтори' };
    }
    const busy = snap.task || null;
    if (busy && busy.source !== 'autopilot') {
      const err = `тело занято навыком ${busy.name} (taskId ${busy.id}) — сундук не трогаю, повтори, когда тело освободится`;
      return { ok: false, error: err, fly, busy: busy.name };
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
    const noChest = knownErr
      ? `сундук не виден рядом, к известному не дошла: ${knownErr} — дай x,y,z или подойди сама (go_safe)`
      : 'сундук не виден рядом и я такого места не помню — дай x,y,z или найди (find/explore)';
    if (!chest) {
      log('сундук не найден: ' + noChest);
      return { ok: false, error: noChest };
    }
    const [cx, cy, cz] = chest;

    // --- 3. подойти, если далеко (иначе survey не покажет ничего) ---
    const walkSec = Math.min(Math.max(Number(params.walk_sec) || 20, 3), 60);
    let dist = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
    if (found !== 'помню такой сундук' && (dist > 3 || Math.abs(fly[1] - cy) > 1)) {
      const dx = Math.sign(fly[0] - cx) || 1;
      const dz = fly[0] === cx ? 0 : Math.sign(fly[2] - cz);
      try { await api.cmd('goto', { x: cx + dx * 1.5, y: cy, z: cz + dz * 1.5, timeout: walkSec }); }
      catch (e) { log('goto к сундуку: ' + String(e.message).slice(0, 100)); }
      fly = await flyOf();
      dist = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
    }
    if (dist > 25) {
      const err = `сундук ${cx} ${cy} ${cz} в ${dist} м от мухи (муха ${fly.join(' ')}) — так близко с места не откроется; сходи к сундуку (go_safe) и повтори`;
      log(err);
      return { ok: false, chest, error: err, fly };
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
      log(err);
      return { ok: false, chest, error: err, fly };
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
    if (!blocker && target) {
      const at = target.cell;
      if (!(fly[0] === at[0] && fly[1] === at[1] && fly[2] === at[2])) {
        try { await api.cmd('goto', { x: at[0], y: at[1], z: at[2], timeout: 12 }); }
        catch (e) { log('встать у сундука: ' + String(e.message).slice(0, 100)); }
        fly = await flyOf();
      }
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

    // всё, что мешало смотреть внутрь, — честный отказ (заявку не выполнили)
    if (blocker) {
      log('сундук ' + [cx, cy, cz].join(' ') + ': не открыть — ' + blocker);
      return { ok: false, error: blocker, chest, fly, blocker, faces, above, held, dugAbove, found };
    }

    // --- 8. открыть контейнер и ПРОЧИТАТЬ содержимое: тело chest_take БЕЗ item ---
    // тело открывает окно, строит {имя: количество}, ничего НЕ берёт (took: 0) и закрывает окно
    let cursor = 0;
    try { const l = await api.events(0, 1); cursor = (l && l.lastId) || 0; } catch (e) {}
    let started = null;
    try { started = await api.start('chest_take', { x: cx, y: cy, z: cz }); }
    catch (e) {
      const err = `сундук ${cx} ${cy} ${cz} не открылся: ${String(e.message).slice(0, 180)} (муха ${fly.join(' ')}, в руке ${held || 'пусто'}, над сундуком ${above})`;
      return { ok: false, error: err, chest, fly, faces, above, held };
    }
    if (!started || !started.taskId) {
      const why = (started && (started.error || started.hint)) || 'навык встал в очередь, а не пошёл';
      const err = `сундук ${cx} ${cy} ${cz} не открылся: тело занято (${why}) — повтори, когда тело освободится`;
      return { ok: false, error: err, chest, fly, faces, above, held };
    }

    const limit = Math.min(Math.max(Number(params.open_sec) || 5, 2), 20);
    const deadline = Date.now() + limit * 1000;
    let ev = null;
    while (Date.now() < deadline) {
      let list = { events: [] };
      try { list = await api.events(cursor, 60); } catch (e) { log('events: ' + String(e.message).slice(0, 80)); }
      const events = (list && list.events) || [];
      ev = events.find(x => x.taskId === started.taskId && (x.type === 'task_done' || x.type === 'task_failed' || x.type === 'task_aborted')) || null;
      if (ev) break;
      await api.sleep(200);
    }
    if (!ev) {
      try { await api.stop(); } catch (e) {}
      const err = `сундук ${cx} ${cy} ${cz} не открылся за ${limit} с — сервер не открыл окно (муха ${fly.join(' ')}, в руке ${held || 'пусто'}, над сундуком ${above}); проверь блок над сундуком и грань, с которой смотрит муха`;
      return { ok: false, error: err, chest, fly, faces, above, held, timeoutSec: limit };
    }

    const res = ev.result || {};
    if (ev.type !== 'task_done') {
      const reason = String(ev.reason || 'без причины');
      const err = `сундук ${cx} ${cy} ${cz} не открылся: ${reason} (муха ${fly.join(' ')}, в руке ${held || 'пусто'}, над сундуком ${above})`;
      const out = { ok: false, error: err, chest, fly, above, held, reason };
      if (res.content) out.content = res.content;
      return out;
    }

    const content = (res.content && typeof res.content === 'object') ? res.content : {};
    const took = Number(res.took) || 0;
    const types = Object.keys(content).length;
    const total = Object.values(content).reduce((s, n) => s + (Number(n) || 0), 0);

    // вопрос «есть ли X?» — по прочитанному содержимому, ничего не беря
    let want = String(params.item || '').trim();
    let have = null;
    if (want) have = content[want] || 0;

    log(`сундук ${cx} ${cy} ${cz}: окно открыл и закрыл, взято ${took} (должно быть 0), внутри ${types} видов / ${total} предметов: ${contentStr(content, 160)}` + (want ? `; ${want}: ${have > 0 ? 'есть ' + have + ' шт' : 'нет'}` : ''));

    const note = !types ? 'сундук открыт: внутри пусто, взято ' + took
      : want ? `${want}: ${have > 0 ? 'есть ' + have + ' шт' : 'нет'} (внутри ${types} видов, взято ${took})`
      : `сундук открыт: ${types} видов / ${total} предметов, взято ${took}`;

    return {
      ok: true, chest, content, took, types, total,
      ...(want ? { item: want, have } : {}),
      fly, faces, above, held, dugAbove, found, note
    };
  }
};
