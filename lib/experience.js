// Опыт выживания: какие защитные действия (escape/shelter/fight/...) помогали в какой обстановке.
// Пишется сам по task_started защитных навыков (рефлекс, мозг, автопилот); итог через 30 с: жив/умер, изменение HP.
// data/experience.json. Рефлекс выбирает действие с лучшей долей выживания для похожей обстановки; мозг видит строку «опыт».
'use strict';
const fs = require('fs');
const path = require('path');
const { entName, isHostile } = require('./util');
const { timeInfo } = require('./perception');
const F = require('./felt');

const FILE = path.join(__dirname, '..', 'data', 'experience.json');
const DEFENSIVE = new Set(['escape', 'shelter', 'fight', 'defend', 'wait_night', 'sleep', 'night_mine', 'go_safe']);
const WINDOW_MS = 30000, REPLACED_MS = 5000, EXPLORE = 0.15, MIN_N = 3;
const TIERS = ['none', 'leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const FIELDS = ['phase', 'place', 'armor', 'weapon', 'hp', 'enemy', 'count'];
const WEIGHT = { phase: 3, place: 2, armor: 2, weapon: 1, hp: 1, enemy: 1, count: 1 };

function file(ctx) { return ctx.expFile || FILE; }
function load(ctx) {
  if (ctx.exp) return ctx.exp;
  let d = null; try { if (fs.existsSync(file(ctx))) d = JSON.parse(fs.readFileSync(file(ctx), 'utf8')); } catch (e) {}
  ctx.exp = { stats: (d && d.stats) || {}, recent: (d && d.recent) || [], pending: [], log: [] };
  return ctx.exp;
}
function save(ctx) {
  const x = load(ctx);
  try { fs.writeFileSync(file(ctx), JSON.stringify({ stats: x.stats, recent: x.recent.slice(-50) }, null, 1)); } catch (e) {}
}

function armorTier(bot) {
  let best = 0;
  for (const i of [5, 6, 7, 8]) { const it = bot.inventory.slots && bot.inventory.slots[i]; if (!it) continue; const k = TIERS.indexOf(String(it.name).split('_')[0]); best = Math.max(best, k < 0 ? 1 : k); }
  return TIERS[best];
}
function place(bot) {
  try { if (require('./skills/survival').isSheltered(bot)) return 'sheltered'; } catch (e) {}
  try { const b = bot.blockAt(bot.entity.position.offset(0, 1.6, 0)); if (b && b.skyLight != null && b.skyLight < 8) return 'underground'; } catch (e) {}
  return 'outdoors';
}
function countBucket(n) { return n === 0 ? '0' : n === 1 ? '1' : n <= 3 ? '2-3' : '4+'; }

// Обстановка сейчас: объект + ключ-строка
function situation(ctx) {
  const bot = ctx.bot, me = bot.entity.position;
  let near = null, nd = 16, n = 0;
  const seen = new Set();
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !isHostile(e)) continue;
    const d = F.distTo(bot, e); if (d > 16) continue;
    n++; seen.add(e.id); if (d < nd) { nd = d; near = e; }
  }
  for (const e of F.knownAttackers(ctx)) if (!seen.has(e.id)) { n++; if (!near) near = e; } // почувствованные, но далёкие/невидимые
  const hp = bot.health;
  const s = {
    phase: timeInfo(bot).isNight ? 'night' : 'day', place: place(bot), armor: armorTier(bot),
    weapon: bot.inventory.items().some(i => /_sword$|_axe$|_spear$|trident/.test(i.name)) ? 'weapon' : 'nowpn',
    hp: hp < 8 ? 'low' : hp < 14 ? 'mid' : 'high', enemy: near ? entName(near) : (F.recentHit(ctx) ? 'unseen' : 'none'), count: countBucket(n)
  };
  return { ...s, key: FIELDS.map(f => s[f]).join('|') };
}
function parseKey(k) { const a = k.split('|'); const o = {}; FIELDS.forEach((f, i) => { o[f] = a[i]; }); return o; }
function sim(a, b) { let s = 0, tot = 0; for (const f of FIELDS) { tot += WEIGHT[f]; if (a[f] === b[f]) s += WEIGHT[f]; } return s / tot; }

