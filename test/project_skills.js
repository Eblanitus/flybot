// Офлайн-проверка строительных навыков проекта (gather_list, setup_base, deposit, build_hut, build_fence_line,
// stairs_down, mine_tunnel) на фальшивом мире и фальшивом api: dry-подсчёт, отказ без материалов, основной путь.
// Мир: суша x>=-398 (трава y=66, земля 64-65, камень ниже), к западу каньон (камень до y=38, вода 39-40).
'use strict';
const assert = require('assert');
const L = n => require('../brain/learned/' + n);

const AIR = /^(air|cave_air|short_grass|snow|torch|wall_torch)$/;
const NONSOLID = /^(air|cave_air|short_grass|snow|torch|wall_torch|water|lava)$/;
const DROP = { stone: 'cobblestone', grass_block: 'dirt', coal_ore: 'coal', iron_ore: 'raw_iron' };
const RECIPES = {
  spruce_planks: { out: 4, ing: { spruce_log: 1 } }, stick: { out: 4, ing: { spruce_planks: 2 } },
  crafting_table: { out: 1, ing: { spruce_planks: 4 } }, chest: { out: 1, ing: { spruce_planks: 8 } },
  furnace: { out: 1, ing: { cobblestone: 8 } }, spruce_door: { out: 3, ing: { spruce_planks: 6 } },
  spruce_fence: { out: 3, ing: { spruce_planks: 4, stick: 2 } }, torch: { out: 4, ing: { coal: 1, stick: 1 } }
};
const COLLECT = { stone: 'cobblestone', spruce_log: 'spruce_log', coal: 'coal', dirt: 'dirt' };

function gen(x, y, z) {
  if (x >= -398) return y > 66 ? 'air' : y === 66 ? 'grass_block' : y >= 64 ? 'dirt' : 'stone';
  return y > 40 ? 'air' : y >= 39 ? 'water' : 'stone';
}

