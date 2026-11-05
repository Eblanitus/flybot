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
// Правка «утопление» (смерть 20261031-063950: стояла под льдом/потолком 45 с, голова в воде, goto не прерывался):
//   — голова под водой дольше drownUnderMs и за drownStillMs высота не выросла — тону: бросаю задачу и pathfinder,
//     плыву к ближайшему воздуху или ломаю то, что над головой; не помогло — блок под ноги; автопилот то же дело на минуты не берёт.
'use strict';
const L = require('./core');
const { entName, isAutoTarget, isHostile, Vec3 } = L('util');
const { equipBestArmor, equipToolFor, equipBestWeapon } = L('actions');
const { timeInfo } = L('perception');
const AG = L('aggressors');
const F = L('felt');
const E = L('experience');
const SURV = L('skills/survival');
const T = require('./thresholds');
const D = L('danger');
// этап 2 стенда (HC_REFLEX — путь к hardcore/reflexes.js, только у учащихся мух): какой ответ рефлекса — выбирает муха по очкам;
// автоеда, «моб подходит» и «ожила ночью» здесь выключены (еда и ночь — дела общего списка, моб вплотную — рефлекс там)
const RX = process.env.HC_REFLEX ? require(process.env.HC_REFLEX) : null;

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
  try { return !!SURV.isSheltered(ctx.bot); } catch (e) { return false; }
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
  const lowHp = bot.health < T.apLowHp;
  // behavior_reflexes_fight_nowpn: голыми руками не воюем — без оружия бой не предлагаем вовсе
  const canFight = !lowHp && !!att && F.distTo(bot, att) <= T.defenseFightDist && isAutoTarget(att) && hasWeapon(bot);
  const o = outlookOf(ctx, att);
  const losing = lowHp || (o ? !o.win : bot.health < T.defenseLowHp); // А: бой проигран по оценке (без оценки — порог HP)
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
  if (si >= 0 && ctx.shelterFailT && Date.now() - ctx.shelterFailT < T.shelterFailMs) {
    opts.splice(si, 1);
    if (!inShelter(ctx)) {
      const ei = opts.indexOf('escape');
      if (ei >= 0) {
        opts.splice(ei, 1);
        opts.push('escape');
      }
    }
  }
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
  if (cur && ['fight', 'defend', 'escape', 'shelter', 'collect', 'gather_list', 'craft', 'smelt_all', 'mine_vein', 'mine_tunnel', 'gather_wood', 'cook_food'].includes(cur.name)) return null; // защита уже идёт или идёт сбор/крафт/добыча — не дёргать её на каждом ударе
  // L052: mob_hurt — по муху бьют прямо сейчас, признак «в укрытии» не действует, «стоять» нельзя
  // (зомби в 0.3 м при «укрытии» бил 8 раз подряд — 20→0 за 9 с). L043 («в укрытии стоим») держится,
  // пока по муху не бьют: здесь такое решение от удара больше не выходит, «стою» остаётся у защиты от игрока.
  const lowHp = bot.health < T.apLowHp;
  const plan = { shelterVoid: inShelter(ctx) }; // признак укрытия был, удар его отменил — причина пойдёт в журнал
  const opts = defensePrior(ctx, att, true);
  const o = outlookOf(ctx, att);
  if (cur && (o ? o.win : bot.health >= T.swatMinHp) && !lowHp && att && opts[0] === 'fight') { plan.swat = att; return plan; } // занят делом, бой выигран (А; без оценки — HP в норме) — отмахнуться
  const mobName = att ? entName(att) : null;
  let ch = shelterTooSlow(ctx, att) ? { action: 'escape', why: `мало HP и враг вплотную — копка-укрытие не успевает, экстренный побег` } : E.choose(ctx, opts);
  // v0.4 (2.4): побег от такого моба недавно не оторвался (fled:false) — сразу укрытие (если оно в вариантах: не вплотную и не только что упало)
  if (ch.action === 'escape' && mobName && escapeFailed(ctx, mobName) && opts.includes('shelter') && !shelterTooSlow(ctx, att))
    ch = { action: 'shelter', why: `прошлый побег от ${mobName} не оторвался (fled:false) — сразу укрытие` };
  const params = ch.action === 'fight' ? { targetId: att.id, radius: T.fightRadius } : {};
  const note = shelterTooSlow(ctx, att) ? '; копка-укрытие не успевает' : '';
  // А: при критически низком HP (< 10) — escape использует экстренные варианты в зависимости от типа врага
  if (ch.action === 'escape' && bot.health < T.apLowHp) {
    const isRanged = att && F.RANGED.has(entName(att));
    const isNight = timeInfo(bot).isNight;
    const dist = attackerDist(bot, att);
    const hasBlocks = bot.inventory.items().filter(i => ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'diorite', 'andesite', 'granite', 'tuff', 'coarse_dirt', 'deepslate', 'calcite', 'sandstone', 'blackstone'].includes(i.name)).reduce((a, i) => a + i.count, 0) >= 3;
    const hasWeapon = bot.inventory.items().some(i => /_sword$|_axe$/.test(i.name));
    if (isRanged) {
      // Скелет/стрелк — приоритет укрытие от линии огня (cover_escape) или зигзаг
      if (dist != null && dist <= 5 && hasBlocks && !hasWeapon) {
        params.style = 'wall_escape'; // ставим стену между собой и скелетом
      } else {
        params.style = 'cover_escape'; // ищем укрытие, разрывая линию огня
      }
    } else if (isNight) {
      // Ночь, враг ближнего боя — столб
      params.style = 'pillar'; // предпочитаем столб: мобы ближнего боя не достают
    } else {
      // День / подземелье, враг ближнего боя (зомби и др.) при низком HP — агрессивный разрыв дистанции и отход
      if (dist != null && dist <= 6 && hasBlocks && !hasWeapon) {
        params.style = 'wall_escape';
      } else if (dist != null && dist <= 8) {
        params.style = 'zigzag';
      } else {
        params.style = 'sprint_away';
      }
    }
  }
  plan.skill = ch.action;
  plan.mob = mobName;
  plan.params = params;
  plan.why = ch.why + note;
  plan.options = opts;
  plan.dist = attackerDist(bot, att);
  return plan;
}

