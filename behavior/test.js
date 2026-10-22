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
  // пауза после побега: оторвались — минута, не оторвались — 5 минут
  assert.strictEqual(escapePause('lowhp_escape', true), T.apEscapeCooldownMs);
  assert.strictEqual(escapePause('lowhp_escape', false), T.apEscapeFailPauseMs);
  assert.ok(T.apEscapeFailPauseMs > T.apEscapeCooldownMs, 'неудачный побег — пауза длиннее');
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
  // пауза после провала: у ВЫУЧЕННОГО навыка — как у команд тела (та же причина — длиннее), а не ровно 60 с
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', false, 1, 1), 4000, 'первый провал — короткая пауза');
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', true, 2, 2), Math.min(T.backoffMs * 2, T.failSameMaxMs));
  assert.ok(failPause('learned', 'не нашёл log в радиусе 48', true, 2, 2) > T.backoffMs, 'та же причина — пауза длиннее 60 с');
  assert.strictEqual(failPause('learned', 'не нашёл log в радиусе 48', false, 1, T.failMax), T.backoffMs, 'третий провал — минута');
  assert.strictEqual(failPause('learned', 'навык "build_hut" выключен: авто: 3 провала подряд', false, 1, 1), 600000, 'выключенный навык — 10 мин');
  assert.strictEqual(failPause('body', 'не нашёл log', true, 2, 2), Math.min(T.backoffMs * 2, T.failSameMaxMs), 'у команд тела — как было');
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
  // протухший сбой кода забываем (навык можно снова)
  const apc = { codeCrash: { build_hut: { reason: 'x.js:1', at: Date.now() - 1000 }, old: { reason: 'y.js:2', at: Date.now() - (T.apCodeCrashSkipMs + 1000) } } };
  const cl = crashList(apc, Date.now());
  assert.ok(cl.build_hut, 'свежий сбой кода в списке');
  assert.ok(!cl.old, 'протухший сбой кода забыт');
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
  return { ok: true };
};
