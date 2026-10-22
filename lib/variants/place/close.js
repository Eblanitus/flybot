// close: встать вплотную к точке (1–2.5 блока) — тесное место, стена, край обрыва: издали грань не видна.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
module.exports = {
  name: 'close', family: 'place',
  desc: 'встать вплотную (1–2.5 блока): тесно, стена, край обрыва',
  applies: () => true,
  async run(ctx, t, p) {
    const bot = ctx.bot, pos = p.pos;
    const goal = new goals.GoalCompositeAll([new goals.GoalNear(pos.x, pos.y, pos.z, 2.5), new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1))]);
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 2.8 || A.blockHitsBot(bot, pos)) await A.goto(ctx, t, goal, { timeout: 60000 });
    return { stood: true };
  }
};
