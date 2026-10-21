// crit_jump: прыжок и удар на падении (крит x1.5). Без спринта (спринт отменяет крит). Не в воде, не на лестнице, потолок >= 3.
'use strict';
const M = require('../../melee');
const C = require('./_core');

// Подпрыгнуть и дождаться падения (скорость вниз, не на земле), не дольше 550 мс; затем удар
async function jumpCrit(env) {
  const { bot, t } = env;
  M.stopMove(bot); // сброс спринта
  if (bot.entity.onGround !== false) {
    bot.setControlState('jump', true);
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < 550) {
        await t.sleep(25);
        const v = bot.entity.velocity;
        if (Date.now() - t0 > 120 && v && v.y < -0.05 && !bot.entity.onGround) break;
      }
    } finally { bot.setControlState('jump', false); }
    await bot.lookAt(env.aim(), true);
  }
  return C.hitNow(env);
}

module.exports = {
  name: 'crit_jump', family: 'melee',
  desc: 'прыжок и удар на падении (крит x1.5), без спринта; на перезарядке отход',
  applies: (ctx, sit) => !sit.water && !sit.ladder && (sit.ceiling == null || sit.ceiling >= 3),
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'crit_jump' }, sit, { strike: jumpCrit }),
  jumpCrit
};
