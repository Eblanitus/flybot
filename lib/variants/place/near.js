// near: встать в 1.5–3.5 блоках от точки (как было у place_at), не в самой точке.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
module.exports = {
  name: 'near', family: 'place',
  desc: 'встать в 1.5–3.5 блоках от точки',
  applies: () => true,
  async run(ctx, t, p) {
    const bot = ctx.bot, pos = p.pos;
    const goal = new goals.GoalCompositeAll([new goals.GoalNear(pos.x, pos.y, pos.z, 3.5), new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5))]);
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4 || A.blockHitsBot(bot, pos)) await A.goto(ctx, t, goal, { timeout: 60000 });
    return { stood: true };
  }
};
