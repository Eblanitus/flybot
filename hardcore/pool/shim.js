// Переходник: навыки Voyager и Odyssey (код под mineflayer, лицензия MIT — см. voyager/LICENSE, odyssey/LICENSE)
// запускаются у мухи поверх её тела. Чужой код не правим: он лежит в voyager/t1..t3 и odyssey/ как есть,
// а здесь — то, что он ждёт вокруг себя: `bot`, `mcData`, Vec3, Goal*, mineBlock/craftItem/smeltItem/killMob/placeItem/exploreUntil.
// Каждое действие уходит в тело (api.cmd выученного навыка): mineBlock → collect, craftItem → craft, smeltItem → smelt,
// killMob → hunt/fight, placeItem → place_at, exploreUntil → explore, bot.dig → dig_at, bot.fish → fish и т.д.
// Мир чужой навык видит только честно: сумка и позиция — из снимка тела, блоки — из survey (что муха видит), существа — из scan.
// Читов нет: bot.chat уходит в журнал навыка, а не в чат сервера.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Vec3 } = require('vec3');

const HERE = __dirname;
const SURVEY_R = 9, SURVEY_DY = 4;            // сколько мира вокруг мухи отдаём чужому навыку (findBlock, blockAt); тело даёт survey ≤ 4096 блоков
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat']);
// у Voyager craftItem(name, n) — n раз рецепт; у тела craft count — сколько предметов. Сколько даёт один рецепт:
const CRAFT_MULT = [[/_planks$/, 4], [/^stick$/, 4], [/^torch$/, 4], [/^arrow$/, 4], [/^ladder$/, 3], [/_slab$/, 6], [/_stairs$/, 4], [/^bowl$/, 4], [/_wall$/, 6]];
const multOf = name => { for (const [re, k] of CRAFT_MULT) if (re.test(name)) return k; return 1; };

// mcData: в переходнике id предмета — это его имя (тело работает с именами); любое имя «существует»
const named = () => new Proxy({}, { get: (_, k) => (typeof k === 'string' && k !== 'then' ? { id: k, name: k, displayName: k } : undefined) });
const mcData = { itemsByName: named(), blocksByName: named(), entitiesByName: named(), items: named(), blocks: named(), foods: {} };

// Цели pathfinder: тело само ходит (goto), нам нужна только точка
class Goal { constructor(x, y, z, range) { this.x = x; this.y = y; this.z = z; this.range = range || 0; } }
class GoalBlock extends Goal {}
class GoalNear extends Goal { constructor(x, y, z, range) { super(x, y, z, range == null ? 1 : range); } }
class GoalNearXZ extends Goal { constructor(x, z, range) { super(x, null, z, range == null ? 1 : range); } }
class GoalXZ extends Goal { constructor(x, z) { super(x, null, z, 0); } }
class GoalGetToBlock extends Goal {}
class GoalLookAtBlock extends Goal { constructor(pos) { super(pos.x, pos.y, pos.z, 3); } }
class GoalPlaceBlock extends Goal { constructor(pos) { super(pos.x, pos.y, pos.z, 3); } }
class GoalFollow extends Goal { constructor(entity, range) { const p = (entity && entity.position) || {}; super(p.x, p.y, p.z, range || 2); } }

const nameOf = x => (x == null ? '' : typeof x === 'object' ? String(x.name || x.id || '') : String(x)).replace(/^minecraft:/, '');
const k3 = (x, y, z) => `${x},${y},${z}`;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const errText = e => String((e && e.message) || e || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 200);

// Разбор survey тела (layers y=…: строки по z, символы по x; legend: символ → имя; '?' — не видно)
function parseSurvey(sv) {
  const map = new Map();
  if (!sv || !sv.origin || !sv.layers) return map;
  const o = sv.origin, leg = sv.legend || {};
  for (const [key, rows] of Object.entries(sv.layers)) {
    const y = parseInt(String(key).replace(/^y=/, ''), 10);
    if (!Number.isFinite(y) || !Array.isArray(rows)) continue;
    rows.forEach((row, dz) => {
      for (let dx = 0; dx < row.length; dx++) {
        const c = row[dx];
        if (c === '?') continue;
        map.set(k3(o.x + dx, y, o.z + dz), c === '.' ? 'air' : (leg[c] || 'unknown'));
      }
    });
  }
  return map;
}