function mkWorld(inv0, opts = {}) {
  const blocks = new Map(); const inv = { ...inv0 }; const calls = []; const marks = { ...(opts.marks || {}) }; const chests = {};
  let pos = { x: -393.5, y: 67, z: 36.5 };
  const K = (x, y, z) => x + ',' + y + ',' + z;
  const get = (x, y, z) => blocks.has(K(x, y, z)) ? blocks.get(K(x, y, z)) : gen(x, y, z);
  const set = (x, y, z, b) => blocks.set(K(x, y, z), b);
  for (const [k, v] of Object.entries(opts.blocks || {})) blocks.set(k, v);
  const add = (n, c) => { inv[n] = (inv[n] || 0) + c; if (inv[n] <= 0) delete inv[n]; };
  const fail = (a, m) => { const e = new Error(`навык тела "${a}" не удался: ${m}`); throw e; };

  function survey(p) {
    const x1 = Math.min(p.x1, p.x2), x2 = Math.max(p.x1, p.x2), y1 = Math.min(p.y1, p.y2), y2 = Math.max(p.y1, p.y2), z1 = Math.min(p.z1, p.z2), z2 = Math.max(p.z1, p.z2);
    const vol = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
    if (vol > 4096) fail('survey', `объём слишком большой: ${vol}`);
    const legend = { '.': 'air' }, codeOf = { air: '.' }; let ci = 0;
    const POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const code = n => codeOf[n] || (codeOf[n] = POOL[ci++], legend[codeOf[n]] = n, codeOf[n]);
    const layers = {}; const hm = [];
    for (let z = z1; z <= z2; z++) hm.push(new Array(x2 - x1 + 1).fill(null));
    for (let y = y2; y >= y1; y--) {
      const rows = [];
      for (let z = z1; z <= z2; z++) {
        let row = '';
        for (let x = x1; x <= x2; x++) { const b = get(x, y, z); row += code(b); if (!NONSOLID.test(b) && hm[z - z1][x - x1] === null) hm[z - z1][x - x1] = y; }
        rows.push(row);
      }
      layers['y=' + y] = rows;
    }
    const edges = [];
    for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) {
      const top = hm[z - z1][x - x1]; if (top === null) continue;
      const dirs = []; let drop = 0;
      for (const [ox, oz, nm] of [[1, 0, 'В'], [-1, 0, 'З'], [0, 1, 'Ю'], [0, -1, 'С']]) {
        const nx = x + ox, nz = z + oz; if (nx < x1 || nx > x2 || nz < z1 || nz > z2) continue;
        let nt = hm[nz - z1][nx - x1]; if (nt === null) nt = y1 - 1;
        if (top - nt >= 3) { dirs.push(nm); drop = Math.max(drop, top - nt); }
      }
      if (dirs.length) edges.push({ x, y: top, z, drop, dirs: dirs.join('') });
    }
    return { ok: true, origin: { x: x1, y: y1, z: z1 }, legend, layers, heightmap: hm, edges };
  }

  const api = {
    calls, inv, marks, chests, get, set, logs: [],
    log(m) { api.logs.push(m); },
    async sleep() {},
    async snapshot() {
      const eyes = { blocks: {} };
      if (opts.tableNear) eyes.blocks.crafting_table = { d: 3 };
      return { position: { ...pos }, inventory: Object.entries(inv).filter(([, c]) => c > 0).map(([name, count], slot) => ({ slot, name, count })), eyes, health: 20, food: 20 };
    },
    async count(n) { const t = n instanceof RegExp ? k => n.test(k) : Array.isArray(n) ? k => n.includes(k) : k => k === n; return Object.entries(inv).filter(([k]) => t(k)).reduce((s, [, c]) => s + c, 0); },
    async skill(name, params) { return L(name).run(api, params); },
    async cmd(a, p = {}) {
      calls.push({ a, p });
      switch (a) {
        case 'survey': return survey(p);
        case 'goto': pos = { x: p.x + 0.5, y: p.y !== undefined ? p.y : pos.y, z: p.z + 0.5 }; return { ok: true };
        case 'equip_best': case 'explore': return { ok: true };
        case 'place_at': {
          if (!(inv[p.item] > 0)) fail(a, 'нет в инвентаре: ' + p.item);
          const cur = get(p.x, p.y, p.z);
          if (!AIR.test(cur) && cur !== 'water') fail(a, `место ${p.x},${p.y},${p.z} занято: ${cur}`);
          const nb = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([a2, b, c]) => !NONSOLID.test(get(p.x + a2, p.y + b, p.z + c)));
          if (!nb) fail(a, 'не к чему прислонить блок');
          set(p.x, p.y, p.z, p.item); add(p.item, -1);
          if (/_door$/.test(p.item)) set(p.x, p.y + 1, p.z, p.item);
          return { placed: p.item, at: [p.x, p.y, p.z] };
        }
        case 'dig_at': {
          const cur = get(p.x, p.y, p.z);
          if (AIR.test(cur)) fail(a, `нет такого блока в ${p.x},${p.y},${p.z}: air`);
          if (/water|lava/.test(cur)) fail(a, 'жидкость');
          for (const [a2, b, c] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) if (get(p.x + a2, p.y + b, p.z + c) === 'lava') fail(a, 'отказ: рядом с блоком лава');
          set(p.x, p.y, p.z, 'air'); add(DROP[cur] || cur, 1);
          return { dug: cur };
        }
        case 'craft': {
          const r = RECIPES[p.item]; if (!r) fail(a, 'неизвестный предмет');
          if (p.item === 'spruce_planks' && p.count > 8) { inv.spruce_log = 0; fail(a, 'missing ingredient'); } // баг тела из notes.md
          const times = Math.ceil(p.count / r.out);
          for (const [k, c] of Object.entries(r.ing)) if ((inv[k] || 0) < c * times) fail(a, `не хватает: ${k} x${c * times - (inv[k] || 0)}`);
          for (const [k, c] of Object.entries(r.ing)) add(k, -c * times);
          add(p.item, r.out * times); return { item: p.item, made: r.out * times };
        }
        case 'collect': {
          if ((opts.noCollect || []).includes(p.block)) fail(a, `не вижу ${p.block} — исследуй`);
          add(COLLECT[p.block] || p.block, p.count); return { got: p.count };
        }
        case 'mark': marks[p.name] = [p.x, p.y, p.z]; return { marked: p.name, at: [p.x, p.y, p.z] };
        case 'waypoints': return { waypoints: Object.entries(marks).map(([name, at]) => ({ name, at })) };
        case 'chest_store': {
          if (get(p.x, p.y, p.z) !== 'chest') fail(a, 'не вижу сундука рядом');
          const stored = {}; const ch = chests[K(p.x, p.y, p.z)] = chests[K(p.x, p.y, p.z)] || {};
          for (const n of p.items) { const c = Math.min(p.count || inv[n] || 0, inv[n] || 0); if (!c) continue; add(n, -c); ch[n] = (ch[n] || 0) + c; stored[n] = c; }
          return { chest: [p.x, p.y, p.z], stored };
        }
        default: fail(a, 'unknown action');
      }
    }
  };
  return api;
}
const acts = (api, a) => api.calls.filter(c => c.a === a);

