// Офлайн-проверка lib/daylog.js: накопление за игровой день, итог при смене суток, days.log, чат до 200 символов, событие day_report, поле day в snapshot
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const D = require('../lib/daylog');

function mk(dir, extra) {
  const bot = new EventEmitter();
  bot.time = { day: 5, timeOfDay: 100 };
  bot.chat = t => chat.push(t);
  bot.inventory = { items: () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 30 }] };
  bot.dig = async block => ({ dug: block.name });
  const chat = [], events = [];
  const skillsFile = path.join(dir, 'skills_stats.json');
  fs.writeFileSync(skillsFile, JSON.stringify({ build_hut: { ok: 2, fail: 1 }, mine_vein: { ok: 5, fail: 0 } }));
  const ctx = Object.assign({
    bot, ready: true, dataDir: dir, daylogSkillsFile: skillsFile, stats: { distanceTraveled: 1000 },
    events: { push: (type, d) => events.push({ type, ...d }) }, tasks: { current: null, legacyBusy: 0 }
  }, extra || {});
  const session = { bot, timers: [], ended: false };
  return { ctx, bot, chat, events, session, skillsFile };
}
let px = 0; // каждая установка — в новую клетку
const place = (bot, name, ctx) => { const position = { x: px++, y: 64, z: 0 }; if (ctx) ctx.buildingAt = D.key(position); bot.emit('blockPlaced', { name: 'air' }, { name, position }); if (ctx) ctx.buildingAt = null; };

