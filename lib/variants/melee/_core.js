// Общая схватка ближнего боя для вариантов melee: один цикл с гарантиями lib/melee.js, варианты меняют только «как»
// (удар, что делать на перезарядке, как подходить). Гарантии здесь: бить только с предела (≤HIT_REACH), не чаще
// полного заряда оружия, отход назад только если безопасно (backIsSafe; в defend — не дальше leash от поста),
// крипер — отскок после удара, стрелки — сближаться (дистанцию не держим), мало HP — отступить, агрессор-игрок
// пропал/перестал нападать — бросить; abort/finally — цель пути и управление сброшены.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { entName, r1 } = require('../../util');
const M = require('../../melee');
const F = require('../../felt');
const AG = require('../../aggressors');

function alive(bot, e) { return !!e && bot.entities[e.id] === e && e.isValid !== false; }

// Отбежать от сущности на ~dist блоков (со спринтом) за ms
async function retreat(ctx, t, from, dist, ms) {
  const bot = ctx.bot;
  if (ctx.sprintMovements) bot.pathfinder.setMovements(ctx.sprintMovements);
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(from, dist)), true);
  try { await t.sleep(ms); } finally { bot.pathfinder.setGoal(null); if (ctx.movements) bot.pathfinder.setMovements(ctx.movements); }
}

