// Боевые навыки: fight, defend, equip_best. Големов и нейтралов не атакуем никогда.
// Игроков — только агрессоров (ударивших нас <=120 с назад, см. aggressors.js); мирных игроков не трогаем.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { num, SkillError, entName, isAutoTarget, isHostile, r1 } = require('../util');
const A = require('../actions');
const AG = require('../aggressors');
const threats = require('../threats');
const F = require('../felt');
const M = require('../melee');
const { timeInfo } = require('../perception');
// от кого убегать: мобы, игроки-агрессоры и игроки-убийцы (data/killers.json)
const fleeFrom = (ctx, e) => isHostile(e) || AG.isAggressorEntity(ctx, e) || (e.type === 'player' && e !== ctx.bot.entity && !!e.username && !!threats.isThreat(ctx, e.username));

function nearestTarget(bot, radius, filter = isAutoTarget) {
  let best = null, bd = radius;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !filter(e)) continue;
    const d = F.distTo(bot, e); // всадник: позиция по транспорту
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function alive(bot, e) { return e && bot.entities[e.id] === e && e.isValid !== false; }

// Отбежать от сущности на ~dist блоков (со спринтом)
async function retreat(ctx, t, from, dist, ms) {
  const bot = ctx.bot;
  const goal = new goals.GoalInvert(new goals.GoalFollow(from, dist));
  bot.pathfinder.setMovements(ctx.sprintMovements);
  bot.pathfinder.setGoal(goal, true);
  try { await t.sleep(ms); } finally { bot.pathfinder.setGoal(null); bot.pathfinder.setMovements(ctx.movements); }
}

