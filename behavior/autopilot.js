// Автопилот (поведение): когда мозг молчит >= 30 с и тело свободно, тело само делает полезное — по одному навыку за раз
// (source:'autopilot'). Срочное (враг-игрок, лава/застряла, мало HP, моб ночью) — сразу; остальное (В) — не очередь,
// а выбор по обстановке: у дел счёт (время суток, голод, до базы, цель мозга, провалы), берётся наибольший.
// А: «мало HP», «бой по силам» — по последствию (lib/danger.js outlook), пороги HP — только когда оценки нет.
// Мозг всегда главнее: любая его команда вытесняет навык автопилота (tasks.js).
// L013 (переделано по заявке учителя): выученный навык, который вёл автопилот, по возможности НЕ убиваем.
// Короткая команда мозга (chest_take, craft…) — тело отдаёт её сама (она вытеснит текущую задачу навыка), навык сам
// закончится честно («вытеснен командой мозга»). Длинная (goto, wait_night, night_mine…) — тело нужно мозгу надолго:
// освобождаем сами и честно пишем причину («уступка мозгу: <команда>»). Намеренная уступка — это НЕ провал навыка:
// счётчик провалов исполнителя сбрасываем (POST :3200/enable), а в журнале различаем «прерван по требованию мозга»
// и «провалился сам». Задачи рефлексов автопилот не трогает.
// Решение — чистая функция decide(state), её можно проверять без бота. Перенесён из lib/autopilot.js как есть.
// Пороги — behavior/thresholds.js; цель/база из notes.md и переход на базу — ядро (lib/basegoal.js).
// Правка по заявке учителя (behavior_autopilot.md, 21.10): 1) одинаковая причина провала ВЫУЧЕННОГО навыка → пауза как у
// команд тела (failSameCount/failSameMaxMs), а не ровно 60 с; 2) проваленная цель из строки «Автопилот:» с теми же
// параметрами не повторяется — ждём новой строки (или явного enable) и пишем об этом честно; 3) сбой кода навыка
// («файл.js:строка») автопилот сам не повторяет — сообщает мозгу и ждёт. L003 (лесенка), L014 (мало HP), L013 (уступка
// мозгу) не тронуты.
// Правка по заявке учителя L052-автопилот (behavior_autopilot.md, смерть 22.10 00:54): «укрытие объявлено» ≠
// «безопасно ждать». Пока ночью рядом враждебный моб (в hostileR) или по муху недавно прилетели удары — wait_night
// не берём вовсе, а начавшийся wait_night прерываем не молча: бой (оружие, HP в норме) → укрытие стенами (НЕ яма:
// копка ямы 3-4 с, за это время зомби дошёл 9.7 → 2.7 м и залез в неё) → отход. Яму (night_shelter_dig) не начинаем
// при мобе рядом. Ждать утра с мобом в 0.3 м — смерть (удары 9 с, HP 20 → 0).
// Правка по заявке учителя (behavior_autopilot.md, 21.10 19:48, смерть 17): «иду на базу» — не голая команда goto.
// Дорогу ведёт выученный go_safe (проверки лавы/огня/воды/края/HP/ночи), если он включён у исполнителя; нет — прежние
// ноги, но: до старта горю/лава/под водой дорогу не начинаем; ночью (закат) при HP<8 или еде<18 (без регенерации,
// REGEN_FOOD в lib/danger.js) дорогу не начинаем; на голом goto по ходу «горю»/в лаве — бросаем дорогу немедленно
// (HP 20 → 7 за 70 с — цена одной проверки) и отходим/укрываемся. L003/L014/L013/L052 и правила паузы/цели не тронул.
// v0.2 «простой страшнее смерти»: idleBuildMin — минуты без блока стройки (lib/daylog.js). Давление idlePerMin за минуту
// (не выше idleCapMin): + к цели мозга, − к ожиданию/укрытию без угрозы (wait_night, night_shelter*, sleep). Ночью цель —
// только у базы (муха и точка цели в радиусе «База:»), не в поле. Идущий wait_night при простое ≥ idleBreakWaitMin без
// угрозы у базы — прерываем ради цели. Угроза (враг, лава, мало HP, моб ночью) — всегда раньше давления.
// Цель: провал — повтор через goalRetryMs с count/n вдвое меньше; успех с прогрессом — следующий шаг через goalRepeatMs;
// успех без нового блока — до новой строки «Автопилот:» не повторяем (иначе пустой круг).
// v0.2 «Постройка:» (мозг — архитектор, только «что и где»): строка «Постройка: <чертёж> x y z rot=…» в notes.md —
// дело мухи целиком: далеко — идёт к месту (build_go), строит build_blueprint (build), не хватило материала — добирает
// ровно недостающее выученным gather_list (build_gather) и строит снова; другой провал — пауза goalRetryMs и повтор
// (не бросает до новой строки); всё стоит — событие build_done один раз на эту строку, дальше её не строит.
// «Постройка:» главнее «Автопилот:». Счёт и ночь — как у цели мозга (давление простоя, ночью только у базы);
// угрозы, рефлексы, мало HP — всегда раньше. Мозг на провалы и простой не будится — это дело мухи.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const L = require('./core');
const { isHostile, isAnimal, isBuildBlock, entName, r1 } = L('util');
const A = L('actions');
const { timeInfo } = L('perception');
const threats = L('threats');
const AG = L('aggressors');
const vision = L('vision');
const { parseGoal, parseBuild, parseBase, baseTravel } = L('basegoal');
const T = require('./thresholds');
const D = L('danger');

const RUNNER = (process.env.RUNNER_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const IDLE_MS = T.idleMs;  // столько мозг должен молчать (и тело стоять), чтобы автопилот взялся за дело
const TICK_MS = T.tickMs;
const ENEMY_R = T.enemyR;  // враг-игрок ближе — реагировать сразу
const FAIL_MAX = T.failMax; // провалов подряд до паузы
const BACKOFF_MS = T.backoffMs;
const CHAT_MS = T.chatMs;  // не чаще одного сообщения в чат в минуту
const GAME = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];
// команды мозга, которые только читают/говорят: время молчания сбрасывают, но автопилот не прерывают
const READONLY = new Set(['survey', 'snapshot', 'status', 'task', 'recipes', 'scan', 'chat', 'wait']);
// короткие команды мозга (L013): тело отдаёт их сразу (вытесняет текущую задачу навыка) — навык убивать не надо,
// он сам закончится честно («вытеснен командой мозга»). Длинные — навык занимает тело надолго: освобождаем.
const SHORT_BRAIN = new Set([
  'chesttake', 'cheststore', 'craft', 'mark', 'waypoints', 'eat', 'equipitem', 'toss', 'dropjunk', 'pickup',
  'light', 'use', 'jump', 'sprint', 'sneak', 'look', 'placeat', 'digat', 'pillarup', 'bridge', 'shield'
]);
// ошибки, которыми навык сообщает, что тело забрала команда мозга (а не что навык провалился сам)
const BRAIN_ERR = /вытеснен командой мозга|уступка мозгу|занят навыком|POST \/abort/i;
// по такой причине навык выключают из-за прерываний (настоящие провалы — нет): вернуть его в работу
const INTERRUPT_ERR = /POST \/abort|вытеснен командой мозга|уступка мозгу|занят навыком/i;
// в ошибке навыка — файл и строка («brain/learned/build_hut.js:250»): это сбой кода, а не отказ о мире
const CODE_ERR = /\S+\.js:\d+/;
const norm = s => String(s || '').toLowerCase().replace(/[\s_\-]/g, '');
// причина провала без чисел: «блоков на стены мало (0/4)» и «(1/5)» — одна и та же причина
const normReason = r => String(r || '').toLowerCase().replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();
// вниз копать нельзя: пустота (пещера), лава, вода — укрытие только стенами, блоки в пустоту не ставим
const NO_DIG = /пустота|пещера|нельзя копать|копать негде|лава|вода/i;
const NOTES = path.join(process.env.FLYBOT_CORE || path.join(__dirname, '..'), 'brain', 'notes.md');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOD = {}; // метка этой версии модуля: после перезагрузки поведения автопилот создаётся заново

