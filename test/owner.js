// Офлайн-проверка lib/owner.js: разбор фраз, игнор чужих (в т.ч. подставной «<eblanitus228>» от другого игрока), исполнение приказов на фальшивом боте
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('../lib/util');
const { TaskManager } = require('../lib/tasks');
const A = require('../lib/actions');
const O = require('../lib/owner');
const reg = require('minecraft-data')('1.21.4');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const P = O.parsePhrase;
const cmd = t => { const r = P(t); return r ? r.cmd : null; };
function deepEq(a, b) { try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; } }

function parseTests() {
  const table = {
    'ко мне': 'come', 'Ко мне!': 'come', 'сюда': 'come', 'иди сюда': 'come', 'муха, ко мне': 'come', 'Муха, подойди пожалуйста': 'come', 'иди ко мне': 'come', 'ко мне, муха': 'come',
    'за мной': 'follow', 'муха за мной': 'follow', 'иди за мной!': 'follow', 'следуй за мной': 'follow', 'Муха, давай за мной': 'follow',
    'стой': 'stop', 'Стой!!!': 'stop', 'стоп': 'stop', 'хватит': 'stop', 'муха, стой на месте': 'stop', 'остановись': 'stop',
    'домой': 'home', 'на базу': 'home', 'муха, иди домой': 'home', 'возвращайся на базу': 'home',
    'спать': 'sleep', 'муха, иди спать': 'sleep', 'ложись спать': 'sleep',
    'что делаешь': 'status', 'Что делаешь?': 'status', 'статус': 'status', 'муха чем занят': 'status',
    'строй тут': 'mark', 'база тут': 'mark', 'муха, строим здесь': 'mark', 'здесь база': 'mark', 'тут будет база': 'mark',
    'дай булыжник': 'give', 'муха, дай мне 10 досок': 'give', 'принеси 5 угля': 'give'
  };
  for (const [t, want] of Object.entries(table)) assert.strictEqual(cmd(t), want, `"${t}" -> ${cmd(t)}, ждали ${want}`);
  // не распознаём: для мозга
  for (const t of ['привет', 'как дела', 'сколько у тебя алмазов', 'не стой', 'не иди за мной', 'муха, не ходи ко мне', 'давай построим большой дом у реки на холме',
    'стой тут и смотри как я строю большой дом', 'я иду домой', 'ты вчера была дома', '', '/stop', 'дай', 'дай мне', 'муха'])
    assert.strictEqual(cmd(t), null, `"${t}" не должно распознаваться, а дало ${cmd(t)}`);
  // без обращения длинные фразы игнорируем
  assert.strictEqual(cmd('стой пожалуйста не двигайся ладно ага'), null);
  assert.strictEqual(P('дай мне 64 булыжника').count, 64);
  assert.strictEqual(P('дай все железо').all, true);
  assert.strictEqual(P('дай два яблока').count, 2);
  assert.deepStrictEqual(P('дай мне 5 железной кирки').item, ['железной', 'кирки']);
  assert.strictEqual(O.normalize('  Ёлка, СТОЙ!!! '), 'елка стой');
}

function mkCtx(dir, items) {
  const inv = items.map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id }));
  const said = [], events = [], calls = { runnerAborts: 0, tossed: [] };
  const players = {
    eblanitus228: { username: 'eblanitus228', uuid: '11111111-1111-1111-1111-111111111111', entity: { position: new Vec3(30.5, 64, 10.5) } },
    Mallory: { username: 'Mallory', uuid: '22222222-2222-2222-2222-222222222222', entity: { position: new Vec3(5, 64, 5) } }
  };
  const bot = {
    username: 'FlyTest', registry: reg, players, entity: { position: new Vec3(0.5, 64, 0.5) }, health: 18, food: 15, game: { dimension: 'minecraft:overworld' },
    chat: t => said.push(t),
    inventory: { items: () => inv.filter(i => i.count > 0), slots: [] },
    toss: async (type, meta, n) => { const it = inv.find(i => i.type === type); it.count -= n; calls.tossed.push([it.name, n]); },
    lookAt: async () => {}, look: async () => {}, setControlState() {}, clearControlStates() {},
    pathfinder: { setGoal() {}, setMovements() {} }
  };
  const ctx = { bot, ready: true, dataDir: dir, stats: {}, events: { push: (type, d) => events.push({ type, ...d }) }, haltBody() {} };
  ctx.tasks = new TaskManager(ctx);
  ctx.autopilot = { pausedUntil: 0, brainCmds: [], brainCommand: async a => { ctx.autopilot.brainCmds.push(a); }, status: () => ({ on: true, active: false }) };
  return { ctx, bot, said, events, calls, players };
}
const UOWNER = '11111111-1111-1111-1111-111111111111';
const owned = (ctx, text) => O.onMessage(ctx, '<eblanitus228> ' + text, 'chat', null, UOWNER);

