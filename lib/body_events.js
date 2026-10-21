// События тела (ядро): учёт урона, сигналы опасности, кто ударил, смерть, пройденный путь, чат.
// Только факты и журналы — решений здесь нет. Что делать при ударе, голоде, в воде — решает поведение (behavior/),
// ядро лишь передаёт ему события через хост (lib/behavior_host.js: player_attack, mob_hurt).
// Подключается ОДИН раз на экземпляр бота; все таймеры живут в session и чистятся при отключении.
'use strict';
const { entName, isHostile, r1, dirName } = require('./util');
const { timeInfo } = require('./perception');
const AG = require('./aggressors');
const threats = require('./threats');
const F = require('./felt');
const E = require('./experience');

const HURT_KEEP_MS = 20000; // журнал урона для законов игры (lib/danger.js)

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
  if (/was killed$|was killed/.test(m)) return 'убит командой /kill или магией';
  if (/out of the world/.test(m)) return 'пустота';
  return m.trim();
}

// Передать событие поведению (если оно подключено)
function toBehavior(ctx, name, payload) {
  const h = ctx.behaviorHost;
  if (h) h.emit(name, payload);
}

function attach(ctx, session) {
  const bot = ctx.bot;
  const every = (ms, fn) => session.timers.push(setInterval(() => { if (ctx.bot === bot && ctx.ready && bot.entity) { try { Promise.resolve(fn()).catch(() => {}); } catch (e) {} } }, ms));
  E.attach(ctx, session);         // опыт: что помогало выжить в какой обстановке
  threats.attach(ctx, session);   // враги-игроки: danger kind:"enemy_player"

  // ---- Голова под водой: с какого момента (законы игры считают по нему воздух; oxygenLevel в 26.1 ненадёжен) ----
  every(250, () => {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.5, 0));
    if (head && head.name === 'water') { if (!ctx.headUnderSince) ctx.headUnderSince = Date.now(); } else ctx.headUnderSince = 0;
  });

  // ---- Урон: статистика, журнал для законов игры, сигнал low_hp ----
  let lastHealth = null;
  let lowHpWarned = false;
  bot.on('health', () => {
    if (lastHealth != null && bot.health < lastHealth) {
      ctx.stats.damageTaken += (lastHealth - bot.health);
      ctx.statsDirty = true;
      const now = Date.now();
      const log = ctx.hurtLog || (ctx.hurtLog = []);
      log.push({ t: now, amount: lastHealth - bot.health });
      while (log.length && now - log[0].t > HURT_KEEP_MS) log.shift();
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

  // Игрок ударил: запомнить агрессора, сигнал attacked; что делать — решает поведение (player_attack)
  let lastAttackEvent = 0;
  function onPlayerAttack(player) {
    const name = player.username || entName(player);
    const rec = AG.record(ctx, name);
    ctx.combatUntil = Date.now() + 5000;
    const d = r1(bot.entity.position.distanceTo(player.position));
    if (Date.now() - lastAttackEvent > 5000) {
      lastAttackEvent = Date.now();
      ctx.events.push('danger', { kind: 'attacked', by: name, player: true, hp: Math.round(bot.health), d, hits: rec ? rec.hits : 1 });
    }
    toBehavior(ctx, 'player_attack', { player, name });
  }

  // Моб ударил: кто на самом деле (felt.js), сигнал attacked; что делать — решает поведение (mob_hurt)
  function onMobHurt(source, cause) {
    const att = F.resolveAttacker(bot, source).entity;
    F.feel(ctx, att);
    ctx.combatUntil = Date.now() + 5000;
    if (Date.now() - lastAttackEvent > 5000) {
      lastAttackEvent = Date.now();
      ctx.events.push('danger', { kind: 'attacked', by: att ? entName(att) : cause, hp: Math.round(bot.health), d: att ? r1(F.distTo(bot, att)) : null, ...(att && att !== source ? { note: 'источник не рядом — бил ближний ' + entName(att) } : {}) });
    }
    toBehavior(ctx, 'mob_hurt', { att, source, cause });
  }
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return;
    // сервер не назвал источник — ищем обидчика-игрока по взмаху руки рядом
    if (!source || !source.position) { const g = AG.guessAttacker(bot, swings); if (g) source = g; }
    const cause = source ? entName(source) : null; // без источника: падение/огонь/вода/голод/команда — уточняем по сообщению о смерти
    ctx.lastDamage = { cause, t: Date.now(), sourceId: source ? source.id : null };
    if (source && source.type === 'player' && source !== bot.entity) { onPlayerAttack(source); return; }
    if (!source || !isHostile(source)) return; // урон не от моба
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

  // ---- Сканер опасностей и ночи (сигналы, без действий) ----
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

module.exports = { attach, causeFromMessage };
