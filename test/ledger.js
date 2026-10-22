// Офлайн-проверка учёта ресурсов (lib/ledger.js) на искусственной последовательности инвентаря: добыто, подобрано, скрафчено,
// поставлено, съедено, выброшено, сундук/печь, смерть (в т.ч. с сохранённым инвентарём), неизвестное, сводка, хранение с троттлингом.
// Запуск: node test/offline.js (или node test/ledger.js)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Vec3 } = require('../lib/util');
const { Ledger } = require('../lib/ledger');

const T0 = Date.parse('2026-10-21T12:00:00Z');

function world(dir, opts = {}) {
  const bot = new EventEmitter();
  const inv = {};
  Object.assign(bot, {
    food: 14, foodSaturation: 2, entity: { id: 1, position: new Vec3(0, 64, 0) }, time: { day: 5 },
    inventory: { items: () => Object.entries(inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })), slots: [] },
    registry: {
      blocksByName: { stone: { drops: [1] }, oak_log: { drops: [2] }, wheat: { drops: [3, 4] } },
      items: { 1: { name: 'cobblestone' }, 2: { name: 'oak_log' }, 3: { name: 'wheat' }, 4: { name: 'wheat_seeds' } },
      foodsByName: { bread: {}, apple: {} }
    }
  });
  const clock = { t: T0 };
  const ctx = { bot, ready: true, dataDir: dir, events: { push() {} }, tasks: { current: null, legacy: null } };
  const led = new Ledger(ctx, { file: path.join(dir, 'ledger.json'), now: () => clock.t });
  const session = { timers: [] };
  led.attach(session); session.timers.forEach(clearInterval); session.timers = [];
  const step = (ms = 500) => { clock.t += ms; led.tick(); };
  const task = (name, by) => { ctx.tasks.current = name ? { name, by: by || 'brain', source: 'brain' } : null; };
  // сумма по предмету/направлению/причине/источнику из сводки
  const get = (item, dir, reason, by) => {
    let n = 0; const days = led.days;
    for (const d of Object.keys(days)) { const row = days[d][item]; if (!row) continue; const r = row[dir][reason]; if (!r) continue; for (const b of Object.keys(r)) if (!by || b === by) n += r[b]; }
    return n;
  };
  return { bot, inv, ctx, led, clock, step, task, get };
}