async function testGather() {
  const items = 'cobblestone:20,spruce_planks:8,spruce_fence:3,torch:4';
  let w = mkWorld({ spruce_log: 5, coal: 1, cobblestone: 10 });
  let r = await L('gather_list').run(w, { items, dry: 1 });
  assert(r.ok && r.dry, JSON.stringify(r));
  assert.deepStrictEqual(r.missing, { cobblestone: 10 }, JSON.stringify(r));
  assert(r.crafts.some(c => c.item === 'crafting_table'), 'верстак в плане');
  assert.strictEqual(w.calls.filter(c => c.a !== 'survey').length, 0, 'dry ничего не делает');
  // основной путь: добыть камень, доски партиями по 4 (баг тела на больших партиях не задет)
  r = await L('gather_list').run(w, { items, max_sec: 60 });
  assert(r.ok, JSON.stringify(r));
  assert(w.inv.cobblestone >= 20 && w.inv.spruce_planks >= 8 && w.inv.spruce_fence >= 3 && w.inv.torch >= 4, JSON.stringify(w.inv));
  assert(acts(w, 'craft').filter(c => c.p.item === 'spruce_planks').every(c => c.p.count <= 4), 'доски партиями');
  // нечего добыть: брёвен нет и не видно — честный missing
  w = mkWorld({ cobblestone: 5 }, { noCollect: ['spruce_log'] });
  r = await L('gather_list').run(w, { items: 'spruce_door:1', max_sec: 60 });
  assert(!r.ok && r.missing.spruce_door === 1 && /spruce_door/.test(r.error), JSON.stringify(r));
  console.log('gather_list: OK');
}

async function testSetupBase() {
  let w = mkWorld({ cobblestone: 3 });
  let r = await L('setup_base').run(w, { x: -393, y: 67, z: 36, dry: 1 });
  assert(r.ok && r.dry && r.missing.cobblestone === 5 && r.missing.spruce_planks === 12, JSON.stringify(r));
  r = await L('setup_base').run(w, { x: -393, y: 67, z: 36 });
  assert(!r.ok && r.missing && acts(w, 'place_at').length === 0, 'без материалов не ставит');
  w = mkWorld({ cobblestone: 20, spruce_log: 3 });
  r = await L('setup_base').run(w, { x: -393, y: 67, z: 36, avoid: '-398,28,-392,34' });
  assert(r.ok, JSON.stringify(r));
  assert(r.placed.crafting_table && r.placed.furnace && r.placed.chest, JSON.stringify(r));
  for (const at of Object.values(r.placed)) assert(!(at[0] >= -398 && at[0] <= -392 && at[2] >= 28 && at[2] <= 34), 'не в месте хижины');
  assert.deepStrictEqual(w.marks.home, [-393, 67, 36]);
  // повтор: всё уже стоит
  r = await L('setup_base').run(w, { x: -393, y: 67, z: 36, dry: 1 });
  assert(r.ok && Object.keys(r.existing).length === 3 && !Object.keys(r.missing).length, JSON.stringify(r));
  console.log('setup_base: OK');
}