// ---------- Решение (чистая функция) ----------
// А: «мало HP» по последствию (lib/danger.js outlook в s.outlook): бой проигран и, не отбиваясь, муха умрёт раньше apReactSec
function lowHpOf(s) {
  if (s.sheltered && !s.hitRecent && s.hp >= T.apLowHp) return false;
  const o = s.outlook;
  if (!o) return s.hp < T.apLowHp;
  // если муха укрыта иRecent ударов нет — outlook не должен учитывать мобов,
  // которых не могут достать (в яме/укрытии). Считаем только реальную угрозу.
  if (s.sheltered && !s.hitRecent) {
    // outlook считает встречу выигрышной, если enough HP и weapon against mobs
    // если outlook проигрышный но мобов снаружи не достучаться — не ставим «мало HP»
    const relevantMobs = o.mobs ? o.mobs.filter(m => m.d <= T.apReactSec + 4) : [];
    const hasRelevantThreat = relevantMobs.length > 0 && !o.win;
    if (!hasRelevantThreat) return false;
  }
  return !o.win && o.passiveTtdSec < T.apReactSec;
}
// s: {on, idle, task:{name,source}|null, running:{key,name,kind}|null, runnerOther, hp, food, hasFood, hasWeapon, hasPickaxe,
//     blocks, logs, cobble, phase, isNight, nightIn, sheltered, inLava, suffocating, stuck, underWater,
//     hostilesNear, hostile:{name,id,d}|null (ближайший враждебный моб в hostileR),
//     hitRecent (по муху недавно били — урон в тике), enemies:[{name,d,why,aggressor}], alone, freeBed, animals,
//     recoverable, blocked:{key:true},
//     failInfo:{key:{reason,count}} (причины последних провалов автопилота: одинаковые — меняем тактику),
//     goal:{name,params,kind:'body'|'learned'}|null (цель мозга из notes.md), goalDone,
//     goalFailed (цель мозга уже провалилась — с теми же параметрами не повторяем), crashed:{навык:{reason,at}}
//     (навыки, упавшие со сбоем кода: автопилот их не повторяет),
//     base:{x,y,z,r}|null (строка «База:» из notes.md), baseDist (горизонтальная дистанция до базы, null если не считается),
//     outlook (А, lib/danger.js outlook: {win, ttdSec, passiveTtdSec, hitsToDie, mobs…}; нет — пороги HP),
//     idleBuildMin (v0.2: минуты без блока стройки; нет поля — давления нет, всё как раньше),
//     build:{name,x,y,z,rot,sig,need:{предмет:n}|null}|null (v0.2: «Постройка:» в работе — не готова и не на паузе),
//     buildDist (горизонтальная дистанция до места постройки)}
// -> null | {key, kind:'body'|'learned', name, params, why, preempt?, score?, others?} (score/others — В: счёт выбранного дела и следующих)
function decide(s) {
  if (!s.on) return null;
  if (s.task && s.task.source !== 'autopilot') return null; // мозг или рефлекс заняли тело — не лезем
  if (s.runnerOther) return null;                            // мозг запустил выученный навык
  const run = s.running ? s.running.key : null;
  const ok = k => !(s.blocked && s.blocked[k]);
  const body = (key, name, params, why, preempt) => ({ key, kind: 'body', name, params: params || {}, why, ...(preempt ? { preempt: true } : {}) });
  const crashed = s.crashed || {};
  // навык, упавший со сбоем кода, автопилот не повторяет: тот же вызов упадёт так же — ждём правки от мозга
  const learned = (key, name, params, why) => (crashed[name] ? null : { key, kind: 'learned', name, params: params || {}, why });

  // L052 (смерть 23): ночная защита, когда моб в hostileR или по муху били — те же варианты, что у рефлекса
  // (behavior/reflexes.js defensePrior): бой с оружием (HP в норме) → укрытие стенами (НЕ яма — копка ямы
  // занимает 3-4 с, зомби успевает дойти и залезть; по муху били и враг вплотную — стены не начинаем) → отход.
  // Укрытие заявлено и ударов нет — строить заново бессмысленно: бой или стоим (в тике напишем, что стоим).
  // А: «HP в норме для боя» — по последствию: бой с мобами рядом выигран (lib/danger.js outlook); без оценки — порог apFightHp
  const o = s.outlook || null;
  const fightWins = o ? !!o.win : s.hp >= T.apFightHp;
  const nightDefense = preempt => {
    const h = s.hostile;
    const hitClose = s.hitRecent && !!h && h.d < T.hitNoShelterDist; // били только что и враг вплотную — стены не успеть
    // 1) с оружием и HP в норме — отбиваемся (и из укрытия тоже: моб в 0.3 м — «укрытие» уже не спасает)
    if (h && s.hasWeapon && fightWins && ok('night_fight'))
      return body('night_fight', 'fight', { target: String(h.name).toLowerCase(), radius: T.fightRadius, flee_hp: T.playerFleeHp, timeout: T.apFightTimeout },
        `ночью отбиваюсь от ${h.name} (${h.d} м)${s.hitRecent ? ' — по муху били' : ''}`, preempt);
    // 2) укрытия нет — стены из блоков (НЕ яма: копка ямы 3-4 с, зомби успевает дойти и залезть); по муху били
    //    и враг вплотную — стены не начинаем (L052: не успеть, как у рефлекса hitNoShelterDist)
    if (!s.sheltered && s.blocks >= 2 && !hitClose && ok('night_shelter'))
      return body('night_shelter', 'shelter', { mode: 'walls' },
        h ? `ночью ${h.name} рядом (${h.d} м) — укрываюсь стенами (яму рядом с мобом не копаю)` : 'ночью небезопасно — укрываюсь стенами', preempt);
    // 3) по муху били (укрытие объявлено ≠ наверное есть) или укрытия нет совсем — отходим; в закрытом укрытии
    //    без ударов и без оружия ждём (в тике напишем «мобы рядом ночью — жду в укрытии», wait_night всё равно не берём)
    if ((!s.sheltered || s.hitRecent) && ok('night_escape'))
      return body('night_escape', 'escape', { distance: T.apEscapeDist, shelter: true },
        h ? `ночью ${h.name} рядом (${h.d} м) — отхожу${s.sheltered ? ', выхожу из укрытия' : ''}` : 'ночью небезопасно (по муху били) — отхожу', preempt);
    return null;
  };

  // 1. враг-игрок рядом — сразу, даже если мозг говорил недавно (тело свободно или работает автопилот)
  const en = (s.enemies || [])[0];
  if (en) {
    if (run === 'fight_player' || run === 'escape_player') return null;
    if (en.aggressor && s.hasWeapon && s.hp >= T.apFightHp && s.alone && ok('fight_player'))
      return body('fight_player', 'fight', { target: en.name, radius: T.apFightRadius, flee_hp: T.apFleeHp, timeout: T.apFightTimeout }, `отбиваюсь от ${en.name}`, true);
    if (ok('escape_player')) return body('escape_player', 'escape', { distance: T.apEscapeDist, shelter: true }, `убегаю от ${en.name} (${en.why}) — ${s.sheltered ? 'выхожу из укрытия в поле' : 'в поле'}`, true);
  }
  // L052 (смерть 23): ночью моб у порога или по муху били — долгую wait_night не молча держим: прерываем и отдаём
  // тело защите (бой/стены/отход); пока мозг командовал недавно — не отбираем (мозг главнее, L013)
  const nightSoon = s.isNight || s.nightIn < T.nightSoonSec;
  if (run === 'wait_night' && s.idle && nightSoon && (s.hostilesNear > 0 || s.hitRecent)) {
    const a = nightDefense(s, true);
    if (a) return a;
  }
  // behavior_autopilot (заявка учителя, день 21): на голом goto к базе (kind «тело») по ходу присматриваем —
  // go_safe у исполнителя смотрит снимок сам (его не дёргаем). Снимок «горю»/в лаве — бросаем дорогу немедленно
  // (HP 20 → 7 за 70 с — цена одной проверки): отходим/укрываемся, дальше разберётся самозащита и гейт до старта.
  if (run === 'go_base' && s.running.kind === 'body' && (s.onFire || s.inLava)) {
    return body('go_base_escape', 'escape', { distance: T.apEscapeDist, shelter: true },
      s.inLava ? 'в лаве на дороге к базе — бросаю дорогу и выхожу' : 'горю на дороге к базе — бросаю дорогу и отхожу/укрываюсь', true);
  }
  // v0.2: давление простоя и цель мозга (ночью — только у базы)
  const threat = s.hostilesNear > 0 || s.hitRecent;
  const idleMin = Math.max(0, Number(s.idleBuildMin) || 0);
  const press = T.idlePerMin * Math.min(idleMin, T.idleCapMin);
  // v0.2: «Постройка:» главнее «Автопилот:» — при постройке старая микроцель не берётся
  const b = s.build || null;
  const g = !b && s.goal && !s.goalDone && !s.goalFailed ? s.goal : null;
  const goalAct = () => {
    const why = `продолжаю цель мозга: ${g.name}${Object.keys(g.params).length ? ' ' + JSON.stringify(g.params) : ''}${press ? ` (простой ${Math.round(idleMin)} мин)` : ''}`;
    return g.kind === 'learned' ? learned('goal', g.name, g.params, why) : body('goal', g.name, g.params, why); // упала со сбоем кода — её нет
  };
// v0.2 постройка: не хватает материала — добор до ИТОГА (need из ответа build_blueprint); далеко — к месту; иначе — строю по чертежу
  const buildAct = () => {
    const tail = press ? ` (простой ${Math.round(idleMin)} мин)` : '';
    const need = b.need && Object.keys(b.need).length ? b.need : null;
    // не начинаем добор ночью (здесь isNight = phase === 'ночь'; nightIn — секунд до ночи)
    if (need && (s.isNight || (s.nightIn != null && s.nightIn < T.nightSoonSec))) {
      return null; // ночью не добираем — ждём утра или укрытия
    }
    if (need) {
      const items = Object.entries(need).map(([k, n]) => `${k}:${n}`).join(',');
      return learned('build_gather', 'gather_list', { items, max_sec: T.buildGatherSec }, `добираю для постройки ${b.name}: ${items.replace(/,/g, ', ')}${tail}`);
    }
    if (s.buildDist != null && s.buildDist > T.buildNearDist)
      return body('build_go', 'goto', { x: b.x, y: b.y, z: b.z, r: T.buildNearDist / 2, timeout: T.baseTimeoutSec, label: 'к постройке', fail: 'до постройки не дошла' }, `иду к постройке ${b.name} (${Math.round(s.buildDist)} м)${tail}`);
    return body('build', 'build_blueprint', { name: b.name, x: b.x, y: b.y, z: b.z, rot: b.rot }, `строю ${b.name} у ${b.x} ${b.y} ${b.z}${b.rot ? ' rot=' + b.rot : ''}${tail}`);
  };
  const job = b ? buildAct : g ? goalAct : null; // дело от мозга: постройка или старая цель
  const inBase = (x, z) => Math.hypot(x - s.base.x, z - s.base.z) <= s.base.r;
  const gp = b ? { x: b.x, z: b.z } : g && g.params || {};
  const atBase = !!(s.base && s.baseDist != null && s.baseDist <= s.base.r &&
    !(Number.isFinite(gp.x) && Number.isFinite(gp.z) && !inBase(gp.x, gp.z))); // ночная стройка — у базы, не в поле
  // идущий wait_night: простой давно, угрозы нет, у базы — будим ради цели (после угроз и go_base_escape, мозг молчит)
  if (run === 'wait_night' && s.idle && job && atBase && !threat && idleMin >= T.idleBreakWaitMin && !lowHpOf(s)
      && !(s.inLava || s.suffocating || s.stuck || s.underWater)) {
    const a = job();
    if (a && ok(a.key)) return { ...a, why: a.why + ' — прерываю ожидание ночи', preempt: true };
  }
  // Safety: interrupt own collection task if hostile mob appears nearby
  // Exception to the general "don't interrupt own task" rule (like go_base escape for fire/lava)
  if (run === 'collect_stone' && s.hostilesNear > 0) {
    const mob = (s.hostilesNear > 0 && s.hostile) ? s.hostile : null;
    if (mob && mob.d < T.hostileR) {
      if (s.hasWeapon && s.hp >= T.apFightHp) {
        return body('fight', 'fight', { target: mob.name, radius: T.fightRadius, flee_hp: T.apFleeHp, timeout: T.apFightTimeout },
          `безопасность: ${mob.name} рядом (${mob.d} м) — драюсь, а не собираю`);
      }
      return body('escape', 'escape', { distance: T.apEscapeDist, shelter: true },
        `безопасность: ${mob.name} рядом (${mob.d} m) — прекращаю сбор, отхожу в сторону`);
    }
  }
  if (run || s.task) return null; // свой навык идёт — не дёргать
  if (!s.idle) return null;       // мозг недавно командовал — ждём

  // 2. безопасность
  if ((s.inLava || s.suffocating || s.stuck || s.underWater) && ok('unstuck'))
    return body('unstuck', 'explore', { distance: T.unstuckDist }, s.inLava ? 'выбираюсь из лавы' : s.suffocating ? 'выбираюсь из блока' : s.underWater ? 'выплываю из воды' : 'выбираюсь: застрял');
  // А: «мало HP» — по последствию: встреча (с мобами рядом, а нет их — с обычным ночным мобом) проиграна и, не отбиваясь,
  // муха умрёт раньше, чем уйдёт или укроется (apReactSec). «Еле жива» — переживёт не больше одного удара. Без оценки — пороги.
  if (lowHpOf(s)) {
    const crit = (o ? o.hitsToDie != null && o.hitsToDie <= 1 : s.hp <= T.apCritHp) && !s.hasFood; // еле жива и есть нечего — наружу не ходим
    const dark = s.isNight || s.nightIn < T.nightSoonSec;   // ночью в поле не выходим: стены и ждать утра
    const waitLimitMs = 300000; // 5 мин ограничения ожидания
    const waitCount = (s.failInfo && s.failInfo.lowhp_waitCount) || 0;
    const shouldWait = waitCount * T.tickMs < waitLimitMs;
    // инкрементируем счетчик ожидания каждые ticks
    if (s.failInfo) s.failInfo.lowhp_waitCount = waitCount + 1;
    const fi = s.failInfo || {};
    const bad = k => !!(fi[k] && fi[k].count >= T.failSameCount); // эта тактика уже провалилась одинаково
    const need = T.apLowHpBlocks;                 // блоков надо на стены укрытия
    if (!s.sheltered) {
      // 1) лесенка (L003, не трогаем): блоки → укрытие. При crit наружу не ходим — только укрыться.
      if (!crit && s.blocks < need && !bad('lowhp_dirt') && ok('lowhp_dirt')) {
        // 1) блоки — раньше укрытия: без них shelter падает «блоков на стены мало»
        return body('lowhp_dirt', 'collect', { block: 'dirt', count: need - s.blocks }, `мало HP (${s.hp}) — беру блоки на укрытие`);
      }
      if (s.blocks >= need && !bad('lowhp_shelter') && ok('lowhp_shelter')) {
        // 2) укрыться; вниз копать нельзя (пещера/лава) — только стенами
        const why = (fi.lowhp_shelter && fi.lowhp_shelter.reason) || '';
        const dig = NO_DIG.test(why);
        return body('lowhp_shelter', 'shelter', dig ? { mode: 'walls' } : {}, `мало HP (${s.hp}) — укрываюсь${dig ? ' стенами (вниз копать нельзя)' : ''}`);
      }
      // 3) побег (L014) — только из открытого места, днём, с оружием и не crit. Из укрытия не бежим.
      if (s.hostilesNear > 0 && ok('lowhp_escape') && !bad('lowhp_escape') && !crit && !dark && s.hasWeapon)
        return body('lowhp_escape', 'escape', { distance: T.apLowHpEscapeDist, shelter: true },
          `мало HP (${s.hp}) — убегаю в поле на ${T.apLowHpEscapeDist} м (укрытия нет, оружие есть)`);
      // 4) одна и та же причина провала — сменить тактику: отойти в сторону (иначе тот же провал и та же пауза)
      const last = ((bad('lowhp_shelter') ? fi.lowhp_shelter : fi.lowhp_dirt) || fi.lowhp_shelter || {}).reason || 'укрытие не выходит';
      if (!crit && !(dark && s.hostilesNear > 0) && (bad('lowhp_dirt') || bad('lowhp_shelter') || bad('lowhp_escape')) && ok('lowhp_move'))
        return body('lowhp_move', 'explore', { distance: T.apLowHpMoveDist }, `мало HP (${s.hp}) — ${last} — отхожу в сторону`);
    }
    if (s.build && !crit) {
      // есть задача от мозга постройки — берем её, а не ждём низкого HP
      const buildT = buildAct();
      if (buildT) return buildT;
    }
    if (crit) {
      return null; // еле жива и есть нечего — наружу не ходим, ждём
    } else if (s.food < T.goBaseMinFood) {
      // еда меньше порога регенерации (REGEN_FOOD=18) — ждать бессмысленно, HP не вырастет
      // fall through to task selection below
    } else if (!shouldWait) {
      // время ожидания истекло (более 5 мин) — не ждать, а выбирать другое дело
      // fall through to task selection below
    } else {
      return null; // ждём (ест рефлекс) — в укрытии восстанавливаемся, наружу не идём
    }
  }
  const night = nightSoon;
  // L052 (смерть 23): ночью моб в hostileR или по муху били — «укрытие объявлено» ≠ «безопасно ждать»:
  // бой/стены/отход, а не wait_night и не яма (копка двух блоков 3-4 с — зомби успевает дойти и влезть).
  if (night && threat) {
    const a = nightDefense(false);
    return a; // все варианты защиты на паузе — жду (яму и ночную работу при мобе не начинаем)
  }

  // ---- В: дальше не очередь, а выбор по обстановке ----
  // У каждого дела — счёт: время суток (до ночи, ночь), голод, далеко ли база, цель мозга, удалось ли раньше.
  // Провал дела — минус к его счёту (apFailPenalty за каждый): берётся следующее дело, а не пауза; сбор и разведка
  // при повторе идут с другими параметрами (радиус/дальность больше). Выбирается дело с наибольшим счётом.
  const fiAll = s.failInfo || {};
  const tried = k => (fiAll[k] ? fiAll[k].count || 0 : 0);
  const cands = [];
  const add = (score, act) => { if (act && ok(act.key)) cands.push({ score: score - T.apFailPenalty * tried(act.key), act }); };
  const wider = (k, r0) => Math.min(96, r0 + 24 * tried(k)); // повтор сбора — шире радиус
  const pick = () => {
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return { ...cands[0].act, score: Math.round(cands[0].score), ...(cands.length > 1 ? { others: cands.slice(1, 4).map(c => `${c.act.key} ${Math.round(c.score)}`) } : {}) };
  };

  if (night) {
    // ночь: укрыться важнее всего (без укрытия ночью — мобы), потом польза (туннель), сон, переждать
    if (!s.sheltered) {
      if (s.blocks < T.nightBlocksMin && s.hostilesNear === 0) add(80, body('night_dirt', 'collect', { block: 'dirt', count: T.nightBlocksMin + 1 - s.blocks, radius: wider('night_dirt', 48) }, 'запасаю землю на укрытие'));
      // L052: яму (3-4 с) не начинаем, когда моб уже близко и сближается — тогда стены, отход или бой
      // v0.2: угрозы нет (иначе выше ночная защита) — простой снижает укрытие/ожидание
      if (s.hasPickaxe && s.hostilesNear === 0) add(Math.max(0, 75 - press), body('night_shelter_dig', 'shelter', { mode: 'dig' }, 'ночь: закапываюсь (мобов рядом нет)'));
      add(Math.max(0, 70 - press), body('night_shelter', 'shelter', {}, 'ночь: строю укрытие'));
    }
    if (s.phase === 'ночь' || s.phase === 'закат') add(50, learned('night_mine', 'night_mine', {}, 'копаю туннель ночью')); // упал со сбоем кода — его нет в выборе
    if (s.isNight && s.freeBed) add(Math.max(0, 45 + (s.hp < 20 || s.food < T.huntFood ? 10 : 0) - press), body('sleep', 'sleep', {}, 'сплю в кровати')); // ранена или голодна — сон полезнее
    // v0.2: цель мозга ночью — только у базы (без «База:» или вне радиуса — нет: ночью в поле не строим)
// Гейт: ночью с мобами рядом не начинаем дело — сначала укрытие/ожидание
    if (job && atBase && s.hostilesNear === 0) add(50 + press, job());
    // L052: wait_night только без врагов рядом и без свежих ударов (иначе выше сработала ночная защита)
    if (s.isNight) add(Math.max(0, 20 - press), body('wait_night', 'wait_night', { max_sec: T.waitNightSec }, 'пережидаю ночь'));
    return pick();
  }

  // день
  const duskSoon = s.nightIn != null && s.nightIn < T.apDuskSec; // до ночи мало — далеко не уходим, к базе спешим
  // после смерти — за вещами (лежат ~5 мин: самое срочное днём; если у места смерти враг — recover откажет сам)
  if (s.recoverable) add(60, body('recover', 'recover', {}, 'иду за вещами к месту смерти'));
  // база далеко: чем дальше и чем ближе ночь — тем важнее дойти. behavior_autopilot (заявка учителя, день 21):
  // дорога — не через огонь и лаву: до старта если снимок «горю»/в лаве — дорогу не начинаем; ночью (закат) при
  // HP < 8 или еде < 18 (без регенерации — REGEN_FOOD в lib/danger.js) тоже не начинаем, ждём (еда и HP вернутся);
  // дорогу ведёт выученный go_safe (лава/огонь/вода/край/HP/ночь), нет включённого — прежние ноги с присмотром выше.
  const farBase = s.base && s.baseDist != null && s.baseDist > s.base.r;
  if (farBase) {
    // переход на базу только сейчас не вышел — дальше от базы не уходим (только за вещами), ждём следующей попытки
    if (!ok('go_base')) return pick();
    const nightRoad = s.isNight || (s.nightIn != null && s.nightIn < T.apDuskSec);
    const dirtyRoad = s.onFire || s.inLava || (nightRoad && (s.hp < T.goBaseMinHp || s.food < T.goBaseMinFood) || (nightRoad && s.hostilesNear > 0));
    // дорогу не начинаем — тела не отдаём ей, берём следующее дело (лава/горю лечит самозащита, ночью еда и вернутся),
    // а после добавления остальных дел решаем, чем заняться
    if (!dirtyRoad) {
      const act = s.goSafe
        ? learned('go_base', 'go_safe', { x: s.base.x, y: s.base.y, z: s.base.z, max_sec: T.goSafeMaxSec }, 'иду на базу осторожно (go_safe)')
        : body('go_base', 'goto', { x: s.base.x, y: s.base.y, z: s.base.z, r: s.base.r, timeout: T.baseTimeoutSec }, 'иду на базу');
      add(45 + Math.min(25, (s.baseDist - s.base.r) / 8) + (duskSoon ? 20 : 0), act);
    }
  }
  // цель мозга (строка «Автопилот:» в notes.md); провал — пауза goalRetryMs (goalFailed), выполнена — goalDone; v0.2: + давление простоя
  // v0.2: «Постройка:» — на том же месте в выборе, что цель мозга (и главнее строки «Автопилот:»)
  if (job) add(50 + press, job());
  // длинная дневная работа: до ночи не успеет — счёт ниже
  add(35 - (s.nightIn != null && s.nightIn < T.dayRoutineSec ? 10 : 0), learned('day_routine', 'day_routine', { max_sec: T.dayRoutineSec }, 'дневная работа (day_routine)'));
  // голод: чем меньше сытость (а еды нет), тем важнее охота — голодная муха охотится раньше цели мозга
  if (s.food < T.huntFood && !s.hasFood && s.animals > 0) add(20 + (T.huntFood - s.food) * 3, body('hunt', 'hunt', { count: T.huntCount }, 'охочусь: нечего есть'));
  // золото: сначала собираем бревно, потом кнущим кирку, потом камень
  // когда нет кирки — сначала собрать logs, а не сразу идти к камню
  if (!s.hasPickaxe) {
    if (s.logs < T.needLogs) add(28, body('collect_log', 'collect', { block: 'log', count: T.logCount, ...(tried('collect_log') ? { radius: wider('collect_log', 48) } : {}) }, 'рублю дерево'));
    if (s.logs >= T.pickLogs) add(30, body('craft_pick', 'craft', { item: 'wooden_pickaxe' }, 'делаю деревянную кирку'));
  }
  // если кирка есть — собираем камень
  const edgeHazard = s.snapshot?.hazards?.includes('обрыв') || s.survey?.edges?.some(e => e.drop >= 3);
  const duskNoWeapon = duskSoon && !s.hasWeapon; // на закате без оружия за камнем далеко не идём
  if (s.hasPickaxe && s.cobble < T.cobbleWant && !edgeHazard && !duskNoWeapon) {
    const far = tried('collect_stone') ? { radius: wider('collect_stone', 48) } : {};
    add(26, body('collect_stone', 'collect', { block: 'stone', count: T.stoneCount, ...far },
      duskSoon && !s.hasWeapon ? 'сбор на закате без оружия отложен' : 'добиваю камень'));
  }
  // если обрыв — сбор не начинаем, оставляем следующий кандидат или тихо ждем
  if (edgeHazard && s.snapshot?.hazards?.includes('обрыв') && !s.running) add(0, body('explore', 'explore', { distance: 8 }, 'обрыв рядом — не начинаю сбор, исследую другое место'));
  // разведка — когда больше нечего; перед ночью — ближе
  add(10, body('explore', 'explore', { distance: duskSoon ? Math.round(T.exploreDist / 2) : T.exploreDist + 24 * tried('explore') }, 'исследую окрестности'));
  return pick();
}

