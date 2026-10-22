// pillar: столб под себя до нужной высоты (прыжок + блок). Нужны блоки (не меньше подъёма) и открытый верх; не в воде.
'use strict';

module.exports = {
  name: 'pillar', family: 'climb',
  desc: 'столб под себя прыжками (блоков не меньше подъёма, открытый верх)',
  applies: (ctx, sit) => !sit.water && (sit.blocks || 0) >= Math.min(sit.rise || 1, 32) && (sit.ceiling == null || sit.ceiling >= 3),
  async run(ctx, t, p) {
    const M = require('../../skills/move');
    const r = await require('../../skills/basic').pillarUp(ctx, t, { height: Math.min(p.ty - p.y0, 32) });
    return M.heightResult(ctx.bot, p.y0, p.ty, r.stopped ? { stopped: r.stopped } : {});
  }
};