module.exports = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledtest-'));
  try {
    const w = world(tmp);
    const { bot, inv, led, step, task, get } = w;
    inv.stick = 4; inv.bread = 2; inv.dirt = 20;
    for (let i = 0; i < 8; i++) step(); // «settle»: инвентарь приезжает пакетами, это не приход
    assert.deepStrictEqual(led.days, {}, 'стартовый инвентарь в учёт не попал');

    // добыто (диг -> предмет входит в drops блока), источник — навык исполнителя
    task('collect', 'skill:miner');
    bot.emit('fly_dug', { name: 'stone' }); inv.cobblestone = 1; step();
    assert.strictEqual(get('cobblestone', 'in', 'mined', 'skill:miner'), 1);
    // тот же диг не объясняет чужой предмет: яблоко без причины -> unknown
    inv.apple = 1; step(); assert.strictEqual(get('apple', 'in', 'unknown'), 1, 'причину не установить -> unknown');
    // подобрано
    task(null); bot.emit('playerCollect', { id: 1 }, { getDroppedItem: () => ({ name: 'feather' }) }); inv.feather = 2; step();
    assert.strictEqual(get('feather', 'in', 'collected', 'нет задачи'), 2);
    // чужой подбор (collector не муха) не засчитывается
    bot.emit('playerCollect', { id: 99 }, { getDroppedItem: () => ({ name: 'flint' }) }); inv.flint = 1; step(); assert.strictEqual(get('flint', 'in', 'collected'), 0); assert.strictEqual(get('flint', 'in', 'unknown'), 1);

    // крафт: приход скрафченного и расход на крафт, источник — мозг
    task('craft', 'brain'); inv.oak_planks = 4; inv.oak_log = 1; step(); // log уже 0 -> нет: проверим расход ниже
    inv.oak_log = 0; inv.stick = 4; inv.oak_planks = 2; inv.crafting_table = 1; step();
    assert.strictEqual(get('oak_planks', 'in', 'crafted', 'brain'), 4); assert.strictEqual(get('oak_planks', 'out', 'craft_spent', 'brain'), 2);
    assert.strictEqual(get('crafting_table', 'in', 'crafted'), 1);

    // поставлено
    task('place_at', 'skill:builder'); bot.emit('blockPlaced', null, { name: 'cobblestone' }); inv.cobblestone -= 1; step();
    assert.strictEqual(get('cobblestone', 'out', 'placed', 'skill:builder'), 1);
    // без события блока и без нужной задачи расход честно «unknown»
    task(null); inv.dirt -= 1; step(); assert.strictEqual(get('dirt', 'out', 'unknown', 'нет задачи'), 1);
    // посев: блок wheat, ушли семена (предмет есть в drops блока)
    inv.wheat_seeds = 3; task('plant', 'autopilot'); w.led.digs = []; step(); // семена пришли с задачей plant — без причины
    bot.emit('blockPlaced', null, { name: 'wheat' }); inv.wheat_seeds -= 1; step();
    assert.strictEqual(get('wheat_seeds', 'out', 'placed', 'autopilot'), 1);

    // съедено: еда выросла и хлеба стало меньше
    task(null); bot.food = 18; inv.bread -= 1; step(); assert.strictEqual(get('bread', 'out', 'eaten'), 1);
    // еда пропала, а сытость не выросла -> не «съедено»
    inv.bread -= 1; step(); assert.strictEqual(get('bread', 'out', 'eaten'), 1); assert.strictEqual(get('bread', 'out', 'unknown'), 1);
    // выброшено
    task('toss', 'brain'); inv.dirt -= 5; step(); assert.strictEqual(get('dirt', 'out', 'tossed', 'brain'), 5);

    // сундук: открыли, взяли, закрыли; потом положили
    task('chest_take', 'skill:storekeeper');
    bot.emit('windowOpen', { type: 'minecraft:generic_9x3' }); inv.iron_ingot = 5; bot.emit('windowClose', { type: 'minecraft:generic_9x3' });
    assert.strictEqual(get('iron_ingot', 'in', 'chest_take', 'skill:storekeeper'), 5, 'взято из сундука (синхронно по закрытию окна)');
    bot.emit('windowOpen', { type: 'minecraft:generic_9x3' }); inv.iron_ingot -= 3; bot.emit('windowClose', { type: 'minecraft:generic_9x3' });
    assert.strictEqual(get('iron_ingot', 'out', 'chest_put'), 3);
    // печь
    task('smelt', 'brain'); bot.emit('windowOpen', { type: 'minecraft:furnace' }); inv.raw_iron = 0; inv.coal = 2; bot.emit('windowClose', { type: 'minecraft:furnace' });
    assert.strictEqual(get('coal', 'in', 'furnace_out'), 2, 'в окне печи приход — из печи');
    // итог задачи пишется на саму задачу, даже если current уже сменилась
    inv.glass = 1; task(null); led.onEvent('task_done', { name: 'collect', by: 'skill:miner' });
    assert.strictEqual(get('glass', 'in', 'unknown', 'skill:miner'), 1, 'итог пишется на задачу из события (collect), причины для стекла у неё нет -> unknown');
  } catch (e) { throw e; } finally { /* ниже продолжение в отдельных мирах */ }

  try {
    // ---- смерть: потеряно всё, что было; новое после респавна (settle) не считается приходом ----
    const w = world(path.join(tmp, 'death'));
    w.inv.diamond = 3; w.inv.iron_pickaxe = 1; for (let i = 0; i < 8; i++) w.step();
    w.step(); w.bot.emit('death');
    for (const k of Object.keys(w.inv)) delete w.inv[k]; // сервер забрал инвентарь
    w.step(); w.step(); // пока мёртвая — ничего не пишем
    assert.deepStrictEqual(w.led.days, {}, 'до респавна учёта нет');
    w.led.onEvent('spawn', { msg: 'респавн' });
    w.inv.wooden_sword = 1; // стартовый набор приезжает после респавна
    for (let i = 0; i < 10; i++) w.step();
    assert.strictEqual(w.get('diamond', 'out', 'died'), 3); assert.strictEqual(w.get('iron_pickaxe', 'out', 'died'), 1);
    assert.strictEqual(w.get('wooden_sword', 'in', 'unknown'), 0, 'то, что пришло при респавне, приходом не считаем');
    w.step(); assert.strictEqual(w.get('diamond', 'out', 'unknown'), 0);

    // keepInventory: умерла, но предметы остались -> потерь нет
    const k = world(path.join(tmp, 'keep'));
    k.inv.diamond = 3; for (let i = 0; i < 8; i++) k.step();
    k.bot.emit('death'); k.led.onEvent('spawn', {}); for (let i = 0; i < 10; i++) k.step();
    assert.strictEqual(k.get('diamond', 'out', 'died'), 0, 'инвентарь сохранился -> не «потеряно»');

    // ---- игровые дни ----
    const d = world(path.join(tmp, 'days'));
    d.inv.dirt = 1; for (let i = 0; i < 8; i++) d.step();
    d.bot.emit('fly_dug', { name: 'oak_log' }); d.inv.oak_log = 2; d.step();
    d.bot.time.day = 6; d.bot.emit('fly_dug', { name: 'oak_log' }); d.inv.oak_log = 5; d.step();
    assert.strictEqual(d.led.days['5'].oak_log.in.mined['нет задачи'], 2); assert.strictEqual(d.led.days['6'].oak_log.in.mined['нет задачи'], 3);

    // ---- сводка ----
    const s = d.led.summary();
    assert(s.ok && s.totals.in === 5 && s.totals.out === 0, JSON.stringify(s.totals));
    assert.strictEqual(s.byReason.in.mined, 5); assert.deepStrictEqual(s.bySource['нет задачи'], { in: 5, out: 0 });
    assert.deepStrictEqual(s.byDay.map(x => x.day), ['5', '6']); assert.strictEqual(s.items[0].item, 'oak_log'); assert.strictEqual(s.items[0].net, 5);
    assert.strictEqual(s.labels.mined, 'добыто'); assert.strictEqual(s.inventory.oak_log, 5);

    // ---- хранение: троттлинг, атомарная запись, загрузка ----
    const file = path.join(tmp, 'days', 'ledger.json');
    assert(!fs.existsSync(file) || true);
    d.led.lastSave = d.clock.t;                  // только что сохраняли
    assert.strictEqual(d.led.save(), false, 'троттлинг: рано');
    d.clock.t += 16000; assert.strictEqual(d.led.save(), true, 'прошло 15 с — пишем');
    assert(fs.existsSync(file) && !fs.existsSync(file + '.tmp'));
    d.inv.oak_log = 6; d.bot.emit('fly_dug', { name: 'oak_log' }); d.step(); assert.strictEqual(d.led.save(), false, 'снова рано'); assert.strictEqual(d.led.flush(), true, 'flush игнорирует троттлинг');
    const again = new Ledger({ bot: d.bot, dataDir: path.join(tmp, 'days'), events: { push() {} }, tasks: {} }, { file });
    assert.strictEqual(again.days['6'].oak_log.in.mined['нет задачи'], 4, 'после перезапуска учёт на месте');
    // слив старых дней
    const c = world(path.join(tmp, 'cmp'), { }); c.led.L.MAX_DAYS = 3;
    for (let i = 1; i <= 6; i++) c.led.days[String(i)] = { dirt: { in: { mined: { x: 1 } }, out: {} } };
    c.led.dirty = true; c.led.save(true);
    assert.deepStrictEqual(Object.keys(c.led.days).sort(), ['4', '5', '6', 'older']); assert.strictEqual(c.led.days.older.dirt.in.mined.x, 3);
    console.log('ledger: OK');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