module.exports = async () => {
  // чистые функции
  assert.strictEqual(D.plural(1, 'блок', 'блока', 'блоков'), 'блок'); assert.strictEqual(D.plural(3, 'блок', 'блока', 'блоков'), 'блока');
  assert.strictEqual(D.plural(12, 'блок', 'блока', 'блоков'), 'блоков'); assert.strictEqual(D.plural(21, 'блок', 'блока', 'блоков'), 'блок');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-daylog-'));
  try {
    const { ctx, bot, chat, events, session, skillsFile } = mk(dir);
    const dl = D.attach(ctx, session);
    bot.emit('time');                                   // первый пакет времени: день 5 начался
    assert.strictEqual(dl.state.day, 5);

    // стройка: блок в клетке, которую ставит place_at/place/platform (ctx.buildingAt) — «построено»; укрытие/подпорки/факелы — «служебные»
    ctx.tasks.current = { name: 'place_at' };
    for (let i = 0; i < 6; i++) place(bot, 'cobblestone', ctx);
    for (let i = 0; i < 2; i++) place(bot, 'oak_planks', ctx);
    place(bot, 'torch', ctx);                           // факел — всегда служебный
    place(bot, 'dirt');                                 // подпорка, которую pathfinder поставил по дороге к place_at — служебный
    ctx.tasks.current = { name: 'shelter' };
    for (let i = 0; i < 4; i++) place(bot, 'dirt');
    ctx.tasks.current = null; place(bot, 'stone', ctx);   // старая команда place/platform
    ctx.tasks.legacyBusy = 1; place(bot, 'gravel'); ctx.tasks.legacyBusy = 0; // во время простой команды goto — не стройка
    place(bot, 'gravel');                               // подпорка пути вне задачи — служебный
    // добыча через bot.dig (обёртка), трава игнорируется
    for (let i = 0; i < 7; i++) await bot.dig({ name: 'stone' });
    for (let i = 0; i < 3; i++) await bot.dig({ name: 'coal_ore' });
    await bot.dig({ name: 'dirt' }); await bot.dig({ name: 'short_grass' });
    // смерть: что выпало
    bot.emit('death');
    ctx.stats.distanceTraveled = 1812;

    let t = dl.today();
    assert.strictEqual(t.day, 5); assert.strictEqual(t.built, 9); assert.strictEqual(t.aux, 8); assert.strictEqual(t.deaths, 1);
    assert.strictEqual(t.dist, 812); assert(/cobblestone 6/.test(t.builtItems)); assert(/stone 7/.test(t.mined));

    // навыки: за день один build_hut ok, один mine_vein fail
    fs.writeFileSync(skillsFile, JSON.stringify({ build_hut: { ok: 3, fail: 1 }, mine_vein: { ok: 5, fail: 1 }, new_skill: { ok: 1, fail: 0 } }));

    // смена суток -> итог
    bot.time.day = 6; bot.time.timeOfDay = 5;
    bot.emit('time');
    assert.strictEqual(chat.length, 1, 'одна строка в чат');
    const line = chat[0];
    assert(line.length <= 200, 'длина ' + line.length);
    assert(/^День 5: построено 9 блоков \(cobblestone 6, oak_planks 2, stone 1\)/.test(line), line);
    assert(/добыто stone 7, coal_ore 3, dirt 1/.test(line), line);
    assert(/смертей 1 \(выпало 31 предм\.\)/.test(line), line);
    assert(/прошла 812 бл/.test(line) && /навыки ok 2\/провал 1/.test(line), line);
    assert(!line.startsWith('/'));
    const ev = events.find(e => e.type === 'day_report');
    assert(ev && ev.day === 5 && ev.built === 9 && ev.aux === 8 && ev.deaths === 1 && ev.skills.ok === 2 && ev.skills.fail === 1 && !ev.warn);
    const rows = fs.readFileSync(path.join(dir, 'days.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].day, 5); assert.strictEqual(rows[0].line, line); assert.deepStrictEqual(rows[0].skills.by.build_hut, [1, 0]);
    // новый день пуст, вчера в snapshot
    t = dl.today(); assert.strictEqual(t.day, 6); assert.strictEqual(t.built, 0); assert.strictEqual(t.deaths, 0);
    const snap = D.decorate(ctx, { ready: true });
    assert.strictEqual(snap.day.today.day, 6); assert.strictEqual(snap.day.yesterday.day, 5); assert.strictEqual(snap.day.yesterday.built, 9); assert.strictEqual(snap.day.yesterday.line, line);

    // день без стройки: честно «0 блоков»
    bot.time.day = 7; bot.emit('time');
    const l0 = chat[1];
    assert(/^День 6: построено 0 блоков, добыто ничего, смертей 0/.test(l0), l0);
    const ev0 = events.filter(e => e.type === 'day_report')[1]; assert.strictEqual(ev0.built, 0); assert(/0 блоков/.test(ev0.warn));
    assert.strictEqual(D.decorate(ctx, {}).day.yesterday.built, 0);

    // длинный итог укладывается в 200 символов
    place(bot, 'x'); // служебный
    const big = {}; for (let i = 0; i < 12; i++) big['some_long_block_name_number_' + i] = 1000 + i;
    const longLine = D.formatLine({ day: 12345, built: 99999, builtItems: big, aux: 77777, auxItems: {}, mined: big, minedTotal: 12000, deaths: 123, lost: {}, lostTotal: 4567, dist: 987654, skills: { ok: 12, fail: 34 }, partial: true });
    assert(longLine.length <= 200, longLine.length + ' ' + longLine); assert(/^День 12345 \(неполный\): построено 99999 блоков/.test(longLine)); assert(/смертей 123/.test(longLine));

    // состояние переживает рестарт тела; день сменился за время простоя -> итог прошлого дня при первом пакете времени
    ctx.tasks.current = { name: 'place_at' }; place(bot, 'cobblestone', ctx); place(bot, 'cobblestone', ctx); dl.dirty = true; dl.save();
    const m2 = mk(dir); m2.ctx.stats.distanceTraveled = 1000;
    const dl2 = D.create(m2.ctx); m2.ctx.daylog = dl2;
    assert.strictEqual(dl2.state.day, 7); assert.strictEqual(dl2.state.built, 2); assert.strictEqual(dl2.state.restarts, 1); assert.strictEqual(dl2.last.day, 6);
    m2.bot.time.day = 8; dl2.onTime(m2.bot);
    assert(/^День 7: построено 2 блока \(cobblestone 2\)/.test(m2.chat[0]), m2.chat[0]);

    // обёртка dig: считает успех, не считает провал, повторный attach не оборачивает дважды
    const m3 = mk(fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-daylog3-')));
    const d3 = D.attach(m3.ctx, m3.session); D.attach(m3.ctx, m3.session);
    await m3.bot.dig({ name: 'stone' }); assert.strictEqual(d3.state.mined.stone, 1);
    // bot.dig появляется позже attach (плагины mineflayer грузятся после createBot): обёртка встаёт на spawn; смерть её не снимает
    const m4 = mk(fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-daylog4-')));
    const realDig = m4.bot.dig; delete m4.bot.dig;
    const d4 = D.attach(m4.ctx, m4.session);
    m4.bot.dig = realDig; m4.bot.emit('spawn'); await new Promise(r => setImmediate(r));
    await m4.bot.dig({ name: 'stone' }); assert.strictEqual(d4.state.mined.stone, 1, 'добыча считается, хотя bot.dig появился позже');
    m4.bot.emit('death'); m4.bot.removeAllListeners('diggingCompleted'); m4.bot.emit('spawn');
    await m4.bot.dig({ name: 'stone' }); assert.strictEqual(d4.state.mined.stone, 2, 'после смерти добыча считается');
    await m4.bot.dig({ name: 'stone' }).catch(() => {}); assert.strictEqual(d4.state.mined.stone, 3, 'обёртка одна');
    for (const ss of [session, m2.session, m3.session, m4.session]) for (const tm of ss.timers) clearInterval(tm);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('daylog: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
