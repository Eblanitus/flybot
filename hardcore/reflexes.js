// Рефлексы мухи (этап 2, решение хозяина 05.11): «рефлекс от навыка отличается приоритетом … оставить ей свойство мгновенности.
// Но какой из вариантов рефлекса врубается — это уже в очках». И: то, что не мгновенно и не так необходимо, — не рефлекс, а навык.
//
// Рефлекс = срабатывание + варианты ответа.
//   — Срабатывание мгновенное и главнее любого дела: тело бросает дело (force) и делает ответ. Пороги «мало здоровья»,
//     «моб вплотную», «крипер рядом», «стрелок» муха выбирает сама раз за жизнь — тоже по очкам (ключ rxth:<рефлекс>:<порог>).
//   — Какой ответ — выбирает муха тем же решателем, что и дела (hardcore/decider.js pickOption): ключ rx:<рефлекс>:<ответ>,
//     опыт — общая таблица решателя (итоги матчей), пробы — как у дел. Порядок ответов в списке — только подсказка
//     для холодного старта (старое правило первым), опыт её перебивает.
// Рефлексы (9): мало здоровья, ударил моб, ударила муха, моб вплотную, крипер рядом, стрелок, тону, лава/огонь, застряла в блоке.
// Не рефлексы (стали делами общего списка, без прерывания): поесть, поиск еды, взять меч, ночная защита, ожила ночью среди мобов,
// выплыть к суше, домой, блоки на укрытие и прочие правила автопилота — collectRules ниже и skillCands (поесть).
// Плавание (держать прыжок в воде) и автоброня — не выбор, а «дыхание»: остаются в behavior/reflexes.js как были.
//
// Включается только у учащихся мух этапа 2: fly.js ставит HC_REFLEX = путь к этому файлу (контроль — старый код целиком).
// Чистые части (без mineflayer) проверяет test/hardcore_reflexes.js.
'use strict';
const D = require('./decider');

// ---------- пороги, которые муха учит сама (раз за жизнь) ----------
// первый в списке — прежнее правило (подсказка), остальные — пробы
const THRESHOLDS = {
  low_hp: [10, 4, 6, 8, 14],      // здоровье ниже — рефлекс «мало здоровья» (прежнее apLowHp 10)
  mob_close: [6, 2, 4, 10],       // моб ближе — «моб вплотную» (прежнее reflexInterruptDist 6)
  creeper: [8, 4, 6, 12],         // крипер ближе (прежнее creeperInterruptDist 8)
  ranged: [16, 8, 12, 24]         // стрелок ближе и по муху недавно били (прежнее rangedLowHpDist 16)
};
const LIFE_SIT = { key: 'life', coarse: 'life' };   // порог выбирается раз за жизнь — обстановка одна на всех

// ---------- ответы ----------
// do(f, info) → { skill, params } | { inline: 'swat'|'eat' } | null (ничего не делать, продолжать своё)
// can(f, info) — есть ли чем (блоки на столб, еда, цель для боя). Это не запрет за муху, а «нечем»: без блоков столб не встанет.
const ESC = (style, extra) => ({ id: 'escape_' + style, ru: { sprint_away: 'бежать', zigzag: 'бежать зигзагом', cover_escape: 'за укрытие от стрел', wall_escape: 'стена и бежать', pillar: 'столб и бежать' }[style] || style,
  can: style === 'wall_escape' || style === 'pillar' ? f => f.blocks >= 3 : null,
  do: () => ({ skill: 'escape', params: { style, distance: 24, ...(extra || {}) } }) });
