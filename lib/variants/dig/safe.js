// safe: подойти к блоку сбоку, не вставая на него; цель под ногами или перепад под целью — отказ.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
const { Vec3 } = require('vec3');

function hasSupport(bot, pos) {
  const below = bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z));
  return below && A.isSolid(below);
}

function dropBelow(bot, pos, minDrop = 3) {
  const startY = Math.floor(pos.y);
  const minY = bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64;
  for (let y = startY - 1; y >= minY; y--) {
    const b = bot.blockAt(new Vec3(pos.x, y, pos.z));
    if (b && A.isSolid(b)) {
      return startY - 1 - y >= minDrop;
    }
  }
  return true; // пустота до дна мира
}

function isUnderFeet(bot, pos) {
  const me = bot.entity.position.floored();
  return pos.x === me.x && pos.z === me.z && pos.y <= me.y + 1;
}

module.exports = {
  name: 'safe', family: 'dig',
  desc: 'подойти сбоку, не вставая на блок; цель под ногами или обрыв под целью — отказ',
  applies: (ctx, sit) => {
    // safe применяется везде, но проверки внутри run
    return true;
  },
  run: async (ctx, t, p, sit) => {
    const bot = ctx.bot;
    const pos = p.pos;
    const ownBlocks = p.ownBlocks;
    const danger = p.danger;

    // 1. Цель под ногами — отказ
    if (isUnderFeet(bot, pos)) {
      throw new Error('цель под ногами: safe отказывает');
    }

    // 2. Цель — свой блок — отказ
    if (ownBlocks) {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (ownBlocks.has(key)) {
        throw new Error('цель — свой блок: safe отказывает');
      }
    }

    // 3. Перепад под целью ≥ 3 блока — отказ
    if (dropBelow(bot, pos, 3)) {
      throw new Error('под целью пропасть: safe отказывает');
    }

    // 4. Нет опоры под целью — отказ
    if (!hasSupport(bot, pos)) {
      throw new Error('нет опоры под целью: safe отказывает');
    }

    // 5. Моб очень близко — отказ (дополнительная проверка)
    if (danger && danger.mobs && danger.mobs.mobs && danger.mobs.mobs.length) {
      const nearest = danger.mobs.mobs.reduce((a, m) => m.d < a.d ? m : a, danger.mobs.mobs[0]);
      if (nearest.d <= 3) {
        throw new Error(`моб ${nearest.name} ${nearest.d.toFixed(1)} м рядом: safe отказывает`);
      }
    }

    // Найти позицию рядом с блоком, откуда он виден и достаётся, но не на самом блоке
    const offsets = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1]
    ];

    for (const [dx, dz] of offsets) {
      const standPos = new Vec3(pos.x + dx, pos.y, pos.z + dz);
      const standBlock = bot.blockAt(standPos);
      const headBlock = bot.blockAt(standPos.offset(0, 1, 0));
      const belowStand = bot.blockAt(standPos.offset(0, -1, 0));

      // Место для стояния: воздух, над полом, голова не в блоке
      if (standBlock && !A.isAirLike(standBlock)) continue;
      if (headBlock && !A.isAirLike(headBlock)) continue;
      if (!belowStand || !A.isSolid(belowStand)) continue;

      // Перепад под местом стояния — проверка
      if (dropBelow(bot, standPos, 3)) continue;

      // Попытка дойти
      try {
        await A.goto(ctx, t, new goals.GoalBlock(standPos.x, standPos.y, standPos.z), { timeout: p.timeout || 45000 });
      } catch (e) {
        if (e.aborted) throw e;
        continue; // пробуем следующую позицию
      }

      // Проверить досягаемость блока из этой позиции
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const targetCenter = pos.offset(0.5, 0.5, 0.5);
      const reach = eye.distanceTo(targetCenter);
      if (reach <= 5.2) {
        return { reached: true, reach, standPos };
      }
      // Если не достаёт, пробуем следующую позицию
    }

    throw new Error('safe: не нашла безопасную позицию для копки');
  }
};