async function testDeposit() {
  let w = mkWorld({ stone_pickaxe: 1, cobblestone: 50, dirt: 10, cooked_beef: 3, torch: 5, iron_helmet: 1 }, { marks: { home: [-393, 67, 36] }, blocks: { '-391,67,36': 'chest' } });
  let r = await L('deposit').run(w, { keep: 'pickaxe,food,torch,cobblestone:16', dry: 1 });
  assert(r.ok && r.dry && r.store.dirt === 10 && r.store.cobblestone === 34 && !r.store.cooked_beef && !r.store.iron_helmet, JSON.stringify(r));
  r = await L('deposit').run(w, { keep: 'pickaxe,food,torch,cobblestone:16' });
  assert(r.ok && r.stored.dirt === 10 && r.stored.cobblestone === 34, JSON.stringify(r));
  assert(w.inv.cobblestone === 16 && w.inv.stone_pickaxe === 1 && w.inv.torch === 5 && w.inv.cooked_beef === 3);
  // нет метки и координат — отказ
  w = mkWorld({ dirt: 3 });
  r = await L('deposit').run(w, {});
  assert(!r.ok && /home/.test(r.error), JSON.stringify(r));
  // нет сундука — крафтит из досок и ставит
  w = mkWorld({ spruce_planks: 12, dirt: 7 }, { tableNear: true });
  r = await L('deposit').run(w, { x: -393, y: 67, z: 36 });
  assert(r.ok && r.placedChest && r.stored.dirt === 7, JSON.stringify(r));
  console.log('deposit: OK');
}

async function testHut() {
  const full = { cobblestone: 100, spruce_log: 10, spruce_planks: 60, spruce_door: 1 };
  let w = mkWorld(full);
  let r = await L('build_hut').run(w, { x: -397, z: 29, y: 66, dry: 1 });
  // пол — трава, навык (brain/learned, правка 22.10) считает его стоящим; стены 69 - 8 брёвен = 61 булыжник; 8 брёвен; крыша 49; дверь
  assert(r.ok && r.dry, JSON.stringify(r));
  assert.deepStrictEqual(r.need, { cobblestone: 61, spruce_log: 8, spruce_planks: 49, spruce_door: 1 }, JSON.stringify(r.need));
  assert.deepStrictEqual(r.door, { x: -398, y: 67, z: 31 });
  assert.strictEqual(Object.keys(r.missing).length, 0);
  // нет двери и мало досок — навык (brain/learned, правка 22.10) строит из того, что есть, и честно говорит, чего не хватило; копки нет
  w = mkWorld({ cobblestone: 100, spruce_log: 10, spruce_planks: 20 });
  r = await L('build_hut').run(w, { x: -397, z: 29, y: 66 });
  assert(!r.ok && r.missing.spruce_planks === 29 && !r.doorOk && /spruce_door/.test(r.doorWhy), JSON.stringify(r));
  assert.strictEqual(acts(w, 'dig_at').length, 0, 'без материалов не копает');
  // основной путь
  w = mkWorld(full);
  r = await L('build_hut').run(w, { x: -397, z: 29, y: 66 });
  assert(r.ok && r.built === r.total && r.doorOk, JSON.stringify(r));
  assert.strictEqual(w.get(-398, 67, 31), 'spruce_door');
  assert.strictEqual(w.get(-398, 68, 29), 'air', 'окно на запад');
  assert.strictEqual(w.get(-395, 67, 31), 'air', 'внутри пусто');
  // второй раз: всё стоит, ставить нечего
  r = await L('build_hut').run(w, { x: -397, z: 29, y: 66, dry: 1 });
  assert(r.already === r.total && !Object.keys(r.need).length, JSON.stringify(r));
  console.log('build_hut: OK');
}

async function testFence() {
  let w = mkWorld({ spruce_fence: 9 });
  let r = await L('build_fence_line').run(w, { x: -393, z: 36, r: 8, y: 66, dry: 1 });
  assert(r.ok && r.dry && r.need.spruce_fence === 17 && r.missing.spruce_fence === 8, JSON.stringify(r));
  assert(r.cells.every(c => c[0] === -398 && c[1] === 66), 'кромка обрыва на суше');
  r = await L('build_fence_line').run(w, { x: -393, z: 36, r: 8, y: 66 });
  assert(!r.ok && r.missing.spruce_fence === 8 && acts(w, 'place_at').length === 0, JSON.stringify(r));
  // только 9 — ограничить max=9 у меня под ногами
  r = await L('build_fence_line').run(w, { x: -393, z: 36, r: 8, y: 66, max: 9 });
  assert(r.ok && r.placed === 9 && r.verified === 9, JSON.stringify(r));
  // повтор с запасом: 9 уже стоит, ставит остальные 8
  w.inv.spruce_fence = 10;
  r = await L('build_fence_line').run(w, { x: -393, z: 36, r: 8, y: 66 });
  assert(r.ok && r.already === 9 && r.placed === 8 && r.verified === 17, JSON.stringify(r));
  console.log('build_fence_line: OK');
}

