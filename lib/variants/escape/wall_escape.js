// wall_escape: когда окружен зомби/мобы рядом, HP низкий, оружия нет — ставит стену между собой и врагом или бьёт тем, что в руке.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('../../util');
const A = require('../../actions');
const C = require('./_core');
const basic = require('../../skills/basic');

function hasPlaceableBlocks(bot) {
  const PLACEABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'diorite', 'andesite', 'granite', 'tuff', 'coarse_dirt', 'deepslate', 'calcite', 'sandstone', 'blackstone'];
  return bot.inventory.items().filter(i => PLACEABLE.includes(i.name)).reduce((a, i) => a + i.count, 0) >= 3;
}

function hasWeapon(bot) {
  const item = bot.heldItem;
  if (!item) return false;
  return /_sword$|_axe$|_spear$|trident|bow|crossbow/.test(item.name);
}

function findWallPos(bot, targetPos, me) {
  // Ставим стену в 1 блоке от нас в направлении к врагу
  const dx = targetPos.x - me.x;
  const dz = targetPos.z - me.z;
  const len = Math.hypot(dx, dz);
  if (!len) return null;
  const ux = dx / len, uz = dz / len;
  // Пробуем поставить блок перед нами (между нами и врагом)
  const wx = Math.floor(me.x + ux * 1.5);
  const wz = Math.floor(me.z + uz * 1.5);
  const wy = Math.floor(me.y);
  // Проверяем, что там воздух и под ногами твёрдо
  const block = bot.blockAt(new bot.entity.position.constructor(wx, wy, wz));
  const below = bot.blockAt(new bot.entity.position.constructor(wx, wy - 1, wz));
  if (block && block.name !== 'air') return null;
  if (!below || below.boundingBox !== 'block') return null;
  return { x: wx, y: wy, z: wz };
}

module.exports = {
  name: 'wall_escape', family: 'escape',
  desc: 'стена между собой и врагом или отбиваться руками — когда окружен, HP низкий, оружия нет',
  applies: (ctx, sit) => {
    if (sit.pvp) return false; // против игроков — другая логика
    if (sit.hp !== 'low' && sit.hp !== 'mid') return false; // только когда HP не высокий
    if (sit.dist != null && sit.dist > 5) return false; // враг слишком далеко
    if (hasWeapon(ctx.bot)) return false; // если есть оружие — лучше бить (fight)
    return (sit.enemy === 'zombie' || sit.enemy === 'husk' || sit.enemy === 'drowned' || sit.count === '2-3' || sit.count === '4+') && (sit.blocks || 0) >= 3;
  },
  async run(ctx, t, p, sit) {
    const bot = ctx.bot;
    const me = bot.entity.position;
    const done = C.measure(ctx);

    // Находим ближайшего врага
    const foe = C.foeDist(ctx) != null ? null : null; // foeDist возвращает дистанцию, нам нужна позиция
    let target = null;
    const felt = require('../../felt').knownAttackers(ctx);
    const { isHostile } = require('../../util');
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || !isHostile(e)) continue;
      if (me.distanceTo(e.position) <= 5) { target = e; break; }
    }
    if (!target && felt.length) target = felt[0];

    if (target) {
      const wallPos = findWallPos(bot, target.position, me);
      if (wallPos && hasPlaceableBlocks(bot)) {
        // Ставим стену
        t.progress('ставим стену от зомби');
        try {
          await basic.placeBlockAt(ctx, t, wallPos, { timeout: 5000 });
          // Ждём немного, чтобы моб застрял за стеной
          await t.sleep(1000);
          return done({ walled: true });
        } catch (e) { if (e.aborted) throw e; }
      }
    }

    // Не получилось поставить стену — бьём тем, что в руке
    t.progress('бей тем, что в руке');
    const melee = require('../../melee');
    let lastHit = 0;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      t.check();
      const e = target;
      if (!e || !bot.entities[e.id] || me.distanceTo(e.position) > melee.HIT_REACH + 0.5) break;
      await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true);
      const cd = melee.cooldownMs(bot.heldItem && bot.heldItem.name);
      if (Date.now() - lastHit >= cd) {
        bot.attack(e);
        lastHit = Date.now();
      }
      await t.sleep(50);
    }
    return done({ fought: true });
  }
};