async function fight(ctx, t, params) {
  const bot = ctx.bot;
  let radius = num(params.radius, 16, 3, 32);
  const fleeHp = num(params.flee_hp ?? params.fleeHp, 6, 0, 19);
  const name = params.target ? String(params.target).toLowerCase() : null;
  const isPlayerName = !!name && (bot.players[name] || Object.values(bot.players).some(p => p.username.toLowerCase() === name));
  if (isPlayerName) {
    // игрока бьём только если он напал на нас недавно
    if (name === String(bot.username).toLowerCase() || !AG.isAggressor(ctx, name)) throw new SkillError(`игрок ${params.target} не нападал — не бью`);
    radius = Math.min(radius, AG.CHASE_MAX);
  }
  const filter = e => {
    if (params.targetId != null) return e.id === params.targetId && isHostile(e);
    if (isPlayerName) return e.type === 'player' && entName(e) === name && AG.isAggressorEntity(ctx, e);
    if (name) return entName(e) === name && e.type !== 'player' && isHostile(e);
    return isAutoTarget(e);
  };
  const deadline = Date.now() + num(params.timeout, 60, 5, 300) * 1000;
  let kills = 0; let hits = 0;
  let target = nearestTarget(bot, radius, filter);
  // targetId не найден рядом (сервер назвал не того/позиция устарела) — бить того, кто реально ударил за 10 с, или ближнего в 6 м
  if (!target && params.targetId != null) target = F.knownAttackers(ctx).filter(e => isHostile(e) && F.distTo(bot, e) <= radius).sort((a, b) => F.distTo(bot, a) - F.distTo(bot, b))[0] || nearestTarget(bot, F.MELEE_REACH, isAutoTarget);
  if (!target) throw new SkillError(name ? `нет ${name} в радиусе ${radius}` : `нет врагов в радиусе ${radius}`);
  let lost = null; // агрессор-игрок пропал/убежал/перестал быть агрессором
  await A.equipBestWeapon(bot);
  let lastHit = 0;
  let followFor = null, bestD = Infinity, progressT = Date.now();
  try {
  while (Date.now() < deadline) {
    t.check();
    ctx.combatUntil = Date.now() + 3000;
    if (isPlayerName) {
      // игрок: гонимся не дальше CHASE_MAX, при потере из виду или по истечении 120 с — прекращаем
      const gone = !alive(bot, target) || !AG.isAggressorEntity(ctx, target);
      if (gone || bot.entity.position.distanceTo(target.position) > AG.CHASE_MAX) {
        lost = gone ? 'агрессор пропал из виду или больше не нападает' : `агрессор дальше ${AG.CHASE_MAX} м`;
        break;
      }
    }
    if (!alive(bot, target)) {
      kills++;
      target = params.targetId != null ? null : nearestTarget(bot, radius, filter);
      if (!target && params.targetId != null) target = nearestTarget(bot, 6, isAutoTarget); // добить соседей
      if (!target) break;
      followFor = null; bestD = Infinity; progressT = Date.now();
    }
    const tn = entName(target);
    t.progress(`бой с ${tn}, HP ${Math.round(bot.health)}, убито ${kills}`);
    if (bot.health <= fleeHp) {
      M.stopMove(bot);
      await retreat(ctx, t, target, 16, 5000);
      throw new SkillError(`отступил: мало HP (${Math.round(bot.health)})`, { kills, hits });
    }
    const d = F.distTo(bot, target);
    if (d > radius + 8) { target = nearestTarget(bot, radius, filter); if (!target) break; continue; }
    const ranged = F.RANGED.has(tn), creeper = tn === 'creeper';
    const hbd = M.reachDist(bot, target); // до хитбокса: бьём с предела досягаемости
    const ready = Date.now() - lastHit >= M.cooldownMs(bot.heldItem && bot.heldItem.name);
    const mode = M.decide({ dist: hbd, ready, close: ranged, keep: !ranged });
    if (mode === 'approach') {
      M.stopMove(bot);
      // цель ставим один раз (повторный setGoal сбрасывает поиск пути)
      if (followFor !== target) { bot.pathfinder.setGoal(new goals.GoalFollow(target, creeper ? 2.5 : ranged ? 1.8 : 2.2), true); followFor = target; }
      if (d < bestD - 0.5) { bestD = d; progressT = Date.now(); }
      if (Date.now() - progressT > 15000) {
        bot.pathfinder.setGoal(null);
        throw new SkillError(`не могу подобраться к ${tn} (${r1(d)}м)`, { kills, hits });
      }
      await t.sleep(100);
      continue;
    }
    if (followFor) { bot.pathfinder.setGoal(null); followFor = null; }
    bestD = d; progressT = Date.now();
    const aim = () => F.posOf(target).offset(0, target.height * 0.7, 0);
    await bot.lookAt(aim(), true);
    if (mode === 'back') M.setMove(bot, M.backIsSafe(bot, target) ? 'back' : null); // не теряя взгляда на цель
    else if (mode === 'hold') M.setMove(bot, null);
    else {
      // удар; перед ним короткий разбег со спринтом — в 26.1 спринт-удар отбрасывает сильнее
      if (M.shouldLunge({ food: bot.food, dist: hbd, creeper, enabled: params.sprint !== false })) {
        M.setMove(bot, 'lunge');
        await t.sleep(M.LUNGE_MS);
        await bot.lookAt(aim(), true);
      }
      const still = M.reachDist(bot, target) <= M.HIT_REACH + 0.2;
      M.stopMove(bot); // спринт сбрасываем сразу после удара
      if (still && alive(bot, target)) { bot.attack(target); hits++; lastHit = Date.now(); }
      if (still && creeper) await retreat(ctx, t, target, 6, 900); // ударил — отскочить, чтобы не попасть под взрыв
    }
    await t.sleep(50);
  }
  } finally { bot.pathfinder.setGoal(null); M.stopMove(bot); }
  bot.pathfinder.setGoal(null);
  const left = target && alive(bot, target) ? entName(target) : null;
  if (lost && !hits) throw new SkillError(lost, { kills, hits });
  if (!kills && !hits) throw new SkillError('не удалось вступить в бой' + (left ? ': ' + left + ' недосягаем' : ''), { kills, hits });
  return { kills, hits, hp: Math.round(bot.health), ...(lost ? { note: lost } : left ? { note: 'время вышло, ' + left + ' жив' } : {}) };
}

