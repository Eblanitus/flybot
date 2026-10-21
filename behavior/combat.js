// Выбор способа боя (поведение): какой вариант семейства melee (lib/variants/melee/*) взять на схватку.
// Сейчас — как было в lib/skills/combat.js: бандит по опыту (data/variants.json), иначе запасной kite.
// Ядро (combat.js) зовёт chooseMelee через хост; если поведения нет или оно упало — тот же выбор делает само.
'use strict';
const L = require('./core');

function chooseMelee(ctx, sit, { style, exclude } = {}) {
  const V = L('variants');
  exclude = exclude || new Set();
  return V.choose(ctx, 'melee', sit, { style, exclude }) ||
    (exclude.has('kite') ? null : { variant: V.family('melee').variants.get('kite'), name: 'kite', keys: V.keysFor(V.family('melee'), sit), why: 'запасной' });
}

module.exports = { chooseMelee };
