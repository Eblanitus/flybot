// Общее семейства home: путь скачками по leg блоков (длинный путь pathfinder за раз ведёт ненадёжно), как было в baseTravel.
// opts: { leg (блоков за скачок; Infinity — сразу к цели), sprint, hops (максимум скачков) }.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');

async function travel(ctx, t, p, { leg = 64, sprint = true, hops = 14 } = {}) {
  const bot = ctx.bot;
  const hd = () => Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z);
  const arrive = p.arrive || 3, near = p.near || 3, d0 = hd();
  const deadline = Date.now() + (Number(p.timeout) > 0 ? Number(p.timeout) : 420) * 1000;
  let stalls = 0, lastErr = null;
  t.progress(`иду${p.label ? ' ' + p.label : ''} (${Math.round(d0)} м)`);
  for (let hop = 0; hop < hops && hd() > arrive; hop++) {
    t.check();
    const left = deadline - Date.now();
    if (left < 5000) throw new SkillError(`${p.fail || 'не дошла'}: вышло время (осталось ${Math.round(hd())} м)`, { left: Math.round(hd()), d0: Math.round(d0) });
    const before = hd(), me = bot.entity.position;
    const goal = before <= leg ? (Number.isFinite(Number(p.y)) ? new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), near) : new goals.GoalNearXZ(Math.floor(p.x), Math.floor(p.z), near))
      : new goals.GoalNearXZ(Math.round(me.x + (p.x - me.x) * leg / before), Math.round(me.z + (p.z - me.z) * leg / before), 3);
    try { await A.goto(ctx, t, goal, { timeout: Math.min(left, 120000), sprint }); }
    catch (e) { if (e.aborted) throw e; lastErr = e.message; }
    if (before - hd() < 4) { if (++stalls >= 2) throw new SkillError(`${p.fail || 'не дошла'}: ${lastErr || 'нет продвижения'} (осталось ${Math.round(hd())} м)`, { left: Math.round(hd()), d0: Math.round(d0) }); }
    else stalls = 0;
  }
  if (hd() > arrive) throw new SkillError(`${p.fail || 'не дошла'}: осталось ${Math.round(hd())} м`, { left: Math.round(hd()), d0: Math.round(d0) });
  return { arrived: true, left: Math.round(hd()), d0: Math.round(d0) };
}

module.exports = { travel };
