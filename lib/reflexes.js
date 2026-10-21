// Рефлексы: плавание, автоеда, автоброня, самозащита, сигналы опасности, смерть, чат.
// Подключаются ОДИН раз на экземпляр бота; все таймеры живут в session и чистятся при отключении.
'use strict';
const { sleep, entName, isAutoTarget, isHostile, r1, dirName } = require('./util');
const { equipBestArmor } = require('./actions');
const { timeInfo } = require('./perception');
const AG = require('./aggressors');
const threats = require('./threats');
const autopilot = require('./autopilot');

function hasWeapon(bot) { return bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name)); }
function hostilesNear(bot, r) {
  const p = bot.entity.position;
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && isHostile(e) && e.position.distanceTo(p) <= r).length;
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
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return;
    // сервер не назвал источник — ищем обидчика-игрока по взмаху руки рядом
    if (!source || !source.position) { const g = AG.guessAttacker(bot, swings); if (g) source = g; }
    const cause = source ? entName(source) : null; // без источника: падение/огонь/вода/голод/команда — уточняем по сообщению о смерти
    ctx.lastDamage = { cause, t: Date.now(), sourceId: source ? source.id : null };
    if (source && source.type === 'player' && source !== bot.entity) { onPlayerAttack(source); return; }
    if (!source || !isHostile(source)) return; // урон не от моба — не атакуем
    ctx.combatUntil = Date.now() + 5000;
    if (Date.now() - lastAttackEvent > 5000) {
      lastAttackEvent = Date.now();
      ctx.events.push('danger', { kind: 'attacked', by: cause, hp: Math.round(bot.health), d: r1(bot.entity.position.distanceTo(source.position)) });
    }
    if (!isAutoTarget(source)) return; // эндермен, голем и т.п. — не трогаем
    const cur = ctx.tasks.current;
    if (cur && ['fight', 'defend', 'escape'].includes(cur.name)) return;
    // мало HP — убегать; без оружия против толпы (обычно сразу после респавна ночью) — закопаться; иначе — драться
    const crowd = hostilesNear(bot, 10);
    const outmatched = !hasWeapon(bot) && (crowd >= 2 || timeInfo(bot).isNight);
    const skill = bot.health < 8 ? 'escape' : outmatched ? 'shelter' : 'fight';
    if (skill === 'shelter') {
      if (!(cur && cur.name === 'shelter')) ctx.runSkill('shelter', {}, { source: 'reflex', force: true });
      return;
    }
    const params = skill === 'fight' ? { targetId: source.id, radius: 12 } : {};
    if (!cur) { ctx.runSkill(skill, params, { source: 'reflex' }); return; }
    if (bot.health < 8) { ctx.runSkill(skill, params, { source: 'reflex', force: true }); return; }
    // идёт другой навык и HP в норме — просто отмахнуться, если в досягаемости
    if (bot.entity.position.distanceTo(source.position) < 3.2) {
      bot.lookAt(source.position.offset(0, source.height * 0.8, 0), true).then(() => bot.attack(source)).catch(() => {});
    }
  });

  // ---- Респаун ночью среди мобов: голыми руками не воевать, сразу укрыться (иначе — смерть по кругу на спавне) ----
  bot.on('spawn', () => {
    setTimeout(() => {
      try {
        if (!ctx.ready || bot.health <= 0) return;
        if (!timeInfo(bot).isNight || hasWeapon(bot) || hostilesNear(bot, 16) === 0) return;
        const cur = ctx.tasks.current;
        if (cur && ['shelter', 'escape'].includes(cur.name)) return;
        ctx.runSkill('shelter', {}, { source: 'reflex', force: true });
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
    ctx.stats.deaths++; ctx.statsDirty = true;
    ctx.lastPos = null;
    if (ctx.tasks.current) ctx.tasks.current.abort('смерть');
    setTimeout(() => {
      const message = deathMsg && Date.now() - deathMsg.t < 3000 ? deathMsg.msg : null;
      const guess = causeFromMessage(message, bot.username) || ld || 'неизвестно';
      ctx.events.push('death', { cause: guess, message, at: pos ? [pos.x, pos.y, pos.z] : null, phase: ti ? ti.phase : null, deaths: ctx.stats.deaths });
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

module.exports = { attach, pickFood, FOOD_BLACKLIST, causeFromMessage };
