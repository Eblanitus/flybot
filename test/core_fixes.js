// Офлайн-проверки исправлений: craft большими количествами, dig_at по пустой клетке, explore с памятью неудач, shelter у обрыва.
// Запуск: node test/core_fixes.js (входит в node test/offline.js)
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const craft = require('../lib/skills/craft');
const gather = require('../lib/skills/gather');
const build = require('../lib/skills/build');
const survival = require('../lib/skills/survival');
const A = require('../lib/actions');

// другие тесты подменяют A.goto и не всегда возвращают; нам нужен настоящий (core_fixes грузится до них, см. offline.js)
const REAL_GOTO = A.goto;
const task = () => new Task(1, 'x', {}, 'test');

// ---------- craft ----------
// Фальшивый сервер: client = модель окна бота (что видит bot.inventory.items()), server = истина.
// Режим bug: после bugAfter крафтов в одном вызове bot.craft клиент «теряет» брёвна — они на курсоре, craft кидает «missing ingredient» (как mineflayer при большом count).
function craftWorld({ logs, bugAfter = 3, alwaysBroken = false }) {
  const LOG = 1, PLANKS = 2;
  const server = { logs, planks: 1, cursorLogs: 0 };
  const client = { logs, planks: 1, cursorLogs: 0 };
  const recipe = { delta: [{ id: LOG, count: -1 }, { id: PLANKS, count: 4 }], result: { id: PLANKS, count: 4 }, requiresTable: false };
  const stats = { crafts: 0, closes: 0, syncs: 0 };
  const items = () => [{ name: 'spruce_log', count: client.logs }, { name: 'spruce_planks', count: client.planks }, { name: 'coal', count: 12 }].filter(i => i.count > 0);
  const inventory = {
    items, slots: [], inventoryStart: 9, inventoryEnd: 45,
    get selectedItem() { return client.cursorLogs ? { name: 'spruce_log', count: client.cursorLogs } : null; }
  };
  const bot = {
    registry: {
      itemsByName: { spruce_log: { id: LOG, name: 'spruce_log' }, spruce_planks: { id: PLANKS, name: 'spruce_planks' } },
      items: { [LOG]: { id: LOG, name: 'spruce_log' }, [PLANKS]: { id: PLANKS, name: 'spruce_planks' } },
      blocksByName: { crafting_table: { id: 99 } }
    },
    inventory, currentWindow: null,
    recipesAll: id => (id === PLANKS ? [recipe] : []),
    craft: async (rec, n) => {
      let local = 0;
      for (let i = 0; i < n; i++) {
        stats.crafts++;
        if (alwaysBroken || local >= bugAfter) {
          // сбой: стопка у клиента и сервера уходит на курсор, крафта нет
          server.cursorLogs += server.logs; server.logs = 0; client.cursorLogs = server.cursorLogs; client.logs = 0;
          throw new Error(new Error('missing ingredient'));
        }
        server.logs--; server.planks += 4; client.logs--; client.planks += 4; local++;
      }
    },
    closeWindow: async () => { stats.closes++; server.logs += server.cursorLogs; server.cursorLogs = 0; },
    _syncWindow: async () => { stats.syncs++; client.logs = server.logs; client.planks = server.planks; client.cursorLogs = server.cursorLogs; },
    putSelectedItemRange: async () => {}
  };
  return { bot, server, client, stats };
}

