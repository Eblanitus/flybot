// «Почувствованные» обидчики: кто нас ударил (даже если его не видно/он в темноте/сидит верхом) и откуда пришёл удар.
// Ударивший моб известен телу 10 с — fight/escape учитывают его и направление удара, даже если зрение его не показывает.
'use strict';
const { entName, isHostile } = require('./util');

const FELT_MS = 10000;
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch', 'drowned', 'breeze', 'piglin', 'shulker', 'evoker', 'illusioner']);
const MELEE_REACH = 6; // копьё зомби (26.1) достаёт дальше руки

// У всадника (зомби на зомби-лошади) сервер шлёт позицию только транспорта — своя у него устаревшая
function posOf(e) { return e && e.vehicle && e.vehicle.position ? e.vehicle.position : e && e.position; }
function distTo(bot, e) { const p = posOf(e); return p ? bot.entity.position.distanceTo(p) : Infinity; }

function nearestHostile(bot, r) {
  let best = null, bd = r;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !isHostile(e)) continue;
    const d = distTo(bot, e); if (d <= bd) { bd = d; best = e; }
  }
  return best;
}

// Кто на самом деле ударил: источник из damage_event, если он правдоподобно близко; иначе ближайший враг в 6 м
function resolveAttacker(bot, source) {
  const ok = s => s && posOf(s) && (RANGED.has(entName(s)) || distTo(bot, s) <= MELEE_REACH + 2);
  if (source && source.type === 'player') return { entity: source, sure: true };
  if (ok(source) && isHostile(source)) return { entity: source, sure: true };
  const near = nearestHostile(bot, MELEE_REACH);
  if (near) return { entity: near, sure: false };
  return { entity: source && isHostile(source) ? source : null, sure: false, far: !!source };
}

// Запомнить удар: обидчик + направление (откуда отбросило)
function feel(ctx, e) {
  const bot = ctx.bot, now = Date.now();
  if (!ctx.felt) ctx.felt = { ids: new Map(), t: 0, dir: null };
  const f = ctx.felt; f.t = now;
  if (e) f.ids.set(e.id, now);
  for (const [id, t] of f.ids) if (now - t > FELT_MS) f.ids.delete(id);
  const p = e && posOf(e), me = bot.entity.position;
  if (p && me.distanceTo(p) <= MELEE_REACH + 2) { const dx = p.x - me.x, dz = p.z - me.z, l = Math.hypot(dx, dz); if (l > 0.1) f.dir = { x: dx / l, z: dz / l }; }
  else setTimeout(() => { // источник неизвестен — направление по отбрасыванию: удар пришёл с противоположной стороны
    try { const v = bot.entity && bot.entity.velocity, l = v ? Math.hypot(v.x, v.z) : 0; if (l > 0.05 && ctx.felt === f) f.dir = { x: -v.x / l, z: -v.z / l }; } catch (er) {}
  }, 60);
}

function recentHit(ctx) { return !!(ctx.felt && Date.now() - ctx.felt.t <= FELT_MS); }
// Живые сущности, ударившие нас за 10 с
function knownAttackers(ctx) {
  if (!recentHit(ctx)) return [];
  const now = Date.now(), out = [];
  for (const [id, t] of ctx.felt.ids) { const e = ctx.bot.entities[id]; if (e && now - t <= FELT_MS && e.isValid !== false) out.push(e); }
  return out;
}
function hitDir(ctx) { return recentHit(ctx) ? ctx.felt.dir : null; }

function hasArmor(bot) { return [5, 6, 7, 8].some(i => bot.inventory.slots && bot.inventory.slots[i]); }

module.exports = { FELT_MS, RANGED, MELEE_REACH, posOf, distTo, nearestHostile, resolveAttacker, feel, recentHit, knownAttackers, hitDir, hasArmor };
