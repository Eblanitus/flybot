// flat: идти по ровному — край (обрыв, спуск больше 4 уровней) обходить стороной, вниз не спускаться; обхода нет — отказ с причиной.
// Чем отличается от direct/hops/short_hops: те отвечают «как дойти», этот — «куда нельзя идти» (заявка 1029a35ad1).
'use strict';
const C = require('./_core');
module.exports = {
  name: 'flat', family: 'home',
  desc: 'по ровному: край обходит стороной, вниз больше 4 уровней не спускается (цель не ниже)',
  applies: (ctx, sit) => (sit.rise == null || sit.rise >= -4) && !C.pit(sit),
  run: (ctx, t, p) => C.travel(ctx, t, p, { leg: 24, sprint: (ctx.bot.food == null ? 20 : ctx.bot.food) > 6, hops: 36, flat: true })
};
