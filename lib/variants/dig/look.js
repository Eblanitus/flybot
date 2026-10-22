// look: подойти туда, откуда блок виден и достаётся (reach 4) — как было у collect.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
module.exports = {
  name: 'look', family: 'dig',
  desc: 'встать там, откуда блок виден и достаётся (reach 4)',
  applies: () => true,
  run: (ctx, t, p) => A.goto(ctx, t, new goals.GoalLookAtBlock(p.pos, ctx.bot.world, { reach: 4 }), { timeout: p.timeout || 45000 })
};