// ---- v0.4 (2.4): побег, который не оторвал от моба (fled:false), помним по виду моба escapeFailMemMs — в следующий раз тот же моб → сразу укрытие ----
function noteEscapeFail(ctx, mob) { if (mob) (ctx.escapeFail || (ctx.escapeFail = {}))[String(mob)] = Date.now(); }
function escapeFailed(ctx, mob) {
  const t = mob && ctx.escapeFail ? ctx.escapeFail[String(mob)] : 0;
  return !!t && Date.now() - t < T.escapeFailMemMs;
}
// итоги побегов: запуск запомнен (ctx.escapeWatch: [{taskId, mob, t}]) — ищем task_done/task_failed этой задачи в журнале и смотрим result.fled
function scanEscapes(ctx) {
  const w = ctx.escapeWatch; if (!w || !w.length) return;
  const buf = (ctx.events && ctx.events.buf) || [];
  ctx.escapeWatch = w.filter(it => {
    if (Date.now() - it.t > T.escapeFailMemMs) return false;
    const ev = buf.find(e => e.taskId === it.taskId && (e.type === 'task_done' || e.type === 'task_failed'));
    if (!ev) return true;
    const r = ev.result;
    if (r && r.fled === false) noteEscapeFail(ctx, it.mob);
    return false;
  });
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
  // v0.4 (2.4, смерть 110846: в руке pointed_dripstone, меч в сумке): оружие в сумке есть, а в руке нет — сначала меч/топор в руку (быстро, до защиты)
  try {
    const b = ctx.bot, held = b && b.heldItem;
    if (b && b.inventory && hasWeapon(b) && !(held && /_(sword|axe)$|^(trident|mace)$/.test(held.name))) await withTimeout(equipBestWeapon(b), 1500);
  } catch (e) {}
  let r = null;
  try {
    r = await withTimeout(ctx.runSkill(plan.skill, plan.params, { source: 'reflex', force: true }), T.reflexStartMs);
  } catch (e) {
    r = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  if (r && r.ok !== false) {
    clearRefusal(ctx, plan.skill);
    if (plan.skill === 'escape' && plan.mob && r.taskId) (ctx.escapeWatch || (ctx.escapeWatch = [])).push({ taskId: r.taskId, mob: String(plan.mob), t: Date.now() });
    return r;
  }
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

// Цикл mob_near (моб сближается): что делать — {skill, params, why}. Крипер/проигрыш/мало HP — уклонение;
// бой — только с оружием (behavior_reflexes_fight_nowpn: голыми руками 20 HP против паука — смерть); без оружия — укрытие/отход
function mobNearPlan(ctx, nearest, dist) {
  const bot = ctx.bot;
  const o = outlookOf(ctx, nearest);
  const losing = o ? !o.win : bot.health < T.defenseLowHp;
  const isCreeper = nearest.name === 'creeper';
  const armed = hasWeapon(bot);
  const canFight = armed && F.distTo(bot, nearest) <= T.defenseFightDist && isAutoTarget(nearest);
  const d = Number(dist).toFixed(1);
  if (isCreeper || losing || bot.health <= T.swatMinHp) {
    const params = {};
    if (!isCreeper && bot.health < T.apLowHp) {
      const isRanged = F.RANGED.has(nearest.name);
      const hasBlocks = bot.inventory.items().filter(i => ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'diorite', 'andesite', 'granite', 'tuff', 'coarse_dirt', 'deepslate', 'calcite', 'sandstone', 'blackstone'].includes(i.name)).reduce((a, i) => a + i.count, 0) >= 3;
      const hasWeapon = armed;
      if (isRanged) {
        params.style = dist <= 5 && hasBlocks && !hasWeapon ? 'wall_escape' : 'cover_escape';
      } else {
        params.style = dist <= 6 && hasBlocks && !hasWeapon ? 'wall_escape' : (dist <= 8 ? 'zigzag' : 'sprint_away');
      }
    }
    // v0.4 (2.4): побег от такого моба недавно не оторвался — сразу укрытие (не вплотную и не только что упавшее)
    if (!isCreeper && escapeFailed(ctx, nearest.name) && dist >= T.hitNoShelterDist && !bannedActions(ctx).shelter && !(ctx.shelterFailT && Date.now() - ctx.shelterFailT < T.shelterFailMs))
      return { skill: 'shelter', params: {}, mob: nearest.name, why: `моб ${nearest.name} ${d} м — прошлый побег от такого не оторвался, сразу укрытие` };
    return { skill: 'escape', params, mob: nearest.name, why: `моб ${nearest.name} ${d} м — уклонение от ${isCreeper ? 'взрыва' : 'урона'}` };
  }
  if (canFight) return { skill: 'fight', params: { targetId: nearest.id, radius: T.fightRadius }, why: `моб ${nearest.name} ${d} м — бой` };
  if (!armed) {
    // вплотную копка-укрытие не успевает — отход; иначе укрытие
    const close = dist < T.hitNoShelterDist || bannedActions(ctx).shelter || (ctx.shelterFailT && Date.now() - ctx.shelterFailT < T.shelterFailMs);
    const params = {};
    if (close && bot.health < T.apLowHp) {
      const hasBlocks = bot.inventory.items().filter(i => ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'diorite', 'andesite', 'granite', 'tuff', 'coarse_dirt', 'deepslate', 'calcite', 'sandstone', 'blackstone'].includes(i.name)).reduce((a, i) => a + i.count, 0) >= 3;
      params.style = dist <= 6 && hasBlocks ? 'wall_escape' : 'zigzag';
    }
    return close ? { skill: 'escape', params, mob: nearest.name, why: `моб ${nearest.name} ${d} м — нет оружия, отхожу` }
      : { skill: 'shelter', params: {}, why: `моб ${nearest.name} ${d} м — нет оружия, укрываюсь` };
  }
  return { skill: 'shelter', params: {}, why: `моб ${nearest.name} ${d} м — укрытие` };
}
// HP < apLowHp и стрелок (скелет и пр.) ближе rangedLowHpDist — побег, стиль чередуем (cover_escape / sprint_away):
// прошлый побег не оторвал — следующий другой. escape_to_base при низком HP исключён в combat.chooseVariant.
function rangedLowHpPlan(ctx, hostiles) {
  const bot = ctx.bot;
  if (!bot || bot.health >= T.apLowHp || !bot.entity) return null;
  const p = bot.entity.position;
  const r = (hostiles || []).filter(e => F.RANGED.has(entName(e)) && F.posOf(e))
    .map(e => ({ e, d: F.posOf(e).distanceTo(p) })).filter(x => x.d <= T.rangedLowHpDist).sort((a, b) => a.d - b.d)[0];
  if (!r) return null;
  const styles = ['cover_escape', 'sprint_away'];
  const n = ctx._rangedEscN = (ctx._rangedEscN || 0) + 1;
  const style = styles[(n - 1) % styles.length];
  return { params: { style }, mob: entName(r.e), dist: r.d,
    why: `${entName(r.e)} ${r.d.toFixed(1)} м, HP ${Math.round(bot.health)} < ${T.apLowHp} — ухожу из-под стрел (${style})` };
}