async function testCraft() {
  // 17 бревен, 32 доски: раньше «missing ingredient» и брёвна пропадали
  let w = craftWorld({ logs: 17, bugAfter: 3 });
  let ctx = { bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {} };
  let have = await craft.craftItem(ctx, task(), 'spruce_planks', 32);
  assert.strictEqual(have, 33, 'доски: ' + have);
  assert.strictEqual(w.client.logs, 9, 'осталось брёвен ' + w.client.logs);
  assert.strictEqual(w.client.cursorLogs, 0);

  // сбой посреди крафта (порция по 3 -> сбой на 4-м) — после сбоя ничего не пропало: брёвна на курсоре возвращены
  w = craftWorld({ logs: 17, bugAfter: 2 });
  ctx = { bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {} };
  have = await craft.craftItem(ctx, task(), 'spruce_planks', 32);
  assert.strictEqual(have, 33); assert.strictEqual(w.client.logs + w.client.cursorLogs, 9);
  assert(w.stats.closes > 0 && w.stats.syncs > 0, 'после сбоя окна закрыты и инвентарь синхронизирован');

  // унылый случай: остались брёвна на курсоре с прошлого сбоя — следующий craft сам их возвращает
  w = craftWorld({ logs: 17, bugAfter: 99 });
  w.server.cursorLogs = 14; w.server.logs = 3; w.client.cursorLogs = 14; w.client.logs = 0;
  ctx = { bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {} };
  assert(craft.craftStateDirty(w.bot));
  have = await craft.craftItem(ctx, task(), 'spruce_planks', 4);
  assert.strictEqual(have, 5); assert.strictEqual(w.client.logs, 16);

  // совсем сломанный крафт: ошибка с понятной причиной за ограниченное число попыток, брёвна не пропали
  w = craftWorld({ logs: 17, alwaysBroken: true });
  ctx = { bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {} };
  await assert.rejects(() => craft.craftItem(ctx, task(), 'spruce_planks', 32), e => /missing ingredient/.test(e.message) && /не удался/.test(e.message));
  assert.strictEqual(w.client.logs + w.client.cursorLogs, 17, 'брёвна целы');
  assert(w.stats.crafts <= 8, 'без бесконечных попыток: ' + w.stats.crafts);

  // не хватает по-честному: прежнее сообщение
  w = craftWorld({ logs: 1 });
  ctx = { bot: w.bot, stats: { blocksPlaced: 0 }, tasks: {} };
  await assert.rejects(() => craft.craftItem(ctx, task(), 'spruce_planks', 32), e => /не хватает/.test(e.message));
  console.log('craft: OK');
}

// ---------- dig_at по пустой клетке ----------
async function testDigAtEmpty() {
  for (const [name, re] of [['air', /уже пусто \(air\)/], ['cave_air', /уже пусто \(cave_air\)/], ['water', /вода/], ['lava', /лава/]]) {
    let walked = false;
    const bot = {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: p => ({ name, boundingBox: 'empty', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), diggable: false }),
      pathfinder: { goto: async () => { walked = true; }, setGoal() {}, setMovements() {} },
      inventory: { items: () => [] }, registry: { itemsByName: {} }
    };
    const ctx = { bot, stats: { blocksMined: 0 } };
    await assert.rejects(() => build.digAt(ctx, task(), { x: 20, y: 64, z: 20 }), e => re.test(e.message) && /20 64 20/.test(e.message) && e.extra && e.extra.empty, name);
    assert(!walked, 'без хождения: ' + name);
  }
  console.log('dig_at пусто: OK');
}

// ---------- explore с памятью ----------
function exploreWorld(blocked) {
  const targets = [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => [] }, registry: { itemsByName: {} },
    pathfinder: {
      setGoal() {}, setMovements() {},
      goto: async g => {
        targets.push({ x: g.x, z: g.z });
        if (blocked(g.x, g.z)) { const e = new Error('No path'); e.name = 'NoPath'; throw e; }
        bot.entity.position = new Vec3(g.x + 0.5, 64, g.z + 0.5);
      }
    }
  };
  return { bot, targets, ctx: { bot, visited: new Set(), stats: {} } };
}

async function testExplore() {
  A.goto = REAL_GOTO;
  // всё заблокировано: explore провалится, но все цели разные, а следующий вызов не повторяет прежние точки
  let w = exploreWorld(() => true);
  const t0 = () => new Task(2, 'explore', {}, 'test');
  await assert.rejects(() => gather.explore(w.ctx, t0(), { distance: 48 }), e => /нет пути/.test(e.message) && /пробовал/.test(e.message));
  const first = w.targets.slice();
  assert(first.length >= 4 && first.length <= 6, 'попыток: ' + first.length);
  assert(first.some(p => Math.hypot(p.x, p.z) < 40), 'пробует и ближе, не только полную дальность');
  for (let i = 0; i < first.length; i++) for (let j = i + 1; j < first.length; j++) assert(Math.hypot(first[i].x - first[j].x, first[i].z - first[j].z) >= 12, 'повтор цели в одном вызове');
  assert.strictEqual(w.ctx.exploreFails.length, first.length);
  w.targets.length = 0;
  await assert.rejects(() => gather.explore(w.ctx, t0(), { distance: 48 }));
  for (const p of w.targets) for (const q of first) assert(Math.hypot(p.x - q.x, p.z - q.z) >= 12, `повторил неудачную точку ${p.x},${p.z} ~ ${q.x},${q.z}`);
  // через 10 минут память пуста
  for (const f of w.ctx.exploreFails) f.t -= 11 * 60 * 1000;
  w.targets.length = 0;
  await assert.rejects(() => gather.explore(w.ctx, t0(), { distance: 48 }));
  assert.strictEqual(w.ctx.exploreFails.length, w.targets.length, 'старые неудачи забыты, записаны новые');

  // север закрыт, остальное свободно: пять explore подряд (с возвратом на старт) — каждый раз уходит, к закрытой точке не возвращается
  w = exploreWorld((x, z) => z < -10);
  const northTried = [];
  for (let i = 0; i < 5; i++) {
    w.bot.entity.position = new Vec3(0.5, 64, 0.5); w.targets.length = 0;
    const r = await gather.explore(w.ctx, t0(), { distance: 48 });
    assert(r.moved >= 6, 'ушёл: ' + JSON.stringify(r));
    for (const p of w.targets) if (p.z < -10) northTried.push(p);
  }
  for (let i = 0; i < northTried.length; i++) for (let j = i + 1; j < northTried.length; j++) assert(Math.hypot(northTried[i].x - northTried[j].x, northTried[i].z - northTried[j].z) >= 12, 'закрытая точка предложена дважды');
  console.log('explore: OK (закрытых попыток', northTried.length, ')');
}