// ---------- HTTP к исполнителю выученных навыков ----------
function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(new Error('исполнитель ответил не JSON')); } });
      res.on('error', reject);
    });
    req.on('error', e => reject(new Error('исполнитель недоступен: ' + (e.code || e.message))));
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('тайм-аут')));
    if (data) req.write(data);
    req.end();
  });
}
async function runnerActive() {
  try { const h = await httpJson('GET', RUNNER + '/health', undefined, 1500); return h && h.runner ? h.runner.active : null; }
  catch (e) { return null; }
}
function runnerGo(name, params, timeoutSec) {
  const q = new URLSearchParams({ name, wait: '1', timeout_sec: String(timeoutSec) });
  for (const [k, v] of Object.entries(params || {})) q.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return httpJson('GET', RUNNER + '/go?' + q.toString(), undefined, (timeoutSec + 60) * 1000);
}
const runnerAbort = () => httpJson('POST', RUNNER + '/abort', {}, 3000);
const runnerEnable = (name) => httpJson('POST', RUNNER + '/enable', { name }, 4000);

// состояние навыка в исполнителе (enabled / disabledReason / consecutiveFails) — только чтение
async function skillState(name) {
  try {
    const r = await httpJson('GET', RUNNER + '/skills', undefined, 8000);
    const s = (r && r.skills || []).find(x => x.name === name);
    return s || null;
  } catch (e) { return null; }
}

