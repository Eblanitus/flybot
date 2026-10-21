// Навык recover: вернуться к месту последней смерти и собрать свои вещи (лежат ~5 минут).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, SkillError } = require('../util');
const A = require('../actions');
const threats = require('../threats');

const DESPAWN_MS = 5 * 60 * 1000;

async function recover(ctx, t, p) {
  const bot = ctx.bot;
  const ld = ctx.lastDeath;
  if (!ld || !ld.at) throw new SkillError('не помню места смерти (тело перезапускалось?)');
  const ageSec = Math.round((Date.now() - ld.ts) / 1000);
  if (Date.now() - ld.ts > DESPAWN_MS) throw new SkillError(`вещи уже исчезли: смерть была ${Math.round(ageSec / 60)} мин назад (лежат ~5 мин)`);
  const at = new Vec3(ld.at[0] + 0.5, ld.at[1] + 0.5, ld.at[2] + 0.5);
  const radius = num(p.radius, 10, 3, 16);
  // враг у места смерти — не лезть в засаду
  const danger = threats.list(ctx).find(th => {
    const e = Object.values(bot.entities).find(x => x.username === th.name);
    return e && e.position.distanceTo(at) < 16;
  });
  if (danger && p.force !== true) throw new SkillError(`у места смерти враг ${danger.name} (${danger.why}) — опасно; force:true, чтобы всё равно пойти`);

  const before = A.invMap(bot);
  t.progress(`иду к месту смерти ${ld.at.join(' ')}`);
  const left = DESPAWN_MS - (Date.now() - ld.ts);
  try { await A.goto(ctx, t, new goals.GoalNear(at.x, at.y, at.z, 2), { timeout: Math.max(5000, left), sprint: true }); }
  catch (e) { if (e.aborted) throw e; throw new SkillError(`не дошёл до места смерти: ${e.message}`); }
  t.progress('собираю вещи');
  for (let i = 0; i < 3; i++) await A.pickupDrops(ctx, t, at, radius, 10000);

  const gained = {};
  for (const [n, c] of A.invMap(bot)) { const d = c - (before.get(n) || 0); if (d > 0) gained[n] = d; }
  const left2 = Object.values(bot.entities).filter(e => e.name === 'item' && e.position && e.position.distanceTo(at) <= radius).length;
  return { at: ld.at, deathAgoSec: ageSec, gained, itemsLeft: left2, ...(Object.keys(gained).length ? {} : { note: 'ничего не подобрал: вещи забрали, сгорели или упали в недоступное место' }) };
}

module.exports = { recover };
