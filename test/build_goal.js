// Офлайн-проверка v0.2 «Постройка:»: parseBuild и дело «постройка» в автопилоте (decide, итог build_blueprint, статус)
'use strict';
const assert = require('assert');
const AP = require('../behavior/autopilot');
const { decide, buildState, buildAfter, buildStatus, lackOf, newBuildSt } = AP;
const { parseBuild, parseGoal } = require('../lib/basegoal');
const T = require('../behavior/thresholds');

module.exports = async () => {
  // ---- parseBuild ----
  const n1 = '# x\n## Текущая цель\nШаг: хижина\nПостройка: hut_west -390 67 40 rot=90\nАвтопилот: collect block=stone count=60\nБаза: -393 67 36\n## Проект\nПостройка: other 1 2 3\n';
  assert.deepStrictEqual(parseBuild(n1), { name: 'hut_west', x: -390, y: 67, z: 40, rot: 90, sig: 'hut_west -390 67 40 90' });
  assert.strictEqual(parseGoal(n1).name, 'collect', 'parseGoal по-прежнему понимает «Автопилот:»');
  assert.deepStrictEqual(parseBuild('## Текущая цель\n- **Постройка:** `fence_post_lamp x=-380 y=66 z=30`\n'),
    { name: 'fence_post_lamp', x: -380, y: 66, z: 30, rot: 0, sig: 'fence_post_lamp -380 66 30 0' });
  assert.strictEqual(parseBuild('## Текущая цель\nПостройка: hut_west.txt 1 2 3 rot=180\n').rot, 180);
  assert.strictEqual(parseBuild('## Текущая цель\nПостройка: hut_west y=5 x=1 z=-2\n').sig, 'hut_west 1 5 -2 0', 'ключи в любом порядке');
  assert.strictEqual(parseBuild('## Другое\nПостройка: hut_west 1 2 3\n'), null, 'только в «Текущей цели»');
  assert.strictEqual(parseBuild('## Текущая цель\nПостройка: (нет — мозг выберет)\n'), null, 'без чертежа — нет');
  assert.strictEqual(parseBuild('## Текущая цель\nПостройка: hut_west 1 2\n'), null, 'без трёх чисел — нет');
  assert.strictEqual(parseBuild('## Текущая цель\nПостройка: hut_west 1 2 3 rot=45\n'), null, 'rot только 0/90/180/270');
  assert.strictEqual(parseBuild(''), null);
  console.log('parseBuild: OK');

  // ---- decide: постройка ----
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  const bl = { name: 'hut_west', x: -390, y: 67, z: 40, rot: 90, sig: 'hut_west -390 67 40 90', need: null };
  let a = decide({ ...base, build: bl, buildDist: 5 });
  assert(a && a.key === 'build' && a.kind === 'body' && a.name === 'build_blueprint', 'есть постройка -> строю: ' + JSON.stringify(a));
  assert.deepStrictEqual(a.params, { name: 'hut_west', x: -390, y: 67, z: 40, rot: 90 });
  a = decide({ ...base, build: bl, buildDist: 120 });
  assert(a.key === 'build_go' && a.name === 'goto' && a.params.x === -390 && a.params.z === 40, 'далеко -> иду к месту');
  a = decide({ ...base, build: { ...bl, need: { spruce_planks: 12, cobblestone: 5 } }, buildDist: 5 });
  assert(a.key === 'build_gather' && a.kind === 'learned' && a.name === 'gather_list' && a.params.items === 'spruce_planks:12,cobblestone:5', 'не хватило -> gather_list ровно этого');
  const goal = { name: 'climb_up', params: { x: -352, z: 12 }, kind: 'learned', sig: 'g' };
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, goal }).key, 'build', '«Постройка:» главнее «Автопилот:»');
  assert.strictEqual(decide({ ...base, build: null, goal }).key, 'goal', 'без постройки — старая цель как раньше');
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, crashed: { gather_list: {} }, goal }).key, 'build', 'добор не нужен — сбой gather_list не мешает');
  // угрозы и мало HP — раньше постройки
  assert.notStrictEqual((decide({ ...base, build: bl, buildDist: 5, hp: 5, hostilesNear: 2 }) || {}).key, 'build', 'мало HP раньше');
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, enemies: [{ name: 'Griefer', d: 5, why: 'бил' }] }).key, 'escape_player', 'враг-игрок раньше');
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, inLava: true }).key, 'unstuck', 'лава раньше');
  const nightThreat = decide({ ...base, build: bl, buildDist: 5, isNight: true, phase: 'ночь', nightIn: 0, hostilesNear: 1, hostile: { name: 'zombie', d: 4 },
    base: { x: -393, y: 67, z: 36, r: 96 }, baseDist: 5, idleBuildMin: 40 });
  assert(nightThreat && nightThreat.key === 'night_fight', 'моб ночью раньше постройки');
  // ночью — только у базы; давление простоя
  const nb = { x: -393, y: 67, z: 36, r: 96 };
  assert.notStrictEqual((decide({ ...base, build: bl, buildDist: 5, isNight: true, phase: 'ночь', nightIn: 0 }) || {}).key, 'build', 'ночью без базы не строю');
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, isNight: true, phase: 'ночь', nightIn: 0, base: nb, baseDist: 5, idleBuildMin: 30 }).key, 'build', 'ночью у базы при простое — строю');
  assert.notStrictEqual((decide({ ...base, build: { ...bl, x: 500, z: 500 }, buildDist: 5, isNight: true, phase: 'ночь', nightIn: 0, base: nb, baseDist: 5, idleBuildMin: 30 }) || {}).key, 'build', 'ночью постройка вне базы — нет');
  a = decide({ ...base, running: { key: 'wait_night', name: 'wait_night', kind: 'body' }, task: { name: 'wait_night', source: 'autopilot' }, build: bl, buildDist: 5,
    isNight: true, phase: 'ночь', nightIn: 0, base: nb, baseDist: 5, idleBuildMin: T.idleBreakWaitMin + 1 });
  assert(a && a.key === 'build' && a.preempt, 'простой — прерываю ожидание ночи ради постройки');
  assert.strictEqual(decide({ ...base, build: bl, buildDist: 5, idle: false }), null, 'мозг/хозяин командовал — ждём');
  console.log('decide постройка: OK');

  // ---- итог build_blueprint: добор, пауза, готово ----
  assert.deepStrictEqual(lackOf('не хватает: spruce_planks ×12, cobblestone ×5', null), { spruce_planks: 12, cobblestone: 5 });
  assert.deepStrictEqual(lackOf('не достроено: 3 из 40 клеток; например (1 2 3) glass: нет в инвентаре: glass; не хватило: glass ×3', null), { glass: 3 });
  assert.deepStrictEqual(lackOf('не достроено: 1 из 40', { missing: { torch: 2 } }), { torch: 2 }, 'поле missing главнее текста');
  assert.deepStrictEqual(lackOf('не достроено: 2 из 40 клеток; например (1 2 3) stone: бот стоит на месте установки', { missing: {} }), {});

  const now = 1e9;
  const ap = { build: { name: 'hut_west', x: -390, y: 67, z: 40, rot: 90, sig: 'S' }, buildSt: newBuildSt('S'), running: null };
  assert.strictEqual(buildState(ap, now).build.name, 'hut_west');
  assert.strictEqual(buildStatus(ap, now).status, 'строю (сейчас другое дело)');
  // не хватило -> добор этого списка
  let r = buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не хватает: spruce_planks ×12', { missing: { spruce_planks: 12 } }, now, false);
  assert(r && !r.done && /добираю/.test(r.note), JSON.stringify(r));
  assert.deepStrictEqual(buildState(ap, now).build.need, { spruce_planks: 12 });
  a = decide({ ...base, ...buildState(ap, now), buildDist: 3 });
  assert(a.key === 'build_gather' && a.params.items === 'spruce_planks:12', 'после нехватки decide даёт gather_list');
  assert(/добираю spruce_planks ×12/.test(buildStatus(ap, now).status));
  // добор сделан -> снова строю
  r = buildAfter(ap, { key: 'build_gather', sig: 'S' }, 'ok', null, null, now, false);
  assert(/строю снова/.test(r.note) && buildState(ap, now).build.need === null);
  assert.strictEqual(decide({ ...base, ...buildState(ap, now), buildDist: 3 }).key, 'build');
  // другой провал -> пауза и повтор (не бросает)
  r = buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не достроено: 2 из 40 клеток; например (1 2 3) stone: бот стоит на месте установки', { missing: {} }, now, true);
  assert(/повтор через/.test(r.note), r.note);
  assert.strictEqual(buildState(ap, now + 1000).build, null, 'на паузе — дела нет');
  assert(/^пауза до \d\d:\d\d:\d\d \(провал/.test(buildStatus(ap, now + 1000).status), buildStatus(ap, now + 1000).status);
  assert.strictEqual(buildState(ap, now + T.buildRetryMs + 1).build.name, 'hut_west', 'после паузы — снова строю');
  // добор без прогресса buildGatherMax раз -> пауза, а не бесконечный круг
  ap.buildSt = newBuildSt('S');
  for (let i = 0; i < T.buildGatherMax; i++) {
    buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не хватает: glass ×4', null, now, false);
    buildAfter(ap, { key: 'build_gather', sig: 'S' }, 'ok', null, null, now, false);
  }
  r = buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не хватает: glass ×4', null, now, false);
  assert(/добор не помогает/.test(r.note) && buildState(ap, now + 1).build === null, r.note);
  // старый запуск после смены строки — не считается
  assert.strictEqual(buildAfter(ap, { key: 'build', sig: 'OLD' }, 'ok', null, null, now, true), null);
  // готово -> done один раз, дальше не строит
  ap.buildSt = newBuildSt('S');
  r = buildAfter(ap, { key: 'build', sig: 'S' }, 'ok', null, { ok: true }, now, true);
  assert(r && r.done === true, 'готово -> done');
  assert.strictEqual(buildState(ap, now + 1e9).build, null, 'готовую больше не строит');
  assert.strictEqual(buildStatus(ap, now).status, 'готово');
  assert.strictEqual(decide({ ...base, ...buildState(ap, now), goal }).key, 'goal', 'постройка готова — дальше прежний выбор');
  console.log('итог постройки: OK');

  // ---- живой цикл (start -> finish): нехватка -> добор, готово -> build_done в ленте один раз ----
  const events = [];
  const ctx = { events: { push: (type, data) => events.push({ type, ...data }) }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap2 = AP.create(ctx);
  ap2.build = { name: 'hut_west', x: -390, y: 67, z: 40, rot: 90, sig: 'S' }; ap2.buildSt = newBuildSt('S');
  const act = { ...decide({ ...base, ...buildState(ap2, Date.now()), buildDist: 3 }) };
  ctx.runSkill = async () => ({ ok: false, error: 'не хватает: cobblestone ×7', result: { missing: { cobblestone: 7 } } });
  ap2._start(act); await ap2.running.promise;
  assert.deepStrictEqual(ap2.buildSt.need, { cobblestone: 7 }, 'нехватка из итога build_blueprint');
  assert(!ap2.until.build, 'нехватка — не провал: паузы у build нет');
  assert.strictEqual(ap2.status().build.status, 'добираю cobblestone ×7');
  ap2.buildSt.need = null;
  ctx.runSkill = async () => ({ ok: true, result: { ok: true, matched: 40, total: 40 } });
  ap2._start(act); await ap2.running.promise;
  ap2._start(act); await ap2.running.promise; // повторный запуск той же строки (вручную) — события второй раз нет
  assert.strictEqual(events.filter(e => e.type === 'build_done').length, 1, 'build_done один раз');
  assert.deepStrictEqual(events.find(e => e.type === 'build_done').at, [-390, 67, 40]);
  assert.strictEqual(ap2.status().build.status, 'готово');
  assert(!events.some(e => /^(brain|wake)/.test(e.type)), 'мозг на провалы не будим');
  console.log('живой цикл постройки: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