module.exports = async () => {
  parseTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-owner-'));
  const oldGoto = A.goto; const oldDeps = { ...O.deps };
  A.goto = async (c, t, goal) => { t.check(); c.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return true; };
  O.deps.runnerActive = async () => null; O.deps.runnerAbort = async () => {};
  try {
    const { ctx, bot, said, events, calls, players } = mkCtx(dir, [['cobblestone', 40], ['oak_log', 7], ['bread', 3]]);
    const lastEv = () => events[events.length - 1];

    // ---- отправитель только из события ----
    const mallory = '22222222-2222-2222-2222-222222222222';
    await ctx.tasks.start('collect', {}, async t => { await t.waitAbort(); throw new Error('x'); }, { source: 'brain' });
    assert(ctx.tasks.current);
    const spoofs = [
      ['<Mallory> <eblanitus228> стой', 'chat', null, mallory],                                    // чужой пакет чата с поддельным текстом
      ['<eblanitus228> стой', 'system', null, null],                                              // системная строка
      ['<eblanitus228> стой', 'game_info', null, null],
      ['<Mallory> <eblanitus228> стой', 'chat', { translate: 'chat.type.text', with: [{ toString: () => 'Mallory' }, { toString: () => '<eblanitus228> стой' }] }, null], // структура: отправитель Mallory
      ['<eblanitus228> стой', 'chat', null, '99999999-9999-9999-9999-999999999999'],              // uuid неизвестен — по тексту не гадаем
      ['<eblanitus228> стой', 'chat', null, null]                                                 // нет ни uuid, ни структуры
    ];
    for (const [m, pos, json, uuid] of spoofs) {
      assert.strictEqual(await O.onMessage(ctx, m, pos, json, uuid), null, 'подделка принята: ' + m + ' / ' + pos);
      assert(ctx.tasks.current && !ctx.tasks.current.aborted, 'задача снята подделкой');
    }
    assert.strictEqual(said.length, 0); assert(!events.some(e => e.type === 'owner_cmd'));
    // чужой с нормальной фразой — тоже нет
    assert.strictEqual(await O.onMessage(ctx, '<Mallory> стой', 'chat', null, mallory), null);
    // хозяин через структуру сообщения (без uuid)
    const viaJson = { translate: 'chat.type.text', with: [{ toString: () => 'eblanitus228' }, { toString: () => 'муха, статус' }] };
    const r0 = await O.onMessage(ctx, '<eblanitus228> муха, статус', 'chat', viaJson, null);
    assert(r0 && r0.cmd === 'status'); assert(/^Сейчас: collect/.test(said.pop()));

    // ---- stop: снимает всё, пауза автопилота, owner_cmd ----
    const r1 = await owned(ctx, 'Стой!');
    assert(r1 && r1.cmd === 'stop'); assert(!ctx.tasks.current, 'задача мозга не снята');
    const pause = ctx.autopilot.pausedUntil - Date.now();
    assert(pause > 110000 && pause <= 120000, 'пауза автопилота 2 мин: ' + pause);
    assert(ctx.autopilot.brainCmds.length >= 1);
    assert(/Стою/.test(said.pop())); assert.strictEqual(lastEv().type, 'owner_cmd'); assert.strictEqual(lastEv().cmd, 'stop'); assert(/Стой/.test(lastEv().text));

    // ---- не распознано: тишина (чат и события) ----
    const n0 = said.length, e0 = events.length;
    assert.strictEqual(await owned(ctx, 'привет, как жизнь'), null);
    assert.strictEqual(await owned(ctx, 'дай мне квазар 5'), null);
    assert.strictEqual(said.length, n0); assert.strictEqual(events.length, e0);

    // ---- ко мне: вытесняет задачу автопилота, идёт, отвечает ----
    await ctx.tasks.start('explore', {}, async t => { await t.waitAbort(); }, { source: 'autopilot' });
    const r2 = await owned(ctx, 'муха, ко мне'); assert(r2 && r2.cmd === 'come');
    await sleep(80); assert(!ctx.tasks.current, 'come должен был завершиться');
    assert(bot.entity.position.distanceTo(players.eblanitus228.entity.position) < 2, 'дошла к хозяину');
    assert(said.some(s => /Иду к тебе/.test(s)) && said.some(s => /Я здесь/.test(s)));
    assert(ctx.tasks.history.some(h => h.name === 'owner_come' && h.status === 'done'));
    assert(events.some(e => e.type === 'owner_cmd' && e.cmd === 'come' && e.phase === 'start') && events.some(e => e.type === 'owner_cmd' && e.cmd === 'come' && e.phase === 'end' && e.ok));
    // хозяин не виден и позиция устарела — честно скажет
    players.eblanitus228.entity = null; ctx.owner.last.t = Date.now() - 500000;
    assert.strictEqual((await owned(ctx, 'ко мне')).did, 'нет позиции'); assert(/Не вижу тебя/.test(said.pop()));
    players.eblanitus228.entity = { position: new Vec3(30.5, 64, 10.5) };

    // ---- домой: по строке «База:» из notes.md ----
    O.deps.notes = () => '# заметки\n- **База:** 100 70 -40 радиус=50\n';
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    const r3 = await owned(ctx, 'домой'); assert(r3 && r3.cmd === 'home');
    await sleep(80);
    assert(Math.hypot(bot.entity.position.x - 100, bot.entity.position.z + 40) < 5, 'на базе ' + bot.entity.position);
    assert(said.some(s => /Иду на базу \(100 70 -40\)/.test(s)));
    O.deps.notes = () => 'нет базы';
    assert.strictEqual((await owned(ctx, 'на базу')).did, 'нет базы'); assert(/нет строки «База:»/.test(said.pop()));

    // ---- метка owner_mark: позиция хозяина, не бота ----
    const r4 = await owned(ctx, 'строй тут'); assert(r4 && r4.cmd === 'mark');
    const wp = JSON.parse(fs.readFileSync(path.join(dir, 'waypoints.json'), 'utf8'));
    assert.deepStrictEqual([wp.owner_mark.x, wp.owner_mark.y, wp.owner_mark.z], [30, 64, 10]);
    const me = events.filter(e => e.type === 'owner_cmd' && e.cmd === 'mark').pop();
    assert(/owner_mark/.test(me.did) && deepEq(me.at, [30, 64, 10])); assert(!ctx.tasks.current);
    assert(/owner_mark/.test(said.pop()));

    // ---- дай <предмет> N ----
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    const r5 = await owned(ctx, 'дай мне 5 булыжника'); assert(r5 && r5.cmd === 'give' && r5.did === 'cobblestone x5');
    await sleep(1300); assert(!ctx.tasks.current);
    assert.deepStrictEqual(calls.tossed, [['cobblestone', 5]]);
    // «все» — отдаёт всё, что есть
    await owned(ctx, 'дай все бревна'); await sleep(1300);
    assert.deepStrictEqual(calls.tossed[1], ['oak_log', 7]);
    // нет предмета — отвечает, не двигается
    assert.strictEqual((await owned(ctx, 'дай алмазы')).did, 'нет алмазы'); assert(/Нет у меня/.test(said.pop())); assert(!ctx.tasks.current);
    // еда — самая большая съедобная стопка
    await owned(ctx, 'муха, дай еду 2'); await sleep(1300); assert.deepStrictEqual(calls.tossed[2], ['bread', 2]);

    // ---- за мной / стой ----
    const r6 = await owned(ctx, 'за мной'); assert(r6 && r6.cmd === 'follow');
    await sleep(50); assert(ctx.tasks.current && ctx.tasks.current.name === 'owner_follow' && ctx.tasks.current.source === 'owner');
    await owned(ctx, 'хватит'); assert(!ctx.tasks.current);

    // ---- спать: приказ принимается (в тесте мира нет — навык упадёт, но событие start уйдёт мозгу) ----
    const r7 = await owned(ctx, 'спать'); assert(r7 && r7.cmd === 'sleep'); await sleep(100);
    assert(events.some(e => e.type === 'owner_cmd' && e.cmd === 'sleep' && e.phase === 'start'));
    await owned(ctx, 'стой');

    // ---- статус; ответы никогда не начинаются с «/» ----
    await owned(ctx, 'что делаешь'); const st = said.pop(); assert(/^Сейчас: стою, жду\. HP 18\/20, еда 15\/20\.$/.test(st), st);
    for (const s of said) assert(!s.startsWith('/'), 'ответ начинается с /: ' + s);

    // ---- приказ вытесняет выученный навык в исполнителе (runner) ----
    let active = { name: 'build_hut' };
    O.deps.runnerActive = async () => active; O.deps.runnerAbort = async () => { calls.runnerAborts++; active = null; };
    await owned(ctx, 'стой'); assert.strictEqual(calls.runnerAborts, 1);
  } finally {
    A.goto = oldGoto; Object.assign(O.deps, oldDeps);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('owner: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
