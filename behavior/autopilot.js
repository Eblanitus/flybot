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
const PL = require('./plan');   // v0.3 очередь «## План» в notes.md (шаг 3): работа без мозга
const SW = L('switches');       // пульт: включён ли мозг (data/switches.json)
const D = L('danger');

const RUNNER = (process.env.RUNNER_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const IDLE_MS = T.idleMs;  // столько мозг должен молчать (и тело стоять), чтобы автопилот взялся за дело
const TICK_MS = T.tickMs;
const ENEMY_R = T.enemyR;  // враг-игрок ближе — реагировать сразу
const FAIL_MAX = T.failMax; // провалов подряд до паузы
const BACKOFF_MS = T.backoffMs;
const CHAT_MS = T.chatMs;  // не чаще одного сообщения в чат в минуту
// v0.4 (2.5): путь от спавна к базе по дну каньона (docs/citadel.md); только при базе у (-393, 36)
const ROUTE_HOME = [{ x: -226, y: 67, z: 67 }, { x: -302, y: 67, z: 51 }];
// ближайшая следующая точка по пути домой: она ближе к базе, чем муха (с запасом wpNearDist), лежит «по дороге» (ближе, чем сама база) и ещё не достигнута; нет — null (идём на базу)
function nextWaypoint(pos, base) {
  if (!pos || !base || Math.hypot(base.x + 393, base.z - 36) > 64) return null;
  const dMe = Math.hypot(pos.x - base.x, pos.z - base.z);
  for (let i = 0; i < ROUTE_HOME.length; i++) {
    const w = ROUTE_HOME[i];
    const dw = Math.hypot(w.x - base.x, w.z - base.z), dm = Math.hypot(w.x - pos.x, w.z - pos.z);
    if (dw + T.wpNearDist < dMe && dm < dMe && dm > T.wpNearDist) return { ...w, i };
  }
  return null;
}
const GAME = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']; // козы — не дичь: мяса с них нет
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
// своё дело автопилота, которое безопасность бросает при мобе рядом (behavior_autopilot_collect_dusk)
const WORK_KEYS = new Set(['collect_stone', 'collect_log', 'night_dirt', 'build', 'build_go', 'build_gather', 'goal', 'goal_gather', 'explore', 'day_routine', 'go_base', 'night_collect',
  'hunt_stock', 'food_spot', 'food_explore', 'cook', 'bread', 'surface', 'surface_stairs', 'surface_dig', 'seeds_grass', 'reserve_dirt', // v0.3 еда: охота впрок, поход к животным, жарка, подъём; v0.4: копка над головой, трава за семенами, запас блоков
  'fish', 'fish_go', 'fish_ice', 'craft_rod', 'food_village', 'vh_wheat', 'vh_carrot', 'vh_potato', 'farm', // v0.3 еда, этап 2: рыбалка, деревня, ферма
  'bed_craft', 'bed_wool', 'bed_home', 'light_base']); // v0.3 ночь у базы (шаг 6): кровать (крафт, шерсть, постановка у базы), факелы на закате
// провал добора не потому, что материала нет, а потому что муху отвлекли (рефлекс, мозг, связь) — добор продолжаем
const GATHER_INTERRUPT = /вытеснен|прерван|POST \/abort|отключ|уступка мозгу|занят навыком|смерть/i;
const CORE_DIR = process.env.FLYBOT_CORE || path.join(__dirname, '..');
const NOTES = path.join(CORE_DIR, 'brain', 'notes.md');
const BLUEPRINTS = path.join(CORE_DIR, 'brain', 'blueprints');
const PLAN_FILE = path.join(CORE_DIR, 'data', 'autopilot_plan.json'); // память пунктов очереди (вне git)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOD = {}; // метка этой версии модуля: после перезагрузки поведения автопилот создаётся заново

// ---------- v0.3 инструменты: кирка, меч, лопата, топор (шаг 2) ----------
// Чистые функции (проверяются без бота). k — набор из gather(): {pickaxe, sword, shovel, axe: ранг лучшего (0 — нет; 1 дерево/золото,
// 2 камень/медь, 3 железо, 4 алмаз, 5 незерит), planks, sticks, logs (брёвна), cobble, table (верстак в сумке или рядом)}.
const TOOL_TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };
const TOOL_KINDS = ['pickaxe', 'sword', 'shovel', 'axe'];
const TOOL_KEY = { pickaxe: 'craft_pick', sword: 'craft_sword', shovel: 'craft_shovel', axe: 'craft_axe' };
const TOOL_RU = { pickaxe: 'кирка', sword: 'меч', shovel: 'лопата', axe: 'топор' };
// цена инструмента: n — досок (деревянный) или булыжника (каменный), s — палок; каменный и деревянный стоят одинаково
const TOOL_COST = { pickaxe: { n: 3, s: 2 }, sword: { n: 2, s: 1 }, shovel: { n: 1, s: 2 }, axe: { n: 3, s: 2 } };
const TOOL_UPGRADE = new Set(['pickaxe', 'sword']); // деревянные кирку и меч меняем на каменные; лопату и топор — только если их нет
// ранги инструментов в сумке: берём лучший каждого вида
function toolTiers(items) {
  const out = { pickaxe: 0, sword: 0, shovel: 0, axe: 0 };
  for (const i of items || []) {
    const m = /^(\w+)_(pickaxe|sword|shovel|axe)$/.exec(i.name);
    if (m && TOOL_TIER[m[1]] > out[m[2]]) out[m[2]] = TOOL_TIER[m[1]];
  }
  return out;
}
// хватает ли материала на инструмент kind из mat ('stone' | 'wooden'): палки из досок (2 доски → 4 палки), верстак (4 доски), брёвна → доски
function toolFeasible(k, kind, mat) {
  const c = TOOL_COST[kind];
  if (mat === 'stone' && (k.cobble || 0) < c.n) return false;
  const planks = Math.ceil(Math.max(0, c.s - (k.sticks || 0)) / 4) * 2 + (mat === 'wooden' ? c.n : 0) + (k.table ? 0 : 4);
  return (k.planks || 0) + 4 * (k.logs || 0) >= planks;
}
// что сделать из недостающего, по порядку важности (кирка, меч, лопата, топор): [{kind, item, tier, upgrade}]; каменный — если хватает булыжника
function toolNext(k) {
  const out = [];
  for (const kind of TOOL_KINDS) {
    const tier = k[kind] || 0;
    if (tier >= 2 || (tier > 0 && !TOOL_UPGRADE.has(kind))) continue;
    if (toolFeasible(k, kind, 'stone')) out.push({ kind, item: 'stone_' + kind, tier, upgrade: tier > 0 });
    else if (tier === 0 && toolFeasible(k, kind, 'wooden')) out.push({ kind, item: 'wooden_' + kind, tier, upgrade: false });
  }
  return out;
}
// v0.3 еда, этап 2: хватает ли материала. k — s.tools (+ string): палки из досок (2 доски → 4 палки), верстак (4 доски), брёвна → доски
// удочка: 3 палки + rodString нитей (нить — только с пауков: нет — ветку рыбалки пропускаем)
function rodFeasible(k) {
  const planks = Math.ceil(Math.max(0, 3 - (k.sticks || 0)) / 4) * 2 + (k.table ? 0 : 4);
  return (k.string || 0) >= T.rodString && (k.planks || 0) + 4 * (k.logs || 0) >= planks;
}
// мотыга (farm_plot крафтит деревянную): 2 палки + 2 доски
function hoeFeasible(k) {
  const planks = Math.ceil(Math.max(0, 2 - (k.sticks || 0)) / 4) * 2 + 2 + (k.table ? 0 : 4);
  return (k.planks || 0) + 4 * (k.logs || 0) >= planks;
}
// вода под ферму: из кандидатов памяти мира (ближние первыми, у каждого at=[x,y,z]) — только на уровне базы (farm_plot ищет воду у поверхности
// в survey от y−4 до y+3 вокруг себя, речка на дне каньона ему невидима) и не из «неподходящих» точек (farmBad: [{x,z,t}] после провала фермы)
function farmWaterPick(cands, base, bad, now) {
  const by = base && Number.isFinite(base.y) ? base.y : null;
  const old = b => now - b.t < T.farmBadMin * 60000;
  for (const c of cands || []) {
    if (!c || !c.at) continue;
    if (by != null && Math.abs(c.at[1] - by) > T.farmWaterDy) continue;
    if ((bad || []).some(b => old(b) && Math.hypot(b.x - c.at[0], b.z - c.at[2]) <= T.farmBadR)) continue;
    return { x: c.at[0], z: c.at[2] };
  }
  return null;
}
// какой инструмент нужен для добычи блока/предмета (по имени), null — рукой нормально
const TOOL_PICK_RE = /(^|_)(stone|cobblestone|cobbled_deepslate|deepslate|andesite|diorite|granite|tuff|blackstone|sandstone|netherrack|basalt|obsidian|calcite|bricks?)$|_ore$|^(coal|raw_iron|raw_copper|raw_gold|iron|copper|gold|diamond|redstone|lapis_lazuli|emerald|quartz)$/;
const TOOL_SHOVEL_RE = /^(dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|mud|clay|sand|red_sand|gravel|soul_sand|soul_soil|snow|snow_block|dirt_path|farmland)$/;
const TOOL_AXE_RE = /^(log|wood)$|_(log|wood|stem|hyphae)$/;
function toolFor(name) {
  const n = String(name || '').replace(/^minecraft:/, '').toLowerCase();
  if (!n || /_(pickaxe|sword|shovel|axe|hoe)$/.test(n)) return null;
  if (TOOL_SHOVEL_RE.test(n)) return 'shovel';
  if (TOOL_AXE_RE.test(n)) return 'axe';
  if (TOOL_PICK_RE.test(n)) return 'pickaxe';
  return null;
}
// какие инструменты нужны делу автопилота: collect (block) или gather_list (items: «cobblestone:20,dirt:5» / объект / массив)
function toolsForAct(act) {
  if (!act || !act.params) return [];
  const p = act.params;
  let names = [];
  if (act.name === 'collect') names = [p.block || p.type || p.name];
  else if ((act.base || act.name) === 'gather_list') { // act.base — навык вызван версией (gather_list_v12)
    let it = p.items;
    if (typeof it === 'string' && /^\s*[\[{]/.test(it)) { try { it = JSON.parse(it); } catch (e) {} }
    if (typeof it === 'string') names = it.split(',').map(x => x.split(':')[0].trim());
    else if (Array.isArray(it)) names = it.map(x => (x && typeof x === 'object' ? x.name || x.item : x));
    else if (it && typeof it === 'object') names = Object.keys(it);
  }
  const kinds = new Set(names.map(toolFor).filter(Boolean));
  return ['pickaxe', 'shovel', 'axe'].filter(x => kinds.has(x));
}

// какие выученные навыки исполнитель сейчас не даст запустить: {off:{имя:причина}, known:[имена]} или null (список не получен).
// Выключенный авто из-за прерываний (POST /abort, уступка мозгу) сюда не входит: его возвращает в работу finish() (reenable) —
// иначе он остался бы выключенным навсегда. known пуст — исполнитель не отдал список: «не найден» по нему не судим.
function skillGate(list) {
  if (!Array.isArray(list)) return null;
  const off = {};
  for (const x of list) {
    if (!x || !x.name || x.enabled !== false) continue;
    const reason = String(x.disabledReason || 'вручную');
    if (/^авто:/.test(reason) && INTERRUPT_ERR.test(reason)) continue;
    off[x.name] = reason;
  }
  const known = list.filter(x => x && x.name).map(x => x.name);
  return { off, known: known.length ? known : null };
}

// v0.4 версии навыков: автопилот звал навык по базовому имени, а файл с ним — старый снимок; новые версии (gather_list_v12,
// climb_up_v5) он не вызывал никогда. list — GET /skills исполнителя ([{name, enabled, valid, stats:{runs,ok}}]) -> {база: имя версии}.
// Кандидаты — включённые и не broken (valid:false), кроме bad (версии со сбоем кода). Лучшая по счёту brain/versions.score = (ok+1)/(runs+2)
// (при равенстве — больше запусков, потом новее); если счёт лучшей < skillVerGoodScore, новая версия (номер больше, runs < skillVerTrialRuns)
// получает пробные запуски — самая новая из таких. Кандидатов нет / библиотеки версий нет — базы в карте нет: зовём базовое имя, как раньше.
let VERLIB; // brain/versions.js: parseName/score — лениво (в сохранённых копиях поведения ядро даёт FLYBOT_CORE)
const versionsLib = () => VERLIB !== undefined ? VERLIB : (VERLIB = (() => { try { return require(path.join(CORE_DIR, 'brain', 'versions')); } catch (e) { return null; } })());
function pickVersions(list, bad) {
  const V = versionsLib();
  if (!V || !Array.isArray(list)) return {};
  const by = new Map();
  for (const x of list) {
    if (!x || !x.name || x.enabled === false || x.valid === false || (bad && bad.has(x.name))) continue;
    const p = V.parseName(x.name);
    if (!by.has(p.base)) by.set(p.base, []);
    by.get(p.base).push({ name: x.name, n: p.n, runs: (x.stats && x.stats.runs) || 0, sc: V.score(x) });
  }
  const out = {};
  for (const [base, vs] of by) {
    vs.sort((a, b) => b.sc - a.sc || b.runs - a.runs || b.n - a.n);
    let pick = vs[0];
    if (pick.sc < T.skillVerGoodScore) {
      const fresh = vs.filter(v => v.n > pick.n && v.runs < T.skillVerTrialRuns).sort((a, b) => b.n - a.n)[0];
      if (fresh) pick = fresh;
    }
    out[base] = pick.name;
  }
  return out;
}

// ---------- Решение (чистая функция) ----------
// А: «мало HP» по последствию (lib/danger.js outlook в s.outlook): бой проигран и, не отбиваясь, муха умрёт раньше apReactSec
function lowHpOf(s) {
  if (s.sheltered && !s.hitRecent && s.hp >= T.apLowHp) return false;
  // behavior_autopilot_fullhp_wait (зависание 11 мин): HP полный, ударов нет, моба вплотную нет — «мало HP» по оценке
  // (крипер в 11 м: hitsToDie 1) не про регенерацию: ждать нечего, дело идёт, подход моба ловят рефлекс и «безопасность»
  const h = s.hostile;
  const close = !!h && h.d <= (h.name === 'creeper' ? T.creeperInterruptDist : T.reflexInterruptDist);
  if (s.hp >= T.apFullHp && !s.hitRecent && !close) return false;
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
//     buildDist (горизонтальная дистанция до места постройки)
//     tools (v0.3 инструменты: набор для toolNext — ранги кирки/меча/лопаты/топора, доски, палки, брёвна, булыжник, верстак; нет поля — не крафтим),
//     skillOff {навык:причина} и skillKnown [имена] (выученные навыки: выключенный/не найденный decide не предлагает; нет полей — как раньше)}
// -> null | {key, kind:'body'|'learned', name, params, why, preempt?, score?, others?} (score/others — В: счёт выбранного дела и следующих)
function decide(s) {
  if (!s.on) return null;
  if (s.task && s.task.source !== 'autopilot') return null; // мозг или рефлекс заняли тело — не лезем
  if (s.runnerOther) return null;                            // мозг запустил выученный навык
  // При низком HP и АКТИВНОМ рефлекс-escape — не начинаем новые дела автопилота, отдаём тело рефлексам/защите
  // (рефлекс escape при HP < 10 должен успеть сработать; автопилот не мешает ему)
  const reflexEscapeActive = (s.task && s.task.source === 'reflex' && s.task.name === 'escape')
    || (s.running && s.running.name === 'escape' && s.running.kind === 'body' && s.task && s.task.source === 'reflex');
  if (reflexEscapeActive && s.hp < T.apLowHp) {
    return null;
  }
  const run = s.running ? s.running.key : null;
  const ok = k => !(s.blocked && s.blocked[k]);
  const body = (key, name, params, why, preempt) => ({ key, kind: 'body', name, params: params || {}, why, ...(preempt ? { preempt: true } : {}) });
  const crashed = s.crashed || {};
  // навык, упавший со сбоем кода, автопилот не повторяет: тот же вызов упадёт так же — ждём правки от мозга
  // выключенный (или не найденный) у исполнителя навык не предлагаем вовсе — иначе «навык выключен» каждые 2–60 с (night_mine ×60)
  const skillGone = name => !!(s.skillOff && s.skillOff[name]) || (Array.isArray(s.skillKnown) && s.skillKnown.length > 0 && !s.skillKnown.includes(name));
  // v0.4 версии: s.skillVer {база: версия} (pickVersions) — навык зовём выбранной версией (явно названную версию в цели не подменяем),
  // а key, счёт паузы/провалов и сбой кода остаются по базе. Сбой кода записан на версию (crashed[база].file) — другая версия базы не заблокирована
  const verOf = name => (s.skillVer && !/_v[0-9]{1,3}$/.test(name) && s.skillVer[name]) || name;
  const learned = (key, name, params, why) => {
    const real = verOf(name), cr = crashed[name];
    if (cr && (!cr.file || cr.file === real)) return null;
    if (skillGone(real)) return null;
    return real === name ? { key, kind: 'learned', name, params: params || {}, why }
      : { key, kind: 'learned', name: real, base: name, params: params || {}, why: `${why} [${name} → ${real}]` };
  };

  // L052 (смерть 23): ночная защита, когда моб в hostileR или по муху били — те же варианты, что у рефлекса
  // (behavior/reflexes.js defensePrior): бой с оружием (HP в норме) → укрытие стенами (НЕ яма — копка ямы
  // занимает 3-4 с, зомби успевает дойти и залезть; по муху били и враг вплотную — стены не начинаем) → отход.
  // Укрытие заявлено и ударов нет — строить заново бессмысленно: бой или стоим (в тике напишем, что стоим).
  // А: «HP в норме для боя» — по последствию: бой с мобами рядом выигран (lib/danger.js outlook); без оценки — порог apFightHp
  const o = s.outlook || null;
  const fightWins = o ? !!o.win : s.hp >= T.apFightHp;
  // крипер у порога (в creeperInterruptDist): ждать нельзя ни в укрытии, ни на рассвете (почти-смерть 23.10: wait_night 504 с, крипер 11.6 → 3.3 м)
  const creeperClose = () => !!(s.hostile && s.hostile.name === 'creeper' && s.hostile.d <= T.creeperInterruptDist);
  const nightDefense = preempt => {
    const h = s.hostile;
    const hitClose = s.hitRecent && !!h && h.d < T.hitNoShelterDist; // били только что и враг вплотную — стены не успеть
    // 1) с оружием и HP в норме — отбиваемся (и из укрытия тоже: моб в 0.3 м — «укрытие» уже не спасает)
    if (h && s.hasWeapon && fightWins && ok('night_fight'))
      return body('night_fight', 'fight', { target: String(h.name).toLowerCase(), radius: T.fightRadius, flee_hp: T.playerFleeHp, timeout: T.apFightTimeout },
        `ночью отбиваюсь от ${h.name} (${h.d} м)${s.hitRecent ? ' — по муху били' : ''}`, preempt);
    // 2) укрытия нет — стены из блоков (НЕ яма: копка ямы 3-4 с, зомби успевает дойти и залезть); по муху били
    //    и враг вплотную — стены не начинаем (L052: не успеть, как у рефлекса hitNoShelterDist)
    if (!s.sheltered && s.blocks >= 2 && !hitClose && !creeperClose() && ok('night_shelter')) // крипер у порога — стены не спасут от взрыва
      return body('night_shelter', 'shelter', { mode: 'walls' },
        h ? `ночью ${h.name} рядом (${h.d} м) — укрываюсь стенами (яму рядом с мобом не копаю)` : 'ночью небезопасно — укрываюсь стенами', preempt);
    // 3) по муху били (укрытие объявлено ≠ наверное есть) или укрытия нет совсем — отходим; в закрытом укрытии
    //    без ударов и без оружия ждём (в тике напишем «мобы рядом ночью — жду в укрытии», wait_night всё равно не берём)
    //    behavior_reflexes_mob_near: крипер ближе creeperInterruptDist — взрыв достаёт и через стенку: критерий —
    //    дистанция врага, а не флаг «укрыта»; и «жду» в укрытии не дольше apWaitMaxSec — потом действие
    const boom = creeperClose();
    const waitOver = (s.waitSec || 0) >= T.apWaitMaxSec;
    if ((!s.sheltered || s.hitRecent || boom || waitOver) && ok('night_escape'))
      return body('night_escape', 'escape', { distance: T.apEscapeDist, shelter: true },
        h ? `${boom ? `${h.name} ${h.d} м — прерываю ожидание, ` : waitOver ? `жду дольше ${T.apWaitMaxSec} с — хватит, ` : 'ночью '}${h.name} рядом (${h.d} м) — отхожу${s.sheltered ? ', выхожу из укрытия' : ''}` : 'ночью небезопасно (по муху били) — отхожу', preempt);
    return null;
  };

  // 1. враг-игрок рядом — сразу, даже если мозг говорил недавно (тело свободно или работает автопилот)
  // (L? , core_task 29181f0b08): «еле жива» без еды и еда не появится — из укрытия к игроку не выходим:
  // побег из укрытия при критическом HP вернее смерть (журналы 09:47/09:51 — выход при враге в 5–11 м)
  const en = (s.enemies || [])[0];
  if (en) {
    if (run === 'fight_player' || run === 'escape_player') return null;
    const critHere = (o ? o.hitsToDie != null && o.hitsToDie <= 1 : s.hp <= T.apCritHp) && !s.hasFood;
    if (en.aggressor && s.hasWeapon && s.hp >= T.apFightHp && s.alone && ok('fight_player'))
      return body('fight_player', 'fight', { target: en.name, radius: T.apFightRadius, flee_hp: T.apFleeHp, timeout: T.apFightTimeout }, `отбиваюсь от ${en.name}`, true);
    if (ok('escape_player') && !(critHere && s.sheltered)) return body('escape_player', 'escape', { distance: T.apEscapeDist, shelter: true }, `убегаю от ${en.name} (${en.why}) — ${s.sheltered ? 'выхожу из укрытия в поле' : 'в поле'}`, true);
  }
  // неудачный побег от игрока — не возвращаемся к работе: уходим на базу, пока не оторвёмся (в работе — пауза после побега)
  const escapePlayerFailed = !!(s.failInfo && s.failInfo.escape_player && s.failInfo.escape_player.reason === 'побег не оторвал от врага' && s.blocked && s.blocked.escape_player);
  const workBan = !!en || escapePlayerFailed; // враг-игрок в enemyR или pausa после неудачного побега — никакой работы (build/сбор/разведка/рутина)
  if (escapePlayerFailed && !lowHpOf(s) && s.blocked && s.blocked.escape_player && s.base && s.baseDist != null && s.baseDist > s.base.r && ok('go_base')) {
    return s.goSafe
      ? learned('go_base', 'go_safe', { x: s.base.x, y: s.base.y, z: s.base.z, max_sec: T.goSafeMaxSec, priority: true }, 'побег от игрока не удался — ухожу на базу (go_safe)')
      : body('go_base', 'goto', { x: s.base.x, y: s.base.y, z: s.base.z, r: s.base.r, timeout: T.baseTimeoutSec, priority: true }, 'побег от игрока не удался — ухожу на базу');
  }
  // L052 (смерть 23): ночью моб у порога или по муху били — долгую wait_night не молча держим: прерываем и отдаём
  // тело защите (бой/стены/отход); пока мозг командовал недавно — не отбираем (мозг главнее, L013)
  const nightSoon = s.isNight || s.nightIn < T.nightSoonSec;
  // v0.4 (2.4): побег от этого моба не оторвался (s.escapeFailed) — сразу укрытие
  const escFailed = m => !!(m && s.escapeFailed && s.escapeFailed[String(m.name)]);
  // v0.4 (2.5): возродилась далеко от базы (> respawnFarDist) — ночью укрытие до утра
  const respawnFar = !!s.afterDeath && s.baseDist != null && s.baseDist > T.respawnFarDist;
  // behavior_reflexes_mob_near: крипер у порога прерывает ожидание и на рассвете (там nightSoon уже false)
  // v0.3 ночь у базы: то же для сна (sleep) — моб подошёл или ударил, пока ложилась/спала: просыпаемся и защищаемся
  if ((run === 'wait_night' || run === 'sleep') && s.idle && ((nightSoon && (s.hostilesNear > 0 || s.hitRecent)) || creeperClose())) {
    const a = nightDefense(true);
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
    // v0.4: цель упала «не хватает …» — сперва добор gather_list'ом (ключ goal_gather, по образцу build_gather), потом цель снова
    const gneed = s.goalNeed && Object.keys(s.goalNeed).length ? s.goalNeed : null;
    if (gneed) {
      // ночью с угрозой добор не начинаем (как build_gather); камень без кирки не доберём — день сначала даст кирку
      if ((s.isNight || (s.nightIn != null && s.nightIn < T.nightSoonSec)) && (s.hostilesNear > 0 || s.hitRecent)) return null;
      if (!s.hasPickaxe && Object.keys(gneed).some(k => /cobble|stone|deepslate|andesite|diorite|granite|tuff|blackstone/.test(k))) return null;
      const items = Object.entries(gneed).map(([k, n]) => `${k}:${n}`).join(',');
      return learned('goal_gather', 'gather_list', { items, max_sec: T.buildGatherSec }, `цель ${g.name}: добираю недостающее — ${items.replace(/,/g, ', ')}${press ? ` (простой ${Math.round(idleMin)} мин)` : ''}`);
    }
    return g.kind === 'learned' ? learned('goal', g.name, g.params, why) : body('goal', g.name, g.params, why); // упала со сбоем кода — её нет
  };
// v0.3 постройка шагами (behavior_autopilot_build_step): не «добрать весь список 101 и построить», а ставить то,
// что есть (build_partial: пол/стены раньше крыши), и добирать ШАГ (<= buildStepItems каждого вида), пока не достроим.
  const buildAct = () => {
    const tail = press ? ` (простой ${Math.round(idleMin)} мин)` : '';
    const need = b.need && Object.keys(b.need).length ? b.need : null;
    const have = b.have || {};
    // в сумке есть хоть что-то из материала постройки (have — из итога build_blueprint/gather_list) — ставим это частью
    const haveAny = need ? Object.values(have).some(n => (Number(n) || 0) > 0) : false;
    // камень без кирки не доберём («нужен инструмент для stone» — 49 с впустую): пусть день сначала даст кирку
    const stoneNeed = need ? Object.keys(need).some(k => /cobble|stone|deepslate|andesite|diorite|granite|tuff|blackstone/.test(k)) : false;
    // ночью добор/стройку не начинаем только при угрозе (моб рядом, удары); ночь без мобов — работа у базы
    if (need && (s.isNight || (s.nightIn != null && s.nightIn < T.nightSoonSec)) && (s.hostilesNear > 0 || s.hitRecent)) {
      return null;
    }
    // behavior_autopilot_build_gather (дыра 2): здесь добор уже ничего не дал (материала физически нет — пещера, 160 м
    // от места) — сначала к месту постройки, добираем/ставим там, а не тот же gather_list с того же места
    if (need && b.gatherAway && s.buildDist != null && s.buildDist > T.buildNearDist)
      return body('build_go', 'goto', { x: b.x, y: b.y, z: b.z, r: T.buildNearDist / 2, timeout: T.baseTimeoutSec, label: 'к постройке', fail: 'до постройки не дошла', priority: true },
        `материала для ${b.name} тут нет — иду к постройке (${Math.round(s.buildDist)} м), доберу там${tail}`);
    // есть чем ставить — ставим часть (build_partial), а не копим материал на весь список
    if (need && haveAny && !b.partialStuck) {
      const has = Object.entries(have).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
      return learned('build_partial', 'build_partial_v1', { blueprint: b.name, x: b.x, y: b.y, z: b.z, rot: b.rot },
        `постройка ${b.name}: ставлю, что есть (${has}) — осталось добрать ${lackStr(need)}${tail}`);
    }
    // без кирки камень не доберём — не тратим заход: день сначала collect_log → craft_pickaxe
    if (need && stoneNeed && !s.hasPickaxe) return null;
    if (need) {
      const items = Object.entries(need).map(([k, n]) => `${k}:${n}`).join(',');
      return learned('build_gather', 'gather_list', { items, max_sec: T.buildGatherSec }, `добираю шагом для постройки ${b.name}: ${items.replace(/,/g, ', ')}${tail}`);
    }
    if (s.buildDist != null && s.buildDist > T.buildNearDist)
      return body('build_go', 'goto', { x: b.x, y: b.y, z: b.z, r: T.buildNearDist / 2, timeout: T.baseTimeoutSec, label: 'к постройке', fail: 'до постройки не дошла', priority: true }, `иду к постройке ${b.name} (${Math.round(s.buildDist)} м)${tail}`);
    return body('build', 'build_blueprint', { name: b.name, x: b.x, y: b.y, z: b.z, rot: b.rot }, `строю ${b.name} у ${b.x} ${b.y} ${b.z}${b.rot ? ' rot=' + b.rot : ''}${tail}`);
  };
  // ---- v0.3 инструменты (шаг 2): кирка, меч, лопата, топор — сделать, когда материал есть (верстак и палки тело делает само, craft) ----
  // Дело, которому нужен инструмент (collect/gather_list: камень/руда — кирка, земля/песок/гравий — лопата, брёвна — топор), не начинаем
  // без него: если материал есть — сначала крафт. Кирки нет и сделать не из чего — дело не берём (рукой камень не долбим: 51 провал
  // «нужен инструмент для stone»), день даст дерево (collect_log). Лопата и топор — желательны: не сделать — дело идёт как раньше.
  const tk = s.tools || null;
  const toolHave = () => `есть: булыжник ${tk.cobble || 0}, доски ${tk.planks || 0}, палки ${tk.sticks || 0}, брёвна ${tk.logs || 0}`;
  const toolActs = () => (!tk || workBan ? [] : toolNext(tk).map(c => ({ ...c,
    act: body(TOOL_KEY[c.kind], 'craft', { item: c.item }, `${c.upgrade ? 'улучшаю' : 'делаю'} ${TOOL_RU[c.kind]} (${c.item}); ${toolHave()}`) })).filter(c => ok(c.act.key)));
  const withTool = act => {
    if (!tk || !act) return act;
    for (const kind of toolsForAct(act)) {
      if ((tk[kind] || 0) > 0) continue;
      const c = toolNext(tk).find(x => x.kind === kind);
      if (c && ok(TOOL_KEY[kind])) return body(TOOL_KEY[kind], 'craft', { item: c.item }, `перед «${act.key}» нет инструмента (${TOOL_RU[kind]}) — сначала ${c.item}; ${toolHave()}`);
      if (kind === 'pickaxe') return null;
    }
    return act;
  };
  const job0 = b ? buildAct : g ? goalAct : null; // дело от мозга: постройка или старая цель
  const job = job0 ? () => withTool(job0()) : null;
  const inBase = (x, z) => Math.hypot(x - s.base.x, z - s.base.z) <= s.base.r;
  const gp = b ? { x: b.x, z: b.z } : g && g.params || {};
  const atBase = !!(s.base && s.baseDist != null && s.baseDist <= s.base.r &&
    !(Number.isFinite(gp.x) && Number.isFinite(gp.z) && !inBase(gp.x, gp.z))); // ночная стройка — у базы, не в поле
  // ---- v0.3 ночь у базы (шаг 6): кровать (точка возрождения и сон), свет на закате ----
  // nearBase — просто муха в радиусе «База:» (atBase выше ещё требует, чтобы точка цели тоже была у базы)
  const nearBase = !!(s.base && s.baseDist != null && s.baseDist <= s.base.r);
  const bedItems = Number(s.bedItem) || 0;                       // кроватей в сумке
  const bedPlaced = !!s.bedHome || (nearBase && !!s.freeBed);    // своя кровать у базы: запомненная (поставила bring_bed_home) или видна рядом
  const woodEq = tk ? (tk.planks || 0) + 4 * (tk.logs || 0) : 0; // досок-эквивалент (брёвна -> доски)
  const woolN = Number(s.wool) || 0;                             // шерсти одного цвета (лучший цвет)
  // кровать: шерсть есть — крафт (3 шерсти + 3 доски, верстак ещё 4 доски); шерсти нет, а овцы рядом — make_bed (стрижёт ножницами или бьёт овец);
  // кровать в сумке и муха у базы — поставить у базы (bring_bed_home), ночью sleep сам ставит кровать из сумки, если дома не успела
  const bedActs = duskSoon => {
    const out = [];
    if (workBan || threat) return out;
    if (bedItems === 0 && !bedPlaced && tk && woodEq >= 3 + (tk.table ? 0 : 4)) {
      if (woolN >= T.bedWool && s.woolColor)
        out.push([T.apBedCraft, body('bed_craft', 'craft', { item: `${s.woolColor}_bed` }, `делаю кровать (${s.woolColor}_bed): шерсти ${woolN}, досок ${woodEq} в пересчёте — точка возрождения и сон у базы`)]);
      else if (woolN < T.bedWool && (Number(s.sheep) || 0) > 0 && !duskSoon)
        out.push([T.apBedWool, learned('bed_wool', 'make_bed', { max_sec: T.bedWoolSec },
          `нужна кровать: шерсти ${woolN} из ${T.bedWool}, овцы рядом (${s.sheep}) — ${s.shears ? 'стригу' : 'охочусь на овец'} (make_bed)`)]);
    }
    if (bedItems > 0 && !bedPlaced && nearBase && s.base && Number.isFinite(s.base.y))
      out.push([T.apBedPlace, learned('bed_home', 'bring_bed_home', { x: s.base.x, y: s.base.y, z: s.base.z, place: 1, max_sec: T.bedHomeSec },
        'кровать в сумке, я у базы — ставлю её у базы (точка возрождения)')]);
    return out;
  };
  // факелы вокруг базы на закате: свои факелы или уголь на них (запас lightCoalKeep остаётся печи), не чаще lightRepeatMin
  const torchN = Number(s.torches) || 0, coalN = Number(s.coal) || 0;
  const sticksEq = tk ? (tk.sticks || 0) + 2 * Math.floor(woodEq / 2) : 0; // палки: свои + из досок (как считает light_base)
  const torchCan = torchN + 4 * Math.min(Math.max(0, coalN - T.lightCoalKeep), sticksEq);
  const lightAct = () => {
    if (workBan || threat || !nearBase || s.isNight || s.nightIn == null || s.nightIn >= T.lightDuskSec) return null;
    if (torchCan < T.lightMinTorches) return null;
    if (s.lightSinceMin != null && s.lightSinceMin < T.lightRepeatMin) return null;
    return learned('light_base', 'light_base', { x: s.base.x, y: s.base.y, z: s.base.z, r: Math.max(6, Math.min(T.lightRadius, s.base.r)), step: T.lightStep,
      max: Math.min(T.lightMax, torchCan), max_sec: T.lightMaxSec },
      `закат (до ночи ${s.nightIn} с): расставляю факелы вокруг базы (факелов ${torchN}${coalN ? `, угля ${coalN}` : ''})`);
  };
  // ---- v0.4 ночь у базы (этап 3): нужда стройки/цели (need) — крафт из сумки (заборы, факелы, доски, палки) или плавка stone ----
  const nightNeed = b ? b.need : g ? s.goalNeed : null;
  const nightWork = () => {
    if (!nightNeed || !tk || workBan || threat || !nearBase) return null;
    for (const [k, q] of Object.entries(nightNeed)) {
      const hv = b && b.have && k in b.have ? Number(b.have[k]) || 0 : k === 'torch' ? torchN : 0;
      const want = Math.floor(Number(q) || 0) - hv;
      if (!(want > 0)) continue;
      let n = 0;
      if (/_fence$/.test(k)) { // 4 доски + 2 палки -> 3 забора; палок нет — из досок (2 доски -> 4 палки)
        for (let c = Math.ceil(want / 3); c >= 1 && !n; c--)
          if (4 * c + 2 * Math.ceil(Math.max(0, 2 * c - (tk.sticks || 0)) / 4) <= woodEq) n = Math.min(want, 3 * c);
      } else if (k === 'torch') n = Math.min(want, 4 * Math.min(Math.ceil(want / 4), coalN, sticksEq)); // уголь + палка -> 4 факела
      else if (/_planks$/.test(k)) n = Math.min(want, 4 * (tk.logs || 0));
      else if (k === 'stick') n = Math.min(want, 4 * Math.floor(woodEq / 2));
      else if (k === 'stone' && s.fuel && s.cobble) { // плавка булыжника (печь рядом или на неё 8 булыжника)
        const m = Math.min(want, s.cobble - (s.furnaceNear ? 0 : T.furnaceCobble));
        if (m > 0) return [T.apNightSmelt, body('night_smelt', 'smelt', { item: 'cobblestone', count: m }, `ночь у базы: нужен stone ×${want} — плавлю булыжник ×${m} (${b ? b.name : g.name})`)];
        continue;
      }
      if (n > 0) return [T.apNightCraft, body('night_craft', 'craft', { item: k, count: n }, `ночь у базы: нужно ${k} ×${want} — делаю ×${n} из сумки (доски ${tk.planks || 0}, палки ${tk.sticks || 0}, уголь ${coalN})`)];
    }
    return null;
  };
  // идущий wait_night: простой давно, угрозы нет, у базы — будим ради цели (после угроз и go_base_escape, мозг молчит)
  if (run === 'wait_night' && s.idle && job && !workBan && atBase && !threat && idleMin >= T.idleBreakWaitMin && !lowHpOf(s)
      && !(s.inLava || s.suffocating || s.stuck || s.underWater)) {
    const a = job();
    if (a && ok(a.key)) return { ...a, why: a.why + ' — прерываю ожидание ночи', preempt: true };
  }
  // behavior_autopilot_collect_dusk: своя задача (сбор, стройка, дорога, разведка) не отключает безопасность —
  // моб подошёл (крипер — ближе creeperInterruptDist, прочие — safetyWorkDist; ночью — весь hostileR): бросаем дело
  // с честной причиной и берём защиту (preempt — иначе тик не прервёт идущее дело). Свой бой/побег/укрытие не трогаем.
  if (run && WORK_KEYS.has(run) && !(run === 'go_base' && s.running.kind !== 'body') && s.idle && s.hostile) { // go_safe смотрит сам
    const mob = s.hostile;
    const lim = mob.name === 'creeper' ? T.creeperInterruptDist : nightSoon ? T.hostileR : T.safetyWorkDist;
    const what = run === 'go_base' ? 'дорогу' : /^build/.test(run) ? 'стройку' : run === 'explore' ? 'разведку' : 'сбор';
    if (mob.d <= lim) {
      if (mob.name !== 'creeper' && s.hasWeapon && fightWins && ok('safety_fight'))
        return body('safety_fight', 'fight', { target: String(mob.name).toLowerCase(), radius: T.fightRadius, flee_hp: T.apFleeHp, timeout: T.apFightTimeout },
          `безопасность: ${mob.name} рядом (${mob.d} м) — бросаю ${what}, отбиваюсь`, true);
      if (escFailed(mob) && mob.name !== 'creeper' && !s.sheltered && s.blocks >= 2 && ok('safety_shelter'))
        return body('safety_shelter', 'shelter', { mode: 'walls' }, `безопасность: ${mob.name} рядом (${mob.d} м), прошлый побег от такого не оторвался — бросаю ${what}, сразу укрываюсь стенами`, true);
      if (ok('safety_escape'))
        return body('safety_escape', 'escape', { distance: T.apEscapeDist, shelter: true },
          `безопасность: ${mob.name} рядом (${mob.d} м) — бросаю ${what}, отхожу`, true);
    }
  }
  if (run || s.task) return null; // свой навык идёт — не дёргать
  if (!s.idle) return null;       // мозг недавно командовал — ждём
  // v0.4 (2.4): угроза рядом, оружие в сумке, а в руке нет — меч в руку
  if (s.hasWeapon && s.handArmed === false && (s.hostilesNear > 0 || s.hitRecent) && ok('equip_weapon'))
    return body('equip_weapon', 'equip_best', { for: 'fight' }, `угроза рядом${s.hostile ? ` (${s.hostile.name} ${s.hostile.d} м)` : ''}, в руке не оружие — беру лучший меч/топор`, true);

  // 2. безопасность
  if ((s.inLava || s.suffocating || s.stuck || s.underWater) && ok('unstuck'))
    return body('unstuck', 'explore', { distance: T.unstuckDist }, s.inLava ? 'выбираюсь из лавы' : s.suffocating ? 'выбираюсь из блока' : s.underWater ? 'выплываю из воды' : 'выбираюсь: застрял');
  // А: «мало HP» — по последствию: встреча (с мобами рядом, а нет их — с обычным ночным мобом) проиграна и, не отбиваясь,
  // муха умрёт раньше, чем уйдёт или укроется (apReactSec). «Еле жива» — переживёт не больше одного удара. Без оценки — пороги.
  // Простой страшнее смерти (заявки 23.10): у любого «жду» — потолок apWaitMaxSec (s.waitSec — сколько тело уже стоит
  // без дела, считает тик), потом действие; без угрозы (мобов в hostileR нет, ударов нет, день, не «еле жива») — не прячемся.
  const waitSec = Math.max(0, Number(s.waitSec) || 0);
  const waitOver = waitSec >= T.apWaitMaxSec;
  // v0.4 (2.5): далеко от базы — домой по точкам дна каньона (ROUTE_HOME)
  const ht = (s.base && s.pos && s.baseDist != null && s.baseDist > T.respawnFarDist) ? nextWaypoint(s.pos, s.base) : null;
  const homeTo = ht ? { x: ht.x, y: ht.y, z: ht.z, r: T.wpNearDist } : s.base ? { x: s.base.x, y: s.base.y, z: s.base.z, r: s.base.r } : null;
  const homeTag = ht ? ` — по дну каньона, точка ${ht.i + 1} из ${ROUTE_HOME.length}` : '';
  const goBase = why => (s.base && s.baseDist != null && s.baseDist > s.base.r && ok('go_base')
    ? (s.goSafe
      ? learned('go_base', 'go_safe', { x: homeTo.x, y: homeTo.y, z: homeTo.z, max_sec: T.goSafeMaxSec, priority: true }, why + homeTag + ' (go_safe)')
      : body('go_base', 'goto', { x: homeTo.x, y: homeTo.y, z: homeTo.z, r: homeTo.r, timeout: T.baseTimeoutSec, priority: true }, why + homeTag))
    : null);
  // ---- v0.3 еда, этап 1: муха сама добывает еду, а не сидит с HP 2 без регенерации (сытость < 18) ----
  const fiF = s.failInfo || {};
  const triedF = k => (fiF[k] ? fiF[k].count || 0 : 0);
  // под землёй — наверх: в пещере ни животных, ни дерева (113 раз «не вижу log», 257 раз «путь…» у explore).
  // climb_up; дважды не вышел (или упал со сбоем кода) — climb_stairs; оба не вышли — null (дальше другие способы)
  // v0.4 (2.1): HP < surfaceMinHp — без climb_up; «потолок над головой» → dig_at, потом снова climb_stairs; 2 провала — пауза (finish)
  // (pillar_up внутри climb_stairs) — сначала копаем блок над головой (dig_at), потом climb_stairs снова; два одинаковых провала — пауза (finish)
  const surfaceAct = why => {
    if (!s.underground) return null;
    const y = Math.round(s.surfaceY != null ? s.surfaceY : 64);
    const a = s.hp >= T.surfaceMinHp && triedF('surface') < T.failSameCount && ok('surface') ? learned('surface', 'climb_up', { y, max_sec: T.surfaceSec }, why + ' (climb_up)') : null;
    if (a) return a;
    const st = fiF.surface_stairs;
    if (st && /потолок/i.test(String(st.reason || '')) && triedF('surface_stairs') < T.failSameCount && s.pos && ok('surface_dig'))
      return body('surface_dig', 'dig_at', { x: s.pos.x, y: s.pos.y + 2, z: s.pos.z }, `${why} — над головой потолок: копаю вверх (${s.pos.x} ${s.pos.y + 2} ${s.pos.z}), потом снова climb_stairs`);
    return triedF('surface_stairs') < T.failSameCount && ok('surface_stairs') ? learned('surface_stairs', 'climb_stairs', { target_y: y }, why + ' (climb_stairs)') : null;
  };
  // v0.4 (2.4): HP ≤ lowHpHoldHp и еды нет — ночью охота/места/земля не дальше nightLeash, без туннелей;
  // укрытие на месте — ночные ветки ниже (night_shelter*), днём без угрозы еду добываем как раньше
  const holdHp = s.hp <= T.lowHpHoldHp && !s.hasFood;
  const leash = holdHp && nightSoon;
  const animalClose = leash && s.animalD != null ? s.animalD <= T.nightLeash : s.animals > 0; // (нет расстояния в снимке — как раньше)
  // туда, где недавно видела животных (память поведения: s.animalSpot), не дальше maxD; baseLim — и не дальше baseLim м от базы (охота впрок ≤ huntStockBaseDist)
  const spotAct = (why, maxD, baseLim) => {
    const sp = s.animalSpot;
    if (!sp || sp.d > (leash ? Math.min(maxD || T.foodSpotMaxDist, T.nightLeash) : (maxD || T.foodSpotMaxDist)) || !ok('food_spot')) return null;
    if (baseLim && s.base && Math.hypot(sp.x - s.base.x, sp.z - s.base.z) > baseLim) return null;
    return body('food_spot', 'goto', { x: sp.x, y: sp.y, z: sp.z, r: 8, timeout: 180, label: 'к животным', fail: 'до места с животными не дошла' },
      `${why} — иду туда, где видела животных (${Math.round(sp.d)} м, ${sp.ago} мин назад)`);
  };
  // ---- v0.3 еда, этап 2: рыбалка (удочка; вода подо льдом — сначала лёд) и деревня из памяти мира ----
  const fv = s.fish || null, wat = s.water || null;  // fv: {open, ice:{x,y,z}|null} (есть удочка), wat: ближайшая вода {x,y,z,d}
  const fishOpen = fv ? !!fv.open : !!(wat && wat.d <= T.fishNearDist);
  const fishAct = tag => {
    if ((s.rod || 0) > 0) {
      if (fishOpen && ok('fish')) {
        const casts = Math.min(T.fishCasts, Math.max(3, T.foodStockWant + 1 - (Number(s.foodUnits) || 0))); // до запаса, не «до упора»
        return body('fish', 'fish', { casts, max_sec: T.fishMaxSec }, `${tag} — рыбачу (до ${T.foodStockWant} еды или ${T.fishMaxSec} с)`);
      }
      if (!fishOpen && fv && fv.ice && ok('fish_ice')) // прорубь: ломаем блок льда над водой, дальше fish видит открытую воду
        return body('fish_ice', 'dig_at', { x: fv.ice.x, y: fv.ice.y, z: fv.ice.z }, `${tag} — вода подо льдом: ломаю лёд (${fv.ice.x} ${fv.ice.y} ${fv.ice.z}), потом рыбачу`);
      if (!fishOpen && wat && wat.d > T.fishNearDist && ok('fish_go'))
        return body('fish_go', 'goto', { x: wat.x, y: wat.y, z: wat.z, r: 6, timeout: 150, label: 'к воде', fail: 'до воды не дошла' }, `${tag} — иду к воде (${wat.d} м) рыбачить`);
      return null;
    }
    if (!wat && !fishOpen && !(fv && fv.ice)) return null; // воды нет — удочка ни к чему
    if (rodFeasible({ ...(tk || {}), string: s.string }) && ok('craft_rod'))
      return body('craft_rod', 'craft', { item: 'fishing_rod' }, `${tag} — делаю удочку (3 палки + ${T.rodString} нити), вода рядом`);
    return null; // нити нет (она только с пауков) или нечего на палки — ветку пропускаем
  };
  const VIL = ['wheat', 'carrot', 'potato'];
  const villageAct = tag => {
    const v = s.village, vh = s.vhDone || {};
    if (!v || VIL.every(c => vh[c])) return null; // деревни нет / всё уже пробовала (villageHarvestMin) — по кругу не ходим
    if (v.d > T.villageHereDist) {
      if (!ok('food_village') || (s.nightIn != null && s.nightIn < T.apDuskSec + v.d / T.villageSpeed)) return null; // до ночи не дойти
      return body('food_village', 'goto', { x: v.x, y: v.y, z: v.z, r: 10, timeout: 240, label: 'в деревню', fail: 'до деревни не дошла' },
        `${tag} — иду в деревню из памяти (${v.d} м): созревшие грядки; жителей не трогаю`);
    }
    for (const c of VIL) if (!vh[c] && ok('vh_' + c))
      return body('vh_' + c, 'harvest', { crop: c, radius: T.villageHarvestR, replant: true }, `${tag} — в деревне собираю созревшее: ${c}`);
    return null;
  };
  // поиск еды по порядку: животные рядом → наверх из пещеры → место, где были животные → рыбалка → деревня из памяти → база → поле (explore шире с каждым провалом).
  // nearOnly (ночь) — только ближнее: охота рядом, подъём, место с животными в foodSpotNightDist; в поле ночью не идём
  const foodQuest = (tag, nearOnly) => {
    if (animalClose && ok('hunt')) return body('hunt', 'hunt', { count: T.huntCount, ...(leash ? { radius: T.nightLeash } : {}) }, `${tag} — охочусь (животные рядом, мобов нет)`);
    const up = surfaceAct(`${tag} — под землёй еды нет, поднимаюсь наверх`); if (up) return up;
    const sp = spotAct(tag, nearOnly ? T.foodSpotNightDist : T.foodSpotMaxDist); if (sp) return sp; // (при leash spotAct сам режет до nightLeash)
    if (nearOnly) return null;
    const fa = fishAct(tag); if (fa) return fa;
    const va = villageAct(tag); if (va) return va;
    const gb = goBase(`${tag} — иду на базу`); if (gb) return gb;
    if (!ok('food_explore')) return null;
    const d = Math.min(96, T.exploreDist + 24 * triedF('food_explore'));
    return body('food_explore', 'explore', { distance: d }, `${tag} — ищу животных в поле (explore ${d} м)`);
  };
  // зомби рядом, оружие есть и бой по оценке выигран — гнилая плоть тоже еда (без оценки боя — не лезем)
  const zombieFood = () => {
    const zh = s.hostile;
    if (!zh || !/^(zombie|husk|drowned|zombie_villager)$/.test(String(zh.name)) || !s.hasWeapon || !s.outlook || !s.outlook.win || !ok('food_zombie')) return null;
    return body('food_zombie', 'fight', { target: String(zh.name).toLowerCase(), radius: T.fightRadius, flee_hp: Math.max(2, Math.min(T.apFleeHp, s.hp - 2)), timeout: T.apFightTimeout },
      `HP ${s.hp}, сытость ${s.food}, еды нет — ${zh.name} (${zh.d} м) по силам: бью ради гнилой плоти`);
  };
  if (lowHpOf(s)) {
    const dark = s.isNight || s.nightIn < T.nightSoonSec;   // ночью в поле не выходим: стены и ждать утра
    // «еле жива» — про настоящий низкий HP: крипер «убьёт одним взрывом» и при HP 20 (hitsToDie 1), это не повод ждать регенерацию
    const crit = (o ? o.hitsToDie != null && o.hitsToDie <= 1 : s.hp <= T.apCritHp) && s.hp < T.apLowHp && !s.hasFood; // еле жива и есть нечего — наружу не ходим
    // behavior_reflexes_shelter_no_mobs: укрытие — только при угрозе (моб в hostileR, удары, ночь, «еле жива»);
    // «мало HP (10)» днём в пустом поле — не повод закапываться: регенерация идёт и за работой
    const danger = threat || dark || crit;
    const fi = s.failInfo || {};
    const bad = k => !!(fi[k] && fi[k].count >= T.failSameCount); // эта тактика уже провалилась одинаково
    const need = T.apLowHpBlocks;                 // блоков надо на стены укрытия
    // v0.3 еда: регенерации нет (сытость < 18) и есть нечего — ждать бесполезно, HP не растёт (388 раз «жду N с из 120» с HP 2):
    // зомби рядом и бой по оценке выигран — гнилая плоть тоже еда; угрозы нет — сразу за едой (ночью — только ближнее)
    const starving = s.food < T.goBaseMinFood && !s.hasFood;
    const zf = starving ? zombieFood() : null; if (zf) return zf;
    if (starving && !threat && !(s.enemies && s.enemies.length)) { // враг-игрок рядом — из укрытия не выходим
      const a = foodQuest(`мало HP (${s.hp}), сытость ${s.food}, еды нет — регенерации нет`, dark);
      if (a) return a;
    }
    if (danger && !s.sheltered) {
      // 1) лесенка (L003, не трогаем): блоки → укрытие. При crit наружу не ходим — только укрыться.
      if (!crit && s.blocks < need && !bad('lowhp_dirt') && ok('lowhp_dirt')) {
        // 1) блоки — раньше укрытия: без них shelter падает «блоков на стены мало»
        return body('lowhp_dirt', 'collect', { block: 'dirt', count: need - s.blocks, ...(leash ? { radius: T.nightLeash } : {}) }, `мало HP (${s.hp}) — беру блоки на укрытие`);
      }
      if (s.blocks >= need && !bad('lowhp_shelter') && ok('lowhp_shelter')) {
        // 2) укрыться; вниз копать нельзя (пещера/лава) — только стенами
        const why = (fi.lowhp_shelter && fi.lowhp_shelter.reason) || '';
        const dig = NO_DIG.test(why);
        return body('lowhp_shelter', 'shelter', dig ? { mode: 'walls' } : {}, `мало HP (${s.hp}) — укрываюсь${dig ? ' стенами (вниз копать нельзя)' : ''}${s.hostile ? ` (${s.hostile.name} ${s.hostile.d} м)` : ''}`);
      }
      // 3) побег (L014) — только из открытого места, днём, с оружием (или HP не низкий) и не crit. Из укрытия не бежим.
      if (s.hostilesNear > 0 && ok('lowhp_escape') && !bad('lowhp_escape') && !escFailed(s.hostile) && !crit && !dark && (s.hasWeapon || s.hp >= T.apLowHp))
        return body('lowhp_escape', 'escape', { distance: T.apLowHpEscapeDist, shelter: true },
          `мало HP (${s.hp}) — убегаю в поле на ${T.apLowHpEscapeDist} м (укрытия нет${s.hasWeapon ? ', оружие есть' : ''})`);
      // 4) одна и та же причина провала — сменить тактику: отойти в сторону (иначе тот же провал и та же пауза)
      const last = ((bad('lowhp_shelter') ? fi.lowhp_shelter : fi.lowhp_dirt) || fi.lowhp_shelter || {}).reason || 'укрытие не выходит';
      if (!crit && !(dark && s.hostilesNear > 0) && (bad('lowhp_dirt') || bad('lowhp_shelter') || bad('lowhp_escape')) && ok('lowhp_move'))
        return body('lowhp_move', 'explore', { distance: T.apLowHpMoveDist }, `мало HP (${s.hp}) — ${last} — отхожу в сторону`);
    }
    // behavior_autopilot_fullhp_wait: HP не низкий (≥ apLowHp) — «мало HP» лишь по оценке встречи; ждать регенерацию
    // нечего: укрыться/отойти выше не вышло — дальше обычный выбор дел (ночью — ночная защита ниже), а не вечный return null
    if (s.hp < T.apLowHp) {
      // при низком HP без еды на регенерацию — только восстановление (еда/охота, возврат на базу, ожидание в укрытии);
      // стройка, добор, добыча, дорога не к базе — запрещены; давление простоя (idlePerMin) не отменяет запрет
      const survivalBan = s.food < T.goBaseMinFood;
      // behavior_eat_desperate_hp: регенерации нет (сытость < 18), а съедобное есть (при ранении и гнилое мясо) —
      // рефлекс не съел за apEatWaitSec — едим сами, а не «жду … еды нет» час подряд
      if (survivalBan && s.hasFood && waitSec >= T.apEatWaitSec && ok('lowhp_eat'))
        return body('lowhp_eat', 'eat', { desperate: true, count: 2 }, `мало HP (${s.hp}), сытость ${s.food} — регенерации нет, ем (гнилое тоже)`);
      // без угрозы и с регенерацией (сытость ≥ 18) — HP вернётся и за работой: дальше обычный выбор
      if (danger || survivalBan) {
        // без угрозы и без еды — восстановление сразу: охота, база (там сундук); ждать нечего
        if (!danger && !s.hasFood) {
          if (animalClose && ok('hunt')) return body('hunt', 'hunt', { count: T.huntCount, ...(leash ? { radius: T.nightLeash } : {}) }, `мало HP (${s.hp}), еды нет — охочусь (мобов рядом нет)`);
          const gb = goBase(`мало HP (${s.hp}) и нет еды — иду на базу`); if (gb) return gb;
        }
        // ждём (ест рефлекс), но не дольше apWaitMaxSec; в укрытии ночью с мобом за стеной — ждём (угроза настоящая)
        if (!waitOver || (dark && s.hostilesNear > 0 && s.sheltered)) return null;
        const tag = crit ? 'критический HP без еды' : !s.hasFood ? 'низкий HP и нет еды' : 'низкий HP';
        const gb = goBase(`${tag} — жду дольше ${T.apWaitMaxSec} с, иду на базу`); if (gb) return gb;
        if (!s.hasFood && animalClose && ok('hunt')) return body('hunt', 'hunt', { count: T.huntCount, ...(leash ? { radius: T.nightLeash } : {}) }, `${tag} — жду дольше ${T.apWaitMaxSec} с, охочусь`);
        if (ok('lowhp_emergency_explore'))
          return body('lowhp_emergency_explore', 'explore', { distance: dark ? T.apLowHpMoveDist : T.exploreDist },
            `${tag} — жду дольше ${T.apWaitMaxSec} с, ${s.hasFood ? 'ищу место спокойнее' : 'ищу еду'} (explore)`);
        return null;
      }
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
  const add = (score, act) => { act = withTool(act); if (act && ok(act.key)) cands.push({ score: score - T.apFailPenalty * tried(act.key), act }); };
  const wider = (k, r0) => Math.min(96, r0 + 24 * tried(k)); // повтор сбора — шире радиус
  const pick = () => {
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return { ...cands[0].act, score: Math.round(cands[0].score), ...(cands.length > 1 ? { others: cands.slice(1, 4).map(c => `${c.act.key} ${Math.round(c.score)}`) } : {}) };
  };

  if (night) {
    // ночь: укрыться важнее всего (без укрытия ночью — мобы), потом польза (туннель), сон, переждать
    // behavior_reflexes_shelter_no_mobs: мобов рядом нет (иначе выше ночная защита), ударов нет и HP не низкий — укрытие
    // и ожидание утра не дело, а запас на «делать нечего»: счёт ниже любой работы (стройка/добор у базы, туннель, сбор рядом)
    // v0.4: вдали от базы после смерти (2.5) и HP низкий без еды (2.4) — не «спокойно»: укрытие, без туннелей и дел
    const calm = s.hp >= T.apLowHp && !respawnFar;
    const nightQuiet = holdHp || respawnFar;
    if (!s.sheltered) {
      if (s.blocks < T.nightBlocksMin && s.hostilesNear === 0) add(calm ? 30 : 80, body('night_dirt', 'collect', { block: 'dirt', count: T.nightBlocksMin + 1 - s.blocks, radius: nightQuiet ? T.nightLeash : wider('night_dirt', 48) }, respawnFar ? `возродилась далеко от базы (${Math.round(s.baseDist)} м), ночь — запасаю землю рядом на укрытие` : 'запасаю землю на укрытие'));
      // L052: яму (3-4 с) не начинаем, когда моб уже близко и сближается — тогда стены, отход или бой
      // v0.2: угрозы нет (иначе выше ночная защита) — простой снижает укрытие/ожидание
      if (s.hasPickaxe && s.hostilesNear === 0) add(Math.max(0, (calm ? 25 : 75) - press), body('night_shelter_dig', 'shelter', { mode: 'dig' }, calm ? 'ночь: дел нет — закапываюсь до утра' : respawnFar ? `ночь, возродилась далеко от базы (${Math.round(s.baseDist)} м): закапываюсь до утра, домой не иду` : `ночь, мало HP (${s.hp}): закапываюсь`));
      add(Math.max(0, (calm ? 25 : 70) - press), body('night_shelter', 'shelter', {}, calm ? 'ночь: дел нет — строю укрытие' : respawnFar ? `ночь, возродилась далеко от базы (${Math.round(s.baseDist)} м): строю укрытие до утра, домой не иду` : `ночь, мало HP (${s.hp}): строю укрытие`));
    }
    if (!nightQuiet && (s.phase === 'ночь' || s.phase === 'закат')) add(50, learned('night_mine', 'night_mine', {}, 'копаю туннель ночью'));
    // v0.3 инструменты: ночь спокойная (мобов нет, ударов нет) — вместо ожидания делаю недостающее (верстак тело ставит само)
    if (calm && s.hostilesNear === 0) { const ta = toolActs()[0]; if (ta) add(T.apToolNight, ta.act); }
    // v0.3 еда: регенерации нет и есть нечего, а животные рядом (мобов нет — иначе выше защита) — охота и ночью
    if (!s.hasFood && s.food < T.eatRegenFood && s.hp < T.apFullHp && animalClose) add(60, body('hunt', 'hunt', { count: T.huntCount, ...(leash ? { radius: T.nightLeash } : {}) }, `ночь, HP ${s.hp}, сытость ${s.food}, еды нет — охочусь рядом${leash ? ` (не дальше ${T.nightLeash} м)` : ''} (мобов нет)`)); // упал со сбоем кода — его нет в выборе
    // v0.3 ночь у базы: кровать в сумке и я у базы — sleep сам ставит её рядом и ложится (точка возрождения); выше укрытия и wait_night
    if (s.isNight && (s.freeBed || (bedItems > 0 && nearBase)))
      add(Math.max(0, (nearBase ? T.apSleepBase : 45) + (s.hp < 20 || s.food < T.huntFood ? 10 : 0) - press), body('sleep', 'sleep', {}, s.freeBed ? 'сплю в кровати' : 'сплю: ставлю кровать из сумки у базы')); // ранена или голодна — сон полезнее
    // v0.3 ночь у базы: закат ещё не ночь (nightIn < nightSoonSec) — свет успеть до темноты; спокойно (мобов нет)
    if (calm && s.hostilesNear === 0) { const la = lightAct(); if (la) add(T.apLight, la); }
    // v0.4 ночь у базы (этап 3): нужда очереди из сумки (крафт/плавка) раньше добора и ожидания; сырое мясо и топливо — жарка
    if (calm && s.hostilesNear === 0) { const nw = nightWork(); if (nw) add(nw[0] + press, nw[1]); }
    if (calm && nearBase && !workBan && !threat && s.rawFood && s.fuel && (s.furnaceNear || s.cobble >= T.furnaceCobble))
      add(T.apNightSmelt, body('night_cook', 'smelt', { item: s.rawFood.name, count: s.rawFood.count }, `ночь у базы: жарю ${s.rawFood.name} ×${s.rawFood.count} вместо ожидания`));
    // v0.2: цель мозга ночью — только у базы (без «База:» или вне радиуса — нет: ночью в поле не строим)
// Гейт: ночью с мобами рядом не начинаем дело — сначала укрытие/ожидание
    if (job && !workBan && atBase && s.hostilesNear === 0 && !nightQuiet) add(50 + press, job());
    // запасная ночная работа (night_mine выключен, постройки нет): камень рядом малым радиусом, не поход в поле
    if (calm && !workBan && s.hasPickaxe && s.cobble < T.cobbleWant && !(s.base && s.baseDist != null && s.baseDist > s.base.r))
      add(30, body('night_collect', 'collect', { block: 'stone', count: T.stoneCount, radius: 16 }, 'ночь, мобов рядом нет — добываю камень рядом'));
    // L052: wait_night только без врагов рядом и без свежих ударов (иначе выше сработала ночная защита)
    if (s.isNight) add(Math.max(0, 20 - press), body('wait_night', 'wait_night', { max_sec: T.waitNightSec }, calm ? 'дел нет — пережидаю ночь' : 'пережидаю ночь'));
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
    // ...но не дольше apWaitMaxSec: простой дольше — берём дело рядом (заявка behavior_autopilot_fullhp_wait)
    if (!ok('go_base') && !waitOver) return pick();
    const nightRoad = s.isNight || (s.nightIn != null && s.nightIn < T.apDuskSec);
    // А: ночью при HP < 10 (apLowHp) и без укрытия/оружия — дорогу не начинаем, приоритет укрытию/выживанию
    const vulnerableAtNight = nightRoad && s.hp < T.apLowHp && (!s.sheltered || !s.hasWeapon);
    // 2.5: только что возродилась далеко от базы — на закате дорогу домой не начинаем (ночью по каньону — смерть): укрытие до утра
    const dirtyRoad = s.onFire || s.inLava || (nightRoad && (s.hp < T.goBaseMinHp || s.food < T.goBaseMinFood) || (nightRoad && s.hostilesNear > 0)) || vulnerableAtNight || (nightRoad && respawnFar);
    // дорогу не начинаем — тела не отдаём ей, берём следующее дело (лава/горю лечит самозащита, ночью еда и вернутся),
    // а после добавления остальных дел решаем, чем заняться
    if (!dirtyRoad) {
      const act = s.goSafe
        ? learned('go_base', 'go_safe', { x: homeTo.x, y: homeTo.y, z: homeTo.z, max_sec: T.goSafeMaxSec, priority: true }, 'иду на базу осторожно' + homeTag + ' (go_safe)')
        : body('go_base', 'goto', { x: homeTo.x, y: homeTo.y, z: homeTo.z, r: homeTo.r, timeout: T.baseTimeoutSec, priority: true }, 'иду на базу' + homeTag);
      add(45 + Math.min(25, (s.baseDist - s.base.r) / 8) + (duskSoon ? 20 : 0), act);
    }
  }
  // цель мозга (строка «Автопилот:» в notes.md); провал — пауза goalRetryMs (goalFailed), выполнена — goalDone; v0.2: + давление простоя
  // v0.2: «Постройка:» — на том же месте в выборе, что цель мозга (и главнее строки «Автопилот:»)
  if (job && !workBan) add(50 + press, job());
  // длинная дневная работа: до ночи не успеет — счёт ниже
  if (!workBan) add(35 - (s.nightIn != null && s.nightIn < T.dayRoutineSec ? 10 : 0), learned('day_routine', 'day_routine', { max_sec: T.dayRoutineSec }, 'дневная работа (day_routine)'));
  // голод: чем меньше сытость (а еды нет), тем важнее охота — голодная муха охотится раньше цели мозга
  if (s.food < T.huntFood && !s.hasFood && s.animals > 0) add(20 + (T.huntFood - s.food) * 3, body('hunt', 'hunt', { count: T.huntCount, ...(leash ? { radius: T.nightLeash } : {}) }, 'охочусь: нечего есть'));
  // v0.3 еда (ловушка «HP 10 — здорова»): HP не полный, сытость < 18 и есть нечего — HP сам не вернётся: за едой раньше работы
  const noRegen = s.hp < T.apFullHp && s.food < T.eatRegenFood && !s.hasFood;
  if (noRegen && !workBan) add(30 + (T.eatRegenFood - s.food) * 3 + (T.apFullHp - s.hp) * 2, zombieFood() || foodQuest(`HP ${s.hp}, сытость ${s.food}, еды нет — без еды регенерации нет`, false));
  // v0.3 запас еды: днём еды в сумке мало — охота впрок (ближе к закату важнее: ночью охоты нет); животных нет — к месту, где были
  const units = Number(s.foodUnits) || 0;
  const stockLow = s.foodUnits != null && units < T.foodStockWant;
  const duskFood = s.nightIn != null && s.nightIn < T.foodStockDuskSec;
  // v0.4 (2.2): запас мал и закат близко — охота и жарка впрок +huntStockDuskBonus;
  // охота впрок — только в huntStockBaseDist м от базы (радиус урезан)
  const duskStock = stockLow && duskFood;
  const huntBaseOk = !s.base || s.baseDist == null || s.baseDist <= T.huntStockBaseDist;
  if (stockLow && !noRegen && !workBan) {
    const sc = 28 + (duskFood ? 18 : 0) + (T.foodStockWant - units) * 2 + (duskStock ? T.huntStockDuskBonus : 0);
    const hr = s.base && s.baseDist != null ? { radius: Math.max(8, Math.min(32, Math.floor(T.huntStockBaseDist - s.baseDist))) } : {};
    if (s.animals > 0 && huntBaseOk) add(sc, body('hunt_stock', 'hunt', { count: T.huntCount, ...hr }, `запас еды мал (${units}/${T.foodStockWant}) — охочусь впрок${duskFood ? ' до ночи' : ''}${s.base && s.baseDist != null ? ` (не дальше ${T.huntStockBaseDist} м от базы)` : ''}`));
    else if (!duskSoon && huntBaseOk) add(sc - 12, spotAct(`запас еды мал (${units}/${T.foodStockWant})`, undefined, s.base ? T.huntStockBaseDist : 0));
    // v0.3 еда, этап 2: животных рядом нет — рыбалка (удочка; нет — крафт, если есть нить), счёт выше рутины, когда еды совсем мало
    if (s.animals === 0 && !duskSoon) add(sc - 2, fishAct(`запас еды мал (${units}/${T.foodStockWant})`));
  }
  // v0.3 жарка: сырое есть, топливо есть, печь рядом или булыжник на неё (тело ставит печь само) — smelt тела, без охоты
  // (cook_food 0/8: звали без мяса — он охотился без животных рядом и падал за 0.1 с; раз — без топлива)
  if (s.rawFood && s.fuel && (s.furnaceNear || s.cobble >= T.furnaceCobble) && !workBan)
    add(30 + (stockLow ? 10 : 0) + (duskFood ? 6 : 0) + (duskStock ? T.huntStockDuskBonus : 0), body('cook', 'smelt', { item: s.rawFood.name, count: s.rawFood.count },
      `жарю ${s.rawFood.name} ×${s.rawFood.count} (печь ${s.furnaceNear ? 'рядом' : 'поставлю из булыжника'})`));
  // хлеб из пшеницы (craft тела)
  if ((Number(s.wheat) || 0) >= T.breadWheat && !workBan)
    add(24 + (stockLow ? 8 : 0), body('bread', 'craft', { item: 'bread', count: Math.floor(s.wheat / T.breadWheat) }, `пеку хлеб из пшеницы (${s.wheat})`));
  // v0.3 ферма у базы (этап 2): база рядом, вода у базы, семена (wheat_seeds) и мотыга (или материал на неё) — выученный farm_plot
  // (грядки у воды: вскопать, посадить; повторный вызов — собрать спелое и пересадить), потом каждые farmRevisitMin минут
  let farmAdded = false; // ферма в выборе прямо сейчас (старт или сбор) — траву за семенами берём, когда фермой заняться нечем
  if (!workBan && !duskSoon && s.base && s.baseDist != null && s.baseDist <= T.farmBaseDist) {
    const fm = s.farm || null, seeds = Number(s.seeds) || 0;
    // v0.4 (2.3): воды у базы нет — берём ферму всё равно: farm_plot_v1 dry=1 (x,y,z базы); базовый farm_plot dry не знает, поэтому версия явно
    const dryFarm = fm ? !!fm.dry : !s.farmWater;
    const spot = fm || s.farmWater || (dryFarm ? { x: s.base.x, z: s.base.z } : null);
    const canStart = !!fm || (seeds >= T.farmSeedsMin && (!!s.hoe || hoeFeasible(tk || {})));
    if (spot && canStart && (!fm || fm.sinceMin >= T.farmRevisitMin)) {
      const rev = `ферма у базы: проверяю урожай (${fm ? Math.round(fm.sinceMin) : 0} мин) — собрать и пересадить`;
      if (dryFarm)
        add(T.farmDryScore + (stockLow ? 4 : 0), learned('farm', 'farm_plot_v1', { x: spot.x, ...(Number.isFinite(s.base.y) ? { y: s.base.y } : {}), z: spot.z, size: T.farmSize, seed: 'wheat_seeds', dry: 1, max_sec: T.farmMaxSec },
          fm ? rev + ' (без воды, dry=1)' : `ферма у базы без воды: семян ${seeds}, мотыга ${s.hoe ? 'есть' : 'сделаю'} — сухая грядка на площадке базы (${spot.x} ${spot.z}), dry=1`));
      else
        add(T.farmScore + (stockLow ? 4 : 0), learned('farm', 'farm_plot', { x: spot.x, z: spot.z, size: T.farmSize, seed: 'wheat_seeds', max_sec: T.farmMaxSec },
          fm ? rev : `ферма у базы: семян ${seeds}, мотыга ${s.hoe ? 'есть' : 'сделаю'} — грядки у воды (${spot.x} ${spot.z})`));
    }
  }
  farmAdded = cands.some(c => c.act.key === 'farm');
  // v0.4 (2.3): семян < seedsWant — днём у базы ломаем траву; травы нет — пауза (finish)
  if (!farmAdded && !workBan && !duskSoon && !threat && s.base && s.baseDist != null && s.baseDist <= T.seedsGrassDist && (Number(s.seeds) || 0) < T.seedsWant && (!!s.hoe || hoeFeasible(tk || {})))
    add(T.seedsGrassScore, body('seeds_grass', 'collect', { block: 'short_grass', count: T.seedsGrassCount, radius: T.seedsGrassRadius }, `семян ${Number(s.seeds) || 0} из ${T.seedsWant} — ломаю траву у базы (${Math.round(s.baseDist)} м)`));
  // v0.4 (2.4): запас dirt/cobble на укрытие (shelterReserve) — днём добираем, счёт низкий
  if (!workBan && !duskSoon && !threat && s.blocks < T.shelterReserve)
    add(T.reserveScore, body('reserve_dirt', 'collect', { block: 'dirt', count: T.shelterReserve - s.blocks + 2, radius: wider('reserve_dirt', 24) }, `запас блоков на укрытие мал (${s.blocks}/${T.shelterReserve}) — добираю землю`));
  // золото: сначала собираем бревно, потом кнущим кирку, потом камень
  // когда нет кирки — сначала собрать logs, а не сразу идти к камню
  if (!s.hasPickaxe) {
    // gather_list_alt_seek (второй фронт): радиус задаём всегда — collect днём идёт к известным из памяти тела точкам
    // в пределах радиуса (approachKnownLimited), а не только в 16 м; «не вижу» — шире радиус, а не случайная разведка
    // v0.3: нужно дерево, а муха под землёй — сначала наверх (в пещере log не найти); подъём не вышел — сбор по памяти, как раньше
    const upForLog = s.logs < T.needLogs && !workBan ? surfaceAct('нужно дерево, а я под землёй — сначала наверх') : null;
    if (upForLog) add(28, upForLog);
    else if (s.logs < T.needLogs && !workBan) add(28, body('collect_log', 'collect', { block: 'log', count: T.logCount, radius: wider('collect_log', 48) }, tried('collect_log') ? `рублю дерево: рядом не нашла — ищу по памяти в ${wider('collect_log', 48)} м` : 'рублю дерево'));
    if (!tk && s.logs >= T.pickLogs) add(30, body('craft_pick', 'craft', { item: 'wooden_pickaxe' }, 'делаю деревянную кирку')); // набора нет (старый снимок) — как раньше
  }
  // v0.3 ночь у базы: кровать (крафт / шерсть / поставить у базы) и факелы на закате — по счёту выше цели мозга (50): дело короткое и разовое, давление простоя его иначе вечно перебивало бы
  for (const [sc, act] of bedActs(duskSoon)) add(sc, act);
  { const la = lightAct(); if (la) add(T.apLight, la); }
  // v0.3 инструменты: недостающее/слабое делаю раньше рутины (day_routine 35, сбор 26–28) и после еды при низком HP (там счёт выше)
  for (const c of toolActs()) add(c.upgrade ? T.apToolUpgrade : c.kind === 'pickaxe' ? T.apToolPick : c.kind === 'sword' ? T.apToolSword : T.apToolMisc, c.act);
  // если кирка есть — собираем камень
  const edgeHazard = s.snapshot?.hazards?.includes('обрыв') || s.survey?.edges?.some(e => e.drop >= 3);
  const duskNoWeapon = duskSoon && !s.hasWeapon; // на закате без оружия за камнем далеко не идём
  if (s.hasPickaxe && s.cobble < T.cobbleWant && !edgeHazard && !duskNoWeapon && !workBan) {
    // behavior_autopilot_collect_dusk: в поиске всегда предел радиуса (без него сбор уходил в поле);
    // провал «неизвестный блок:» без имени — сбой вызова, а не нехватка камня: такой сбор не повторяем вслепую
    const badCall = /неизвестный блок:\s*$/.test(String((s.failInfo && s.failInfo.collect_stone && s.failInfo.collect_stone.reason) || ''));
    const far = { radius: tried('collect_stone') ? wider('collect_stone', 48) : 16 };
    if (!badCall) add(26, body('collect_stone', 'collect', { block: 'stone', count: T.stoneCount, ...far },
      duskSoon && !s.hasWeapon ? 'сбор на закате без оружия отложен' : 'добиваю камень'));
  }
  // если обрыв — сбор не начинаем, оставляем следующий кандидат или тихо ждем
  if (edgeHazard && s.snapshot?.hazards?.includes('обрыв') && !s.running) add(0, body('explore', 'explore', { distance: 8 }, 'обрыв рядом — не начинаю сбор, исследую другое место'));
  // разведка — когда больше нечего; перед ночью — ближе
  // разведка: после «спуск на N ур.» / «внизу обрыв» дальше не шагаем (короче, навык сам помнит закрытые направления);
  // gather_list_alt_seek: есть база/постройка — разведкой от неё дальше ~96 м не уходим (там дорога go_base / build_go)
  const exploreFell = /спуск на|обрыв/.test(String((fiAll.explore && fiAll.explore.reason) || ''));
  const anchorFar = (s.base && s.baseDist != null && s.baseDist > Math.max(96, s.base.r)) || (s.buildDist != null && s.buildDist > 96);
  const exploreD = exploreFell ? Math.round(T.exploreDist / 2) : duskSoon ? Math.round(T.exploreDist / 2) : Math.min(T.exploreDist + 24 * tried('explore'), 96);
  if (!workBan && !anchorFar && !(exploreFell && tried('explore') >= T.failSameCount))
    add(10, body('explore', 'explore', { distance: exploreD }, exploreFell ? `исследую окрестности ближе (${exploreD} м): там был спуск/обрыв` : 'исследую окрестности'));
  let res = pick();
  // потолок «жду» (fullhp_wait): дел не нашлось дольше apWaitMaxSec — короткий шаг (новое место — новые дела), не ещё минута стояния
  if (!res && waitOver && !workBan && ok('idle_move'))
    res = body('idle_move', 'explore', { distance: T.apLowHpMoveDist * 2 }, `дела нет уже ${Math.round(waitSec)} с — меняю место (${T.apLowHpMoveDist * 2} м)`);
  return res;
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
    if (v.mtime !== undefined && mtimeOf(v.file || k) !== v.mtime) delete ap.codeCrash[k]; // файл (версии, если сбой в ней) поменялся — пробуем снова
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
    goalFailed: !!(ap.goalFail && ap.goalFail.sig === g.sig && now - (ap.goalFail.at || 0) < T.goalRetryMs),
    // v0.4: цель упала «не хватает …» — что добрать gather_list'ом (goal_gather), потом цель снова; нет нужды — поля нет
    ...(ap.goalNeed && ap.goalNeed.sig === g.sig && ap.goalNeed.need && Object.keys(ap.goalNeed.need).length ? { goalNeed: { ...ap.goalNeed.need } } : {})
  };
}
// провал цели без добора: пауза goalRetryMs, шаг (count/n) вдвое меньше
function goalFailMark(ap, sig, name, reason, now) {
  ap.goalFail = { sig, name, reason, at: now };
  const div = ap.goalDivSig === sig ? ap.goalDiv || 1 : 1;
  ap.goalDiv = div * 2; ap.goalDivSig = sig;
}
// итог запуска цели: verdict 'ok' | 'провал' (прочее — null); progressed — за запуск встал хоть один блок стройки (ctx.lastProgressAt)
// err/result — полный текст ошибки и итог навыка (v0.4: «не хватает блоков: a ×n» -> ap.goalNeed, добор вместо деления шага;
// после buildGatherMax доборов подряд без успеха цели — как раньше: провал, пауза, шаг вдвое меньше)
function goalAfter(ap, run, verdict, reason, now, progressed, err, result) {
  if (verdict === 'ok') {
    ap.goalDone = run.sig; ap.goalDoneAt = now; ap.goalFail = null; ap.goalDiv = 1; ap.goalDivSig = null;
    ap.goalNeed = null; ap.goalGather = null;
    ap.goalEmpty = progressed ? null : run.sig; // без прогресса — пустой круг, до новой строки не повторяем
    return progressed ? `цель ${run.name}: шаг сделан — следующий через ${Math.round(T.goalRepeatMs / 1000)} с`
      : `цель ${run.name}: выполнена, нового блока нет — не повторяю до новой цели`;
  }
  if (verdict === 'провал') {
    const lack = lackOf(err, result);
    const gg = ap.goalGather && ap.goalGather.sig === run.sig ? ap.goalGather : (ap.goalGather = { sig: run.sig, n: 0 });
    if (Object.keys(lack).length) {
      if (gg.n < T.buildGatherMax) {
        const need = stepNeed(lack, haveOf(result));
        ap.goalNeed = { sig: run.sig, need }; ap.goalFail = null;
        return `цель ${run.name}: не хватает ${lackStr(lack)} — добираю gather_list до ${lackStr(need)}, потом повторю`;
      }
      reason = `добор не помогает (${gg.n} раз), не хватает ${lackStr(lack)}`;
    }
    ap.goalNeed = null; gg.n = 0;
    goalFailMark(ap, run.sig, run.name, reason, now);
    return `цель ${run.name}: провал (${reason}) — повтор через ${Math.round(T.goalRetryMs / 1000)} с, шаг вдвое меньше`;
  }
  return null;
}
// итог добора под цель (goal_gather = gather_list): -> {note, resume?, failed?} | null. failed — причина провала цели (пауза и счёт очереди)
function goalGatherAfter(ap, run, verdict, err, result, now) {
  const gn = ap.goalNeed;
  if (!gn || gn.sig !== run.sig || (verdict !== 'ok' && verdict !== 'провал')) return null;
  const name = (ap.goal && ap.goal.name) || 'цель';
  const why = String(err || 'провал').split('\n')[0].slice(0, 120);
  if (verdict !== 'ok' && GATHER_INTERRUPT.test(String(err || ''))) return { note: `цель ${name}: добор прерван (${why}) — продолжаю`, resume: true }; // не провал добора
  const gg = ap.goalGather && ap.goalGather.sig === run.sig ? ap.goalGather : (ap.goalGather = { sig: run.sig, n: 0 });
  gg.n++;
  const hasResult = result && typeof result === 'object' && ('collected' in result || 'crafted' in result || 'have' in result);
  const gotMap = hasResult ? { ...(result.collected || {}), ...(result.crafted || {}) } : {};
  const got = Object.keys(gotMap).length > 0;
  const added = got ? Object.entries(gotMap).map(([k, n]) => `${k}+${n}`).join(', ') : 'предметы добавлены';
  const short = {};
  if (hasResult && result.have) for (const [k, n] of Object.entries(gn.need)) if ((Number(result.have[k]) || 0) < n) short[k] = n - (Number(result.have[k]) || 0);
  const enough = !!(hasResult && result.have && !Object.keys(short).length);
  const fail = text => {
    ap.goalNeed = null; gg.n = 0;
    goalFailMark(ap, run.sig, name, text, now);
    return { note: `цель ${name}: ${text} — повтор через ${Math.round(T.goalRetryMs / 1000)} с, шаг вдвое меньше`, failed: text };
  };
  if (verdict === 'ok' && (!hasResult || got || enough)) {      // ok без итога — верим навыку
    if (Object.keys(short).length) {
      if (gg.n >= T.buildGatherMax) return fail(`добор не помогает (${gg.n} раз), ещё не хватает ${lackStr(short)}`);
      return { note: `цель ${name}: добор сделал (${added}), ещё не хватает ${lackStr(short)} — добираю дальше` };
    }
    ap.goalNeed = null;
    return { note: `цель ${name}: добор сделал (${added}) — повторяю цель` };
  }
  if (got) { // провал, но что-то собрал — прогресс: need остаётся
    if (gg.n >= T.buildGatherMax) return fail(`добор не помогает (${gg.n} раз): ${why}`);
    return { note: `цель ${name}: добор не до конца (${why}), но собрал ${added} — добираю дальше` };
  }
  return fail(`добор ничего не дал (${hasResult && result.have ? lackStr(result.have) || 'пусто' : '?'}, нужно ${lackStr(gn.need)}) — материала нет, меняю способ`);
}

// ---------- v0.2 «Постройка:» — муха строит сама ----------
// ap.build — строка из notes.md {name,x,y,z,rot,sig}; ap.buildSt — как идёт эта строка:
// {sig, need:{предмет:n}|null (добрать), gathers (доборов без нового блока), pauseUntil, reason, done, doneAt,
//  pauses — пауз подряд без нового блока: planFailPauses штук — пункт очереди проваливается, behavior/plan.js}
const BUILD_KEYS = new Set(['build', 'build_partial', 'build_go', 'build_gather']);
// v0.3 (behavior_autopilot_build_step): стройка шагами — need (что добрать) не больше buildStepItems каждого вида,
// stuck — build_partial не поставил ни клетки (материал есть, но не подошёл/не дотянуться) — сразу добор шага.
// have — что из материала постройки было в сумке по последнему итогу (build_blueprint/gather_list); есть — decide даёт build_partial.
const newBuildSt = sig => ({ sig, need: null, have: null, gathers: 0, pauseUntil: 0, reason: null, done: false, doneAt: 0, stuck: false, partialEmpty: 0, pauses: 0 });
// behavior_autopilot_build_gather (дыра 1): известная нехватка переживает рестарт тела — data/autopilot_build.json
// {sig, need, at}; после рестарта первым делом добор по памяти, а не build_blueprint с пустой сумкой (data/ — вне git)
const BUILD_MEM = path.join(process.env.FLYBOT_CORE || path.join(__dirname, '..'), 'data', 'autopilot_build.json');
const BUILD_MEM_TTL = 6 * 3600 * 1000;
function saveBuildNeed(st) {
  try { fs.writeFileSync(BUILD_MEM, JSON.stringify({ sig: st.sig, need: st.need && Object.keys(st.need).length ? st.need : null, at: Date.now() })); } catch (e) {}
}
function loadBuildNeed(sig) {
  try {
    const m = JSON.parse(fs.readFileSync(BUILD_MEM, 'utf8'));
    return m && m.sig === sig && m.need && typeof m.need === 'object' && Date.now() - (m.at || 0) < BUILD_MEM_TTL ? m.need : null;
  } catch (e) { return null; }
}
const lackStr = m => Object.entries(m || {}).map(([k, n]) => `${k} ×${n}`).join(', ');
// шаг добора: каждого недостающего не больше buildStepItems (не «довести сумку до 101»); 0/пусто — пусто.
// gather_list считает ИТОГ в сумке, поэтому цель = что уже есть (have) + шаг
const stepNeed = (m, have) => {
  const out = {};
  for (const [k, n] of Object.entries(m || {})) {
    const q = Math.ceil(Number(n) || 0);
    if (q > 0) out[k] = (Number(have && have[k]) || 0) + Math.min(q, T.buildStepItems);
  }
  return out;
};
const haveOf = r => r && r.have && typeof r.have === 'object' ? { ...r.have } : null;
// недостающий материал из итога build_blueprint: поле missing (оно точнее), иначе текст «не хватает: a ×n, b ×m»
// (смета до стройки) или «не достроено: … не хватило: a ×n» (кончилось по ходу)
function lackOf(err, result) {
  const out = {};
  const m = result && result.missing;
  if (m && typeof m === 'object') for (const [k, n] of Object.entries(m)) if (Number(n) > 0) out[k] = Math.ceil(Number(n));
  if (Object.keys(out).length) return out;
  // «не хватает: a ×n», «не хватило: a ×n», «не хватает блоков: a ×n, b ×m» (lamp_posts и др.); разделитель ×/x
  const t = /не (?:хватает|хватило)[^:\n]*:\s*([^;\n]+)/.exec(String(err || ''));
  if (t) for (const q of t[1].matchAll(/([a-z0-9_]+)\s*[×x]\s*(\d+)/gi)) out[q[1]] = Number(q[2]);
  return out;
}
// постройка для decide: готова или на паузе — её нет (в выборе другие дела); иначе со списком добора
function buildState(ap, now) {
  const b = ap.build, st = ap.buildSt;
  if (!b || ap.buildHold || !st || st.sig !== b.sig || st.done || now < (st.pauseUntil || 0)) return { build: null };
  return { build: { ...b, need: st.need && Object.keys(st.need).length ? { ...st.need } : null, have: st.have ? { ...st.have } : null, gatherAway: !!st.gatherAway, partialStuck: !!st.stuck } };
}
// итог запуска дела постройки (verdict 'ok' | 'провал'): -> {note, done?} | null. Мозг тут не будится — всё решает муха.
function buildAfter(ap, run, verdict, err, result, now, progressed) {
  const st = ap.buildSt, b = ap.build;
  // строка сменилась, пока шёл навык, или постройка уже готова (build_done был) — ничего не меняем
  if (!st || !b || st.done || st.sig !== run.sig || (verdict !== 'ok' && verdict !== 'провал')) return null;
  const why = String(err || 'провал').split('\n')[0].slice(0, 120);
  const pause = text => {
    st.pauseUntil = now + T.buildRetryMs; st.reason = text; st.need = null; st.have = null; st.gathers = 0; st.stuck = false; st.partialEmpty = 0; st.pauses = (st.pauses || 0) + 1;
    return { note: `постройка ${b.name}: ${text} — повтор через ${Math.round(T.buildRetryMs / 1000)} с` };
  };
  if (progressed) { st.gathers = 0; st.pauses = 0; }
  if (run.key === 'build') {
    if (verdict === 'ok') {
      st.done = true; st.doneAt = now; st.need = null; st.reason = null;
      return { note: `постройка ${b.name}: готово — все клетки стоят`, done: true };
    }
    const lack = lackOf(err, result);
    if (Object.keys(lack).length) {
      if (st.gathers >= T.buildGatherMax) return pause(`добор не помогает (${st.gathers} раз без нового блока), не хватает ${lackStr(lack)}`);
      // v0.3: добор — ШАГ (<= buildStepItems каждого вида), а не «довести сумку до всего списка»
      st.have = haveOf(result);
      st.need = stepNeed(lack, st.have); st.reason = null; st.stuck = false; st.partialEmpty = 0;
      return { note: `постройка ${b.name}: не хватает ${lackStr(lack)} — что есть, ставлю частью, добираю шагом до ${lackStr(st.need)}` };
    }
    return pause(`провал (${why})`);
  }
  if (run.key === 'build_partial') {
    // v0.3: поставили часть — фиксируем прогресс и добираем ШАГ по названной нехватке; ничего не поставили —
    // не повторяем ту же пустую стройку, сразу шаг добора (stuck), а если и он пуст — пауза/смена способа
    const lack = lackOf(err, result);
    st.have = null;   // что подходило — поставлено (или не встало); сумку узнаем из следующего итога
    if (verdict === 'ok') {
      st.gathers = 0; st.stuck = false; st.partialEmpty = 0; st.reason = null;
      if (result && result.complete) {
        st.done = true; st.doneAt = now; st.need = null;
        return { note: `постройка ${b.name}: готово — все клетки стоят`, done: true };
      }
      const placed = Number(result && result.placed) || 0;
      st.need = Object.keys(lack).length ? stepNeed(lack) : null;
      return {
        note: placed > 0
          ? `постройка ${b.name}: поставил ${placed} клеток${st.need ? `, осталось добрать ${lackStr(st.need)}` : ''} — продолжаю шагами`
          : `постройка ${b.name}: всё, что было, поставил — проверяю остаток`
      };
    }
    st.stuck = true; st.partialEmpty = (st.partialEmpty || 0) + 1;
    st.need = stepNeed(Object.keys(lack).length ? lack : (st.need || {}));
    if (!Object.keys(st.need).length) return pause(`нечего ставить (${why})`);
    if (st.partialEmpty >= T.buildGatherMax) return pause(`нечего ставить ${st.partialEmpty} раз подряд (${lackStr(st.need)}) — меняю способ`);
    return { note: `постройка ${b.name}: нечего ставить (${why}) — добираю шагом ${lackStr(st.need)}` };
  }
  if (run.key === 'build_gather') {
    // behavior_autopilot_build_gather (3 дыры): (1) «ok» без всего нужного — не «строю снова» вслепую, а добор дальше;
    // (2) добор прерван (вытеснен/abort/отключение) — не пауза 3 мин, продолжаем сразу; (3) пустой добор — сначала
    // к месту постройки/другое место (gatherAway), пауза только если и там пусто
    const hasResult = result && typeof result === 'object' && ('collected' in result || 'crafted' in result || 'have' in result);
    const gotMap = hasResult ? { ...(result.collected || {}), ...(result.crafted || {}) } : {};
    const got = Object.keys(gotMap).length > 0;
    const added = got ? Object.entries(gotMap).map(([k, n]) => `${k}+${n}`).join(', ') : 'предметы добавлены';
    if (verdict !== 'ok' && GATHER_INTERRUPT.test(String(err || ''))) {
      // прерывание — не провал добора: need остаётся, доборы не считаем, паузы нет
      return { note: `постройка ${b.name}: добор прерван (${why}) — продолжаю`, resume: true };
    }
    st.gathers++;
    if (hasResult && result.have) st.have = haveOf(result);
    // have известен: всего ли хватает? нет — need остаётся (добираем дальше), да — строю
    const short = {};
    if (hasResult && result.have && st.need) for (const [k, n] of Object.entries(st.need)) if ((Number(result.have[k]) || 0) < n) short[k] = n - (Number(result.have[k]) || 0);
    const enough = !!(hasResult && result.have && st.need && !Object.keys(short).length);
    if (verdict === 'ok' && (!hasResult || got || enough)) {   // ok без итога — верим навыку, строю
      st.gatherAway = false; st.stuck = false;
      if (Object.keys(short).length) {
        return { note: `постройка ${b.name}: добор сделал (${added}), ещё не хватает ${lackStr(short)} — добираю дальше` };
      }
      st.need = null;
      return { note: `постройка ${b.name}: добор сделал (${added}) — строю снова` };
    }
    // провал, но что-то собрал — это прогресс: need остаётся, без паузы
    if (got) {
      st.gatherAway = false; st.stuck = false;
      return { note: `постройка ${b.name}: добор не до конца (${why}), но собрал ${added} — добираю дальше` };
    }
    // пустой добор: первый раз — меняем место (к постройке, decide даст build_go), повтор там же — честная пауза
    const haveStr = hasResult && result.have ? lackStr(result.have) : '?';
    const needStr = st.need ? lackStr(st.need) : '?';
    if (!st.gatherAway) {
      st.gatherAway = true;
      return { note: `постройка ${b.name}: добор ничего не дал (${haveStr}, нужно ${needStr}) — меняю место: иду к постройке / ищу дальше` };
    }
    // st.need НЕ сбрасываем — после паузы перестройка вернёт тот же итог
    st.gatherAway = false;
    st.pauses = (st.pauses || 0) + 1;
    st.pauseUntil = now + T.buildRetryMs; st.reason = `добор ничего не дал и на новом месте (${haveStr}, нужно ${needStr}) — материала нет, меняю способ`;
    return { note: `постройка ${b.name}: ${st.reason} — повтор через ${Math.round(T.buildRetryMs / 1000)} с` };
  }
  if (run.key === 'build_go') { if (verdict === 'ok') { st.gatherAway = false; return null; } return pause(`не дошла до места (${why})`); }
  return null;
}
// состояние постройки для /snapshot → autopilot (видят аудит и учитель)
function buildStatus(ap, now) {
  const b = ap.build; if (!b) return null;
  const st = ap.buildSt && ap.buildSt.sig === b.sig ? ap.buildSt : newBuildSt(b.sig);
  const run = ap.running && BUILD_KEYS.has(ap.running.key) ? ap.running.key : null;
  let status;
  if (ap.buildHold) { // «Постройка:» из «Текущей цели» закрыта (готова / провалена) или ждёт очереди — только для показа, в выбор не идёт
    const e = ap.planState && ap.planState.items[b.sig];
    status = e && e.status === 'done' ? 'готово' : e && e.status === 'failed' ? `провал (${e.reason || '—'}), повтор позже` : 'ждёт очереди';
  } else if (st.done) status = 'готово';
  else if (now < (st.pauseUntil || 0)) status = `пауза до ${new Date(st.pauseUntil).toTimeString().slice(0, 8)} (${st.reason})`;
  else if (run === 'build_go') status = 'иду к месту';
  else if (st.need && Object.keys(st.need).length) status = 'добираю ' + lackStr(st.need);
  else if (run === 'build_partial') status = st.stuck ? 'нечего ставить — добираю шаг' : 'ставлю, что есть';
  else status = run === 'build' ? 'строю' : 'строю (сейчас другое дело)';
  return { name: b.name, at: [b.x, b.y, b.z], rot: b.rot, status };
}

// ---------- v0.3 еда: где видела животных, что в сумке, под землёй ли ----------
// своя память поведения (worldmem животных не помнит): до 8 мест, места ближе 16 м склеиваем, свежее — первым
function noteAnimalSpot(ap, a, now) {
  const list = ap.animalSpots || (ap.animalSpots = []);
  const near = list.find(q => Math.hypot(q.x - a.x, q.z - a.z) < 16);
  if (near) Object.assign(near, { x: a.x, y: a.y, z: a.z, t: now, n: a.n });
  else list.push({ x: a.x, y: a.y, z: a.z, t: now, n: a.n });
  list.sort((q, w) => w.t - q.t);
  if (list.length > 8) list.length = 8;
}
// пришла на место, животных нет — место забываем (иначе ходит туда по кругу)
function forgetAnimalSpot(ap, x, z) {
  if (ap.animalSpots) ap.animalSpots = ap.animalSpots.filter(q => Math.hypot(q.x - x, q.z - z) >= 16);
}
// ближайшее свежее место с животными: не «тут» (foodSpotMinDist) и не путешествие (foodSpotMaxDist)
function animalSpotOf(ap, p, now) {
  let best = null;
  for (const q of ap.animalSpots || []) {
    if (now - q.t > T.foodSpotTtlMin * 60000) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < T.foodSpotMinDist || d > T.foodSpotMaxDist) continue;
    if (!best || d < best.d) best = { x: q.x, y: q.y, z: q.z, d: Math.round(d), ago: Math.round((now - q.t) / 60000), n: q.n };
  }
  return best;
}
const RAW_FOOD = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
// еда в сумке для decide: единиц запаса (съедобное не из чёрного списка), сырое на жарку (чего больше, не больше 16 за заход),
// топливо (уголь, или брёвна/доски от 4 — дерево нужно и на кирку), пшеница на хлеб
function foodInv(inv, foods, bl) {
  let units = 0;
  for (const [n, c] of Object.entries(inv)) if (foods[n] && !bl.has(n) && !n.endsWith('_bucket')) units += c;
  const raw = RAW_FOOD.filter(n => inv[n] > 0).sort((a, b) => inv[b] - inv[a])[0];
  const sum = re => Object.entries(inv).filter(([n]) => re.test(n)).reduce((s, [, c]) => s + c, 0);
  return {
    foodUnits: units,
    rawFood: raw ? { name: raw, count: Math.min(16, inv[raw]) } : null,
    fuel: sum(/^(coal|charcoal|coal_block)$/) > 0 || sum(/_(log|stem)$|_planks$/) >= 4,
    wheat: inv.wheat || 0
  };
}
// под землёй: ниже поверхности (y базы, без базы — 63) больше чем на undergroundDy, над головой свод (твёрдое в 24 блоках)
// и неба не видно (skyLight < 8, если сервер его дал). Каньон под открытым небом — не «под землёй»
function undergroundOf(bot, p, surfaceY) {
  if (p.y >= surfaceY - T.undergroundDy) return false;
  let roof = false;
  for (let dy = 2; dy < 26 && !roof; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === 'block') roof = true; }
  if (!roof) return false;
  const h = bot.blockAt(p.offset(0, 1, 0));
  return !(h && typeof h.skyLight === 'number' && h.skyLight >= 8);
}

// v0.3 еда, этап 2: куда ловить. open — есть открытая вода (над водой воздух, как требует fish) в 16 м; нет — ближайший блок льда
// над водой (прорубь: сломать лёд, тогда вода открыта) или null. Тяжёлый обход мира — вызывать редко (кэш в gather)
function fishSpot(ctx) {
  const bot = ctx.bot, reg = bot.registry.blocksByName, p = bot.entity.position;
  if (!reg.water) return null;
  const up = q => bot.blockAt(q.offset(0, 1, 0));
  const open = vision.find(ctx, [reg.water.id], { radius: 16, count: 60 }).some(w => { const u = up(w); return !!u && A.isAirLike(u); });
  if (open || !reg.ice) return { open, ice: null };
  const ice = vision.find(ctx, [reg.ice.id], { radius: 16, count: 40 })
    .filter(q => { const b = bot.blockAt(q.offset(0, -1, 0)), u = up(q); return !!b && b.name === 'water' && !!u && A.isAirLike(u); })
    .sort((a, b) => a.distanceTo(p) - b.distanceTo(p))[0];
  return { open: false, ice: ice ? { x: ice.x, y: ice.y, z: ice.z } : null };
}

// дичь рядом (козы не в счёт: мяса нет — ни охота, ни запоминание места «с животными» их не видит)
function gameNear(ents, p, radius) {
  return ents.filter(e => isAnimal(e) && GAME.includes(entName(e)) && e.position.distanceTo(p) <= radius);
}

function gather(ctx, ap) {
  const bot = ctx.bot;
  const now = Date.now();
  const p = bot.entity.position;
  const items = bot.inventory.items();
  const sum = re => items.filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0);
  const inv = {};
  for (const i of items) inv[i.name] = (inv[i.name] || 0) + i.count;
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
  // v0.3 еда: животные рядом — запомнить место (ближайшее), печь рядом, под землёй ли
  const animalEnts = gameNear(ents, p, T.animalsR);
  const overworld = baseDimOk(bot);
  if (animalEnts.length && overworld) {
    const a = animalEnts.slice().sort((x, y) => x.position.distanceTo(p) - y.position.distanceTo(p))[0];
    noteAnimalSpot(ap, { x: Math.floor(a.position.x), y: Math.floor(a.position.y), z: Math.floor(a.position.z), n: animalEnts.length }, now);
  }
  let tableNear = (inv.crafting_table || 0) > 0;
  try { const tb = bot.registry.blocksByName.crafting_table; if (!tableNear && tb) tableNear = vision.find(ctx, [tb.id], { radius: 24, count: 1 }).length > 0; } catch (e) {}
  let furnaceNear = false;
  try { const fb = bot.registry.blocksByName.furnace; if (fb) furnaceNear = vision.find(ctx, [fb.id], { radius: 24, count: 1 }).length > 0; } catch (e) {}
  // v0.3 еда, этап 2: вода и деревня из памяти мира (worldmem), вода у базы под ферму, вода вокруг для удочки (кэш 5 с)
  let water = null, village = null, farmWater = null, fish = null;
  try {
    const wm = overworld ? ctx.worldmem : null;
    if (wm) {
      const at = v => ({ x: v.at[0], y: v.at[1], z: v.at[2], d: Math.round(v.dist) });
      const w1 = wm.near('water', p, { limit: 1, maxDist: T.fishWaterDist })[0]; if (w1) water = at(w1);
      const v1 = wm.near('village', p, { limit: 1, maxDist: T.villageMaxDist })[0]; if (v1) village = { ...at(v1), villagers: v1.villagers || 0 };
      // вода у базы под ферму: несколько ближних, по высоте базы (не речка на дне каньона) и мимо точек, где ферма уже проваливалась
      if (ap.base) farmWater = farmWaterPick(wm.near('water', ap.base, { limit: T.farmWaterCands, maxDist: T.farmWaterDist }), ap.base, ap.farmBad, now);
    }
    if (overworld && (inv.fishing_rod || 0) > 0) {
      if (!ap.fishView || now - ap.fishView.t > 5000) ap.fishView = { t: now, v: fishSpot(ctx) };
      fish = ap.fishView.v;
    }
  } catch (e) {}
  const vhDone = {}; for (const [c, t] of Object.entries(ap.vh || {})) if (now - t < T.villageHarvestMin * 60000) vhDone[c] = true; // культуры деревни, уже пробованные
  const surfaceY = ap.base && Number.isFinite(ap.base.y) ? ap.base.y : 63;
  let underground = false; try { underground = overworld && undergroundOf(bot, p, surfaceY); } catch (e) {}
  // v0.3 ночь у базы (шаг 6): шерсть лучшего цвета, кровать в сумке, овцы рядом, своя поставленная кровать у базы (память; блока нет — забываем)
  let wool = 0, woolColor = null;
  for (const [n, c] of Object.entries(inv)) { const m = /^(\w+)_wool$/.exec(n); if (m && c > wool) { wool = c; woolColor = m[1]; } }
  let bedHome = null;
  if (ap.bed) {
    try {
      const bb = bot.blockAt(p.offset(ap.bed.x - p.x, ap.bed.y - p.y, ap.bed.z - p.z));
      if (bb && !/_bed$/.test(bb.name)) { ap.bed = null; } // кровать сломали/убрали — поставим заново (блок загружен и не кровать)
      else bedHome = { x: ap.bed.x, y: ap.bed.y, z: ap.bed.z };
    } catch (e) { bedHome = { x: ap.bed.x, y: ap.bed.y, z: ap.bed.z }; }
  }
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
    // HP низкий (рефлекс ест «отчаянно», behavior_eat_desperate_hp) — гнилое мясо/сырая курица тоже еда
    hasFood: items.some(i => foods[i.name] && (!FOOD_BL.has(i.name) || (bot.health <= T.eatHurtHp && (i.name === 'rotten_flesh' || i.name === 'chicken'))) && !i.name.endsWith('_bucket')),
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
    freeBed, animals: animalEnts.length,
    pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, // v0.4: где стоит (копка над головой, путевые точки домой)
    animalD: animalEnts.length ? r1(Math.min(...animalEnts.map(e => e.position.distanceTo(p)))) : null, // v0.4: ближайшее животное, м (ночной поводок при низком HP)
    handArmed: !!(bot.heldItem && /_sword$|_axe$|^(trident|mace)$/.test(bot.heldItem.name)), // v0.4: в руке оружие
    afterDeath: !!(ld && now - ld.ts < T.respawnWindowMs), // v0.4 (2.5): недавно умерла (возродилась)
    escapeFailed: (() => { const o = {}; for (const [m, t] of Object.entries(ctx.escapeFail || {})) if (now - t < T.escapeFailMemMs) o[m] = true; return o; })(), // v0.4 (2.4): побег от этих мобов не оторвался
    ...foodInv(inv, foods, FOOD_BL), furnaceNear, underground, surfaceY, // v0.3 еда: запас, сырое, топливо, пшеница; печь; под землёй
    animalSpot: overworld ? animalSpotOf(ap, p, now) : null,  // v0.3: где недавно видела животных (не тут и не далеко)
    // v0.3 еда, этап 2: удочка, нить, семена, мотыга; вода/лёд, деревня, вода у базы, пробованные культуры деревни, ферма
    rod: inv.fishing_rod || 0, string: inv.string || 0, seeds: inv.wheat_seeds || 0, hoe: items.some(i => /_hoe$/.test(i.name)),
    water, fish, village, farmWater, vhDone, farm: ap.farm ? { x: ap.farm.x, z: ap.farm.z, sinceMin: (now - ap.farm.t) / 60000, dry: !!ap.farm.dry } : null,
    recoverable: !!(ld && ld.at && now - ld.ts < T.recoverMs && ap.recoverFor !== ld.ts),
    blocked, failInfo: failInfoOf(ap, now),
    // v0.3 инструменты: что в сумке (лучший ранг каждого вида) и из чего делать; навыки, которые исполнитель не запустит
    tools: { ...toolTiers(items), planks: sum(/_planks$/), sticks: inv.stick || 0, logs: sum(/_(log|stem)$/), cobble: sum(/^(cobblestone|cobbled_deepslate)$/), table: tableNear },
    skillOff: ap.skillOff || {}, skillKnown: ap.skillKnown || null,
    skillVer: pickVersions(ap.skillList, new Set(Object.values(crashList(ap, now)).map(c => c.file).filter(Boolean))), // v0.4: какую версию навыка звать
    // v0.3 ночь у базы: кровать (в сумке / поставлена у базы), шерсть, овцы, ножницы; факелы и уголь, когда светила в последний раз
    bedItem: sum(/_bed$/), bedHome, wool, woolColor, shears: (inv.shears || 0) > 0, sheep: animalEnts.filter(e => entName(e) === 'sheep').length,
    torches: inv.torch || 0, coal: inv.coal || 0, lightSinceMin: ap.light ? (now - ap.light.t) / 60000 : null,
    waitSec: ap.waitSince ? Math.round((now - ap.waitSince) / 1000) : 0, // сколько тело свободно, а автопилот ждёт (потолок apWaitMaxSec)
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
    skillList: null, skillVerSeen: '', // v0.4: GET /skills (имя, enabled, valid, stats) -> pickVersions; что выбрано в прошлый раз (для журнала)
    skillOff: {}, skillKnown: null, // v0.3: выключенные/не найденные выученные навыки (из того же GET /skills раз в 30 с) — decide их не выбирает
    goalFail: null,   // проваленная цель мозга: {sig, name, reason, at} — повтор через goalRetryMs (v0.2)
    goalDiv: 1, goalDivSig: null, // шаг цели после провалов: count/n делим на goalDiv
    goalDoneAt: 0, goalEmpty: null, // выполнена когда; выполнена без прогресса (sig) — не повторяем
    goalNeed: null, goalGather: null, // v0.4: цель упала на нехватке — {sig, need} (добор goal_gather) и счёт доборов подряд {sig, n}
    goalFailNote: null, // что написать в журнал про проваленную цель (сразу после строки о провале)
    build: null, buildSt: null, // v0.2 «Постройка:» (из «Текущей цели» или пункт очереди) и как она идёт (newBuildSt)
    buildHold: false,           // build — «Постройка:» из notes.md, но закрыта/ждёт очереди: показываем в статусе, в выбор не идёт
    // v0.3 очередь «## План» (behavior/plan.js): разобранный список, память пунктов (data/autopilot_plan.json), что выбрано
    planState: PL.emptyPlan(), planFile: null, planItems: [], planCopy: false, planInfo: null, planNoted: {}, notesBuild: null,
    notesFile: null, bpDir: null, switchesDir: undefined, brainT: 0, brainV: true, goalSigSeen: undefined, // *File/bpDir/switchesDir — подмена путей в тестах
    codeCrash: {},    // навыки, упавшие со сбоем кода: {навык: {reason, at}} — автопилот их не зовёт
    _mod: MOD, fails: {}, failInfo: {}, until: {}, lastChat: 0, recoverFor: 0, stuckSince: 0, wetSince: 0, lastPos: null, ticking: false, history: [],
    lastHp: null, // HP на прошлом тике: упало — по муху били (ap.lastHit), ночью тогда не wait_night (L052)
    lastHit: 0,   // последний урон: свежий apHitFreshMs — блокирует wait_night и ямы (L052, смерть 23)
    yields: 0, yieldWatch: null,
    farm: null, farmBad: [], vh: {}, fishView: null, // v0.3 еда, этап 2: ферма у базы {x,z,t}, культуры деревни {crop: когда пробовала}, кэш воды/льда для удочки
    bed: null, light: null // v0.3 ночь у базы: своя кровать у базы {x,y,z,t}, когда последний раз расставляла факелы {t}
  };
  const note = (text, chat) => {
    ctx.events.push('info', { msg: 'автопилот: ' + text, autopilot: true });
    if (chat && Date.now() - ap.lastChat >= CHAT_MS && ctx.statusChat) { ap.lastChat = Date.now(); ctx.statusChat('автопилот: ' + text, true); }
  };

  // имя ближайшего враждебного моба (null — нет): побег без отрыва запоминаем по виду моба (ctx.escapeFail), не по id
  const hostileName = () => {
    try {
      const bot = ctx.bot; if (!bot || !bot.entity) return null;
      const p = bot.entity.position; let best = null, bd = Infinity;
      for (const e of Object.values(bot.entities || {})) {
        if (!e || e === bot.entity || !e.position || !isHostile(e)) continue;
        const d = e.position.distanceTo(p); if (d < bd) { bd = d; best = entName(e); }
      }
      return best;
    } catch (e) { return null; }
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
    const hpLow = st.hp < T.apLowHp;
    if (hpLow) {
      note(`мало HP (${st.hp}) — жду ${st.waitSec || 0} с из ${T.apWaitMaxSec} (${st.sheltered ? 'в укрытии' : 'без укрытия'}${st.hasFood ? '' : ', еды нет'}), потом действую`);
    } else {
      note(`опасность${st.hostile ? ` (${st.hostile.name} ${st.hostile.d} м)` : ''} — ждать нельзя (HP ${st.hp}, ${st.sheltered ? 'в укрытии' : 'без укрытия'})`);
    }
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

  // ---- v0.3 очередь «## План» (behavior/plan.js): память пунктов, выбор, итоги ----
  const savePlanState = () => { if (ap.planFile) PL.savePlan(ap.planFile, ap.planState); };
  // включён ли мозг на пульте (data/switches.json), кэш 30 с; нет файла/мусор — включён (как в lib/switches.js)
  const brainIsOn = () => {
    const t = Date.now();
    if (t - ap.brainT > 30000) { ap.brainT = t; try { ap.brainV = SW.isOn('brain', ap.switchesDir); } catch (e) { ap.brainV = true; } }
    return ap.brainV;
  };
  // пропуск пункта: нет файла чертежа / неизвестный или выключенный навык (проверяется заново каждый тик — пропуск не навсегда)
  const planVeto = it => {
    if (it.kind === 'build') {
      return fs.existsSync(path.join(ap.bpDir || BLUEPRINTS, it.build.name + '.txt')) ? null : { reason: `нет чертежа ${it.build.name}.txt в brain/blueprints` };
    }
    const name = it.goal.name;
    if ((ctx.skillNames || []).some(k => norm(k) === norm(name))) return null;
    const known = ap.skillKnown || (ap.goalSkills.names.size ? [...ap.goalSkills.names] : null); // список не получали — не судим
    if (known && !known.includes(name)) return { reason: `неизвестный навык ${name}` };
    if (ap.skillOff && ap.skillOff[name]) return { reason: `навык ${name} выключен у исполнителя` };
    return null;
  };
  function pickPlan() {
    const now = Date.now();
    const pick = PL.planPick({ own: ap.notesBuild, goal: ap.goalRaw, items: ap.planItems, state: ap.planState, now, brainOn: brainIsOn(), veto: planVeto });
    ap.planInfo = pick;
    for (const s of pick.skipped) { // причина пропуска — в журнал один раз
      const k = s.item.sig + '|' + s.reason;
      if (!ap.planNoted[k]) { ap.planNoted[k] = 1; note(`очередь: пропускаю «${PL.label(s.item)}» — ${s.reason}`); }
    }
    if (pick.retry) { // проваленный пункт пора пробовать снова: чистый лист (память о провале и счётчик пауз)
      const sig = pick.item ? pick.item.sig : pick.build.sig;
      delete ap.planState.items[sig]; savePlanState();
      note(`очередь: повторяю «${pick.item ? PL.label(pick.item) : 'Постройка: ' + pick.build.name}» — раньше не вышло`);
    }
    return pick;
  }
  // пункт готов: память, событие plan_item_done (для пунктов очереди), перечитать notes.md (мозг/хозяин увидят свежее)
  function planDone(sig, label, isBuild, now, extra) {
    PL.mark(ap.planState, sig, 'done', '', now, 0);
    if (isBuild) ap.planState.doneAt = now;
    savePlanState();
    if (ap.planItems.some(i => i.sig === sig)) ctx.events.push('plan_item_done', { item: label, ...extra });
    ap.goalMtime = -1; // кэш времени notes.md сбросить — файл перечитается
  }
  // итог «Автопилот:» из очереди: ok — готово (plan_item_done); провал planFailPauses раз подряд без нового блока — failed
  function planGoalAfter(run, verdict, reason, now, progressed) {
    const it = (ap.planItems || []).find(i => i.kind === 'goal' && i.mark === ' ' && i.sig === run.sig);
    if (!it) return;
    if (verdict === 'ok') { planDone(it.sig, PL.label(it), false, now, { kind: 'goal', skill: it.goal.name }); return; }
    const prev = ap.planState.items[it.sig];
    const n = (progressed ? 0 : (prev && prev.pauses) || 0) + 1;
    if (n >= T.planFailPauses) { planFailed(it.sig, PL.label(it), reason, now); return; }
    PL.mark(ap.planState, it.sig, 'open', reason, now, n); savePlanState();
  }
  function planFailed(sig, label, reason, now) {
    PL.mark(ap.planState, sig, 'failed', reason, now, T.planFailPauses);
    savePlanState();
    note(`очередь: «${label}» не вышло ${T.planFailPauses} раза подряд без нового блока: ${reason} — иду к следующему пункту, повтор через ${Math.round(T.planRetryMs / 3600000)} ч`);
    ap.goalMtime = -1;
  }

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
        // v0.3: выключенные навыки (авто после провалов / вручную) не предлагаем; список не пришёл — прежний набор, ничего не меняем
        const gate = skillGate(r && r.skills);
        if (gate) {
          const was = Object.keys(ap.skillOff || {}).sort().join(', '), nowOff = Object.keys(gate.off).sort().join(', ');
          ap.skillOff = gate.off; ap.skillKnown = gate.known;
          // v0.4 версии навыков: кого звать вместо базового имени (пишем в журнал, когда выбор поменялся)
          ap.skillList = (r.skills || []).filter(x => x && x.name).map(x => ({ name: x.name, enabled: x.enabled, valid: x.valid, stats: { runs: (x.stats && x.stats.runs) || 0, ok: (x.stats && x.stats.ok) || 0 } }));
          const pv = Object.entries(pickVersions(ap.skillList)).filter(([b, v]) => b !== v).map(([b, v]) => b + ' → ' + v).sort().join(', ');
          if (pv !== ap.skillVerSeen) { ap.skillVerSeen = pv; note(pv ? 'версии навыков (звать вместо базового имени): ' + pv : 'версии навыков: звать базовые имена'); }
          if (was !== nowOff) note(nowOff ? `выключены у исполнителя — не выбираю: ${Object.entries(gate.off).map(([k, v]) => k + ' (' + v.slice(0, 60) + ')').join('; ')}` : 'выключенных навыков нет — выбираю любые');
        }
      } catch (e) {}
    }
    let mt = 0; try { mt = fs.statSync(ap.notesFile || NOTES).mtimeMs; } catch (e) { ap.goal = null; ap.base = null; ap.build = null; ap.buildHold = false; ap.notesBuild = null; ap.planInfo = null; return; }
    if (mt !== ap.goalMtime) {
      ap.goalMtime = mt;
      let g = null, txt = ''; try { txt = fs.readFileSync(ap.notesFile || NOTES, 'utf8'); g = parseGoal(txt); } catch (e) {}
      ap.base = parseBase(txt);
      ap.notesBuild = parseBuild(txt);
      // v0.3 очередь «## План»: раздел есть — он (и копия обновляется); пропал (мозг переписал файл) — последняя копия
      const pl = PL.planList(txt, ap.planState);
      ap.planItems = pl.items; ap.planCopy = pl.copy;
      if (pl.changed) { ap.planState.list = pl.list; PL.prune(ap.planState, new Set(pl.items.map(i => i.sig)), Date.now()); savePlanState(); }
      const bsig = ap.base ? `${ap.base.x} ${ap.base.y} ${ap.base.z} ${ap.base.r}` : '';
      if (bsig !== ap.baseSig) { ap.baseSig = bsig; delete ap.until.go_base; ap.fails.go_base = 0; } // новая база — пауза не действует
      ap.goalRaw = g;
    }
    // что делать по цели — «Постройка:» из «Текущей цели» → очередь «## План» → «Автопилот:» (behavior/plan.js, planPick)
    const pick = pickPlan();
    const bl = pick.build || null;
    // v0.2: новая строка «Постройка:» (или пункт очереди) — всё сначала (пауза, добор, «готово» — про прежнюю строку)
    if (bl && (!ap.buildSt || ap.buildSt.sig !== bl.sig || pick.retry)) {
      ap.buildSt = newBuildSt(bl.sig);
      for (const k of BUILD_KEYS) { delete ap.until[k]; delete ap.failInfo[k]; ap.fails[k] = 0; }
      const mem = loadBuildNeed(bl.sig); // рестарт: нехватка по памяти — сначала добор
      if (mem) { ap.buildSt.need = mem; note(`постройка ${bl.name}: не хватает по памяти (${lackStr(mem)}) — добираю`); }
    }
    ap.build = bl || ap.notesBuild; ap.buildHold = !bl && !!ap.notesBuild;
    // новая строка «Автопилот:» (или пункт очереди) — новая попытка: проваленную цель можно пробовать снова
    const g = pick.goal || ap.goalRaw;
    const gsig = g ? g.sig : null;
    if (gsig !== ap.goalSigSeen || (pick.retry && pick.goal && pick.via === 'plan')) {
      ap.goalSigSeen = gsig;
      delete ap.until.goal; ap.fails.goal = 0; ap.goalFail = null; ap.goalDiv = 1; ap.goalDivSig = null; ap.goalEmpty = null; ap.goalNeed = null; ap.goalGather = null;
      if (g && g.name) delete ap.codeCrash[g.name]; // сбой кода этого навыка — тоже новая попытка
    }
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
    plan: PL.planStatus({ items: ap.planItems, state: ap.planState, now: Date.now(), pick: ap.planInfo, copy: ap.planCopy }), // v0.3 очередь «## План»: сколько открыто/готово/провал, что сейчас
    ...(ap.goalNeed && ap.goal && ap.goalNeed.sig === ap.goal.sig ? { goalGather: `${ap.goal.name}: добираю ${lackStr(ap.goalNeed.need)}` } : {}),
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
      // v0.4 (2.1): подъём наверх — два одинаковых провала подряд = пауза surfacePauseMs (раньше повтор каждые 3 с: 88 запусков, 80 провалов)
      if (/^surface/.test(run.key) && same && count >= T.failSameCount) ap.until[run.key] = Math.max(ap.until[run.key], now + T.surfacePauseMs);
      // v0.4 (2.3): травы за семенами не нашла (или сбор упал) — пауза seedsGrassPauseMs
      if (run.key === 'seeds_grass') ap.until[run.key] = Math.max(ap.until[run.key], now + T.seedsGrassPauseMs);
      if (same && count >= T.failSameCount) ap.fails[run.key] = 0;      // та же причина — пауза длиннее
      else if (n >= FAIL_MAX) ap.fails[run.key] = 0;
      // сбой кода навыка (в ошибке — файл и строка): это не отказ о мире, тот же вызов упадёт так же —
      // автопилот его не повторяет: сообщает мозгу и ждёт правки
      if (run.kind === 'learned' && run.name && isCodeCrash(err)) {
        const cbase = run.base || run.name; // счёт сбоя — по базе, а не по каждой версии отдельно; file — какая версия упала
        ap.codeCrash[cbase] = { reason, at: now, mtime: learnedMtime(run.name), ...(run.name !== cbase ? { file: run.name } : {}) };
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
      if (!grew && run.mob0) (ctx.escapeFail || (ctx.escapeFail = {}))[run.mob0] = now; // v0.4 (2.4): от такого моба не оторвалась — в следующий раз сразу укрытие
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
        ap.goalFailNote = goalAfter(ap, run, verdict, reason, now, (ctx.lastProgressAt || 0) >= run.started, err, res && res.result);
        // v0.3: пункт очереди «Автопилот:»; v0.4: нехватка с добором — не провал пункта, пока добор идёт
        if (!(verdict === 'провал' && ap.goalNeed && ap.goalNeed.sig === run.sig)) planGoalAfter(run, verdict, reason, now, (ctx.lastProgressAt || 0) >= run.started);
        if (ap.goalNeed && ap.goalNeed.sig === run.sig) { delete ap.until.goal_gather; delete ap.failInfo.goal_gather; ap.fails.goal_gather = 0; delete ap.until.goal; delete ap.failInfo.goal; ap.fails.goal = 0; } // нехватка — шаг, а не провал
      } else {
        ap.until.goal = Math.max(ap.until.goal || 0, now + BACKOFF_MS); // прерванная/выключенная цель — тоже пауза (L013)
      }
    }
    if (run.key === 'goal_gather') {
      // v0.4 добор под цель «Автопилот:»: хватило — цель снова; ничего не дал / не помогает — провал цели (пауза, очередь); прервали — продолжаем
      if (verdict === 'ok' || verdict === 'провал') {
        const r = goalGatherAfter(ap, run, verdict, err, res && res.result, now);
        if (r && r.note) ap.goalFailNote = r.note;
        if (r && r.failed) planGoalAfter(run, 'провал', r.failed, now, false);
        if (r && r.resume) { delete ap.failInfo[run.key]; ap.fails[run.key] = 0; ap.until[run.key] = now + 4000; }
        else if (r && !r.failed) { delete ap.until.goal; ap.fails.goal = 0; }
      } else {
        ap.until[run.key] = Math.max(ap.until[run.key] || 0, now + 10000); // прерванный — короткая пауза, материал всё ещё нужен
      }
    }
    if (BUILD_KEYS.has(run.key)) {
      if (verdict === 'ok' || verdict === 'провал') {
        // v0.2 постройка: готово — build_done один раз на строку; не хватило — добор; другое — пауза и повтор (мозг не будим)
        const r = buildAfter(ap, run, verdict, err, res && res.result, now, (ctx.lastProgressAt || 0) >= run.started);
        if (r && run.key === 'build' && ap.buildSt && ap.buildSt.need) { delete ap.until.build; delete ap.failInfo.build; ap.fails.build = 0; } // нехватка — шаг, а не провал
        if (r && r.done) {
          ctx.events.push('build_done', { name: ap.build.name, at: [ap.build.x, ap.build.y, ap.build.z], rot: ap.build.rot });
          // v0.3: готова (своя «Постройка:» или пункт очереди) — в память; пункт очереди — ещё plan_item_done; мозг включён — ждёт 10 мин новую «Постройку:»
          planDone(run.sig, PL.label({ kind: 'build', build: ap.build }), true, now, { kind: 'build', name: ap.build.name, at: [ap.build.x, ap.build.y, ap.build.z] });
        } else if (r && ap.buildSt && ap.buildSt.sig === run.sig && !ap.buildSt.done && (ap.buildSt.pauses || 0) >= T.planFailPauses && now < (ap.buildSt.pauseUntil || 0)
            && !(ap.planState.items[run.sig] && ap.planState.items[run.sig].status === 'failed')) {
          // v0.3: planFailPauses пауз подряд без нового блока — провал: следующий пункт, повтор через planRetryMs
          planFailed(run.sig, PL.label({ kind: 'build', build: ap.build }), ap.buildSt.reason || 'пауза стройки', now);
        }
        if (r && r.note) ap.goalFailNote = r.note;
        if (ctx.bot && ap.buildSt) saveBuildNeed(ap.buildSt); // нехватка переживёт рестарт тела
        // добор прерван (вытеснен/abort) — не провал: без паузы и без счёта провалов, через тик продолжаем (behavior_autopilot_build_gather)
        if (r && r.resume) { delete ap.failInfo[run.key]; ap.fails[run.key] = 0; ap.until[run.key] = now + 4000; }
      } else {
        // прервана/выключена — пауза (L013); добор — короткая: его прерывают мобы/рефлексы, а материал всё ещё нужен
        ap.until[run.key] = Math.max(ap.until[run.key] || 0, now + (run.key === 'build_gather' ? 10000 : BACKOFF_MS));
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
    // v0.3 еда: дошла к месту с животными — место забываем (животные тут — gather запомнит снова; нет — туда не ходим по кругу)
    if (run.key === 'food_spot' && verdict === 'ok' && run.params) forgetAnimalSpot(ap, run.params.x, run.params.z);
    // v0.3 еда, этап 2: деревня — культуру пробовала (ok или провал: снова не раньше villageHarvestMin); ферма — когда сделана; рыбалка — паузы
    if (/^vh_/.test(run.key) && (verdict === 'ok' || verdict === 'провал')) (ap.vh || (ap.vh = {}))[run.key.slice(3)] = now;
    if (run.key === 'farm' && verdict === 'ok' && run.params) ap.farm = { x: run.params.x, z: run.params.z, t: now, ...(Number(run.params.dry) === 1 ? { dry: true } : {}) };
    // ферма провалилась из-за воды/участка («у участка нет воды», «на участке нечего вскапывать/сажать») — эту точку farmBad не выбираем farmBadMin минут
    // (иначе цикл: та же вода из памяти, тот же провал); если это была уже посаженная ферма — забываем и её
    if (run.key === 'farm' && verdict === 'провал' && run.params && /вод[аыуе]|участк/i.test(String(err))) {
      ap.farmBad = (ap.farmBad || []).filter(b => now - b.t < T.farmBadMin * 60000).concat({ x: run.params.x, z: run.params.z, t: now }).slice(-8);
      if (ap.farm && Math.hypot(ap.farm.x - run.params.x, ap.farm.z - run.params.z) <= T.farmBadR) ap.farm = null;
    }
    // v0.3 ночь у базы: кровать поставлена (bring_bed_home вернул at) — запоминаем; факелы — ok или провал, снова не раньше lightRepeatMin
    if (run.key === 'bed_home' && verdict === 'ok') {
      const rr = res && (res.result || res), at = rr && rr.placed !== false && Array.isArray(rr.at) ? rr.at.map(Number) : null;
      if (at && at.length >= 3 && at.every(Number.isFinite)) ap.bed = { x: at[0], y: at[1], z: at[2], t: now };
    }
    if (run.key === 'light_base' && (verdict === 'ok' || verdict === 'провал')) ap.light = { t: now };
    if ((run.key === 'night_craft' || run.key === 'night_smelt' || run.key === 'night_cook') && verdict === 'ok') ap.until[run.key] = now + T.nightCraftPauseMs; // нужда в снимке обновится позже — не крутить
    if (run.key === 'fish_go' && verdict === 'ok') ap.until.fish_go = now + T.fishGoPauseMs; // пришла, а ловить негде — к воде снова не сразу
    if (run.key === 'fish' && verdict === 'ok') { const rr = res && (res.result || res); if (!(rr && rr.caught && Object.keys(rr.caught).length)) ap.until.fish = now + T.fishNoCatchMs; } // без улова — пауза
    if (ap.yieldWatch && ap.yieldWatch.name === run.name) ap.yieldWatch = null;
    ap.history.push({ key: run.key, name: run.name, verdict, sec: Math.round(sec), ...(byBrain ? { brain: cmdAction } : {}), ...(err ? { error: err.split('\n')[0].slice(0, 160) } : {}) });
    if (ap.history.length > 20) ap.history.shift();
    note(`${run.name}: ${verdict}${byBrain ? ` (команда ${cmdWho}: ${cmdAction})` : ''}${err && (verdict === 'провал' || verdict === 'навык выключен') ? ' — ' + err.split('\n')[0].slice(0, 160) : ''}`);
    if (ap.goalFailNote) { note(ap.goalFailNote); ap.goalFailNote = null; } // «цель X: та же причина — не повторяю» — сразу после провала
    if (ap.running === run) ap.running = null;
  }

  function start(act) {
    const run = { ...act, started: Date.now(), aborting: null, ...((act.key === 'goal' || act.key === 'goal_gather') && ap.goal ? { sig: ap.goal.sig } : {}), ...(BUILD_KEYS.has(act.key) && ap.build ? { sig: ap.build.sig } : {}) };
    if (act.name === 'escape') { run.enemyD0 = hostileD(); run.mob0 = hostileName(); } // сколько было до врага и кто он — чтобы честно оценить побег
    ap.running = run;
    if (act.key === 'recover' && ctx.lastDeath) ap.recoverFor = ctx.lastDeath.ts;
    note(act.why, true);
    const p = act.kind === 'learned'
      ? runnerGo(act.name, act.params, (act.base || act.name) === 'day_routine' ? 720 : (act.base || act.name) === 'go_safe' ? T.goSafeMaxSec + 60 : 900)
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
      // простой страшнее смерти: сколько автопилот уже «ждёт» при свободном теле (s.waitSec в decide — потолок apWaitMaxSec)
      ap.waitSince = !act && st.idle && !st.task && !st.runnerOther && !ap.running ? (ap.waitSince || now) : 0;
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
  ap.refreshGoal = refreshGoal;
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
    ap.planFile = PLAN_FILE; ap.planState = PL.loadPlan(PLAN_FILE); // v0.3: память пунктов очереди переживает рестарт тела
    if (prev) { ap.on = prev.on !== false; ap.pausedUntil = prev.pausedUntil || 0; ap.lastBrainCmd = prev.lastBrainCmd || ap.lastBrainCmd; ap.yields = prev.yields || 0; ap.history = Array.isArray(prev.history) ? prev.history.slice(-20) : []; ap.goalFail = prev.goalFail || null; ap.goalDiv = prev.goalDiv || 1; ap.goalDivSig = prev.goalDivSig || null; ap.goalDone = prev.goalDone || null; ap.goalDoneAt = prev.goalDoneAt || 0; ap.goalEmpty = prev.goalEmpty || null; ap.codeCrash = prev.codeCrash || {}; ap.lastHp = prev.lastHp != null ? prev.lastHp : null; ap.lastHit = prev.lastHit || 0; ap.goSafe = !!prev.goSafe; ap.skillOff = prev.skillOff || {}; ap.skillKnown = prev.skillKnown || null; ap.skillList = prev.skillList || null; ap.goSafeT = prev.goSafeT || 0; ap.buildSt = prev.buildSt || null; ap.animalSpots = Array.isArray(prev.animalSpots) ? prev.animalSpots : []; ap.farm = prev.farm || null; ap.vh = prev.vh || {}; ap.bed = prev.bed || null; ap.light = prev.light || null; }
    ctx.autopilot = ap;
  }
  api.on(bot, 'death', () => { ap.yieldAll('смерть').catch(() => {}); });
  api.every(TICK_MS, () => ap.tick(), 'автопилот', { always: true });
  return { detach: reason => ap.yieldAll(reason || 'поведение выгружено') };
}

