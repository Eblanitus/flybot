// Связь с игровым сервером (lib/link.js) на фальшивом createBot в живом порядке событий:
// в мире → сервер упал ('end' socketClosed) → попытки: 'error' ECONNREFUSED, затем 'end' socketClosed (как в flybot.out.log
// 22.10) → паузы растут до потолка и попытки не кончаются → сервер вернулся → вход, событие reconnected будит мозг.
// Плюс: вход завис (сервер молчит), 'error' без 'end', createBot бросил исключение. connected в снимке — честный.
// Запуск: node test/link.js (входит в node test/offline.js)
'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { Link } = require('../lib/link');
const { EventHub } = require('../lib/events');
const perception = require('../lib/perception');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(3); }
  throw new Error('не дождались: ' + what);
}

module.exports = async function () {
  const server = { mode: 'up' }; // up | down | stall | errnoend | throw
  const bots = [];
  const createBot = () => {
    const mode = server.mode;
    if (mode === 'throw') throw new Error('bad version');
    const bot = new EventEmitter();
    bot.at = Date.now(); bot.mode = mode; bot.endCalls = 0;
    bot.loadPlugin = () => {};
    bot.end = reason => { bot.endCalls++; if (bot.closed) return; bot.closed = true; setTimeout(() => bot.emit('end', reason || 'clientQuit'), 1); };
    bots.push(bot);
    setTimeout(() => {
      if (bot.closed) return;
      if (mode === 'up') { bot.entity = { position: { x: 0, y: 64, z: 0 } }; bot.emit('spawn'); }
      else if (mode === 'down') { // как в живом логе: сперва error, потом end
        const e = new Error('connect ECONNREFUSED 127.0.0.1:25565'); e.code = 'ECONNREFUSED';
        bot.emit('error', e); bot.closed = true; bot.emit('end', 'socketClosed');
      } else if (mode === 'errnoend') { const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET'; bot.emit('error', e); }
      // stall: сервер принял соединение и молчит
    }, 3);
    return bot;
  };
  const ctx = { events: new EventHub(500), ready: false, lastError: null, bot: null };
  const attached = [], ended = [];
  const logs = [];
  const link = new Link(ctx, {
    host: 'localhost', port: 25565, user: 'FlyBot_01', createBot,
    timing: { BACKOFF_MIN_MS: 20, BACKOFF_MAX_MS: 160, LOGIN_TIMEOUT_MS: 150, ERROR_END_MS: 40 },
    attach: s => attached.push(s), spawn: (s, first) => { s.firstSpawn = first; }, ended: s => ended.push(s),
    log: s => logs.push(s)
  });
  const waits = [];
  const sched = link._schedule.bind(link);
  link._schedule = () => { const w = sched(); waits.push(w); return w; };
  const evs = type => ctx.events.buf.filter(e => e.type === type);

  try {
    // 1) сервер есть — вошли; респавн в той же сессии — не «переподключение»
    link.start();
    await until(() => ctx.ready, 1000, 'вход');
    assert.strictEqual(link.info().state, 'online'); assert.strictEqual(link.online, true);
    assert.strictEqual(evs('spawn')[0].msg, 'вошёл в мир'); assert.strictEqual(evs('reconnected').length, 0);
    bots[0].emit('spawn');
    assert.strictEqual(evs('spawn')[1].msg, 'респавн'); assert.strictEqual(evs('reconnected').length, 0);
    assert.strictEqual(attached[0].firstSpawn, false, 'второй spawn сессии — не первый');

    // 2) сервер упал: сессия кончилась socketClosed — событие disconnect (будит мозг), connected=false
    server.mode = 'down';
    const cur = bots[0]; cur.closed = true; cur.emit('end', 'socketClosed');
    assert.strictEqual(ctx.ready, false); assert.strictEqual(ended.length, 1);
    const disc = evs('disconnect')[0];
    assert(disc && disc.reason === 'socketClosed' && /переподключаюсь сам/.test(disc.msg), 'disconnect: ' + JSON.stringify(disc));
    let snap = perception.snapshot(ctx);
    assert.strictEqual(snap.ready, false); assert.strictEqual(snap.connected, false, 'connected честный (раньше было true)');
    assert.strictEqual(snap.link.state, 'offline');

    // мозг ждёт в /wait: неудачные попытки его не будят, вход после разрыва — будит
    const since = ctx.events.seq;
    let woke = null; const waiting = ctx.events.wait(since, 5000).then(r => { woke = r; });

    // 3) попытки бесконечные, пауза растёт и упирается в потолок
    await until(() => evs('info').length >= 8, 3000, '8 неудачных попыток');
    assert.deepStrictEqual(waits.slice(0, 7), [20, 40, 80, 160, 160, 160, 160], 'паузы: ' + waits);
    assert.strictEqual(link.state === 'offline' || link.state === 'connecting', true);
    assert(link.timer || link.session, 'следующая попытка запланирована/идёт');
    const info = evs('info');
    assert.strictEqual(info[0].attempt, 1); assert.strictEqual(info[7].attempt, 8);
    assert(/попытка 3 не удалась \(ECONNREFUSED\); следующая через/.test(info[2].msg), info[2].msg);
    assert.strictEqual(ctx.lastError, 'ECONNREFUSED');
    // реальные паузы между попытками следуют за расписанием
    const downBots = bots.filter(b => b.mode === 'down');
    for (let i = 4; i < 7; i++) { const gap = downBots[i].at - downBots[i - 1].at; assert(gap >= 150 && gap < 400, 'пауза у потолка: ' + gap); }
    assert.strictEqual(woke, null, 'попытки (info) мозг не будят');
    snap = perception.snapshot(ctx);
    assert.strictEqual(snap.connected, false); assert(snap.link.attempts >= 8, JSON.stringify(snap.link));
    assert(/нет связи с игровым сервером localhost:25565 \(ECONNREFUSED\)|подключаюсь к игровому серверу/.test(snap.link.text), snap.link.text);
    // команда тела, пока связи нет: честная причина и состояние связи
    const { makeDispatcher } = require('../lib/commands');
    const r = await makeDispatcher(ctx)({ action: 'collect', params: { block: 'log' } });
    assert(!r.ok && /^not ready: ECONNREFUSED/.test(r.error) && r.link && r.link.online === false, JSON.stringify(r));

    // 4) сервер вернулся — вошли сами, мозг разбужен событием reconnected
    server.mode = 'up';
    await until(() => ctx.ready, 1000, 'вход после разрыва');
    await waiting;
    assert(woke && !woke.timedOut, 'мозг разбужен');
    const rec = woke.events.find(e => e.type === 'reconnected');
    assert(rec && rec.attempts >= 9 && rec.offlineSec >= 0 && rec.lastReason === 'socketClosed' && /связь с сервером восстановлена/.test(rec.msg), JSON.stringify(rec));
    assert(!woke.events.some(e => e.type === 'info'), 'попытки в /wait не сыплются');
    assert.strictEqual(link.info().state, 'online'); assert.strictEqual(link.attempts, 0);
    assert.strictEqual(ctx.lastError, null);

    // 5) после входа пауза снова с начала; вход завис (сервер молчит) — сторож рвёт и пробует снова
    server.mode = 'stall';
    waits.length = 0;
    const live = bots[bots.length - 1]; live.closed = true; live.emit('end', 'socketClosed');
    assert.strictEqual(waits[0], 20, 'пауза сброшена после входа');
    await until(() => evs('info').some(e => e.reason === 'loginTimeout'), 1000, 'сторож входа');
    const stalled = bots.filter(b => b.mode === 'stall')[0];
    assert(stalled.endCalls >= 1, 'зависшее соединение закрыто');
    assert(/не впустил в мир/.test(evs('info').find(e => e.reason === 'loginTimeout').msg));

    // 6) 'error' без 'end' — закрываем сами и пробуем дальше; createBot бросил — тоже пробуем дальше
    server.mode = 'errnoend';
    await until(() => evs('info').some(e => /^error: ECONNRESET/.test(e.reason)), 1500, 'error без end');
    server.mode = 'throw';
    await until(() => evs('info').some(e => /^createBot: bad version/.test(e.reason)), 1500, 'createBot бросил');
    server.mode = 'up';
    await until(() => ctx.ready, 1500, 'снова в мире');
    assert.strictEqual(evs('reconnected').length, 2);
    assert.strictEqual(link.info().online, true); assert.strictEqual(link.info().text, undefined, 'в мире лишнего текста нет');

    // 7) одна сессия — один конец: повторные end/error после разрыва не плодят попыток
    const n = bots.length; const b = bots[n - 1];
    b.closed = true; b.emit('end', 'socketClosed'); b.emit('end', 'socketClosed'); b.emit('error', new Error('late'));
    assert.strictEqual(evs('disconnect').length, 3);
    await until(() => bots.length === n + 1, 1000, 'одна новая попытка');
    await sleep(40);
    assert.strictEqual(bots.length, n + 1, 'ровно одна новая попытка');
    await until(() => ctx.ready, 1000, 'вход');
  } finally {
    link.stop();
  }
  assert.strictEqual(link.timer, null);
  console.log('link (переподключение без конца, честное connected, reconnected будит мозг, сторож входа): OK');
};
if (require.main === module) module.exports().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
