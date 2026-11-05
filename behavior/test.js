// Офлайн-проверка поведения (без бота и сервера): ядро зовёт её перед включением новой версии (selfTest).
// Должна быть быстрой (< 15 с) и бросать исключение, если что-то не так.
'use strict';
const assert = require('assert');
const { decide: decideAny, escapePause, yieldPlan, isBrainYield, verdictOf, brainHoldsBody, failPause, isCodeCrash, crashList } = require('./autopilot');
const R = require('./reflexes');
const T = require('./thresholds');
// этап 2 (HC_STAGE2 на стенде) меняет выбор (ночной туннель — hc_night_mine); здесь проверяется обычный автопилот, этап 2 — в test/hardcore_*.js
const decide = (...a) => { const s2 = process.env.HC_STAGE2; delete process.env.HC_STAGE2; try { return decideAny(...a); } finally { if (s2 !== undefined) process.env.HC_STAGE2 = s2; } };

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
  // в воде укрытие не встаёт (стенам не к чему прислониться: разбор 2-го мира этапа 2, 33 провала подряд) — плывём к суше
  a = decide({ ...base, ...mob9, hp: 5, blocks: T.apLowHpBlocks, inWater: true });
  assert.strictEqual(a.key, 'lowhp_move', 'в воде — к суше, а не укрытие'); assert.strictEqual(a.params.distance, T.apLowHpWaterDist);
  a = decide({ ...base, ...mob9, hp: 5, blocks: 0, inWater: true });
  assert.strictEqual(a.key, 'lowhp_move', 'в воде и блоков нет — тоже к суше');
  // v0.3 еда: еле жива, есть нечего, регенерации нет — днём без угрозы ждать бесполезно: за едой (раньше — null, «жду» часами)
  assert.strictEqual(decide({ ...base, hp: 2, food: 0, hasFood: false, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } }).key, 'food_explore');
  // ...ночью без ближней еды — по-прежнему ждём (укрыться нечем), в поле ночью не идём
  assert.strictEqual(decide({ ...base, isNight: true, phase: 'ночь', nightIn: 0, hp: 2, food: 0, hasFood: false, blocks: 0, failInfo: { lowhp_dirt: { reason: 'не вижу dirt', count: 2 } } }), null);
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
  // оружие есть, но при низком HP — приоритетный побег, а не бой
  const armed = fakeBot({ health: 5, entities: { 3: zClose }, inventory: { items: () => [{ name: 'stone_sword' }], slots: [] } });
  const optsArmed = R.defensePrior(fakeCtx(armed), zClose);
  assert.ok(optsArmed.includes('escape') && !optsArmed.includes('fight') && !optsArmed.includes('shelter'), 'оружие есть, но при низком HP — побег вместо боя');
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
  assert.strictEqual(decide({ ...base, crashed: { day_routine: { reason: 'x.js:1', at: Date.now() } } }).key, 'explore', 'упавший навык не повторяем');
  const nz = { ...base, phase: 'ночь', isNight: true, nightIn: 0, sheltered: true, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } };
  assert.strictEqual(decide(nz).key, 'wait_night', 'ночью без упавшего навыка — пережидаем');
  // behavior_autopilot_wait_night_idle: на открытой местности без укрытия автопилот выбирает укрытие (night_shelter_dig), а не wait_night
  const nightOpen = { ...nz, sheltered: false, base: null, baseDist: null, hostilesNear: 0, hostile: null, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } };
  const openAct = decide(nightOpen);
  assert.strictEqual(openAct.key, 'night_shelter_dig', 'на открытой местности ночью — укрытие, а не стояние в wait_night');

  // если укрытие заблокировано, wait_night имеет короткий max_sec и низкий счёт
  const nightOpenBlocked = { ...nightOpen, blocked: { night_shelter_dig: true, night_shelter: true } };
  const wnOpen = decide(nightOpenBlocked);
  assert.strictEqual(wnOpen.key, 'wait_night');
  assert.ok(wnOpen.params.max_sec <= 30, 'на открытой местности max_sec короткий: ' + wnOpen.params.max_sec);
  assert.ok(wnOpen.score <= 5, 'на открытой местности счёт wait_night низкий: ' + wnOpen.score);

  const nightSheltered = { ...nz, sheltered: true, hostilesNear: 0, hostile: null, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } };
  const wnSheltered = decide(nightSheltered);
  assert.strictEqual(wnSheltered.key, 'wait_night');
  assert.strictEqual(wnSheltered.params.max_sec, T.waitNightSec, 'в укрытии max_sec полный');
  // сбой кода (В): не 30 минут — запись живёт, пока файл навыка тот же; поменялся файл — пробуем снова
  const apc = { codeCrash: { build_hut: { reason: 'x.js:1', at: Date.now() - 1000, mtime: 111 }, fixed: { reason: 'y.js:2', at: Date.now() - 1000, mtime: 111 } } };
  const cl = crashList(apc, Date.now(), n => (n === 'fixed' ? 222 : 111));
  assert.ok(cl.build_hut, 'файл тот же — сбой кода в списке');
  assert.ok(!cl.fixed && !apc.codeCrash.fixed, 'файл поменялся — сбой забыт, навык снова можно');
  assert.strictEqual(T.apCodeCrashSkipMs, undefined, 'тридцатиминутной паузы больше нет');
  const nz2 = { ...base, phase: 'ночь', isNight: true, nightIn: 0, sheltered: true };
  // мобов нет и ударов нет — пережидаем ночь (как было; night_mine отключен, чтобы дойти до wait_night)
  assert.strictEqual(decide({ ...nz2, crashed: { night_mine: { reason: 'x.js:1', at: Date.now() } } }).key, 'wait_night', 'ночь чиста — пережидаем');
  // моб рядом ночью — wait_night не берём: бой/стены/отход
  let nd = decide({ ...nz2, hostilesNear: 1, hostile: { name: 'zombie', d: 9.7 } });
  assert.ok(nd && nd.key !== 'wait_night', 'моб рядом ночью — не wait_night');
  assert.notStrictEqual(nd.key, 'night_shelter_dig', 'яму при мобе не копаем');
  assert.strictEqual(decide({ ...nz2, sheltered: false, hasWeapon: false, hostilesNear: 1, hostile: { name: 'zombie', d: 9.7 } }).params.mode, 'walls', 'рядом моб, без оружия — укрытие стенами, не яма: копка 3-4 с, зомби успевает влезть (9.7 → 2.7 м)');
  // с оружием и HP в норме — отбиваемся; а начавшийся wait_night прерываем (не молча держим)
  nd = decide({ ...nz2, hostilesNear: 1, hostile: { name: 'zombie', d: 0.3 }, running: { name: 'wait_night', key: 'wait_night', kind: 'body' } });
  assert.strictEqual(nd.key, 'night_fight', 'оружие есть — отбиваемся от зомби');
  assert.strictEqual(nd.params.target, 'zombie', 'цель — моб');
  assert.strictEqual(nd.preempt, true, 'wait_night прерываем — тело отдаём защите');
  // без оружия и моб вплотную уже бил — стены не успеть: отходим
  nd = decide({ ...nz2, sheltered: false, hasWeapon: false, hitRecent: true, hostilesNear: 1, hostile: { name: 'zombie', d: 0.8 } });
  assert.strictEqual(nd.key, 'night_escape', 'враг вплотную и по муху били — отход (L052: та же смерть 23)');
  // по муху били, даже моба не видно (strея издалека) — wait_night отменяется
  nd = decide({ ...nz2, hitRecent: true, hostilesNear: 0, hostile: null });
  assert.ok(nd && nd.key !== 'wait_night', 'свежие удары — не wait_night');
  assert.strictEqual(nd.key, 'night_escape', 'в укрытии, но по муху били — выхожу и отхожу');
  // behavior_reflexes_shelter_no_mobs: мобов нет — укрытие не дело: работа ночью (туннель), а не яма
  nd = decide({ ...nz2, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true });
  assert.ok(nd && !/^night_shelter|^wait_night$/.test(nd.key), 'мобов нет — не закапываюсь: ' + JSON.stringify(nd));
  // дел нет совсем (туннель упал, камня хватает) — яма как запасной вариант остаётся
  assert.strictEqual(decide({ ...nz2, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true, crashed: { night_mine: {} } }).key, 'night_shelter_dig', 'дел нет — закапываюсь');
  // HP низкий ночью — укрытие по-прежнему выше работы
  assert.strictEqual(decide({ ...nz2, hp: 8, sheltered: false, hostilesNear: 0, hostile: null, hasPickaxe: true }).key, 'lowhp_shelter', 'мало HP ночью — укрываюсь');
  // все варианты защиты на паузе — не берём ни яму, ни ночную работу, ни wait_night
  assert.strictEqual(decide({ ...nz2, hostilesNear: 1, hostile: { name: 'zombie', d: 7.2 }, blocked: { night_fight: true, night_shelter: true, night_escape: true } }), null, 'защита на паузе — ничего не начинаем');
  // в закрытом укрытии ударов нет — без оружия ждём моба в укрытии (не вместо wait_night — журнальная строка в тике)
  nd = decide({ ...nz2, hasWeapon: false, hostilesNear: 1, hostile: { name: 'zombie', d: 5 } });
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
  // ---- v0.3 стройка шагами: цель добора — что есть + шаг (buildStepItems), не «итог 101» ----
  const { lackOf: LO, buildState: BS, buildAfter: BA, newBuildSt: NBS } = require('./autopilot');
  const now2 = 1e9;
  // build_blueprint вернул missing=37, have=64 → ставлю 64 частью, добор до 64+20
  const bpResult = { missing: { cobblestone: 37 }, have: { cobblestone: 64 }, need: { cobblestone: 101 } };
  const apBuild = { build: { name: 'hut_west', x: 0, y: 64, z: 0, rot: 0, sig: 'S' }, buildSt: NBS('S') };
  let r2 = BA(apBuild, { key: 'build', sig: 'S' }, 'провал', 'не хватает: cobblestone ×37', bpResult, now2, false);
  const stepTo = 64 + Math.min(37, T.buildStepItems);
  assert.ok(r2 && /ставлю частью/.test(r2.note) && r2.note.includes('cobblestone ×' + stepTo), 'добор шагом: ' + r2.note);
  assert.deepStrictEqual(apBuild.buildSt.need, { cobblestone: stepTo }, 'st.need = есть + шаг');
  assert.deepStrictEqual(BS(apBuild, now2).build.have, { cobblestone: 64 }, 'сумка запомнена для decide');
  // пустой добор (ok, но collected/crafted пусты) → пауза с причиной, need не сбрасывается
  r2 = BA(apBuild, { key: 'build_gather', sig: 'S' }, 'ok', null, { ok: true, collected: {}, crafted: {}, have: { cobblestone: 64 } }, now2, false);
  assert.ok(/добор ничего не дал/.test(r2.note), 'пустой добор → пауза с причиной: ' + r2.note);
  assert.deepStrictEqual(apBuild.buildSt.need, { cobblestone: stepTo }, 'need не сброшен после пустого добора');
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
  // v0.3 еда: регенерации нет (сытость < 18) — ждать нечего, сразу за едой (днём — в поле), не «жду 120 с»
  assert.strictEqual((D({ ...hungry, waitSec: 30 }) || {}).key, 'food_explore', 'голодна, HP 9, еды нет — сразу за едой, не ждём');
  nd = D({ ...hungry, waitSec: T.apWaitMaxSec + 1 });
  assert.ok(nd && /^(hunt|go_base|lowhp_emergency_explore|food_explore)$/.test(nd.key), 'после потолка — выживание: ' + JSON.stringify(nd));
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
  // v0.3 еда: и не ждём (регенерации нет) — выходим за едой, но не на постройку
  assert.strictEqual((decide({ ...base, hp: 8, food: 10, hasFood: false, sheltered: true, build: buildPad, buildDist: 3 }) || {}).key, 'food_explore', 'в укрытии при низком HP без еды — за едой, не на постройку');
  // сбор (цель мозга) при низком HP без еды — запрет; давление простоя не отменяет запрет
  assert.strictEqual((decide({ ...base, hp: 9, food: 17, hasFood: false, sheltered: true, goal: goalStone }) || {}).key, 'food_explore', 'сбор при низком HP без еды — запрет (за едой)');
  assert.strictEqual((decide({ ...base, hp: 9, food: 17, hasFood: false, sheltered: true, goal: goalStone, idleBuildMin: 40 }) || {}).key, 'food_explore', 'давление простоя не перебивает запрет работы при низком HP без еды');
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
  await foodStage1();
  await toolStage2();
  await foodStage2();
  await lowHpStage();
  await nightStage6();

  return { ok: true };
};