const WALLS = { id: 'walls', ru: 'стены вокруг', can: f => f.blocks >= 4 && !f.inWater, do: () => ({ skill: 'shelter', params: { mode: 'walls' } }) };
const DIG = { id: 'dig_in', ru: 'закопаться', can: f => !f.inWater, do: () => ({ skill: 'shelter', params: { mode: 'dig' } }) };
const PILLAR = { id: 'pillar', ru: 'столб вверх', can: f => f.blocks >= 3 && !f.inWater, do: () => ({ skill: 'pillar_up', params: { height: 3 } }) };
const EAT = { id: 'eat', ru: 'поесть', can: f => f.hasFood && f.food < 20, do: () => ({ skill: 'eat', params: { desperate: true, count: 2 } }) };
const STEP = { id: 'step_aside', ru: 'отойти в сторону', do: () => ({ skill: 'explore', params: { distance: 8 } }) };
// подсказка, как прежнее правило: с оружием и здоровьем — драться первым, иначе бежать первым
const armedFirst = f => (f.hasWeapon && f.hp >= 10 ? 'fight' : 'escape_sprint_away');
const KEEP = { id: 'keep_going', ru: 'не отвлекаться', do: () => null };
const SWAT = { id: 'swat', ru: 'отмахнуться и дальше', can: (f, i) => !!(i && i.mob && i.mob.d != null && i.mob.d <= 3.2), do: () => ({ inline: 'swat' }) };
const fightMob = { id: 'fight', ru: 'драться', can: (f, i) => !!(i && i.mob && i.mob.id != null), do: (f, i) => ({ skill: 'fight', params: { targetId: i.mob.id, radius: 12 } }) };
const fightFly = { id: 'fight', ru: 'драться', can: (f, i) => !!(i && i.player), do: (f, i) => ({ skill: 'fight', params: { target: String(i.player).toLowerCase(), radius: 16, flee_hp: 6, timeout: 40 } }) };

// prio: меньше — главнее. Идущий ответ рефлекса не перебивает рефлекс с тем же или меньшим приоритетом.
// cool — через сколько мс тот же рефлекс снова может сработать; coolKeep — если муха выбрала «не отвлекаться»
const REFLEXES = [
  { id: 'lava', ru: 'лава или горю', prio: 0, cool: 3000, coolKeep: 3000,
    when: f => (f.inLava || f.onFire ? {} : null),
    variants: [ESC('sprint_away'), { id: 'to_water', ru: 'к воде', can: f => !!f.water, do: f => ({ skill: 'swim_to', params: { x: f.water.x, y: f.water.y, z: f.water.z, sprint: 1 } }) },
      { id: 'jump_out', ru: 'выпрыгнуть в сторону', do: () => ({ skill: 'explore', params: { distance: 6 } }) }, PILLAR] },
  { id: 'stuck_block', ru: 'застряла в блоке', prio: 1, cool: 3000, coolKeep: 3000,
    when: f => (f.suffocating ? {} : null),
    variants: [{ id: 'dig_head', ru: 'ломать блок у головы', do: f => ({ skill: 'dig_at', params: { x: f.pos.x, y: f.pos.y + 1, z: f.pos.z } }) },
      { id: 'dig_up', ru: 'копать вверх', do: f => ({ skill: 'dig_at', params: { x: f.pos.x, y: f.pos.y + 2, z: f.pos.z } }) },
      { id: 'walk_out', ru: 'выйти в сторону', do: () => ({ skill: 'explore', params: { distance: 4 } }) }] },
  { id: 'low_hp', ru: 'мало здоровья', prio: 2, cool: 10000, coolKeep: 20000, th: 'low_hp',
    when: (f, th) => (f.hp > 0 && f.hp < th ? { mob: f.nearest } : null),
    variants: [ESC('sprint_away'), WALLS, EAT, DIG, ESC('zigzag'), PILLAR, fightMob, STEP, KEEP] },
  { id: 'hit_fly', ru: 'ударила муха', prio: 3, cool: 2000, coolKeep: 6000, first: armedFirst,
    variants: [fightFly, ESC('sprint_away'), ESC('zigzag'), WALLS, PILLAR, KEEP] },
  { id: 'hit_mob', ru: 'ударил моб', prio: 4, cool: 2000, coolKeep: 6000, first: armedFirst,
    variants: [ESC('sprint_away'), fightMob, SWAT, WALLS, ESC('zigzag'), PILLAR, DIG, KEEP] },
  { id: 'creeper', ru: 'крипер рядом', prio: 5, cool: 4000, coolKeep: 10000, th: 'creeper',
    when: (f, th) => (f.creeper && f.creeper.d <= th ? { mob: f.creeper } : null),
    variants: [ESC('sprint_away'), fightMob, ESC('wall_escape'), PILLAR, ESC('zigzag'), KEEP] },
  { id: 'ranged', ru: 'стреляет скелет', prio: 6, cool: 4000, coolKeep: 12000, th: 'ranged',
    when: (f, th) => (f.ranged && f.ranged.d <= th && f.hitRecent ? { mob: f.ranged } : null),
    variants: [ESC('cover_escape'), ESC('sprint_away'), fightMob, WALLS, ESC('zigzag'), KEEP] },
  { id: 'mob_close', ru: 'моб вплотную', prio: 7, cool: 4000, coolKeep: 12000, th: 'mob_close', first: armedFirst,
    when: (f, th) => (f.nearest && f.nearest.name !== 'creeper' && f.nearest.d <= th ? { mob: f.nearest } : null),
    variants: [fightMob, ESC('sprint_away'), WALLS, SWAT, PILLAR, ESC('zigzag'), KEEP] },
  // тону — срабатывание остаётся в behavior/reflexes.js (детектор «голова под водой и не всплываю»), ответ — отсюда (drownStart)
  { id: 'drown', ru: 'тону', prio: 1, cool: 0, coolKeep: 0,
    variants: [{ id: 'swim_air', ru: 'плыть к воздуху', start: {} }, { id: 'dig_up', ru: 'ломать над головой', start: { skipSwim: true } },
      { id: 'place_under', ru: 'блок под ноги', can: f => f.blocks >= 1, start: { skipSwim: true, stuck: true } }] }
];
const BY_ID = Object.fromEntries(REFLEXES.map(r => [r.id, r]));
const STATE_ORDER = ['lava', 'stuck_block', 'low_hp', 'creeper', 'ranged', 'mob_close'];   // проверяются каждые 0.5 с

