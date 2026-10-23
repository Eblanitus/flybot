// Выбор способа действия (поведение): какой вариант семейства взять — бой (melee: lib/variants/melee/*) и остальные
// семейства (escape, shelter, climb, descend, home, dig, place: lib/variants/<семейство>/*).
// Сейчас — бандит по опыту (data/variants.json: счёт каждого варианта по обстановке), у боя запасной — kite.
// Ядро зовёт chooseMelee / chooseVariant через хост; если поведения нет или оно упало — тот же выбор делает само.
'use strict';
const L = require('./core');

function chooseMelee(ctx, sit, { style, exclude } = {}) {
  const V = L('variants');
  exclude = exclude || new Set();
  return V.choose(ctx, 'melee', sit, { style, exclude }) ||
    (exclude.has('kite') ? null : { variant: V.family('melee').variants.get('kite'), name: 'kite', keys: V.keysFor(V.family('melee'), sit), why: 'запасной' });
}

// Д: остальные семейства — тот же выбор (style от мозга, иначе лучший по счёту в этой обстановке).
// Особые случаи — в вариантах семейства (lib/variants/<семейство>/*): встроенный escape_to_base
// перенесён туда (core_task 29181f0b08: из версий поведения ../lib не резолвился).
function chooseVariant(ctx, family, sit, opts = {}) {
  return L('variants').choose(ctx, family, sit, opts);
}

module.exports = { chooseMelee, chooseVariant };
