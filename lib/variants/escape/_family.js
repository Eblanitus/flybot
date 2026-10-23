// Семейство escape: оторваться от врага (бегство/отход). Вызывается из escape (lib/skills/combat.js), до укрытия.
// run(ctx, t, p, sit) варианта: p.vector — куда бежать (от врагов, fleeVector), p.distance — на сколько.
// Итог: { moved, d0, d1, gain, away, high?, foes0?, foes1? } (_core.measure): away — враг отстал (или не достаёт).
'use strict';

const label = 'бегство';
const prior = ['cave_escape', 'wall_escape', 'cover_escape', 'sprint_away', 'zigzag', 'pillar'];

const foe = sit => (sit.pvp ? 'player' : sit.target || 'none');
function sitKeys(sit) {
  return [`${foe(sit)}|${sit.expKey || sit.key}`, `${foe(sit)}|${sit.hp}`, foe(sit), '*'];
}

// Оценка [0,1]: оторвался — от 0.5 (больше отрыв и меньше потерянного HP — лучше); нет — почти ноль
function score({ result, error, hp0, hp1 }) {
  if (error || !result) return { ok: false, score: 0 };
  const lost = Math.max(0, (hp0 || 0) - (hp1 || 0)), hpK = 1 - Math.min(lost, 10) / 10;
  if (!result.away) return { ok: false, score: 0.1 * hpK };
  return { ok: true, score: 0.5 + 0.3 * Math.min(Math.max(result.gain || 0, 0), 16) / 16 + 0.2 * hpK };
}

// Дополнительная информация для лога: почему выбран этот вариант
function logInfo({ result, variant, sit }) {
  if (!result) return '';
  const why = result.variant === 'pillar' && sit.rangedNearby ? ' (но был стрелок рядом — pillar не выбирается)' : '';
  const ranged = sit.rangedNearby ? ' стрелок рядом' : '';
  const target = sit.target ? ` цель:${sit.target}` : '';
  return `${variant}: away=${result.away} gain=${result.gain} d0=${result.d0} d1=${result.d1}${target}${ranged}${why}`;
}

module.exports = { label, prior, sitKeys, score, logInfo };
