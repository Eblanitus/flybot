// sprint_away: бег по прямой от врагов со спринтом (как было в escape). Везде, кроме лестницы.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');
const C = require('./_core');

module.exports = {
  name: 'sprint_away', family: 'escape',
  desc: 'спринт по прямой прочь от врагов на distance блоков',
  applies: (ctx, sit) => !sit.ladder,
  async run(ctx, t, p) {
    const u = C.unit(p.vector); if (!u) throw new SkillError('не знаю, куда бежать: врагов не видно');
    const me = ctx.bot.entity.position, dist = p.distance || 16, done = C.measure(ctx);
    t.progress('убегаю (по прямой)');
    try { await A.goto(ctx, t, new goals.GoalNearXZ(me.x + u.x * dist, me.z + u.z * dist, 2), { timeout: 10000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
    return done();
  }
};
