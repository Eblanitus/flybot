// Рефлексы: плавание, автоеда, автоброня, самозащита, сигналы опасности, смерть, чат.
// Подключаются ОДИН раз на экземпляр бота; все таймеры живут в session и чистятся при отключении.
'use strict';
const { sleep, entName, isAutoTarget, isHostile, r1, dirName } = require('./util');
const { equipBestArmor } = require('./actions');
const { timeInfo } = require('./perception');
const AG = require('./aggressors');
const threats = require('./threats');
const autopilot = require('./autopilot');
const F = require('./felt');
const E = require('./experience');

function hasWeapon(bot) { return bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name)); }
function hostilesNear(bot, r) {
  const p = bot.entity.position;
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && isHostile(e) && F.posOf(e).distanceTo(p) <= r).length;
}

// Что делать, когда ударил моб (att — определённый обидчик или null). null — ничего не запускать.
// Тактику не зашиваем: варианты упорядочены старым правилом (это лишь prior), выбирает опыт (experience.js) — что выживало в такой обстановке
function defensePrior(ctx, att) {
  const bot = ctx.bot;
  const canFight = !!att && F.distTo(bot, att) <= 12 && isAutoTarget(att);
  const opts = bot.health < 8 ? ['escape', 'shelter'] : (!hasWeapon(bot) && (hostilesNear(bot, 10) >= 2 || timeInfo(bot).isNight)) ? ['shelter', 'escape'] : canFight ? ['fight', 'shelter', 'escape'] : ['escape', 'shelter'];
  if (canFight && !opts.includes('fight')) opts.push('fight');
  if (ctx.shelterFailT && Date.now() - ctx.shelterFailT < 15000) { opts.splice(opts.indexOf('shelter'), 1); } // укрытие только что не вышло здесь
  return opts;
}
function mobHurtPlan(ctx, att) {
  const bot = ctx.bot, cur = ctx.tasks.current;
  if (cur && ['fight', 'defend', 'escape', 'shelter'].includes(cur.name)) return null; // защита уже идёт — не дёргать её на каждом ударе
  const opts = defensePrior(ctx, att);
  if (cur && bot.health >= 8 && att && opts[0] === 'fight') return { swat: att }; // занят делом, HP в норме — отмахнуться
  const ch = E.choose(ctx, opts);
  const params = ch.action === 'fight' ? { targetId: att.id, radius: 12 } : {};
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

// Причина смерти по тексту сообщения сервера (англ. локаль сервера)
function causeFromMessage(msg, name) {
  if (!msg) return null;
  const m = msg.slice(name.length).toLowerCase();
  const by = m.match(/(?:slain|shot|killed|blown up|fireballed|stung|impaled|squashed|pummeled|frozen to death) by ([^\s,]+(?: [^\s,]+)?)/);
  if (by) return by[1].replace(/ using.*$/, '');
  if (/drown/.test(m)) return 'утонул';
  if (/lava/.test(m)) return 'лава';
  if (/burn|flames|fire/.test(m)) return 'огонь';
  if (/fell|hit the ground|fall/.test(m)) return 'падение';
  if (/starved/.test(m)) return 'голод';
  if (/suffocated|in a wall/.test(m)) return 'задохнулся в блоке';
  if (/blew up|blown up/.test(m)) return 'взрыв';
  if (/was killed$|was killed/.test(m)) return 'убит командой /kill или магией';
  if (/out of the world/.test(m)) return 'пустота';
  return m.trim();
}

function attach(ctx, session) {
  const bot = ctx.bot;
  const every = (ms, fn) => session.timers.push(setInterval(() => { if (ctx.bot === bot && ctx.ready && bot.entity) { try { Promise.resolve(fn()).catch(() => {}); } catch (e) {} } }, ms));
  E.attach(ctx, session);         // опыт: что помогало выжить в какой обстановке
  threats.attach(ctx, session);   // враги-игроки: danger kind:"enemy_player"
  autopilot.attach(ctx, session); // тело работает само, когда мозг молчит

  // ---- Плавание: держим "прыжок" только пока сами его включили ----
  let swimJump = false;
  let underSince = 0;
  every(250, () => {
    if (ctx.manualControl) return; // старые move/jump/swim управляют сами
    const p = bot.entity.position;
    const head = bot.blockAt(p.offset(0, 1.5, 0));
    const feet = bot.blockAt(p);
    const headWet = head && head.name === 'water';
    const inWater = headWet || (feet && feet.name === 'water');
    const pfActive = bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving();
    // oxygenLevel в 26.1 ненадёжен — считаем, сколько голова под водой
    if (headWet) { if (!underSince) underSince = Date.now(); } else underSince = 0;
    const longUnder = underSince && Date.now() - underSince > 7000;
    const want = inWater && (!pfActive || longUnder);
    if (want) { if (!bot.getControlState('jump')) bot.setControlState('jump', true); swimJump = true; }
    else if (!want && swimJump) { bot.setControlState('jump', false); swimJump = false; }
  });

  // ---- Автоеда ----
  let eating = false;
  let hungerWarned = false;
  every(2000, async () => {
    if (eating || bot.currentWindow) return;
    const needs = bot.food <= 14 || (bot.food < 20 && bot.health <= 12);
    if (!needs) { if (bot.food > 10) hungerWarned = false; return; }
    if (Date.now() < ctx.combatUntil) return; // не есть в бою
    if (bot.targetDigBlock || (bot.pathfinder.isMining && bot.pathfinder.isMining())) return; // не есть во время копания
    const food = pickFood(bot, { desperate: bot.food <= 6 });
    if (!food) {
      if (bot.food <= 6 && !hungerWarned) { hungerWarned = true; ctx.events.push('danger', { kind: 'hunger', food: bot.food, msg: 'голод и нечего есть' }); }
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
  });

  // ---- Автоброня ----
  every(4000, async () => {
    if (bot.currentWindow) return;
    const put = await equipBestArmor(bot);
    if (put.length) ctx.events.push('info', { msg: 'надел броню: ' + put.join(',') });
  });

  // ---- Урон и самозащита ----
  let lastHealth = null;
  let lowHpWarned = false;
  bot.on('health', () => {
    if (lastHealth != null && bot.health < lastHealth) {
      ctx.stats.damageTaken += (lastHealth - bot.health);
      ctx.statsDirty = true;
    }
    lastHealth = bot.health;
    if (bot.health > 0 && bot.health < 8 && !lowHpWarned) {
      lowHpWarned = true;
      ctx.events.push('danger', { kind: 'low_hp', hp: Math.round(bot.health), food: bot.food, lastDamage: ctx.lastDamage ? (ctx.lastDamage.cause || 'без источника') : null });
    }
    if (bot.health >= 12) lowHpWarned = false;
  });

  // Взмахи рук игроков — запасной способ найти обидчика, если сервер не указал источник урона
  const swings = new Map();
  bot.on('entitySwingArm', e => {
    if (e && e.type === 'player') { swings.set(e.id, Date.now()); if (swings.size > 100) swings.clear(); }
  });

  // Самооборона от игрока: драться (есть оружие, HP>=12, обидчик один) или убегать
  function onPlayerAttack(player) {
    const name = player.username || entName(player);
    const rec = AG.record(ctx, name);
    ctx.combatUntil = Date.now() + 5000;
    const d = r1(bot.entity.position.distanceTo(player.position));
    if (Date.now() - lastAttackEvent > 5000) {
      lastAttackEvent = Date.now();
      ctx.events.push('danger', { kind: 'attacked', by: name, player: true, hp: Math.round(bot.health), d, hits: rec ? rec.hits : 1 });
    }
    const cur = ctx.tasks.current;
    const low = String(name).toLowerCase();
    if (cur && (cur.name === 'escape' || cur.name === 'defend')) return;
    if (cur && cur.name === 'fight' && String(cur.params && cur.params.target || '').toLowerCase() === low) return;
    const p = bot.entity.position;
    // посторонние враги рядом: мобы или другие игроки-агрессоры в 6 м
    const others = hostilesNear(bot, 6) + Object.values(bot.entities).filter(e =>
      e && e !== bot.entity && e !== player && AG.isAggressorEntity(ctx, e) && e.position.distanceTo(p) <= 6).length;
    const canFight = hasWeapon(bot) && bot.health >= 12 && others === 0;
    if (canFight) ctx.runSkill('fight', { target: low, radius: AG.CHASE_MAX, flee_hp: 8, timeout: 45 }, { source: 'reflex', force: true });
    else ctx.runSkill('escape', {}, { source: 'reflex', force: true });
  }

  let lastAttackEvent = 0;
  function onMobHurt(source, cause) {
    const att = F.resolveAttacker(bot, source).entity;
    F.feel(ctx, att);
    ctx.combatUntil = Date.now() + 5000;
    if (Date.now() - lastAttackEvent > 5000) {
      lastAttackEvent = Date.now();
      ctx.events.push('danger', { kind: 'attacked', by: att ? entName(att) : cause, hp: Math.round(bot.health), d: att ? r1(F.distTo(bot, att)) : null, ...(att && att !== source ? { note: 'источник не рядом — бил ближний ' + entName(att) } : {}) });
    }
    if (att && !isAutoTarget(att) && att === source) return; // эндермен, голем и т.п. — не трогаем
    const plan = mobHurtPlan(ctx, att);
    if (!plan) return;
    if (plan.swat) {
      const s = plan.swat;
      if (F.distTo(bot, s) < 3.2) bot.lookAt(F.posOf(s).offset(0, (s.height || 1.8) * 0.8, 0), true).then(() => bot.attack(s)).catch(() => {});
      return;
    }
    ctx.events.push('info', { msg: `рефлекс: ${plan.skill} (${plan.why}; варианты ${plan.options.join('/')})` });
    ctx.runSkill(plan.skill, plan.params, { source: 'reflex', ...(plan.force ? { force: true } : {}) });
  }
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return;
    // сервер не назвал источник — ищем обидчика-игрока по взмаху руки рядом
    if (!source || !source.position) { const g = AG.guessAttacker(bot, swings); if (g) source = g; }
    const cause = source ? entName(source) : null; // без источника: падение/огонь/вода/голод/команда — уточняем по сообщению о смерти
    ctx.lastDamage = { cause, t: Date.now(), sourceId: source ? source.id : null };
    if (source && source.type === 'player' && source !== bot.entity) { onPlayerAttack(source); return; }
    if (!source || !isHostile(source)) return; // урон не от моба — не атакуем
    onMobHurt(source, cause);
  });
  // ударила сущность, которой у тела нет (не заспавнилась у клиента, всадник и т.п.) — mineflayer даёт source=undefined
  bot._client.on('damage_event', p => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id || !(p.sourceCauseId > 0) || bot.entities[p.sourceCauseId - 1]) return;
      ctx.lastDamage = { cause: 'невидимый моб', t: Date.now(), sourceId: p.sourceCauseId - 1 };
      onMobHurt(null, 'невидимый моб');
    } catch (e) {}
  });

  // ---- Респаун ночью среди мобов: голыми руками не воевать, сразу укрыться (иначе — смерть по кругу на спавне) ----
  bot.on('spawn', () => {
    setTimeout(() => {
      try {
        if (!ctx.ready || bot.health <= 0) return;
        if (!timeInfo(bot).isNight || hasWeapon(bot) || hostilesNear(bot, 16) === 0) return;
        const cur = ctx.tasks.current;
        if (cur && ['shelter', 'escape'].includes(cur.name)) return;
        const ch = E.choose(ctx, ['shelter', 'escape']);
        ctx.runSkill(ch.action, {}, { source: 'reflex', force: true });
      } catch (e) {}
    }, 1500);
  });

  // ---- Сканер опасностей и ночи ----
  const seenEnemies = new Map();
  let nightWarnDay = null;
  every(1000, () => {
    const p = bot.entity.position;
    const now = Date.now();
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !isHostile(e)) continue;
      const d = p.distanceTo(e.position);
      const lim = entName(e) === 'creeper' ? 12 : 10;
      if (d > lim) continue;
      const last = seenEnemies.get(e.id);
      if (last && now - last < 30000) continue;
      seenEnemies.set(e.id, now);
      ctx.events.push('danger', { kind: 'enemy', name: entName(e), d: r1(d), dir: dirName(p, e.position), hp: Math.round(bot.health) });
    }
    if (seenEnemies.size > 200) seenEnemies.clear();
    const ti = timeInfo(bot);
    if (ti.tod >= 11000 && ti.tod < 12542 && nightWarnDay !== ti.day) {
      nightWarnDay = ti.day;
      ctx.events.push('danger', { kind: 'night_soon', nightIn: ti.nightIn });
    }
  });

  // ---- Пройденный путь (без телепортов/респавна) ----
  every(1000, () => {
    const p = bot.entity.position;
    if (ctx.lastPos) {
      const d = p.distanceTo(ctx.lastPos);
      if (d <= 10) { ctx.stats.distanceTraveled += d; if (d > 0.01) ctx.statsDirty = true; }
    }
    ctx.lastPos = p.clone();
    ctx.markVisited(p);
    if (ctx.sheltered && p.floored().distanceTo(ctx.sheltered.pos) > 1.5) ctx.sheltered = null; // вышел из укрытия
  });

  // ---- Смерть ----
  let deathMsg = null;
  bot.on('messagestr', (msg, position) => {
    if (position === 'system' || position === 'game_info' || position == null) {
      if (msg && msg.startsWith(bot.username + ' ')) deathMsg = { msg, t: Date.now() };
    }
  });
  bot.on('death', () => {
    const pos = bot.entity ? bot.entity.position.floored() : null;
    const ld = ctx.lastDamage && Date.now() - ctx.lastDamage.t < 8000 ? ctx.lastDamage.cause : null;
    const ti = bot.time ? timeInfo(bot) : null;
    let exp = null; try { exp = E.onDeath(ctx); } catch (e) {}
    ctx.stats.deaths++; ctx.statsDirty = true;
    ctx.lastPos = null;
    if (ctx.tasks.current) ctx.tasks.current.abort('смерть');
    setTimeout(() => {
      const message = deathMsg && Date.now() - deathMsg.t < 3000 ? deathMsg.msg : null;
      const guess = causeFromMessage(message, bot.username) || ld || 'неизвестно';
      ctx.events.push('death', { cause: guess, message, at: pos ? [pos.x, pos.y, pos.z] : null, phase: ti ? ti.phase : null, deaths: ctx.stats.deaths, ...(exp || {}) });
      try { threats.onDeath(ctx, { message, at: pos ? [pos.x, pos.y, pos.z] : null }); } catch (e) {}
      ctx.logDeath(`[${new Date().toISOString()}] Death #${ctx.stats.deaths} at (${pos ? pos.x + ', ' + pos.y + ', ' + pos.z : '?'}) cause: ${guess}${message ? ' | ' + message : ''} timeOfDay: ${ti ? ti.phase : 'unknown'}\n`);
    }, 600);
  });

  // ---- Чат от игроков ----
  bot.on('chat', (username, message) => {
    console.log(`[chat] <${username}> ${message}`);
    if (username === bot.username) return;
    const text = String(message).slice(0, 300);
    const e = ctx.chat.push('chat', text, username);
    ctx.events.push('chat', { from: username, text, id: e.id });
  });

  // ---- Системные строки и экшн-бар: пишем в журнал, чтобы мозг видел их в /snapshot ----
  // (чат игроков сюда уже попадает через 'chat' — здесь его пропускаем, чтобы не дублировать)
  bot.on('messagestr', (msg, position) => {
    const text = String(msg == null ? '' : msg).trim();
    if (!text || position === 'chat') return;
    if (position === 'system' || position === 'game_info') {
      const kind = position === 'game_info' ? 'action_bar' : 'system';
      const e = ctx.chat.push(kind, text);
      ctx.events.push('chat', { kind, from: null, text, id: e.id });
    }
  });
}

module.exports = { attach, mobHurtPlan, defensePrior, pickFood, FOOD_BLACKLIST, causeFromMessage };
