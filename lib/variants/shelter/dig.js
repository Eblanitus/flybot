// dig: закопаться — 2 блока вниз и блок на голову (быстро, 1–3 блока). Не в воде и не рядом с водой.
'use strict';
const isWaterB = b => !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'seagrass' || b.name === 'tall_seagrass');

function at(bot, x, y, z) { try { const V = bot.entity.position.constructor; return bot.blockAt(new V(Math.floor(x), Math.floor(y), Math.floor(z))); } catch (e) { return null; } }

function waterNearby(bot, sit) {
  if (sit.water) return true;
  const p = bot.entity.position;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const b = at(bot, p.x + dx, p.y + 0.01, p.z + dz);
    if (isWaterB(b)) return true;
  }
  return false;
}

module.exports = {
  name: 'dig', family: 'shelter',
  desc: 'закопаться: 2 блока вниз и закрыть голову (быстро, мало блоков)',
  applies: (ctx, sit) => !waterNearby(ctx.bot, sit) && !sit.ladder,
  run: (ctx, t, p) => require('../../skills/survival').shelterImpl(ctx, t, { ...p, mode: 'dig' })
};
