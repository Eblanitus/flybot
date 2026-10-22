// Рефлексы (поведение): плавание, автоеда, автоброня, самозащита, укрытие после респауна ночью.
// Перенесены из lib/reflexes.js как есть — это «учебные колёса», учитель может их менять.
// События удара приходят от ядра (lib/body_events.js) через api.handle('player_attack' | 'mob_hurt').
// Правка L018: защита больше не повторяет молча одно и то же решение.
//   — отказ выполнения (тело занято чужой работой) пишется в журнал;
//   — действие, которое не выполнилось, уходит на паузу: следующий раз выбирается другой вариант (бой или побег);
//   — простая команда мозга (идёт мимо очереди задач) вытесняется: защита начинается сразу, а не после неё.
// Правка L043 (смерть 20261022-073132): рефлекс больше не вытаскивает муху из готового укрытия
//   и не берёт копку-укрытие, когда враг уже вплотную и HP низкий (задача не успевает).
//   — муха в закрытом укрытии: блок зомби не проломит, а побег вытащит наружу — стоим и ждём;
//   — враг ближе defenseCloseDist и HP ниже defenseLowHp: копка-укрытие (3-4 с) в вариантах её нет.
// Правка А (законы игры вместо порогов): «HP низкий» = бой проигран по оценке lib/danger.js (outlook: удары мобов, оружие мухи),
//   «копка не успевает» = не отбиваясь, муха умрёт раньше shelterBuildMs; пороги defenseLowHp/swatMinHp — только когда оценки нет.
// Правка L052 (смерть 20261022-104811-74, 00:54:56-00:55:05): укрытие есть, только пока по муху не бьют.
//   — mob_hurt = удар: признак «в укрытии» не действует — зомби в 0.3 м из «укрытия» (голова открыта) бил 8 раз подряд и убил за 9 с;
//   — при ударе и враге ближе hitNoShelterDist (2 м) копку-укрытие не начинаем и не ждём (раньше до правила не доходило: hold срабатывал первым);
//   — в журнале вместо «в укрытии, стою» — причина: «в укрытии, но по муху бьют — укрытия нет, ухожу». L018 и L043 держатся.
'use strict';
const L = require('./core');
const { entName, isAutoTarget, isHostile } = L('util');
const { equipBestArmor } = L('actions');
const { timeInfo } = L('perception');
const AG = L('aggressors');
const F = L('felt');
const E = L('experience');
const SURV = L('skills/survival');
const T = require('./thresholds');
const D = L('danger');

function hasWeapon(bot) { return bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name)); }
function hostilesNear(bot, r) {
  const p = bot.entity.position;
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && isHostile(e) && F.posOf(e).distanceTo(p) <= r).length;
}

// ---- L043: муха в закрытом укрытии? Тело это знает ----
// ctx.sheltered — навык shelter его поставил (lib/skills/survival.js), тело снимает, когда муха вышла;
// isSheltered(bot) — блоки вокруг закрыты прямо сейчас (зомби такой блок не проломит).
// L052: признак действует, только пока по муху НЕ бьют — пришёл mob_hurt, значит укрытия фактически нет
// (моб достаёт сквозь/изнутри — как зомби в яме 0.3 м), и на ударе защиты от мобов «стою» не выбирается.
function inShelter(ctx) {
  if (!ctx.sheltered) return false; // тело не считает муху в укрытии
  try { return !!SURV.isSheltered(ctx.bot); } catch (e) { return true; }
}
// До кого бьют/до кого дошли: обидчик (или ближайший враждебный, если обидчик неизвестен)
function attackerDist(bot, att) {
  if (att) { const d = F.distTo(bot, att); if (isFinite(d)) return d; }
  const nh = F.nearestHostile(bot, T.defenseFightDist);
  return nh ? F.distTo(bot, nh) : null;
}
// А: чем кончится бой здесь и сейчас — законы игры (lib/danger.js: удары мобов, оружие мухи). null — оценки нет: тогда пороги thresholds
function outlookOf(ctx, att) { try { return D.outlook(ctx.bot, att && att.id); } catch (e) { return null; } }
// L043: копка-укрытие не успевает — враг вплотную, и пока муха копает (shelterBuildMs, не отбиваясь), её добьют.
// А: «добьют» — по оценке passiveTtdSec (не отбиваться); без оценки — старый порог defenseLowHp
function shelterTooSlow(ctx, att) {
  const bot = ctx.bot;
  const o = outlookOf(ctx, att);
  const slow = o ? o.passiveTtdSec != null && o.passiveTtdSec * 1000 < T.shelterBuildMs : bot.health < T.defenseLowHp;
  if (!slow) return false;
  const d = attackerDist(bot, att);
  return d !== null && d <= T.defenseCloseDist;
}