// ---------- чистые части ----------
const rateOf = st => (process.env.HC_EXPLORE === '0' ? 0 : D.exploreRate(D.runsIn(st)));
// порог рефлекса на эту жизнь: варианты rxth:<id>:<значение>, первый — прежнее правило
function pickThreshold(id, mem, { rnd = Math.random } = {}) {
  const vals = THRESHOLDS[id];
  const st = D.statsFor(mem, LIFE_SIT);
  const opts = vals.map((v, i) => ({ key: `rxth:${id}:${v}`, prior: i === 0 ? 0.9 : 0.5, act: v }));
  const ch = D.pickOption(opts, st, { rate: rateOf(st), rnd });
  return { value: ch.act, key: ch.key, explore: ch.explore, why: ch.why };
}
// что из состояния f срабатывает первым (по порядку срочности); th(id) — порог
function firstTrigger(f, th, skip = () => false) {
  for (const id of STATE_ORDER) {
    const R = BY_ID[id];
    if (skip(R)) continue;
    const info = R.when(f, R.th ? th(R.th) : null);
    if (info) return { R, info };
  }
  return null;
}
// ответ рефлекса: варианты, которые есть чем сделать; подсказка — порядок в списке (0.9, 0.8, …)
function pickVariant(R, f, info, st, { rnd = Math.random, rate } = {}) {
  let vs = R.variants.filter(v => !v.can || v.can(f, info));
  if (!vs.length) return null;
  const lead = R.first ? R.first(f) : null;   // подсказка от обстановки: этот ответ — первым
  if (lead && vs.some(v => v.id === lead)) vs = [vs.find(v => v.id === lead), ...vs.filter(v => v.id !== lead)];
  const opts = vs.map((v, i) => ({ key: `rx:${R.id}:${v.id}`, prior: Math.max(0.05, 0.9 - 0.1 * i), act: v }));
  return D.pickOption(opts, st, { rate: rate == null ? rateOf(st) : rate, rnd });
}
// обстановка для таблицы решателя — как у дел (decider.sitOf), из ощущений тела
function sitOfFeel(f) {
  return D.sitOf({ isNight: f.isNight, sheltered: f.sheltered, underground: f.underground, hp: f.hp, tools: { pickaxe: f.pickaxe },
    enemies: f.flyNear ? [1] : [], hostilesNear: f.hostilesNear }, f.biome);
}