async function testStairs() {
  // дыра сбоку на ступени 3 -> перила; до y=60
  let w = mkWorld({ cobblestone: 10, torch: 4 }, { blocks: { '-398,64,33': 'air' } });
  let r = await L('stairs_down').run(w, { x: -397, y: 67, z: 30, dir: 'south', to: 60, torch_every: 3, dry: 1 });
  assert(r.ok && r.dry && r.need.cobblestone === 1 && r.need.torch === 2, JSON.stringify(r));
  assert.strictEqual(acts(w, 'dig_at').length, 0);
  r = await L('stairs_down').run(w, { x: -397, y: 67, z: 30, dir: 'south', to: 60, torch_every: 3 });
  assert(r.ok && r.reached === 'y' && r.steps === 7 && r.torches === 2, JSON.stringify(r));
  assert.strictEqual(w.get(-398, 64, 33), 'cobblestone', 'перила');
  for (let k = 1; k <= 7; k++) for (const dy of [0, 1, 2]) assert(/air|torch/.test(w.get(-397, 67 - k + dy, 30 + k)), `проход 3 в ступени ${k}`);
  // вода в стене -> цель to=water
  w = mkWorld({ cobblestone: 10 }, { blocks: { '-397,63,34': 'water' } });
  r = await L('stairs_down').run(w, { x: -397, y: 67, z: 30, dir: 'south' });
  assert(r.ok && r.reached === 'water' && r.steps === 3, JSON.stringify(r));
  // лава -> стоп, лаву не копает
  w = mkWorld({ cobblestone: 10 }, { blocks: { '-397,61,36': 'lava' } });
  r = await L('stairs_down').run(w, { x: -397, y: 67, z: 30, dir: 'south', to: 50 });
  assert(!r.ok && /лава/.test(r.stopped) && r.steps < 6, JSON.stringify(r));
  console.log('stairs_down: OK');
}

async function testTunnel() {
  const blocks = { '-394,61,31': 'iron_ore', '-392,60,29': 'water', '-388,60,30': 'lava', '-395,59,30': 'coal_ore' };
  let w = mkWorld({ stone_pickaxe: 1, torch: 2, cobblestone: 3 }, { blocks });
  let r = await L('mine_tunnel').run(w, { x: -397, y: 60, z: 30, dir: 'east', length: 10, torch_every: 4, dry: 1 });
  assert(r.ok && r.dry && r.need.torch === 2 && /ЛАВА/.test(r.plan) && r.missing.cobblestone === 5, JSON.stringify(r));
  // без кирки — отказ
  r = await L('mine_tunnel').run(mkWorld({ torch: 2 }, { blocks }), { x: -397, y: 60, z: 30, dir: 'east' });
  assert(!r.ok && /кирк/.test(r.error), JSON.stringify(r));
  r = await L('mine_tunnel').run(w, { x: -397, y: 60, z: 30, dir: 'east', length: 10, torch_every: 4 });
  assert(r.ok && /лава/.test(r.stopped) && r.dug === 7, JSON.stringify(r));
  assert(r.ores.some(o => o.name === 'iron_ore' && o.x === -394) && r.ores.some(o => o.name === 'coal_ore'), JSON.stringify(r.ores));
  assert(r.sealed.some(s => s.join() === '-392,60,29') && w.get(-392, 60, 29) === 'cobblestone', 'вода заделана');
  assert.strictEqual(r.torches, 1);
  assert.notStrictEqual(w.get(-388, 60, 30), 'air');
  // без лавы — полная длина
  w = mkWorld({ stone_pickaxe: 1, torch: 4 });
  r = await L('mine_tunnel').run(w, { x: -397, y: 60, z: 30, dir: 'south', length: 12 });
  assert(r.ok && r.dug === 12 && !r.stopped && r.torches === 1, JSON.stringify(r));
  console.log('mine_tunnel: OK');
}

module.exports = async () => {
  await testGather(); await testSetupBase(); await testDeposit(); await testHut();
  await testFence(); await testStairs(); await testTunnel();
};
if (require.main === module) module.exports().then(() => console.log('project_skills: OK'), e => { console.error(e); process.exit(1); });