const EYE_NAMES = {
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  bed: ['white_bed', 'red_bed']
};
const EMPTY = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|snow|.*_flower|dandelion|poppy)$/;
// старые имена блоков, под которые писали Voyager/Odyssey (1.19): чужой фильтр «grass» — это нынешняя short_grass
const LEGACY = { short_grass: 'grass' };
// посевы: зрелость муха не видит (survey даёт только имя) — говорим «спелое», а bot.dig посева уходит в harvest тела, который берёт только спелое
const CROPS = { wheat: 'wheat', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot' };
function makeBlock(name, x, y, z) {
  const crop = !!CROPS[name];
  return { name, type: name, displayName: name, metadata: crop ? 7 : 0, position: new Vec3(x, y, z), boundingBox: EMPTY.test(name) || crop ? 'empty' : 'block', getProperties: () => (crop ? { age: 7 } : {}), diggable: name !== 'bedrock' };
}

// Окружение одного запуска: фасад bot + примитивы. maxSec — потолок времени (после него любое действие бросает).
function makeEnv(api, opts = {}) {
  const t0 = Date.now();
  const deadline = t0 + Math.max(2, Number(opts.maxSec) || 300) * 1000;
  const S = { snap: null, grid: new Map(), ents: [], held: null, calls: [], chat: [], errors: [], equipped: false, effects: 0, bred: new Set() };   // effects — дела без прибавки в сумке: вспахал, посадил, накормил пару
  const log = msg => { const s = String(msg).slice(0, 200); S.chat.push(s); try { api.log && api.log('[чужой навык] ' + s); } catch (e) {} };
  const check = what => { if (Date.now() > deadline) throw new Error(`время навыка вышло (${what})`); };
  // промис, который никто не ждёт (чужой код забыл await), не должен валить процесс навыка: помечаем обработанным
  const guard = p => { if (p && typeof p.catch === 'function') p.catch(e => { S.errors.push(errText(e)); }); return p; };

  async function refresh(full = true) {
    S.snap = await api.snapshot();
    if (!full) return S.snap;
    try { S.grid = parseSurvey(await api.cmd('survey', { radius: SURVEY_R, dy: SURVEY_DY })); } catch (e) { /* не видно — пусто */ }
    try {
      const r = await api.cmd('scan', {});
      S.ents = ((r && r.entities) || []).map((e, i) => ({
        id: i + 1, uuid: `${e.name}@${e.position && [e.position.x, e.position.y, e.position.z].join(',')}`, name: e.name, username: e.type === 'player' ? e.name : undefined,
        displayName: e.name, type: e.type, height: 1.8, position: new Vec3(e.position.x, e.position.y, e.position.z)
      }));
    } catch (e) { S.ents = []; }
    return S.snap;
  }
  async function body(action, params) {
    check(action);
    S.calls.push(action + (params && (params.item || params.block || params.animal || params.target) ? ':' + (params.item || params.block || params.animal || params.target) : ''));
    try { return await api.cmd(action, params || {}); }
    finally { try { await refresh(); } catch (e) {} }
  }

  const pos = () => { const p = (S.snap && S.snap.position) || { x: 0, y: 64, z: 0 }; return new Vec3(p.x, p.y, p.z); };
  const invItems = () => ((S.snap && S.snap.inventory) || []).map(i => ({ name: i.name, type: i.name, count: i.count, slot: i.slot, displayName: i.name, stackSize: 64 }));
  const inventory = {
    items: invItems,
    count: (id) => { const n = nameOf(id); return invItems().filter(i => n == null || n === '' || i.name === n).reduce((s, i) => s + i.count, 0); },
    findInventoryItem: (id) => { const n = nameOf(id); return invItems().find(i => i.name === n) || null; },
    slots: [], emptySlotCount: () => Math.max(0, 36 - invItems().length)
  };

  function matcherOf(matching) {
    if (typeof matching === 'function') return b => { try { return !!matching(b); } catch (e) { return false; } };
    const names = new Set((Array.isArray(matching) ? matching : [matching]).map(nameOf));
    return b => names.has(b.name);
  }
  function findBlocks(o = {}) {
    const me = pos(), max = Number(o.maxDistance) || 16, count = Number(o.count) || 1, m = matcherOf(o.matching);
    const center = o.point ? new Vec3(o.point.x, o.point.y, o.point.z) : me;
    const out = [];
    for (const [key, name] of S.grid) {
      const [x, y, z] = key.split(',').map(Number);
      const d = Math.hypot(x + 0.5 - center.x, y + 0.5 - center.y, z + 0.5 - center.z);
      if (d > max) continue;
      const b = makeBlock(name, x, y, z);
      if (m(b) || (LEGACY[name] && m(makeBlock(LEGACY[name], x, y, z)))) out.push({ d, p: b.position });
    }
    // далёкие руды и брёвна, которые муха видела (снимок eyes.blocks), — если survey до них не достаёт
    // глаза зовут все брёвна 'log', кровати 'bed' — подставляем настоящее имя, которое примет чужой фильтр
    for (const [key, v] of Object.entries((S.snap && S.snap.eyes && S.snap.eyes.blocks) || {})) {
      if (!v || !Array.isArray(v.at) || S.grid.has(k3(...v.at))) continue;
      const d = new Vec3(v.at[0] + 0.5, v.at[1] + 0.5, v.at[2] + 0.5).distanceTo(center);
      if (d > max) continue;
      const b = (EYE_NAMES[key] || [key]).map(n => makeBlock(n, v.at[0], v.at[1], v.at[2])).find(m);
      if (b) { S.grid.set(k3(...v.at), b.name); out.push({ d, p: b.position }); } // теперь и blockAt его знает
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, count).map(x => x.p);
  }
  const blockAt = p => { if (!p) return null; const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); const n = S.grid.get(k3(x, y, z)); return n ? makeBlock(n, x, y, z) : null; };
  const where = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

  const bot = {
    get username() { return (S.snap && S.snap.username) || 'fly'; },
    get entity() { return { position: pos(), eyeHeight: 1.62, yaw: (S.snap && S.snap.yaw) || 0, pitch: 0, height: 1.8, onGround: true }; },
    get health() { return (S.snap && S.snap.health) || 0; },
    get food() { return (S.snap && S.snap.food) || 0; },
    get heldItem() { return S.held ? inventory.findInventoryItem(S.held) : null; },
    get time() { return { timeOfDay: (S.snap && S.snap.time) || 0, isDay: !S.snap || S.snap.timeOfDay === 'day' }; },
    get entities() { const o = {}; for (const e of S.ents) o[e.id] = e; return o; },
    inventory, registry: mcData, world: {}, version: 'flybot',
    chat: msg => log(msg),
    whisper: (u, msg) => log(msg),
    save: () => {}, on: () => {}, once: () => {}, removeListener: () => {}, emit: () => {},
    findBlocks,
    findBlock: o => { const p = findBlocks({ ...o, count: 1 })[0]; return p ? blockAt(p) : null; },
    blockAt,
    nearestEntity: (filter = () => true) => {
      const me = pos();
      return S.ents.filter(e => { try { return filter(e); } catch (er) { return false; } }).sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null;
    },
    getEquipmentDestSlot: () => 0,
    waitForTicks: n => guard((async () => { check('waitForTicks'); await sleep(Math.min((Number(n) || 1) * 50, Math.max(0, deadline - Date.now()))); })()),   // цикл ожидания без действий тоже упирается в потолок
    lookAt: () => Promise.resolve(),
    look: () => Promise.resolve(),
    setControlState: () => {}, clearControlStates: () => {},
    equip: (item, dest) => guard((async () => {
      const n = nameOf(item); if (!n) throw new Error('equip: нет предмета');
      const slot = dest === 'off-hand' ? 'off-hand' : ['head', 'torso', 'legs', 'feet'].includes(dest) ? dest : 'hand';
      await body('equip_item', { item: n, slot });
      if (slot === 'hand') S.held = n;
      S.equipped = true;
    })()),
    unequip: () => Promise.resolve(),
    consume: () => guard(body('eat', S.held ? { item: S.held } : {})),
    dig: block => guard((async () => {
      const at = where(block.position || block), crop = CROPS[block.name || S.grid.get(k3(at.x, at.y, at.z))];
      if (crop) return body('harvest', { crop, radius: 3 });
      return body('dig_at', at);
    })()),
    placeBlock: (ref, face) => guard((async () => {
      const p = (ref.position || ref).plus(face || new Vec3(0, 1, 0));
      if (S.held && /_seeds$|^(carrot|potato)$/.test(S.held)) { const r = await body('plant', { seed: S.held, ...where(p) }); if (r && r.planted > 0) S.effects++; return r; }
      return body('place_at', { ...where(p), item: S.held || 'dirt' });
    })()),
    activateBlock: block => guard((async () => {
      if (!(S.held && /_hoe$/.test(S.held))) return body('activate', where(block.position));
      const r = await body('till', where(block.position)); if (r && r.tilled > 0) S.effects++; return r;
    })()),
    activateItem: () => guard(body('use_item', S.held ? { item: S.held } : {})),
    deactivateItem: () => {},
    useOn: entity => guard((async () => {
      const animal = entity && entity.name;
      if (S.held === 'shears') return body('shear', { animal });
      if (S.held === 'bucket') return body('use_item', { item: 'bucket', entity: animal });
      // breed тела кормит пару сам: на вид животного — один вызов; отказ не бросаем (useOn mineflayer — просто клик)
      if (S.bred.has(animal)) return;
      S.bred.add(animal);
      try { const r = await body('breed', { animal, ...(S.held ? { food: S.held } : {}) }); if (r && Array.isArray(r.fed) && r.fed.length >= 2) S.effects++; }
      catch (e) { if (/время навыка вышло/.test(errText(e))) throw e; log(`кормление ${animal}: ${errText(e)}`); }
    })()),
    fish: () => guard((async () => {
      const r = await body('fish', { casts: 1, max_sec: 60 });
      if (!r || !r.caught || !Object.keys(r.caught).length) throw new Error('Fishing cancelled');
    })()),
    pathfinder: {
      goto: goal => guard((async () => {
        const g = goal || {};
        if (!Number.isFinite(g.x) || !Number.isFinite(g.z)) return;
        await body('goto', { x: Math.floor(g.x), ...(Number.isFinite(g.y) ? { y: Math.floor(g.y) } : {}), z: Math.floor(g.z), timeout: 60 });
      })()),
      setGoal: () => {}, setMovements: () => {}, stop: () => {}, isMoving: () => false
    }
  };

  // ---- примитивы Voyager/Odyssey поверх тела ----
  const P = {
    mineBlock: (b, name, count = 1) => guard(body('collect', { block: nameOf(name), count: Math.max(1, Math.round(Number(count) || 1)) })),
    craftItem: (b, name, count = 1) => guard(body('craft', { item: nameOf(name), count: Math.max(1, Math.round(Number(count) || 1)) * multOf(nameOf(name)) })),
    smeltItem: (b, itemName, fuelName, count = 1) => guard((async () => {
      const fuel = nameOf(fuelName);
      await body('smelt', { item: nameOf(itemName), count: Math.max(1, Math.round(Number(count) || 1)), ...(fuel && inventory.count(fuel) ? { fuel } : {}) });
    })()),
    killMob: (b, mobName, timeout) => guard(ANIMALS.has(nameOf(mobName)) ? body('hunt', { animal: nameOf(mobName), count: 1 }) : body('fight', { target: nameOf(mobName), radius: 32 })),
    placeItem: (b, name, position) => guard((async () => {
      const n = nameOf(name);
      const p = position && Number.isFinite(position.x) ? position : pos().offset(1, 0, 0);
      try { await body('place_at', { ...where(p), item: n }); }
      catch (e) {
        // верстак и печь тело ставит само при craft/smelt — неудачная постановка их тут не провал
        if (n === 'crafting_table' || n === 'furnace') log(`${n} не поставлен (${errText(e)}) — тело поставит само при крафте/плавке`); else throw e;
      }
    })()),
    exploreUntil: (b, direction, maxTime = 60, callback = () => false) => guard((async () => {
      const until = Math.min(Date.now() + Math.min(Number(maxTime) || 60, 1200) * 1000, deadline);
      let fails = 0;
      for (;;) {
        const r = await callback();
        if (r) return r;
        if (Date.now() >= until) return null;
        try {
          if (direction && direction.y < 0 && !direction.x && !direction.z) await body('descend', { depth: 6 });
          else await body('explore', { distance: 24 });
          fails = 0;
        } catch (e) {
          log('разведка: ' + errText(e));
          if (++fails >= 3) return null;
          await sleep(500);
        }
      }
    })())
  };

  return { S, bot, P, refresh, log, deadline, t0 };
}

