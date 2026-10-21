// Офлайн-проверка чёрного ящика (lib/blackbox.js) и источника действий (lib/origin.js): кольцо на 60 с, запись при смерти и
// почти-смерти, троттлинг/склейка серий, очистка старых файлов, защита от ../ в чтении. Запуск: node test/offline.js (или node test/blackbox.js)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Vec3, sleep } = require('../lib/util');
const { BlackBox, FILE_RE } = require('../lib/blackbox');
const origin = require('../lib/origin');

const T0 = Date.parse('2026-10-21T12:00:00Z');

function world(dir, limits) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    health: 20, food: 18, foodSaturation: 5, oxygenLevel: 20, username: 'муха',
    entity: { id: 1, position: new Vec3(10.5, 64, -20.5), onGround: true, velocity: new Vec3(0, 0, 0) },
    entities: {}, players: {}, heldItem: { name: 'stone_sword', count: 1 }, time: { day: 5, timeOfDay: 6000 }, game: { minY: -64, difficulty: 'normal' },
    registry: { effectsByName: {} },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
    inventory: { items: () => [{ name: 'cobblestone', count: 40 }, { name: 'bread', count: 3 }, { name: 'stone_pickaxe', count: 1 }], slots: [] }
  });
  const events = [];
  const clock = { t: T0 };
  const ctx = {
    bot, ready: true, dataDir: dir, hurtLog: [], lastDamage: null,
    events: { push: (type, data) => { events.push({ type, ...data }); } },
    tasks: { current: { id: 7, name: 'collect', source: 'brain', by: 'skill:miner', status: 'running', started: T0 - 5000, progressText: 'копаю' }, legacy: null }
  };
  const bb = new BlackBox(ctx, { dir: path.join(dir, 'blackbox'), now: () => clock.t, limits });
  const session = { timers: [] };
  bb.attach(session); session.timers.forEach(clearInterval); session.timers = []; // кадры в тесте делаем руками
  const step = (ms = 1000) => { clock.t += ms; return bb.tick(); };
  return { bot, ctx, bb, events, clock, step };
}

const files = bb => bb.files();

