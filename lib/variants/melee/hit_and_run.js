// hit_and_run: удар и отбег на 4–5 блоков, пока оружие заряжается полностью, затем снова — против групп и сильных мобов.
// Не против стрелков (их надо сближать), не крипера, не в охране поста; вардена/голема не трогаем вовсе.
'use strict';
const M = require('../../melee');
const C = require('./_core');

const STRONG = new Set(['ravager', 'vindicator', 'polar_bear', 'hoglin', 'zoglin', 'piglin_brute', 'spider', 'cave_spider', 'husk', 'zombie_villager', 'slime', 'magma_cube']);
const NEVER = new Set(['warden', 'iron_golem', 'creaking']);

module.exports = {
  name: 'hit_and_run', family: 'melee',
  desc: 'удар и отбег на 4–5 блоков до полного заряда, снова (против групп и сильных)',
  applies: (ctx, sit) => !sit.defend && !sit.ranged && !sit.creeper && !sit.water && !sit.ladder && !NEVER.has(sit.target) &&
    (STRONG.has(sit.target) || (!!sit.count && sit.count !== '0' && sit.count !== '1') || sit.hp !== 'high' || !!sit.pvp),
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'hit_and_run' }, sit, {
    async strike(env) {
      const hit = await C.lungeHit(env);
      if (hit && !env.creeper && C.alive(env.bot, env.target) && M.backIsSafe(env.bot, env.target)) {
        const left = M.cooldownMs(env.bot.heldItem && env.bot.heldItem.name) - (Date.now() - env.st.lastHit);
        await C.retreat(ctx, t, env.target, 5, Math.max(600, left));
      }
      return hit;
    }
  })
};