// Вредная/нежелательная еда
const FOOD_BLACKLIST = new Set(['poisonous_potato', 'pufferfish', 'spider_eye', 'chicken', 'suspicious_stew', 'chorus_fruit',
  'enchanted_golden_apple', 'golden_apple', 'rotten_flesh']);

// v0.3: цена шага pathfinder (exclusionAreasStep — его зовут для клеток ног и головы): сталагмит в клетке или под ней,
// сталактит над ней (до 2 блоков) — дорого, но не 100 (100 = «нельзя»): обход есть — обходит, нет — идёт (урон 4→2, смерть от сталактита)
const DRIP = 'pointed_dripstone';
function dripstoneCost(block, isDripAt) {
  if (!block || !block.position) return 0;
  if (block.name === DRIP) return T.dripstoneCost;
  const p = block.position;
  for (const dy of [-1, 1, 2]) { try { if (isDripAt(p.offset(0, dy, 0))) return T.dripstoneCost; } catch (e) {} }
  return 0;
}

// когда есть: голодна (≤ eatFood), ранена (HP ≤ eatHurtHp), или HP не полный, а сытость ниже порога регенерации —
// v0.3 еда: доедаем до eatRegenFood (18), иначе HP 2 при сытости 16 стоит часами (регенерация в Java только с 18)
function needsEat(food, hp) {
  return food <= T.eatFood || (food < 20 && hp <= T.eatHurtHp) || (food < T.eatRegenFood && hp < T.apFullHp);
}

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

// ---- Утопление: чистые решения (без бота — проверяются в behavior/test.js) ----
const WET_NAMES = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const isWetB = b => !!b && WET_NAMES.has(b.name);
const isAirB = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air');
const isSolidB = b => !!b && b.boundingBox === 'block';
const PILLAR_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack', 'coarse_dirt', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff'];

