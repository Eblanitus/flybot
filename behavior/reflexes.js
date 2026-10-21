// Рефлексы (поведение): плавание, автоеда, автоброня, самозащита, укрытие после респауна ночью.
// Перенесены из lib/reflexes.js как есть — это «учебные колёса», учитель может их менять.
// События удара приходят от ядра (lib/body_events.js) через api.handle('player_attack' | 'mob_hurt').
'use strict';
const L = require('./core');
const { entName, isAutoTarget, isHostile } = L('util');
const { equipBestArmor } = L('actions');
const { timeInfo } = L('perception');
const AG = L('aggressors');
const F = L('felt');
const E = L('experience');
const T = require('./thresholds');

function hasWeapon(bot) { return bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name)); }
function hostilesNear(bot, r) {
  const p = bot.entity.position;
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && isHostile(e) && F.posOf(e).distanceTo(p) <= r).length;
}

// Что делать, когда ударил моб (att — определённый обидчик или null). null — ничего не запускать.
// Тактику не зашиваем: варианты упорядочены старым правилом (это лишь prior), выбирает опыт (experience.js) — что выживало в такой обстановке
function defensePrior(ctx, att) {
  const bot = ctx.bot;
  const canFight = !!att && F.distTo(bot, att) <= T.defenseFightDist && isAutoTarget(att);
  const opts = bot.health < T.defenseLowHp ? ['escape', 'shelter'] : (!hasWeapon(bot) && (hostilesNear(bot, T.crowdR) >= T.crowdN || timeInfo(bot).isNight)) ? ['shelter', 'escape'] : canFight ? ['fight', 'shelter', 'escape'] : ['escape', 'shelter'];
  if (canFight && !opts.includes('fight')) opts.push('fight');
  if (ctx.shelterFailT && Date.now() - ctx.shelterFailT < T.shelterFailMs) { opts.splice(opts.indexOf('shelter'), 1); } // укрытие только что не вышло здесь
  return opts;
}
function mobHurtPlan(ctx, att) {
  const bot = ctx.bot, cur = ctx.tasks.current;
  if (cur && ['fight', 'defend', 'escape', 'shelter'].includes(cur.name)) return null; // защита уже идёт — не дёргать её на каждом ударе
  const opts = defensePrior(ctx, att);
  if (cur && bot.health >= T.swatMinHp && att && opts[0] === 'fight') return { swat: att }; // занят делом, HP в норме — отмахнуться
  const ch = E.choose(ctx, opts);
  const params = ch.action === 'fight' ? { targetId: att.id, radius: T.fightRadius } : {};
  return { skill: ch.action, params, force: !!cur, why: ch.why, options: opts };
}

// Вредная/нежелательная еда
const FOOD_BLACKLIST = new Set(['poisonous_potato', 'pufferfish', 'spider_eye', 'chicken', 'suspicious_stew', 'chorus_fruit',
  'enchanted_golden_apple', 'golden_apple', 'rotten_flesh']);

function pickFood(bot, { desperate = false } = {}) {
  const foods = bot.registry.foodsByName;
  const cands = bot.inventory.items().filter(i => {
    const f = foods[i.name]; if (!f) return false;
    if (i.name.endsWith('_bucket')) return false;
    if (FOOD_BLACKLIST.has(i.name)) return desperate && (i.name === 'rotten_flesh' || i.name === 'chicken');
    return true;
  });
  cands.sort((a, b) => (foods[b.name].effectiveQuality || 0) - (foods[a.name].effectiveQuality || 0));
  return cands[0] || null;
}

