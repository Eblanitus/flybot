// Семейство place: как встать, чтобы поставить блок в точку (place_at, lib/skills/build.js). Вариант только подходит;
// оценивает place_at после установки (V.judge): поставила — хорошо. p: { pos (Vec3), item }.
'use strict';

const label = 'установка блока';
const prior = ['near', 'close', 'pillar'];

const lvl = sit => (sit.dy > 3 ? 'high' : sit.dy < -3 ? 'low' : 'level');
function sitKeys(sit) {
  return [`${sit.place}|${lvl(sit)}`, lvl(sit), '*'];
}

// Оценка [0,1]: поставила — от 0.6 (быстрее — лучше), нет — 0
function score({ result, error, ms }) {
  if (error || !result || !result.placed) return { ok: false, score: 0 };
  return { ok: true, score: 0.6 + 0.4 * Math.max(0, 1 - (ms || 0) / 20000) };
}

module.exports = { label, prior, sitKeys, score };