// ---------- Уступка мозгу (L013) ----------
// что делать с выученным навыком, когда пришла команда мозга: {kill, why}
// короткая команда — тело отдаст её сама (вытеснит текущую задачу навыка), убивать навык незачем;
// длинная — она сама займёт тело надолго, навык освобождаем (но честно: с причиной «уступка мозгу»)
function yieldPlan(action) {
  const a = norm(action);
  if (READONLY.has(a)) return { kill: false, why: 'только читает — тело не занимает' };
  if (SHORT_BRAIN.has(a)) return { kill: false, why: 'короткая команда — тело отдаст её сама' };
  return { kill: true, why: 'долгая команда мозга — тело нужно ему надолго' };
}

// уступка мозгу (а не провал навыка): мы сами прервали навык ради команды мозга, либо тело/исполнитель
// заняты командой мозга (навык не успел закончить). Уступка должна быть свежей — иначе это обычный провал.
function isBrainYield(run, err) {
  if (!run || !run.brainYield) return false;
  if (run.aborting && /команда мозга|уступка мозгу/.test(String(run.aborting))) return true;
  if (!err || !BRAIN_ERR.test(err)) return false;
  const at = Number(run.brainYield.at) || 0;
  return !at || Date.now() - at <= T.apYieldFreshMs;
}

// тело сейчас занято мозгом — убивать навык нельзя: его 'stop' убьёт и команду мозга
function brainHoldsBody(ctx) {
  const tm = ctx && ctx.tasks; if (!tm) return false;
  const cur = tm.current;
  if (cur && cur.source === 'brain' && !/^skill:/.test(String(cur.by || ''))) return true;
  if (tm.legacyBusy > 0 && tm.legacy && tm.legacy.by === 'brain') return true;
  return false;
}

// чистый итог запуска: различаем «прерван по требованию мозга» и «провалился сам» (L013)
function verdictOf(run, err) {
  if (err && /выключен|не найден/.test(err)) return 'навык выключен';
  if (isBrainYield(run, err)) {
    const a = String((run && run.brainYield && run.brainYield.action) || '');
    return a === 'owner' ? 'прерван по требованию хозяина' : 'прерван по требованию мозга';
  }
  if (run && run.aborting) return 'прерван автопилотом';
  if (err && /POST \/abort/.test(err)) return 'прерван мозгом';
  if (err && /занят/.test(err)) return 'тело/исполнитель заняты';
  if (!err) return 'ok';
  return 'провал';
}

// пауза после побега (L014): тот же побег сразу не зовём. В: не оторвались — долгой паузы нет: провал идёт в причины
// (failInfo «не оторвался»), и в следующий раз берётся другая тактика (отойти в сторону, укрытие), а не тот же побег
function escapePause(key, grew) {
  if (key === 'lowhp_escape') return T.apEscapeCooldownMs;
  return grew ? T.apPlayerEscapeCooldownMs : T.apEscapeCooldownMs;
}

// сбой кода навыка (в ошибке — файл и строка), а не отказ о мире: тот же вызов упадёт так же
const isCodeCrash = err => CODE_ERR.test(String(err || ''));

// пауза после провала. В: долгих пауз (5 мин) нет — одна и та же причина или много провалов подряд дают не больше минуты,
// а главное — минус к счёту этого дела в decide (берётся следующее дело или тот же сбор с другими параметрами)
function failPause(kind, err, same, count, n) {
  if (kind === 'learned' && /выключен|не найден/.test(err)) return 600000; // навык выключен мозгом — ждём, пока включит
  if ((same && count >= T.failSameCount) || n >= FAIL_MAX) return BACKOFF_MS;
  return 4000;
}

// навыки, упавшие со сбоем кода: автопилот их не зовёт, пока файл навыка тот же (тот же код упадёт так же).
// В: не 30 минут — запись снимается, как только файл навыка поменялся (мозг поправил/выложил версию)
const LEARNED_DIR = path.join(process.env.FLYBOT_CORE || path.join(__dirname, '..'), 'brain', 'learned');
const learnedMtime = name => { try { return fs.statSync(path.join(LEARNED_DIR, name + '.js')).mtimeMs; } catch (e) { return null; } };
function crashList(ap, now, mtimeOf = learnedMtime) {
  const out = {};
  for (const [k, v] of Object.entries(ap.codeCrash || {})) {
    if (v.mtime !== undefined && mtimeOf(k) !== v.mtime) delete ap.codeCrash[k]; // файл поменялся — пробуем снова
    else out[k] = v;
  }
  return out;
}

// ---------- Состояние мира для decide ----------
const baseDimOk = bot => String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '') === 'overworld';
// причины последних провалов автопилота; протухшие (давно не повторялись) забываем
function failInfoOf(ap, now) {
  const out = {};
  for (const [k, v] of Object.entries(ap.failInfo || {})) {
    if (now - v.t > T.failReasonTtlMs) delete ap.failInfo[k];
    else out[k] = { reason: v.reason, count: v.count };
  }
  return out;
}
// v0.2: цель мозга для decide — провал: пауза goalRetryMs, затем повтор с count/n/кол-во вдвое меньше (ap.goalDiv, не меньше 1);
// выполнена: снова через goalRepeatMs (следующий шаг стройки), но выполнена без нового блока (goalEmpty) — до новой строки нет
const STEP_KEYS = ['count', 'n', 'кол-во'];
function stepParams(params, div) {
  if (!(div > 1)) return params;
  const out = { ...params };
  for (const k of STEP_KEYS) if (typeof out[k] === 'number' && out[k] > 0) out[k] = Math.max(1, Math.floor(out[k] / div));
  return out;
}
function goalState(ap, now) {
  const g = ap.goal;
  if (!g) return { goal: null, goalDone: false, goalFailed: false };
  const div = ap.goalDivSig === g.sig ? ap.goalDiv || 1 : 1;
  return {
    goal: div > 1 ? { ...g, params: stepParams(g.params, div) } : g,
    goalDone: ap.goalDone === g.sig && (ap.goalEmpty === g.sig || now - (ap.goalDoneAt || 0) < T.goalRepeatMs),
    goalFailed: !!(ap.goalFail && ap.goalFail.sig === g.sig && now - (ap.goalFail.at || 0) < T.goalRetryMs)
  };
}
// итог запуска цели: verdict 'ok' | 'провал' (прочее — null); progressed — за запуск встал хоть один блок стройки (ctx.lastProgressAt)
function goalAfter(ap, run, verdict, reason, now, progressed) {
  if (verdict === 'ok') {
    ap.goalDone = run.sig; ap.goalDoneAt = now; ap.goalFail = null; ap.goalDiv = 1; ap.goalDivSig = null;
    ap.goalEmpty = progressed ? null : run.sig; // без прогресса — пустой круг, до новой строки не повторяем
    return progressed ? `цель ${run.name}: шаг сделан — следующий через ${Math.round(T.goalRepeatMs / 1000)} с`
      : `цель ${run.name}: выполнена, нового блока нет — не повторяю до новой цели`;
  }
  if (verdict === 'провал') {
    ap.goalFail = { sig: run.sig, name: run.name, reason, at: now };
    const div = ap.goalDivSig === run.sig ? ap.goalDiv || 1 : 1;
    ap.goalDiv = div * 2; ap.goalDivSig = run.sig;
    return `цель ${run.name}: провал (${reason}) — повтор через ${Math.round(T.goalRetryMs / 1000)} с, шаг вдвое меньше`;
  }
  return null;
}

