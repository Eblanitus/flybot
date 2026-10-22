// Общее семейства escape: ближайший враг (видимый враждебный моб или почувствованный обидчик), замер отрыва.
'use strict';
const { isHostile, r1 } = require('../../util');
const F = require('../../felt');
const AG = require('../../aggressors');

const MIN_GAIN = 3; // на столько метров враг должен отстать, чтобы побег считался удачным (как apEscapeMinDist)

// Расстояние до ближайшего врага (null — врагов в 32 м нет)
function foeDist(ctx) {
  const bot = ctx.bot, me = bot.entity.position;
  const felt = new Set(F.knownAttackers(ctx).map(e => e.id));
  let best = null;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    const foe = felt.has(e.id) || isHostile(e) || (e.type === 'player' && AG.isAggressorEntity(ctx, e));
    if (!foe) continue;
    const p = F.posOf(e) || e.position, d = p.distanceTo(me);
    if (d <= 32 && (best == null || d < best)) best = d;
  }
  return best;
}

// Замер до попытки -> функция, которая после попытки вернёт итог { moved, d0, d1, gain, away }
function measure(ctx) {
  const bot = ctx.bot, p0 = bot.entity.position.clone(), d0 = foeDist(ctx);
  return (extra = {}) => {
    const d1 = foeDist(ctx), moved = r1(bot.entity.position.distanceTo(p0));
    const gain = d0 != null && d1 != null ? r1(d1 - d0) : d1 == null ? 16 : 0;
    const away = extra.high != null ? !!extra.high : (d1 == null || (d0 != null && d1 >= d0 + MIN_GAIN));
    return { moved, d0: d0 == null ? null : r1(d0), d1: d1 == null ? null : r1(d1), gain, away, ...extra };
  };
}

// Единичный вектор бегства из p.vector (или null)
function unit(v) { if (!v) return null; const l = Math.hypot(v.x, v.z); return l ? { x: v.x / l, z: v.z / l } : null; }

module.exports = { MIN_GAIN, foeDist, measure, unit };
