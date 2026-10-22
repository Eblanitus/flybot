// pillar: точка высоко над головой (4+ блока) — подойти под неё и подняться столбом, чтобы дотянуться.
// Нужны блоки (не считая ставимого) и открытый верх; не в воде.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
module.exports = {
  name: 'pillar', family: 'place',
  desc: 'точка высоко (4+ блока): подойти и подняться столбом до неё',
  applies: (ctx, sit) => (sit.dy || 0) >= 4 && !sit.water && (sit.blocks || 0) >= (sit.dy || 0) - 1,
  async run(ctx, t, p) {
    const bot = ctx.bot, pos = p.pos;
    const goal = new goals.GoalCompositeAll([new goals.GoalNearXZ(pos.x, pos.z, 2), new goals.GoalInvert(new goals.GoalNearXZ(pos.x, pos.z, 0.9))]);
    try { await A.goto(ctx, t, goal, { timeout: 30000 }); } catch (e) { if (e.aborted) throw e; }
    const rise = pos.y - Math.floor(bot.entity.position.y) - 2;
    if (rise > 0) await require('../../skills/basic').pillarUp(ctx, t, { height: Math.min(rise, 32) });
    return { stood: true, rose: Math.max(0, rise) };
  }
};
