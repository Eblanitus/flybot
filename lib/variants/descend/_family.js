// Семейство descend: спуститься на высоту (навык descend, lib/skills/move.js). p: { y0, ty }. Итог: heightResult.
'use strict';
const label = 'спуск';
const prior = ['path', 'stairs'];
const band = sit => (sit.drop > 8 ? 'deep' : 'low');
const sitKeys = sit => [`${sit.place}|${band(sit)}|${sit.cliff ? 'cliff' : 'flat'}`, `${sit.place}|${band(sit)}`, sit.place, '*'];
const score = info => require('../../skills/move').heightScore(info);
module.exports = { label, prior, sitKeys, score };