// Загрузить библиотеку (папку с чужими функциями) в отдельный vm-контекст поверх окружения
// own — файл самого навыка: грузится последним, чтобы его функции победили одноимённые (у Voyager V2 — то же имя, что у V1)
function loadLib(libId, env, own) {
  const dir = path.join(HERE, libId);
  const ctx = vm.createContext({
    bot: env.bot, mcData, Vec3, GoalBlock, GoalNear, GoalNearXZ, GoalXZ, GoalGetToBlock, GoalLookAtBlock, GoalPlaceBlock, GoalFollow,
    goals: { GoalBlock, GoalNear, GoalNearXZ, GoalXZ, GoalGetToBlock, GoalLookAtBlock, GoalPlaceBlock, GoalFollow },
    ...env.P,
    _craftItemFailCount: 0, _killMobFailCount: 0, _mineBlockFailCount: 0, _placeItemFailCount: 0, _smeltItemFailCount: 0,
    None: null,
    console: { log: env.log, info: env.log, warn: env.log, error: env.log },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}
  });
  const errors = [];
  const files = fs.readdirSync(dir).filter(n => n.endsWith('.js') && n !== own).sort();
  if (own && fs.existsSync(path.join(dir, own))) files.push(own);
  for (const f of files) {
    try { vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: `${libId}/${f}`, timeout: 2000 }); }
    catch (e) { errors.push(`${f}: ${errText(e)}`); }
  }
  return { ctx, errors };
}

