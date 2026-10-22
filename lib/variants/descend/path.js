// path: спуститься обходом (pathfinder: склоны, ступени, прыжки до 3 блоков), до 40 с.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');

module.exports = {
  name: 'path', family: 'descend',
  desc: 'спуститься обходом: склоны и ступени (pathfinder), до 40 с',
  applies: () => true,
  async run(ctx, t, p) {
    const M = require('../../skills/move');
    t.progress(`спускаюсь обходом до y=${p.ty}`);
    let err = null;
    try { await A.goto(ctx, t, new goals.GoalY(p.ty), { timeout: 40000 }); } catch (e) { if (e.aborted) throw e; err = e.message; }
    const r = M.heightResult(ctx.bot, p.y0, p.ty);
    if (!r.went) throw new SkillError('спуск обходом не вышел: ' + (err || 'не спустилась'), r);
    return err ? { ...r, note: err } : r;
  }
};
