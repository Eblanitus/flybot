// Общее семейства home: путь скачками по leg блоков (длинный путь pathfinder за раз ведёт ненадёжно), как было в baseTravel.
// opts: { leg (блоков за скачок; Infinity — сразу к цели), sprint, hops (максимум скачков), flat (не спускаться: край обходить или отказ) }.
// Застой (заявка 892391944e): позиция не сдвинулась на STALL_D м за STALL_MS — отказ сразу, с секундами и перепадом высот,
// а не 2 «прыжка» по 120 с молчания (p.stallMs — для тестов).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');

const STALL_MS = 40000, STALL_D = 2;
const FLAT_DROP = 4; // flat: ниже начала скачка больше чем на 4 уровня не спускаемся

// flat: направление скачка без края впереди — прямо или в обход стороной (±25°, ±50°, ±75°), короче; null — обхода нет
function flatHop(bot, me, p, leg, before) {
  const ang0 = Math.atan2(p.x - me.x, -(p.z - me.z));
  const len = Math.min(leg, before);
  let firstEdge = null;
  for (const da of [0, 25, -25, 50, -50, 75, -75]) {
    const a = ang0 + da * Math.PI / 180, dx = Math.sin(a), dz = -Math.cos(a);
    const d = da ? Math.min(len, 16) : len;
    const e = A.edgeAhead(bot, me, dx, dz, d, { maxDrop: FLAT_DROP });
    if (!e) return { x: Math.round(me.x + dx * d), z: Math.round(me.z + dz * d), side: da, last: !da && d >= before };
    if (!firstEdge) firstEdge = e;
  }
  return { edge: firstEdge };
}

async function travel(ctx, t, p, { leg = 64, sprint = true, hops = 14, flat = false } = {}) {
  const bot = ctx.bot;
  const hd = () => Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z);
  const rise = () => (Number.isFinite(Number(p.y)) ? Math.round(Number(p.y) - bot.entity.position.y) : null);
  const arrive = p.arrive || 3, near = p.near || 3, d0 = hd();
  const deadline = Date.now() + (Number(p.timeout) > 0 ? Number(p.timeout) : 420) * 1000;
  const stallMs = Number(p.stallMs) > 0 ? Number(p.stallMs) : STALL_MS;
  let stalls = 0, lastErr = null;
  // застой: якорь сдвигается, только когда муха отошла от него на STALL_D м
  let anchor = bot.entity.position.clone(), anchorT = Date.now();
  t.progress(`иду${p.label ? ' ' + p.label : ''} (${Math.round(d0)} м)`);
  for (let hop = 0; hop < hops && hd() > arrive; hop++) {
    t.check();
    const left = deadline - Date.now();
    if (left < 5000) throw new SkillError(`${p.fail || 'не дошла'}: вышло время (осталось ${Math.round(hd())} м)`, { left: Math.round(hd()), d0: Math.round(d0) });
    const before = hd(), me = bot.entity.position.clone();
    let goal;
    if (flat) {
      const h = flatHop(bot, me, p, leg, before);
      if (h.edge) throw new SkillError(`${p.fail || 'не дошла'}: впереди ${h.edge.kind} в ${h.edge.s} м${h.edge.kind === 'спуск' ? ` (на ${h.edge.drop} ур.)` : ''}, обхода стороной нет — вниз не иду (осталось ${Math.round(before)} м)`, { left: Math.round(before), d0: Math.round(d0), edge: h.edge.kind });
      goal = h.last && Number.isFinite(Number(p.y)) ? new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), near) : new goals.GoalNearXZ(h.x, h.z, h.last ? near : 3);
    } else {
      goal = before <= leg ? (Number.isFinite(Number(p.y)) ? new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), near) : new goals.GoalNearXZ(Math.floor(p.x), Math.floor(p.z), near))
        : new goals.GoalNearXZ(Math.round(me.x + (p.x - me.x) * leg / before), Math.round(me.z + (p.z - me.z) * leg / before), 3);
    }
    let stuck = false, sank = false;
    const watch = setInterval(() => {
      try {
        const q = bot.entity.position;
        if (flat && me.y - q.y > FLAT_DROP) { sank = true; bot.pathfinder.setGoal(null); return; }
        if (q.distanceTo(anchor) >= STALL_D) { anchor = q.clone(); anchorT = Date.now(); }
        else if (Date.now() - anchorT > stallMs) { stuck = true; bot.pathfinder.setGoal(null); }
      } catch (e) {}
    }, Math.min(1000, Math.max(50, stallMs / 4)));
    try { await A.goto(ctx, t, goal, { timeout: Math.min(left, 120000), sprint }); }
    catch (e) { if (e.aborted) throw e; lastErr = e.message; }
    finally { clearInterval(watch); }
    if (sank) throw new SkillError(`${p.fail || 'не дошла'}: дорога пошла вниз на ${Math.round(me.y - bot.entity.position.y)} ур. — дальше не спускаюсь (осталось ${Math.round(hd())} м)`, { left: Math.round(hd()), d0: Math.round(d0), drop: Math.round(me.y - bot.entity.position.y) });
    if (stuck) {
      const sec = Math.round((Date.now() - anchorT) / 1000), r = rise();
      throw new SkillError(`${p.fail || 'не дошла'}: застой — сдвиг ${Math.round(bot.entity.position.distanceTo(anchor))} м за ${sec} с` + (r != null && r >= 4 ? `, цель на ${r} м выше` : r != null && r <= -4 ? `, цель на ${-r} м ниже` : '') + (lastErr && !/goal was changed/i.test(lastErr) ? ` (${lastErr})` : '') + ` (осталось ${Math.round(hd())} м)`,
        { left: Math.round(hd()), d0: Math.round(d0), stuckSec: sec, ...(r != null ? { rise: r } : {}) });
    }
    if (before - hd() < 4) { if (++stalls >= 2) throw new SkillError(`${p.fail || 'не дошла'}: ${lastErr || 'нет продвижения'} (осталось ${Math.round(hd())} м)`, { left: Math.round(hd()), d0: Math.round(d0) }); }
    else stalls = 0;
  }
  if (hd() > arrive) throw new SkillError(`${p.fail || 'не дошла'}: осталось ${Math.round(hd())} м`, { left: Math.round(hd()), d0: Math.round(d0) });
  return { arrived: true, left: Math.round(hd()), d0: Math.round(d0) };
}

// в яме/пещере, цель на 8+ м выше: пешие варианты там стоят (заявка 892391944e) — остаётся только up (подъём или отказ)
const pit = sit => !!sit && sit.place === 'underground' && sit.rise != null && sit.rise >= 8;

module.exports = { travel, flatHop, pit, STALL_MS };
