// cover_escape: отход к ближайшей стене/укрытию, чтобы разорвать линию огня стрелка. Не в воде, не на лестнице.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');
const C = require('./_core');
const F = require('../../felt');

const RANGE = 25; // ищем укрытие в этом радиусе
const MAX_DIST = 16; // идем не дальше

function isSolidBlock(bot, x, y, z) {
  const b = bot.blockAt(new (bot.entity.position.constructor)(Math.floor(x), Math.floor(y), Math.floor(z)));
  return !!b && b.boundingBox === 'block';
}

function hasCover(bot, x, z, me) {
  // проверяем, есть ли блок, за которым можно спрятаться (стена высотой 2+)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const bx = x + dx, bz = z + dz;
      if (isSolidBlock(bot, bx, me.y, bz) && isSolidBlock(bot, bx, me.y + 1, bz)) {
        // проверяем, что это не просто блок под ногами, а стена
        return { x: bx, z: bz, side: dx !== 0 ? (dx > 0 ? 'west' : 'east') : (dz > 0 ? 'north' : 'south') };
      }
    }
  }
  return null;
}

function findCoverSpot(bot, fromPos, me) {
  // ищем позицию рядом со стеной, откуда не видно стрелков
  const best = { pos: null, score: -1 };
  for (let r = 1; r <= RANGE; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
      const x = fromPos.x + Math.cos(a) * r;
      const z = fromPos.z + Math.sin(a) * r;
      const y = Math.floor(fromPos.y);
      if (!isSolidBlock(bot, x, y, z) && !isSolidBlock(bot, x, y + 1, z)) {
        const cover = hasCover(bot, x, z, { x, y, z });
        if (cover) {
          // проверяем, что от этой позиции нет видимости на стрелков
          let visible = false;
          for (const e of Object.values(bot.entities || {})) {
            if (!e || e === bot.entity || !e.position || !F.RANGED.has(e.name)) continue;
            const ep = F.posOf(e) || e.position;
            if (ep.distanceTo(new (bot.entity.position.constructor)(x + 0.5, y + 1.6, z + 0.5)) <= 20) {
              // грубая проверка LOS - можно улучшить, но пока просто дистанция
              visible = true; break;
            }
          }
          const score = visible ? 0 : 10 - r;
          if (score > best.score) {
            best.pos = { x: x + 0.5, y: y + 1, z: z + 0.5 };
            best.score = score;
          }
        }
      }
    }
    if (best.pos) break;
  }
  return best.pos;
}

module.exports = {
  name: 'cover_escape', family: 'escape',
  desc: 'отход к стене/укрытию, чтобы разорвать линию огня стрелка',
  applies: (ctx, sit) => sit.rangedNearby && !sit.water && !sit.ladder,
  async run(ctx, t, p) {
    const bot = ctx.bot;
    const me = bot.entity.position;
    const done = C.measure(ctx);
    t.progress('ищу укрытие от стрелка');
    const coverPos = findCoverSpot(bot, me, me);
    if (!coverPos) {
      t.progress('укрытие не найдено — убегаю зигзагом');
      // fallback к зигзагу
      const u = C.unit(p.vector); if (!u) throw new SkillError('не знаю, куда бежать: врагов не видно');
      const { legs } = require('./zigzag');
      for (let i = 0; i < 3; i++) {
        t.check(); t.progress(`убегаю зигзагом ${i+1}/3`);
        try { await A.goto(ctx, t, new goals.GoalNearXZ(me.x + legs(u, 16)[i].x, me.z + legs(u, 16)[i].z, 1.5), { timeout: 4000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
      }
      return done();
    }
    t.progress(`иду в укрытие (${Math.round(coverPos.x)}, ${Math.round(coverPos.z)})`);
    try {
      await A.goto(ctx, t, new goals.GoalNearXZ(coverPos.x, coverPos.z, 1.5), { timeout: 8000, sprint: true });
    } catch (e) { if (e.aborted) throw e; }
    return done();
  }
};