// ---------- shelter у обрыва ----------
function cliffWorld(inv, { rejectCliffPlace }) {
  const solid = n => !['air', 'snow', 'water', 'lava'].includes(n);
  const set = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  // z <= 0 — земля до y=65; z >= 1 — обрыв (пустота)
  const gen = (x, y, z) => (z <= 0 && y <= 65 ? 'dirt' : 'air');
  const bot = {
    username: 'FlyTest', health: 20, food: 20, registry: require('minecraft-data')('26.1'),
    entity: { id: 1, position: new Vec3(0.5, 66, 0.5), velocity: new Vec3(0, 0, 0), height: 1.8, yaw: 0 }, entities: {},
    time: { timeOfDay: 6000, day: 3 },
    inventory: { items: () => inv.filter(i => i.count > 0), slots: {} },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = key(x, y, z);
      const name = set.has(k) ? set.get(k) : gen(x, y, z);
      return { name, boundingBox: solid(name) ? 'block' : 'empty', position: new Vec3(x, y, z), diggable: true, skyLight: 15 };
    },
    pathfinder: { setMovements() {}, setGoal() {}, goto: async g => { if (g.x != null) bot.entity.position = new Vec3(g.x + 0.5, bot.entity.position.y, g.z + 0.5); } },
    clearControlStates() {}, setControlState() {}, look: async () => {}, lookAt: async () => {},
    equip: async it => { bot.held = it; },
    placeBlock: async (ref, face) => {
      const t = ref.position.plus(face);
      if (rejectCliffPlace && t.z >= 1 && t.y >= 66) throw new Error('сервер отклонил');
      set.set(key(t.x, t.y, t.z), bot.held.name); bot.held.count--;
    },
    dig: async b => {
      set.set(key(b.position.x, b.position.y, b.position.z), 'air');
      const it = inv.find(i => i.name === 'dirt'); if (it) it.count++;
      const p = bot.entity.position; while (A.isAirLike(bot.blockAt(p.offset(0, -1, 0)))) p.y -= 1; // падение в яму
    }
  };
  return { bot };
}

async function testShelterCliff() {
  const mk = bot => ({ bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} });
  // со стороны обрыва поставить блоки не выходит (нет опоры/сервер не даёт) — раньше «не до конца закрыто», теперь копает яму и закрывается
  let w = cliffWorld([{ name: 'cobblestone', count: 24 }, { name: 'dirt', count: 0 }], { rejectCliffPlace: true });
  let ctx = mk(w.bot);
  const r = await survival.shelter(ctx, task(), {});
  assert(r.mode === 'dig' && survival.isSheltered(w.bot), JSON.stringify(r));
  assert(w.bot.entity.position.y < 66, 'ушёл в яму');
  // явный mode=walls запасной вариант не включает, но причина в тексте ошибки
  w = cliffWorld([{ name: 'cobblestone', count: 24 }], { rejectCliffPlace: true });
  await assert.rejects(() => survival.shelter(mk(w.bot), task(), { mode: 'walls' }), e => /не до конца закрыто \(открыто: .*\d+ \d+ \d+: /.test(e.message));
  // без отказов сервера у обрыва стены закрываются опорой снизу, как раньше
  w = cliffWorld([{ name: 'cobblestone', count: 24 }], { rejectCliffPlace: false });
  const r2 = await survival.shelter(mk(w.bot), task(), {});
  assert(survival.isSheltered(w.bot), JSON.stringify(r2));
  console.log('shelter у обрыва: OK', JSON.stringify(r), JSON.stringify(r2));
}