// версия (v0.4 ночь у базы, этап 3): ночью у базы без угроз нужда стройки/цели (spruce_fence, torch, доски, палки) крафтится из сумки (night_craft), stone плавится из булыжника (night_smelt), сырое мясо жарится (night_cook) — вместо «дел нет — пережидаю ночь»; счёт ниже угроз и еды, выше wait_night; после успеха пауза nightCraftPauseMs. Прежняя (v0.4 еда и ночь, этап 2): подъём — HP<8 без climb_up, «потолок» → dig_at (surface_dig), 2 одинаковых провала surface_* — пауза 10 мин; закат + запас<6 — охота (≤64 м от базы) и жарка +14; ферма без воды — farm_plot_v1 dry=1, семена: днём у базы short_grass; HP≤6 без еды — ночью поводок 16 м, укрытие; меч в руку (equip_best); побег fled:false → 5 мин сразу укрытие; резерв 8 dirt (reserve_dirt); смерть далеко (>96 м): ночью укрытие, днём домой по точкам дна каньона. Прежняя (v0.4 стоп-кран, этап 1): козы — не дичь (GAME без goat: охота и память мест с животными их не видят); «Автопилот:»-цель упала «не хватает [блоков]: a ×n» → ap.goalNeed, decide даёт gather_list с ключом goal_gather (ночью с угрозой и камень без кирки — не начинаем; buildGatherMax доборов подряд без успеха или пустой добор — обычный провал цели: пауза, шаг вдвое меньше, счёт очереди), потом цель снова; версии навыков из GET /skills (pickVersions: включённые и не broken, лучшая по (ok+1)/(runs+2), при счёте < 0.5 новая версия с runs < 3 — на пробу) звать вместо базового имени, key/паузы/сбой кода — по базе (в why «gather_list → gather_list_v12»). Прежняя (v0.3 ночь у базы, шаг 6): кровать — шерсти одного цвета ≥ 3 и досок хватает (3, +4 на верстак) → craft `<цвет>_bed`; шерсти нет, овцы рядом, день — make_bed (ножницы/охота на овец); кровать в сумке и муха у базы → bring_bed_home ставит её у базы (позиция в памяти, блок исчез — забываем), ночью у базы без угроз sleep (сам ставит кровать из сумки) со счётом выше wait_night и укрытия, моб подошёл во сне — защита как у wait_night; на закате (до ночи < 150 с) у базы light_base из факелов в сумке или угля сверх запаса 2 (не чаще раза в 15 мин). Прежняя (v0.3 еда, этап 2): рыбалка — нет еды и вода рядом (worldmem, 40 м): удочка (3 палки + 2 нити; нить только с пауков — нет, ветку пропускаем) → fish до запаса или 240 с, сырую рыбу жарит smelt как мясо; вода подо льдом — dig_at ломает лёд над водой, потом fish; заход без улова — пауза 10 мин; деревня из памяти (worldmem village ≤ 200 м) шагом foodQuest перед базой/полем: идём, собираем созревшую пшеницу/морковь/картофель (harvest с пересадкой, жителей не трогаем), культуру пробуем раз в 30 мин; ферма — база ≤ 48 м, вода у базы, семена ≥ 2 и мотыга (или доски на неё): выученный farm_plot с центром на воде, потом раз в 30 мин собрать и пересадить. Прежняя (v0.3 очередь, шаг 3): работа без мозга — раздел «## План» в brain/notes.md (behavior/plan.js): пункты `- [ ] чертёж x y z rot=…` и `- [ ] Автопилот: навык ключ=значение`, `[x]` готово, `[-]` пропуск, после « | » комментарий; порядок: «Постройка:» из «Текущей цели» (не готова и не провалена) → первый открытый пункт очереди → «Автопилот:» цели; пункт готов (build_done / ok навыка) — память data/autopilot_plan.json + событие plan_item_done + перечитать notes.md; planFailPauses пауз стройки (или провалов навыка) подряд без нового блока — пункт провален, идём к следующему, повтор через 6 ч (или через 30 мин, когда открытых нет); нет чертежа / неизвестный навык / битая строка — пропуск с причиной в журнале; раздел пропал из notes.md — работаем по последней копии; мозг включён (пульт) — после build_done 10 мин ждём его «Постройку:», выключен — берём сразу; статус очереди — в snapshot autopilot.plan. Прежняя (v0.3 инструменты, шаг 2): набор кирка/меч/лопата/топор — каменные при булыжнике ≥ цены (+палки), иначе деревянные, деревянные кирку и меч меняю на каменные; крафт (craft тела: верстак и палки сам) раньше рутины, после еды при низком HP и угроз; перед collect/gather_list (камень/руда — кирка, земля/песок/гравий — лопата, брёвна — топор) сначала крафт, а кирки нет и не из чего — дело не берём, день сначала даёт дерево; ночью без угроз крафт вместо ожидания; выключенный (или не найденный) у исполнителя выученный навык decide не предлагает вовсе (список раз в 30 с, как go_safe) — без «night_mine: навык выключен» ×60. Прежняя (v0.3 еда, этап 1): рефлекс доедает до 18 при HP < 20 (регенерация); низкий HP без еды — не «жду 120 с», а сразу за едой: охота рядом → наверх из пещеры (climb_up/climb_stairs) → место, где видела животных → база → поле (explore шире с каждым провалом), ночью только ближнее, враг-игрок рядом — ждём; зомби по силам — бой ради гнилой плоти; днём запас еды < 6 — охота впрок (к закату важнее), сырое + топливо — smelt тела, пшеница — хлеб; нужно дерево под землёй — сначала наверх; pathfinder обходит сталагмиты/сталактиты. Прежняя (заявки 23.10, «простой страшнее смерти»): у любого «жду» потолок apWaitMaxSec (waitSec из тика), HP 20 без моба рядом — не «мало HP»; низкий HP без угрозы и с регеном — работа, без регена и с едой — ем сам; ночь без мобов — работа/добор, укрытие и wait_night — запас; своё дело прерывается мобом (safety_*, preempt); добор: прерван — продолжаю, пусто — к постройке, нехватка по памяти после рестарта. До неё: как 20261022-225845-1e05a2, но цель добора — ИТОГ (need из ответа build_blueprint), а не дельта (missing); «добор сделан» только по факту прибавки в сумке; после пустого добора — пауза с причиной и смена тактики, не повтор того же вызова; добор ночью не начинать; шаг build_gather в коде; по заявке учителя
module.exports = { nextWaypoint, ROUTE_HOME, rodFeasible, hoeFeasible, farmWaterPick, fishSpot, toolTiers, toolFeasible, toolNext, toolFor, toolsForAct, skillGate, attach, decide, lowHpOf, gather, create, noteAnimalSpot, forgetAnimalSpot, animalSpotOf, foodInv, undergroundOf, goalState, goalAfter, buildState, buildAfter, buildStatus, lackOf, newBuildSt, gameNear, GAME, goalGatherAfter, pickVersions, stepParams, escapePause, yieldPlan, isBrainYield, verdictOf, brainHoldsBody, failPause, isCodeCrash, crashList, IDLE_MS, READONLY, SHORT_BRAIN };
