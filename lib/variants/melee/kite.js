// kite: удар с предела досягаемости с коротким спринт-разбегом, на перезарядке — шаг назад (если безопасно).
'use strict';
const C = require('./_core');

module.exports = {
  name: 'kite', family: 'melee',
  desc: 'удар с предела + спринт-разбег, на перезарядке отход назад (базовое поведение)',
  applies: () => true,
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'kite' }, sit, {})
};