// ---------- не рефлексы: правила автопилота — дела общего списка ----------
// decide() автопилота возвращает первое сработавшее правило раньше списка дел. Здесь правила собираются по очереди
// (сработавшее помечается занятым, decide зовётся снова), пока decide не дойдёт до общего списка (out.cands).
// Каждое правило — дело в списке с подсказкой по прежнему порядку; прерывать идущее дело (preempt) правило больше не может.
// Срочное «враг рядом» (out.urgent, выбор по очкам уже был) не трогаем.
function collectRules(decide, st, first, out, max = 16) {
  if (!first || out.cands || out.urgent) return first;
  const rules = [];
  const blocked = { ...(st.blocked || {}) };
  let a = first, o = out;
  while (a && !o.cands && !o.urgent && rules.length < max && !rules.some(r => r.key === a.key)) {
    rules.push(a); blocked[a.key] = true;
    o = {}; a = decide({ ...st, blocked }, o);
  }
  const calm = r => { const c = { ...r, rule: true }; delete c.preempt; return c; };
  const cands = rules.map((r, i) => ({ score: Math.max(5, 95 - 4 * i), act: calm(r) }));
  if (o.urgent) for (const u of o.urgent) cands.push({ score: 40, act: calm(u) });
  if (o.cands) cands.push(...o.cands);
  out.cands = cands;
  return cands[0].act;
}
// поесть — дело общего списка (раньше автоеда-рефлекс): лучшее или что есть (гнилое тоже)
function skillCands(st) {
  if (!(st.hasFood && st.food != null && st.food < 20)) return [];
  const want = st.food <= 14 ? 70 : st.food < 18 && st.hp < 20 ? 50 : 10;   // подсказка — прежняя автоеда (≤14, или ранена и не лечится)
  return [
    { score: want, act: { key: 'eat_best', kind: 'body', name: 'eat', params: { count: 2 }, why: `поесть (сытость ${st.food})` } },
    { score: Math.round(want / 3), act: { key: 'eat_any', kind: 'body', name: 'eat', params: { desperate: true, count: 2 }, why: `поесть что есть, гнилое тоже (сытость ${st.food})` } }
  ];
}