// ---- Что сейчас занимает тело: задача (источник известен) или простая команда (в ящике — «простая команда: goto») ----
function busyInfo(ctx) {
  const tm = ctx.tasks; if (!tm) return { busy: false, legacy: false, what: '' };
  const cur = tm.current;
  if (cur) return { busy: true, legacy: false, what: `навыком ${cur.name} (задача ${cur.id}, ${cur.source || 'brain'})` };
  if (tm.legacyBusy) return { busy: true, legacy: true, what: tm.legacy && tm.legacy.name ? `простой командой ${tm.legacy.name}` : 'простой командой' };
  return { busy: false, legacy: false, what: '' };
}

// ---- Отказы рефлекса: какое действие не выполнилось и до какого времени его не предлагаем ----
function failState(ctx) {
  if (!ctx.reflexFail) ctx.reflexFail = { last: null, count: 0, banned: {} };
  const s = ctx.reflexFail, now = Date.now();
  for (const k of Object.keys(s.banned)) if (s.banned[k] <= now) delete s.banned[k];
  return s;
}
function bannedActions(ctx) { return failState(ctx).banned; }
// отказ: считаем подряд и убираем действие из выбора — ту же попытку не повторяем
function noteRefusal(ctx, action) {
  const s = failState(ctx);
  if (s.last === action) s.count++; else { s.last = action; s.count = 1; }
  s.banned[action] = Date.now() + T.reflexFailBanMs;
  return { count: s.count, until: s.banned[action] };
}
// действие выполнилось — оно рабочее: паузу снимаем
function clearRefusal(ctx, action) {
  const s = failState(ctx);
  if (s.last === action) { s.last = null; s.count = 0; }
  delete s.banned[action];
}

