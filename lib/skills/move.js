// Навыки: climb (подняться на высоту), descend (спуститься). Как — вариант семейства (lib/variants/climb|descend/*):
// style=auto|<имя>, auto — лучший по счёту в этой обстановке (data/variants.json). В итоге — variant, why, variants (счёт).
'use strict';
const { num, SkillError } = require('../util');
const V = require('../variants');

// Целевая высота: y (абсолютная) или height/depth (на сколько) от ног
function targetY(bot, p, up) {
  const y0 = Math.floor(bot.entity.position.y + 0.01);
  if (p.y != null && Number.isFinite(Number(p.y))) return { y0, ty: Math.floor(Number(p.y)) };
  const d = num(up ? p.height : p.depth, up ? 3 : 4, 1, 64);
  return { y0, ty: up ? y0 + d : y0 - d };
}

// Итог попытки подъёма/спуска: сколько прошли из нужного
function heightResult(bot, y0, ty, extra = {}) {
  const y1 = Math.floor(bot.entity.position.y + 0.01), wanted = Math.abs(ty - y0);
  const went = Math.max(0, ty > y0 ? y1 - y0 : y0 - y1);
  return { y0, y1, wanted, went, reached: went >= wanted, ...extra };
}

async function climb(ctx, t, p) {
  const bot = ctx.bot, style = V.checkStyle('climb', p.style);
  const { y0, ty } = targetY(bot, p, true);
  if (ty <= y0) throw new SkillError(`уже на высоте ${y0} (цель ${ty})`);
  return V.perform(ctx, t, 'climb', { ...p, y0, ty }, V.situation(ctx, null, { rise: ty - y0 }), { style });
}

async function descend(ctx, t, p) {
  const bot = ctx.bot, style = V.checkStyle('descend', p.style);
  const { y0, ty } = targetY(bot, p, false);
  if (ty >= y0) throw new SkillError(`уже на высоте ${y0} (цель ${ty})`);
  return V.perform(ctx, t, 'descend', { ...p, y0, ty }, V.situation(ctx, null, { drop: y0 - ty }), { style });
}

// Общая оценка подъёма/спуска [0,1]: дошла — от 0.6 (быстрее — лучше), нет — доля пройденного (до 0.3)
function heightScore({ result, error, ms }) {
  if (error || !result) return { ok: false, score: 0 };
  if (result.reached) return { ok: true, score: 0.6 + 0.4 * Math.max(0, 1 - (ms || 0) / 30000) };
  return { ok: false, score: 0.3 * (result.wanted ? result.went / result.wanted : 0) };
}

module.exports = { climb, descend, targetY, heightResult, heightScore };
