// escape_to_base: при стрелке (скелет/любой ranged) ближе 10 м — отход к базе, где безопаснее и врага
// отбиваем от своих вещей; базы нет — бежим прочь по вектору. Настоящий вариант семейства (core_task 29181f0b08):
// раньше был встроен в behavior/combat.js и с версий поведения не запускался (../lib оттуда не резолвился).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const A = require('../../actions');
const { parseBase } = require('../../basegoal');
const C = require('./_core');

module.exports = {
  name: 'escape_to_base', family: 'escape',
  desc: 'бегство к базе от стрелка (скелет/ranged <10м); нет базы — прочь по вектору',
  applies: (ctx, sit) => !!(sit && (sit.target === 'skeleton' || sit.ranged) && (sit.dist == null || sit.dist < 10)),
  async run(ctx, t, p) {
    const done = C.measure(ctx);
    t.progress('убегаю к базе от стрелка');
    let base = ctx.base;
    if (!base) {
      try {
        const notes = fs.readFileSync(path.join(__dirname, '../../../brain/notes.md'), 'utf8');
        base = parseBase(notes);
      } catch (e) {}
    }
    if (base) {
      try {
        await A.goto(ctx, t, new goals.GoalNear(base.x, base.y, base.z, 2), { timeout: 15000, sprint: true });
        return done();
      } catch (e) {
        if (e.aborted) throw e;
      }
    }
    const u = C.unit(p.vector);
    const me = ctx.bot.entity.position, dist = p.distance || 16;
    if (u) {
      try { await A.goto(ctx, t, new goals.GoalNearXZ(me.x + u.x * dist, me.z + u.z * dist, 2), { timeout: 10000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
    }
    return done();
  }
};
