// Семейство climb: подняться на высоту (навык climb, lib/skills/move.js). p: { y0, ty }. Итог: heightResult (reached, went).
'use strict';
const label = 'подъём';
const prior = ['path', 'pillar'];
const band = sit => (sit.rise > 8 ? 'high' : 'low');
const sitKeys = sit => [`${sit.place}|${band(sit)}|${sit.water ? 'water' : 'dry'}`, `${sit.place}|${band(sit)}`, sit.place, '*'];
const score = info => require('../../skills/move').heightScore(info);
module.exports = { label, prior, sitKeys, score };
