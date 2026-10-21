// pillar_fight: встать на столб в 2 блока (pillar_up) и бить сверху пешеходов (зомби, пауки). Не против стрелков/крипера.
// Сверху не спускаемся и не отходим (упадём); цель не подходит 10 с — сдаёмся (бой продолжит другой вариант).
'use strict';
const M = require('../../melee');
const C = require('./_core');

const WALKERS = new Set(['zombie', 'husk', 'zombie_villager', 'spider', 'cave_spider']);

module.exports = {
  name: 'pillar_fight', family: 'melee',
  desc: 'столб в 2 блока и удары сверху по зомби/паукам (нужно >=2 блоков земли/булыжника)',
  applies: (ctx, sit) => WALKERS.has(sit.target) && !sit.pvp && !sit.defend && !sit.water && !sit.ladder &&
    (sit.blocks || 0) >= 2 && (sit.ceiling == null || sit.ceiling >= 5),
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'pillar_fight' }, sit, {
    keep: false,
    async setup(env) {
      const basic = require('../../skills/basic');
      let r = null;
      try { r = await basic.pillarUp(ctx, t, { height: 2 }); } catch (e) { if (e.aborted) throw e; return false; }
      env.st.data.top = true;
      return !!(r && r.raised >= 1);
    },
    strike: env => C.hitNow(env),                    // без разбега — на столбе
    async cooldown(env) { M.setMove(env.bot, null); }, // не шагать — упадём
    async approach(env, d) {                           // ждём, пока подойдёт сама
      const { st } = env;
      M.setMove(env.bot, null);
      if (d < st.bestD - 0.5) { st.bestD = d; st.progressT = Date.now(); }
      if (Date.now() - st.progressT > 10000) return 'gaveup';
      await env.t.sleep(100);
      return null;
    }
  })
};