// api — от ядра (lib/behavior_host.js): ctx, bot, every, after, on, handle
function attach(api) {
  const { ctx, bot } = api;
  const every = (ms, fn, name) => api.every(ms, fn, name);

  // ---- Плавание: держим "прыжок" только пока сами его включили ----
  let swimJump = false;
  let underSince = 0;
  every(250, () => {
    if (ctx.manualControl) return; // руки (move/jump/swim, swim_to, dive) управляют сами
    const p = bot.entity.position;
    const head = bot.blockAt(p.offset(0, 1.5, 0));
    const feet = bot.blockAt(p);
    const headWet = head && head.name === 'water';
    const inWater = headWet || (feet && feet.name === 'water');
    const pfActive = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving();
    // oxygenLevel в 26.1 ненадёжен — считаем, сколько голова под водой
    if (headWet) { if (!underSince) underSince = Date.now(); } else underSince = 0;
    const longUnder = underSince && Date.now() - underSince > T.swimLongUnderMs;
    const want = inWater && (!pfActive || longUnder);
    if (want) { if (!bot.getControlState('jump')) bot.setControlState('jump', true); swimJump = true; }
    else if (!want && swimJump) { bot.setControlState('jump', false); swimJump = false; }
  }, 'плавание');

  // ---- Автоеда ----
  let eating = false;
  let hungerWarned = false;
  every(2000, async () => {
    if (eating || bot.currentWindow) return;
    const needs = bot.food <= T.eatFood || (bot.food < 20 && bot.health <= T.eatHurtHp);
    if (!needs) { if (bot.food > T.hungerWarnResetFood) hungerWarned = false; return; }
    if (Date.now() < ctx.combatUntil) return; // не есть в бою
    if (bot.targetDigBlock || (bot.pathfinder.isMining && bot.pathfinder.isMining())) return; // не есть во время копания
    const food = pickFood(bot, { desperate: bot.food <= T.desperateFood });
    if (!food) {
      if (bot.food <= T.desperateFood && !hungerWarned) { hungerWarned = true; ctx.events.push('danger', { kind: 'hunger', food: bot.food, msg: 'голод и нечего есть' }); }
      return;
    }
    eating = true;
    const prev = bot.heldItem ? bot.heldItem.name : null;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      ctx.events.push('info', { msg: 'съел ' + food.name, food: bot.food });
    } catch (e) {
      console.log('[reflex] eat fail', e.message);
    } finally {
      try {
        if (prev && (!bot.heldItem || bot.heldItem.name !== prev)) {
          const it = bot.inventory.items().find(i => i.name === prev);
          if (it) await bot.equip(it, 'hand');
        }
      } catch (e) {}
      eating = false;
    }
  }, 'автоеда');

  // ---- Автоброня ----
  every(4000, async () => {
    if (bot.currentWindow) return;
    let put = [];
    try { put = await equipBestArmor(bot); } catch (e) { return; } // как раньше: неудачная примерка — не сбой поведения
    if (put.length) ctx.events.push('info', { msg: 'надел броню: ' + put.join(',') });
  }, 'автоброня');

  // ---- Самооборона от игрока: драться (есть оружие, HP>=12, обидчик один) или убегать ----
  api.handle('player_attack', ({ player, name }) => {
    const cur = ctx.tasks.current;
    const low = String(name).toLowerCase();
    if (cur && (cur.name === 'escape' || cur.name === 'defend')) return;
    if (cur && cur.name === 'fight' && String(cur.params && cur.params.target || '').toLowerCase() === low) return;
    const p = bot.entity.position;
    // посторонние враги рядом: мобы или другие игроки-агрессоры в 6 м
    const others = hostilesNear(bot, T.playerOthersR) + Object.values(bot.entities).filter(e =>
      e && e !== bot.entity && e !== player && AG.isAggressorEntity(ctx, e) && e.position.distanceTo(p) <= T.playerOthersR).length;
    const canFight = hasWeapon(bot) && bot.health >= T.playerFightHp && others === 0;
    if (canFight) ctx.runSkill('fight', { target: low, radius: AG.CHASE_MAX, flee_hp: T.playerFleeHp, timeout: T.playerFightTimeout }, { source: 'reflex', force: true });
    else ctx.runSkill('escape', {}, { source: 'reflex', force: true });
  });

  // ---- Самооборона от моба ----
  api.handle('mob_hurt', ({ att, source }) => {
    if (att && !isAutoTarget(att) && att === source) return; // эндермен, голем и т.п. — не трогаем
    const plan = mobHurtPlan(ctx, att);
    if (!plan) return;
    if (plan.swat) {
      const s = plan.swat;
      if (F.distTo(bot, s) < T.swatReach) bot.lookAt(F.posOf(s).offset(0, (s.height || 1.8) * 0.8, 0), true).then(() => bot.attack(s)).catch(() => {});
      return;
    }
    ctx.events.push('info', { msg: `рефлекс: ${plan.skill} (${plan.why}; варианты ${plan.options.join('/')})` });
    ctx.runSkill(plan.skill, plan.params, { source: 'reflex', ...(plan.force ? { force: true } : {}) });
  });

  // ---- Респаун ночью среди мобов: голыми руками не воевать, сразу укрыться (иначе — смерть по кругу на спавне) ----
  api.on(bot, 'spawn', () => {
    api.after(T.respawnDelayMs, () => {
      if (!ctx.ready || bot.health <= 0) return;
      if (!timeInfo(bot).isNight || hasWeapon(bot) || hostilesNear(bot, T.respawnHostilesR) === 0) return;
      const cur = ctx.tasks.current;
      if (cur && ['shelter', 'escape'].includes(cur.name)) return;
      const ch = E.choose(ctx, ['shelter', 'escape']);
      ctx.runSkill(ch.action, {}, { source: 'reflex', force: true });
    }, 'респаун ночью');
  });

  // при выгрузке версии — отпустить «прыжок», если держали его сами
  return { detach() { if (swimJump) { try { bot.setControlState('jump', false); } catch (e) {} swimJump = false; } } };
}

module.exports = { attach, mobHurtPlan, defensePrior, pickFood, FOOD_BLACKLIST, hasWeapon, hostilesNear };