// ---- v0.4 «еда и ночь» (этап 2): подъём, запас еды к закату, низкий HP, смерть вдали от базы ----
async function lowHpStage() {
  const AP = require('./autopilot');
  const day = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, foodUnits: 8 };
  const night = { isNight: true, phase: 'ночь', nightIn: 0 };
  const base = { x: 0, y: 64, z: 0, r: 16 };
  let a;
  // ---- 2.1 подъём ----
  const under = { ...day, hp: 9, food: 16, hasFood: false, foodUnits: 0, underground: true, surfaceY: 64, pos: { x: 5, y: 30, z: 7 } };
  assert.strictEqual(decide(under).key, 'surface', 'HP 9 >= surfaceMinHp — climb_up');
  assert.strictEqual(decide(under).name, 'climb_up');
  a = decide({ ...under, hp: T.surfaceMinHp - 1 });
  assert.ok(a && a.key === 'surface_stairs' && a.name === 'climb_stairs', 'HP < surfaceMinHp — climb_up не зовём, сразу climb_stairs: ' + JSON.stringify(a));
  const ceil = { surface_stairs: { count: 1, reason: 'потолок над головой' } };
  a = decide({ ...under, hp: 5, failInfo: ceil });
  assert.ok(a && a.key === 'surface_dig' && a.name === 'dig_at' && a.params.x === 5 && a.params.y === 32 && a.params.z === 7, 'потолок — копаю вверх: ' + JSON.stringify(a));
  a = decide({ ...under, hp: 5, failInfo: { surface_stairs: { count: T.failSameCount, reason: 'потолок над головой' } } });
  assert.notStrictEqual((a || {}).key, 'surface_dig', 'потолок раз за разом — копать не бесконечно');
  assert.notStrictEqual((decide({ ...under, hp: 5, failInfo: ceil, blocked: { surface_dig: true } }) || {}).key, 'surface_dig', 'пауза surface_dig');
  assert.notStrictEqual((decide({ ...under, hp: 5, failInfo: { surface_stairs: { count: 1, reason: 'не вижу пути' } } }) || {}).key, 'surface_dig', 'не потолок — не копаем');
  // два одинаковых провала surface_* — пауза surfacePauseMs
  const ctx = { events: { push() {} }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap = AP.create(ctx);
  let res = { ok: true };
  ctx.runSkill = async () => res;
  const go = async (key, params, r, name) => { res = r; ap._start({ key, kind: 'body', name: name || 'x', params, why: 't' }); await ap.running.promise; };
  await go('surface_stairs', { target_y: 64 }, { ok: false, error: 'потолок над головой' }, 'climb_stairs');
  assert.ok(!((ap.until.surface_stairs || 0) > Date.now() + T.surfacePauseMs - 5000), 'один провал — длинной паузы нет');
  await go('surface_stairs', { target_y: 64 }, { ok: false, error: 'потолок над головой' }, 'climb_stairs');
  assert.ok(ap.until.surface_stairs > Date.now() + T.surfacePauseMs - 5000, 'второй такой же провал — пауза 10 мин: ' + (ap.until.surface_stairs - Date.now()));
  // ---- 2.2 запас еды к закату ----
  const near = { base, baseDist: 10 };
  const dusk = { ...day, ...near, foodUnits: 1, animals: 2, nightIn: T.foodStockDuskSec - 20 };
  const early = { ...dusk, nightIn: T.foodStockDuskSec + 200 };
  const hd = decide(dusk), he = decide(early);
  assert.ok(hd && hd.key === 'hunt_stock', 'закат, запас мал — охота впрок: ' + JSON.stringify(hd));
  assert.strictEqual(hd.score - he.score, 18 + T.huntStockDuskBonus, 'закат: приоритет охоты выше на duskFood + bonus');
  assert.ok(hd.params.radius <= T.huntStockBaseDist - 10, 'радиус охоты урезан остатком до 64 м от базы: ' + hd.params.radius);
  assert.notStrictEqual((decide({ ...dusk, baseDist: T.huntStockBaseDist + 10 }) || {}).key, 'hunt_stock', 'база дальше 64 м — на охоту не ухожу');
  a = decide({ ...dusk, animals: 0, animalSpot: { x: 100, y: 64, z: 0, d: 100, ago: 3, n: 2 } });
  assert.notStrictEqual((a || {}).key, 'food_spot', 'место с животными дальше 64 м от базы — не иду');
  const cookS = decide({ ...dusk, animals: 0, rawFood: { name: 'beef', count: 2 }, fuel: true, furnaceNear: true });
  const cookE = decide({ ...early, animals: 0, rawFood: { name: 'beef', count: 2 }, fuel: true, furnaceNear: true });
  assert.ok(cookS && cookS.key === 'cook', 'закат: жарка впрок: ' + JSON.stringify(cookS));
  assert.strictEqual(cookS.score - cookE.score, 6 + T.huntStockDuskBonus, 'жарка получает huntStockDuskBonus');
  // ---- 2.4 низкий HP: протокол ----
  const low = { ...day, ...night, hp: 5, food: 14, hasFood: false, foodUnits: 0, hasPickaxe: true };
  a = decide({ ...low, animals: 1, animalD: 10 });
  assert.ok(a && a.key === 'hunt' && a.params.radius === T.nightLeash, 'ночью HP<=6, еды нет, животное в 10 м — охота в пределах поводка: ' + JSON.stringify(a));
  a = decide({ ...low, animals: 1, animalD: T.nightLeash + 6 });
  assert.notStrictEqual((a || {}).key, 'hunt', 'животное дальше 16 м — ночью не идём');
  a = decide(low);
  assert.ok(!a || (a.key !== 'night_mine' && a.key !== 'explore' && a.key !== 'food_explore' && a.key !== 'food_spot'), 'HP 5 без еды ночью — ни туннеля, ни разведки: ' + JSON.stringify(a));
  a = decide({ ...low, blocks: 1 });
  assert.ok(a && (a.key === 'night_dirt' || a.key === 'lowhp_dirt') && a.params.radius === T.nightLeash, 'HP 5, блоков нет — землю только рядом: ' + JSON.stringify(a));
  // меч в руку перед защитой / боем
  a = decide({ ...day, handArmed: false, hasWeapon: true, hostilesNear: 1, hostile: { name: 'zombie', d: 6 } });
  assert.ok(a && a.key === 'equip_weapon' && a.name === 'equip_best', 'угроза, в руке не оружие — меч в руку: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...day, handArmed: true, hasWeapon: true, hostilesNear: 1, hostile: { name: 'zombie', d: 6 } }) || {}).key, 'equip_weapon', 'меч уже в руке');
  assert.notStrictEqual((decide({ ...day, handArmed: false, hasWeapon: false, hostilesNear: 1, hostile: { name: 'zombie', d: 6 } }) || {}).key, 'equip_weapon', 'оружия нет — брать нечего');
  assert.notStrictEqual((decide({ ...day, handArmed: false, hasWeapon: true }) || {}).key, 'equip_weapon', 'угрозы нет — меч не нужен');
  // побег от этого моба не оторвался — сразу укрытие
  const work = { name: 'explore', key: 'explore', kind: 'body' };
  const zomb = { hostilesNear: 1, hostile: { name: 'zombie', d: 5 }, hasWeapon: false, running: work };
  a = decide({ ...day, ...zomb });
  assert.ok(a && a.key === 'safety_escape', 'контроль: без памяти — обычный отход: ' + JSON.stringify(a));
  a = decide({ ...day, ...zomb, escapeFailed: { zombie: true } });
  assert.ok(a && a.key === 'safety_shelter' && a.name === 'shelter', 'побег от зомби не оторвался — укрытие: ' + JSON.stringify(a));
  a = decide({ ...day, ...zomb, hostile: { name: 'skeleton', d: 5 }, escapeFailed: { zombie: true } });
  assert.strictEqual((a || {}).key, 'safety_escape', 'память про зомби к скелету не относится');
  // запас блоков на укрытие
  a = decide({ ...day, blocks: 3, cobble: 99 });
  assert.ok(a && (a.others || []).some(x => /^reserve_dirt /.test(x)), 'резерв в списке кандидатов (низкий счёт): ' + JSON.stringify(a));
  a = decide({ ...day, blocks: 3, cobble: 99, blocked: { day_routine: true } });
  assert.ok(a && a.key === 'reserve_dirt' && a.name === 'collect' && a.params.block === 'dirt', 'блоков меньше 8 — днём добираю землю: ' + JSON.stringify(a));
  assert.ok(T.reserveScore < 35, 'резерв — ниже рутины');
  assert.notStrictEqual((decide({ ...day, blocks: T.shelterReserve }) || {}).key, 'reserve_dirt', 'резерв есть');
  assert.notStrictEqual((decide({ ...day, blocks: 3, nightIn: 60 }) || {}).key, 'reserve_dirt', 'к закату — не время');
  assert.notStrictEqual((decide({ ...day, blocks: 3, blocked: { reserve_dirt: true } }) || {}).key, 'reserve_dirt', 'пауза reserve_dirt');
  // рефлексы: fled:false помним по виду моба
  const rctx = { escapeFail: null };
  assert.strictEqual(R.escapeFailed(rctx, 'zombie'), false);
  R.noteEscapeFail(rctx, 'zombie');
  assert.strictEqual(R.escapeFailed(rctx, 'zombie'), true, 'помним провал побега');
  assert.strictEqual(R.escapeFailed(rctx, 'spider'), false, 'другой вид моба — не помним');
  rctx.escapeFail.zombie = Date.now() - T.escapeFailMemMs - 1000;
  assert.strictEqual(R.escapeFailed(rctx, 'zombie'), false, 'забываем через escapeFailMemMs');
  // scanEscapes: task_done с fled:false -> метка; fled:true -> нет
  const sctx = { escapeWatch: [{ taskId: 11, mob: 'zombie', t: Date.now() }, { taskId: 12, mob: 'spider', t: Date.now() }, { taskId: 13, mob: 'husk', t: Date.now() }],
    events: { buf: [{ type: 'task_done', taskId: 11, result: { fled: false } }, { type: 'task_done', taskId: 12, result: { fled: true } }] } };
  R.scanEscapes(sctx);
  assert.strictEqual(R.escapeFailed(sctx, 'zombie'), true, 'fled:false — запомнено');
  assert.strictEqual(R.escapeFailed(sctx, 'spider'), false, 'fled:true — не запоминаем');
  assert.deepStrictEqual(sctx.escapeWatch.map(w => w.taskId), [13], 'итог неизвестен — ещё ждём');
  // защита: после fled:false вместо побега — укрытие (удар и приближение)
  const V = (x, y, z) => ({ x, y, z, offset: (dx, dy, dz) => V(x + dx, y + dy, z + dz), plus: o => V(x + o.x, y + o.y, z + o.z),
    distanceTo: o => Math.hypot(x - o.x, y - o.y, z - o.z), floored: () => V(Math.floor(x), Math.floor(y), Math.floor(z)) });
  const mk = (o = {}) => ({ health: 5, food: 20, time: { timeOfDay: 1000, day: 1 }, registry: { foodsByName: {} }, inventory: { items: () => [], slots: [] },
    entity: { position: V(0, 64, 0) }, blockAt: () => ({ name: 'air' }), entities: {}, ...o });
  const mkCtx = (bot, o = {}) => ({ bot, tasks: { current: null }, exp: { stats: {}, recent: [], pending: [], log: [] }, expRand: () => 1, ...o });
  const zFar = { id: 3, type: 'hostile', name: 'zombie', position: V(6, 64, 0) };
  const c0 = mkCtx(mk({ entities: { 3: zFar } }));
  const p0 = R.mobNearPlan(c0, zFar, 6);
  assert.ok(p0 && p0.skill === 'escape', 'контроль: без памяти HP 5 — побег: ' + JSON.stringify(p0));
  const c1 = mkCtx(mk({ entities: { 3: zFar } })); R.noteEscapeFail(c1, 'zombie');
  const p1 = R.mobNearPlan(c1, zFar, 6);
  assert.ok(p1 && p1.skill === 'shelter' && p1.mob === 'zombie', 'после fled:false — сразу укрытие: ' + JSON.stringify(p1));
  const h1 = R.mobHurtPlan(c1, zFar);
  assert.strictEqual(h1.skill, 'shelter', 'удар издали после fled:false — укрытие: ' + JSON.stringify(h1));
  assert.strictEqual(R.mobHurtPlan(c0, zFar).mob, 'zombie', 'план защиты помнит моба (для учёта итога побега)');
  // startDefense: оружие в сумке, в руке не оружие — equip до запуска навыка
  const eq = []; const sword = { name: 'stone_sword', count: 1, type: 1 };
  const ebot = mk({ health: 18, heldItem: { name: 'pointed_dripstone', type: 2 }, inventory: { items: () => [sword], slots: [] },
    equip: async (it) => { eq.push(it.name); ebot.heldItem = it; } });
  const order = [];
  const ectx = { bot: ebot, events: { push() {} }, tasks: { current: null, legacyBusy: 0, legacy: null, stop: async () => {} },
    runSkill: async () => { order.push('skill:' + (eq.length ? 'armed' : 'unarmed')); return { ok: true, taskId: 77 }; } };
  await R.startDefense(ectx, { skill: 'escape', params: {}, why: 'тест', options: ['escape'], mob: 'zombie' });
  assert.deepStrictEqual(eq, ['stone_sword'], 'меч взят в руку перед защитой');
  assert.deepStrictEqual(order, ['skill:armed'], 'навык запущен уже с мечом');
  assert.deepStrictEqual(ectx.escapeWatch.map(w => [w.taskId, w.mob]), [[77, 'zombie']], 'побег поставлен на учёт итога');
  // ---- 2.5 после смерти ----
  const w0 = { x: -62, y: 64, z: 27 }, wb = { x: -393, y: 67, z: 36, r: 16 };
  let w = AP.nextWaypoint(w0, wb);
  assert.ok(w && w.i === 0 && w.x === -226 && w.z === 67, 'от спавна — к первой точке дна каньона: ' + JSON.stringify(w));
  w = AP.nextWaypoint({ x: -226, y: 67, z: 67 }, wb);
  assert.ok(w && w.i === 1 && w.x === -302 && w.z === 51, 'у первой точки — ко второй: ' + JSON.stringify(w));
  assert.strictEqual(AP.nextWaypoint({ x: -302, y: 67, z: 51 }, wb), null, 'у второй — дальше прямо на базу');
  assert.strictEqual(AP.nextWaypoint(w0, { x: 100, y: 64, z: 100, r: 16 }), null, 'база не там — маршрут не применяем');
  assert.strictEqual(AP.nextWaypoint(null, wb), null);
  const far = { ...day, base: wb, baseDist: 340, pos: w0, afterDeath: true };
  a = decide(far);
  assert.ok(a && a.key === 'go_base' && a.params.x === -226 && a.params.z === 67 && a.params.r === T.wpNearDist, 'днём после смерти — по дну каньона, к точке 1: ' + JSON.stringify(a));
  a = decide({ ...far, pos: { x: -226, y: 67, z: 67 }, baseDist: 170 });
  assert.ok(a && a.key === 'go_base' && a.params.x === -302 && a.params.z === 51, 'потом точка 2: ' + JSON.stringify(a));
  a = decide({ ...far, pos: { x: -302, y: 67, z: 51 }, baseDist: 100 });
  assert.ok(a && a.key === 'go_base' && a.params.x === wb.x && a.params.z === wb.z, 'у последней точки — на базу: ' + JSON.stringify(a));
  // ночью, возродилась далеко — укрытие до утра, не домой и не туннель
  const nfar = { ...far, ...night, hp: 20 };
  a = decide(nfar);
  assert.ok(a && a.key !== 'go_base' && a.key !== 'night_mine', 'ночью вдали от базы после смерти — не иду домой: ' + JSON.stringify(a));
  assert.ok(['night_shelter_dig', 'night_shelter', 'night_dirt', 'wait_night'].includes(a.key), 'укрытие до утра: ' + a.key);
  a = decide({ ...nfar, blocks: 1 });
  assert.ok(a && a.key === 'night_dirt' && a.params.radius === T.nightLeash, 'блоков нет — землю рядом: ' + JSON.stringify(a));
  assert.ok(T.respawnFarDist === 96 && T.nightLeash === 16 && T.lowHpHoldHp === 6, 'пороги этапа 2 на месте');
}


// ---- v0.3 ночь у базы (шаг 6): кровать, точка возрождения, факелы на закате ----
async function nightStage6() {
  const AP = require('./autopilot');
  const day = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, foodUnits: 8 };
  const base = { x: 0, y: 64, z: 0, r: 16 };
  const home = { base, baseDist: 5 };
  const full = { pickaxe: 3, sword: 3, shovel: 3, axe: 3 };                   // инструменты не мешают
  const wood = { ...full, planks: 8, sticks: 0, logs: 0, cobble: 30, table: true };
  const night = { isNight: true, phase: 'ночь', nightIn: 0 };
  const dusk = { phase: 'закат', nightIn: 100 };
  let a;
  // ---- крафт кровати ----
  a = decide({ ...day, tools: wood, wool: 3, woolColor: 'white' });
  assert.ok(a && a.key === 'bed_craft' && a.name === 'craft' && a.params.item === 'white_bed', 'шерсть 3 + доски — крафт кровати: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...day, tools: wood, wool: 5, woolColor: 'red' }).params.item, 'red_bed', 'цвет кровати — цвет шерсти');
  assert.strictEqual(decide({ ...day, tools: { ...wood, planks: 0, logs: 1 }, wool: 3, woolColor: 'white' }).key, 'bed_craft', 'брёвна -> доски');
  assert.notStrictEqual((decide({ ...day, tools: wood, wool: 2, woolColor: 'white' }) || {}).key, 'bed_craft', 'шерсти мало');
  assert.notStrictEqual((decide({ ...day, tools: wood }) || {}).key, 'bed_craft', 'без шерсти — не крафтим');
  assert.notStrictEqual((decide({ ...day, tools: { ...wood, planks: 2 }, wool: 3, woolColor: 'white' }) || {}).key, 'bed_craft', 'досок мало (3)');
  assert.notStrictEqual((decide({ ...day, tools: { ...wood, planks: 5, table: false }, wool: 3, woolColor: 'white' }) || {}).key, 'bed_craft', 'верстака нет: 3 + 4 доски');
  assert.strictEqual(decide({ ...day, tools: { ...wood, planks: 7, table: false }, wool: 3, woolColor: 'white' }).key, 'bed_craft', 'доски на верстак и кровать');
  assert.notStrictEqual((decide({ ...day, tools: wood, wool: 3, woolColor: 'white', bedItem: 1 }) || {}).key, 'bed_craft', 'кровать в сумке уже есть');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, wool: 3, woolColor: 'white', bedHome: { x: 3, y: 64, z: 3 } }) || {}).key, 'bed_craft', 'кровать у базы уже стоит (память)');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, wool: 3, woolColor: 'white', freeBed: true }) || {}).key, 'bed_craft', 'кровать у базы уже видна');
  assert.notStrictEqual((decide({ ...day, tools: wood, wool: 3, woolColor: 'white', blocked: { bed_craft: true } }) || {}).key, 'bed_craft', 'пауза после провала');
  assert.notStrictEqual((decide({ ...day, tools: wood, wool: 3, woolColor: 'white', enemies: [{ name: 'Bob', d: 12, why: 'x', aggressor: false }] }) || {}).key, 'bed_craft', 'враг-игрок рядом — не до кровати');
  // шерсти нет, овцы рядом, день — make_bed (сам стрижёт или бьёт овец); овец нет / закат / навык выключен — нет
  a = decide({ ...day, tools: wood, sheep: 2 });
  assert.ok(a && a.key === 'bed_wool' && a.kind === 'learned' && a.name === 'make_bed' && a.params.max_sec === T.bedWoolSec, 'овцы рядом, шерсти нет — make_bed: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...day, tools: wood, sheep: 0 }) || {}).key, 'bed_wool', 'овец рядом нет');
  assert.notStrictEqual((decide({ ...day, tools: wood, sheep: 2, nightIn: 100 }) || {}).key, 'bed_wool', 'к закату за шерстью не ходим');
  assert.notStrictEqual((decide({ ...day, tools: { ...wood, planks: 1 }, sheep: 2 }) || {}).key, 'bed_wool', 'досок на кровать нет — овец не бьём');
  assert.notStrictEqual((decide({ ...day, tools: wood, sheep: 2, skillOff: { make_bed: 'вручную' } }) || {}).key, 'bed_wool', 'навык выключен — не предлагаем');
  assert.notStrictEqual((decide({ ...day, tools: wood, sheep: 2, bedItem: 1 }) || {}).key, 'bed_wool', 'кровать уже есть');

  // ---- поставить кровать у базы днём ----
  a = decide({ ...day, ...home, tools: wood, bedItem: 1 });
  assert.ok(a && a.key === 'bed_home' && a.kind === 'learned' && a.name === 'bring_bed_home' && a.params.x === 0 && a.params.y === 64 && a.params.z === 0 && a.params.place === 1 && a.params.max_sec === T.bedHomeSec,
    'кровать в сумке, я у базы — ставлю у базы: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...day, base, baseDist: 60, tools: wood, bedItem: 1 }) || {}).key, 'bed_home', 'далеко от базы — сначала на базу');
  assert.notStrictEqual((decide({ ...day, tools: wood, bedItem: 1 }) || {}).key, 'bed_home', 'базы нет — не ставим');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood }) || {}).key, 'bed_home', 'кровати в сумке нет');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, bedItem: 1, bedHome: { x: 3, y: 64, z: 3 } }) || {}).key, 'bed_home', 'у базы уже стоит своя кровать');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, bedItem: 1, skillOff: { bring_bed_home: 'вручную' } }) || {}).key, 'bed_home', 'навык выключен — не предлагаем (ночью sleep поставит сам)');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, bedItem: 1, blocked: { bed_home: true } }) || {}).key, 'bed_home', 'пауза после провала');
  assert.notStrictEqual((decide({ ...day, ...home, tools: wood, bedItem: 1, hostilesNear: 1, hostile: { name: 'zombie', d: 9 } }) || {}).key, 'bed_home', 'моб рядом — не ставлю');
  assert.ok(T.apBedPlace > 50 && T.apBedPlace < 100, 'постановка кровати: выше цели мозга (50), но не выше срочного');

  // ---- ночью у базы: сон раньше ожидания и укрытия ----
  const nhome = { ...day, ...home, ...night, tools: wood };
  a = decide({ ...nhome, bedItem: 1 });
  assert.ok(a && a.key === 'sleep' && a.name === 'sleep' && /сумки/.test(a.why), 'ночью у базы кровать в сумке — сплю (ставит сама): ' + JSON.stringify(a));
  assert.ok(a.others.every(o => !/^wait_night /.test(o) || +o.split(' ')[1] < a.score), 'сон выше ожидания ночи: ' + JSON.stringify(a));
  a = decide({ ...nhome, freeBed: true });
  assert.strictEqual(a.key, 'sleep', 'кровать у базы стоит — сплю');
  assert.strictEqual(a.why, 'сплю в кровати');
  a = decide({ ...nhome, freeBed: true, sheltered: false, hasPickaxe: true });
  assert.ok(a.key === 'sleep' && a.score > 25, 'сон выше укрытия (25)');
  assert.notStrictEqual((decide({ ...nhome }) || {}).key, 'sleep', 'кровати нет — не сплю');
  assert.notStrictEqual((decide({ ...nhome, base, baseDist: 80, bedItem: 1 }) || {}).key, 'sleep', 'кровать в сумке, но я далеко от базы — не ставлю её в поле');
  // угроза рядом — ночная защита, а не сон
  const mob = { hostilesNear: 1, hostile: { name: 'zombie', d: 5 } };
  a = decide({ ...nhome, bedItem: 1, ...mob });
  assert.strictEqual(a.key, 'night_fight', 'зомби рядом — бой, не сон: ' + JSON.stringify(a));
  a = decide({ ...nhome, bedItem: 1, ...mob, hasWeapon: false });
  assert.ok(a.key === 'night_shelter' || a.key === 'night_escape', 'без оружия — стены/отход, не сон: ' + JSON.stringify(a));
  assert.notStrictEqual(decide({ ...nhome, freeBed: true, hitRecent: true, hostile: { name: 'zombie', d: 3 }, hostilesNear: 1 }).key, 'sleep', 'били — не сплю');
  // моб подошёл, пока она спит (sleep идёт) — прерываем сон, защита (как wait_night)
  a = decide({ ...nhome, freeBed: true, running: { key: 'sleep', name: 'sleep', kind: 'body' }, task: { name: 'sleep', source: 'autopilot' }, ...mob });
  assert.ok(a && a.preempt && a.key === 'night_fight', 'моб рядом во сне — просыпаюсь и защищаюсь: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...nhome, freeBed: true, running: { key: 'sleep', name: 'sleep', kind: 'body' }, task: { name: 'sleep', source: 'autopilot' } }), null, 'спит без угрозы — не трогаем');

  // ---- факелы на закате ----
  const lamp = { ...day, ...home, ...dusk, tools: wood };
  a = decide({ ...lamp, torches: 6 });
  assert.ok(a && a.key === 'light_base' && a.kind === 'learned' && a.name === 'light_base' && a.params.x === 0 && a.params.y === 64 && a.params.z === 0
    && a.params.r === 16 && a.params.step === T.lightStep && a.params.max === 6 && a.params.max_sec === T.lightMaxSec, 'закат у базы, факелы есть — расставляю: ' + JSON.stringify(a));
  a = decide({ ...lamp, coal: 3, tools: { ...wood, sticks: 4 } });
  assert.ok(a && a.key === 'light_base' && a.params.max === 4, 'уголь сверх запаса (3-2=1 → 4 факела) — свет из угля: ' + JSON.stringify(a));
  a = decide({ ...lamp, coal: 20, tools: { ...wood, sticks: 40 } });
  assert.ok(a && a.key === 'light_base' && a.params.max === T.lightMax, 'много угля — не больше lightMax: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...lamp, torches: 3, coal: 0 }) || {}).key, 'light_base', 'факелов мало (<4) и угля нет — не зовём');
  assert.notStrictEqual((decide({ ...lamp }) || {}).key, 'light_base', 'без факелов и угля — не зовём');
  assert.notStrictEqual((decide({ ...lamp, coal: 2, tools: { ...wood, sticks: 4 } }) || {}).key, 'light_base', 'последний уголь (запас lightCoalKeep) печи — факелы не делаем');
  assert.notStrictEqual((decide({ ...lamp, coal: 5, tools: { ...wood, planks: 0, sticks: 0 } }) || {}).key, 'light_base', 'уголь есть, а палок/досок нет');
  assert.strictEqual(decide({ ...lamp, coal: 5, tools: { ...wood, planks: 2, sticks: 0 } }).key, 'light_base', 'палки из досок (2 доски → 4 палки)');
  assert.notStrictEqual((decide({ ...day, ...home, nightIn: 400, torches: 6, tools: wood }) || {}).key, 'light_base', 'до ночи далеко — рано');
  assert.notStrictEqual((decide({ ...lamp, base, baseDist: 60, torches: 6 }) || {}).key, 'light_base', 'не у базы — свет не ставим');
  assert.notStrictEqual((decide({ ...lamp, torches: 6, skillOff: { light_base: 'вручную' } }) || {}).key, 'light_base', 'навык выключен');
  assert.notStrictEqual((decide({ ...lamp, torches: 6, blocked: { light_base: true } }) || {}).key, 'light_base', 'пауза после провала');
  assert.notStrictEqual((decide({ ...lamp, torches: 6, ...mob }) || {}).key, 'light_base', 'моб рядом — не до света');
  // повтор не чаще lightRepeatMin: недавно расставляла — нет; прошло — снова
  assert.notStrictEqual((decide({ ...lamp, torches: 6, lightSinceMin: T.lightRepeatMin - 1 }) || {}).key, 'light_base', 'недавно расставляла — не повторяю');
  assert.strictEqual(decide({ ...lamp, torches: 6, lightSinceMin: T.lightRepeatMin + 1 }).key, 'light_base', 'прошло достаточно — снова');
  // совсем закат (nightIn < nightSoonSec, ещё не ночь): свет ещё можно, пока мобов нет
  assert.strictEqual(decide({ ...lamp, nightIn: T.nightSoonSec - 10, torches: 6 }).key, 'light_base', 'последние секунды заката — ставлю');
  // ночью (темно) — не ходим по базе с факелами
  assert.notStrictEqual((decide({ ...lamp, ...night, torches: 6 }) || {}).key, 'light_base', 'ночью факелы не расставляем');
  assert.ok(T.apLight > 50 && T.apLight < 100, 'свет: выше цели мозга (50)');

  // ---- v0.4 ночь у базы (этап 3): нужда очереди — крафт/плавка из сумки вместо wait_night ----
  const nwB = need => ({ ...nhome, hostile: null, build: { name: 'fence_line', x: 0, y: 64, z: 0, rot: 0, sig: 'F', need }, buildDist: 3 });
  const nwT = { ...wood, planks: 20, sticks: 10 };
  a = decide({ ...nwB({ spruce_fence: 12 }), tools: nwT });
  assert.ok(a && a.key === 'night_craft' && a.name === 'craft' && a.params.item === 'spruce_fence' && a.params.count === 12, 'ночь у базы, нужда в заборах — крафт: ' + JSON.stringify(a));
  a = decide({ ...nwB({ spruce_fence: 12 }), tools: { ...nwT, planks: 6, sticks: 0 } });
  assert.ok(a && a.key === 'night_craft' && a.params.count === 3, 'досок на один крафт (4 + 2 на палки) — заборов 3: ' + JSON.stringify(a));
  a = decide({ ...nwB({ spruce_fence: 12 }), tools: { ...nwT, planks: 2, sticks: 0 } });
  assert.notStrictEqual((a || {}).key, 'night_craft', 'досок не хватает даже на один крафт');
  a = decide({ ...nwB({ torch: 8 }), tools: nwT, coal: 5 });
  assert.ok(a && a.key === 'night_craft' && a.params.item === 'torch' && a.params.count === 8, 'факелы из угля и палок: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...nwB({ torch: 8 }), tools: nwT, coal: 0 }) || {}).key, 'night_craft', 'угля нет — факелов нет');
  a = decide({ ...nwB({ spruce_planks: 12 }), tools: { ...nwT, planks: 0, logs: 2 } });
  assert.ok(a && a.key === 'night_craft' && a.params.item === 'spruce_planks' && a.params.count === 8, 'доски из брёвен: ' + JSON.stringify(a));
  a = decide({ ...nwB({ stone: 6 }), tools: { ...nwT, cobble: 30 }, cobble: 30, fuel: true });
  assert.ok(a && a.key === 'night_smelt' && a.name === 'smelt' && a.params.item === 'cobblestone' && a.params.count === 6, 'нужен stone — плавка булыжника: ' + JSON.stringify(a));
  a = decide({ ...nhome, hostile: null, rawFood: { name: 'beef', count: 3 }, fuel: true, furnaceNear: true });
  assert.ok(a && a.key === 'night_cook' && a.params.item === 'beef', 'сырое мясо и топливо — жарка вместо ожидания: ' + JSON.stringify(a));
  // не у базы, угроза, пауза, нужды нет — как раньше
  assert.notStrictEqual((decide({ ...nwB({ spruce_fence: 12 }), tools: nwT, baseDist: 60 }) || {}).key, 'night_craft', 'не у базы — не крафтим');
  assert.notStrictEqual((decide({ ...nwB({ spruce_fence: 12 }), tools: nwT, hostilesNear: 1, hostile: { name: 'zombie', d: 6 } }) || {}).key, 'night_craft', 'моб рядом — защита');
  assert.notStrictEqual((decide({ ...nwB({ spruce_fence: 12 }), tools: nwT, blocked: { night_craft: true } }) || {}).key, 'night_craft', 'пауза после крафта');
  assert.notStrictEqual((decide({ ...nwB(null), tools: nwT }) || {}).key, 'night_craft', 'нужды нет — не крафтим');
  assert.ok(T.apNightCraft > 50 && T.apNightCraft < 60 && T.apNightSmelt > 20 && T.apNightSmelt < 60, 'ночная работа: выше wait_night, ниже еды/угроз (60)');

  // ---- живой цикл (start -> finish): память кровати и пауза факелов ----
  const ctx = { events: { push() {} }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap = AP.create(ctx);
  let res = { ok: true };
  ctx.runSkill = async () => res;
  const go = async (key, params, r) => { res = r; ap._start({ key, kind: 'body', name: 'x', params, why: 't' }); await ap.running.promise; };
  await go('bed_home', {}, { ok: true, result: { ok: true, bed: true, placed: true, at: [3, 64, -2] } });
  assert.deepStrictEqual({ x: ap.bed.x, y: ap.bed.y, z: ap.bed.z }, { x: 3, y: 64, z: -2 }, 'кровать у базы запомнена');
  ap.bed = null; await go('bed_home', {}, { ok: false, error: 'нет ровного места под кровать у базы' });
  assert.strictEqual(ap.bed, null, 'провал постановки не запоминаем');
  await go('light_base', {}, { ok: true, result: { ok: true, placed: 4 } });
  assert.ok(ap.light && ap.light.t > 0, 'факелы расставляла — запомнила');
  ap.light = null; await go('light_base', {}, { ok: false, error: 'некуда ставить факелы' });
  assert.ok(ap.light && ap.light.t > 0, 'провал тоже в счёт — по кругу не зовём');
}

// ---- v0.3 инструменты (шаг 2): кирка/меч/лопата/топор по материалам, крафт перед делом, выключенные навыки не выбираются ----
async function toolStage2() {
  const AP = require('./autopilot');
  // сумка -> ранги: лучший каждого вида
  assert.deepStrictEqual(AP.toolTiers([{ name: 'wooden_pickaxe' }, { name: 'stone_pickaxe' }, { name: 'iron_sword' }, { name: 'stick' }]), { pickaxe: 2, sword: 3, shovel: 0, axe: 0 });
  // какой инструмент нужен блоку / делу
  assert.strictEqual(AP.toolFor('stone'), 'pickaxe'); assert.strictEqual(AP.toolFor('cobblestone'), 'pickaxe'); assert.strictEqual(AP.toolFor('deepslate_iron_ore'), 'pickaxe');
  assert.strictEqual(AP.toolFor('dirt'), 'shovel'); assert.strictEqual(AP.toolFor('gravel'), 'shovel'); assert.strictEqual(AP.toolFor('oak_log'), 'axe'); assert.strictEqual(AP.toolFor('log'), 'axe');
  assert.strictEqual(AP.toolFor('stone_pickaxe'), null, 'сам инструмент — не блок'); assert.strictEqual(AP.toolFor('wheat'), null);
  assert.deepStrictEqual(AP.toolsForAct({ name: 'collect', params: { block: 'stone' } }), ['pickaxe']);
  assert.deepStrictEqual(AP.toolsForAct({ name: 'gather_list', params: { items: 'cobblestone:20,dirt:5,oak_log:3' } }), ['pickaxe', 'shovel', 'axe']);
  assert.deepStrictEqual(AP.toolsForAct({ name: 'gather_list', params: { items: { dirt: 4 } } }), ['shovel']);
  assert.deepStrictEqual(AP.toolsForAct({ name: 'explore', params: {} }), []);
  // материал: деревянная кирка = 3 доски + 2 палки (палки из досок) + верстак 4 доски; каменная — 3 булыжника + палки
  const none = { pickaxe: 0, sword: 0, shovel: 0, axe: 0, planks: 0, sticks: 0, logs: 0, cobble: 0, table: false };
  assert.strictEqual(AP.toolFeasible({ ...none, logs: 2 }, 'pickaxe', 'wooden'), false, '8 досок < 3+2(палки)+4(верстак) = 9');
  assert.strictEqual(AP.toolFeasible({ ...none, logs: 3 }, 'pickaxe', 'wooden'), true);
  assert.strictEqual(AP.toolFeasible({ ...none, logs: 2, table: true }, 'pickaxe', 'wooden'), true, 'верстак рядом — 4 доски не нужны');
  assert.strictEqual(AP.toolFeasible({ ...none, logs: 2, cobble: 3 }, 'pickaxe', 'stone'), true, 'камень: палки (2 доски) + верстак (4) = 6 <= 8 досок');
  assert.strictEqual(AP.toolFeasible({ ...none, logs: 1, cobble: 3 }, 'pickaxe', 'stone'), false, '4 доски < 6');
  assert.deepStrictEqual(AP.toolNext(none), [], 'ничего нет — делать нечего');
  assert.strictEqual(AP.toolNext({ ...none, logs: 3 })[0].item, 'wooden_pickaxe', 'кирка — первая (каждый инструмент считается отдельно, после крафта счёт заново)');
  assert.deepStrictEqual(AP.toolNext({ ...none, logs: 1 }), [], '4 доски: на верстак хватит, на инструмент нет');
  assert.deepStrictEqual(AP.toolNext({ ...none, logs: 6, cobble: 9 }).map(c => c.item), ['stone_pickaxe', 'stone_sword', 'stone_shovel', 'stone_axe'], 'камень есть — каменные');
  assert.deepStrictEqual(AP.toolNext({ ...none, pickaxe: 1, sword: 1, shovel: 1, axe: 1, logs: 6, cobble: 9 }).map(c => c.item), ['stone_pickaxe', 'stone_sword'], 'деревянные кирку и меч улучшаем, лопату и топор — нет');
  assert.deepStrictEqual(AP.toolNext({ ...none, pickaxe: 2, sword: 3, shovel: 2, axe: 2, logs: 9, cobble: 9 }), [], 'всё есть');
  // выключенные навыки у исполнителя
  const gate = AP.skillGate([{ name: 'night_mine', enabled: false, disabledReason: 'авто: 3 провала подряд' }, { name: 'day_routine', enabled: false, disabledReason: 'вручную' },
    { name: 'build_hut', enabled: false, disabledReason: 'авто: POST /abort' }, { name: 'go_safe', enabled: true }]);
  assert.deepStrictEqual(Object.keys(gate.off).sort(), ['day_routine', 'night_mine'], 'выключенный из-за прерываний не в счёт — его вернёт finish()');
  assert.deepStrictEqual(gate.known, ['night_mine', 'day_routine', 'build_hut', 'go_safe']);
  assert.strictEqual(AP.skillGate(undefined), null, 'список не пришёл — прежний набор'); assert.strictEqual(AP.skillGate([]).known, null);

  const day = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, foodUnits: 8 };
  const full = { pickaxe: 2, sword: 2, shovel: 2, axe: 2, planks: 0, sticks: 0, logs: 0, cobble: 30, table: false };
  assert.strictEqual(decide({ ...day, tools: full }).key, 'day_routine', 'инструменты все — обычная работа');
  // нет кирки, дерево есть — крафтим деревянную раньше рутины и сбора дерева
  let a = decide({ ...day, hasPickaxe: false, hasWeapon: false, cobble: 0, logs: 3, tools: { ...none, logs: 3 } });
  assert.ok(a.key === 'craft_pick' && a.name === 'craft' && a.params.item === 'wooden_pickaxe', 'нет кирки, дерево есть — крафт: ' + JSON.stringify(a));
  // нет кирки и дерева нет — крафта нет: рублю дерево (не долблю камень рукой)
  a = decide({ ...day, hasPickaxe: false, cobble: 0, logs: 0, tools: none });
  assert.ok(a.key === 'collect_log', 'нет ни кирки, ни дерева — за деревом: ' + JSON.stringify(a));
  // камень есть + палки: каменная кирка вместо деревянной
  a = decide({ ...day, hasPickaxe: false, cobble: 5, logs: 2, tools: { ...none, logs: 2, cobble: 5 } });
  assert.ok(a.key === 'craft_pick' && a.params.item === 'stone_pickaxe', 'булыжник есть — каменная: ' + JSON.stringify(a));
  // деревянная кирка -> каменная, когда набрался камень (улучшение выше рутины, но ниже меча)
  a = decide({ ...day, tools: { ...full, pickaxe: 1, sword: 2, shovel: 2, axe: 2, logs: 2 } });
  assert.ok(a.key === 'craft_pick' && a.params.item === 'stone_pickaxe', 'улучшаю деревянную: ' + JSON.stringify(a));
  a = decide({ ...day, tools: { ...full, pickaxe: 1, sword: 0, logs: 2 } });
  assert.ok(a.key === 'craft_sword' && a.params.item === 'stone_sword', 'меча нет — раньше улучшения кирки: ' + JSON.stringify(a));
  // лопата и топор: только если их нет; материала нет — работа как обычно
  a = decide({ ...day, tools: { ...full, shovel: 0, planks: 8 } });
  assert.ok(a.key === 'craft_shovel', 'лопаты нет — делаю: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...day, tools: { ...full, shovel: 0, axe: 0 } }).key, 'day_routine', 'на лопату и топор материала нет — не жду, работаю');
  // провалившийся крафт на паузе: не зовём снова
  assert.notStrictEqual(decide({ ...day, tools: { ...full, shovel: 0, planks: 8 }, blocked: { craft_shovel: true } }).key, 'craft_shovel');
  // еда при низком HP важнее крафта; угроза — тем более
  a = decide({ ...day, hp: 12, food: 16, hasFood: false, foodUnits: 0, animals: 2, tools: { ...full, sword: 0, planks: 8 } });
  assert.strictEqual(a.key, 'hunt', 'HP 12 без регенерации — охота раньше крафта: ' + JSON.stringify(a));
  a = decide({ ...day, hp: 5, hostilesNear: 1, hostile: { name: 'zombie', d: 9 }, tools: { ...full, sword: 0, planks: 8 } });
  assert.strictEqual(a.key, 'lowhp_shelter', 'мало HP и моб — укрытие, не крафт');
  assert.ok(!/^craft_/.test((decide({ ...day, enemies: [{ name: 'Bob', d: 5, why: 'бил', aggressor: false }], tools: { ...full, sword: 0, planks: 8 } }) || {}).key), 'враг-игрок рядом — не крафтим');

  // цель мозга: collect камня — без кирки сначала крафт (если материал есть); нет материала — цель не берём, идём за деревом
  const goalStone = { name: 'collect', kind: 'body', params: { block: 'stone', count: 10 }, sig: 'collect {"block":"stone"}' };
  const noPick = { ...day, hasPickaxe: false, cobble: 0, logs: 3, goal: goalStone };
  a = decide({ ...noPick, tools: { ...none, logs: 3 } });
  assert.ok(a.key === 'craft_pick' && a.params.item === 'wooden_pickaxe', 'цель «камень», кирки нет, дерево есть — сначала кирка: ' + JSON.stringify(a));
  a = decide({ ...noPick, logs: 0, tools: none });
  assert.notStrictEqual(a.key, 'goal', 'кирки и дерева нет — камень рукой не долбим: ' + JSON.stringify(a));
  assert.strictEqual(a.key, 'collect_log');
  a = decide({ ...noPick, tools: { ...none, logs: 3 }, blocked: { craft_pick: true } });
  assert.notStrictEqual(a.key, 'goal', 'крафт кирки на паузе — камень рукой не долбим');
  // цель: земля — лопата; не сделать лопату — цель идёт как была
  const goalDirt = { name: 'collect', kind: 'body', params: { block: 'dirt', count: 10 }, sig: 'collect {"block":"dirt"}' };
  a = decide({ ...day, goal: goalDirt, tools: { ...full, shovel: 0, planks: 8 } });
  assert.ok(a.key === 'craft_shovel' || /перед «goal»/.test(a.why), 'цель «земля» — сначала лопата: ' + JSON.stringify(a));
  a = decide({ ...day, goal: goalDirt, tools: { ...full, shovel: 0 } });
  assert.strictEqual(a.key, 'goal', 'лопату не из чего — копаю рукой как раньше');
  // добор постройки (gather_list) с камнем и землёй: кирка/лопата перед ним
  const bd = { name: 'hut', x: 0, y: 64, z: 0, rot: 0, sig: 'b', need: { cobblestone: 20, dirt: 6 }, have: null };
  a = decide({ ...day, hasPickaxe: false, logs: 3, cobble: 0, build: bd, buildDist: 5, tools: { ...none, logs: 3 } });
  assert.strictEqual(a.key, 'craft_pick', 'добор камня без кирки: сначала кирка');
  a = decide({ ...day, build: bd, buildDist: 5, tools: { ...full, shovel: 0, planks: 8 } });
  assert.strictEqual(a.key, 'craft_shovel', 'добор земли без лопаты: сначала лопата (материал есть)');
  a = decide({ ...day, build: bd, buildDist: 5, tools: full });
  assert.strictEqual(a.key, 'build_gather', 'инструменты есть — добор как раньше');

  // ночь без угроз: нечего делать — крафт вместо ожидания/укрытия
  const night = { ...day, isNight: true, phase: 'ночь', nightIn: 0 };
  assert.strictEqual(decide({ ...night, tools: { ...full, sword: 0, logs: 2 } }).key, 'night_mine', 'ночью туннель (50) важнее');
  a = decide({ ...night, skillOff: { night_mine: 'авто: 3 провала подряд' }, tools: { ...full, sword: 0, logs: 2 } });
  assert.ok(a.key === 'craft_sword' && a.params.item === 'stone_sword', 'туннель выключен — ночью делаю меч: ' + JSON.stringify(a));
  a = decide({ ...night, skillOff: { night_mine: 'авто: 3 провала подряд' }, tools: full });
  assert.ok(a && a.key && a.key !== 'night_mine', 'ночью что-то делаем (не «навык выключен»): ' + JSON.stringify(a));

  // выключенный learned-навык не выбирается: ни дело дня, ни цель
  a = decide({ ...day, skillOff: { day_routine: 'авто: 3 провала подряд' } });
  assert.ok(a.key !== 'day_routine' && a.name !== 'day_routine', 'day_routine выключен — другое дело: ' + JSON.stringify(a));
  assert.strictEqual(a.key, 'explore');
  assert.strictEqual(decide({ ...day, skillKnown: ['go_safe', 'climb_up'] }).key, 'explore', 'навыка нет в списке исполнителя («не найден») — не берём');
  assert.strictEqual(decide({ ...day, skillKnown: ['day_routine', 'go_safe'], skillOff: {} }).key, 'day_routine', 'навык есть и включён — берём');
  const lg = { name: 'my_skill', kind: 'learned', params: { n: 3 }, sig: 'my_skill {"n":3}' };
  assert.strictEqual(decide({ ...day, goal: lg }).key, 'goal', 'цель-навык включён — берём');
  a = decide({ ...day, goal: lg, skillOff: { my_skill: 'вручную' } });
  assert.ok(a.key !== 'goal', 'цель-навык выключен — не берём: ' + JSON.stringify(a));
  // выключен go_safe — к базе идём своими ногами (goto), не пытаемся звать выключенный
  a = decide({ ...day, goSafe: true, skillOff: { go_safe: 'вручную' }, base: { x: 0, y: 64, z: 0, r: 16 }, baseDist: 80, tools: full });
  assert.ok(!(a && a.kind === 'learned' && a.name === 'go_safe'), 'go_safe выключен — не предлагаем: ' + JSON.stringify(a));
}

// ---- v0.3 еда, этап 1: доедать до регенерации, низкий HP без еды — сразу за едой, запас, жарка, наверх из пещеры, сталагмиты ----
async function foodStage1() {
  const AP = require('./autopilot');
  // рефлекс еды: HP не полный и сытость < 18 — ест (HP 2 / сытость 16 сидела часами); сытая/здоровая — нет
  assert.strictEqual(R.needsEat(16, 2), true, 'HP 2, сытость 16 — есть до регенерации');
  assert.strictEqual(R.needsEat(17, 19), true, 'HP 19, сытость 17 — регенерации нет, есть');
  assert.strictEqual(R.needsEat(18, 15), false, 'сытость 18, HP 15 — регенерация идёт, рефлекс не ест');
  assert.strictEqual(R.needsEat(16, 20), false, 'HP полный — регенерация не нужна');
  assert.strictEqual(R.needsEat(T.eatFood, 20), true, 'голодна — ест');
  const day = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, foodUnits: 8 };
  const night = { isNight: true, phase: 'ночь', nightIn: 0 };
  // живой случай 30–31.10: HP 2, сытость 16, еды нет, мобов нет — не «жду 120 с», а сразу за едой
  const starve = { ...day, hp: 2, food: 16, hasFood: false, foodUnits: 0 };
  let a = decide(starve);
  assert.ok(a && a.key === 'food_explore' && /ищу животных/.test(a.why), 'нет животных и мест — ищу в поле: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...starve, animals: 2 }).key, 'hunt', 'животные рядом — охота');
  const starve12 = { ...starve, hp: 9 }; // HP ≥ surfaceMinHp (8): climb_up сам не выйдет
  assert.strictEqual(decide({ ...starve12, underground: true, surfaceY: 67 }).name, 'climb_up', 'под землёй — сначала наверх, не в пещеру глубже');
  assert.strictEqual(decide({ ...starve12, underground: true, surfaceY: 67 }).params.y, 67);
  assert.strictEqual(decide({ ...starve12, underground: true, crashed: { climb_up: {} } }).name, 'climb_stairs', 'climb_up упал — climb_stairs');
  assert.strictEqual(decide({ ...starve12, underground: true, failInfo: { surface: { reason: 'нет блоков', count: 2 } } }).key, 'surface_stairs', 'climb_up не вышел дважды — другой способ');
  assert.strictEqual(decide({ ...starve, underground: true, surfaceY: 67 }).name, 'climb_stairs', 'HP 2 (< surfaceMinHp): climb_up сам выходит при HP<8 — сразу climb_stairs');
  const spot = { x: 40, y: 70, z: 0, d: 40, ago: 3, n: 2 };
  a = decide({ ...starve, animalSpot: spot });
  assert.ok(a.key === 'food_spot' && a.name === 'goto' && a.params.x === 40, 'животных нет — иду туда, где видела: ' + JSON.stringify(a));
  // база далеко — на базу раньше разведки
  assert.strictEqual(decide({ ...starve, base: { x: 0, y: 64, z: 0, r: 16 }, baseDist: 60 }).key, 'go_base');
  // ночь, мобов нет: только ближнее — охота рядом, подъём, место с животными в foodSpotNightDist; иначе ждём (в поле ночью не идём)
  assert.strictEqual(decide({ ...starve, ...night, animals: 1 }).key, 'hunt', 'ночью животные рядом — охота');
  assert.strictEqual(decide({ ...starve12, ...night, underground: true }).name, 'climb_up', 'ночью из пещеры наверх');
  assert.strictEqual(decide({ ...starve, ...night, animalSpot: { ...spot, d: 12 } }).key, 'food_spot', 'ночью к месту с животными рядом (HP 2: не дальше nightLeash)');
  assert.notStrictEqual((decide({ ...starve, ...night, animalSpot: { ...spot, d: 20 } }) || {}).key, 'food_spot', 'HP 2 ночью: место с животными дальше nightLeash (16 м) — не иду');
  assert.notStrictEqual((decide({ ...starve, ...night, animalSpot: spot }) || {}).key, 'food_spot', 'ночью далеко за едой не иду');
  // ночь и моб рядом — сначала безопасность (как раньше), не поход за едой
  a = decide({ ...starve, ...night, hostilesNear: 1, hostile: { name: 'skeleton', d: 8 } });
  assert.ok(!a || !/^(food_|hunt)/.test(a.key), 'ночью с мобом — безопасность: ' + JSON.stringify(a));
  // зомби рядом, оружие есть, бой по оценке выигран — гнилая плоть тоже еда; бой проигран — не лезем
  const zomb = { ...starve, hp: 6, hostilesNear: 1, hostile: { name: 'zombie', d: 5 } };
  a = decide({ ...zomb, outlook: { win: true, passiveTtdSec: 3, hitsToDie: 2 } });
  assert.ok(a.key === 'food_zombie' && a.name === 'fight' && a.params.flee_hp < 6, 'зомби по силам — бью ради плоти: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...zomb, outlook: { win: false, passiveTtdSec: 3, hitsToDie: 2 } }) || {}).key, 'food_zombie', 'бой проигран — не за плотью');
  assert.notStrictEqual((decide({ ...zomb, hasWeapon: false, outlook: { win: true, passiveTtdSec: 3, hitsToDie: 2 } }) || {}).key, 'food_zombie', 'без оружия — нет');
  // ловушка «HP 10 — здорова»: сытость < 18, еды нет — за едой раньше дневной работы
  assert.strictEqual(decide({ ...day, hp: 12, food: 16, hasFood: false, foodUnits: 0, animals: 2 }).key, 'hunt', 'HP 12 без регенерации — охота раньше работы');
  assert.strictEqual(decide({ ...day, hp: 12, food: 18, hasFood: false, foodUnits: 0, animals: 2 }).key, 'hunt_stock', 'регенерация идёт — охота впрок');
  // запас: сытая, еды мало — охота впрок; еды хватает — обычная работа; к закату запас важнее
  assert.strictEqual(decide({ ...day, foodUnits: 1, animals: 1 }).key, 'hunt_stock', 'еды мало — охочусь впрок');
  assert.strictEqual(decide({ ...day, foodUnits: 8, animals: 1 }).key, 'day_routine', 'еды хватает — работа');
  a = decide({ ...day, foodUnits: 4, animals: 1, nightIn: 200 });
  assert.ok(a.key === 'hunt_stock' && /до ночи/.test(a.why), 'к закату запас важнее: ' + JSON.stringify(a));
  // жарка: сырое + топливо + печь рядом или булыжник на неё — smelt тела (не cook_food); нет топлива — не жарим
  a = decide({ ...day, foodUnits: 3, rawFood: { name: 'beef', count: 3 }, fuel: true });
  assert.ok(a.key === 'cook' && a.name === 'smelt' && a.params.item === 'beef', 'жарю сырое: ' + JSON.stringify(a));
  assert.notStrictEqual(decide({ ...day, foodUnits: 3, rawFood: { name: 'beef', count: 3 }, fuel: false }).key, 'cook', 'без топлива не жарю');
  assert.notStrictEqual(decide({ ...day, cobble: 2, foodUnits: 3, rawFood: { name: 'beef', count: 3 }, fuel: true }).key, 'cook', 'ни печи, ни булыжника — не жарю');
  assert.strictEqual(decide({ ...day, crashed: { day_routine: {} }, wheat: 6 }).key, 'bread', 'пшеница есть — хлеб');
  // нужно дерево, а муха под землёй — сначала наверх, а не collect log в пещере
  a = decide({ ...day, hasPickaxe: false, logs: 0, underground: true, surfaceY: 67, crashed: { day_routine: {} } });
  assert.ok(a.key === 'surface' && /дерево/.test(a.why), 'под землёй за деревом — наверх: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...day, hasPickaxe: false, logs: 0, crashed: { day_routine: {} } }).key, 'collect_log', 'на поверхности — рублю');
  // своё дело еды прерывает моб рядом (как сбор)
  a = decide({ ...day, running: { key: 'food_explore', name: 'explore', kind: 'body' }, task: { name: 'explore', source: 'autopilot' }, hostilesNear: 1, hostile: { name: 'zombie', d: 4 } });
  assert.ok(a && /^safety_/.test(a.key) && a.preempt, 'моб у поиска еды — бросаю: ' + JSON.stringify(a));
  // память мест с животными: свежее ближнее место; «тут» и протухшее — нет; дошла — забыла
  const ap = {}; const t0 = 1e12;
  AP.noteAnimalSpot(ap, { x: 50, y: 70, z: 0, n: 2 }, t0);
  AP.noteAnimalSpot(ap, { x: 55, y: 70, z: 3, n: 3 }, t0 + 1000); // в 16 м от прежнего — одно место
  assert.strictEqual(ap.animalSpots.length, 1);
  assert.strictEqual(AP.animalSpotOf(ap, { x: 0, z: 0 }, t0 + 2000).x, 55);
  assert.strictEqual(AP.animalSpotOf(ap, { x: 50, z: 0 }, t0 + 2000), null, 'стою у места — это «тут»');
  assert.strictEqual(AP.animalSpotOf(ap, { x: 0, z: 0 }, t0 + (T.foodSpotTtlMin + 1) * 60000), null, 'старое место забыто');
  AP.forgetAnimalSpot(ap, 54, 2); assert.strictEqual(ap.animalSpots.length, 0, 'дошла — забыла');
  // козы — не дичь (с них нет мяса): рядом одни козы -> животных 0, места не запоминаем, охота не выбирается, к месту не идём
  const ent = (name, x) => ({ type: 'animal', name, position: { distanceTo: () => x } });
  assert.ok(!AP.GAME.includes('goat'), 'goat не в GAME');
  assert.strictEqual(AP.gameNear([ent('goat', 5), ent('goat', 9)], {}, 32).length, 0, 'одни козы — дичи нет');
  assert.strictEqual(AP.gameNear([ent('goat', 5), ent('cow', 9), ent('pig', 40)], {}, 32).length, 1, 'корова считается, коза и далёкая свинья — нет');
  const apG = {}; // как в gather(): место запоминается только при дичи рядом
  const goatsOnly = AP.gameNear([ent('goat', 5)], {}, 32);
  if (goatsOnly.length) AP.noteAnimalSpot(apG, { x: 1, y: 70, z: 1, n: goatsOnly.length }, t0);
  assert.ok(!apG.animalSpots || apG.animalSpots.length === 0, 'место только с козами не запомнено');
  a = decide({ ...starve, animals: goatsOnly.length, animalSpot: AP.animalSpotOf(apG, { x: 0, z: 0 }, t0) });
  assert.ok(a && a.key !== 'hunt' && a.key !== 'hunt_stock' && a.key !== 'food_spot', 'одни козы, еды нет — не охота и не поход к козам: ' + JSON.stringify(a));
  // версии навыков (v0.4): карта «база → какую версию звать» из GET /skills исполнителя
  const sk = (name, runs, ok, extra) => ({ name, enabled: true, valid: true, stats: { runs, ok }, ...(extra || {}) });
  let pv = AP.pickVersions([sk('gather_list', 233, 105), sk('gather_list_v4', 0, 0), sk('gather_list_v12', 0, 0)]);
  assert.strictEqual(pv.gather_list, 'gather_list_v12', 'счёт базы 0.45 < 0.5 — пробуем самую новую версию без запусков: ' + JSON.stringify(pv));
  pv = AP.pickVersions([sk('climb_up', 32, 8), sk('climb_up_v5', 5, 5), sk('climb_up_v6', 0, 0)]);
  assert.strictEqual(pv.climb_up, 'climb_up_v5', 'лучшая по (ok+1)/(runs+2): 6/7; v6 без запусков = 0.5 — не лучше');
  pv = AP.pickVersions([sk('x', 10, 8), sk('x_v2', 0, 0)]);
  assert.strictEqual(pv.x, 'x', 'у базы счёт 0.75 >= 0.5 — новой версии пробных запусков не даём');
  pv = AP.pickVersions([sk('y', 20, 2), sk('y_v1', 2, 0), sk('y_v2', 0, 0, { valid: false }), sk('y_v3', 0, 0, { enabled: false })]);
  assert.strictEqual(pv.y, 'y_v1', 'broken (valid:false) и выключенные версии не кандидаты; v1 (0 из 2, runs < 3) — пробная');
  pv = AP.pickVersions([sk('z', 20, 2), sk('z_v1', 3, 0)]);
  assert.strictEqual(pv.z, 'z_v1', 'обе плохи: v1 0.2 (runs=3 — проба кончилась), база 0.2727 — лучше по счёту');
  pv = AP.pickVersions([sk('w', 5, 5, { enabled: false }), sk('w_v1', 3, 3)]);
  assert.strictEqual(pv.w, 'w_v1', 'база выключена — берём версию');
  assert.strictEqual(AP.pickVersions([sk('b', 0, 0)]).b, 'b', 'одна версия — её и зовём');
  assert.deepStrictEqual(AP.pickVersions([sk('q', 20, 2), sk('q_v1', 0, 0)], new Set(['q_v1'])), { q: 'q' }, 'версия со сбоем кода исключена');
  assert.deepStrictEqual(AP.pickVersions(null), {}, 'списка нет — карты нет (зовём базовые имена)');
  assert.deepStrictEqual(AP.pickVersions(undefined), {});
  // decide подставляет версию: name — версия, base — база, key не меняется; явно названную версию не трогаем; без карты — как раньше
  const lampG = { name: 'gather_list', params: { items: 'cobblestone:10' }, kind: 'learned', sig: 'gl' };
  a = decide({ ...day, goal: lampG, skillVer: { gather_list: 'gather_list_v12' } });
  assert.ok(a.key === 'goal' && a.kind === 'learned' && a.name === 'gather_list_v12' && a.base === 'gather_list' && /gather_list → gather_list_v12/.test(a.why), 'версия в имени и в why: ' + JSON.stringify(a));
  a = decide({ ...day, goal: lampG });
  assert.ok(a.name === 'gather_list' && !a.base, 'карты нет — базовое имя, как сейчас');
  a = decide({ ...day, goal: { ...lampG, name: 'gather_list_v3' }, skillVer: { gather_list: 'gather_list_v12' } });
  assert.strictEqual(a.name, 'gather_list_v3', 'явная версия в цели не подменяется');
  // сбой кода: на версии — другая версия базы не заблокирована, на базе — заблокирована вся база
  a = decide({ ...day, goal: lampG, skillVer: { gather_list: 'gather_list_v12' }, crashed: { gather_list: { file: 'gather_list_v4' } } });
  assert.strictEqual(a.name, 'gather_list_v12', 'сбой в другой версии не мешает выбранной');
  assert.notStrictEqual((decide({ ...day, goal: lampG, skillVer: { gather_list: 'gather_list_v12' }, crashed: { gather_list: { file: 'gather_list_v12' } } }) || {}).key, 'goal', 'выбранная версия упала с кодом — не зовём');
  assert.notStrictEqual((decide({ ...day, goal: lampG, crashed: { gather_list: {} } }) || {}).key, 'goal', 'сбой базы — базу не зовём');
  // выключена база, но версия включена
  a = decide({ ...day, goal: lampG, skillVer: { gather_list: 'gather_list_v12' }, skillOff: { gather_list: 'вручную' }, skillKnown: ['gather_list', 'gather_list_v12'] });
  assert.strictEqual(a.name, 'gather_list_v12', 'база выключена, версия — нет');
  // инструмент для добора считается по базе (gather_list_v12 тоже gather_list)
  assert.deepStrictEqual(AP.toolsForAct({ name: 'gather_list_v12', base: 'gather_list', params: { items: 'cobblestone:10' } }), ['pickaxe']);
  // сумка: запас (без гнилого), сырое на жарку, топливо, пшеница
  const fi = AP.foodInv({ cooked_beef: 2, rotten_flesh: 3, beef: 4, coal: 1, wheat: 3 }, { cooked_beef: {}, rotten_flesh: {}, beef: {}, wheat: {} }, R.FOOD_BLACKLIST);
  assert.deepStrictEqual(fi, { foodUnits: 9, rawFood: { name: 'beef', count: 4 }, fuel: true, wheat: 3 });
  assert.strictEqual(AP.foodInv({ oak_log: 2 }, {}, R.FOOD_BLACKLIST).fuel, false, '2 бревна — на кирку, не в печь');
  // под землёй: ниже поверхности, свод, неба не видно
  const vp = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return vp(x + dx, y + dy, z + dz); } });
  const ugBot = sky => ({ blockAt: q => (q.y >= 52 ? { name: 'stone', boundingBox: 'block', skyLight: sky } : { name: 'air', boundingBox: 'empty', skyLight: sky }) });
  assert.strictEqual(AP.undergroundOf(ugBot(0), vp(0, 40, 0), 67), true, 'y 40, свод, темно — под землёй');
  assert.strictEqual(AP.undergroundOf(ugBot(15), vp(0, 40, 0), 67), false, 'небо видно — каньон, не под землёй');
  assert.strictEqual(AP.undergroundOf(ugBot(0), vp(0, 65, 0), 67), false, 'у поверхности — не под землёй');
  // сталагмиты: pathfinder платит за клетку со сталагмитом/под сталактитом (обходит), прочие — без цены
  const cell = (name, y) => ({ name, position: vp(0, y, 0) });
  assert.strictEqual(R.dripstoneCost(cell('pointed_dripstone', 60), () => false), T.dripstoneCost);
  assert.strictEqual(R.dripstoneCost(cell('air', 60), v => v.y === 62), T.dripstoneCost, 'сталактит над головой — дорого');
  assert.strictEqual(R.dripstoneCost(cell('air', 60), v => v.y === 59), T.dripstoneCost, 'сталагмит под ногами — дорого');
  assert.strictEqual(R.dripstoneCost(cell('air', 60), () => false), 0);
  assert.ok(T.dripstoneCost < 100, 'не запрет: нет обхода — идёт');
  // ---- v0.3 очередь «## План» (шаг 3, behavior/plan.js): разбор и порядок выбора (чистые функции; полная проверка — test/plan.js) ----
  const PLN = require('./plan');
  const pp = PLN.parsePlan('## Текущая цель\n## План\n- [ ] hut_west 1 2 3 rot=90 | комментарий\n- [ ] Автопилот: collect block=stone count=8\n- [x] base_pad 0 0 0\n- [ ] hut_west 1 2\n## Проект\n');
  assert.ok(pp.found && pp.items.length === 4 && pp.items[0].kind === 'build' && pp.items[0].comment === 'комментарий' && pp.items[1].kind === 'goal' && pp.items[2].mark === 'x' && pp.items[3].bad, 'parsePlan');
  const pst = PLN.emptyPlan();
  assert.strictEqual(PLN.planPick({ own: null, goal: null, items: pp.items, state: pst, now: 1e12, brainOn: false }).item, pp.items[0], 'первый открытый пункт');
  PLN.mark(pst, pp.items[0].sig, 'done', '', 1e12, 0); pst.doneAt = 1e12;
  assert.strictEqual(PLN.planPick({ own: null, goal: null, items: pp.items, state: pst, now: 1e12 + 1000, brainOn: false }).item, pp.items[1], 'готовый по памяти пропущен');
  assert.strictEqual(PLN.planPick({ own: null, goal: null, items: pp.items, state: pst, now: 1e12 + 1000, brainOn: true }).via, null, 'мозг включён — после build_done ждём его');
  assert.ok(T.planFailPauses >= 1 && T.planRetryMs > T.planRetryIdleMs && T.planBrainWaitMs > 0, 'пороги очереди');
}

// ---- v0.3 еда, этап 2: рыбалка (удочка, прорубь), деревня из памяти, ферма у базы ----
async function foodStage2() {
  const AP = require('./autopilot');
  const day = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false, foodUnits: 8 };
  const night = { isNight: true, phase: 'ночь', nightIn: 0 };
  const hungry = { ...day, foodUnits: 0 };                                     // сытая, еды в сумке нет, животных нет
  const starve = { ...day, hp: 2, food: 16, hasFood: false, foodUnits: 0 };   // регенерации нет — за едой
  const lake = { x: 10, y: 63, z: 10, d: 10 };
  const open = { open: true, ice: null };
  const ice = { x: 12, y: 63, z: 11 };
  const base = { x: 0, y: 64, z: 0, r: 16 };
  let a;
  // ---- материал: удочка = 3 палки + 2 нити (палки из досок, верстак 4 доски), мотыга = 2 палки + 2 доски ----
  assert.strictEqual(AP.rodFeasible({ string: 2, sticks: 3, planks: 0, table: true }), true, 'палки и нить есть');
  assert.strictEqual(AP.rodFeasible({ string: 2, planks: 2, table: true }), true, '2 доски -> 4 палки');
  assert.strictEqual(AP.rodFeasible({ string: 2, planks: 5, table: false }), false, 'верстака нет: 4 + 2 доски');
  assert.strictEqual(AP.rodFeasible({ string: 2, planks: 6, table: false }), true);
  assert.strictEqual(AP.rodFeasible({ string: 2, logs: 2, table: false }), true, 'брёвна -> доски');
  assert.strictEqual(AP.rodFeasible({ string: 1, sticks: 3, table: true }), false, 'нити мало (нить только с пауков)');
  assert.strictEqual(AP.hoeFeasible({ planks: 2, sticks: 2, table: true }), true);
  assert.strictEqual(AP.hoeFeasible({ planks: 3, table: true }), false, 'на палки не хватает');
  assert.strictEqual(AP.hoeFeasible({ planks: 8 }), true, 'доски на верстак, палки и мотыгу');
  // ---- рыбалка ----
  // еды мало, животных нет, удочка и открытая вода — fish (забросов столько, сколько не хватает до запаса, не меньше 3)
  a = decide({ ...hungry, rod: 1, water: lake, fish: open });
  assert.ok(a && a.key === 'fish' && a.name === 'fish' && a.params.casts === T.foodStockWant + 1 && a.params.max_sec === T.fishMaxSec, 'удочка + вода — рыбачу: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...hungry, foodUnits: 5, rod: 1, water: lake, fish: open }).params.casts, 3, 'не хватает 1 — всё равно хотя бы 3 заброса');
  assert.notStrictEqual((decide({ ...day, rod: 1, water: lake, fish: open }) || {}).key, 'fish', 'еды хватает — не рыбачу');
  assert.notStrictEqual((decide({ ...hungry, animals: 2, rod: 1, water: lake, fish: open }) || {}).key, 'fish', 'животные рядом — охота впрок, не рыба');
  assert.notStrictEqual((decide({ ...hungry, nightIn: 60, rod: 1, water: lake, fish: open }) || {}).key, 'fish', 'к закату на рыбу не ухожу');
  assert.notStrictEqual((decide({ ...hungry, rod: 1, water: lake, fish: open, blocked: { fish: true } }) || {}).key, 'fish', 'пауза после захода без улова');
  // удочки нет: нить есть и материал на палки — крафт; нити нет / воды нет / материала нет — ветку пропускаем
  const mat = { planks: 8, sticks: 0, logs: 0, table: true };
  a = decide({ ...starve, water: lake, string: 2, tools: mat });
  assert.ok(a && a.key === 'craft_rod' && a.name === 'craft' && a.params.item === 'fishing_rod', 'нить есть — делаю удочку: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...starve, water: lake, string: 0, tools: mat }) || {}).key, 'craft_rod', 'нити нет — ветку пропускаем');
  assert.notStrictEqual((decide({ ...starve, string: 2, tools: mat }) || {}).key, 'craft_rod', 'воды нет — удочка ни к чему');
  assert.notStrictEqual((decide({ ...starve, water: lake, string: 2, tools: { ...mat, planks: 0 } }) || {}).key, 'craft_rod', 'нечего на палки');
  // вода далеко — сначала к воде; льдом закрыта — сначала лёд (прорубь), потом рыба
  a = decide({ ...hungry, rod: 1, water: { ...lake, d: 30 }, fish: { open: false, ice: null } });
  assert.ok(a && a.key === 'fish_go' && a.name === 'goto' && a.params.x === 10, 'вода в 30 м — иду к ней: ' + JSON.stringify(a));
  a = decide({ ...hungry, rod: 1, water: lake, fish: { open: false, ice } });
  assert.ok(a && a.key === 'fish_ice' && a.name === 'dig_at' && a.params.x === 12 && a.params.y === 63 && a.params.z === 11, 'вода подо льдом — ломаю лёд: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...hungry, rod: 1, water: lake, fish: { open: true, ice } }).key, 'fish', 'открытая вода есть — лёд не трогаю');
  assert.notStrictEqual((decide({ ...hungry, rod: 1, water: { ...lake, d: 30 }, fish: { open: false, ice: null }, blocked: { fish_go: true } }) || {}).key, 'fish_go', 'пришла и ловить негде — снова не иду');
  // низкий HP без еды: охота -> место с животными -> РЫБАЛКА -> деревня -> база -> поле
  assert.strictEqual(decide({ ...starve, rod: 1, water: lake, fish: open }).key, 'fish', 'HP 2, еды нет, вода рядом — рыбачу вместо explore');
  assert.strictEqual(decide({ ...starve, animals: 1, rod: 1, water: lake, fish: open }).key, 'hunt', 'животные рядом — охота раньше рыбы');
  assert.strictEqual(decide({ ...starve, animalSpot: { x: 40, y: 70, z: 0, d: 40, ago: 3, n: 2 }, rod: 1, water: lake, fish: open }).key, 'food_spot', 'место с животными — раньше рыбы');
  assert.strictEqual(decide({ ...starve, base, baseDist: 60, rod: 1, water: lake, fish: open }).key, 'fish', 'рыба раньше дороги на базу');
  assert.strictEqual(decide({ ...starve, water: lake, string: 2, tools: mat }).key, 'craft_rod', 'HP 2, удочки нет, нить есть — крафт');
  assert.notStrictEqual((decide({ ...starve, ...night, rod: 1, water: lake, fish: open }) || {}).key, 'fish', 'ночью на рыбу не идём');
  // сырая рыба — как мясо: smelt
  a = decide({ ...day, foodUnits: 3, rawFood: { name: 'salmon', count: 3 }, fuel: true });
  assert.ok(a.key === 'cook' && a.name === 'smelt' && a.params.item === 'salmon', 'сырую рыбу жарю: ' + JSON.stringify(a));
  // ---- деревня из памяти ----
  const vil = { x: 300, y: 70, z: 0, d: 150, villagers: 5 };
  a = decide({ ...starve, village: vil });
  assert.ok(a && a.key === 'food_village' && a.name === 'goto' && a.params.x === 300 && /не трогаю/.test(a.why), 'деревня в 150 м — иду: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...starve, village: vil, base, baseDist: 60 }).key, 'food_village', 'деревня раньше базы');
  assert.strictEqual(decide({ ...starve, village: vil, rod: 1, water: lake, fish: open }).key, 'fish', 'рыба раньше деревни');
  assert.strictEqual(decide({ ...starve, village: vil, animalSpot: { x: 40, y: 70, z: 0, d: 40, ago: 3, n: 2 } }).key, 'food_spot', 'место с животными раньше деревни');
  assert.strictEqual(decide({ ...starve }).key, 'food_explore', 'деревни нет — поле');
  assert.notStrictEqual((decide({ ...starve, village: vil, nightIn: 150 }) || {}).key, 'food_village', 'до ночи не дойти — не иду');
  assert.notStrictEqual((decide({ ...starve, village: vil, blocked: { food_village: true } }) || {}).key, 'food_village', 'пауза после неудачи');
  assert.notStrictEqual((decide({ ...starve, ...night, village: { ...vil, d: 20 } }) || {}).key, 'vh_wheat', 'ночью за урожаем не ходим');
  // в деревне: пшеница -> морковь -> картофель (по разу за villageHarvestMin), потом дальше (не по кругу)
  const here = { ...vil, d: 20 };
  a = decide({ ...starve, village: here });
  assert.ok(a && a.key === 'vh_wheat' && a.name === 'harvest' && a.params.crop === 'wheat' && a.params.replant === true && a.params.radius === T.villageHarvestR, 'в деревне — собираю пшеницу: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...starve, village: here, vhDone: { wheat: true } }).params.crop, 'carrot', 'пшеницу пробовала — морковь');
  assert.strictEqual(decide({ ...starve, village: here, vhDone: { wheat: true, carrot: true } }).params.crop, 'potato');
  a = decide({ ...starve, village: here, vhDone: { wheat: true, carrot: true, potato: true } });
  assert.ok(a && a.key === 'food_explore', 'всё пробовала — не по кругу, а дальше: ' + JSON.stringify(a));
  a = decide({ ...starve, village: vil, base, baseDist: 60, vhDone: { wheat: true, carrot: true, potato: true } });
  assert.strictEqual(a.key, 'go_base', 'культуры пробованы — в деревню снова не возвращаюсь, иду на базу');
  // пшеница из деревни — хлеб (уже было), еда в сумке — деревня не нужна
  assert.notStrictEqual((decide({ ...day, village: vil }) || {}).key, 'food_village', 'еды хватает — за урожаем не иду');
  // ---- ферма у базы (выученный farm_plot) ----
  const full = { pickaxe: 3, sword: 3, shovel: 3, axe: 3 };
  const near = { base, baseDist: 10 };
  const farmW = { x: 5, z: 7 };
  a = decide({ ...day, ...near, seeds: 3, hoe: true, farmWater: farmW });
  assert.ok(a && a.key === 'farm' && a.kind === 'learned' && a.name === 'farm_plot' && a.params.x === 5 && a.params.z === 7 && a.params.seed === 'wheat_seeds' && a.params.size === T.farmSize && a.params.max_sec === T.farmMaxSec, 'база, вода, семена, мотыга — ферма: ' + JSON.stringify(a));
  assert.strictEqual(decide({ ...day, ...near, seeds: 3, hoe: false, tools: { ...full, planks: 8, table: true }, farmWater: farmW }).key, 'farm', 'мотыги нет, но доски на неё есть (farm_plot крафтит сам)');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: false, tools: { ...full, planks: 1, table: true }, farmWater: farmW }) || {}).key, 'farm', 'мотыги нет и не из чего');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 1, hoe: true, farmWater: farmW }) || {}).key, 'farm', 'семян мало');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 0, hoe: true, farmWater: farmW }) || {}).key, 'farm', 'без семян не зовём');
  assert.notStrictEqual((decide({ ...day, seeds: 3, hoe: true, farmWater: farmW }) || {}).key, 'farm', 'без базы не зовём');
  assert.notStrictEqual((decide({ ...day, base, baseDist: 100, seeds: 3, hoe: true, farmWater: farmW }) || {}).key, 'farm', 'база далеко — сначала на базу');
  // v0.4 (2.3): воды у базы нет — ферма всё равно берётся: farm_plot_v1 dry=1, центр — база (x,y,z)
  a = decide({ ...day, ...near, seeds: 3, hoe: true });
  assert.ok(a && a.key === 'farm' && a.kind === 'learned' && a.name === 'farm_plot_v1' && a.params.dry === 1 && a.params.x === base.x && a.params.z === base.z && a.params.y === base.y && a.params.seed === 'wheat_seeds', 'воды нет — сухая грядка на базе: ' + JSON.stringify(a));
  assert.strictEqual(a.score, T.farmDryScore, 'счёт сухой грядки');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: true, skillKnown: ['go_safe', 'farm_plot'] }) || {}).key, 'farm', 'farm_plot_v1 нет у исполнителя — не предлагаем');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 1, hoe: true }) || {}).key, 'farm', 'сухая грядка: семян меньше farmSeedsMin — нет');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: true, nightIn: 60 }) || {}).key, 'farm', 'сухая грядка к закату не начинается');
  a = decide({ ...day, ...near, seeds: 3, hoe: true, farm: { x: base.x, z: base.z, sinceMin: T.farmRevisitMin + 1, dry: true } });
  assert.ok(a && a.key === 'farm' && a.name === 'farm_plot_v1' && a.params.dry === 1, 'сухая ферма: пора собирать — тот же dry=1: ' + JSON.stringify(a));
  // семена: меньше seedsWant, день, база ≤48 м, мотыга есть/будет, фермой заняться нечем — ломаем траву; травы нет (пауза) — нет
  a = decide({ ...day, ...near, seeds: 1, hoe: true });
  assert.ok(a && a.key === 'seeds_grass' && a.name === 'collect' && a.params.block === 'short_grass' && a.params.radius === T.seedsGrassRadius, 'семян мало — трава: ' + JSON.stringify(a));
  assert.notStrictEqual((decide({ ...day, ...near, seeds: T.seedsWant, hoe: true }) || {}).key, 'seeds_grass', 'семян хватает');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 1, hoe: true, blocked: { seeds_grass: true } }) || {}).key, 'seeds_grass', 'травы не нашла — пауза');
  assert.notStrictEqual((decide({ ...day, base, baseDist: T.seedsGrassDist + 5, seeds: 1, hoe: true }) || {}).key, 'seeds_grass', 'база дальше 48 м — траву не ищем');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 1, hoe: false, tools: { ...full, planks: 0, sticks: 0, logs: 0, table: false } }) || {}).key, 'seeds_grass', 'мотыги нет и не будет — семена ни к чему');
  assert.strictEqual((decide({ ...day, ...near, seeds: 1, hoe: false, tools: { ...full, planks: 8, table: true } }) || {}).key, 'seeds_grass', 'мотыги нет, но будет — семена нужны');
  assert.notStrictEqual((decide({ ...day, ...near, ...night, seeds: 1, hoe: true }) || {}).key, 'seeds_grass', 'ночью траву не ломаем');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: true, farmWater: farmW, skillOff: { farm_plot: 'вручную' } }) || {}).key, 'farm', 'навык выключен — не предлагаем');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: true, farmWater: farmW, skillKnown: ['go_safe'] }) || {}).key, 'farm', 'навыка нет у исполнителя — не предлагаем');
  assert.notStrictEqual((decide({ ...day, ...near, seeds: 3, hoe: true, farmWater: farmW, nightIn: 60 }) || {}).key, 'farm', 'к закату грядки не начинаю');
  assert.notStrictEqual((decide({ ...day, ...near, ...night, seeds: 3, hoe: true, farmWater: farmW }) || {}).key, 'farm', 'ночью — нет');
  // уже посажено: пока рано — не зовём; прошло farmRevisitMin — собрать и пересадить на том же месте (семян не нужно: пересадка из урожая)
  const planted = { x: 5, z: 7, sinceMin: 5 };
  assert.notStrictEqual((decide({ ...day, ...near, farm: planted, farmWater: { x: 90, z: 90 } }) || {}).key, 'farm', 'посажено недавно — рано');
  a = decide({ ...day, ...near, farm: { ...planted, sinceMin: T.farmRevisitMin + 1 }, farmWater: { x: 90, z: 90 } });
  assert.ok(a && a.key === 'farm' && a.params.x === 5 && a.params.z === 7, 'пора собирать — на том же участке: ' + JSON.stringify(a));
  assert.ok(T.farmScore > 35 && T.farmScore < 50, 'ферма: выше рутины (35), ниже цели мозга (50)');
  // ---- живой цикл (start -> finish): память фермы, культур деревни и пауз рыбалки ----
  const ctx = { events: { push() {} }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap = AP.create(ctx);
  let res = { ok: true };
  ctx.runSkill = async () => res;
  const go = async (key, params, r) => { res = r; ap._start({ key, kind: 'body', name: 'x', params, why: 't' }); await ap.running.promise; };
  await go('farm', { x: 5, z: 7 }, { ok: true, result: { ok: true, planted: 9 } });
  assert.ok(ap.farm && ap.farm.x === 5 && ap.farm.z === 7 && ap.farm.t > 0, 'ферма запомнена');
  ap.farm = null; await go('farm', { x: 5, z: 7 }, { ok: false, error: 'на участке нечего вскапывать/сажать' });
  assert.strictEqual(ap.farm, null, 'провал фермы не запоминаем');
  // вода для фермы: база на y=67, речка на дне каньона (y≈36) — не берём; на уровне базы — берём; провал фермы метит точку
  const wb = { x: -393, y: 67, z: 36 }, canyon = { at: [-376, 36, 40] }, pond = { at: [-390, 66, 30] };
  assert.strictEqual(AP.farmWaterPick([canyon], wb, [], Date.now()), null, 'вода ниже базы на 30 блоков — ферму не выбираем');
  assert.deepStrictEqual(AP.farmWaterPick([canyon, pond], wb, [], Date.now()), { x: -390, z: 30 }, 'ближайшая в каньоне, дальше пруд на уровне базы — берём пруд');
  assert.strictEqual(AP.farmWaterPick([pond], wb, [{ x: -388, z: 32, t: Date.now() }], Date.now()), null, 'точка недавно провалилась — не выбираем');
  assert.deepStrictEqual(AP.farmWaterPick([pond], wb, [{ x: -388, z: 32, t: Date.now() - (T.farmBadMin + 1) * 60000 }], Date.now()), { x: -390, z: 30 }, 'давно провалилась — снова можно');
  a = decide({ ...day, ...near, seeds: 3, hoe: true, farmWater: AP.farmWaterPick([canyon], wb, [], Date.now()) });
  assert.ok(a && a.key === 'farm' && a.name === 'farm_plot_v1' && a.params.dry === 1, 'воды у базы нет (только каньон) — ферма сухая, не отказ: ' + JSON.stringify(a));
  await go('farm', { x: -390, z: 30 }, { ok: false, error: 'у участка -392,28..-388,32 нет воды в 4 клетках на уровне y=66' });
  assert.ok(ap.farmBad.some(b => b.x === -390 && b.z === 30 && b.t > 0), 'ферма провалилась из-за воды — точка в farmBad');
  const nBad = ap.farmBad.length;
  await go('farm', { x: 50, z: 70 }, { ok: false, error: 'ничего не сделано: hoe' });
  assert.strictEqual(ap.farmBad.length, nBad, 'провал не про воду/участок — точку не метим');
  await go('vh_wheat', { crop: 'wheat' }, { ok: true, result: { harvested: 0 } });
  assert.ok(ap.vh.wheat > 0, 'пшеницу в деревне пробовала');
  await go('vh_carrot', { crop: 'carrot' }, { ok: false, error: 'ничего не собрано: x' });
  assert.ok(ap.vh.carrot > 0, 'провал тоже считается пробой — по кругу не ходим');
  await go('fish', {}, { ok: true, result: { casts: 3, caught: {}, errors: 0 } });
  assert.ok(ap.until.fish > Date.now(), 'заход без улова — пауза');
  delete ap.until.fish;
  await go('fish', {}, { ok: true, result: { casts: 3, caught: { cod: 2 }, errors: 0 } });
  assert.ok(!ap.until.fish || ap.until.fish <= Date.now() + 20000, 'с уловом — паузы рыбалки нет (дальше решает запас)');
  await go('fish_go', { x: 10, y: 63, z: 10 }, { ok: true });
  assert.ok(ap.until.fish_go > Date.now() + T.fishGoPauseMs - 5000, 'дошла до воды — снова к ней не сразу');
  // fishSpot: открытая вода — ловим; воды под льдом — берём ближайший лёд над водой; ничего — null/пусто
  const Vec3 = require('vec3').Vec3, vision = require('../lib/vision');
  const grid = new Map(); const put = (x, y, z, name) => grid.set(x + ',' + y + ',' + z, { name, boundingBox: name === 'air' ? 'empty' : 'block' });
  const fbot = { registry: { blocksByName: { water: { id: 1 }, ice: { id: 2 } } }, entity: { position: new Vec3(0, 64, 0) },
    blockAt: q => grid.get(q.x + ',' + q.y + ',' + q.z) || { name: 'air', boundingBox: 'empty' } };
  const realFind = vision.find; const found = { 1: [], 2: [] };
  vision.find = (c, ids) => found[ids[0]];
  try {
    found[1] = [new Vec3(5, 63, 0)]; put(5, 63, 0, 'water');
    assert.deepStrictEqual(AP.fishSpot({ bot: fbot }), { open: true, ice: null }, 'над водой воздух — открытая');
    put(5, 64, 0, 'ice'); // замёрзла: над водой лёд
    assert.strictEqual(AP.fishSpot({ bot: fbot }).open, false);
    found[2] = [new Vec3(5, 64, 0), new Vec3(9, 64, 0)]; put(9, 63, 0, 'water'); put(9, 64, 0, 'ice');
    put(5, 64, 0, 'ice'); // над льдом воздух, под льдом вода
    assert.deepStrictEqual(AP.fishSpot({ bot: fbot }), { open: false, ice: { x: 5, y: 64, z: 0 } }, 'прорубь: ближайший лёд над водой');
    found[2] = [new Vec3(20, 64, 0)]; put(20, 64, 0, 'ice'); // лёд на суше (под ним не вода) — не годится
    assert.deepStrictEqual(AP.fishSpot({ bot: fbot }), { open: false, ice: null });
  } finally { vision.find = realFind; }

  // ---- утопление: тону ли, куда плыть, что ломать (чистые решения reflexes.js) ----
  const now0 = 100000;
  const mk = pts => pts.map(([dt, y]) => ({ t: now0 - dt, y })); // [сколько мс назад, высота]
  assert.strictEqual(R.isDrowning(T.drownUnderMs + 1, mk([[3000, 60.2], [2000, 60.2], [1000, 60.2], [0, 60.2]]), now0), true, 'под водой давно и y не растёт — тону');
  assert.strictEqual(R.isDrowning(T.drownUnderMs - 1000, mk([[3000, 60.2], [0, 60.2]]), now0), false, 'под водой ещё недолго — не тону');
  assert.strictEqual(R.isDrowning(T.drownUnderMs + 1, mk([[3000, 55], [2000, 56], [0, 58]]), now0), false, 'всплываю (y растёт) — не мешаем');
  assert.strictEqual(R.isDrowning(T.drownUnderMs + 1, mk([[1000, 60.2], [0, 60.2]]), now0), false, 'истории короче окна нет — решения нет');
  assert.strictEqual(R.isDrowning(0, mk([[3000, 60], [0, 60]]), now0), false, 'голова не под водой');
  assert.strictEqual(R.isDrowning(T.drownUnderMs + 1, [], now0), false);
  // мир-сетка: блок по умолчанию — вода (столб воды); put меняет клетки
  const wg = new Map(); const wput = (x, y, z, name) => wg.set(x + ',' + y + ',' + z, name);
  const wblock = name => name === 'water' ? { name, boundingBox: 'empty' } : name === 'air' ? { name, boundingBox: 'empty' } : { name, boundingBox: 'block', diggable: true };
  const wget = (x, y, z) => wblock(wg.get(x + ',' + y + ',' + z) || 'water');
  const pos0 = { x: 0.5, y: 60.2, z: 0.5 }; // ноги 60.2, глаза 61.7 -> клетка головы y=61
  // под льдом: над головой лёд (y=62), воздуха рядом нет — ломать лёд
  wput(0, 62, 0, 'ice');
  let pl = R.rescuePlan(wget, pos0, {});
  assert.strictEqual(pl.action, 'dig'); assert.deepStrictEqual([pl.target.x, pl.target.y, pl.target.z, pl.target.name], [0, 62, 0, 'ice']);
  assert.ok(/ломаю ice/.test(pl.why), pl.why);
  assert.strictEqual(R.blockOverhead(wget, pos0).kind, 'solid');
  // ...ломать не вышло (noDig), блоков нет — просто вверх; блок есть и «стою» — подставляем под ноги
  assert.strictEqual(R.rescuePlan(wget, pos0, { noDig: true }).action, 'up');
  assert.strictEqual(R.rescuePlan(wget, pos0, { noDig: true, stuck: true, canPlace: true }).action, 'place');
  // рядом (3 клетки) край с воздухом, по прямой льда нет: лёд над головой есть, но плывём к воздуху
  wput(3, 61, 1, 'air'); wput(3, 62, 1, 'air'); wput(3, 60, 1, 'water');
  pl = R.rescuePlan(wget, pos0, {});
  assert.strictEqual(pl.action, 'swim'); assert.deepStrictEqual([pl.target.x, pl.target.y, pl.target.z], [3, 61, 1]);
  assert.ok(/плыву к воздуху \(3 1\)/.test(pl.why), pl.why);
  // к воздуху пробовали, не вышло — ломаем лёд над головой
  assert.strictEqual(R.rescuePlan(wget, pos0, { skipSwim: true }).action, 'dig');
  // воздух за стеной (камень между) — не цель
  wput(1, 61, 0, 'stone'); wput(1, 61, 1, 'stone'); wput(1, 61, 2, 'stone'); wput(1, 60, 0, 'stone'); wput(1, 60, 1, 'stone'); wput(1, 60, 2, 'stone'); wput(2, 61, 1, 'stone'); wput(2, 60, 1, 'stone');
  assert.strictEqual(R.findAirCell(wget, pos0), null, 'воздух за стеной — не цель');
  // дальше радиуса — не цель
  wg.clear(); wput(0, 62, 0, 'ice'); wput(9, 61, 0, 'air'); wput(9, 62, 0, 'air');
  assert.strictEqual(R.findAirCell(wget, pos0), null, 'дальше drownSurfaceR — не ищем');
  // воздух прямо над головой — всплываем вверх; воздух выше +2 клеток по высоте не берём
  wg.clear(); wput(0, 62, 0, 'air'); wput(0, 63, 0, 'air');
  assert.strictEqual(R.rescuePlan(wget, pos0, {}).action, 'up');
  assert.strictEqual(R.rescuePlan(wget, pos0, { stuck: true, canPlace: true }).action, 'place', 'вверх не поднимаюсь, блок есть — подставляем');
  wg.clear(); wput(2, 65, 0, 'air'); wput(2, 66, 0, 'air');
  assert.strictEqual(R.findAirCell(wget, pos0), null, 'воздух выше +drownSurfaceDy — не цель');
  // глубокая вода без потолка и без воздуха рядом — просто вверх
  wg.clear();
  assert.strictEqual(R.rescuePlan(wget, pos0, {}).action, 'up');
  assert.strictEqual(R.blockOverhead(wget, pos0).kind, 'water');
  // пороги утопления на месте
  for (const k of ['drownUnderMs', 'drownStillMs', 'drownRiseMin', 'drownStuckMs', 'drownRescueMs', 'drownPauseMs']) assert.ok(T[k] > 0, k);
}