module.exports = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbtest-'));
  try {
    // ---- источник действий ----
    assert.deepStrictEqual(origin.resolve({ internal: false, autopilotOwnsRunner: false, src: 'skill:miner' }), { source: 'brain', by: 'brain' }, 'curl мозга src не подделает');
    assert.deepStrictEqual(origin.resolve({ internal: true, autopilotOwnsRunner: false, src: 'skill:miner' }), { source: 'brain', by: 'skill:miner' });
    assert.deepStrictEqual(origin.resolve({ internal: true, autopilotOwnsRunner: true, src: 'skill:miner' }), { source: 'autopilot', by: 'autopilot' });
    assert.deepStrictEqual(origin.resolve({ internal: true, autopilotOwnsRunner: false, src: 'skill:../../x' }), { source: 'brain', by: 'brain' }, 'плохое имя навыка отбрасывается');

    // ---- кольцо ~60 с и состав кадра ----
    const w = world(path.join(tmp, 'a'));
    w.bot.entities[5] = { id: 5, type: 'hostile', name: 'zombie', position: new Vec3(13.5, 64, -20.5) };
    for (let i = 0; i < 100; i++) w.step();
    w.ctx.lastDamage = { cause: 'zombie', t: w.clock.t - 1500 }; w.ctx.hurtLog = [{ t: Date.now(), amount: 2 }]; w.step();
    assert(w.bb.frames.length >= 59 && w.bb.frames.length <= 62, 'кольцо ~60 кадров: ' + w.bb.frames.length);
    assert(w.bb.frames[0].t >= w.clock.t - 60000, 'старше 60 с выброшено');
    const fr = w.bb.frames[w.bb.frames.length - 1];
    assert.deepStrictEqual(fr.pos, [10.5, 64, -20.5]); assert.strictEqual(fr.hp, 20); assert.strictEqual(fr.food, 18);
    assert.strictEqual(fr.task.name, 'collect'); assert.strictEqual(fr.task.by, 'skill:miner', 'кто отдал задачу');
    assert(fr.air && fr.air.under === false && 'sec' in fr.air, 'воздух');
    assert(fr.ttd && 'air' in fr.ttd && fr.worst !== undefined, 'ttd по угрозам и worst');
    assert.strictEqual(fr.env.below, 'stone'); assert.strictEqual(fr.fire, false); assert.strictEqual(fr.lava, false); assert.strictEqual(fr.water, false);
    assert(fr.mobs.some(m => m.name === 'zombie' && m.kind === 'враг'), 'мобы рядом');
    assert.strictEqual(fr.hurt.cause, 'zombie'); assert.strictEqual(fr.held, 'stone_sword');
    if (process.env.SHOW_FRAME) console.log(JSON.stringify(fr));
    // кадр по событию: урон и начало/конец задачи
    const n0 = w.bb.frames.length;
    w.clock.t += 300; w.bot.health = 20; w.bot.emit('health'); w.bot.health = 17; w.bot.emit('health');
    assert(w.bb.frames[w.bb.frames.length - 1].why === 'урон', 'кадр на уроне');
    w.clock.t += 300; w.bb.onEvent('task_done', { name: 'collect' });
    assert.strictEqual(w.bb.frames[w.bb.frames.length - 1].why, 'task_done');
    w.bot.health = 20;

    // ---- смерть: заморозка, файл, потерянный инвентарь, событие ----
    w.bot.health = 0; w.bot.emit('death');
    assert(w.bb.frozen, 'ящик заморожен');
    const frozenN = w.bb.frames.length; w.step(); w.step(); assert.strictEqual(w.bb.frames.length, frozenN, 'после смерти новые кадры не пишутся');
    assert.strictEqual(files(w.bb).length, 0, 'до события death файла ещё нет (ждём причину)');
    w.bb.onEvent('death', { cause: 'drowned', message: 'муха drowned', at: [10, 64, -21], phase: 'день', deaths: 3 });
    const fl = files(w.bb); assert.strictEqual(fl.length, 1); assert(/^death-\d{8}-\d{6}\.json$/.test(fl[0]), fl[0]);
    const death = JSON.parse(fs.readFileSync(path.join(w.bb.dir, fl[0]), 'utf8'));
    assert.strictEqual(death.kind, 'death'); assert.strictEqual(death.summary.cause, 'drowned'); assert.strictEqual(death.summary.message, 'муха drowned');
    assert.strictEqual(death.summary.lastTask.by, 'skill:miner'); assert.deepStrictEqual(death.summary.pos, [10, 64, -21]); assert.strictEqual(death.summary.deaths, 3);
    assert.deepStrictEqual(death.lost.items, { cobblestone: 40, bread: 3, stone_pickaxe: 1 }); assert.strictEqual(death.lost.total, 44);
    assert(death.frames.length >= 60 && death.frames[death.frames.length - 1].why === 'смерть', 'кадры: ' + death.frames.length);
    const ev = w.events.find(e => e.type === 'blackbox_saved'); assert(ev && ev.kind === 'death' && ev.file === 'data/blackbox/' + fl[0], JSON.stringify(ev));
    // повторное событие death файл не дублирует; spawn размораживает ящик
    w.bb.onEvent('death', { cause: 'x' }); assert.strictEqual(files(w.bb).length, 1);
    w.bot.health = 20; w.bb.onEvent('spawn', { msg: 'респавн' }); assert(!w.bb.frozen && w.bb.frames.length === 0, 'после респавна буфер пустой');
    w.step(); assert.strictEqual(w.bb.frames.length, 1);

    // ---- смерть без события death: запасной таймер ----
    const w2 = world(path.join(tmp, 'b'), { DEATH_WAIT_MS: 30 });
    w2.ctx.lastDamage = { cause: 'creeper', t: w2.clock.t - 500 };
    w2.step(); w2.step(); w2.bot.health = 0; w2.bot.emit('death');
    await sleep(120);
    const f2 = files(w2.bb); assert.strictEqual(f2.length, 1, 'файл по таймеру');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w2.bb.dir, f2[0]), 'utf8')).summary.cause, 'creeper', 'причина из последнего урона');

    // ---- почти-смерть: HP <= 4 и выжила >= 10 с; серия склеивается; чаще раза в 60 с не пишем ----
    const w3 = world(path.join(tmp, 'c'));
    for (let i = 0; i < 5; i++) w3.step();
    w3.bot.health = 3;
    for (let i = 0; i < 4; i++) w3.step();
    assert.strictEqual(files(w3.bb).length, 0, 'пока опасно — файл не пишем');
    w3.bot.health = 18;
    for (let i = 0; i < 9; i++) w3.step();
    assert.strictEqual(files(w3.bb).length, 0, 'нет 10 с после последнего «почти»');
    for (let i = 0; i < 3; i++) w3.step();
    let f3 = files(w3.bb); assert.strictEqual(f3.length, 1, 'почти-смерть записана');
    assert(/^near-/.test(f3[0]));
    const near1 = JSON.parse(fs.readFileSync(path.join(w3.bb.dir, f3[0]), 'utf8'));
    assert.strictEqual(near1.kind, 'near'); assert.strictEqual(near1.summary.minHp, 3); assert.strictEqual(near1.summary.series, 1); assert(near1.frames.length >= 8);
    assert(w3.events.some(e => e.type === 'blackbox_saved' && e.kind === 'near'));
    // вторая серия через ~20 с: склеивается в тот же файл
    for (let i = 0; i < 8; i++) w3.step();
    w3.bot.health = 2; for (let i = 0; i < 3; i++) w3.step(); w3.bot.health = 18; for (let i = 0; i < 12; i++) w3.step();
    f3 = files(w3.bb); assert.strictEqual(f3.length, 1, 'серия склеена, а не новый файл: ' + f3);
    const near2 = JSON.parse(fs.readFileSync(path.join(w3.bb.dir, f3[0]), 'utf8'));
    assert.strictEqual(near2.summary.series, 2); assert.strictEqual(near2.summary.minHp, 2); assert(near2.frames.length > near1.frames.length);
    assert(new Set(near2.frames.map(f => f.t)).size === near2.frames.length, 'кадры без дублей');
    // третья — спустя > 60 с: новый файл
    for (let i = 0; i < 70; i++) w3.step();
    w3.bot.health = 4; for (let i = 0; i < 2; i++) w3.step(); w3.bot.health = 18; for (let i = 0; i < 12; i++) w3.step();
    assert.strictEqual(files(w3.bb).length, 2, 'после паузы — новый файл');

    // почти-смерть по «времени до смерти»: HP 10, но за 5 с получено 20 урона (worst.ttdSec = 2.5)
    const w4 = world(path.join(tmp, 'd'));
    w4.bot.health = 10; w4.ctx.hurtLog = [{ t: Date.now(), amount: 20 }];
    w4.step(); w4.step(); w4.ctx.hurtLog = []; for (let i = 0; i < 12; i++) w4.step();
    const f4 = files(w4.bb); assert.strictEqual(f4.length, 1, 'почти-смерть по ttd');
    assert(JSON.parse(fs.readFileSync(path.join(w4.bb.dir, f4[0]), 'utf8')).summary.why.some(s => /до смерти/.test(s)));

    // смерть во время «почти»: файла почти-смерти нет, есть только файл смерти
    const w5 = world(path.join(tmp, 'e'));
    w5.step(); w5.bot.health = 2; w5.step(); w5.step(); w5.bot.health = 0; w5.bot.emit('death'); w5.bb.onEvent('death', { cause: 'zombie' });
    for (let i = 0; i < 15; i++) w5.step();
    assert.deepStrictEqual(files(w5.bb).map(n => n.split('-')[0]), ['death'], 'выжила не выжила — решает смерть');

    // ---- очистка: не больше MAX_FILES, чужие файлы не трогаем ----
    const w6 = world(path.join(tmp, 'f'), { MAX_FILES: 5 });
    fs.mkdirSync(w6.bb.dir, { recursive: true });
    fs.writeFileSync(path.join(w6.bb.dir, 'notes.txt'), 'моё'); fs.writeFileSync(path.join(w6.bb.dir, 'keep.json'), '{}');
    for (let i = 1; i <= 8; i++) w6.bb.write(`death-20260101-00000${i}.json`, { kind: 'death', summary: { cause: 'x' }, frames: [] });
    const f6 = files(w6.bb); assert.strictEqual(f6.length, 5);
    assert.deepStrictEqual(f6, [4, 5, 6, 7, 8].map(i => `death-20260101-00000${i}.json`), 'старые удалены: ' + f6);
    assert(fs.existsSync(path.join(w6.bb.dir, 'notes.txt')) && fs.existsSync(path.join(w6.bb.dir, 'keep.json')), 'чужие файлы целы');

    // ---- список и чтение файла (защита от ../) ----
    const L = w.bb.list(); assert(L.ok && L.total === 1 && L.items.length === 1);
    const it = L.items[0]; assert.strictEqual(it.kind, 'death'); assert.strictEqual(it.cause, 'drowned'); assert.strictEqual(it.by, 'skill:miner'); assert(it.frames >= 60);
    assert.strictEqual(w.bb.readFile(fl[0]).ok, true);
    for (const bad of ['../a/blackbox/' + fl[0], '..\\x.json', '/etc/passwd', 'notes.txt', 'death-../x.json', fl[0] + '/', '', null, 'near-' + '..%2f.json'])
      assert.strictEqual(w.bb.readFile(bad).ok, false, 'должно быть отказано: ' + bad);
    assert.strictEqual(w.bb.readFile('death-19990101-000000.json').status, 404);
    assert(FILE_RE.test('near-20260101-000000-2.json') && !FILE_RE.test('death-x/y.json'));
    console.log('blackbox: OK');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
