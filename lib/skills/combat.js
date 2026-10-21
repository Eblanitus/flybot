// Боевые навыки: fight, defend, equip_best. Големов и нейтралов не атакуем никогда.
// Игроков — только агрессоров (ударивших нас <=120 с назад, см. aggressors.js); мирных игроков не трогаем.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { num, SkillError, entName, isAutoTarget, isHostile, r1 } = require('../util');
const A = require('../actions');
const AG = require('../aggressors');
const threats = require('../threats');
// от кого убегать: мобы, игроки-агрессоры и игроки-убийцы (data/killers.json)
const fleeFrom = (ctx, e) => isHostile(e) || AG.isAggressorEntity(ctx, e) || (e.type === 'player' && e !== ctx.bot.entity && !!e.username && !!threats.isThreat(ctx, e.username));

function nearestTarget(bot, radius, filter = isAutoTarget) {
  let best = null, bd = radius;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !filter(e)) continue;
    const d = bot.entity.position.distanceTo(e.position);
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
  if (!target) throw new SkillError(name ? `нет ${name} в радиусе ${radius}` : `нет врагов в радиусе ${radius}`);
  let lost = null; // агрессор-игрок пропал/убежал/перестал быть агрессором
  await A.equipBestWeapon(bot);
  let lastHit = 0;
  let followFor = null, bestD = Infinity, progressT = Date.now();
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
      await retreat(ctx, t, target, 16, 5000);
      throw new SkillError(`отступил: мало HP (${Math.round(bot.health)})`, { kills, hits });
    }
    const d = bot.entity.position.distanceTo(target.position);
    if (d > radius + 8) { target = nearestTarget(bot, radius, filter); if (!target) break; continue; }
    const cd = Date.now() - lastHit;
    if (d <= 3.0) {
      if (followFor) { bot.pathfinder.setGoal(null); followFor = null; }
      bestD = d; progressT = Date.now();
      await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true);
      if (cd >= 650) { bot.attack(target); hits++; lastHit = Date.now(); }
      if (tn === 'creeper' && cd >= 650) {
        // ударил — отскочить, чтобы не попасть под взрыв
        await retreat(ctx, t, target, 6, 900);
      }
    } else {
      // цель ставим один раз (повторный setGoal сбрасывает поиск пути)
      if (followFor !== target) { bot.pathfinder.setGoal(new goals.GoalFollow(target, tn === 'creeper' ? 2.5 : 1.8), true); followFor = target; }
      if (d < bestD - 0.5) { bestD = d; progressT = Date.now(); }
      if (Date.now() - progressT > 15000) {
        bot.pathfinder.setGoal(null);
        throw new SkillError(`не могу подобраться к ${tn} (${r1(d)}м)`, { kills, hits });
      }
    }
    await t.sleep(100);
  }
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
  while (Date.now() < end) {
    t.check();
    const e = nearestTarget(bot, reach, x => isAutoTarget(x) || AG.isAggressorEntity(ctx, x)); // + игроки-агрессоры
    t.progress(`охрана, осталось ${Math.round((end - Date.now()) / 1000)}с, ударов ${hits}`);
    if (e) {
      ctx.combatUntil = Date.now() + 3000;
      if (bot.health <= 6) { await retreat(ctx, t, e, 14, 5000); throw new SkillError('отступил: мало HP', { hits }); }
      const d = bot.entity.position.distanceTo(e.position);
      await bot.lookAt(e.position.offset(0, e.height * 0.8, 0), true);
      if (d <= 3.0 && Date.now() - lastHit >= 650) { bot.attack(e); hits++; lastHit = Date.now(); }
    }
    await t.sleep(150);
  }
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
    if (d <= 3) {
      if (followFor) { bot.pathfinder.setGoal(null); followFor = null; }
      progressT = Date.now();
      await bot.lookAt(target.position.offset(0, target.height * 0.6, 0), true);
      if (Date.now() - lastHit >= 650) { bot.attack(target); lastHit = Date.now(); }
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

// Убежать от врагов (спринт), при необходимости — закрыться в укрытии
async function escape(ctx, t, params) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  let vx = 0, vz = 0, n = 0;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !fleeFrom(ctx, e)) continue;
    const d = e.position.distanceTo(me); if (d > (e.type === 'player' ? 32 : 20)) continue;
    const w = 1 / Math.max(d * d, 1); vx += (me.x - e.position.x) * w; vz += (me.z - e.position.z) * w; n++;
  }
  if (!n) return { fled: false, note: 'врагов рядом нет' };
  const len = Math.hypot(vx, vz) || 1;
  const dist = num(params.distance, 16, 6, 40);
  const tx = me.x + vx / len * dist, tz = me.z + vz / len * dist;
  t.progress('убегаю');
  try { await A.goto(ctx, t, new goals.GoalNearXZ(tx, tz, 2), { timeout: 10000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
  const near = nearestTarget(bot, 6, e => fleeFrom(ctx, e));
  let sheltered = false;
  if (near && params.shelter !== false) {
    try { await require('./survival').shelter(ctx, t, {}); sheltered = true; } catch (e) { if (e.aborted) throw e; }
  }
  return { fled: true, moved: r1(bot.entity.position.distanceTo(me)), sheltered, hp: Math.round(bot.health) };
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

module.exports = { fight, defend, escape, hunt, equipBest, nearestTarget, r1 };