// Началось защитное действие
function start(ctx, action, source) {
  if (!ctx.bot || !ctx.bot.entity) return;
  const x = load(ctx), now = Date.now();
  for (const p of x.pending) if (!p.done && now - p.t0 < REPLACED_MS) p.replaced = true; // сменили почти сразу — не судить
  const s = situation(ctx);
  x.pending.push({ action, source, key: s.key, t0: now, hp0: ctx.bot.health });
  x.log.push({ action, source, key: s.key, t: now }); if (x.log.length > 20) x.log.shift();
}
function record(ctx, p, died) {
  const x = load(ctx); p.done = true;
  if (p.replaced && !died) return;
  const st = (x.stats[p.key] = x.stats[p.key] || {}), a = (st[p.action] = st[p.action] || { n: 0, survived: 0, died: 0, hp: 0 });
  a.n++; if (died) a.died++; else a.survived++;
  a.hp += Math.round(((died ? 0 : ctx.bot && ctx.bot.health != null ? ctx.bot.health : p.hp0) - p.hp0));
  x.recent.push({ t: new Date().toISOString().slice(0, 19), key: p.key, action: p.action, source: p.source, died: !!died });
  save(ctx);
}
// Раз в секунду: закрыть пробы старше 30 с как «выжил»
function tick(ctx) {
  const x = load(ctx), now = Date.now();
  for (const p of x.pending) if (!p.done && now - p.t0 >= WINDOW_MS) record(ctx, p, false);
  x.pending = x.pending.filter(p => !p.done);
}
// Смерть: все пробы окна — «умер»; вернуть ключ обстановки и последние действия для события death
function onDeath(ctx) {
  const x = load(ctx), now = Date.now();
  let key = null; try { key = situation(ctx).key; } catch (e) {}
  for (const p of x.pending) if (!p.done && now - p.t0 < WINDOW_MS + 5000) record(ctx, p, true);
  x.pending = [];
  const last = x.log.filter(l => now - l.t < 60000).slice(-5).map(l => `${l.action}(${l.source}) ${Math.round((now - l.t) / 1000)}с назад`);
  return { situation: key, lastActions: last };
}

// Оценки вариантов для обстановки s: точное совпадение весит больше всего, похожие — меньше
function scores(ctx, s, options) {
  const x = load(ctx), out = {};
  for (const o of options) out[o] = { n: 0, survived: 0, wn: 0, ws: 0 };
  for (const [k, st] of Object.entries(x.stats)) {
    const w = Math.pow(sim(s, parseKey(k)), 4); if (w < 0.05) continue;
    for (const o of options) {
      const a = st[o]; if (!a) continue;
      out[o].wn += w * a.n; out[o].ws += w * a.survived;
      if (k === s.key) { out[o].n += a.n; out[o].survived += a.survived; }
    }
  }
  for (const o of options) out[o].rate = (out[o].ws + 1) / (out[o].wn + 2);
  return out;
}
// Выбрать действие: лучшая доля выживания; prior (порядок options) — только при равенстве; мало данных — иногда пробуем
function choose(ctx, options, s = situation(ctx)) {
  if (options.length <= 1) return { action: options[0], why: 'единственный вариант' };
  const sc = scores(ctx, s, options), rnd = ctx.expRand || Math.random;
  const scarce = options.filter(o => sc[o].n < MIN_N);
  if (scarce.length && rnd() < EXPLORE) { const o = scarce[Math.floor(rnd() * scarce.length)]; return { action: o, why: 'пробую (мало опыта)', scores: sc }; }
  let best = options[0];
  options.forEach((o, i) => { if (sc[o].rate - i * 0.01 > sc[best].rate - options.indexOf(best) * 0.01) best = o; });
  return { action: best, why: `выживал ${sc[best].survived}/${sc[best].n} здесь`, scores: sc };
}

// Строка для мозга: «опыт сейчас: escape выжил 0/4, shelter 3/3»
function line(ctx) {
  const s = situation(ctx), x = load(ctx);
  let st = x.stats[s.key], tag = '';
  if (!st) { // нет точного — ближайшая обстановка с данными
    let bk = null, bs = 0; for (const k of Object.keys(x.stats)) { const v = sim(s, parseKey(k)); if (v > bs) { bs = v; bk = k; } }
    if (!bk || bs < 0.5) return null; st = x.stats[bk]; tag = ' (похожая: ' + bk + ')';
  }
  const parts = Object.entries(st).sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([a, v]) => `${a} выжил ${v.survived}/${v.n}`);
  return parts.length ? `опыт сейчас [${s.key}]${tag}: ${parts.join(', ')}` : null;
}
// Дополнить снимок для мозга
function decorate(ctx, snap) {
  try {
    if (!snap || !snap.ready) return snap;
    const l = line(ctx);
    if (snap.eyes) snap.eyes.experience = l;
    if (l && snap.summary) snap.summary += ' ' + l + '.';
  } catch (e) {}
  return snap;
}

// Подключить: ловим task_started защитных навыков на шине событий (один раз на ctx)
function attach(ctx, session) {
  load(ctx);
  if (!ctx.events._expHooked) {
    const push = ctx.events.push.bind(ctx.events);
    ctx.events.push = (type, data = {}) => {
      if (type === 'task_started' && DEFENSIVE.has(data.name) && data.source !== 'test') { try { start(ctx, data.name, data.source); } catch (e) {} }
      return push(type, data);
    };
    ctx.events._expHooked = true;
  }
  if (session) session.timers.push(setInterval(() => { try { tick(ctx); } catch (e) {} }, 1000));
}

module.exports = { attach, situation, start, tick, onDeath, choose, scores, line, decorate, DEFENSIVE, FILE };
