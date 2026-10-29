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
// behavior_reflexes_escape_skeleton_lowhp: при HP < apLowHp (или под землёй) от стрелка к базе не бежим — escape_to_base
// это длинная дорога под стрелами по открытому месту (смерть 20261023-191254-90); берём укрытие от линии огня/рывок.
// Других вариантов нет — прежний выбор (лучше уйти к базе, чем стоять).
function chooseVariant(ctx, family, sit, opts = {}) {
  const V = L('variants');
  if (family === 'escape' && sit && (sit.ranged || sit.target === 'skeleton') && ((sit.hpNum != null && sit.hpNum < require('./thresholds').apLowHp) || sit.place === 'underground')) {
    const exclude = new Set(opts.exclude || []); exclude.add('escape_to_base');
    const ch = V.choose(ctx, family, sit, { ...opts, exclude });
    if (ch) return ch;
  }
  return V.choose(ctx, family, sit, opts);
}

module.exports = { chooseMelee, chooseVariant };
