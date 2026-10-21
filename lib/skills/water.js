// Руки для воды (простые действия без решений): swim_to — плыть к точке (в т.ч. под водой, sprint=1 — быстрое
// плавание), dive — нырнуть вниз. Всплывать сами НЕ всплывают и за воздухом не следят: когда всплывать — решает
// поведение (behavior/) или мозг. Блок под водой ставит place_at (вода в клетке — не помеха).
// Пока рука работает, ctx.manualControl = true: рефлекс плавания поведения не держит «прыжок».
'use strict';
const { Vec3, num, SkillError, r1 } = require('../util');

const isWater = b => !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'kelp_plant' || b.name === 'seagrass' || b.name === 'tall_seagrass');
function airLeft(bot) { return bot.oxygenLevel != null ? bot.oxygenLevel : null; }

// управление вручную на время действия; в конце — всё отпустить
async function manual(ctx, fn) {
  const bot = ctx.bot;
  ctx.manualControl = true;
  try { return await fn(); } finally { try { bot.clearControlStates(); } catch (e) {} ctx.manualControl = false; }
}

// swim_to {x,y,z, sprint?, reach?(1.2), timeout?(с, 20)}: смотреть на точку, плыть вперёд; выше — «прыжок», ниже — «присесть».
async function swimTo(ctx, t, p) {
  const bot = ctx.bot;
  const x = Number(p.x), y = Number(p.y), z = Number(p.z);
  if (![x, y, z].every(Number.isFinite)) throw new SkillError('нужны x, y, z');
  const target = new Vec3(x + 0.5, y, z + 0.5);
  const sprint = p.sprint === true || p.sprint === 1 || p.sprint === '1' || p.sprint === 'true';
  const reach = num(p.reach, 1.2, 0.5, 4);
  const until = Date.now() + num(p.timeout, 20, 1, 120) * 1000;
  return manual(ctx, async () => {
    t.progress(`плыву к ${x} ${y} ${z}${sprint ? ' (быстро)' : ''}`);
    while (Date.now() < until) {
      t.check();
      const me = bot.entity.position;
      if (me.distanceTo(target) <= reach) break;
      await bot.lookAt(target.offset(0, 0.9, 0), true).catch(() => {});
      const dy = target.y - me.y;
      bot.setControlState('forward', Math.hypot(target.x - me.x, target.z - me.z) > 0.4);
      bot.setControlState('sprint', sprint);
      bot.setControlState('jump', dy > 0.5);
      bot.setControlState('sneak', dy < -0.5);
      await t.sleep(100);
    }
    const left = bot.entity.position.distanceTo(target);
    const res = { at: [r1(bot.entity.position.x), r1(bot.entity.position.y), r1(bot.entity.position.z)], left: r1(left), inWater: isWater(bot.blockAt(bot.entity.position.offset(0, 1.6, 0))), air: airLeft(bot) };
    if (left > reach) throw new SkillError(`не доплыла до ${x} ${y} ${z}: осталось ${r1(left)} м`, res);
    return { arrived: true, ...res };
  });
}

// dive {depth?(3) | y?, sprint?, timeout?(с, 15)}: вниз до высоты y (или на depth блоков), до дна или до тайм-аута.
async function dive(ctx, t, p) {
  const bot = ctx.bot;
  const start = bot.entity.position.y;
  const toY = Number.isFinite(Number(p.y)) && p.y !== undefined && p.y !== null && p.y !== '' ? Number(p.y) : start - num(p.depth, 3, 1, 64);
  const sprint = p.sprint === true || p.sprint === 1 || p.sprint === '1' || p.sprint === 'true';
  const until = Date.now() + num(p.timeout, 15, 1, 60) * 1000;
  if (!isWater(bot.blockAt(bot.entity.position)) && !isWater(bot.blockAt(bot.entity.position.offset(0, 1.6, 0)))) throw new SkillError('не в воде — нырять некуда');
  return manual(ctx, async () => {
    t.progress(`ныряю до y=${Math.round(toY)}`);
    let bottom = false;
    while (Date.now() < until) {
      t.check();
      const me = bot.entity.position;
      if (me.y <= toY + 0.3) break;
      if (bot.entity.onGround) { bottom = true; break; }
      await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {}); // взгляд вниз (pitch -90°)
      bot.setControlState('sneak', true);
      bot.setControlState('jump', false);
      bot.setControlState('forward', sprint);
      bot.setControlState('sprint', sprint);
      await t.sleep(100);
    }
    const y = bot.entity.position.y;
    return { y: r1(y), reached: y <= toY + 0.3, bottom, dived: r1(start - y), air: airLeft(bot) };
  });
}

module.exports = { swimTo, dive };
