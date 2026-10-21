// strafe: кружение вокруг цели (влево/вправо по очереди) на перезарядке, удар с разбегом — против тех, кто бьёт часто (игроки, FlyBot).
'use strict';
const C = require('./_core');

const SWITCH_MS = 700;

async function circle(env, mode) {
  const { bot, st } = env;
  const now = Date.now();
  if (!st.data.side || now - st.data.sideT > SWITCH_MS) { st.data.side = st.data.side === 'left' ? 'right' : 'left'; st.data.sideT = now; }
  // шаг вбок — перпендикуляр к направлению на цель (смотрим на цель)
  const a = C.awayDir(env), sgn = st.data.side === 'left' ? 1 : -1;
  let sx = -a.z * sgn, sz = a.x * sgn, side = st.data.side;
  const ok = (x, z) => C.stepIsSafe(bot, x, z) && C.inLeash(env, x * 1.5, z * 1.5);
  if (!ok(sx, sz)) { // в эту сторону нельзя — в другую, иначе стоим
    side = side === 'left' ? 'right' : 'left'; sx = -sx; sz = -sz;
    if (!ok(sx, sz)) side = null;
    if (side) st.data.side = side; st.data.sideT = now;
  }
  bot.setControlState('sprint', false); bot.setControlState('forward', false);
  bot.setControlState('left', side === 'left');
  bot.setControlState('right', side === 'right');
  bot.setControlState('back', mode === 'back' && env.hbd() < 1.6 && C.canBack(env));
}

module.exports = {
  name: 'strafe', family: 'melee',
  desc: 'кружит вокруг цели влево/вправо на перезарядке, удар с разбегом (против частых ударов: игроки)',
  applies: (ctx, sit) => !sit.water && !sit.ladder && !sit.creeper,
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'strafe' }, sit, { cooldown: circle })
};