// Стоять на месте и бить всех враждебных, подошедших близко, duration секунд
async function defend(ctx, t, params) {
  const bot = ctx.bot;
  const duration = num(params.duration, 30, 3, 600) * 1000;
  const reach = num(params.radius, 5, 2, 10);
  const end = Date.now() + duration;
  let hits = 0;
  await A.equipBestWeapon(bot);
  let lastHit = 0;
  const post = bot.entity.position.clone(); // пост: отходим при перезарядке не дальше 4 блоков от него
  try {
    while (Date.now() < end) {
      t.check();
      const e = nearestTarget(bot, reach, x => isAutoTarget(x) || AG.isAggressorEntity(ctx, x)); // + игроки-агрессоры
      t.progress(`охрана, осталось ${Math.round((end - Date.now()) / 1000)}с, ударов ${hits}`);
      if (e) {
        ctx.combatUntil = Date.now() + 3000;
        if (bot.health <= 6) { M.stopMove(bot); await retreat(ctx, t, e, 14, 5000); throw new SkillError('отступил: мало HP', { hits }); }
        const hbd = M.reachDist(bot, e), ranged = F.RANGED.has(entName(e));
        const ready = Date.now() - lastHit >= M.cooldownMs(bot.heldItem && bot.heldItem.name);
        const mode = M.decide({ dist: hbd, ready, keep: !ranged });
        await bot.lookAt(F.posOf(e).offset(0, e.height * 0.7, 0), true);
        if (mode === 'back') M.setMove(bot, bot.entity.position.distanceTo(post) < 4 && M.backIsSafe(bot, e) ? 'back' : null);
        else if (mode === 'hit') { M.stopMove(bot); bot.attack(e); hits++; lastHit = Date.now(); }
        else M.setMove(bot, null);
      } else M.stopMove(bot);
      await t.sleep(e ? 50 : 150);
    }
  } finally { M.stopMove(bot); }
  return { hits, hp: Math.round(bot.health) };
}

// Охота на животных ради еды (только скот, не питомцы)
const GAME = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];
async function hunt(ctx, t, params) {
  const bot = ctx.bot;
  const want = params.animal ? String(params.animal).toLowerCase() : null;
  if (want && !GAME.includes(want)) throw new SkillError('охочусь только на: ' + GAME.join(', '));
  const count = num(params.count, 1, 1, 10);
  const filter = e => e.type === 'animal' && (want ? entName(e) === want : GAME.includes(entName(e))) && !(e.metadata && e.metadata[16] === true);
  let kills = 0, lastHit = 0, target = null, followFor = null, bestD = Infinity, progressT = Date.now();
  const deadline = Date.now() + 90000;
  await A.equipBestWeapon(bot);
  while (kills < count && Date.now() < deadline) {
    t.check();
    if (!target || !alive(bot, target)) {
      if (target) { kills++; await A.pickupDrops(ctx, t, target.position, 5, 3000); }
      if (kills >= count) break;
      target = nearestTarget(bot, num(params.radius, 32, 4, 64), filter);
      if (!target) break;
      followFor = null; bestD = Infinity; progressT = Date.now();
    }
    t.progress(`охота на ${entName(target)}: ${kills}/${count}`);
    const d = bot.entity.position.distanceTo(target.position);
    if (M.reachDist(bot, target) <= M.HIT_REACH) {
      if (followFor) { bot.pathfinder.setGoal(null); followFor = null; }
      progressT = Date.now();
      await bot.lookAt(target.position.offset(0, target.height * 0.6, 0), true);
      if (Date.now() - lastHit >= M.cooldownMs(bot.heldItem && bot.heldItem.name)) { bot.attack(target); lastHit = Date.now(); }
    } else {
      if (followFor !== target) { bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.5), true); followFor = target; }
      if (d < bestD - 0.5) { bestD = d; progressT = Date.now(); }
      if (Date.now() - progressT > 15000) { target = null; continue; }
    }
    await t.sleep(100);
  }
  bot.pathfinder.setGoal(null);
  if (!kills) throw new SkillError(want ? `не нашёл/не догнал ${want}` : 'животных рядом нет');
  return { kills, food: A.invMap ? Object.fromEntries([...A.invMap(bot)].filter(([n]) => bot.registry.foodsByName[n])) : {} };
}