const invMap = snap => { const m = {}; for (const i of (snap && snap.inventory) || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const armorOf = snap => ((snap && snap.armor) || []).slice().sort().join(',');

// Запустить один чужой навык. entry = {id, lib, fn}. Итог: ok (без ошибки и что-то прибавилось/надето), gained, err, calls.
async function runForeign(api, entry, opts = {}) {
  const env = makeEnv(api, opts);
  await env.refresh();
  const before = invMap(env.S.snap), armor0 = armorOf(env.S.snap), food0 = Number(env.S.snap && env.S.snap.food) || 0;
  const { ctx, errors } = loadLib(entry.lib, env, entry.file || entry.fn + '.js');
  const fn = ctx[entry.fn];
  let err = null;
  if (typeof fn !== 'function') err = `нет функции ${entry.fn} в ${entry.lib}${errors.length ? ' (' + errors.join('; ').slice(0, 200) + ')' : ''}`;
  else {
    try { await fn(env.bot); } catch (e) { err = errText(e); }
  }
  try { await env.refresh(false); } catch (e) {}
  const after = invMap(env.S.snap);
  const gained = {};
  for (const [n, c] of Object.entries(after)) if (c > (before[n] || 0)) gained[n] = c - (before[n] || 0);
  const fed = Number(env.S.snap && env.S.snap.food) > food0;
  const progress = Object.keys(gained).length > 0 || armorOf(env.S.snap) !== armor0 || fed || env.S.effects > 0;
  return { id: entry.id, ok: !err && progress, err: err || (progress ? null : 'ничего не прибавилось'), gained, calls: env.S.calls, chat: env.S.chat.slice(-4), sec: Math.round((Date.now() - env.t0) / 1000) };
}

module.exports = { runForeign, makeEnv, loadLib, parseSurvey, mcData, multOf, HERE };
