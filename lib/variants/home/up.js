// up: «я в яме/пещере, цель выше» (заявка 892391944e) — сначала подъём до высоты цели (навык climb: семейство climb, path/pillar),
// потом короткие скачки. Подъём не вышел — отказ с числами («цель на 11 м выше, поднялась на 2»), а не стояние в яме.
'use strict';
const { SkillError } = require('../../util');
const C = require('./_core');
const UP_MIN = 8; // цель выше хотя бы на столько — пешие варианты в яме стоят

module.exports = {
  name: 'up', family: 'home', UP_MIN,
  desc: 'из ямы/пещеры к цели выше (на 8+ м): подъём (climb), потом короткие скачки; не поднялась — отказ',
  applies: (ctx, sit) => sit.rise != null && sit.rise >= UP_MIN,
  async run(ctx, t, p) {
    const bot = ctx.bot;
    const y0 = Math.floor(bot.entity.position.y + 0.01), ty = Math.floor(Number(p.y));
    if (Number.isFinite(ty) && ty - y0 >= UP_MIN) {
      t.progress(`цель на ${ty - y0} м выше — поднимаюсь`);
      let r = null, err = null;
      try { r = await require('../../skills/move').climb(ctx, t, { y: ty }); } catch (e) { if (e.aborted) throw e; err = e; }
      const y1 = Math.floor(bot.entity.position.y + 0.01);
      if (ty - y1 >= UP_MIN) {
        throw new SkillError(`${p.fail || 'не дошла'}: цель на ${ty - y0} м выше, подъём не вышел (поднялась на ${Math.max(0, y1 - y0)})` + (err ? ': ' + err.message : ''),
          { left: Math.round(Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z)), rise: ty - y1, climb: r && r.variant ? r.variant : (err && err.extra && err.extra.variant) || null });
      }
    }
    const res = await C.travel(ctx, t, p, { leg: 24, sprint: (bot.food == null ? 20 : bot.food) > 6, hops: 36 });
    return { ...res, rose: Math.floor(bot.entity.position.y + 0.01) - y0 };
  }
};