// Можно ли шагнуть в сторону вектора (sx,sz) от нас: та же проверка, что backIsSafe (пол, лава/вода, обрыв)
function stepIsSafe(bot, sx, sz) {
  const me = bot.entity.position, V = me.constructor;
  return M.backIsSafe(bot, { position: new V(me.x - sx, me.y, me.z - sz) });
}
// Пост (defend): не уходить дальше leash
function inLeash(env, sx = 0, sz = 0) {
  const p = env.p; if (!p.post) return true;
  const me = env.bot.entity.position;
  return Math.hypot(me.x + sx - p.post.x, me.z + sz - p.post.z) < (p.leash || 4);
}
function awayDir(env) {
  const me = env.bot.entity.position, tp = F.posOf(env.target);
  const dx = me.x - tp.x, dz = me.z - tp.z, l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
function canBack(env) { const a = awayDir(env); return M.backIsSafe(env.bot, env.target) && inLeash(env, a.x * 1.5, a.z * 1.5); }

// Удар сейчас, если цель в досягаемости. Крипер — после удара отскок. -> ударил ли
async function hitNow(env) {
  const { bot, target, st, ctx, t } = env;
  const still = M.reachDist(bot, target) <= M.HIT_REACH + 0.2;
  M.stopMove(bot);
  if (still && alive(bot, target)) { bot.attack(target); st.hits++; st.lastHit = Date.now(); }
  if (still && env.creeper) await retreat(ctx, t, target, 6, 900);
  return still;
}
// Удар с коротким спринт-разбегом (если уместно)
async function lungeHit(env) {
  const { bot, p } = env;
  if (M.shouldLunge({ food: bot.food, dist: env.hbd(), creeper: env.creeper, enabled: p.sprint !== false })) {
    M.setMove(bot, 'lunge');
    await env.t.sleep(M.LUNGE_MS);
    await bot.lookAt(env.aim(), true);
  }
  return hitNow(env);
}
// Перезарядка по умолчанию: близко — назад (если безопасно), иначе стоим
async function backOrHold(env, mode) {
  M.setMove(env.bot, mode === 'back' && canBack(env) ? 'back' : null);
}
// Подход по умолчанию: GoalFollow один раз на цель; нет прогресса 15 с -> 'unreachable'
async function follow(env, d) {
  const { bot, target, st } = env;
  M.stopMove(bot);
  if (st.followFor !== target) { bot.pathfinder.setGoal(new goals.GoalFollow(target, env.creeper ? 2.5 : env.ranged ? 1.8 : 2.2), true); st.followFor = target; }
  if (d < st.bestD - 0.5) { st.bestD = d; st.progressT = Date.now(); }
  if (Date.now() - st.progressT > 15000) { bot.pathfinder.setGoal(null); st.followFor = null; return 'unreachable'; }
  await env.t.sleep(100);
  return null;
}

// Схватка с одной целью. p: target, deadline, fleeHp, fleeDist, radius, pvp, sprint, lastHit, post, leash, reach, variant.
// hooks: setup(env)->false=не вышло, strike(env), cooldown(env, 'back'|'hold'), approach(env, d)->null|'unreachable'|'gaveup',
// cleanup(env), keep (держать дистанцию на перезарядке, по умолчанию да), tick (мс).
// -> { outcome: killed|fled|lost|left|unreachable|gaveup|timeout, hits, dmg, ms, lastHit }
async function engage(ctx, t, p, sit, hooks = {}) {
  const bot = ctx.bot, target = p.target;
  const t0 = Date.now(), hp0 = bot.health;
  const tn = entName(target);
  const st = { hits: 0, lastHit: p.lastHit || 0, followFor: null, bestD: Infinity, progressT: Date.now(), data: {} };
  const env = {
    ctx, t, p, sit, bot, target, st, tn,
    ranged: F.RANGED.has(tn), creeper: tn === 'creeper',
    aim: () => F.posOf(target).offset(0, (target.height || 1.8) * 0.7, 0),
    hbd: () => M.reachDist(bot, target),
    ready: () => Date.now() - st.lastHit >= M.cooldownMs(bot.heldItem && bot.heldItem.name)
  };
  let outcome = 'timeout';
  try {
    if (hooks.setup && (await hooks.setup(env)) === false) outcome = 'gaveup';
    else while (Date.now() < p.deadline) {
      t.check();
      ctx.combatUntil = Date.now() + 3000;
      if (!alive(bot, target)) { outcome = 'killed'; break; }
      if (p.pvp && (!AG.isAggressorEntity(ctx, target) || bot.entity.position.distanceTo(target.position) > AG.CHASE_MAX)) { outcome = 'lost'; break; }
      t.progress(`бой с ${tn} [${p.variant || '?'}], HP ${Math.round(bot.health)}, ударов ${st.hits}`);
      if (bot.health <= p.fleeHp) {
        M.stopMove(bot); bot.pathfinder.setGoal(null); st.followFor = null;
        await retreat(ctx, t, target, p.fleeDist || 16, 5000);
        outcome = 'fled'; break;
      }
      const d = F.distTo(bot, target);
      if (p.post ? d > (p.reach || 5) + 1 : d > (p.radius || 16) + 8) { outcome = p.post ? 'left' : 'lost'; break; }
      const hbd = env.hbd();
      const mode = M.decide({ dist: hbd, ready: env.ready(), close: env.ranged, keep: !env.ranged && hooks.keep !== false });
      if (mode === 'approach') {
        if (p.post) { M.setMove(bot, null); await t.sleep(100); continue; } // охрана: не гонимся
        const r = await (hooks.approach || follow)(env, d);
        if (r === 'unreachable' || r === 'gaveup') { outcome = r; break; }
        continue;
      }
      if (st.followFor) { bot.pathfinder.setGoal(null); st.followFor = null; }
      st.bestD = d; st.progressT = Date.now();
      await bot.lookAt(env.aim(), true);
      if (mode === 'hit') await (hooks.strike || lungeHit)(env);
      else await (hooks.cooldown || backOrHold)(env, mode);
      await t.sleep(hooks.tick || 50);
    }
  } finally {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    M.stopMove(bot);
    if (hooks.cleanup) { try { await hooks.cleanup(env); } catch (e) {} }
  }
  return { outcome, hits: st.hits, dmg: r1(Math.max(0, hp0 - bot.health)), ms: Date.now() - t0, lastHit: st.lastHit };
}

module.exports = { engage, retreat, alive, hitNow, lungeHit, backOrHold, follow, canBack, stepIsSafe, inLeash, awayDir };
