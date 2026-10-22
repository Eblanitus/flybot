// hops: скачки по ~64 блока со спринтом (как было у goto базы) — надёжно на длинной дороге.
'use strict';
const C = require('./_core');
module.exports = {
  name: 'hops', family: 'home',
  desc: 'скачки по ~64 блока со спринтом',
  applies: () => true,
  run: (ctx, t, p) => C.travel(ctx, t, p, { leg: 64, sprint: true })
};