// Тону ли: голова под водой дольше drownUnderMs и за последние drownStillMs высота не выросла на drownRiseMin.
// hist — [{t, y}] по возрастанию времени (высота ног). Отсчёта старше окна нет — оценки нет (false): ждём, пока наберётся история.
function isDrowning(underMs, hist, now) {
  if (!(underMs >= T.drownUnderMs) || !hist || !hist.length) return false;
  const yNow = hist[hist.length - 1].y;
  let y0 = null;
  for (const h of hist) { if (h.t <= now - T.drownStillMs) y0 = h.y; else break; } // последний отсчёт не новее окна
  return y0 !== null && yNow - y0 < T.drownRiseMin;
}

// Что над головой: первый не-водный блок в трёх клетках над глазами. kind: 'air' (воздух сверху — всплыть можно),
// 'solid' (лёд/камень/что угодно твёрдое — ломать), 'other' (лава и пр. — не трогаем), 'water' (до верха вода или не загружено).
function blockOverhead(getBlock, pos, n = 3) {
  const ex = Math.floor(pos.x), ez = Math.floor(pos.z), ey = Math.floor(pos.y + 1.5);
  for (let k = 1; k <= n; k++) {
    const b = getBlock(ex, ey + k, ez);
    if (!b || isWetB(b)) continue;
    if (isAirB(b)) return { kind: 'air', x: ex, y: ey + k, z: ez, name: b.name };
    if (isSolidB(b)) return { kind: 'solid', x: ex, y: ey + k, z: ez, name: b.name };
    return { kind: 'other', x: ex, y: ey + k, z: ez, name: b.name };
  }
  return { kind: 'water' };
}

// Ближайшая клетка с воздухом: радиус drownSurfaceR по горизонтали, ±drownSurfaceDy по высоте от глаз; воздух в клетке и над ней
// (голове есть где дышать), под ней вода или твёрдое, а по прямой от головы до неё нет твёрдых блоков (не за стеной и не за льдом).
function findAirCell(getBlock, pos, R = T.drownSurfaceR, dy = T.drownSurfaceDy) {
  const bx = Math.floor(pos.x), bz = Math.floor(pos.z), ey = Math.floor(pos.y + 1.5);
  const eyeY = pos.y + 1.5;
  let best = null;
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    if (Math.hypot(dx, dz) > R) continue;
    for (let ddy = -dy; ddy <= dy; ddy++) {
      const x = bx + dx, y = ey + ddy, z = bz + dz;
      if (!isAirB(getBlock(x, y, z)) || !isAirB(getBlock(x, y + 1, z))) continue;
      const below = getBlock(x, y - 1, z);
      if (!isWetB(below) && !isSolidB(below)) continue;
      const d = Math.hypot(x + 0.5 - pos.x, y + 0.5 - eyeY, z + 0.5 - pos.z);
      if (best && d >= best.d) continue;
      let clear = true;
      const steps = Math.max(1, Math.ceil(d / 0.4));
      for (let i = 1; i < steps && clear; i++) {
        const f = i / steps;
        if (isSolidB(getBlock(Math.floor(pos.x + (x + 0.5 - pos.x) * f), Math.floor(eyeY + (y + 0.5 - eyeY) * f), Math.floor(pos.z + (z + 0.5 - pos.z) * f)))) clear = false;
      }
      if (clear) best = { x, y, z, d };
    }
  }
  return best;
}

