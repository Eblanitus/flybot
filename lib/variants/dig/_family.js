// Семейство dig: как подойти к блоку, чтобы его сломать (collect — на каждый блок, dig_at). Попытку запускает _core.approach:
// выбор варианта, подход, оценка, запись. Итог варианта: { reach } — расстояние от глаз до блока после подхода.
'use strict';

const label = 'подход к блоку';
const prior = ['look', 'near'];

const lvl = sit => (sit.dy > 1 ? 'above' : sit.dy < -1 ? 'below' : 'level');
function sitKeys(sit) {
  return [`${sit.blockKind}|${sit.place}|${lvl(sit)}`, `${sit.blockKind}|${lvl(sit)}`, sit.blockKind, '*'];
}

// Оценка [0,1]: дотянулась — от 0.6 (быстрее — лучше), нет — 0
function score({ result, error, ms }) {
  if (error || !result || !result.reached) return { ok: false, score: 0 };
  return { ok: true, score: 0.6 + 0.4 * Math.max(0, 1 - (ms || 0) / 20000) };
}

module.exports = { label, prior, sitKeys, score };