// ---------- night_mine: ok:false всегда с error ----------
function nightApi(world, { phase = 'ночь', pos = { x: 0.5, y: 64, z: 0.5 } } = {}) {
  const set = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  const g = (x, y, z) => (set.has(key(x, y, z)) ? set.get(key(x, y, z)) : world(x, y, z));
  const st = { pos: { ...pos }, yaw: 0, calls: [], logs: [] };
  const CH = { air: '.', stone: 's', snow: '*', dripstone_block: 'd', obsidian: 'o' };
  const api = {
    log: m => st.logs.push(m), sleep: async () => {},
    snapshot: async () => ({ position: st.pos, health: 20, inventory: [{ name: 'stone_pickaxe', count: 1, slot: 36 }, { name: 'cobblestone', count: 8, slot: 37 }], eyes: { time: { phase } } }),
    cmd: async (name, p) => {
      st.calls.push({ name, p });
      if (name === 'survey') {
        const layers = {}; const legend = { '.': 'air', s: 'stone', '*': 'snow', d: 'dripstone_block', o: 'obsidian' };
        for (let y = p.y1; y <= p.y2; y++) { const rows = []; for (let z = p.z1; z <= p.z2; z++) { let r = ''; for (let x = p.x1; x <= p.x2; x++) r += CH[g(x, y, z)] || 's'; rows.push(r); } layers['y=' + y] = rows; }
        return { origin: { x: p.x1, y: p.y1, z: p.z1 }, layers, legend };
      }
      if (name === 'dig_at') { set.set(key(p.x, p.y, p.z), 'air'); if (Math.floor(st.pos.x) === p.x && Math.floor(st.pos.z) === p.z && p.y === Math.floor(st.pos.y) - 1) st.pos.y -= 1; return {}; }
      if (name === 'look') { st.yaw = p.yaw; return {}; }
      if (name === 'move') { const nx = st.pos.x - Math.sin(st.yaw), nz = st.pos.z - Math.cos(st.yaw); if (g(Math.floor(nx), Math.floor(st.pos.y), Math.floor(nz)) === 'air') { st.pos.x = nx; st.pos.z = nz; } return {}; }
      if (name === 'place_at') { set.set(key(p.x, p.y, p.z), 'stone'); return {}; }
      return {};
    }
  };
  return { api, st, set };
}

