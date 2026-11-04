// Панель локатора (locator bar, с 1.21.6): в мультиплеере заменяет полоску опыта
// и показывает метки направления на других игроков.
//
// Ближние игроки — по позициям, которые и так приходят пакетами сущностей (повторяем правила видимости).
// Дальние (за прорисовкой) — по пакету tracked_waypoint: сервер шлёт метку игроку сам, как настоящему клиенту
// (рядом — точный блок, дальше — чанк, совсем далеко — только направление, azimuth). Это ровно то, что игрок видит
// на панели, — никакого чтения сверх. Скрытых (крадётся, голова/тыква, невидимость) и зрителей сервер не шлёт.
//
// Правила (как в игре):
//   - метка видна, если игрок в конусе 120° вокруг взгляда;
//   - игрок выше/ниже -> стрелка ↑/↓;
//   - скрыт, если крадётся, на голове моб-голова/тыква, или действует невидимость.
'use strict';
const { r1, dirName, isObserver } = require('./util');

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

// Метки tracked_waypoint: uuid (без дефисов) -> { kind: 'vec3i'|'chunk'|'azimuth', at?, chunk?, azimuth?, t }.
// Подключать сразу после createBot (метки шлются при входе и при смене «дальности» связи, повторно — только при движении).
const norm = u => String(u || '').replace(/-/g, '').toLowerCase();
function attachWaypoints(bot) {
  if (!bot || !bot._client || bot.__waypoints) return;
  const wp = bot.__waypoints = new Map();
  bot._client.on('tracked_waypoint', pk => {
    try {
      const w = pk && pk.waypoint;
      if (!w) return;
      const id = w.hasUUID ? norm(w.uuid) : String(w.id || '');
      if (!id) return;
      if (pk.operation === 'untrack') { wp.delete(id); return; }
      const d = w.data, rec = { kind: w.type, t: Date.now() };
      if (w.type === 'vec3i' && d) rec.at = [d.x, d.y, d.z];
      else if (w.type === 'chunk' && d) rec.chunk = [d.chunkX, d.chunkZ];
      else if (w.type === 'azimuth' && typeof d === 'number') rec.azimuth = d;
      else if (w.type === 'azimuth' && d && typeof d.azimuth === 'number') rec.azimuth = d.azimuth;
      else return;
      wp.set(id, rec);
    } catch (e) {}
  });
}
// Где метка: { dx, dz, dy, d, at } от меня; azimuth — только направление (d = null), сервер шлёт его дальше ~330 блоков.
// Азимут — угол в соглашении yaw Minecraft (0 = юг +Z, π/2 = запад −X) от меня к игроку: сервер считает его как atan2 от
// (я − он), повёрнутого на 90°, а клиент сравнивает с yaw камеры. Отсюда направление (−sin a, cos a).
function waypointGeo(rec, me) {
  if (rec.at) { const dx = rec.at[0] + 0.5 - me.x, dy = rec.at[1] - me.y, dz = rec.at[2] + 0.5 - me.z; return { dx, dy, dz, d: Math.hypot(dx, dy, dz), at: rec.at.slice() }; }
  if (rec.chunk) { const x = rec.chunk[0] * 16 + 8, z = rec.chunk[1] * 16 + 8, dx = x - me.x, dz = z - me.z; return { dx, dy: 0, dz, d: Math.hypot(dx, dz), at: [x, Math.floor(me.y), z] }; }
  if (typeof rec.azimuth === 'number') return { dx: -Math.sin(rec.azimuth), dy: 0, dz: Math.cos(rec.azimuth), d: null, at: null };
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
    if (!pl || pl.username === bot.username || isObserver(pl.username)) continue;
    const e = pl.entity;
    if (!e || !e.position) {   // за прорисовкой: только метка сервера (tracked_waypoint), если она есть
      const rec = bot.__waypoints && bot.__waypoints.get(norm(pl.uuid));
      const g = rec && waypointGeo(rec, me);
      if (!g || (radius && g.d != null && g.d > radius)) continue;
      const hl = Math.hypot(g.dx, g.dz) || 1e-6;
      const ang = Math.acos(Math.max(-1, Math.min(1, (lv.x * g.dx + lv.z * g.dz) / (lvLen * hl)))) * 180 / Math.PI;
      out.push({
        name: pl.username, d: g.d == null ? null : r1(g.d), far: true, src: 'waypoint', kind: rec.kind,
        dir: dirName(me, { x: me.x + g.dx * 100, y: me.y, z: me.z + g.dz * 100 }), at: g.at,
        ...(g.d == null ? { heading: [r1(g.dx), r1(g.dz)] } : {}),
        ang: r1(ang), side: (lv.x * g.dz - lv.z * g.dx) > 0 ? 'справа' : 'слева', onBar: ang <= CONE_DEG / 2,
        vert: null, hidden: null, gamemode: pl.gamemode != null ? pl.gamemode : null, ago: Math.round((Date.now() - rec.t) / 1000)
      });
      continue;
    }

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
  out.sort((a, b) => (a.d == null ? 1e9 : a.d) - (b.d == null ? 1e9 : b.d));
  return out.slice(0, limit);
}

module.exports = { playersOnBar, attachWaypoints, waypointGeo, lookVector, headItem, hideReason, CONE_DEG, VERT_DEG };