// ---------- v0.2 «Постройка:» — муха строит сама ----------
// ap.build — строка из notes.md {name,x,y,z,rot,sig}; ap.buildSt — как идёт эта строка:
// {sig, need:{предмет:n}|null (добрать), gathers (доборов без нового блока), pauseUntil, reason, done, doneAt}
const BUILD_KEYS = new Set(['build', 'build_go', 'build_gather']);
const newBuildSt = sig => ({ sig, need: null, gathers: 0, pauseUntil: 0, reason: null, done: false, doneAt: 0 });
const lackStr = m => Object.entries(m || {}).map(([k, n]) => `${k} ×${n}`).join(', ');
// недостающий материал из итога build_blueprint: поле missing (оно точнее), иначе текст «не хватает: a ×n, b ×m»
// (смета до стройки) или «не достроено: … не хватило: a ×n» (кончилось по ходу)
function lackOf(err, result) {
  const out = {};
  const m = result && result.missing;
  if (m && typeof m === 'object') for (const [k, n] of Object.entries(m)) if (Number(n) > 0) out[k] = Math.ceil(Number(n));
  if (Object.keys(out).length) return out;
  const t = /не (?:хватает|хватило):\s*([^;\n]+)/.exec(String(err || ''));
  if (t) for (const q of t[1].matchAll(/([a-z0-9_]+)\s*[×x]\s*(\d+)/gi)) out[q[1]] = Number(q[2]);
  return out;
}
// постройка для decide: готова или на паузе — её нет (в выборе другие дела); иначе со списком добора
function buildState(ap, now) {
  const b = ap.build, st = ap.buildSt;
  if (!b || !st || st.sig !== b.sig || st.done || now < (st.pauseUntil || 0)) return { build: null };
  return { build: { ...b, need: st.need && Object.keys(st.need).length ? { ...st.need } : null } };
}
// итог запуска дела постройки (verdict 'ok' | 'провал'): -> {note, done?} | null. Мозг тут не будится — всё решает муха.
function buildAfter(ap, run, verdict, err, result, now, progressed) {
  const st = ap.buildSt, b = ap.build;
  // строка сменилась, пока шёл навык, или постройка уже готова (build_done был) — ничего не меняем
  if (!st || !b || st.done || st.sig !== run.sig || (verdict !== 'ok' && verdict !== 'провал')) return null;
  const why = String(err || 'провал').split('\n')[0].slice(0, 120);
  const pause = text => {
    st.pauseUntil = now + T.buildRetryMs; st.reason = text; st.need = null; st.gathers = 0;
    return { note: `постройка ${b.name}: ${text} — повтор через ${Math.round(T.buildRetryMs / 1000)} с` };
  };
  if (progressed) st.gathers = 0;
  if (run.key === 'build') {
    if (verdict === 'ok') {
      st.done = true; st.doneAt = now; st.need = null; st.reason = null;
      return { note: `постройка ${b.name}: готово — все клетки стоят`, done: true };
    }
    const lack = lackOf(err, result);
    if (Object.keys(lack).length) {
      if (st.gathers >= T.buildGatherMax) return pause(`добор не помогает (${st.gathers} раз без нового блока), не хватает ${lackStr(lack)}`);
      // ИТОГ для добора — need из ответа build_blueprint (сколько всего нужно в сумке), а не дельта missing
      const totalNeed = result && result.need && typeof result.need === 'object' ? result.need : lack;
      st.need = totalNeed; st.reason = null;
      return { note: `постройка ${b.name}: не хватает ${lackStr(lack)} — добираю до ${lackStr(totalNeed)}` };
    }
    return pause(`провал (${why})`);
  }
  if (run.key === 'build_gather') {
    st.gathers++;
    const hasResult = result && typeof result === 'object' && ('collected' in result || 'crafted' in result);
    const got = hasResult && (Object.keys(result.collected || {}).length || Object.keys(result.crafted || {}).length);
    if (verdict === 'ok' && (!hasResult || got)) {
      st.need = null;
      const added = hasResult ? Object.entries({ ...result.collected, ...result.crafted }).map(([k, n]) => `${k}+${n}`).join(', ') : 'предметы добавлены';
      return { note: `постройка ${b.name}: добор сделал (${added}) — строю снова` };
    }
    // пустой добор: честная пауза с причиной, не повторяем тот же вызов — оставляем need, чтобы перестройка вернула тот же список
    const haveStr = hasResult && result.have ? lackStr(result.have) : '?';
    const needStr = st.need ? lackStr(st.need) : '?';
    // st.need НЕ сбрасываем — перестройка после паузы вернёт тот же итог, gather не вызовется повторно до прогресса или buildGatherMax
    st.pauseUntil = now + T.buildRetryMs; st.reason = `добор ничего не дал (${haveStr}, нужно ${needStr}) — смена тактики`; // st.need не трогаем, st.gathers не сбрасываем
    return { note: `постройка ${b.name}: ${st.reason} — повтор через ${Math.round(T.buildRetryMs / 1000)} с` };
  }
  if (run.key === 'build_go') return verdict === 'ok' ? null : pause(`не дошла до места (${why})`);
  return null;
}
// состояние постройки для /snapshot → autopilot (видят аудит и учитель)
function buildStatus(ap, now) {
  const b = ap.build; if (!b) return null;
  const st = ap.buildSt && ap.buildSt.sig === b.sig ? ap.buildSt : newBuildSt(b.sig);
  const run = ap.running && BUILD_KEYS.has(ap.running.key) ? ap.running.key : null;
  let status;
  if (st.done) status = 'готово';
  else if (now < (st.pauseUntil || 0)) status = `пауза до ${new Date(st.pauseUntil).toTimeString().slice(0, 8)} (${st.reason})`;
  else if (run === 'build_go') status = 'иду к месту';
  else if (st.need && Object.keys(st.need).length) status = 'добираю ' + lackStr(st.need);
  else status = run === 'build' ? 'строю' : 'строю (сейчас другое дело)';
  return { name: b.name, at: [b.x, b.y, b.z], rot: b.rot, status };
}

function gather(ctx, ap) {
  const bot = ctx.bot;
  const now = Date.now();
  const p = bot.entity.position;
  const items = bot.inventory.items();
  const sum = re => items.filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0);
  let FOOD_BL = new Set(); try { FOOD_BL = require('./reflexes').FOOD_BLACKLIST; } catch (e) {}
  const foods = bot.registry.foodsByName || {};
  const head = bot.blockAt(p.offset(0, 1.6, 0)); const feet = bot.blockAt(p);
  const ents = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position);
  // L052: мобов помним как сущности (имя и расстояние), а не только счёт — ночная защита отвечает за мобов
  const hostiles = ents.filter(e => isHostile(e)).map(e => ({ name: entName(e), id: e.id, d: r1(e.position.distanceTo(p)) })).sort((a, b) => a.d - b.d);
  const hostilesIn = hostiles.filter(h => h.d <= T.hostileR);
  const enemies = threats.list(ctx).filter(t => t.d <= ENEMY_R).map(t => ({ ...t, aggressor: AG.isAggressor(ctx, t.name) }));
  let freeBed = false;
  try {
    const bedIds = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id);
    freeBed = vision.find(ctx, bedIds, { radius: 32, count: 20 }).map(q => bot.blockAt(q))
      .some(b => b && !(b.getProperties && b.getProperties().occupied));
  } catch (e) {}
  let sheltered = false; try { sheltered = L('skills/survival').isSheltered(bot); } catch (e) {}
  const ti = timeInfo(bot);
  const cur = ctx.tasks.current;
  const ld = ctx.lastDeath;
  const blocked = {};
  for (const [k, t] of Object.entries(ap.until)) if (t > now) blocked[k] = true;
  return {
    on: ap.on, idle: now - Math.max(ap.lastBrainCmd, ap.lastBusy) >= IDLE_MS && now >= (ap.pausedUntil || 0), // pausedUntil — «стой» хозяина (lib/owner.js)
    task: cur ? { name: cur.name, source: cur.source } : null,
    running: ap.running ? { key: ap.running.key, name: ap.running.name, kind: ap.running.kind } : null, runnerOther: ap.runnerOther,
    hp: Math.round(bot.health), food: bot.food,
    outlook: (() => { try { return D.outlook(bot); } catch (e) { return null; } })(), // А: чем кончится встреча с мобами (lib/danger.js)
    hasFood: items.some(i => foods[i.name] && !FOOD_BL.has(i.name) && !i.name.endsWith('_bucket')),
    hasWeapon: items.some(i => /_sword$|_axe$/.test(i.name)),
    hasPickaxe: items.some(i => /_pickaxe$/.test(i.name)),
    blocks: items.filter(i => isBuildBlock(i.name) && !i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0),
    logs: sum(/_(log|stem)$/) + Math.floor(sum(/_planks$/) / 4), cobble: sum(/^(cobblestone|cobbled_deepslate)$/),
    phase: ti.phase, isNight: ti.isNight, nightIn: ti.nightIn, sheltered,
    inLava: [feet, head].some(b => b && b.name === 'lava'),
    // снимок «горю» (заявка учителя, день 21): флаг «on fire» из метадаты — так же, как lib/perception.js и lib/danger.js
    onFire: (v => typeof v === 'number' && (v & 1) === 1)((bot.entity.metadata || [])[0]),
    suffocating: !!head && A.isSolid(head) && head.boundingBox === 'block',
    stuck: ap.stuckSince > 0 && now - ap.stuckSince > T.stuckMs,
    underWater: ap.wetSince > 0 && now - ap.wetSince > T.underWaterMs,
    hostilesNear: hostilesIn.length,
    hostile: hostilesIn[0] || null, // ближайший враждебный моб в hostileR — ночью для защиты (L052)
    hitRecent: !!(ap.lastHit && now - ap.lastHit <= T.apHitFreshMs), // по муху били недавно (урон между тиками)
    enemies, alone: hostiles.filter(h => h.d <= T.aloneR).length === 0 && enemies.filter(e => e.d <= T.aloneEnemyR).length <= 1,
    freeBed, animals: ents.filter(e => isAnimal(e) && GAME.includes(entName(e)) && e.position.distanceTo(p) <= T.animalsR).length,
    recoverable: !!(ld && ld.at && now - ld.ts < T.recoverMs && ap.recoverFor !== ld.ts),
    blocked, failInfo: failInfoOf(ap, now),
    ...goalState(ap, now), // цель мозга: пауза после провала/успеха, шаг после провала (v0.2)
    ...buildState(ap, now), // v0.2 «Постройка:»: в работе (не готова, не на паузе) и что добрать
    buildDist: ap.build ? Math.hypot(ap.build.x - p.x, ap.build.z - p.z) : null,
    idleBuildMin: ctx.daylog && ctx.daylog.idleMin ? ctx.daylog.idleMin() : 0, // v0.2: минуты без блока стройки
    crashed: crashList(ap, now),
    base: ap.base || null, baseDist: ap.base && baseDimOk(bot) ? Math.hypot(ap.base.x - p.x, ap.base.z - p.z) : null,
    // go_safe включён у исполнителя? — дорогу к базе ведёт он (заявка учителя, день 21); не проверили/выключен — нет
    goSafe: !!ap.goSafe
  };
}