// Что делать, когда ударил моб (att — определённый обидчик или null). null — ничего не запускать.
// Тактику не зашиваем: варианты упорядочены старым правилом (это лишь prior), выбирает опыт (experience.js) — что выживало в такой обстановке
function defensePrior(ctx, att, underHit) {
  const bot = ctx.bot;
  const canFight = !!att && F.distTo(bot, att) <= T.defenseFightDist && isAutoTarget(att);
  const o = outlookOf(ctx, att);
  const losing = o ? !o.win : bot.health < T.defenseLowHp; // А: бой проигран по оценке (без оценки — порог HP)
  const opts = losing ? ['escape', 'shelter'] : (!hasWeapon(bot) && (hostilesNear(bot, T.crowdR) >= T.crowdN || timeInfo(bot).isNight)) ? ['shelter', 'escape'] : canFight ? ['fight', 'shelter', 'escape'] : ['escape', 'shelter'];
  if (canFight && !opts.includes('fight')) opts.push('fight');
  // L043: враг вплотную и HP низкий — копка-укрытие (3-4 с) не успевает: в вариантах её нет. Остаётся бой (если оружие есть) или отход.
  if (shelterTooSlow(ctx, att)) {
    const iSh = opts.indexOf('shelter'); if (iSh >= 0) opts.splice(iSh, 1);
    if (!hasWeapon(bot)) { const iFi = opts.indexOf('fight'); if (iFi >= 0) opts.splice(iFi, 1); }
  }
  // L052: по муху бьют (mob_hurt) и враг ближе hitNoShelterDist — новую копку-укрытие не начинаем и не ждём: побег или бой.
  if (underHit) {
    const d = attackerDist(bot, att);
    if (d !== null && d < T.hitNoShelterDist) { const iSh = opts.indexOf('shelter'); if (iSh >= 0) opts.splice(iSh, 1); }
  }
  const si = opts.indexOf('shelter');
  if (si >= 0 && ctx.shelterFailT && Date.now() - ctx.shelterFailT < T.shelterFailMs) opts.splice(si, 1); // укрытие только что не вышло здесь
  // действие, которое только что НЕ выполнилось, — не предлагаем: другой вариант (бой или побег)
  const ban = bannedActions(ctx);
  if (Object.keys(ban).length) {
    const keep = opts.filter(o => !ban[o]);
    if (keep.length) return keep;
    // все варианты на паузе — берём тот, что запрещён давно (иначе повторим только что отказанный)
    return opts.slice().sort((a, b) => (ban[a] || 0) - (ban[b] || 0));
  }
  return opts;
}
function mobHurtPlan(ctx, att) {
  const bot = ctx.bot, cur = ctx.tasks.current;
  if (cur && ['fight', 'defend', 'escape', 'shelter'].includes(cur.name)) return null; // защита уже идёт — не дёргать её на каждом ударе
  // L052: mob_hurt — по муху бьют прямо сейчас, признак «в укрытии» не действует, «стоять» нельзя
  // (зомби в 0.3 м при «укрытии» бил 8 раз подряд — 20→0 за 9 с). L043 («в укрытии стоим») держится,
  // пока по муху не бьют: здесь такое решение от удара больше не выходит, «стою» остаётся у защиты от игрока.
  const plan = { shelterVoid: inShelter(ctx) }; // признак укрытия был, удар его отменил — причина пойдёт в журнал
  const opts = defensePrior(ctx, att, true);
  const o = outlookOf(ctx, att);
  if (cur && (o ? o.win : bot.health >= T.swatMinHp) && att && opts[0] === 'fight') { plan.swat = att; return plan; } // занят делом, бой выигран (А; без оценки — HP в норме) — отмахнуться
  const ch = E.choose(ctx, opts);
  const params = ch.action === 'fight' ? { targetId: att.id, radius: T.fightRadius } : {};
  const note = shelterTooSlow(ctx, att) ? '; копка-укрытие не успевает' : '';
  plan.skill = ch.action;
  plan.params = params;
  plan.why = ch.why + note;
  plan.options = opts;
  plan.dist = attackerDist(bot, att);
  return plan;
}

// Ждём старта задачи, но не бесконечно: если тело занято и задача не пошла — это отказ (пишем в журнал)
function withTimeout(p, ms) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (done) return; done = true; resolve({ ok: false, error: 'не дождались старта (тело занято)', timeout: true }); }, ms);
    if (t.unref) t.unref();
    Promise.resolve(p).then(
      v => { if (done) return; done = true; clearTimeout(t); resolve(v); },
      e => { if (done) return; done = true; clearTimeout(t); resolve({ ok: false, error: String(e && e.message ? e.message : e) }); }
    );
  });
}

