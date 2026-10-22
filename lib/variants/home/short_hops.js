// short_hops: короткие скачки по ~24 блока — горы, пещеры, лес: pathfinder чаще находит короткий путь. Сытость низкая — без спринта.
'use strict';
const C = require('./_core');
module.exports = {
  name: 'short_hops', family: 'home',
  desc: 'короткие скачки по ~24 блока (горы, пещеры, густой лес); голодной — без спринта',
  applies: () => true,
  run: (ctx, t, p) => C.travel(ctx, t, p, { leg: 24, sprint: (ctx.bot.food == null ? 20 : ctx.bot.food) > 6, hops: 36 })
};