// ---------- живая часть ----------
let U, F, P, A;
const libs = () => { if (!U) { U = require('../lib/util'); F = require('../lib/felt'); P = require('../lib/perception'); A = require('../lib/actions'); } };
const TH = {};
function threshold(ctx, id) {
  if (TH[id] != null) return TH[id];
  const ch = pickThreshold(id, D.memory());
  TH[id] = ch.value;
  ctx.events.push('deed_start', { key: ch.key, name: 'порог ' + id, sit: LIFE_SIT.key, coarse: LIFE_SIT.coarse, explore: !!ch.explore });
  ctx.events.push('info', { msg: `рефлекс «${BY_ID[id].ru}»: порог на эту жизнь ${ch.value} — ${ch.why}`, reflex: true });
  return TH[id];
}
const FOOD_BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']);
function feel(ctx, extra = {}) {
  libs();
  const bot = ctx.bot, p = bot.entity.position;
  const mobs = Object.values(bot.entities || {}).filter(e => e && e !== bot.entity && U.isHostile(e) && F.posOf(e))
    .map(e => ({ id: e.id, name: U.entName(e), d: Math.round(F.posOf(e).distanceTo(p) * 10) / 10, e })).sort((a, b) => a.d - b.d);
  const items = bot.inventory.items();
  const foods = (bot.registry && bot.registry.foodsByName) || {};
  const at = dy => bot.blockAt(p.offset(0, dy, 0));
  const feet = at(0), head = at(1.6);
  const pick = items.map(i => i.name).filter(n => n.endsWith('_pickaxe'));
  const rank = n => (/^(iron|diamond|netherite|golden)_/.test(n) ? 3 : /^stone_/.test(n) ? 2 : 1);
  const prefix = process.env.HC_BR_PREFIX;
  let water = null;
  try {
    const w = bot.registry.blocksByName.water;
    const b = w && bot.findBlock({ matching: w.id, maxDistance: 12 });
    if (b) water = { x: b.position.x, y: b.position.y, z: b.position.z };
  } catch (e) {}
  let biome = 'unknown'; try { biome = D.biomeOf(bot); } catch (e) {}
  return {
    hp: bot.health, food: bot.food, isNight: !!P.timeInfo(bot).isNight, pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    hostilesNear: mobs.filter(m => m.d <= 10).length, nearest: mobs[0] || null,
    creeper: mobs.find(m => m.name === 'creeper') || null, ranged: mobs.find(m => F.RANGED.has(m.name)) || null,
    flyNear: !!prefix && Object.values(bot.players || {}).some(pl => pl.username !== bot.username && pl.username.startsWith(prefix) && pl.entity && pl.entity.position.distanceTo(p) < 24),
    blocks: items.filter(i => U.isBuildBlock(i.name) && !i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0),
    hasFood: items.some(i => foods[i.name] && !FOOD_BAD.has(i.name)),
    hasWeapon: items.some(i => /_(sword|axe)$/.test(i.name)),
    pickaxe: pick.length ? Math.max(...pick.map(rank)) : 0,
    inWater: !!(feet && feet.name === 'water') || !!(head && head.name === 'water'),
    inLava: [feet, head].some(b => b && b.name === 'lava'),
    onFire: (v => typeof v === 'number' && (v & 1) === 1)((bot.entity.metadata || [])[0]),
    suffocating: !!head && A.isSolid(head) && head.boundingBox === 'block',
    sheltered: H && H.inShelter ? !!H.inShelter(ctx) : !!ctx.sheltered, underground: false, hitRecent: !!(ctx.rxHitAt && Date.now() - ctx.rxHitAt < 6000),
    water, biome, ...extra
  };
}

