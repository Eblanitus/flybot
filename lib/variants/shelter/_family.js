// Семейство shelter: укрыться (ночь, мало HP, враги). Вызывается из shelter (lib/skills/survival.js).
// run варианта = shelterImpl с режимом; итог { mode, placed }. Провал — SkillError («не до конца закрыто», «кончились блоки»).
'use strict';

const label = 'укрытие';
const prior = ['smart', 'dig', 'walls'];

// от точного к общему: время суток+место+враг рядом, место, всё
const near = sit => (sit.hostileNear ? 'foe' : 'calm');
function sitKeys(sit) {
  return [`${sit.phase}|${sit.place}|${near(sit)}`, `${sit.place}|${near(sit)}`, sit.place, '*'];
}

// Оценка [0,1]: закрылся — от 0.6 (быстрее и меньше блоков — лучше), нет — 0
function score({ result, error, ms }) {
  if (error || !result) return { ok: false, score: 0 };
  return { ok: true, score: 0.6 + 0.25 * Math.max(0, 1 - (ms || 0) / 20000) + 0.15 * Math.max(0, 1 - (result.placed || 0) / 12) };
}

module.exports = { label, prior, sitKeys, score };
