// zigzag: бегство тремя отрезками под ±35° к направлению «прочь» — лучнику труднее попасть. Не в воде, не на лестнице.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');
const C = require('./_core');

const ANG = 35 * Math.PI / 180;
function legs(u, dist, n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i % 2 ? -ANG : ANG, c = Math.cos(a), s = Math.sin(a);
    out.push({ x: (u.x * c - u.z * s) * dist / n, z: (u.x * s + u.z * c) * dist / n });
  }
  return out;
}

module.exports = {
  name: 'zigzag', family: 'escape',
  desc: 'бегство зигзагом (3 отрезка по ±35°) — против стрелков',
  applies: (ctx, sit) => !sit.water && !sit.ladder,
  async run(ctx, t, p) {
    const u = C.unit(p.vector); if (!u) throw new SkillError('не знаю, куда бежать: врагов не видно');
    const done = C.measure(ctx);
    let i = 0;
    for (const l of legs(u, p.distance || 16)) {
      t.check(); t.progress(`убегаю зигзагом ${++i}/3`);
      const me = ctx.bot.entity.position;
      try { await A.goto(ctx, t, new goals.GoalNearXZ(me.x + l.x, me.z + l.z, 1.5), { timeout: 4000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
    }
    return done();
  },
  legs
};