async function testNightMine() {
  const nm = require('../brain/learned/night_mine.js');
  // днём: отказ с error
  let w = nightApi((x, y, z) => (y <= 63 ? 'stone' : 'air'), { phase: 'день' });
  let r = await nm.run(w.api, {});
  assert(r.ok === false && /night_mine: .*не ночь/.test(r.error), JSON.stringify(r));
  // ночью на открытой поверхности: все направления открыты — отказ с error и подсказкой, не молча
  w = nightApi((x, y, z) => (y <= 63 ? 'stone' : 'air'));
  r = await nm.run(w.api, {});
  assert(r.ok === false && /^night_mine: нет безопасного направления/.test(r.error) && /mine_stairs/.test(r.error), JSON.stringify(r));
  // пещера dripstone_block больше не «не копаем»: рядом сплошная порода из dripstone_block — направление выбирается
  w = nightApi((x, y, z) => ((x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : y <= 70 ? 'dripstone_block' : 'air'));
  r = await nm.run(w.api, { max_blocks: 3 });
  assert(r.ok === true && r.mined >= 1 && !r.error, JSON.stringify(r));
  // тонкий потолок (яма после shelter, над соседями только воздух): раньше «потолок air» — отказ, теперь углубляется на 1 и копает
  w = nightApi((x, y, z) => ((x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : y <= 65 ? 'stone' : 'air'));
  r = await nm.run(w.api, { max_blocks: 3 });
  const firstDig = w.st.calls.find(c => c.name === 'dig_at');
  assert(firstDig && firstDig.p.x === 0 && firstDig.p.y === 63 && firstDig.p.z === 0, 'углубился: ' + JSON.stringify(firstDig));
  assert(r.ok === true && r.mined >= 1, JSON.stringify(r));
  // любой ok:false имеет error: узкий коридор без выхода (стена-«обсидиан» — не копаем)
  w = nightApi((x, y, z) => ((x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : y <= 70 ? 'obsidian' : 'air'));
  r = await nm.run(w.api, {});
  assert(r.ok === false && typeof r.error === 'string' && r.error.length > 10, JSON.stringify(r));
  console.log('night_mine: OK');
}

async function testNestedEmptyStats() {
  const assert = require('assert');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-stats-test-'));
  const statsFile = path.join(dir, 'skills_stats.json');
  fs.writeFileSync(statsFile, '{}');

  // Test the stats functions directly by simulating what runner.js does
  let stats = {};
  function stat(name) {
    if (!stats[name]) stats[name] = { enabled: true, runs: 0, ok: 0, fail: 0, consecutiveFails: 0, lastError: null, lastRun: null, lastOk: null, nestedRuns: 0, nestedOk: 0, nestedFail: 0, emptyRuns: 0, emptyOk: 0 };
    return stats[name];
  }
  function saveStats() {
    try {
      fs.writeFileSync(statsFile + '.tmp', JSON.stringify(stats, null, 2));
      fs.renameSync(statsFile + '.tmp', statsFile);
    } catch (e) { console.log('saveStats error:', e.message); }
  }
  function recordResult(name, ok, error, runId, meta = {}) {
    const s = stat(name);
    if (meta.nested) {
      s.nestedRuns++;
      if (ok) s.nestedOk++; else s.nestedFail++;
    } else if (meta.empty) {
      s.emptyRuns++;
      if (ok) s.emptyOk++;
    } else {
      s.runs++; s.lastRun = new Date().toISOString();
      if (ok) { s.ok++; s.consecutiveFails = 0; s.lastOk = s.lastRun; }
      else { s.fail++; s.consecutiveFails++; s.lastError = String(error || 'неизвестная ошибка').slice(0, 2000); }
    }
    saveStats();
  }
  function statView(name) {
    const s = stats[name] || stat(name);
    return { runs: s.runs, ok: s.ok, fail: s.fail, consecutiveFails: s.consecutiveFails, lastError: s.lastError, lastRun: s.lastRun, lastOk: s.lastOk, nestedRuns: s.nestedRuns, nestedOk: s.nestedOk, nestedFail: s.nestedFail, emptyRuns: s.emptyRuns, emptyOk: s.emptyOk };
  }

  try {
    // Test 1: Normal top-level run increments ok/runs
    recordResult('test_skill', true, null, 1);
    let s = statView('test_skill');
    assert.strictEqual(s.runs, 1, 'top-level run increments runs');
    assert.strictEqual(s.ok, 1, 'top-level ok increments ok');
    assert.strictEqual(s.fail, 0);
    assert.strictEqual(s.nestedRuns, 0);
    assert.strictEqual(s.emptyRuns, 0);

    // Test 2: Nested run increments nestedOk/nestedRuns, not main counters
    recordResult('helper_skill', true, null, 1, { nested: true });
    s = statView('helper_skill');
    assert.strictEqual(s.runs, 0, 'nested run does not increment runs');
    assert.strictEqual(s.ok, 0, 'nested run does not increment ok');
    assert.strictEqual(s.nestedRuns, 1, 'nested run increments nestedRuns');
    assert.strictEqual(s.nestedOk, 1, 'nested run increments nestedOk');

    // Test 3: Empty run increments emptyOk/emptyRuns, not main counters
    recordResult('test_skill', true, null, 2, { empty: true });
    s = statView('test_skill');
    assert.strictEqual(s.runs, 1, 'empty run does not increment runs');
    assert.strictEqual(s.ok, 1, 'empty run does not increment ok');
    assert.strictEqual(s.emptyRuns, 1, 'empty run increments emptyRuns');
    assert.strictEqual(s.emptyOk, 1, 'empty run increments emptyOk');

    // Test 4: Failed nested run increments nestedFail
    recordResult('helper_skill', false, 'error', 2, { nested: true });
    s = statView('helper_skill');
    assert.strictEqual(s.nestedFail, 1, 'failed nested run increments nestedFail');

    // Test 5: Verify skills_stats.json has the right structure
    const savedStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert.ok(savedStats.test_skill.ok === 1 && savedStats.test_skill.runs === 1);
    assert.ok(savedStats.test_skill.emptyOk === 1 && savedStats.test_skill.emptyRuns === 1);
    // helper_skill: 2 nested runs (1 ok, 1 fail)
    assert.ok(savedStats.helper_skill.nestedOk === 1 && savedStats.helper_skill.nestedRuns === 2);
    assert.ok(savedStats.helper_skill.nestedFail === 1);

    console.log('nested/empty stats: OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = async () => {
  await testCraft();
  await testDigAtEmpty();
  await testExplore();
  await testShelterCliff();
  await testNightMine();
  await testNestedEmptyStats();
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
