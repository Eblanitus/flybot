// wtap_combo: серия спринт-ударов со сбросом спринта (w-tap) — каждый удар со свежим спринтом даёт полное отбрасывание.
// Без прыжка. На перезарядке не отходит, а держится на ~2.5 до хитбокса (шагом), чтобы следующий удар был сразу.
'use strict';
const M = require('../../melee');
const C = require('./_core');

const TAP_MS = 60; // отпустить «вперёд» после удара — сервер сбрасывает спринт

async function wtap(env) {
  const hit = await C.lungeHit(env); // разбег со спринтом -> удар (stopMove внутри = отпустить W)
  if (hit) await env.t.sleep(TAP_MS);
  return hit;
}
async function stayClose(env) {
  const { bot } = env, d = env.hbd();
  if (d < M.LUNGE_MIN && C.canBack(env)) return M.setMove(bot, 'back'); // вплотную — место для разбега
  bot.setControlState('sprint', false);
  bot.setControlState('back', false);
  bot.setControlState('forward', d > 2.6 && C.inLeash(env)); // подтянуться шагом, не бежать
}

module.exports = {
  name: 'wtap_combo', family: 'melee',
  desc: 'серия спринт-ударов со сбросом спринта (w-tap), без прыжка; на перезарядке держится рядом',
  applies: (ctx, sit) => !sit.water && !sit.ladder && !sit.creeper && !sit.defend && (sit.food == null || sit.food > 6),
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'wtap_combo' }, sit, { strike: wtap, cooldown: stayClose, keep: false })
};