// ---------- Подключение ----------
function create(ctx) {
  const ap = {
    on: true, lastBrainCmd: Date.now(), lastBusy: 0, running: null, runnerOther: false,
    goal: null, goalDone: null, goalMtime: -1, base: null, baseSig: '', goalSkills: { t: 0, names: new Set(), enabled: {} },
    goSafe: false, goSafeT: 0, // go_safe включён у исполнителя? — раз в 30 с узнаём (дорогу к базе ведёт он, заявка 21.10)
    goalFail: null,   // проваленная цель мозга: {sig, name, reason, at} — повтор через goalRetryMs (v0.2)
    goalDiv: 1, goalDivSig: null, // шаг цели после провалов: count/n делим на goalDiv
    goalDoneAt: 0, goalEmpty: null, // выполнена когда; выполнена без прогресса (sig) — не повторяем
    goalFailNote: null, // что написать в журнал про проваленную цель (сразу после строки о провале)
    build: null, buildSt: null, // v0.2 «Постройка:» из notes.md и как она идёт (newBuildSt)
    codeCrash: {},    // навыки, упавшие со сбоем кода: {навык: {reason, at}} — автопилот их не зовёт
    _mod: MOD, fails: {}, failInfo: {}, until: {}, lastChat: 0, recoverFor: 0, stuckSince: 0, wetSince: 0, lastPos: null, ticking: false, history: [],
    lastHp: null, // HP на прошлом тике: упало — по муху били (ap.lastHit), ночью тогда не wait_night (L052)
    lastHit: 0,   // последний урон: свежий apHitFreshMs — блокирует wait_night и ямы (L052, смерть 23)
    yields: 0, yieldWatch: null
  };
  const note = (text, chat) => {
    ctx.events.push('info', { msg: 'автопилот: ' + text, autopilot: true });
    if (chat && Date.now() - ap.lastChat >= CHAT_MS && ctx.statusChat) { ap.lastChat = Date.now(); ctx.statusChat('автопилот: ' + text, true); }
  };

  // расстояние до ближайшего враждебного моба (null — мобов нет): нужно, чтобы честно оценить побег
  const hostileD = () => {
    try {
      const bot = ctx.bot; if (!bot || !bot.entity) return null;
      const p = bot.entity.position;
      let best = null;
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position || !isHostile(e)) continue;
        const d = e.position.distanceTo(p);
        if (best === null || d < best) best = d;
      }
      return best;
    } catch (e) { return null; }
  };

  // навык выключили из-за прерываний (disabledReason про «POST /abort» или «вытеснен командой мозга») —
  // вернуть его в работу (L013): это не настоящий провал навыка
  const reenable = name => {
    runnerEnable(name).then(
      r => note(`навык ${name} ${r && r.ok ? 'снова включён' : 'не включён: ' + String((r && r.error) || 'ошибка').slice(0, 120)}`),
      e => note(`не смог включить ${name}: ${e.message}`)
    );
  };

  // намеренная уступка мозгу не должна стоять навыку его счёта провалов (L013):
  // POST /enable обнуляет consecutiveFails (runner.js:369). Навык, выключенный вручную или авто не из-за
  // прерываний, не трогаем — там провалы настоящие.
  const resetFails = async (name, why) => {
    if (!name) return;
    try {
      const st = await skillState(name);
      const reason = st ? String(st.disabledReason || '') : '';
      const autoByInterrupt = /^авто:/.test(reason) && INTERRUPT_ERR.test(reason);
      if (st && st.enabled === false && !autoByInterrupt) {
        note(`навык ${name} выключен (${reason || 'вручную'}) — счётчик провалов не трогаю`);
        return;
      }
      const was = st && typeof st.consecutiveFails === 'number' ? st.consecutiveFails : null;
      const r = await runnerEnable(name);
      if (r && r.ok) note(`${why} (навык ${name} прерван, счётчик провалов сброшен${was ? `, было ${was}` : ''})`);
      else note(`навык ${name}: счётчик провалов НЕ сброшен: ${String((r && r.error) || 'ошибка').slice(0, 120)}`);
    } catch (e) {
      note(`навык ${name}: не смог сбросить счётчик провалов: ${e.message}`);
    }
  };

  // сбой кода навыка: навык не виноват (падает не из-за мира), а мы его повторять не будем — счётчик провалов
  // исполнителя сбрасываем, чтобы рабочий навык не выключился авто из-за наших же запусков (выключенный — не трогаем)
  const clearFailsAfterCrash = async (name, reason) => {
    if (!name) return;
    try {
      const st = await skillState(name);
      if (st && st.enabled === false) {
        note(`навык ${name} выключен (${String(st.disabledReason || '') || 'вручную'}) — жду, пока включит мозг`);
        return;
      }
      const was = st && typeof st.consecutiveFails === 'number' ? st.consecutiveFails : null;
      const r = await runnerEnable(name);
      if (r && r.ok) note(`навык ${name}: сбой кода (${reason}) — счётчик провалов сброшен${was ? `, было ${was}` : ''}, жду правки от мозга`);
      else note(`навык ${name}: счётчик провалов НЕ сброшен: ${String((r && r.error) || 'ошибка').slice(0, 120)}`);
    } catch (e) {
      note(`навык ${name}: не смог сбросить счётчик провалов после сбоя кода: ${e.message}`);
    }
  };

  // «жду» при низком HP — в журнал (раз в минуту): видно, что автопилт не бежит, а стоит
  let lastWait = 0;
  const noteWait = st => {
    const now = Date.now();
    if (now - lastWait < 60000) return;
    lastWait = now;
    note(`мало HP (${st.hp}) — жду (${st.sheltered ? 'в укрытии' : 'без укрытия'}${st.hasFood ? '' : ', еды нет'})`);
  };

  // L052: моб рядом ночью, а укрытие есть и ударов нет — честно пишем (раз в минуту), что стоим в укрытии,
  // а не молчим: wait_night при мобе рядом всё равно не берём
  let lastThreatNote = 0;
  const noteThreatWait = st => {
    const now = Date.now();
    if (now - lastThreatNote < 60000) return;
    lastThreatNote = now;
    note(`мобы рядом ночью${st.hostile ? ` (${st.hostile.name} ${st.hostile.d} м)` : ''} — жду в укрытии${st.hitRecent ? ', по муху били — укрытия нет, жду паузу после отхода' : ''}`);
  };

  // цель мозга из notes.md (кэш по mtime); learned — если такой навык есть в исполнителе, иначе навык тела
  async function refreshGoal() {
    // go_safe включён у исполнителя? (заявка учителя, день 21) — раз в 30 с; не проверили (исполнитель молчит) — нет
    if (Date.now() - ap.goSafeT > 30000) {
      ap.goSafeT = Date.now();
      ap.goSafe = false;
      try {
        const r = await httpJson('GET', RUNNER + '/skills', undefined, 1500);
        const s = (r && r.skills || []).find(x => x.name === 'go_safe');
        ap.goSafe = !!(s && s.enabled !== false);
      } catch (e) {}
    }
    let mt = 0; try { mt = fs.statSync(NOTES).mtimeMs; } catch (e) { ap.goal = null; ap.base = null; ap.build = null; return; }
    if (mt !== ap.goalMtime) {
      ap.goalMtime = mt;
      let g = null, txt = ''; try { txt = fs.readFileSync(NOTES, 'utf8'); g = parseGoal(txt); } catch (e) {}
      ap.base = parseBase(txt);
      // v0.2: новая строка «Постройка:» — всё сначала (пауза, добор, «готово» — про прежнюю строку)
      const bl = parseBuild(txt);
      if (bl && (!ap.buildSt || ap.buildSt.sig !== bl.sig)) {
        ap.buildSt = newBuildSt(bl.sig);
        for (const k of BUILD_KEYS) { delete ap.until[k]; delete ap.failInfo[k]; ap.fails[k] = 0; }
      }
      ap.build = bl;
      const bsig = ap.base ? `${ap.base.x} ${ap.base.y} ${ap.base.z} ${ap.base.r}` : '';
      if (bsig !== ap.baseSig) { ap.baseSig = bsig; delete ap.until.go_base; ap.fails.go_base = 0; } // новая база — пауза не действует
      // новая строка «Автопилот:» — новая попытка: проваленную цель можно пробовать снова
      if (!ap.goal || !g || g.sig !== ap.goal.sig) {
        delete ap.until.goal; ap.fails.goal = 0; ap.goalFail = null; ap.goalDiv = 1; ap.goalDivSig = null; ap.goalEmpty = null;
        if (g && g.name) delete ap.codeCrash[g.name]; // сбой кода этого навыка — тоже новая попытка
      }
      ap.goalRaw = g;
    }
    const g = ap.goalRaw;
    if (!g) { ap.goal = null; return; }
    const bodyName = (ctx.skillNames || []).find(k => norm(k) === norm(g.name));
    if (Date.now() - ap.goalSkills.t > 30000) {
      ap.goalSkills.t = Date.now();
      try {
        const r = await httpJson('GET', RUNNER + '/skills', undefined, 1500);
        const list = (r && r.skills) || [];
        ap.goalSkills.names = new Set(list.map(x => x.name));
        const prev = ap.goalSkills.enabled || {};
        const now = {};
        for (const x of list) now[x.name] = x.enabled !== false;
        ap.goalSkills.enabled = now;
        // мозг включил навык, который был выключен (явный enable) — проваленную цель можно пробовать снова
        const gf = ap.goalFail;
        if (gf && gf.name && prev[gf.name] === false && now[gf.name] === true) {
          ap.goalFail = null;
          note(`цель ${gf.name}: навык включён мозгом — пробую цель снова`);
        }
      } catch (e) {}
    }
    if (ap.goalSkills.names.has(g.name)) ap.goal = { ...g, kind: 'learned' };
    else if (bodyName) ap.goal = { ...g, name: bodyName, kind: 'body' };
    else ap.goal = null;
  }

  // освободить тело: прервать свой текущий навык (и выученный навык в исполнителе) и дождаться, пока он отпустит тело
  ap.yieldAll = async reason => {
    const run = ap.running; if (!run) return;
    run.aborting = reason || 'прервано';
    if (run.kind === 'learned') {
      // сначала освобождаем тело: навык сам увидит причину и закончится честно («уступка мозгу: …»), а не молча
      const cur = ctx.tasks.current;
      if (cur && cur.source === 'autopilot') { try { await ctx.tasks.stop(reason || 'автопилот'); } catch (e) {} }
      await Promise.race([run.promise, sleep(T.apYieldGraceMs)]);
      // навык тело не отпустил (спит или зовёт другой навык) — убиваем процесс; но если тело уже занято мозгом — не трогаем:
      // 'stop' от исполнителя убил бы и команду мозга
      if (ap.running === run && !brainHoldsBody(ctx)) {
        try { await runnerAbort(); } catch (e) {}
        await Promise.race([run.promise, sleep(6000)]);
      }
    } else {
      const cur = ctx.tasks.current;
      if (cur && cur.source === 'autopilot') await ctx.tasks.stop(reason || 'автопилот');
      await Promise.race([run.promise, sleep(3000)]);
    }
  };

  // вызывает bot.js на каждую команду мозга (/cmd, /do), ДО выполнения команды
  ap.brainCommand = async action => {
    ap.lastBrainCmd = Date.now();
    if (READONLY.has(norm(action))) return;
    const run = ap.running;
    if (!run || run.kind !== 'learned') return; // навык тела вытесняет тело само (lib/tasks.js)
    const plan = yieldPlan(action);
    run.brainYield = { action: String(action || ''), at: Date.now() };
    ap.yields = (ap.yields || 0) + 1;
    if (!plan.kill) {
      // короткая команда мозга: тело отдаст её сама (вытеснит текущую задачу навыка) — навык не убиваем
      note(`уступаю мозгу: ${action} (навык ${run.name} не убиваю — ${plan.why})`);
      ap.yieldWatch = { name: run.name, action: String(action || ''), at: Date.now() };
      return;
    }
    // долгая команда мозга: тело нужно ему надолго — освобождаем (счётчик провалов сбросим после)
    note(`уступаю мозгу: ${action} (навык ${run.name} освобождает тело — ${plan.why})`);
    await ap.yieldAll('уступка мозгу: ' + action);
  };
  // команды без User-Agent (node) идут от исполнителя; пока он выполняет навык автопилота — это команды автопилота
  ap.ownsRunner = () => !!(ap.running && ap.running.kind === 'learned');
  ap.setOn = async on => {
    ap.on = !!on;
    if (!ap.on) await ap.yieldAll('автопилот выключен');
    // явный enable (автопилот включили снова) — проваленную цель можно пробовать снова
    if (ap.on && ap.goalFail) { note(`цель ${ap.goalFail.name}: автопилот включён снова — пробую цель`); ap.goalFail = null; }
    note(ap.on ? 'включён' : 'выключен');
    return ap.status();
  };
  ap.status = () => ({
    on: ap.on, active: !!ap.running, doing: ap.running ? ap.running.why : null,
    ...(ap.running ? { skill: ap.running.name, kind: ap.running.kind, sec: Math.round((Date.now() - ap.running.started) / 1000) } : {}),
    idleSec: Math.round((Date.now() - Math.max(ap.lastBrainCmd, ap.lastBusy)) / 1000),
    yields: ap.yields || 0,
    build: buildStatus(ap, Date.now()), // v0.2 «Постройка:»: имя, место, статус (строю / добираю / пауза до … / готово)
    ...(ap.goalFail ? { goalFailed: `${ap.goalFail.name}: повтор через ${Math.max(0, Math.round((ap.goalFail.at + T.goalRetryMs - Date.now()) / 1000))} с (${ap.goalFail.reason})` } : {}),
    paused: Object.entries(ap.until).filter(([, t]) => t > Date.now()).map(([k, t]) => `${k} ${Math.round((t - Date.now()) / 1000)}с`)
  });

  function finish(run, res) {
    const now = Date.now(); const sec = (now - run.started) / 1000;
    const err = res && res.ok === false ? String(res.error || 'провал') : null;
    if (run.kind === 'body' && res && res.taskId) {
      const h = ctx.tasks.history.find(x => x.id === res.taskId);
      if (h && h.status === 'aborted') run.aborting = run.aborting || h.error || 'прервано';
    }
    // уступка мозгу — это не провал навыка (L013): свои счётчики не растят, счётчик исполнителя сбрасываем
    const byBrain = isBrainYield(run, err);
    const byUs = !byBrain && !!run.aborting; // прервали сами (безопасность, смерть, выгрузка) — тоже не вина навыка
    const cmdAction = byBrain ? String(run.brainYield.action || '') : '';
    const cmdWho = cmdAction === 'owner' ? 'хозяина' : 'мозга';
    const verdict = verdictOf(run, err);
    // отказ исполнителя — не прерывание: сначала «выключен/не найден», и только потом «POST /abort» (L013)
    if (verdict === 'навык выключен') {
      const back = /выключен/.test(err) && INTERRUPT_ERR.test(err) && run.kind === 'learned' && !!run.name;
      ap.until[run.key] = now + (back ? T.apSkillReenableMs : (run.kind === 'learned' ? 600000 : BACKOFF_MS));
      if (back) reenable(run.name); // выключили из-за прерываний — вернуть в работу
    }
    else if (verdict === 'прерван мозгом') ap.lastBrainCmd = now;
    else if (verdict === 'тело/исполнитель заняты') { ap.lastBusy = now; ap.until[run.key] = now + 5000; }
    else if (verdict === 'ok') {
      ap.fails[run.key] = 0;
      // ситуация изменилась (блоки собраны / место сменилось) — старые причины провала и паузы больше не про то место
      if (run.key.startsWith('lowhp_')) for (const k of Object.keys(ap.failInfo)) if (k.startsWith('lowhp_')) delete ap.failInfo[k];
      if (run.key.startsWith('lowhp_')) for (const k of Object.keys(ap.until)) if (k.startsWith('lowhp_') && k !== run.key) delete ap.until[k];
      if (run.kind === 'learned' && sec < 20) ap.until[run.key] = now + 120000; // делать нечего — не крутить по кругу
      else if (sec < 3) ap.until[run.key] = now + 15000;
    } else if (verdict === 'провал') {
      const n = (ap.fails[run.key] || 0) + 1; ap.fails[run.key] = n;
      // причина провала — решение по ней: одинаковая причина = сменить тактику, а не повторять тот же вызов
      const reason = String(err).split('\n')[0].slice(0, 120);
      const prev = ap.failInfo[run.key];
      const same = !!prev && prev.norm === normReason(reason);
      const count = same ? prev.count + 1 : 1;
      ap.failInfo[run.key] = { reason, norm: normReason(reason), count, t: now };
      // пауза после провала: у выученных навыков — как у команд тела (та же причина — длиннее), не ровно 60 с
      ap.until[run.key] = now + failPause(run.kind, err, same, count, n);
      if (same && count >= T.failSameCount) ap.fails[run.key] = 0;      // та же причина — пауза длиннее
      else if (n >= FAIL_MAX) ap.fails[run.key] = 0;
      // сбой кода навыка (в ошибке — файл и строка): это не отказ о мире, тот же вызов упадёт так же —
      // автопилот его не повторяет: сообщает мозгу и ждёт правки
      if (run.kind === 'learned' && run.name && isCodeCrash(err)) {
        ap.codeCrash[run.name] = { reason, at: now, mtime: learnedMtime(run.name) };
        note(`навык ${run.name}: сбой кода (${reason}) — этот код не повторяю (беру другие дела), жду правки файла от мозга`, true);
        clearFailsAfterCrash(run.name, reason);
      }
    }
    // после побега — пауза (L014): тот же побег раньше паузы не зовём; побег без отрыва от врага — не повторяем
    if (run.name === 'escape' && (run.key === 'lowhp_escape' || run.key === 'escape_player' || run.key === 'night_escape')
        && !/прерван/.test(verdict) && !(err && /занят/.test(err))) {
      const d1 = hostileD();
      const rr = res && (res.result || res);
      const grew = run.enemyD0 == null || d1 == null || d1 >= run.enemyD0 + T.apEscapeMinDist || !!(rr && rr.away === true); // моб пропал или отстал (или не достаёт: столб) — побег удался
      const pause = escapePause(run.key, grew);
      ap.until[run.key] = now + pause;
      if (!grew) { // В: не оторвался — в причины провала: в следующий раз другая тактика, а не тот же побег
        const prev = ap.failInfo[run.key];
        ap.failInfo[run.key] = { reason: 'побег не оторвал от врага', norm: 'побег не оторвал от врага', count: (prev && prev.norm === 'побег не оторвал от врага' ? prev.count : 0) + T.failSameCount, t: now };
      }
      note(`побег: ${grew ? 'оторвался' : 'не оторвался'}${run.enemyD0 != null && d1 != null ? ` (враг: ${run.enemyD0.toFixed(1)} → ${d1.toFixed(1)} м)` : ''} — пауза ${Math.round(pause / 1000)} с`);
    }
    if (run.key === 'goal') {
      if (verdict === 'ok' || verdict === 'провал') {
        // v0.2: провал — повтор через goalRetryMs с шагом вдвое меньше; успех — следующий шаг через goalRepeatMs, без прогресса — стоп
        const reason = err ? String(err).split('\n')[0].slice(0, 120) : 'провал';
        ap.goalFailNote = goalAfter(ap, run, verdict, reason, now, (ctx.lastProgressAt || 0) >= run.started);
      } else {
        ap.until.goal = Math.max(ap.until.goal || 0, now + BACKOFF_MS); // прерванная/выключенная цель — тоже пауза (L013)
      }
    }
    if (BUILD_KEYS.has(run.key)) {
      if (verdict === 'ok' || verdict === 'провал') {
        // v0.2 постройка: готово — build_done один раз на строку; не хватило — добор; другое — пауза и повтор (мозг не будим)
        const r = buildAfter(ap, run, verdict, err, res && res.result, now, (ctx.lastProgressAt || 0) >= run.started);
        if (r && run.key === 'build' && ap.buildSt && ap.buildSt.need) { delete ap.until.build; delete ap.failInfo.build; ap.fails.build = 0; } // нехватка — шаг, а не провал
        if (r && r.done) ctx.events.push('build_done', { name: ap.build.name, at: [ap.build.x, ap.build.y, ap.build.z], rot: ap.build.rot });
        if (r && r.note) ap.goalFailNote = r.note;
      } else {
        ap.until[run.key] = Math.max(ap.until[run.key] || 0, now + BACKOFF_MS); // прервана/выключена — пауза (L013)
      }
    }
    // намеренное прерывание (уступка мозгу или своё) — не вина навыка: счётчик провалов обнуляем
    // (иначе три уступки подряд выключат исправный навык)
    if ((byBrain || byUs) && run.kind === 'learned' && run.name) {
      const why = byBrain
        ? (cmdAction === 'owner' ? 'уступаю хозяину' : `уступаю мозгу: ${cmdAction}`)
        : `прерываю навык: ${String(run.aborting).slice(0, 60)}`;
      resetFails(run.name, why);
    }
    if (ap.yieldWatch && ap.yieldWatch.name === run.name) ap.yieldWatch = null;
    ap.history.push({ key: run.key, name: run.name, verdict, sec: Math.round(sec), ...(byBrain ? { brain: cmdAction } : {}), ...(err ? { error: err.split('\n')[0].slice(0, 160) } : {}) });
    if (ap.history.length > 20) ap.history.shift();
    note(`${run.name}: ${verdict}${byBrain ? ` (команда ${cmdWho}: ${cmdAction})` : ''}${err && (verdict === 'провал' || verdict === 'навык выключен') ? ' — ' + err.split('\n')[0].slice(0, 160) : ''}`);
    if (ap.goalFailNote) { note(ap.goalFailNote); ap.goalFailNote = null; } // «цель X: та же причина — не повторяю» — сразу после провала
    if (ap.running === run) ap.running = null;
  }

  function start(act) {
    const run = { ...act, started: Date.now(), aborting: null, ...(act.key === 'goal' && ap.goal ? { sig: ap.goal.sig } : {}), ...(BUILD_KEYS.has(act.key) && ap.build ? { sig: ap.build.sig } : {}) };
    if (act.name === 'escape') run.enemyD0 = hostileD(); // сколько было до врага — чтобы честно оценить побег
    ap.running = run;
    if (act.key === 'recover' && ctx.lastDeath) ap.recoverFor = ctx.lastDeath.ts;
    note(act.why, true);
    const p = act.kind === 'learned'
      ? runnerGo(act.name, act.params, act.name === 'day_routine' ? 720 : act.name === 'go_safe' ? T.goSafeMaxSec + 60 : 900)
      : act.name === 'goto' // не навык из SKILLS: переход на базу — свой Task (source autopilot)
        ? ctx.tasks.start('goto', act.params, t => baseTravel(ctx, t, act.params), { source: 'autopilot', wait: true })
        : ctx.runSkill(act.name, act.params, { source: 'autopilot', wait: true });
    run.promise = Promise.resolve(p).then(r => finish(run, r), e => finish(run, { ok: false, error: e && e.message ? e.message : String(e) }));
  }

  ap._start = start; // для офлайн-проверки (test/build_goal.js): запуск дела без тика
  ap.tick = async () => {
    const bot = ctx.bot;
    if (ap.ticking || !ctx.ready || !bot || !bot.entity || bot.health <= 0) return;
    ap.ticking = true;
    try {
      const now = Date.now();
      const cur = ctx.tasks.current;
      if ((cur && cur.source !== 'autopilot') || ctx.tasks.legacyBusy) ap.lastBusy = now;
      if (!ap.running) { const act = await runnerActive(); ap.runnerOther = !!act; if (act) ap.lastBusy = Date.now(); }
      else ap.runnerOther = false;
      // застрял (в воздухе без движения: лиана, паутина, яма) / долго под водой
      const p = bot.entity.position;
      const head = bot.blockAt(p.offset(0, 1.6, 0));
      const wet = !!head && head.name === 'water';
      ap.wetSince = wet ? (ap.wetSince || now) : 0;
      const still = ap.lastPos && ap.lastPos.distanceTo(p) < 0.05;
      ap.stuckSince = (!bot.entity.onGround && still && !wet && !cur) ? (ap.stuckSince || now) : 0;
      ap.lastPos = p.clone();
      // L052: HP упало между тиками — по муху били (урон тоже считается). apHitFreshMs ночью тогда
      // не пережидаем (wait_night не берём / прерываем) и яму не начинаем — идём стены/бой/отход
      if (ap.lastHp == null) ap.lastHp = bot.health;
      else if (bot.health < ap.lastHp - 0.01) ap.lastHit = now;
      ap.lastHp = bot.health;
      if (!ap.on) return;
      // уступка мозгу (L013): навык, который не отпустил тело, а команда мозга ещё ждёт — прерываем
      // (счётчик провалов сбросим после: это не вина навыка)
      if (ap.yieldWatch && ap.running && ap.running.kind === 'learned' && now - ap.yieldWatch.at > T.apYieldGraceMs) {
        const w = ap.yieldWatch; ap.yieldWatch = null;
        const queued = (ctx.tasks.queue && ctx.tasks.queue.length) || 0;
        const brainWaits = queued > 0 || brainHoldsBody(ctx);
        if (brainWaits) {
          note(`навык ${w.name} не отпустил тело после уступки мозгу (${w.action}) — прерываю`);
          await ap.yieldAll('уступка мозгу: ' + w.action);
        }
      }
      await refreshGoal();
      const st = gather(ctx, ap);
      const act = decide(st);
      if (!act) {
        const nightNow = st.isNight || st.nightIn < T.nightSoonSec;
        if (st.idle && !st.task && !st.runnerOther) {
          if (lowHpOf(st)) noteWait(st);
          // L052: не молчим, когда моб рядом ночью — что делаем, написано (укрытие/отход/бой выше или стоим тут)
          else if (nightNow && (st.hostilesNear > 0 || st.hitRecent)) noteThreatWait(st);
        }
        return;
      }
      if (ap.running) { if (!act.preempt) return; await ap.yieldAll('безопасность: ' + act.why); if (ap.running) return; }
      if (ctx.tasks.current) return; // пока ждали, тело занял мозг или рефлекс
      start(act);
    } catch (e) {
      console.log('[autopilot] tick:', e && e.message);
    } finally { ap.ticking = false; }
  };
  return ap;
}

