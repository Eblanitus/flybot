// Офлайн-проверка поведения (без бота и сервера): ядро зовёт её перед включением новой версии (selfTest).
// Должна быть быстрой (< 15 с) и бросать исключение, если что-то не так.
'use strict';
const assert = require('assert');
const { decide, escapePause, yieldPlan, isBrainYield, verdictOf, brainHoldsBody, failPause, isCodeCrash, crashList } = require('./autopilot');
const R = require('./reflexes');
const T = require('./thresholds');

module.exports = async function selfTest() {
  console.log('SELFTEST-START');
  // пороги — числа
  for (const [k, v] of Object.entries(T)) assert(typeof v === 'number' && Number.isFinite(v), 'порог ' + k + ' не число');
  // автопилот: день без забот -> дневная работа; враг-агрессор -> драка; мало HP -> укрытие; мозг занял тело -> ничего
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  assert.strictEqual(decide(base).name, 'day_routine');
  assert.strictEqual(decide({ ...base, enemies: [{ name: 'Bob', d: 5, why: 'бил', aggressor: true }] }).key, 'fight_player');
  // заявки 23.10 (простой страшнее смерти): «мало HP — укрываюсь» — только при угрозе (моб рядом/удары/темно); здесь зомби в 9 м
  const mob9 = { hostilesNear: 1, hostile: { name: 'zombie', d: 9 } };
  assert.strictEqual(decide({ ...base, ...mob9, hp: 5 }).key, 'lowhp_shelter');
  assert.strictEqual(decide({ ...base, task: { name: 'collect', source: 'brain' } }), null);
  assert.strictEqual(decide({ ...base, on: false }), null);
  // мало HP: блоки — раньше укрытия (без них shelter падает «блоков на стены мало»)
  assert.strictEqual(decide({ ...base, ...mob9, hp: 5, blocks: 0 }).key, 'lowhp_dirt');
  assert.strictEqual(decide({ ...base, ...mob9, hp: 5, blocks: 0 }).name, 'collect');
  assert.strictEqual(decide({ ...base, ...mob9, hp: 5, blocks: 0 }).params.count, T.apLowHpBlocks);
  // блоков хватает — укрываемся
  assert.strictEqual(decide({ ...base, ...mob9, hp: 5, blocks: T.apLowHpBlocks }).key, 'lowhp_shelter');
  // причина «под ямой пустота (пещера)» — вниз не копаем, укрытие стенами
  const cave = { lowhp_shelter: { reason: 'под ямой пустота (пещера); блоков на стены мало (0/4)', count: 1 } };
  let a = decide({ ...base, ...mob9, hp: 5, blocks: T.apLowHpBlocks, failInfo: cave });
  assert.strictEqual(a.key, 'lowhp_shelter'); assert.strictEqual(a.params.mode, 'walls', 'пещера под ногами — копать нельзя');
  // одна и та же причина дважды — тактику меняем: отойти в сторону, а не звать то же самое
  a = decide({ ...base, ...mob9, hasWeapon: false, hp: 5, blocks: T.apLowHpBlocks, failInfo: { lowhp_shelter: { reason: 'под ямой пустота (пещера)', count: 2 } } });
  assert.strictEqual(a.key, 'lowhp_move'); assert.strictEqual(a.name, 'explore'); // без оружия — побега нет, отходим
  a = decide({ ...base, ...mob9, hasWeapon: false, hp: 5, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt (добыто 0/10)', count: 2 } } });
  assert.strictEqual(a.key, 'lowhp_move', 'земля не идёт — меняем тактику');
  // еле жива и есть нечего — наружу не ходим: ждём (укрыться нечем)
  assert.strictEqual(decide({ ...base, hp: 2, food: 0, hasFood: false, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } }), null);
  // пауза после провала уважается: заблокированный ключ не берём
  assert.notStrictEqual((decide({ ...base, ...mob9, hp: 5, blocks: 0, blocked: { lowhp_dirt: true } }) || {}).key, 'lowhp_dirt'); // на паузе — другое (побег), не то же самое
  // побег при низком HP (L014): сначала укрытие; из укрытия, ночью, без оружия и на «еле жива» — не бежим
  const low = { ...base, ...mob9, hp: 5, blocks: T.apLowHpBlocks };
  assert.strictEqual(decide({ ...low, hostilesNear: 1 }).key, 'lowhp_shelter', 'сначала укрытие, не побег');
  const stuck = { ...base, ...mob9, hp: 5, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } };
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
  // behavior_reflexes_shelter_no_mobs: мобов нет — укрытие не дело: работа ночью (туннель), а не яма
  nd = decide({ ...nz, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true });
  assert.ok(nd && !/^night_shelter|^wait_night$/.test(nd.key), 'мобов нет — не закапываюсь: ' + JSON.stringify(nd));
  // дел нет совсем (туннель упал, камня хватает) — яма как запасной вариант остаётся
  assert.strictEqual(decide({ ...nz, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true, crashed: { night_mine: {} } }).key, 'night_shelter_dig', 'дел нет — закапываюсь');
  // HP низкий ночью — укрытие по-прежнему выше работы
  assert.strictEqual(decide({ ...nz, hp: 8, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true }).key, 'lowhp_shelter', 'мало HP ночью — укрываюсь');
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
  assert.strictEqual(decide({ ...base, ...mob9, hp: 15, outlook: { win: false, passiveTtdSec: 3, hitsToDie: 2 } }).key, 'lowhp_shelter', 'HP 15, но встреча проиграна и умрёт за 3 с — «мало HP»');
  // fullhp_wait: HP 20, встреча «проиграна» (крипер 11 м — вне hostileR), есть постройка — дело, а не ожидание
  nd = decide({ ...base, hp: 20, food: 20, outlook: { win: false, passiveTtdSec: 3, hitsToDie: 1 }, build: { name: 'hut', x: 0, y: 64, z: 0, rot: 0, sig: 'h', need: null }, buildDist: 3 });
  assert.ok(nd && nd.key === 'build', 'HP 20 без моба рядом — строю, не жду: ' + JSON.stringify(nd));
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
  assert.strictEqual(decide(farBase).params.priority, true, 'go_base имеет приоритет');
  assert.strictEqual(decide({ ...farBase, goSafe: true }).params.priority, true, 'go_safe имеет приоритет');
  const buildFar = { ...base, build: { name: 'hut', x: 100, y: 64, z: 100, rot: 0, sig: 'b' }, buildDist: 50 };
  assert.strictEqual(decide(buildFar).params.priority, true, 'build_go имеет приоритет');
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
  assert.ok(/^(goal|night_mine)$/.test(decide({ ...nb, sheltered: false }).key), 'простоя нет, мобов нет — дело (цель/туннель), не укрытие (shelter_no_mobs)');
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
  assert.strictEqual(decide({ ...base, ...mob9, goal: hut, idleBuildMin: 40, hp: 5 }).key, 'lowhp_shelter', 'мало HP днём и моб рядом — укрытие, не цель');
  // shelter_no_mobs (3): HP 10 (и ниже) без мобов днём, сыта (реген идёт) — работа, не укрытие
  assert.strictEqual(decide({ ...base, goal: hut, hp: 10 }).key, 'goal', 'HP 10 без мобов днём — цель');
  assert.strictEqual(decide({ ...base, goal: hut, hp: 6 }).key, 'goal', 'HP 6 без мобов днём, сыта — цель (реген идёт)');
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

  // (1) wait_night with creeper 3m at night -> action, not wait
  const wnCreeper = { ...nightBase, hostilesNear: 1, hostile: { name: 'creeper', d: 3 }, running: { name: 'wait_night', key: 'wait_night', kind: 'body' } };
  const wnAct = D(wnCreeper);
  assert.ok(wnAct && wnAct.key !== 'wait_night', 'wait_night with creeper 3m -> action, not waiting');

  // (2) free body, creeper 6m at night -> action
  const freeCreeper = { ...nightBase, idle: true, task: null, running: null, hostilesNear: 1, hostile: { name: 'creeper', d: 6 } };
  const freeAct = D(freeCreeper);
  assert.ok(freeAct && freeAct.key !== 'wait_night', 'free body with creeper 6m -> action');

  // (3) shelter = open pit (sheltered: false), HP 20, creeper 3m -> action, not waiting
  const openPit = { ...nightBase, sheltered: false, hostilesNear: 1, hostile: { name: 'creeper', d: 3 } };
  const pitAct = D(openPit);
  assert.ok(pitAct && pitAct.key !== 'wait_night', 'open pit with creeper 3m -> action');

  // (4) zero HP / crit without food: waits < 2 min, then triggers emergency action (e.g. explore or go_base) instead of hanging indefinitely
  const zeroHpState = { ...base, hp: 0, hasFood: false, sheltered: true, failInfo: {} };
  assert.strictEqual(D(zeroHpState), null, 'zero HP without food: waits initially (< 2 min)');
  zeroHpState.waitSec = T.apWaitMaxSec + 10; // тело стоит дольше потолка (тик считает waitSince)
  const emergencyAct = D(zeroHpState);
  assert.ok(emergencyAct !== null, 'zero HP without food after > 2 min: does not hang, triggers emergency action');
  // fullhp_wait (2): HP 10 ниже порога? нет — HP 9, еда 4, еды нет: до потолка ждём, после — выживание (охота/база/поиск еды)
  const hungry = { ...base, hp: 9, food: 4, hasFood: false, sheltered: true };
  assert.strictEqual(D({ ...hungry, waitSec: 30 }), null, 'голодна, HP 9 — сначала ждём (меньше потолка)');
  nd = D({ ...hungry, waitSec: T.apWaitMaxSec + 1 });
  assert.ok(nd && /^(hunt|go_base|lowhp_emergency_explore)$/.test(nd.key), 'после потолка — выживание: ' + JSON.stringify(nd));
  assert.strictEqual(D({ ...hungry, animals: 2, waitSec: 0 }).key, 'hunt', 'есть животные — охочусь сразу, не жду');
  // eat_desperate_hp: мало HP, нет регена, съедобное есть — рефлексу даём apEatWaitSec, потом едим сами
  assert.strictEqual(D({ ...base, hp: 3, food: 10, hasFood: true, sheltered: true, waitSec: T.apEatWaitSec + 1 }).key, 'lowhp_eat', 'HP 3, еда есть — ем сам');
  assert.strictEqual(D({ ...base, hp: 3, food: 10, hasFood: true, sheltered: true, waitSec: T.apEatWaitSec + 1 }).params.desperate, true, 'ем и гнилое');

  // ---- behavior_autopilot_lowhp_no_build (заявка учителя): низкий HP + нет еды на регенерацию — только восстановление ----
  console.error('STEP lowhp block start');
  const buildPad = { name: 'base_pad', x: -395, y: 67, z: 34, rot: 0, sig: 'bp' };
  const goalStone = { name: 'collect', params: { block: 'stone', count: 60 }, kind: 'body', sig: 'g' };
  // постройка от мозга при HP<10 и еде<18 не берётся — укрытие, а не «строю base_pad»
  nd = decide({ ...base, hp: 8, food: 10, hasFood: false, blocks: T.apLowHpBlocks, build: buildPad, buildDist: 3 });
  assert.ok(!nd || !/^build/.test(nd.key), 'постройка от мозга при низком HP без еды — не брать: ' + JSON.stringify(nd));
  assert.strictEqual(decide({ ...base, ...mob9, hp: 8, food: 10, hasFood: false, blocks: T.apLowHpBlocks, build: buildPad, buildDist: 3 }).key, 'lowhp_shelter', 'и моб рядом — укрытие');
  // в закрытом укрытии при низком HP без еды — ждём, не выходим на постройку к месту в поле
  assert.strictEqual(decide({ ...base, hp: 8, food: 10, hasFood: false, sheltered: true, build: buildPad, buildDist: 3 }), null, 'в укрытии при низком HP без еды — ждём, не выходим на постройку');
  // сбор (цель мозга) при низком HP без еды — запрет; давление простоя не отменяет запрет
  assert.strictEqual(decide({ ...base, hp: 9, food: 17, hasFood: false, sheltered: true, goal: goalStone }), null, 'сбор при низком HP без еды — запрет');
  assert.strictEqual(decide({ ...base, hp: 9, food: 17, hasFood: false, sheltered: true, goal: goalStone, idleBuildMin: 40 }), null, 'давление простоя не перебивает запрет работы при низком HP без еды');
  // ---- враг-игрок nearby / неудачный побег от игрока — работа запрещена ----
  const enemy = { name: 'Eblanitus228', d: 11, why: 'убивал меня 4 р.', aggressor: true };
  // игрок рядом без оружия — бегство, а не работа
  assert.strictEqual(decide({ ...base, hp: 20, hasWeapon: false, enemies: [enemy] }).key, 'escape_player', 'игрок рядом — бегство, а не работа');
  // после неудачного побега от игрока — сбор/стройка/разведка/рутина не возобновляются
  const afterEscape = { ...base, hp: 20, food: 20, hasWeapon: false, enemies: [enemy], blocked: { escape_player: true }, failInfo: { escape_player: { reason: 'побег не оторвал от врага', count: 2, norm: 'побег не оторвал от врага', t: Date.now() } } };
  const afterEsc = decide(afterEscape);
  if (!(!afterEsc || !/^(build|build_go|build_gather|collect_log|collect_stone|explore|day_routine|goal)$/.test(afterEsc.key))) throw new Error('WORK-TASK-RETURNED: ' + JSON.stringify(afterEsc));
  // с базой далеко — уходим на базу после неудачного побега, а не собираем
  assert.strictEqual(decide({ ...afterEscape, base: { x: -393, y: 67, z: 36, r: 96 }, baseDist: 300 }).key, 'go_base', 'после неудачного побега — уход на базу, а не сбор');
  // в закрытом укрытии при critique HP и игроке рядом — ждём, не выходим на постройку
  assert.strictEqual(decide({ ...base, hp: 2, food: 0, hasFood: false, sheltered: true, enemies: [enemy], build: buildPad, buildDist: 3 }), null, 'укрытие при critique HP и игроке рядом — ждём, не строим');

  // ---- заявки 23.10 (простой страшнее смерти): рефлексы ----
  // fight_nowpn: (1) паук 5 м, HP 20, днём, без оружия — укрытие/отход, не бой; (2) с мечом — бой как раньше; (3) defensePrior без оружия — без fight
  const spider = { id: 4, type: 'hostile', name: 'spider', position: V(5, 64, 0) };
  const nowpnBot = fakeBot({ entities: { 4: spider } });
  let mp = R.mobNearPlan(fakeCtx(nowpnBot), spider, 5);
  assert.ok(mp.skill !== 'fight' && /shelter|escape/.test(mp.skill), 'без оружия паук 5 м — не бой: ' + JSON.stringify(mp));
  const z5 = zombie(5);
  const swordBot = fakeBot({ entities: { 3: z5 }, inventory: { items: () => [{ name: 'iron_sword', count: 1 }], slots: [] } });
  mp = R.mobNearPlan(fakeCtx(swordBot), z5, 5);
  assert.strictEqual(mp.skill, 'fight', 'с мечом против зомби — бой как раньше: ' + JSON.stringify(mp));
  assert.ok(!R.defensePrior(fakeCtx(fakeBot({ entities: { 3: z5 } })), z5).includes('fight'), 'defensePrior без оружия — без fight');
  // escape_skeleton_lowhp: HP < 10, скелет в 12 м — побег сразу (не ждём 6 м), стиль чередуется; HP 20 — правила нет
  const skel = { id: 5, type: 'hostile', name: 'skeleton', position: V(12, 64, 0) };
  const skCtx = fakeCtx(fakeBot({ health: 6, entities: { 5: skel } }));
  const rp1 = R.rangedLowHpPlan(skCtx, [skel]), rp2 = R.rangedLowHpPlan(skCtx, [skel]);
  assert.ok(rp1 && rp2 && rp1.params.style !== rp2.params.style, 'стрелок при HP 6 — побег, второй раз другим стилем: ' + JSON.stringify([rp1, rp2]));
  assert.ok(!/escape_to_base/.test(rp1.params.style), 'не escape_to_base');
  assert.strictEqual(R.rangedLowHpPlan(fakeCtx(fakeBot({ health: 20, entities: { 5: skel } })), [skel]), null, 'HP 20 — правила нет');
  // mob_near (автопилот): (1) ночь, идёт wait_night, крипер 5 м, в укрытии, без оружия — защита, не null; (2) крипер 15 м — ждём дальше
  const wnC = { ...nz, hasWeapon: false, sheltered: true, running: { name: 'wait_night', key: 'wait_night', kind: 'body' }, task: { name: 'wait_night', source: 'autopilot' } };
  nd = decide({ ...wnC, hostilesNear: 1, hostile: { name: 'creeper', d: 5 } });
  assert.ok(nd && nd.key !== 'wait_night' && nd.preempt, 'крипер 5 м при wait_night — защита: ' + JSON.stringify(nd));
  assert.strictEqual(decide({ ...wnC, hostilesNear: 0, hostile: null }), null, 'крипер 15 м (вне hostileR) — wait_night продолжается');
  // collect_dusk: идущий сбор и моб ближе safetyWorkDist — бросаем дело (preempt), с причиной
  nd = decide({ ...base, running: { key: 'collect_stone', name: 'collect', kind: 'body' }, task: { name: 'collect', source: 'autopilot' }, hostilesNear: 1, hostile: { name: 'zombie', d: 4 } });
  assert.ok(nd && /^safety_/.test(nd.key) && nd.preempt && /бросаю/.test(nd.why), 'моб у сбора — бросаю сбор: ' + JSON.stringify(nd));
  assert.strictEqual(decide({ ...base, running: { key: 'collect_stone', name: 'collect', kind: 'body' }, task: { name: 'collect', source: 'autopilot' }, hostilesNear: 1, hostile: { name: 'zombie', d: 9 } }), null, 'моб далеко — сбор идёт');
  assert.ok(decide({ ...base, cobble: 0, crashed: { day_routine: {} } }).params.radius <= 48, 'сбор камня — всегда с пределом радиуса');
  // build_gather: прерванный добор — продолжаю (без паузы); пустой — сначала к постройке, потом пауза
  const apG = { build: { name: 'hut', x: 0, y: 64, z: 0, rot: 0, sig: 'G' }, buildSt: NBS('G') };
  apG.buildSt.need = { cobblestone: 20 };
  let rg = BA(apG, { key: 'build_gather', sig: 'G' }, 'провал', 'вытеснен рефлексом', null, now2, false);
  assert.ok(rg.resume && /прерван.*продолжаю/.test(rg.note) && apG.buildSt.need && !apG.buildSt.pauseUntil, 'прерван — продолжаю: ' + rg.note);
  rg = BA(apG, { key: 'build_gather', sig: 'G' }, 'провал', 'не добрал: cobblestone x20', { collected: {}, crafted: {}, have: { cobblestone: 0 } }, now2, false);
  assert.ok(/меняю место/.test(rg.note) && !apG.buildSt.pauseUntil, 'пусто — меняю место: ' + rg.note);
  nd = decide({ ...base, ...BS(apG, now2), buildDist: 150 });
  assert.strictEqual(nd.key, 'build_go', 'материала тут нет — иду к постройке');
  rg = BA(apG, { key: 'build_gather', sig: 'G' }, 'провал', 'не добрал: cobblestone x20', { collected: {}, crafted: {}, have: { cobblestone: 0 } }, now2, false);
  assert.ok(apG.buildSt.pauseUntil > now2 && /материала нет/.test(rg.note), 'и там пусто — честная пауза: ' + rg.note);
  rg = BA({ build: apG.build, buildSt: Object.assign(NBS('G'), { need: { cobblestone: 20 } }) }, { key: 'build_gather', sig: 'G' }, 'ok', null, { collected: { cobblestone: 5 }, crafted: {}, have: { cobblestone: 5 } }, now2, true);
  assert.ok(/ещё не хватает/.test(rg.note), 'ок, но не всё — добираю дальше, не «строю снова»: ' + rg.note);
  // explore: после «спуск на N ур.» — ближе, и не по кругу
  const drop = { explore: { reason: 'разведка: спуск на 9 ур. в С — внизу обрыв/пещера, дальше не иду', count: 1 } };
  nd = decide({ ...noWork, failInfo: drop });
  assert.ok(nd.key === 'explore' && nd.params.distance < T.exploreDist, 'после спуска — разведка ближе: ' + JSON.stringify(nd));
  assert.notStrictEqual((decide({ ...noWork, failInfo: { explore: { ...drop.explore, count: T.failSameCount } } }) || {}).key, 'explore', 'спуск дважды — туда не разведываю');
  // потолок ожидания: дел нет дольше apWaitMaxSec — шаг, а не ещё ожидание
  const nothing = { ...noWork, failInfo: { explore: { ...drop.explore, count: T.failSameCount } } };
  assert.strictEqual(decide({ ...nothing, waitSec: 10 }), null, 'дел нет — пока ждём');
  assert.strictEqual(decide({ ...nothing, waitSec: T.apWaitMaxSec + 1 }).key, 'idle_move', 'дольше потолка — меняю место');
  // eat_desperate_hp: ранена — гнилое мясо в ход (рефлекс), автопилот видит его как еду
  assert.strictEqual(R.pickFood({ ...bot2, health: 8 }, { desperate: true }).name, 'rotten_flesh');

  return { ok: true };
};
