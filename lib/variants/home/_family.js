// Семейство home: дорога до точки далеко (база — goto автопилота/хозяина, lib/basegoal.js baseTravel; метка — go_home).
// p: { x, y, z, near, arrive, timeout(с) }. Итог _core.travel: { arrived, left, d0 }. Не дошла — SkillError.
'use strict';

const label = 'дорога домой';
const prior = ['up', 'hops', 'short_hops', 'direct', 'flat'];

const far = sit => (sit.trip > 200 ? 'far' : sit.trip > 64 ? 'mid' : 'near');
// цель выше на 8+ м («лезу из ямы», а не «иду по улице») — свой ключ счёта впереди (sit.rise из baseTravel)
const up = sit => (sit.rise != null && sit.rise >= 8 ? '|up' : '');
function sitKeys(sit) {
  return [...(up(sit) ? [`${sit.place}|${sit.phase}|${far(sit)}|up`] : []), `${sit.place}|${sit.phase}|${far(sit)}`, `${sit.place}|${far(sit)}`, sit.place, '*'];
}

// Оценка [0,1]: дошла — от 0.6 (быстрее, м/с — лучше), нет — 0
function score({ result, error, ms }) {
  if (error || !result || !result.arrived) return { ok: false, score: 0 };
  const speed = (result.d0 || 0) / Math.max((ms || 1) / 1000, 1); // м/с; спринт ~5.6
  return { ok: true, score: 0.6 + 0.4 * Math.min(speed / 5, 1) };
}

module.exports = { label, prior, sitKeys, score };