// helpers из behavior/reflexes.js: startDefense (запуск ответа поверх дела, с отказом в журнал)
let H = null;
const COOL = {};
function busyWith(ctx) {   // ответ какого рефлекса сейчас идёт (задача тела от рефлекса), или null
  const cur = ctx.tasks && ctx.tasks.current;
  return cur && cur.source === 'reflex' && ctx.rx && ctx.rx.task === cur.name ? ctx.rx : null;
}
async function fire(ctx, id, info = {}, fIn) {
  const bot = ctx.bot;
  if (!ctx.ready || !bot || !bot.entity || bot.health <= 0 || ctx.manualControl) return null;
  const R = BY_ID[id], now = Date.now();
  if (!R) return null;
  const run = busyWith(ctx);
  if (run && BY_ID[run.id].prio <= R.prio) return null;     // идёт ответ рефлекса не младше — не дёргаем
  if ((COOL[id] || 0) > now) return null;
  const f = fIn || feel(ctx);
  const sit = sitOfFeel(f);
  const st = D.statsFor(D.memory(), sit);
  const ch = pickVariant(R, f, info, st);
  if (!ch) return null;
  const v = ch.act, plan = v.do ? v.do(f, info) : null;
  COOL[id] = now + (plan ? R.cool : R.coolKeep);
  ctx.events.push('deed_start', { key: ch.key, name: `рефлекс ${R.id}: ${v.id}`, sit: sit.key, coarse: sit.coarse, explore: !!ch.explore, reflex: true });
  const mob = info.mob ? `${info.mob.name} ${info.mob.d} м` : info.player ? `муха ${info.player}` : '';
  const why = `рефлекс «${R.ru}»${mob ? ` (${mob})` : ''}, HP ${Math.round(f.hp)}: ${v.ru} — ${ch.why}`;
  ctx.events.push('info', { msg: why, reflex: true, action: v.id, rx: R.id });
  if (!plan) return { id, variant: v.id };
  if (plan.inline === 'swat') {
    const e = info.mob && info.mob.e;
    if (e) bot.lookAt(F.posOf(e).offset(0, (e.height || 1.8) * 0.8, 0), true).then(() => bot.attack(e)).catch(() => {});
    return { id, variant: v.id };
  }
  ctx.rx = { id, task: plan.skill, t: now };
  if (H && H.startDefense) await H.startDefense(ctx, { skill: plan.skill, params: plan.params, why, mob: info.mob ? info.mob.name : null, options: [plan.skill] });
  else await ctx.runSkill(plan.skill, plan.params, { source: 'reflex', force: true });
  return { id, variant: v.id, skill: plan.skill };
}
// тону: детектор в behavior/reflexes.js спрашивает, с чего начать спасение (флаги rescuePlan)
function drownStart(ctx) {
  try {
    const R = BY_ID.drown, f = feel(ctx), sit = sitOfFeel(f);
    const ch = pickVariant(R, f, {}, D.statsFor(D.memory(), sit));
    if (!ch) return {};
    ctx.events.push('deed_start', { key: ch.key, name: `рефлекс drown: ${ch.act.id}`, sit: sit.key, coarse: sit.coarse, explore: !!ch.explore, reflex: true });
    ctx.events.push('info', { msg: `рефлекс «тону»: ${ch.act.ru} — ${ch.why}`, reflex: true, rx: 'drown' });
    return { ...ch.act.start };
  } catch (e) { return {}; }
}
// подключение из behavior/reflexes.js (только с HC_REFLEX): свой опрос состояния каждые 0.5 с
function attach(api, helpers) {
  H = helpers || null;
  const { ctx } = api;
  let busy = false;
  api.every(500, async () => {
    if (busy || !ctx.ready || !ctx.bot || !ctx.bot.entity || ctx.bot.health <= 0 || ctx.manualControl) return;
    busy = true;
    try {
      const f = feel(ctx);
      const run = busyWith(ctx), now = Date.now();
      const hit = firstTrigger(f, id => threshold(ctx, id), R => (COOL[R.id] || 0) > now || (run && BY_ID[run.id].prio <= R.prio));
      if (hit) await fire(ctx, hit.R.id, hit.info, f);
    } catch (e) { console.log('[reflex] опрос:', e && e.message); } finally { busy = false; }
  }, 'рефлексы мухи');
}
// удар: из обработчиков ядра (mob_hurt, player_attack) в behavior/reflexes.js
function onHit(ctx, kind, info) {
  ctx.rxHitAt = Date.now();
  if (kind === 'player') return fire(ctx, 'hit_fly', { player: info.name });
  libs();
  const att = info.att, bot = ctx.bot;
  const mob = att && F.posOf(att) ? { id: att.id, name: U.entName(att), d: Math.round(F.posOf(att).distanceTo(bot.entity.position) * 10) / 10, e: att } : null;
  return fire(ctx, 'hit_mob', { mob });
}
const _reset = () => { for (const k of Object.keys(TH)) delete TH[k]; for (const k of Object.keys(COOL)) delete COOL[k]; H = null; };

module.exports = { REFLEXES, BY_ID, THRESHOLDS, STATE_ORDER, pickThreshold, firstTrigger, pickVariant, sitOfFeel, collectRules, skillCands,
  feel, fire, onHit, drownStart, attach, threshold, _reset };
