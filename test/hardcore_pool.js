// Офлайн-проверка пула навыков хардкор-стенда (hardcore/pool): все чужие навыки каталога загружаются и проходят через переходник
// на поддельном теле без ошибок самого переходника (ReferenceError/TypeError — значит, чужой код ждёт того, чего у фасада нет);
// выбор с температурой (70% лучший, 30% новичок); дело по сумке; диспетчер day_routine_v7 пишет итог в общую память.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CATALOG = require('../hardcore/pool/catalog.json');
const shim = require('../hardcore/pool/shim');
const pick = require('../hardcore/pool/pick');
const run = require('../hardcore/pool/run');

// ---- поддельный мир и тело ----
const DROP = { stone: 'cobblestone', grass_block: 'dirt', coal_ore: 'coal', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', diamond_ore: 'diamond', deepslate: 'cobbled_deepslate', gravel: 'flint', wheat: 'wheat', carrots: 'carrot', potatoes: 'potato', short_grass: 'wheat_seeds' };
const SMELT = { raw_iron: 'iron_ingot', beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', cobblestone: 'stone', sand: 'glass' };
const MEAT = { cow: 'beef', pig: 'porkchop', chicken: 'chicken', sheep: 'mutton' };

function world(bare = false) {
  const m = new Map();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) {
    for (let y = 50; y <= 62; y++) m.set(`${x},${y},${z}`, 'stone');
    m.set(`${x},63,${z}`, 'grass_block');
  }
  if (bare) return m;   // пустой мир: камень и трава, без руды, растений, воды и животных (проверка «навык ходит впустую без цели»)
  for (let y = 64; y <= 67; y++) m.set(`3,${y},0`, 'oak_log');
  m.set('3,68,0', 'oak_leaves');
  m.set('-4,63,-4', 'water'); m.set('-5,63,-4', 'water');
  m.set('2,64,2', 'short_grass'); m.set('-2,64,3', 'wheat'); m.set('-3,64,3', 'carrots'); m.set('-4,64,3', 'potatoes');
  m.set('1,62,1', 'coal_ore'); m.set('2,61,1', 'iron_ore'); m.set('0,58,2', 'deepslate_iron_ore'); m.set('0,52,0', 'diamond_ore');
  m.set('-1,60,0', 'deepslate'); m.set('4,63,4', 'gravel'); m.set('-2,63,-2', 'farmland');
  return m;
}

function fakeBody(startInv, bare = false) {
  const items = { ...startInv }; const calls = []; const armor = []; const grid = world(bare);
  let food = 14; const pos = { x: 0.5, y: 64, z: 0.5 };
  const add = (n, k = 1) => { items[n] = (items[n] || 0) + k; };
  const ents = bare ? [] : [['cow', 'animal', 4, 0], ['pig', 'animal', -4, 1], ['sheep', 'animal', 0, 5], ['chicken', 'animal', 5, 5], ['zombie', 'hostile', 8, -8], ['skeleton', 'hostile', -8, 8], ['spider', 'hostile', 9, 2], ['creeper', 'hostile', -9, -2]];
  const api = {
    log() {},
    async snapshot() {
      return {
        username: 'HC_T', health: 20, food, armor: armor.slice(), position: { ...pos }, time: 3000, timeOfDay: 'day',
        inventory: Object.entries(items).filter(([, c]) => c > 0).map(([name, count], slot) => ({ slot: slot + 9, name, count })),
        eyes: { blocks: { iron_ore: { d: 30, n: 1, at: [20, 40, 20] }, log: { d: 25, n: 3, at: [-20, 64, 10] }, water: { d: 6, n: 2, at: [-4, 63, -4] } }, animals: [] }
      };
    },
    async cmd(action, p = {}) {
      calls.push(action);
      switch (action) {
        case 'survey': {
          const r = Math.min(p.radius || 6, 9), dy = Math.min(p.dy || 3, 4);
          if ((2 * r + 1) ** 2 * (2 * dy + 1) > 4096) throw new Error('навык тела "survey" не удался: объём слишком большой');
          const o = { x: Math.floor(pos.x) - r, y: Math.floor(pos.y) - dy, z: Math.floor(pos.z) - r };
          const legend = { '.': 'air' }, code = {}; let next = 65;
          const layers = {};
          for (let y = o.y; y <= o.y + 2 * dy; y++) {
            const rows = [];
            for (let z = o.z; z <= o.z + 2 * r; z++) {
              let row = '';
              for (let x = o.x; x <= o.x + 2 * r; x++) {
                const n = grid.get(`${x},${y},${z}`);
                if (!n) { row += '.'; continue; }
                if (!code[n]) { code[n] = String.fromCharCode(next++); legend[code[n]] = n; }
                row += code[n];
              }
              rows.push(row);
            }
            layers['y=' + y] = rows;
          }
          return { origin: o, legend, layers };
        }
        case 'scan': return { entities: ents.map(([name, type, x, z]) => ({ type, name, distance: Math.hypot(x, z), position: { x, y: 64, z } })) };
        case 'collect': {
          const b = String(p.block); add(DROP[b] || (b === 'log' ? 'oak_log' : b), p.count || 1); return { mined: p.count || 1 };
        }
        case 'craft': add(p.item, p.count || 1); return { made: p.count || 1 };
        case 'smelt': { const out = SMELT[p.item] || p.item; add(out, p.count || 1); return { got: p.count || 1 }; }
        case 'hunt': add(MEAT[p.animal] || 'beef'); return { kills: 1 };
        case 'fight': add(p.target === 'skeleton' ? 'bone' : p.target === 'spider' ? 'string' : p.target === 'creeper' ? 'gunpowder' : 'rotten_flesh'); return { kills: 1 };
        case 'place_at': {
          if (!items[p.item]) throw new Error(`навык тела "place_at" не удался: нет в инвентаре: ${p.item}`);
          items[p.item]--; grid.set(`${p.x},${p.y},${p.z}`, p.item); return { placed: true };
        }
        case 'dig_at': { const k = `${p.x},${p.y},${p.z}`; const n = grid.get(k); if (n) { grid.delete(k); add(DROP[n] || n); } return { dug: n || null }; }
        case 'equip_item': {
          if (!items[p.item]) throw new Error(`навык тела "equip_item" не удался: нет в инвентаре: ${p.item}`);
          if (['head', 'torso', 'legs', 'feet'].includes(p.slot) || /_(helmet|chestplate|leggings|boots)$/.test(p.item)) { items[p.item]--; armor.push(p.item); }
          return { equipped: p.item };
        }
        case 'eat': food = 20; return { ate: 1 };
        case 'fish': add('cod'); return { casts: 1, caught: { cod: 1 } };
        case 'till': grid.set(`${p.x},${p.y},${p.z}`, 'farmland'); return { tilled: 1 };
        case 'plant': if (items[p.seed]) items[p.seed]--; return { planted: 1 };
        case 'harvest': add('wheat', 3); add('wheat_seeds', 2); return { got: 3 };
        case 'breed': return { animal: p.animal, fed: [1, 2], baby: true };
        case 'shear': add('white_wool', 2); return { wool: 2 };
        case 'use_item': if (p.item === 'bucket') { items.bucket--; add(p.entity === 'cow' ? 'milk_bucket' : 'water_bucket'); } return { used: true };
        case 'activate': return { ok: true };
        case 'goto': pos.x = p.x + 0.5; pos.z = p.z + 0.5; if (Number.isFinite(p.y)) pos.y = p.y; return { ok: true };
        case 'explore': pos.x += 3; return { moved: 24 };
        case 'descend': pos.y -= 6; return { y: pos.y };
        default: throw new Error(`навык тела "${action}" не удался: неизвестно`);
      }
    },
    async skill(name) {
      calls.push('skill:' + name);
      add('oak_log', 3);
      return { ok: true, did: name };
    }
  };
  return { api, items, calls, armor };
}

const RICH = {
  oak_log: 16, oak_planks: 32, stick: 16, crafting_table: 1, cobblestone: 32, furnace: 1, coal: 16, iron_ingot: 24, raw_iron: 6,
  wooden_pickaxe: 1, stone_pickaxe: 1, iron_pickaxe: 1, stone_sword: 1, iron_sword: 1, stone_axe: 1, wooden_hoe: 1, shears: 1, bucket: 2,
  fishing_rod: 1, string: 6, white_wool: 3, wheat_seeds: 6, wheat: 6, beef: 3, porkchop: 3, chicken: 3, mutton: 3, cooked_mutton: 2,
  iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1, bow: 1, arrow: 16, feather: 4, flint: 4, torch: 4, chest: 1, sand: 4
};
const FACADE_BUG = /is not defined|is not a function|Cannot read propert|Cannot set propert|is not iterable|undefined \(reading|null \(reading/;

module.exports = async () => {
  // 1) каталог: 88 навыков, у каждого есть функция в своей библиотеке, библиотеки грузятся без ошибок
  const all = Object.entries(CATALOG).flatMap(([delo, l]) => l.map(e => ({ ...e, delo })));
  assert.strictEqual(all.length, 87, 'навыков в каталоге');
  assert.deepStrictEqual(Object.keys(CATALOG).sort(), ['bed', 'combat', 'farm', 'food', 'furnace', 'iron', 'night', 'stone', 'wood']);
  assert.strictEqual(new Set(all.map(e => e.id)).size, all.length, 'id навыков уникальны');
  for (const lib of new Set(all.map(e => e.lib))) {
    const env = shim.makeEnv(fakeBody({}).api, { maxSec: 10 });
    const { ctx, errors } = shim.loadLib(lib, env);
    assert.deepStrictEqual(errors, [], `${lib}: ${errors.join('; ')}`);
    for (const e of all.filter(x => x.lib === lib)) assert.strictEqual(typeof ctx[e.fn], 'function', `${e.id}: нет функции ${e.fn}`);
  }
  for (const lic of ['voyager/LICENSE', 'odyssey/LICENSE']) assert(/MIT License/.test(fs.readFileSync(path.join(shim.HERE, lic), 'utf8')), lic);
  // в чужом коде нет команд сервера и доступа к процессу
  for (const lib of new Set(all.map(e => e.lib))) for (const f of fs.readdirSync(path.join(shim.HERE, lib)).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(shim.HERE, lib, f), 'utf8');
    assert(!/bot\.chat\(\s*['"`]\//.test(src) && !/\brequire\s*\(|\bprocess\.|\beval\s*\(/.test(src), `${lib}/${f}: команда сервера или доступ к процессу`);
  }

  // 2) survey переходника укладывается в лимит тела (4096 блоков) и разбирается в блоки
  {
    const h = fakeBody({});
    const env = shim.makeEnv(h.api, { maxSec: 10 });
    await env.refresh();
    assert(env.S.grid.size > 1000, 'survey разобран: ' + env.S.grid.size);
    const log = env.bot.findBlock({ matching: b => b.name === 'oak_log', maxDistance: 16 });
    assert(log && log.position.x === 3 && log.name === 'oak_log');
    const far = env.bot.findBlock({ matching: b => b.name.endsWith('_log'), maxDistance: 32, point: { x: -20, y: 64, z: 10 } });
    assert(far && /_log$/.test(far.name) && env.bot.blockAt(far.position), 'бревно из глаз (ключ log) находится и знакомо blockAt');
    assert.strictEqual(env.bot.inventory.count('oak_log'), 0);
    assert(env.bot.nearestEntity(e => e.name === 'cow').position.x === 4);
  }

  // 3) каждый навык каталога на поддельном теле: без ошибок переходника, большинство что-то даёт (или пашет, сажает, кормит, ест)
  const results = [];
  for (const e of all) {
    const h = fakeBody(RICH);
    const r = await shim.runForeign(h.api, e, { maxSec: 3 });
    results.push({ ...r, delo: e.delo });
    assert(!FACADE_BUG.test(r.err || ''), `${e.id}: ошибка переходника: ${r.err} | ${r.calls.join(' ')}`);
    assert(r.sec <= 5, `${e.id}: ${r.sec} с — не уложился в потолок`);
  }
  const ok = results.filter(r => r.ok).length;
  assert(ok >= 60, `удались на поддельном теле только ${ok} из ${results.length}: ` + results.filter(r => !r.ok).map(r => `${r.id} (${r.err})`).join('; '));
  if (process.env.POOL_VERBOSE) for (const r of results) console.log(r.ok ? 'ok  ' : 'FAIL', r.id, r.err || '', JSON.stringify(r.gained), r.calls.join(' '));

  // 4) выбор с температурой
  {
    const cands = [{ id: 'day_routine_v6', native: true }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
    const st = new Map([['wood/day_routine_v6', { runs: 10, ok: 5 }], ['wood/a', { runs: 6, ok: 6 }], ['wood/b', { runs: 2, ok: 0 }]]);
    assert.strictEqual(pick.choose('wood', cands, st, () => 0.1).id, 'a', '70%: лучший из опытных (a 7/8 > родной 6/12)');
    const probe = pick.choose('wood', cands, st, () => 0.9);
    assert.strictEqual(probe.id, 'c', '30%: новичок, первым — ни разу не пробованный');
    assert(/новичок/.test(probe.why));
    // в новом мире без памяти: «лучший» — родной (он один опытный), проба — любой из нетронутых
    assert.strictEqual(pick.choose('wood', cands, new Map(), () => 0.5).id, 'day_routine_v6');
    assert.notStrictEqual(pick.choose('wood', cands, new Map(), () => 0.95).id, 'day_routine_v6');
    // все опытные — новичков нет: всегда лучший
    const vet = new Map([['wood/day_routine_v6', { runs: 10, ok: 2 }], ['wood/a', { runs: 9, ok: 7 }], ['wood/b', { runs: 5, ok: 1 }], ['wood/c', { runs: 5, ok: 0 }]]);
    assert.strictEqual(pick.choose('wood', cands, vet, () => 0.99).id, 'a');
    // доли на 2000 бросках: лучший ~70%
    let best = 0; for (let i = 0; i < 2000; i++) if (pick.choose('wood', cands, st).id === 'a') best++;
    assert(best > 1250 && best < 1550, 'доля лучшего ' + best);
  }

  // 5) дело по сумке
  {
    const s = inv => ({ inventory: Object.entries(inv).map(([name, count]) => ({ name, count })), food: 20, armor: [], eyes: { blocks: {} } });
    assert.strictEqual(run.deloOf(s({ oak_log: 3 }), 'day'), 'wood');
    assert.strictEqual(run.deloOf(s({ wooden_pickaxe: 1 }), 'day'), 'stone');
    assert.strictEqual(run.deloOf(s({ stone_pickaxe: 1 }), 'day', () => 0.1), 'food');
    assert.strictEqual(run.deloOf(s({ stone_pickaxe: 1 }), 'day', () => 0.9), 'farm');
    assert.strictEqual(run.deloOf(s({ stone_pickaxe: 1, cooked_beef: 8 }), 'day'), 'furnace');
    assert.strictEqual(run.deloOf(s({ stone_pickaxe: 1, cooked_beef: 8, furnace: 1, torch: 4 }), 'day'), 'iron');
    assert.strictEqual(run.deloOf({ ...s({ iron_pickaxe: 1, cooked_beef: 8, furnace: 1, torch: 4 }), armor: ['iron_chestplate'] }, 'day'), 'bed');
    assert(run.DAY_DELA.includes(run.deloOf(s({ iron_pickaxe: 1, iron_helmet: 1, cooked_beef: 8, furnace: 1, torch: 4, white_bed: 1 }), 'day')));
    assert.strictEqual(run.deloOf(s({ stone_sword: 1 }), 'night', () => 0.1), 'combat');
    assert.strictEqual(run.deloOf(s({ stone_sword: 1 }), 'night', () => 0.9), 'night');
    assert.strictEqual(run.deloOf(s({}), 'night', () => 0.1), 'night', 'без оружия ночью в бой не идём');
    const c = run.candidates('bed', 'day_routine_v6');
    assert.strictEqual(c.length, 5); assert(c[0].native && c[0].id === 'day_routine_v6');
  }

  // 6) day_routine_v7 / night_mine_v7: вне стенда — родной навык как есть; на стенде — выбор и строка в общей памяти
  {
    const day = require('../brain/learned/day_routine_v7');
    const night = require('../brain/learned/night_mine_v7');
    assert.strictEqual(day.name, 'day_routine'); assert.strictEqual(night.name, 'night_mine');
    for (const f of ['day_routine_v7', 'night_mine_v7']) assert(/^\/\/ версия: /.test(fs.readFileSync(path.join(__dirname, '..', 'brain', 'learned', f + '.js'), 'utf8')), f + ': первая строка «// версия:»');
    const saved = process.env.HC_POOL_RUNS;
    delete process.env.HC_POOL_RUNS;
    let h = fakeBody({});
    let r = await day.run(h.api, { max_sec: 60 });
    assert.deepStrictEqual(h.calls, ['skill:day_routine_v6']); assert.strictEqual(r.did, 'day_routine_v6');
    h = fakeBody({});
    r = await night.run(h.api, {});
    assert.deepStrictEqual(h.calls, ['skill:night_mine_v6']);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
    process.env.HC_POOL_RUNS = path.join(tmp, 'pool_runs.jsonl');
    try {
      const seen = new Set();
      let foreign = 0;
      // зерно для Math.random: проба и выбор новичка идут от него. Без зерна проверка «не меньше 4 разных» падала примерно в одном прогоне из шести (14 запусков, проба 30%)
      const realRandom = Math.random;
      let seedState = 20260411 >>> 0;
      Math.random = () => { seedState = (seedState + 0x6D2B79F5) >>> 0; let t = seedState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < 14; i++) {
        h = fakeBody({});   // пустая сумка: дело «дерево»
        r = await day.run(h.api, { max_sec: 20 });
        assert(r && typeof r.ok === 'boolean', JSON.stringify(r));
        if (r.pool) { assert.strictEqual(r.ok, true, 'чужой навык: автопилоту ok, настоящий итог в pool.ok'); assert.strictEqual(typeof r.pool.ok, 'boolean'); foreign++; }
        else assert.strictEqual(r.did, 'day_routine_v6', 'родной навык: итог как есть');
      }
      Math.random = realRandom;
      assert(foreign > 0);
      const lines = fs.readFileSync(process.env.HC_POOL_RUNS, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.strictEqual(lines.length, 14);
      for (const l of lines) { assert.strictEqual(l.delo, 'wood'); assert.strictEqual(l.fly, 'HC_T'); seen.add(l.skill); }
      assert(seen.has('day_routine_v6'), 'родной навык тоже выбирается');
      assert(seen.size >= 4, 'пробуются разные навыки дела: ' + [...seen].join(', '));
      assert(lines.some(l => l.ok && l.skill !== 'day_routine_v6' && Object.keys(l.gained).length), 'чужой навык что-то добыл');
      const st = pick.readStats();
      assert.strictEqual([...st.values()].reduce((s, x) => s + x.runs, 0), 14);
      // ночь: с мечом иногда бой, иначе ночные навыки
      h = fakeBody({ stone_sword: 1, stone_pickaxe: 1 });
      // потолок 20 с: чужой навык (например v2.exploreCave) может крутиться до потолка; без него тест шёл 300 с и упирался в таймаут прогона
      await night.run(h.api, { max_sec: 20 });
      const last = JSON.parse(fs.readFileSync(process.env.HC_POOL_RUNS, 'utf8').trim().split('\n').pop());
      assert(['night', 'combat'].includes(last.delo), last.delo);
    } finally {
      if (saved === undefined) delete process.env.HC_POOL_RUNS; else process.env.HC_POOL_RUNS = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  console.log(`hardcore_pool: ok (${ok}/${results.length} чужих навыков удались на поддельном теле)`);
};
module.exports.world = world; module.exports.fakeBody = fakeBody; module.exports.RICH = RICH; // для test/hardcore_pool_run.js (Б8)

if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