// Запустить защиту: вытеснить чужую работу, запустить навык и честно сказать, если не вышло.
// Возвращает итог запуска: {ok:true} — задача пошла; {ok:false, error} — отказ (тело занято).
async function startDefense(ctx, plan) {
  const tm = ctx.tasks;
  const was = busyInfo(ctx);
  // простая команда мозга идёт мимо очереди задач: пока она длится, защита не стартует — останавливаем её
  if (was.busy && was.legacy && tm && typeof tm.stop === 'function') {
    try { await tm.stop('вытеснен рефлексом'); } catch (e) {}
    ctx.events.push('info', { msg: `рефлекс: вытесняю ${was.what} — защита важнее`, reflex: true });
  }
  let r = null;
  try {
    r = await withTimeout(ctx.runSkill(plan.skill, plan.params, { source: 'reflex', force: true }), T.reflexStartMs);
  } catch (e) {
    r = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  if (r && r.ok !== false) { clearRefusal(ctx, plan.skill); return r; }
  const why = String((r && r.error) || 'неизвестно');
  const st = noteRefusal(ctx, plan.skill);
  const now = busyInfo(ctx);
  const busy = was.busy ? was : now;
  ctx.events.push('info', {
    msg: `рефлекс: ${plan.skill} — не выполнено${busy.busy ? `: тело занято ${busy.what}` : ''}: ${why} (отказов подряд ${st.count} — следующий раз другой вариант)`,
    reflex: true, action: plan.skill, error: why
  });
  return r;
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
  api.handle('player_attack', async ({ player, name }) => {
    const cur = ctx.tasks.current;
    const low = String(name).toLowerCase();
    if (cur && (cur.name === 'escape' || cur.name === 'defend')) return;
    if (cur && cur.name === 'fight' && String(cur.params && cur.params.target || '').toLowerCase() === low) return;
    // L043: в закрытом укрытии наружу не выходим (побег вытащил бы в открытое место). Игрок блок проломит — тогда укрытия уже нет.
    if (inShelter(ctx)) { ctx.events.push('info', { msg: 'рефлекс: в укрытии, стою', reflex: true, hold: true }); return; }
    const p = bot.entity.position;
    // посторонние враги рядом: мобы или другие игроки-агрессоры в 6 м
    const others = hostilesNear(bot, T.playerOthersR) + Object.values(bot.entities).filter(e =>
      e && e !== bot.entity && e !== player && AG.isAggressorEntity(ctx, e) && e.position.distanceTo(p) <= T.playerOthersR).length;
    const canFight = hasWeapon(bot) && bot.health >= T.playerFightHp && others === 0;
    const plan = canFight
      ? { skill: 'fight', params: { target: low, radius: AG.CHASE_MAX, flee_hp: T.playerFleeHp, timeout: T.playerFightTimeout }, why: `игрок ${name} ударил`, options: ['fight', 'escape'] }
      : { skill: 'escape', params: {}, why: `игрок ${name} ударил`, options: ['escape', 'shelter'] };
    await startDefense(ctx, plan);
  });

  // ---- Самооборона от моба ----
  api.handle('mob_hurt', async ({ att, source }) => {
    if (att && !isAutoTarget(att) && att === source) return; // эндермен, голем и т.п. — не трогаем
    const plan = mobHurtPlan(ctx, att);
    if (!plan) return;
    if (plan.shelterVoid) { // L052: не «в укрытии, стою», а причина — удар отменяет «укрытие», действуем как обычно
      ctx.events.push('info', { msg: 'рефлекс: в укрытии, но по муху бьют — укрытия нет, ухожу', reflex: true });
    }
    if (plan.swat) {
      const s = plan.swat;
      if (F.distTo(bot, s) < T.swatReach) bot.lookAt(F.posOf(s).offset(0, (s.height || 1.8) * 0.8, 0), true).then(() => bot.attack(s)).catch(() => {});
      return;
    }
    ctx.events.push('info', { msg: `рефлекс: ${plan.skill} (${plan.why}; варианты ${plan.options.join('/')}; враг ${plan.dist === null || plan.dist === undefined ? '?' : plan.dist.toFixed(1)} м, HP ${Math.round(bot.health)})` });
    await startDefense(ctx, plan);
  });

  // ---- Респаун ночью среди мобов: голыми руками не воевать, сразу укрыться (иначе — смерть по кругу на спавне) ----
  api.on(bot, 'spawn', () => {
    api.after(T.respawnDelayMs, () => {
      if (!ctx.ready || bot.health <= 0) return;
      if (!timeInfo(bot).isNight || hasWeapon(bot) || hostilesNear(bot, T.respawnHostilesR) === 0) return;
      const cur = ctx.tasks.current;
      if (cur && ['shelter', 'escape'].includes(cur.name)) return;
      const ch = E.choose(ctx, ['shelter', 'escape']);
      startDefense(ctx, { skill: ch.action, params: {}, why: ch.why, options: ['shelter', 'escape'] }).catch(() => {});
    }, 'респаун ночью');
  });

  // при выгрузке версии — отпустить «прыжок», если держали его сами
  return { detach() { if (swimJump) { try { bot.setControlState('jump', false); } catch (e) {} swimJump = false; } } };
}

module.exports = { attach, mobHurtPlan, defensePrior, pickFood, FOOD_BLACKLIST, hasWeapon, hostilesNear,
  busyInfo, failState, bannedActions, noteRefusal, clearRefusal, startDefense, inShelter, attackerDist, shelterTooSlow, outlookOf };