// Куда бежать: от видимых врагов, от почувствованных обидчиков (даже невидимых/далёких) и от направления последнего удара
function fleeVector(ctx) {
  const bot = ctx.bot, me = bot.entity.position;
  let vx = 0, vz = 0, n = 0;
  const add = (p, w) => { vx += (me.x - p.x) * w; vz += (me.z - p.z) * w; n++; };
  const felt = new Set(F.knownAttackers(ctx).map(e => e.id));
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !(fleeFrom(ctx, e) || felt.has(e.id))) continue;
    const p = F.posOf(e), d = p.distanceTo(me);
    if (!felt.has(e.id) && d > (e.type === 'player' ? 32 : 20)) continue;
    add(p, (felt.has(e.id) ? 3 : 1) / Math.max(d * d, 1));
  }
  const hd = F.hitDir(ctx); // удар пришёл оттуда — бежать в обратную сторону
  if (hd) add({ x: me.x + hd.x * 2, z: me.z + hd.z * 2 }, 0.5);
  if (!n && F.recentHit(ctx)) { const a = Math.random() * Math.PI * 2; add({ x: me.x + Math.cos(a), z: me.z + Math.sin(a) }, 1); } // били, но непонятно откуда — хоть сдвинуться
  return n ? { x: vx, z: vz, n } : null;
}

// Убежать от врагов (спринт), затем закрыться в укрытии, если враги рядом, били недавно или ночь
async function escape(ctx, t, params) {
  const bot = ctx.bot;
  const me = bot.entity.position.clone();
  const v = fleeVector(ctx);
  if (!v) return { fled: false, note: 'врагов рядом нет' };
  const len = Math.hypot(v.x, v.z) || 1;
  const dist = num(params.distance, 16, 6, 40);
  const tx = me.x + v.x / len * dist, tz = me.z + v.z / len * dist;
  t.progress('убегаю');
  try { await A.goto(ctx, t, new goals.GoalNearXZ(tx, tz, 2), { timeout: 10000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
  const near = nearestTarget(bot, 10, e => fleeFrom(ctx, e));
  let sheltered = false, shelterErr = null;
  if (params.shelter !== false && (near || F.recentHit(ctx) || timeInfo(bot).isNight)) {
    try { await require('./survival').shelter(ctx, t, {}); sheltered = true; } catch (e) { if (e.aborted) throw e; shelterErr = e.message; }
  }
  return { fled: true, moved: r1(bot.entity.position.distanceTo(me)), sheltered, ...(shelterErr ? { shelterErr } : {}), hp: Math.round(bot.health) };
}

async function equipBest(ctx, t, params) {
  const bot = ctx.bot;
  const forWhat = String(params.for || params.mode || 'fight');
  const armor = await A.equipBestArmor(bot);
  let hand = null;
  if (forWhat === 'dig' || forWhat === 'mine') {
    const blockName = params.block ? String(params.block) : 'stone';
    const b = bot.registry.blocksByName[blockName];
    const picks = bot.inventory.items().filter(i => /_(pickaxe|axe|shovel)$/.test(i.name));
    if (b) {
      // взять самый быстрый инструмент для этого блока
      // нужен лишь тип блока для выбора инструмента — собираем блок-образец из реестра, мир не сканируем
      const Block = require('prismarine-block')(bot.registry);
      const sample = Block.fromStateId(b.defaultState, 0);
      if (sample) hand = await A.equipToolFor(bot, sample);
    }
    if (!hand || hand === 'рука') {
      const best = picks.filter(i => i.name.endsWith('_pickaxe')).sort((a, c) => A.matRank(c.name) - A.matRank(a.name))[0];
      if (best) { await bot.equip(best, 'hand'); hand = best.name; }
    }
  } else {
    hand = await A.equipBestWeapon(bot);
  }
  return { hand: bot.heldItem ? bot.heldItem.name : null, armorPut: armor, armor: [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(i => i.name) };
}

module.exports = { fight, defend, escape, fleeVector, hunt, equipBest, nearestTarget, r1 };
