// pillar: столб из 3 блоков под себя — мобы ближнего боя не достают. Не от стрелков/крипера/игроков, нужны блоки и потолок.
'use strict';
const C = require('./_core');

module.exports = {
  name: 'pillar', family: 'escape',
  desc: 'столб из 3 блоков под себя (мобы ближнего боя не достанут); не от стрелков и крипера',
  applies: (ctx, sit) => !sit.rangedNearby && !sit.creeper && !sit.pvp && !sit.water && !sit.ladder && (sit.blocks || 0) >= 3 && (sit.ceiling == null || sit.ceiling >= 5),
  async run(ctx, t) {
    const done = C.measure(ctx);
    t.progress('убегаю вверх (столб)');
    const r = await require('../../skills/basic').pillarUp(ctx, t, { height: 3 });
    return done({ raised: r.raised, high: r.raised >= 2 });
  }
};
