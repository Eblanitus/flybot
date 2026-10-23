// cave_escape: бегство в пещере/подземелье — смотрит под ногами, не спускается в провалы, идёт вверх по шахте.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');
const C = require('./_core');

function isAirOrWater(bot, x, y, z) {
  const b = bot.blockAt(new bot.entity.position.constructor(Math.floor(x), Math.floor(y), Math.floor(z)));
  return !b || b.name === 'air' || b.name === 'water' || b.name === 'bubble_column' || b.name === 'cave_air' || b.name === 'void_air';
}

function hasDrop(bot, x, z, maxDrop = 3) {
  const y = Math.floor(bot.entity.position.y + 0.01);
  for (let d = 1; d <= maxDrop; d++) {
    const b = bot.blockAt(new bot.entity.position.constructor(Math.floor(x), y - d, Math.floor(z)));
    if (b && b.boundingBox === 'block') return false;
  }
  return true;
}

function isOwnBlock(ctx, x, y, z) {
  try {
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    return ctx.ownBlocks && ctx.ownBlocks.has(key);
  } catch (e) { return false; }
}

function findSafeStep(bot, from, to, maxDist) {
  const steps = Math.ceil(maxDist / 3);
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const x = from.x + (to.x - from.x) * ratio;
    const z = from.z + (to.z - from.z) * ratio;
    const y = Math.floor(bot.entity.position.y + 0.01);
    // Проверяем: нет пропасти под ногами, не свой блок
    if (hasDrop(bot, x, z, 3)) continue;
    if (isOwnBlock({ ownBlocks: new Map() }, x, y - 1, z)) continue; // will be overridden by caller
    return { x, z };
  }
  return null;
}

module.exports = {
  name: 'cave_escape', family: 'escape',
  desc: 'бегство в пещере: смотрит под ногами, не идёт вниз, не ломает свои блоки',
  applies: (ctx, sit) => sit.place === 'underground' && !sit.ladder,
  async run(ctx, t, p) {
    const u = C.unit(p.vector); if (!u) throw new SkillError('не знаю, куда бежать: врагов не видно');
    const bot = ctx.bot;
    const me = bot.entity.position;
    const dist = p.distance || 16;
    const done = C.measure(ctx);

    t.progress('убегаю в пещере (осторожно)');

    // Ищем безопасную точку: не в пропасть, не через свои блоки, по возможности вверх
    const targetX = me.x + u.x * dist;
    const targetZ = me.z + u.z * dist;

    // Проверяем путь небольшими шагами
    const steps = Math.max(4, Math.ceil(dist / 4));
    let lastSafe = { x: me.x, z: me.z };
    let foundSafe = false;

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      const x = me.x + (targetX - me.x) * ratio;
      const z = me.z + (targetZ - me.z) * ratio;
      const y = Math.floor(me.y + 0.01);

      // Не свои блоки
      if (isOwnBlock(ctx, x, y - 1, z) || isOwnBlock(ctx, x, y, z) || isOwnBlock(ctx, x, y + 1, z)) {
        break;
      }
      // Нет пропасти под ногами (проверяем 3 блока вниз)
      if (hasDrop(bot, x, z, 3)) {
        break;
      }
      lastSafe = { x, z };
      foundSafe = true;
    }

    if (!foundSafe) {
      // Не нашли безопасный путь — пробуем вверх по шахте
      t.check();
      t.progress('нет безопасного пути вбок, ищу вверх');
      const upDist = Math.min(dist, 12);
      for (let i = 1; i <= upDist; i++) {
        const y = Math.floor(me.y + 0.01) + i;
        const b = bot.blockAt(new bot.entity.position.constructor(Math.floor(me.x), y, Math.floor(me.z)));
        if (b && b.boundingBox === 'block') break;
        if (i >= 3) {
          // Есть место вверх — поднимаемся
          try {
            await A.goto(ctx, t, new goals.GoalNearXZ(me.x, me.z, 1.5), { timeout: 8000, sprint: false, y });
            return done({ climbed: i });
          } catch (e) { if (e.aborted) throw e; }
        }
      }
      throw new SkillError('нет безопасного пути: провалы или свои блоки');
    }

    try {
      await A.goto(ctx, t, new goals.GoalNearXZ(lastSafe.x, lastSafe.z, 2), { timeout: 10000, sprint: true });
    } catch (e) { if (e.aborted) throw e; }
    return done();
  }
};