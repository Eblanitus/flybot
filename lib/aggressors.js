// Самооборона от игроков: учёт агрессоров. Агрессор — игрок, ударивший нас не более AGGRO_MS назад.
// Бить игроков можно ТОЛЬКО пока они агрессоры; всех остальных (и мирных игроков) — никогда.
'use strict';
const { entName, r1 } = require('./util');

const AGGRO_MS = 120000;       // сколько секунд после последнего удара игрок считается агрессором
const CHASE_MAX = 16;          // дальше этого от агрессора не гонимся

function store(ctx) { return ctx.aggressors || (ctx.aggressors = {}); }
function key(name) { return String(name || '').toLowerCase(); }

// Записать удар игрока по нам
function record(ctx, name) {
  const k = key(name); if (!k) return null;
  const s = store(ctx);
  const cur = s[k] && Date.now() - s[k].lastHit <= AGGRO_MS ? s[k] : null;
  s[k] = { name: String(name), lastHit: Date.now(), hits: (cur ? cur.hits : 0) + 1 };
  return s[k];
}

function isAggressor(ctx, name) {
  const a = store(ctx)[key(name)];
  return !!a && Date.now() - a.lastHit <= AGGRO_MS;
}

// Сущность — игрок-агрессор (не мы сами)
function isAggressorEntity(ctx, e) {
  return !!e && e.type === 'player' && e !== ctx.bot.entity && isAggressor(ctx, entName(e));
}

// Действующие агрессоры: [{name, agoSec, d}] (d = null, если игрока сейчас не видно)
function list(ctx) {
  const bot = ctx.bot; const out = [];
  const s = store(ctx);
  for (const k of Object.keys(s)) {
    const a = s[k];
    if (Date.now() - a.lastHit > AGGRO_MS) { delete s[k]; continue; }
    let d = null;
    try {
      const pl = bot.players[a.name] || Object.values(bot.players).find(p => p.username.toLowerCase() === k);
      if (pl && pl.entity && bot.entity) d = r1(bot.entity.position.distanceTo(pl.entity.position));
    } catch (e) {}
    out.push({ name: a.name, agoSec: Math.round((Date.now() - a.lastHit) / 1000), hits: a.hits, d });
  }
  return out.sort((x, y) => x.agoSec - y.agoSec);
}

// Если сервер не сказал, кто нас ударил: ближайший игрок в 4.5 м, махнувший рукой <0.7 с назад и смотрящий в нашу сторону
function guessAttacker(bot, swings) {
  const me = bot.entity.position; const now = Date.now();
  let best = null, bd = 4.5;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue;
    const sw = swings.get(e.id); if (!sw || now - sw > 700) continue;
    const dx = me.x - e.position.x, dz = me.z - e.position.z; const d = Math.hypot(dx, dz);
    if (d < 0.01 || d > bd) continue;
    // направление взгляда в Minecraft: (-sin(yaw), -cos(yaw))
    const dot = (-Math.sin(e.yaw) * dx - Math.cos(e.yaw) * dz) / d;
    if (dot < 0.5) continue;
    bd = d; best = e;
  }
  return best;
}

module.exports = { AGGRO_MS, CHASE_MAX, record, isAggressor, isAggressorEntity, list, guessAttacker };
