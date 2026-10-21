// Панель локатора (locator bar, с 1.21.6): в мультиплеере заменяет полоску опыта
// и показывает метки направления на других игроков.
//
// Отдельного пакета в протоколе НЕТ: клиент рисует метки по позициям игроков,
// которые и так приходят обычными пакетами сущностей. Берём те же данные и
// повторяем правила видимости — никакого чтения того, чего не видел бы игрок.
//
// Правила (как в игре):
//   - метка видна, если игрок в конусе 120° вокруг взгляда;
//   - игрок выше/ниже -> стрелка ↑/↓;
//   - скрыт, если крадётся, на голове моб-голова/тыква, или действует невидимость.
'use strict';
const { r1, dirName } = require('./util');

const CONE_DEG = 120;        // полный конус видимости метки
const VERT_DEG = 25;         // |вертикальный угол| больше -> стрелка ↑/↓ (подбор по поведению клиента)
const INVISIBILITY_ID = 13;  // minecraft-data 26.1, effects.json -> Invisibility id 13

// Головы мобов и тыквы скрывают игрока на панели
const HIDE_HEADS = new Set([
  'player_head', 'player_wall_head', 'zombie_head', 'zombie_wall_head',
  'creeper_head', 'creeper_wall_head', 'skeleton_skull', 'skeleton_wall_skull',
  'wither_skeleton_skull', 'wither_skeleton_wall_skull',
  'dragon_head', 'dragon_wall_head', 'piglin_head', 'piglin_wall_head',
  'pumpkin', 'carved_pumpkin', 'jack_o_lantern'
]);

// Локальный вектор взгляда по yaw/pitch.
// Minecraft: yaw 0 = юг (+Z), растёт против часовой; pitch -90 = взгляд вверх.
function lookVector(bot) {
  const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: -Math.sin(pitch), z: Math.cos(yaw) * cp };
}

// Шлем: prismarine-entity хранит equipment[0] = рука, дальше броня (сырой слот протокола).
function headItem(entity) {
  try {
    const eq = entity.equipment;
    if (!eq) return null;
    for (const i of [5, 4]) { // 5 = шлем в протоколе 1.20.2+; 4 — на случай иной раскладки
      const it = eq[i];
      if (it && it.name) return it.name;
    }
  } catch (e) {}
  return null;
}

function hideReason(entity) {
  try { if (entity.crouching) return 'крадётся'; } catch (e) {}
  const h = headItem(entity);
  if (h && HIDE_HEADS.has(h)) return 'на голове ' + h;
  try {
    if (entity.effects && entity.effects[INVISIBILITY_ID]) return 'невидимость';
  } catch (e) {}
  return null;
}

// Игроки, которых видно на панели локатора.
// radius = 0 -> весь мир (как в игре: панель дальнобойная, дальше только чанки).
function playersOnBar(ctx, { radius = 0, limit = 12 } = {}) {
  const bot = ctx.bot;
  const me = bot.entity.position;
  const lv = lookVector(bot);
  const lvLen = Math.hypot(lv.x, lv.z) || 1e-6;
  const out = [];

  for (const pl of Object.values(bot.players)) {
    if (!pl || pl.username === bot.username) continue;
    const e = pl.entity;
    if (!e || !e.position) continue; // есть в табе, но чанк не загружен -> позиции нет

    const dx = e.position.x - me.x, dy = e.position.y - me.y, dz = e.position.z - me.z;
    const d = Math.hypot(dx, dy, dz);
    if (radius && d > radius) continue;

    const hl = Math.hypot(dx, dz) || 1e-6;
    const cosA = (lv.x * dx + lv.z * dz) / (lvLen * hl);
    const ang = Math.acos(Math.max(-1, Math.min(1, cosA))) * 180 / Math.PI;
    const cross = lv.x * dz - lv.z * dx; // >0 -> цель справа от взгляда
    const vertAng = Math.atan2(dy, hl) * 180 / Math.PI;

    out.push({
      name: pl.username,
      d: r1(d),
      dir: dirName(me, e.position),
      at: [Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)],
      ang: r1(ang),
      side: cross > 0 ? 'справа' : 'слева',
      onBar: ang <= CONE_DEG / 2,
      vert: vertAng > VERT_DEG ? '↑' : (vertAng < -VERT_DEG ? '↓' : null),
      hidden: hideReason(e),
      gamemode: pl.gamemode || null
    });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, limit);
}

module.exports = { playersOnBar, lookVector, headItem, hideReason, CONE_DEG, VERT_DEG };