// Что делать сейчас. st: { skipSwim — к воздуху сбоку пробовали, не вышло; stuck — и вверх не выходит; canPlace — есть чем подставить;
// noDig — ломать не выходит (бедрок, блок не поддался) }.
// swim — плыть к воздуху сбоку; up — просто вверх; dig — сломать твёрдое над головой; place — блок под ноги.
function rescuePlan(getBlock, pos, st = {}) {
  const over = blockOverhead(getBlock, pos);
  const surf = st.skipSwim ? null : findAirCell(getBlock, pos);
  if (over.kind === 'air') return st.stuck && st.canPlace ? { action: 'place', why: 'вверх не поднимаюсь — ставлю блок под ноги' } : { action: 'up', why: 'всплываю вверх (над головой воздух)' };
  if (surf) return { action: 'swim', target: surf, why: `плыву к воздуху (${surf.x} ${surf.z})` };
  if (over.kind === 'solid' && !st.noDig) return { action: 'dig', target: over, why: `ломаю ${over.name} над головой (${over.x} ${over.y} ${over.z})` };
  if (st.stuck && st.canPlace) return { action: 'place', why: 'ничего не помогло — ставлю блок под ноги' };
  return { action: 'up', why: 'воздуха рядом не видно — пробую вверх' };
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

  // ---- Утопление: голова под водой давно, а вверх не выходит (лёд, потолок, край) — бросить задачу и выбираться ----
  // Плавание выше держит «прыжок», но не знает, что над головой твёрдое; задача goto при этом стоит и ждёт (смерть 20261031-063950).
  let rescuing = false, detached = false, drownRetryAt = 0;
  const drownHist = [];
  const getB = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r1 = v => Math.round(v * 10) / 10;
  const headWetNow = () => { const b = bot.blockAt(bot.entity.position.offset(0, 1.5, 0)); return !!b && b.name === 'water'; };
  const pillarItem = () => bot.inventory.items().find(i => PILLAR_BLOCKS.includes(i.name)) || null;

  async function rescueDrowning(underMs) {
    rescuing = true;
    const t0 = Date.now(), tm = ctx.tasks;
    const cur = tm && tm.current;
    const taskName = cur ? cur.name + (cur.params && cur.params.label ? ` «${cur.params.label}»` : '')
      : (tm && tm.legacyBusy ? (tm.legacy && tm.legacy.name) || 'простая команда' : 'нет');
    const st = { skipSwim: false, stuck: false, noDig: false, canPlace: !!pillarItem(), ...(RX ? RX.drownStart(ctx) : {}) };   // HC_REFLEX: с чего начать — выбор мухи
    let plan = rescuePlan(getB, bot.entity.position, st);
    ctx.events.push('info', { msg: `тону: под водой ${Math.round(underMs / 1000)} с, не всплываю (y ${r1(bot.entity.position.y)}) — бросаю задачу ${taskName}, ${plan.why}`, reflex: true, drown: true, action: plan.action, task: taskName });
    let paused = '';
    try {
      // задача и путь: стоп; автопилот то же дело (например «к животным» через эту воду) минуты не берёт
      const ap = ctx.autopilot;
      if (ap && ap.running && ap.until) { ap.until[ap.running.key] = Math.max(ap.until[ap.running.key] || 0, Date.now() + T.drownPauseMs); paused = `${ap.running.key} ${Math.round(T.drownPauseMs / 1000)} с`; }
      try { if (tm && typeof tm.stop === 'function') await tm.stop('тону — рефлекс прерывает'); } catch (e) {}
      try { if (bot.pathfinder) { bot.pathfinder.setGoal(null); if (typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop(); } } catch (e) {}
      ctx.manualControl = true; // «плавание» не мешает: прыжок и ход держим здесь
      let bestY = bot.entity.position.y, bestT = Date.now(), done = false, dug = 0, digFails = 0;
      while (!detached && bot.health > 0 && Date.now() - t0 < T.drownRescueMs) {
        const p = bot.entity.position;
        if (!headWetNow()) { done = true; break; }
        if (p.y > bestY + 0.3) { bestY = p.y; bestT = Date.now(); }
        else if (Date.now() - bestT > T.drownStuckMs) { // выше не поднимаюсь: к воздуху сбоку не вышло — ломать/вверх; и вверх не вышло — блок под ноги
          if (plan.action === 'swim') st.skipSwim = true; else if (plan.action !== 'dig') st.stuck = true;
          st.canPlace = !!pillarItem(); bestT = Date.now();
        }
        const next = rescuePlan(getB, p, st);
        if (next.action !== plan.action) ctx.events.push('info', { msg: `тону: ${next.why}`, reflex: true, drown: true, action: next.action });
        plan = next;
        if (plan.action === 'swim') {
          const tg = new Vec3(plan.target.x + 0.5, plan.target.y + 0.5, plan.target.z + 0.5);
          await bot.lookAt(tg, true).catch(() => {});
          bot.setControlState('forward', Math.hypot(tg.x - p.x, tg.z - p.z) > 0.4);
          bot.setControlState('jump', true);
          await sleep(150);
        } else if (plan.action === 'dig') {
          const b = bot.blockAt(new Vec3(plan.target.x, plan.target.y, plan.target.z));
          bot.setControlState('forward', false); bot.setControlState('jump', true);
          if (b && isSolidB(b) && b.diggable !== false) {
            try { await equipToolFor(bot, b); } catch (e) {}
            await Promise.race([bot.dig(b, true).catch(() => {}), sleep(T.drownDigMaxMs)]);
            try { bot.stopDigging(); } catch (e) {}
            const after = bot.blockAt(new Vec3(plan.target.x, plan.target.y, plan.target.z));
            if (after && isSolidB(after)) { if (++digFails >= 2) st.noDig = true; } else { dug++; digFails = 0; }
            bestT = Date.now(); // сломали или попытка кончилась — отсчёт «не поднимаюсь» заново
          } else { st.noDig = true; await sleep(150); } // не ломается (бедрок и т.п.) — остаётся блок под ноги
        } else if (plan.action === 'place') {
          bot.setControlState('forward', false); bot.setControlState('jump', true);
          const it = pillarItem();
          if (it && bot.entity.onGround) {
            try {
              await bot.equip(it, 'hand');
              const ref = bot.blockAt(p.offset(0, -1, 0).floored());
              if (ref && isSolidB(ref)) await bot.placeBlock(ref, new Vec3(0, 1, 0));
            } catch (e) {}
          }
          await sleep(250);
        } else { // up
          bot.setControlState('forward', false); bot.setControlState('jump', true);
          await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {});
          await sleep(150);
        }
      }
      const sec = Math.round((Date.now() - t0) / 1000), y = r1(bot.entity.position.y);
      if (done) ctx.events.push('info', { msg: `тону: вынырнула за ${sec} с (y ${y}), воздух есть${dug ? `, сломала блоков: ${dug}` : ''}; задачу ${taskName} бросила${paused ? `, автопилот не берёт ${paused}` : ''}`, reflex: true, drown: true, ok: true });
      else { drownRetryAt = Date.now() + T.drownRetryMs; ctx.events.push('danger', { kind: 'drown', msg: `тону: за ${sec} с не вынырнула (y ${y}, HP ${Math.round(bot.health)}, последнее: ${plan.why})`, reflex: true, drown: true, ok: false }); }
    } catch (e) {
      drownRetryAt = Date.now() + T.drownRetryMs;
      console.log('[reflex] drown rescue fail', e && e.message);
    } finally {
      try { bot.clearControlStates(); } catch (e) {}
      ctx.manualControl = false; underSince = 0; drownHist.length = 0; rescuing = false;
    }
  }
  every(500, () => {
    if (rescuing || detached || ctx.manualControl || !bot.entity || bot.health <= 0) return;
    const now = Date.now();
    if (!headWetNow()) { drownHist.length = 0; return; }
    drownHist.push({ t: now, y: bot.entity.position.y });
    while (drownHist.length > 1 && drownHist[1].t <= now - T.drownStillMs - 3000) drownHist.shift(); // окно + запас
    if (now < drownRetryAt) return;
    const underMs = underSince ? now - underSince : 0;
    if (isDrowning(underMs, drownHist, now)) rescueDrowning(underMs).catch(() => {});
  }, 'утопление');

  // ---- Автоеда ----
  let eating = false;
  let hungerWarned = false;
  every(2000, async () => {
    if (RX) return; // этап 2: поесть — дело общего списка, не рефлекс (хозяин 05.11)
    if (eating || bot.currentWindow) return;
    const needs = needsEat(bot.food, bot.health);
    if (!needs) { if (bot.food > T.hungerWarnResetFood) hungerWarned = false; return; }
    if (Date.now() < ctx.combatUntil) return; // не есть в бою
    if (bot.targetDigBlock || (bot.pathfinder.isMining && bot.pathfinder.isMining())) return; // не есть во время копания
    // behavior_eat_desperate_hp: ранена (HP <= eatHurtHp) — гнилое мясо/сырая курица лучше, чем ждать с HP 1
    const food = pickFood(bot, { desperate: bot.food <= T.desperateFood || bot.health <= T.eatHurtHp });
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

  // ---- v0.3: сталагмиты/сталактиты — pathfinder их обходит (ядро Movements создаёт заново при входе — ставим раз в 5 с,
  // без повторов; функция прежней версии поведения помечена flybotDrip и снимается) ----
  const dripB = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[DRIP];
  const dripStep = dripB ? block => dripstoneCost(block, v => {
    const id = bot.world.getBlockStateId(v);
    return id != null && id >= dripB.minStateId && id <= dripB.maxStateId;
  }) : null;
  if (dripStep) dripStep.flybotDrip = true;
  const movesAll = () => [ctx.movements, ctx.sprintMovements, bot.pathfinder && bot.pathfinder.movements].filter(m => m && Array.isArray(m.exclusionAreasStep));
  const dripOff = () => { for (const m of movesAll()) m.exclusionAreasStep = m.exclusionAreasStep.filter(f => !f.flybotDrip); };
  if (dripStep) {
    const dripOn = () => { for (const m of movesAll()) if (!m.exclusionAreasStep.includes(dripStep)) { m.exclusionAreasStep = m.exclusionAreasStep.filter(f => !f.flybotDrip); m.exclusionAreasStep.push(dripStep); } };
    try { dripOn(); } catch (e) {}
    api.every(5000, () => { try { dripOn(); } catch (e) {} }, 'сталагмиты: обход');
  }

  // ---- Автоброня ----
  every(4000, async () => {
    if (bot.currentWindow) return;
    let put = [];
    try { put = await equipBestArmor(bot); } catch (e) { return; } // как раньше: неудачная примерка — не сбой поведения
    if (put.length) ctx.events.push('info', { msg: 'надел броню: ' + put.join(',') });
  }, 'автоброня');

  // ---- Самооборона от игрока: драться (есть оружие, HP>=12, обидчик один) или убегать ----
  api.handle('player_attack', async ({ player, name }) => {
    if (RX) { await RX.onHit(ctx, 'player', { player, name }); return; } // этап 2: ответ выбирает муха
    const cur = ctx.tasks.current;
    const low = String(name).toLowerCase();
    if (cur && (cur.name === 'escape' || cur.name === 'defend')) return;
    if (cur && cur.name === 'fight' && String(cur.params && cur.params.target || '').toLowerCase() === low) return;
    // L043 / owner fix: в закрытом укрытии наружу не выходим, ПОКА игрок далеко (playerDist >= 3).
    // Если игрок вплотную (playerDist < 3) — укрытия фактически нет (игрок близко/проломит/бьет у входа, как на 1.1 м), стоять нельзя!
    if (inShelter(ctx)) {
      const p = bot.entity.position;
      const playerDist = player && player.position ? player.position.distanceTo(p) : 999;
      if (playerDist >= 3) {
        ctx.events.push('info', { msg: 'рефлекс: в укрытии, стою', reflex: true, hold: true });
        return;
      }
      ctx.events.push('info', { msg: 'рефлекс: в укрытии, но игрок вплотную — укрытия нет, ухожу', reflex: true });
    }
    const p = bot.entity.position;
    const playerDist = player && player.position ? player.position.distanceTo(p) : 999;
    const lowHpAgainstPlayer = bot.health <= 5 && playerDist < 10;
    const hasBlocks = bot.inventory.items().filter(i => ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack'].includes(i.name)).reduce((a, i) => a + i.count, 0) >= 2;
    const others = hostilesNear(bot, T.playerOthersR) + Object.values(bot.entities).filter(e =>
      e && e !== bot.entity && e !== player && AG.isAggressorEntity(ctx, e) && e.position.distanceTo(p) <= T.playerOthersR).length;
    // баттл-рояль стенда (HC_BR_PREFIX): муха против мухи дерётся и кулаком — у обеих обычно нет оружия, а побег при HP 20
    // от каждого удара срывал бой охотника (разбор 04.11: 56 побегов, 27 из них при HP ≥ 14). Против других игроков — как было.
    const brFly = !!process.env.HC_BR_PREFIX && String(name).startsWith(process.env.HC_BR_PREFIX);
    const canFight = !lowHpAgainstPlayer && (hasWeapon(bot) || brFly) && bot.health >= T.playerFightHp && others === 0;
    // Без блоков на укрытие — побег (escape). Раньше здесь был «goto к базе», но goto — команда тела, а не навык: runSkill('goto')
    // падал «fn is not a function» (хардкор-стенд 04.11, 9 раз), а точка базы без «База:» была зашита (-393 67 36) — сотни блоков от мухи.
    const opts = lowHpAgainstPlayer ? ['shelter', 'escape'] : (canFight ? ['fight', 'escape'] : ['escape', 'shelter']);
    const skill = lowHpAgainstPlayer ? (hasBlocks ? 'shelter' : 'escape') : (canFight ? 'fight' : 'escape');
    const params = lowHpAgainstPlayer && hasBlocks ? { mode: 'walls' } : {};
    const whyText = lowHpAgainstPlayer ? `игрок ${name} бьёт, HP ${Math.round(bot.health)} — ухожу от игрока ${hasBlocks ? 'в укрытие (стены)' : 'бегом (блоков на укрытие нет)'}` : `игрок ${name} ударил — ухожу: ${bot.health < T.playerFightHp ? `HP ${Math.round(bot.health)}` : others ? `рядом ещё враги (${others})` : 'нет оружия'}`;
    const plan = canFight
      ? { skill: 'fight', params: { target: low, radius: AG.CHASE_MAX, flee_hp: T.playerFleeHp, timeout: T.playerFightTimeout }, why: `игрок ${name} ударил`, options: opts }
      : { skill: skill, params: params, why: whyText, options: opts };
    ctx.events.push('info', { msg: `рефлекс: утечки от игрока (sprint_away/zigzag к укрытию/базе): ${plan.why}`, reflex: true });
    await startDefense(ctx, plan);
  });

  // ---- Самооборона от моба ----
  api.handle('mob_hurt', async ({ att, source, cause, sure, what }) => {
    if (RX) { if (att && !isAutoTarget(att) && att === source) return; await RX.onHit(ctx, 'mob', { att }); return; } // этап 2: ответ выбирает муха
    // указалки: сталагмит под ногами или упавший сталактит (what: 'сталактит') — уходим с места, не бой
    if (cause === 'сталагмит' || cause === 'сталактит' || what === 'сталактит') {
      const plan = { skill: 'escape', params: {}, why: what === 'сталактит' || cause === 'сталактит' ? 'урон от упавшего сталактита — ухожу из-под свода' : 'урон от сталагмита', options: ['escape', 'shelter'] };
      ctx.events.push('info', { msg: `рефлекс: escape (${plan.why})`, reflex: true });
      await startDefense(ctx, plan);
      return;
    }
    if (att && !isAutoTarget(att) && att === source) return; // эндермен, голем и т.п. — не трогаем
    const plan = mobHurtPlan(ctx, att);
    if (!plan) return;
    // обидчик угадан (sure:false — сервер не назвал, взят ближайший моб): в бой с догадкой не лезем — уходим
    if (sure === false && plan.skill === 'fight') {
      plan.skill = 'escape'; plan.params = {}; plan.why += '; обидчик не точно известен — ухожу, не дерусь';
      if (!plan.options.includes('escape')) plan.options.unshift('escape');
    }
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

  // ---- Новый: проактивная защита от сближающегося моба (ДО удара) ----
  // Проверяем каждые 2 с: есть ли hostile моб рядом, ближе ли он порога действия,
  // и если тело занято задачей — прерываем её и запускаем защиту.
  // Это покрывает случаи: крипер идёт к испуганной мухе, зомби подходит во время сбора,
  // муха стоит в пещере и не двигается — рефлекс выбирает escape/shelter.
  (async () => {
    let lastCheck = 0;
    api.every(2000, async () => {
      const now = Date.now();
      if (now - lastCheck < 1500) return; // мини- débounce
      lastCheck = now;
      try { scanEscapes(ctx); } catch (e) {} // итоги побегов: fled:false → ctx.escapeFail
      if (RX) return; // этап 2: «моб вплотную», крипер, стрелок — рефлексы hardcore/reflexes.js
      if (ctx.manualControl) return;
      const bot = ctx.bot;
      if (!bot.entity || !bot.entity.position) return;
      const cur0 = ctx.tasks.current;
      if (cur0 && ['fight', 'defend', 'escape', 'shelter'].includes(cur0.name)) return;
      if (inShelter(ctx)) return; // L043: в укрытии стоим — побег вытащил бы в открытое место
      const p = bot.entity.position;
      // Находим ближайшего hostile моба
      const hostiles = Object.values(bot.entities).filter(
        e => e && e !== bot.entity && isHostile(e)
      );
      if (hostiles.length === 0) return;
      hostiles.sort((a, b) => F.posOf(a).distanceTo(p) - F.posOf(b).distanceTo(p));
      const nearest = hostiles[0];
      const dist = F.posOf(nearest).distanceTo(p);
      const isCreeper = nearest.name === 'creeper';
      const isProtectedTask = cur0 && ['collect', 'gather_list', 'craft', 'build_blueprint'].includes(cur0.name) ||
        (cur0 && cur0.name === 'goto' && (cur0.params && (cur0.params.label || cur0.params.priority)));
      const threshold = isProtectedTask 
        ? (isCreeper ? 5 : T.defenseCloseDist) 
        : (isCreeper ? T.creeperInterruptDist : T.reflexInterruptDist);
      // behavior_reflexes_escape_skeleton_lowhp: HP < apLowHp и стрелок ближе rangedLowHpDist — уходим из-под стрел,
      // не ждём 6 м; после неудачного побега (задача кончилась) следующий тик — снова побег другим стилем
      const ranged = rangedLowHpPlan(ctx, hostiles);
      if (ranged) {
        if (bannedActions(ctx).escape) return;
        if (cur0 && typeof ctx.tasks.stop === 'function') { try { await ctx.tasks.stop('стрелок, мало HP — рефлекс прерывает'); } catch (e) {} }
        ctx.events.push('info', { msg: `рефлекс: escape (${ranged.why})`, reflex: true, action: 'escape', dist: ranged.dist, mob: ranged.mob });
        await startDefense(ctx, { skill: 'escape', params: ranged.params, why: ranged.why, mob: ranged.mob, options: ['escape', 'shelter'] });
        return;
      }
      if (dist > threshold) return;
      // Если моб дальше порога защитного действия — не трогаем
      if (dist > T.defenseFightDist) return;
      const plan = mobNearPlan(ctx, nearest, dist);
      const { skill, params, why, mob } = plan;
      if (bannedActions(ctx)[skill]) return; // это действие только что не вышло — не повторяем его каждые 2 с
      // Прерываем текущую задачу тела (если есть), чтобы сделать место защите
      const curTask = ctx.tasks.current;
      if (curTask && typeof ctx.tasks.stop === 'function') {
        try { await ctx.tasks.stop('моб сближается — рефлекс прерывает'); } catch (e) {}
      }
      ctx.events.push('info', { msg: `рефлекс: ${skill} (${why})`, reflex: true, action: skill, dist, mob: nearest.name });
      // Запускаем защиту с force:true, чтобы перебить чужую работу
      await startDefense(ctx, { skill, params, why, mob, options: [skill] });
    });
  })();

  // ---- Респаун ночью среди мобов: голыми руками не воевать, сразу укрыться (иначе — смерть по кругу на спавне) ----
  api.on(bot, 'spawn', () => {
    api.after(T.respawnDelayMs, () => {
      if (RX) return; // этап 2: ожила ночью среди мобов — не рефлекс, ночь решают дела общего списка и рефлексы опасности
      if (!ctx.ready || bot.health <= 0) return;
      if (!timeInfo(bot).isNight || hasWeapon(bot) || hostilesNear(bot, T.respawnHostilesR) === 0) return;
      const cur = ctx.tasks.current;
      if (cur && ['shelter', 'escape'].includes(cur.name)) return;
      const ch = E.choose(ctx, ['shelter', 'escape']);
      startDefense(ctx, { skill: ch.action, params: {}, why: ch.why, options: ['shelter', 'escape'] }).catch(() => {});
    }, 'респаун ночью');
  });

  if (RX) RX.attach(api, { startDefense, inShelter }); // этап 2: рефлексы опасности — свой опрос 0.5 с

  // при выгрузке версии — отпустить «прыжок», если держали его сами
  return { detach() {
    detached = true;
    if (swimJump) { try { bot.setControlState('jump', false); } catch (e) {} swimJump = false; }
    try { dripOff(); } catch (e) {} // новая версия поведения поставит свою
  } };
}

module.exports = { noteEscapeFail, escapeFailed, scanEscapes, attach, mobHurtPlan, mobNearPlan, rangedLowHpPlan, defensePrior, pickFood, needsEat, dripstoneCost, FOOD_BLACKLIST, hasWeapon, hostilesNear,
  isDrowning, blockOverhead, findAirCell, rescuePlan, busyInfo, failState, bannedActions, noteRefusal, clearRefusal, startDefense, inShelter, attackerDist, shelterTooSlow, outlookOf };
