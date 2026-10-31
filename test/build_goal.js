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

  // ---- v0.3 стройка шагами: материал кончился по ходу — что есть, ставлю (build_partial), добор шагом ----
  const S = T.buildStepItems;
  ap.buildSt = newBuildSt('S');
  // не хватает только подпорок/части — в сумке есть 30 булыжника: build_partial, а не добор всего списка
  r = buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не хватает: cobblestone ×50', { missing: { cobblestone: 50 }, have: { cobblestone: 30 } }, now, false);
  assert.deepStrictEqual(ap.buildSt.need, { cobblestone: 30 + S }, 'шаг: есть + buildStepItems, не 80: ' + r.note);
  a = decide({ ...base, ...buildState(ap, now), buildDist: 3 });
  assert(a.key === 'build_partial' && a.name === 'build_partial_v1' && a.params.blueprint === 'hut_west', 'есть материал — ставлю частью: ' + JSON.stringify(a));
  // поставил часть, осталось 20 — сумка пуста, добор шагом (с нуля)
  r = buildAfter(ap, { key: 'build_partial', sig: 'S' }, 'ok', null, { ok: true, partial: true, placed: 30, missing: { cobblestone: 20 } }, now, true);
  assert(/поставил 30/.test(r.note), r.note);
  assert.deepStrictEqual(ap.buildSt.need, { cobblestone: Math.min(20, S) });
  a = decide({ ...base, ...buildState(ap, now), buildDist: 3 });
  assert(a.key === 'build_gather' && a.params.items === 'cobblestone:' + Math.min(20, S), 'сумка пуста — добор шага: ' + JSON.stringify(a));
  // добор принёс — строю снова; build_partial довёл до конца — готово
  r = buildAfter(ap, { key: 'build_gather', sig: 'S' }, 'ok', null, { ok: true, collected: { cobblestone: 20 }, have: { cobblestone: 20 } }, now, true);
  assert(/строю снова/.test(r.note), r.note);
  r = buildAfter(ap, { key: 'build_partial', sig: 'S' }, 'ok', null, { ok: true, placed: 20, complete: true }, now, true);
  assert(r.done && buildStatus(ap, now).status === 'готово');
  // build_partial ничего не поставил — не повторяет пустую стройку: stuck, добор шага; buildGatherMax раз — пауза
  ap.buildSt = newBuildSt('S');
  buildAfter(ap, { key: 'build', sig: 'S' }, 'провал', 'не хватает: glass ×4', { missing: { glass: 4 }, have: { glass: 1 } }, now, false);
  r = buildAfter(ap, { key: 'build_partial', sig: 'S' }, 'провал', 'нечего ставить: нет glass', { missing: { glass: 3 } }, now, false);
  assert(/нечего ставить/.test(r.note) && buildState(ap, now).build.partialStuck && buildState(ap, now).build.have === null, r.note);
  assert.strictEqual(decide({ ...base, ...buildState(ap, now), buildDist: 3 }).key, 'build_gather', 'после пустой частичной — добор');
  for (let i = 1; i < T.buildGatherMax; i++) r = buildAfter(ap, { key: 'build_partial', sig: 'S' }, 'провал', 'нечего ставить', { missing: { glass: 3 } }, now, false);
  assert(/подряд/.test(r.note) && buildState(ap, now + 1).build === null, 'пустая частичная подряд — пауза: ' + r.note);
  console.log('стройка шагами: OK');

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

  // ---- v0.4 «Автопилот:» упал на нехватке «не хватает блоков: …» -> gather_list с ключом goal_gather, потом цель снова ----
  assert.deepStrictEqual(lackOf('не хватает блоков: spruce_fence ×12, torch ×4', null), { spruce_fence: 12, torch: 4 }, 'lackOf: «не хватает блоков:»');
  assert.deepStrictEqual(lackOf('не хватило блоков: spruce_fence x12, torch x4', null), { spruce_fence: 12, torch: 4 }, 'lackOf: «xN»');
  const lamp = { name: 'lamp_posts', params: { x1: 1, z1: 2, x2: 30, z2: 2, every: 6 }, kind: 'learned', sig: 'lamp' };
  const LERR = 'не хватает блоков: spruce_fence ×12, torch ×4';
  const LRES = { ok: false, error: LERR, missing: { spruce_fence: 12, torch: 4 }, have: { spruce_fence: 0, torch: 0 } };
  const gev = [];
  const gctx = { events: { push: (type, data) => gev.push({ type, ...data }) }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const apg = AP.create(gctx);
  apg.goal = lamp; apg.goalSigSeen = 'lamp';
  const gnow = Date.now();
  const go = a => { apg._start({ ...a, kind: 'body' }); return apg.running.promise; }; // исполнителя :3200 в тесте нет — гоним через ctx.runSkill
  const dg = ex => decide({ ...base, ...AP.goalState(apg, Date.now()), ...ex });
  a = dg({});
  assert(a.key === 'goal' && a.name === 'lamp_posts', 'сначала сама цель');
  gctx.runSkill = async () => ({ ok: false, error: LERR, result: LRES });
  await go(a);
  assert(!apg.goalFail && !apg.until.goal, 'нехватка — не провал цели: паузы и деления шага нет');
  a = dg({});
  assert(a.key === 'goal_gather' && a.kind === 'learned' && a.name === 'gather_list' && a.params.items === 'spruce_fence:12,torch:4', 'провал по нехватке -> gather_list этих предметов: ' + JSON.stringify(a));
  assert.strictEqual(apg.status().goalGather, 'lamp_posts: добираю spruce_fence ×12, torch ×4');
  // ночью с угрозой добор не начинаем (как build_gather)
  a = dg({ isNight: true, phase: 'ночь', nightIn: 0, hostilesNear: 1, hostile: { name: 'zombie', d: 20 } });
  assert(!a || a.key !== 'goal_gather', 'ночью с мобом добор не начинаем');
  // добор прерван — продолжаем без паузы и счёта
  gctx.runSkill = async () => ({ ok: false, error: 'вытеснен командой мозга' });
  await go(dg({}));
  assert.strictEqual(dg({}).key, 'goal_gather', 'прерванный добор — нужда остаётся');
  // добор дал всё нужное -> цель снова
  gctx.runSkill = async () => ({ ok: true, result: { ok: true, collected: { spruce_log: 3 }, crafted: { spruce_fence: 12, torch: 4 }, have: { spruce_fence: 12, torch: 4 } } });
  delete apg.until.goal_gather;
  await go(dg({}));
  assert(!apg.goalNeed, 'добор сделан — нужда снята');
  assert.strictEqual(dg({}).key, 'goal', 'после добора — цель снова');
  // добор каждый раз даёт часть, а цель снова падает на нехватке — после buildGatherMax доборов обычный провал цели (пауза, шаг вдвое меньше)
  gctx.runSkill = async name => name === 'gather_list'
    ? { ok: true, result: { ok: true, collected: { spruce_log: 1 }, have: { spruce_fence: 3, torch: 0 } } }
    : { ok: false, error: LERR, result: LRES };
  for (let i = 0; i < 12 && !apg.goalFail; i++) {
    delete apg.until.goal_gather; delete apg.until.goal;
    await go(dg({}));
  }
  assert(apg.goalFail && /добор не помогает/.test(apg.goalFail.reason), 'добор не помогает -> провал цели: ' + JSON.stringify(apg.goalFail));
  assert(AP.goalState(apg, Date.now()).goalFailed && !AP.goalState(apg, Date.now()).goalNeed, 'пауза goalRetryMs, нужды нет');
  // пустой добор -> провал цели с причиной «добор ничего не дал»
  const ap3 = AP.create(gctx); ap3.goal = lamp; ap3.goalSigSeen = 'lamp';
  AP.goalAfter(ap3, { sig: 'lamp', name: 'lamp_posts' }, 'провал', 'x', gnow, false, LERR, LRES);
  const r3 = AP.goalGatherAfter(ap3, { sig: 'lamp' }, 'провал', 'не добрал: torch x4', { collected: {}, crafted: {}, have: { spruce_fence: 0, torch: 0 } }, gnow);
  assert(r3.failed && /добор ничего не дал/.test(r3.failed) && ap3.goalFail && !ap3.goalNeed, 'пустой добор: ' + JSON.stringify(r3));
  // нехватка без названия предметов и «Постройка:»-путь не затронуты: обычный провал цели как раньше
  const ap4 = AP.create(gctx);
  AP.goalAfter(ap4, { sig: 'g', name: 'collect' }, 'провал', 'нет кирки', gnow, false, 'нет кирки', null);
  assert(ap4.goalFail && ap4.goalDiv === 2 && !ap4.goalNeed, 'не нехватка — шаг вдвое меньше, как раньше');
  console.log('добор под цель «Автопилот:»: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
