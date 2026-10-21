// Семейство melee: ближний бой с одной целью (схватка). Вызывается из fight/defend (lib/skills/combat.js) на каждую цель.
// run(ctx, t, p, sit) варианта возвращает итог _core.engage: { outcome, hits, dmg, ms, lastHit }.
'use strict';

const label = 'бой';
// порядок по умолчанию, пока опыта нет: первым — проверенное поведение
const prior = ['kite', 'wtap_combo', 'crit_jump', 'strafe', 'shield_counter', 'hit_and_run', 'pillar_fight'];

const tgt = sit => (sit.pvp ? 'player' : sit.target || 'none');
// от точного к общему: цель+обстановка опыта, цель+HP+броня, цель, всё
function sitKeys(sit) {
  return [`${tgt(sit)}|${sit.expKey || sit.key}`, `${tgt(sit)}|${sit.hp}|${sit.armor}`, tgt(sit), '*'];
}

// Оценка схватки в [0,1]: победа (меньше урона и быстрее — лучше); иначе мало, смерть/бегство — почти ноль
function score({ result, error }) {
  if (error || !result) return { ok: false, score: 0 };
  const dmgK = 1 - Math.min(result.dmg || 0, 10) / 10;
  switch (result.outcome) {
    case 'killed': return { ok: true, score: 0.55 + 0.35 * dmgK + 0.1 * Math.max(0, 1 - (result.ms || 0) / 20000) };
    case 'fled': return { ok: false, score: 0.05 };
    case 'gaveup': return { ok: false, score: 0.1 };
    case 'unreachable': return { ok: false, score: 0.15 };
    default: return { ok: false, score: (result.hits ? 0.2 : 0.05) + 0.15 * dmgK }; // lost/left/timeout
  }
}

module.exports = { label, prior, sitKeys, score };