// Подключение к ядру (из behavior/index.js): api — от lib/behavior_host.js. Состояние живёт в ctx.autopilot между
// переподключениями; после перезагрузки поведения создаётся заново (с прежними «включён» и паузой хозяина).
function attach(api) {
  const { ctx, bot } = api;
  let ap = ctx.autopilot;
  if (!ap || ap._mod !== MOD) {
    const prev = ap;
    ap = create(ctx);
    if (prev) { ap.on = prev.on !== false; ap.pausedUntil = prev.pausedUntil || 0; ap.lastBrainCmd = prev.lastBrainCmd || ap.lastBrainCmd; ap.yields = prev.yields || 0; ap.history = Array.isArray(prev.history) ? prev.history.slice(-20) : []; ap.goalFail = prev.goalFail || null; ap.goalDiv = prev.goalDiv || 1; ap.goalDivSig = prev.goalDivSig || null; ap.goalDone = prev.goalDone || null; ap.goalDoneAt = prev.goalDoneAt || 0; ap.goalEmpty = prev.goalEmpty || null; ap.codeCrash = prev.codeCrash || {}; ap.lastHp = prev.lastHp != null ? prev.lastHp : null; ap.lastHit = prev.lastHit || 0; ap.goSafe = !!prev.goSafe; ap.goSafeT = prev.goSafeT || 0; ap.buildSt = prev.buildSt || null; }
    ctx.autopilot = ap;
  }
  api.on(bot, 'death', () => { ap.yieldAll('смерть').catch(() => {}); });
  api.every(TICK_MS, () => ap.tick(), 'автопилот', { always: true });
  return { detach: reason => ap.yieldAll(reason || 'поведение выгружено') };
}

// версия: как 20261022-225845-1e05a2, но цель добора — ИТОГ (need из ответа build_blueprint), а не дельта (missing); «добор сделан» только по факту прибавки в сумке; после пустого добора — пауза с причиной и смена тактики, не повтор того же вызова; добор ночью не начинать; шаг build_gather в коде; по заявке учителя
module.exports = { attach, decide, lowHpOf, gather, create, goalState, goalAfter, buildState, buildAfter, buildStatus, lackOf, newBuildSt, stepParams, escapePause, yieldPlan, isBrainYield, verdictOf, brainHoldsBody, failPause, isCodeCrash, crashList, IDLE_MS, READONLY, SHORT_BRAIN };
