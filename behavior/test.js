// Офлайн-проверка поведения (без бота и сервера): ядро зовёт её перед включением новой версии (selfTest).
// Должна быть быстрой (< 15 с) и бросать исключение, если что-то не так.
'use strict';
const assert = require('assert');
const { decide, escapePause, yieldPlan, isBrainYield, verdictOf, brainHoldsBody, failPause, isCodeCrash, crashList } = require('./autopilot');
const R = require('./reflexes');
const T = require('./thresholds');

module.exports = async function selfTest() {
  // пороги — числа
  for (const [k, v] of Object.entries(T)) assert(typeof v === 'number' && Number.isFinite(v), 'порог ' + k + ' не число');
  // автопилот: день без забот -> дневная работа; враг-агрессор -> драка; мало HP -> укрытие; мозг занял тело -> ничего
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  assert.strictEqual(decide(base).name, 'day_routine');
  assert.strictEqual(decide({ ...base, enemies: [{ name: 'Bob', d: 5, why: 'бил', aggressor: true }] }).key, 'fight_player');
  assert.strictEqual(decide({ ...base, hp: 5 }).key, 'lowhp_shelter');
  assert.strictEqual(decide({ ...base, task: { name: 'collect', source: 'brain' } }), null);
  assert.strictEqual(decide({ ...base, on: false }), null);
  // мало HP: блоки — раньше укрытия (без них shelter падает «блоков на стены мало»)
  assert.strictEqual(decide({ ...base, hp: 5, blocks: 0 }).key, 'lowhp_dirt');
  assert.strictEqual(decide({ ...base, hp: 5, blocks: 0 }).name, 'collect');
  assert.strictEqual(decide({ ...base, hp: 5, blocks: 0 }).params.count, T.apLowHpBlocks);
  // блоков хватает — укрываемся
  assert.strictEqual(decide({ ...base, hp: 5, blocks: T.apLowHpBlocks }).key, 'lowhp_shelter');
  // причина «под ямой пустота (пещера)» — вниз не копаем, укрытие стенами
  const cave = { lowhp_shelter: { reason: 'под ямой пустота (пещера); блоков на стены мало (0/4)', count: 1 } };
  let a = decide({ ...base, hp: 5, blocks: T.apLowHpBlocks, failInfo: cave });
  assert.strictEqual(a.key, 'lowhp_shelter'); assert.strictEqual(a.params.mode, 'walls', 'пещера под ногами — копать нельзя');
  // одна и та же причина дважды — тактику меняем: отойти в сторону, а не звать то же самое
  a = decide({ ...base, hp: 5, blocks: T.apLowHpBlocks, failInfo: { lowhp_shelter: { reason: 'под ямой пустота (пещера)', count: 2 } } });
  assert.strictEqual(a.key, 'lowhp_move'); assert.strictEqual(a.name, 'explore');
  a = decide({ ...base, hp: 5, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt (добыто 0/10)', count: 2 } } });
  assert.strictEqual(a.key, 'lowhp_move', 'земля не идёт — меняем тактику');
  // еле жива и есть нечего — наружу не ходим: ждём (укрыться нечем)
  assert.strictEqual(decide({ ...base, hp: 2, food: 0, hasFood: false, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } }), null);
  // пауза после провала уважается: заблокированный ключ не берём
  assert.strictEqual(decide({ ...base, hp: 5, blocks: 0, blocked: { lowhp_dirt: true } }), null);
  // побег при низком HP (L014): сначала укрытие; из укрытия, ночью, без оружия и на «еле жива» — не бежим
  const low = { ...base, hp: 5, blocks: T.apLowHpBlocks };
  assert.strictEqual(decide({ ...low, hostilesNear: 1 }).key, 'lowhp_shelter', 'сначала укрытие, не побег');
  const stuck = { ...base, hp: 5, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } };
  assert.strictEqual(decide({ ...stuck, hostilesNear: 1 }).key, 'lowhp_escape', 'днём с оружием — побег');
  assert.strictEqual(decide({ ...stuck, hostilesNear: 1, sheltered: true }), null, 'из укрытия не бежим — ждём');
  assert.strictEqual(decide({ ...stuck, hostilesNear: 1, isNight: true, phase: 'ночь' }), null, 'ночью побега нет — стены и ждём утра');
  assert.strictEqual(decide({ ...stuck, hostilesNear: 1, hasWeapon: false }).key, 'lowhp_move', 'без оружия — не побег, отходим в сторону');
  assert.strictEqual(decide({ ...stuck, hp: 2, hasFood: false, hostilesNear: 1 }), null, 'HP≤4 и еды нет — наружу не ходим (ни побег, ни блоки, ни в сторону)');
  assert.strictEqual(decide({ ...stuck, hp: 2, hasFood: false, hostilesNear: 1, blocks: T.apLowHpBlocks }).key, 'lowhp_shelter', 'HP≤4 и еды нет — укрываемся, если блоки есть');
  // пауза после побега: минута; В — не оторвались: пятиминутной паузы нет, провал идёт в причины (другая тактика)
  assert.strictEqual(escapePause('lowhp_escape', true), T.apEscapeCooldownMs);
  assert.strictEqual(escapePause('lowhp_escape', false), T.apEscapeCooldownMs, 'неудачный побег — без долгой паузы');
  assert.strictEqual(T.apEscapeFailPauseMs, undefined, 'пятиминутной паузы побега больше нет');
  a = decide({ ...stuck, hostilesNear: 1, failInfo: { ...stuck.failInfo, lowhp_escape: { reason: 'побег не оторвал от врага', count: 2 } } });
  assert.strictEqual(a.key, 'lowhp_move', 'побег не оторвал — другая тактика (отойти в сторону), а не тот же побег');
  // еда: лучшая по качеству, гнилое мясо — только с голоду
  const bot = { registry: { foodsByName: { bread: { effectiveQuality: 11 }, rotten_flesh: { effectiveQuality: 4 }, cooked_beef: { effectiveQuality: 20 } } },
    inventory: { items: () => [{ name: 'rotten_flesh', count: 3 }, { name: 'bread', count: 1 }, { name: 'cooked_beef', count: 1 }] } };
  assert.strictEqual(R.pickFood(bot).name, 'cooked_beef');
  const bot2 = { ...bot, inventory: { items: () => [{ name: 'rotten_flesh', count: 3 }] } };
  assert.strictEqual(R.pickFood(bot2), null);
  assert.strictEqual(R.pickFood(bot2, { desperate: true }).name, 'rotten_flesh');
  // ---- L018: защита, которую не выполнили, не повторяем молча ----
  // что занимает тело: задача или простая команда (простые идут мимо очереди задач)
  const busyCtx = { tasks: { current: null, legacyBusy: 0, legacy: null } };
  assert.strictEqual(R.busyInfo(busyCtx).busy, false);
  busyCtx.tasks.current = { id: 12, name: 'goto', source: 'brain' };
  assert.strictEqual(R.busyInfo(busyCtx).busy, true);
  assert.ok(/навыком goto/.test(R.busyInfo(busyCtx).what), R.busyInfo(busyCtx).what);
  busyCtx.tasks.current = null; busyCtx.tasks.legacyBusy = 1; busyCtx.tasks.legacy = { name: 'goto', by: 'brain' };
  assert.strictEqual(R.busyInfo(busyCtx).legacy, true);
  assert.ok(/простой командой goto/.test(R.busyInfo(busyCtx).what), R.busyInfo(busyCtx).what);
  // отказ выполнения: пишем в журнал и убираем действие из выбора (следующий раз — другой вариант)
  const ev = []; let stopped = 0; const started = [];
  const dctx = {
    bot: { health: 18, inventory: { items: () => [] }, entities: {}, entity: { position: { x: 0, y: 64, z: 0 } } },
    events: { push: (type, d) => ev.push({ type, ...d }) },
    tasks: { current: null, legacyBusy: 1, legacy: { name: 'goto' }, stop: async () => { stopped++; } },
    runSkill: async (n, p, o) => { started.push({ n, o }); return { ok: false, error: 'выполняется простая команда, повтори через секунду' }; }
  };
  const r1 = await R.startDefense(dctx, { skill: 'shelter', params: {}, why: 'тест', options: ['shelter'] });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(stopped, 1, 'простая команда вытеснена');
  assert.ok(started[0].o.force === true, 'защита идёт с force');
  assert.ok(ev.some(e => /не выполнено/.test(e.msg) && /тело занято/.test(e.msg)), 'отказ не записан в журнал: ' + JSON.stringify(ev));
  assert.ok(Object.keys(R.bannedActions(dctx)).includes('shelter'), 'невыполненное действие не убрано из выбора');
  // успех — пауза снимается
  dctx.runSkill = async () => ({ ok: true, taskId: 1 });
  await R.startDefense(dctx, { skill: 'shelter', params: {}, why: 'тест', options: ['shelter'] });
  assert.ok(!Object.keys(R.bannedActions(dctx)).includes('shelter'), 'успешное действие осталось на паузе');
  // ---- L013: уступка мозгу — это не провал навыка ----
  // короткая команда мозга — навык не убиваем (тело отдаст команду сама)
  assert.strictEqual(yieldPlan('chest_take').kill, false, 'короткая команда — навык не убиваем');
  assert.strictEqual(yieldPlan('craft').kill, false, 'craft — короткая команда');
  assert.strictEqual(yieldPlan('survey').kill, false, 'только читает — не трогаем');
  // длинная команда — навык занимает тело, прерываем
  assert.strictEqual(yieldPlan('goto').kill, true, 'долгая команда — прерываем навык');
  assert.strictEqual(yieldPlan('wait_night').kill, true);
  // уступка мозгу отличается от провала самого навыка
  const byBrain = { brainYield: { action: 'craft', at: Date.now() } };
  assert.strictEqual(isBrainYield(byBrain, 'навык тела "collect" не удался: вытеснен командой мозга'), true, 'вытеснен мозгом — уступка');
  assert.strictEqual(isBrainYield(byBrain, 'навык тела "collect" не удался: занят навыком chest_take (taskId 12)'), true, 'тело занято мозгом — уступка');
  assert.strictEqual(isBrainYield(byBrain, 'запуск прерван (POST /abort): процесс навыка убит, телу отправлен stop'), true, 'убили сами — уступка');
  assert.strictEqual(isBrainYield(byBrain, 'не нашёл log в радиусе 48'), false, 'свой провал — не уступка');
  assert.strictEqual(isBrainYield({}, 'не нашёл log в радиусе 48'), false, 'без команды мозга — не уступка');
  assert.strictEqual(isBrainYield({ brainYield: { action: 'craft' } }, null), false, 'навык закончился успешно — не уступка');
  // уступка должна быть свежей: старая уступка не оправдывает нынешний провал
  const stale = { brainYield: { action: 'craft', at: Date.now() - (T.apYieldFreshMs + 5000) } };
  assert.strictEqual(isBrainYield(stale, 'навык тела "collect" не удался: занят навыком chest_take'), false, 'старая уступка — это обычный провал');
  // итог запуска различает «прерван по требованию мозга» и «провалился сам»
  assert.strictEqual(verdictOf(byBrain, 'вытеснен командой мозга'), 'прерван по требованию мозга');
  assert.strictEqual(verdictOf({ brainYield: { action: 'owner', at: Date.now() } }, 'вытеснен командой мозга'), 'прерван по требованию хозяина');
  assert.strictEqual(verdictOf({ aborting: 'безопасность: убегаю' }, 'навык тела "collect" не удался: убегаю'), 'прерван автопилотом');
  assert.strictEqual(verdictOf({}, 'не нашёл log в радиусе 48'), 'провал');
  assert.strictEqual(verdictOf({}, null), 'ok');
  assert.strictEqual(verdictOf({}, 'навык "day_routine" выключен: авто: 3 провала подряд'), 'навык выключен');
  // тело занято мозгом — навык убивать нельзя (его stop убил бы и команду мозга)
  const bctx = { tasks: { current: null, legacyBusy: 0, legacy: null, queue: [] } };
  assert.strictEqual(brainHoldsBody(bctx), false);
  bctx.tasks.current = { name: 'chest_take', source: 'brain', by: 'brain' };
  assert.strictEqual(brainHoldsBody(bctx), true, 'задача мозга — тело занято мозгом');
  bctx.tasks.current = { name: 'collect', source: 'autopilot', by: 'autopilot' };
  assert.strictEqual(brainHoldsBody(bctx), false, 'задача автопилота — тело не занято мозгом');
  bctx.tasks.current = null; bctx.tasks.legacyBusy = 1; bctx.tasks.legacy = { name: 'goto', by: 'brain' };
  assert.strictEqual(brainHoldsBody(bctx), true, 'простая команда мозга — тело занято мозгом');
  // ---- L043/L052: «в укрытии, стою» верно, только пока по муху не бьют — удар отменяет «укрытие»; вплотную копка-укрытие не в вариантах ----
  const V = (x, y, z) => ({
    x, y, z,
    offset: (dx, dy, dz) => V(x + dx, y + dy, z + dz),
    plus: (o) => V(x + o.x, y + o.y, z + o.z),
    distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z),
    floored: () => V(Math.floor(x), Math.floor(y), Math.floor(z))
  });
  const SOLID = { name: 'stone', boundingBox: 'block' };
  const fakeBot = (o = {}) => ({
    health: 20, food: 20, time: { timeOfDay: 1000, day: 1 },
    registry: { foodsByName: {} }, inventory: { items: () => [], slots: [] },
    entity: { position: V(0, 64, 0) },
    blockAt: () => ({ name: 'air' }), entities: {}, ...o
  });
  const fakeCtx = (bot, o = {}) => ({ bot, tasks: { current: null }, exp: { stats: {}, recent: [], pending: [], log: [] }, expRand: () => 1, ...o });
  const zombie = (d) => ({ id: 3, type: 'hostile', name: 'zombie', position: V(d, 64, 0) });
  const zClose = zombie(1.4), zFar = zombie(9);
  // муха в закрытом укрытии: блоки вокруг закрыты, тело помнит укрытие
  const cellBot = fakeBot({ blockAt: () => SOLID, entities: { 3: zClose } });
  const inCell = fakeCtx(cellBot, { sheltered: { pos: { x: 0, y: 64, z: 0 } } });
  assert.strictEqual(R.inShelter(inCell), true, 'муха в укрытии — тело знает');
  // L052: но mob_hurt = удар — признак «в укрытии» не действует (зомби в 0.3 м из «укрытия» убил за 9 с): действуем, не стоим
  const hitPlan = R.mobHurtPlan(inCell, zClose);
  assert.ok(hitPlan.shelterVoid, 'удар при признаке укрытия — причина пойдёт в журнал');
  assert.ok(!hitPlan.hold, 'удар отменяет «в укрытии, стою»');
  assert.ok(hitPlan.skill === 'fight' || hitPlan.skill === 'escape', 'при ударе — бой или побег, а не стоянка: ' + String(hitPlan.skill));
  assert.ok(!hitPlan.options.includes('shelter'), 'при ударе вплотную (2 м) копка-укрытие не в вариантах');
  // вышла из укрытия — действуем как раньше
  const openBot = fakeBot({ entities: { 3: zClose } });
  const outCell = fakeCtx(openBot);
  assert.strictEqual(R.inShelter(outCell), false, 'вышла из укрытия — укрытия нет');
  const pOpen = R.mobHurtPlan(outCell, zClose);
  assert.ok(pOpen && pOpen.skill, 'вне укрытия — выбираем защиту');
  assert.strictEqual(pOpen.shelterVoid, false, 'без признака укрытия строки-причины нет');
  // враг вплотную и HP низкий: копка-укрытие (3-4 с) не успевает — её в вариантах нет
  const lowBot = fakeBot({ health: 5, entities: { 3: zClose } });
  const optsLow = R.defensePrior(fakeCtx(lowBot), zClose);
  assert.ok(!optsLow.includes('shelter'), 'вплотную и HP низко — копки в вариантах нет');
  assert.ok(optsLow.includes('escape'), 'отход остаётся');
  assert.ok(!optsLow.includes('fight'), 'без оружия бой не предлагаем');
  const planLow = R.mobHurtPlan(fakeCtx(lowBot), zClose);
  assert.ok(!planLow.options.includes('shelter'), 'в плане защиты копки нет');
  assert.ok(/не успевает/.test(planLow.why), 'в журнале — почему копки нет: ' + planLow.why);
  // оружие есть — бой вместо копки
  const armed = fakeBot({ health: 5, entities: { 3: zClose }, inventory: { items: () => [{ name: 'stone_sword' }], slots: [] } });
  const optsArmed = R.defensePrior(fakeCtx(armed), zClose);
  assert.ok(optsArmed.includes('fight') && !optsArmed.includes('shelter'), 'оружие есть — бой вместо копки');
  // враг далеко — укрытие в вариантах остаётся
  const farBot = fakeBot({ health: 5, entities: { 3: zFar } });
  assert.ok(R.defensePrior(fakeCtx(farBot), zFar).includes('shelter'), 'далеко — укрытие в вариантах остаётся');
  // при полном HP укрытие тоже остаётся (правило — только для низкого HP)
  const hpBot = fakeBot({ health: 20, entities: { 3: zClose } });
  assert.ok(R.defensePrior(fakeCtx(hpBot), zClose).includes('shelter'), 'при полном HP укрытие в вариантах остаётся');
  // L052: при ударе враг дальше hitNoShelterDist — обычный выбор с укрытием остаётся; ночью без оружия и враг вплотную — побег
  const farHitBot = fakeBot({ entities: { 3: zFar } });
  assert.ok(R.defensePrior(fakeCtx(farHitBot), zFar, true).includes('shelter'), 'удар: враг дальше 2 м — укрытие в вариантах остаётся');
  const nightCloseBot = fakeBot({ time: { timeOfDay: 18000, day: 1 }, entities: { 3: zClose } });
  const nightPlan = R.mobHurtPlan(fakeCtx(nightCloseBot), zClose);
  assert.strictEqual(nightPlan.skill, 'escape', 'удар ночью без оружия при мобе вплотную — побег');
  assert.ok(!nightPlan.options.includes('shelter'), 'копка-укрытие в вариантах нет');
  // ---- L011/L002/L024 (заявка учителя): провал цели и сбой кода не повторяются ----
  // пауза после провала (В): долгих пауз нет — та же причина или третий провал — не больше минуты, дальше решает счёт дела
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', false, 1, 1), 4000, 'первый провал — короткая пауза');
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', true, 2, 2), T.backoffMs, 'та же причина — минута, не 5 мин');
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', true, 5, 5), T.backoffMs, 'много раз та же причина — всё равно минута');
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', false, 1, T.failMax), T.backoffMs, 'третий провал — минута');
  assert.strictEqual(failPause('learned', 'навык "build_hut" выключен: вручную', false, 1, 1), 600000, 'выключенный мозгом навык — ждём включения');
  assert.strictEqual(failPause('body', 'не нашёл log', true, 2, 2), T.backoffMs, 'у команд тела — так же');
  assert.strictEqual(T.failSameMaxMs, undefined, 'пятиминутной паузы больше нет');
  // сбой кода (в ошибке — файл и строка) — не отказ о мире
  assert.strictEqual(isCodeCrash('brain/learned/build_hut.js:250'), true, 'файл и строка — сбой кода');
  assert.strictEqual(isCodeCrash('построено 140/167, двери нет; дыры: [[-400,66,29]]'), false, 'отказ о мире — не сбой кода');
  assert.strictEqual(isCodeCrash('не нашёл log в радиусе 48'), false);
  // проваленная цель мозга — с теми же параметрами не повторяем (ждём новой строки «Автопилот:»)
  const goalState = { ...base, goal: { name: 'build_hut', params: { x: -399, z: 30 }, kind: 'learned' } };
  assert.strictEqual(decide(goalState).key, 'goal', 'цель мозга — делаем');
  assert.strictEqual(decide({ ...goalState, goalFailed: true }).key, 'day_routine', 'проваленную цель не повторяем');
  // сбой кода навыка — автопилот этот навык не зовёт
  assert.strictEqual(decide({ ...goalState, crashed: { build_hut: { reason: 'brain/learned/build_hut.js:250', at: Date.now() } } }).key, 'day_routine', 'упавшую цель не повторяем');
  assert.strictEqual(decide({ ...base, crashed: { day_routine: { reason: 'x.js:1', at: Date.now() } } }).key, 'explore', 'упавший навык не повторяем');
  assert.strictEqual(decide({ ...base, phase: 'ночь', isNight: true, nightIn: 0, sheltered: true, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } }).key, 'wait_night', 'ночью без упавшего навыка — пережидаем');
  // сбой кода (В): не 30 минут — запись живёт, пока файл навыка тот же; поменялся файл — пробуем снова
  const apc = { codeCrash: { build_hut: { reason: 'x.js:1', at: Date.now() - 1000, mtime: 111 }, fixed: { reason: 'y.js:2', at: Date.now() - 1000, mtime: 111 } } };
  const cl = crashList(apc, Date.now(), n => (n === 'fixed' ? 222 : 111));
  assert.ok(cl.build_hut, 'файл тот же — сбой кода в списке');
  assert.ok(!cl.fixed && !apc.codeCrash.fixed, 'файл поменялся — сбой забыт, навык снова можно');
  assert.strictEqual(T.apCodeCrashSkipMs, undefined, 'тридцатиминутной паузы больше нет');
  // ---- L052-автопилот (заявка учителя, смерть 23): «укрытие объявлено» ≠ «безопасно ждать» ----
  const nz = { ...base, phase: 'ночь', isNight: true, nightIn: 0, sheltered: true };
  // мобов нет и ударов нет — пережидаем ночь (как было; night_mine отключен, чтобы дойти до wait_night)
  assert.strictEqual(decide({ ...nz, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } }).key, 'wait_night', 'ночь чиста — пережидаем');
  // моб рядом ночью — wait_night не берём: бой/стены/отход
  let nd = decide({ ...nz, hostilesNear: 1, hostile: { name: 'zombie', d: 9.7 } });
  assert.ok(nd && nd.key !== 'wait_night', 'моб рядом ночью — не wait_night');
  assert.notStrictEqual(nd.key, 'night_shelter_dig', 'яму при мобе не копаем');
  assert.strictEqual(decide({ ...nz, sheltered: false, hasWeapon: false, hostilesNear: 1, hostile: { name: 'zombie', d: 9.7 } }).params.mode, 'walls', 'рядом моб, без оружия — укрытие стенами, не яма: копка 3-4 с, зомби успевает влезть (9.7 → 2.7 м)');
  // с оружием и HP в норме — отбиваемся; а начавшийся wait_night прерываем (не молча держим)
  nd = decide({ ...nz, hostilesNear: 1, hostile: { name: 'zombie', d: 0.3 }, running: { name: 'wait_night', key: 'wait_night', kind: 'body' } });
  assert.strictEqual(nd.key, 'night_fight', 'оружие есть — отбиваемся от зомби');
  assert.strictEqual(nd.params.target, 'zombie', 'цель — моб');
  assert.strictEqual(nd.preempt, true, 'wait_night прерываем — тело отдаём защите');
  // без оружия и моб вплотную уже бил — стены не успеть: отходим
  nd = decide({ ...nz, sheltered: false, hasWeapon: false, hitRecent: true, hostilesNear: 1, hostile: { name: 'zombie', d: 0.8 } });
  assert.strictEqual(nd.key, 'night_escape', 'враг вплотную и по муху били — отход (L052: та же смерть 23)');
  // по муху били, даже моба не видно (strея издалека) — wait_night отменяется
  nd = decide({ ...nz, hitRecent: true, hostilesNear: 0, hostile: null });
  assert.ok(nd && nd.key !== 'wait_night', 'свежие удары — не wait_night');
  assert.strictEqual(nd.key, 'night_escape', 'в укрытии, но по муху били — выхожу и отхожу');
  // мобов нет — яму копаем как раньше (дистанция/условия прежние)
  assert.strictEqual(decide({ ...nz, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true }).key, 'night_shelter_dig', 'мобов нет — закапываюсь');
  // все варианты защиты на паузе — не берём ни яму, ни ночную работу, ни wait_night
  assert.strictEqual(decide({ ...nz, hostilesNear: 1, hostile: { name: 'zombie', d: 7.2 }, blocked: { night_fight: true, night_shelter: true, night_escape: true } }), null, 'защита на паузе — ничего не начинаем');
  // в закрытом укрытии ударов нет — без оружия ждём моба в укрытии (не вместо wait_night — журнальная строка в тике)
  nd = decide({ ...nz, hasWeapon: false, hostilesNear: 1, hostile: { name: 'zombie', d: 5 } });
  assert.strictEqual(nd, null, 'в укрытии, ударов нет, без оружия — стоим (не wait_night!)');
  // ---- А: опасность по последствию (lib/danger.js fight/outlook), а не по порогу HP ----
  const Dg = require('./core')('danger');
  const f1 = Dg.fight({ hp: 5, weapon: 'fist', mobs: [{ name: 'zombie', d: 1.4 }] });
  assert.ok(!f1.win && f1.ttdSec <= 2 && f1.hitsToDie === 2, 'HP 5 без оружия против зомби вплотную — проигрыш: ' + JSON.stringify(f1));
  const f2 = Dg.fight({ hp: 20, weapon: 'iron_sword', mobs: [{ name: 'zombie', d: 9 }] });
  assert.ok(f2.win && f2.hpLeft > 10, 'железный меч, HP 20 против зомби — победа: ' + JSON.stringify(f2));
  const f3 = Dg.fight({ hp: 20, weapon: 'iron_sword', mobs: [{ name: 'creeper', d: 3 }] });
  assert.ok(!f3.win && f3.hitsToDie === 1, 'крипер вплотную убивает взрывом и при полном HP');
  const f4 = Dg.fight({ hp: 6, weapon: 'stone_sword', mobs: [{ name: 'zombie', d: 8 }] });
  assert.ok(f4.win, 'HP 6 (ниже старого порога 10), но с мечом против одного зомби — бой по силам');
  assert.ok(f1.passiveTtdSec != null && f1.passiveTtdSec * 1000 < T.shelterBuildMs, 'не отбиваясь — умрёт раньше, чем выкопает укрытие');
  // автопилот: оценка решает, порог — нет
  assert.notStrictEqual((decide({ ...base, hp: 6, outlook: f4 }) || {}).key, 'lowhp_shelter', 'HP 6, бой по силам — не «мало HP»');
  assert.strictEqual(decide({ ...base, hp: 15, outlook: { win: false, passiveTtdSec: 3, hitsToDie: 2 } }).key, 'lowhp_shelter', 'HP 15, но встреча проиграна и умрёт за 3 с — «мало HP»');
  nd = decide({ ...nz, hp: 8, hostilesNear: 1, hostile: { name: 'zombie', d: 6 }, outlook: { win: true, passiveTtdSec: 5 } });
  assert.strictEqual(nd.key, 'night_fight', 'HP 8 (ниже порога 12), но бой выигран — отбиваемся');
  nd = decide({ ...nz, hp: 20, sheltered: false, hostilesNear: 3, hostile: { name: 'zombie', d: 6 }, outlook: { win: false, ttdSec: 4, passiveTtdSec: 8 } });
  assert.notStrictEqual(nd.key, 'night_fight', 'HP 20, но толпу не перебить — в бой не лезем');
  // рефлекс: с мечом и HP 5 против одного зомби — бой (оценка), копка не успевает (не отбиваясь — 1 с)
  const armed5 = fakeBot({ health: 5, entities: { 3: zClose }, inventory: { items: () => [{ name: 'stone_sword' }], slots: [] } });
  assert.ok(R.outlookOf(fakeCtx(armed5), zClose).win, 'оценка рефлекса видит победу');
  assert.ok(R.shelterTooSlow(fakeCtx(armed5), zClose), 'копка не успевает — по оценке');

  // ---- В: выбор по обстановке, а не очередь ----
  const gl = { name: 'collect', params: { block: 'stone', count: 60 }, kind: 'body', sig: 'x' };
  assert.strictEqual(decide({ ...base, goal: gl }).key, 'goal', 'сыта — цель мозга');
  assert.strictEqual(decide({ ...base, goal: gl, food: 2, hasFood: false, animals: 3 }).key, 'hunt', 'голодна и еды нет — сначала охота, потом цель');
  assert.strictEqual(decide({ ...base, goal: gl, food: 12, hasFood: false, animals: 3 }).key, 'goal', 'чуть голодна — цель важнее');
  const bs = { x: 0, y: 64, z: 0, r: 96 };
  assert.strictEqual(decide({ ...base, goal: gl, base: bs, baseDist: 110 }).key, 'goal', 'база чуть дальше радиуса, день — цель');
  assert.strictEqual(decide({ ...base, goal: gl, base: bs, baseDist: 110, nightIn: 60 }).key, 'go_base', 'до ночи минута — к базе');
  assert.strictEqual(decide({ ...base, goal: gl, base: bs, baseDist: 400 }).key, 'go_base', 'база далеко — к базе');
  // провал — не пауза, а другое дело или те же дела с другими параметрами
  const wood = { ...base, hasPickaxe: false, logs: 2, crashed: { day_routine: { reason: 'x.js:1' } } };
  assert.strictEqual(decide(wood).key, 'collect_log');
  a = decide({ ...wood, failInfo: { collect_log: { reason: 'не нашёл log', count: 1 } } });
  assert.ok(a.key === 'collect_log' && a.params.radius > 48, 'повтор сбора — шире радиус: ' + JSON.stringify(a.params));
  assert.strictEqual(decide({ ...wood, failInfo: { collect_log: { reason: 'не нашёл log', count: 2 } } }).key, 'explore', 'дважды не вышло — следующее дело');
  assert.ok(decide(base).score != null, 'счёт выбранного дела виден');
  // ---- behavior_autopilot (заявка учителя, день 21): «иду на базу» — не голая команда goto через огонь и лаву ----
  const farBase = { ...base, base: { x: 0, y: 64, z: 0, r: 96 }, baseDist: 275 };
  assert.strictEqual(decide(farBase).key, 'go_base', 'дорога чистая и днём — начинаем');
  // до старта: снимок «горю» — дорогу не начинаем (берём следующее дело); в лаве — сначала «выбираюсь»
  assert.strictEqual(decide({ ...farBase, onFire: true }).key, 'day_routine', 'горю — дорогу не начинаем');
  assert.strictEqual(decide({ ...farBase, inLava: true }).key, 'unstuck', 'в лаве — сначала выходим, дорогу не начинаем');
  // по ходу голого goto: загорела на дороге к базе — бросаем дорогу немедленно и отходим/укрываемся (go_safe смотрит сам, его не дёргаем)
  let gfire = decide({ ...farBase, onFire: true, running: { name: 'goto', key: 'go_base', kind: 'body' } });
  assert.strictEqual(gfire.key, 'go_base_escape', 'загорела на дороге к базе — бросаем дорогу');
  assert.strictEqual(gfire.preempt, true, 'дорогу прерываем немедленно');
  assert.ok(/горю/.test(gfire.why), 'в журнале видно, что бросаем из-за огня: ' + gfire.why);
  assert.strictEqual(decide({ ...farBase, running: { name: 'go_safe', key: 'go_base', kind: 'learned' }, onFire: true }), null, 'go_safe сам смотрит снимок — не дёргаем');
  // ночью (закат) HP < 8 или еда < 18 (без регенерации, REGEN_FOOD=18) — дорогу не начинаем; днём можно
  // (HP 7 при оценке «бой по силам» в «мало HP» не попадает — тем гейт и ловим)
  const oWin = { win: true, passiveTtdSec: 60, hitsToDie: 2 };
  assert.strictEqual(decide({ ...farBase, nightIn: 60, hp: 7, outlook: oWin }).key, 'day_routine', 'ночью при HP 7 дорогу не начинаем');
  assert.strictEqual(decide({ ...farBase, nightIn: 60, food: 17 }).key, 'day_routine', 'ночью без регенерации (еда < 18) дорогу не начинаем');
  assert.strictEqual(decide({ ...farBase, hp: 7, food: 17, outlook: oWin }).key, 'go_base', 'днём и чисто — дорогу можно');
  // go_safe включён у исполнителя — дорогу ведёт он (проверки лавы/огня/воды/края/HP/ночи), а не голый goto
  const gs = decide({ ...farBase, goSafe: true });
  assert(gs && gs.key === 'go_base' && gs.kind === 'learned' && gs.name === 'go_safe', 'go_safe есть — дорогу ведёт он: ' + JSON.stringify(gs));
  assert.strictEqual(gs.params.max_sec, T.goSafeMaxSec, 'предел времени go_safe — из порогов');
  assert.strictEqual(decide({ ...farBase, goSafe: true }).name, 'go_safe', 'не goto');
  // ---- v0.2 «простой страшнее смерти»: давление простоя стройки (idleBuildMin) ----
  const bg = { x: 0, y: 64, z: 0, r: 96 };
  const hut = { name: 'build_hut', params: { x: 5, z: 5 }, kind: 'learned', sig: 'h' };
  // (а) без поля idleBuildMin (и при 0) — всё как раньше
  assert.strictEqual(decide({ ...base, idleBuildMin: 0 }).key, 'day_routine', 'простоя нет — как раньше');
  assert.strictEqual(decide({ ...base, goal: hut, base: bg, baseDist: 400 }).key, 'go_base', 'без поля — база далеко важнее цели');
  assert.strictEqual(decide({ ...nz, crashed: { night_mine: { reason: 'x.js:1' } }, goal: hut }).key, 'wait_night', 'без поля, ночью без базы — пережидаем');
  // (б) днём простой 10 мин — цель побеждает дорогу к базе и разведку
  assert.strictEqual(decide({ ...base, goal: hut, base: bg, baseDist: 400, idleBuildMin: 10 }).key, 'goal', 'простой 10 мин — цель раньше go_base');
  const noWork = { ...base, crashed: { day_routine: { reason: 'x.js:1' } } };
  assert.strictEqual(decide(noWork).key, 'explore');
  a = decide({ ...noWork, goal: hut, idleBuildMin: 10, failInfo: { goal: { reason: 'x', count: 2 } } });
  assert.strictEqual(a.key, 'goal', 'простой 10 мин — цель раньше разведки даже после двух провалов');
  assert.strictEqual(a.score, 50 + T.idlePerMin * 10 - 2 * T.apFailPenalty, 'счёт цели: 50 + давление − провалы');
  assert.strictEqual(decide({ ...base, goal: hut, idleBuildMin: 1000 }).score, 50 + T.idlePerMin * T.idleCapMin, 'давление не выше потолка');
  // (в) ночью без угрозы у базы, простой ≥ 8 — цель раньше ожидания/укрытия; идущий wait_night прерываем
  const nb = { ...nz, base: bg, baseDist: 10, goal: hut };
  assert.strictEqual(decide({ ...nb, idleBuildMin: T.idleBreakWaitMin }).key, 'goal', 'ночь у базы, простой — цель, а не wait_night/night_mine');
  assert.strictEqual(decide({ ...nb, sheltered: false, idleBuildMin: 10 }).key, 'goal', 'ночь у базы без укрытия, простой — цель, а не укрытие');
  assert.strictEqual(decide({ ...nb, sheltered: false }).key, 'night_shelter_dig', 'простоя нет — укрытие как раньше');
  assert.ok(decide({ ...nb, freeBed: true, idleBuildMin: 10 }).key !== 'sleep', 'простой — не сон');
  const wn = { ...nb, running: { name: 'wait_night', key: 'wait_night', kind: 'body' } };
  nd = decide({ ...wn, idleBuildMin: T.idleBreakWaitMin });
  assert.ok(nd && nd.key === 'goal' && nd.preempt === true, 'идущий wait_night прерываем ради цели: ' + JSON.stringify(nd));
  assert.strictEqual(decide({ ...wn, idleBuildMin: T.idleBreakWaitMin - 1 }), null, 'простой меньше порога — ждём ночь дальше');
  assert.strictEqual(decide({ ...wn, idleBuildMin: 20, idle: false }), null, 'мозг командовал — не прерываем');
  assert.strictEqual(decide({ ...wn, idleBuildMin: 20, blocked: { goal: true } }), null, 'цель на паузе — не прерываем');
  // (г) ночью с угрозой или мало HP — давление не действует
  nd = decide({ ...nb, idleBuildMin: 40, hostilesNear: 1, hostile: { name: 'zombie', d: 5 } });
  assert.ok(!nd || nd.key !== 'goal', 'моб рядом ночью — не цель');
  nd = decide({ ...wn, idleBuildMin: 40, hostilesNear: 1, hostile: { name: 'zombie', d: 2 } });
  assert.ok(!nd || nd.key !== 'goal', 'моб рядом — wait_night прерывает защита, не цель');
  assert.strictEqual(decide({ ...wn, idleBuildMin: 40, hitRecent: true }).key, 'night_escape', 'били — защита, не цель');
  assert.notStrictEqual((decide({ ...nb, idleBuildMin: 40, hp: 5 }) || {}).key, 'goal', 'мало HP ночью — не цель');
  assert.strictEqual(decide({ ...wn, idleBuildMin: 40, hp: 5 }), null, 'мало HP — wait_night не прерываем ради цели');
  assert.strictEqual(decide({ ...base, goal: hut, idleBuildMin: 40, hp: 5 }).key, 'lowhp_shelter', 'мало HP днём — укрытие, не цель');
  // (д) ночью вне базы (или без базы, или точка цели вне базы) — цели нет
  assert.notStrictEqual(decide({ ...nb, baseDist: 300, idleBuildMin: 40 }).key, 'goal', 'ночью вне базы — не цель');
  assert.notStrictEqual(decide({ ...nb, base: null, baseDist: null, idleBuildMin: 40 }).key, 'goal', 'ночью без базы — не цель');
  assert.notStrictEqual(decide({ ...nb, goal: { ...hut, params: { x: 500, z: 500 } }, idleBuildMin: 40 }).key, 'goal', 'точка цели вне базы — не цель');
  assert.strictEqual(decide({ ...wn, baseDist: 300, idleBuildMin: 40 }), null, 'вне базы wait_night не прерываем');
  // (е) провал цели — повтор после паузы goalRetryMs с шагом вдвое меньше; успех без нового блока — не повторяем
  const { goalState: GS, goalAfter: GA, stepParams: SP } = require('./autopilot');
  const g60 = { name: 'collect', params: { block: 'stone', count: 60 }, kind: 'body', sig: 's60' };
  const apg = { goal: g60 };
  const t0 = 1e12;
  assert.deepStrictEqual(GS(apg, t0), { goal: g60, goalDone: false, goalFailed: false }, 'цель свежая');
  GA(apg, { sig: 's60', name: 'collect' }, 'провал', 'не нашёл stone', t0, false);
  assert.strictEqual(GS(apg, t0 + 1000).goalFailed, true, 'сразу после провала — пауза');
  let gs2 = GS(apg, t0 + T.goalRetryMs);
  assert.ok(!gs2.goalFailed && gs2.goal.params.count === 30, 'после паузы — повтор, count вдвое меньше: ' + JSON.stringify(gs2));
  assert.strictEqual(decide({ ...base, ...gs2 }).params.count, 30, 'decide берёт уменьшенный шаг');
  GA(apg, { sig: 's60', name: 'collect' }, 'провал', 'не нашёл stone', t0 + T.goalRetryMs, false);
  assert.strictEqual(GS(apg, t0 + 3 * T.goalRetryMs).goal.params.count, 15, 'второй провал — ещё вдвое');
  assert.strictEqual(SP({ n: 1, count: 3, 'кол-во': 5 }, 8).n, 1, 'не меньше 1');
  GA(apg, { sig: 's60', name: 'collect' }, 'ok', null, t0 + 4 * T.goalRetryMs, true);
  gs2 = GS(apg, t0 + 4 * T.goalRetryMs + 1000);
  assert.ok(gs2.goalDone && gs2.goal.params.count === 60, 'успех — шаг сброшен, короткая пауза');
  assert.strictEqual(GS(apg, t0 + 4 * T.goalRetryMs + T.goalRepeatMs).goalDone, false, 'успех с прогрессом — следующий шаг');
  GA(apg, { sig: 's60', name: 'collect' }, 'ok', null, t0 + 5 * T.goalRetryMs, false);
  assert.strictEqual(GS(apg, t0 + 50 * T.goalRetryMs).goalDone, true, 'успех без нового блока — до новой строки не повторяем');
  assert.strictEqual(GS({ goal: { ...g60, sig: 'new' }, goalDone: 's60', goalEmpty: 's60' }, t0).goalDone, false, 'новая строка — снова');
  // ---- behavior_autopilot_build_gather: цель добора — ИТОГ (need), не дельта (missing) ----
  const { lackOf: LO, buildState: BS, buildAfter: BA, newBuildSt: NBS } = require('./autopilot');
  const now2 = 1e9;
  // build_blueprint вернул missing=37, have=64, need=101 → цель добора 101
  const bpResult = { missing: { cobblestone: 37 }, have: { cobblestone: 64 }, need: { cobblestone: 101 } };
  const apBuild = { build: { name: 'hut_west', x: 0, y: 64, z: 0, rot: 0, sig: 'S' }, buildSt: NBS('S') };
  let r2 = BA(apBuild, { key: 'build', sig: 'S' }, 'провал', 'не хватает: cobblestone ×37', bpResult, now2, false);
  assert.ok(r2 && /добираю до/.test(r2.note) && /cobblestone ×101/.test(r2.note), 'цель добора — итог 101: ' + r2.note);
  assert.deepStrictEqual(apBuild.buildSt.need, { cobblestone: 101 }, 'st.need = итог (need), не дельта');
  // пустой добор (ok, но collected/crafted пусты) → пауза с причиной, need не сбрасывается
  r2 = BA(apBuild, { key: 'build_gather', sig: 'S' }, 'ok', null, { ok: true, collected: {}, crafted: {}, have: { cobblestone: 64 } }, now2, false);
  assert.ok(/добор ничего не дал/.test(r2.note), 'пустой добор → пауза с причиной: ' + r2.note);
  assert.deepStrictEqual(apBuild.buildSt.need, { cobblestone: 101 }, 'need не сброшен после пустого dobroра');
  // добор с реальной прибавкой → need сбрасывается, строим снова (используем время после паузы)
  const afterPause = now2 + T.buildRetryMs + 1;
  r2 = BA(apBuild, { key: 'build_gather', sig: 'S' }, 'ok', null, { ok: true, collected: { cobblestone: 37 }, crafted: {}, have: { cobblestone: 101 } }, afterPause, false);
  assert.ok(/добор сделал.*строю снова/.test(r2.note), 'реальный добор → строю снова: ' + r2.note);
  assert.strictEqual(apBuild.buildSt.need, null, 'need сброшен после реального dobroра');
  // ночной добор не начинается (buildAct возвращает null)
  const { decide: D } = require('./autopilot');
  const nightBase = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'ночь', isNight: true, nightIn: 10, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, base: { x: 0, y: 64, z: 0, r: 96 }, baseDist: 5,
    build: { name: 'hut', x: 0, y: 64, z: 0, rot: 0, sig: 'S', need: { cobblestone: 10 } }, buildDist: 3, outlook: null, crashed: {}, idleBuildMin: 0 };
  const nightAct = D(nightBase);
  assert.ok(!nightAct || nightAct.key !== 'build_gather', 'ночью с need — не вызывается build_gather (вернулось: ' + (nightAct ? nightAct.key : 'null') + ')');
  return { ok: true };
};
