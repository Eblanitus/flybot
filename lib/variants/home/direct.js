// direct: один путь сразу до цели (как было у go_home) — быстро, если дорога недлинная и простая.
'use strict';
const C = require('./_core');
module.exports = {
  name: 'direct', family: 'home',
  desc: 'один путь сразу до цели со спринтом (дорога недлинная)',
  applies: (ctx, sit) => sit.trip == null || sit.trip <= 160,
  run: (ctx, t, p) => C.travel(ctx, t, p, { leg: Infinity, sprint: true, hops: 3 })
};
