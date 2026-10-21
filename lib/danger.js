// Законы игры (ядро): «время до смерти» по каждой угрозе — воздух, огонь, лава, голод, падение, входящий урон, пустота.
// Только факты и числа для /snapshot (блок danger). Ядро по ним НИЧЕГО не делает — решает поведение и мозг.
// Правила Minecraft (Java): воздуха 300 тиков = 15 с, потом утопление 2 урона/с; лава 4 урона за удар, удары не чаще
// раза в 0.5 с (8/с); блок огня 1 за удар (2/с), синий огонь 2 (4/с); горение 1/с; голод при сытости 0 — 1 урон раз
// в 4 с (лёгкая сложность — до 10 HP, нормальная — до 1 HP, сложная — до смерти); бег нельзя при сытости <= 6;
// падение — урон = высота − 3 (вода, слизь, паутина, снег-порошок гасят; сено −80%, кровать −50%); пустота ниже дна
// мира — 4 урона раз в 0.5 с (8/с). Броня, зачарования и эффекты (кроме огнестойкости) НЕ учтены — числа грубые.
'use strict';

const AIR_SEC = 15, DROWN_DPS = 2;
const LAVA_DPS = 8, FIRE_DPS = 2, SOUL_FIRE_DPS = 4, BURN_DPS = 1;
const STARVE_EVERY_SEC = 4, SPRINT_MIN_FOOD = 7, REGEN_FOOD = 18;
const VOID_DPS = 8;
const DAMAGE_WINDOW_MS = 5000;
const SOFT_LANDING = { water: 0, bubble_column: 0, slime_block: 0, cobweb: 0, powder_snow: 0, hay_block: 0.2, scaffolding: 0 };
const NOTE = 'броня, зачарования и эффекты (кроме огнестойкости) не учтены';

const r1 = x => Math.round(x * 10) / 10;
const ttd = (hp, dps) => dps > 0 ? r1(hp / dps) : null;

// Время свободного падения с высоты h (блоков) при начальной скорости vy (блок/тик, вниз < 0): физика Minecraft по тикам
function fallTimeSec(h, vy = 0) {
  let y = 0, v = vy, t = 0;
  while (y > -h && t < 2000) { v = (v - 0.08) * 0.98; y += v; t++; }
  return r1(t / 20);
}

// s — состояние (чистые данные, можно собрать руками в тесте):
// { hp, food, saturation, difficulty, y, minY, headUnderSec, air (тиков 0..300 от сервера или null), feet, head (имена блоков),
//   onFire, fireResistance, onGround, velY, fall: {height, landing}|null (до опоры под ногами), hurt: [{t, amount}], now }
function compute(s) {
  const hp = Math.max(0, Number(s.hp) || 0);
  const now = s.now || Date.now();
  const out = { hp: r1(hp), note: NOTE };
  const liquidAt = n => n === 'water' || n === 'bubble_column';

  // ---- воздух ----
  const headWet = liquidAt(s.head);
  if (headWet) {
    const byTime = Math.max(0, AIR_SEC - (Number(s.headUnderSec) || 0));
    const byServer = s.air != null && s.air < 300 ? s.air / 20 : null; // сервер в 26.1 врёт на суше — под водой берём меньшее
    const airSec = r1(byServer != null ? Math.min(byServer, byTime) : byTime);
    out.air = { underWater: true, airSec, airMaxSec: AIR_SEC, source: byServer != null ? 'сервер и время под водой (меньшее)' : 'по времени под водой',
      drownDps: DROWN_DPS, lifeAfterAirSec: ttd(hp, DROWN_DPS), ttdSec: r1(airSec + hp / DROWN_DPS) };
  } else out.air = { underWater: false, airSec: AIR_SEC, ttdSec: null };

  // ---- огонь и лава ----
  const inLava = [s.feet, s.head].includes('lava');
  const fireBlock = [s.feet, s.head].includes('soul_fire') ? 'soul_fire' : [s.feet, s.head].includes('fire') ? 'fire' : null;
  const fr = !!s.fireResistance;
  const fireDps = fr ? 0 : fireBlock === 'soul_fire' ? SOUL_FIRE_DPS : fireBlock ? FIRE_DPS : s.onFire ? BURN_DPS : 0;
  out.fire = { inFire: !!fireBlock, burning: !!s.onFire, dps: fireDps, ttdSec: ttd(hp, fireDps), ...(fr ? { fireResistance: true } : {}) };
  const lavaDps = fr ? 0 : inLava ? LAVA_DPS : 0;
  out.lava = { inLava, dps: lavaDps, ttdSec: ttd(hp, lavaDps), ...(fr ? { fireResistance: true } : {}) };

  // ---- голод ----
  const food = Number(s.food) || 0;
  const diff = String(s.difficulty || 'normal');
  const floorHp = diff === 'hard' ? 0 : diff === 'easy' ? 10 : diff === 'peaceful' ? hp : 1;
  const starving = food <= 0;
  out.hunger = { food, saturation: s.saturation != null ? r1(s.saturation) : null, canSprint: food >= SPRINT_MIN_FOOD, regen: food >= REGEN_FOOD,
    starving, difficulty: diff,
    damageStarts: starving ? 'идёт: 1 урон раз в 4 с' : 'при сытости 0 (когда — зависит от бега, прыжков, драки)',
    ttdSec: starving && hp > floorHp && floorHp === 0 ? hp * STARVE_EVERY_SEC : null,
    ...(starving && floorHp > 0 ? { stopsAtHp: floorHp } : {}) };

  // ---- падение ----
  if (s.onGround || !s.fall) out.fall = { height: s.onGround ? 0 : null, damage: 0, ttdSec: null, ...(s.fall === null && !s.onGround ? { landing: 'пустота до дна мира' } : {}) };
  else {
    const h = Math.max(0, Number(s.fall.height) || 0), land = s.fall.landing || '?';
    const k = SOFT_LANDING[land] != null ? SOFT_LANDING[land] : land.endsWith('_bed') ? 0.5 : 1;
    const dmg = Math.max(0, Math.ceil((h - 3) * k));
    const lethal = dmg >= hp && hp > 0;
    out.fall = { height: r1(h), landing: land, damage: dmg, lethal, falling: (Number(s.velY) || 0) < -0.1,
      ttdSec: lethal ? fallTimeSec(h, Math.min(0, Number(s.velY) || 0)) : null };
  }

  // ---- входящий урон ----
  const recent = (s.hurt || []).filter(h => now - h.t <= DAMAGE_WINDOW_MS);
  const sum = recent.reduce((a, h) => a + (Number(h.amount) || 0), 0);
  const dps = sum / (DAMAGE_WINDOW_MS / 1000);
  out.damage = { last5s: r1(sum), hits: recent.length, dps: r1(dps), ttdSec: ttd(hp, dps) };

  // ---- пустота ----
  const minY = Number.isFinite(s.minY) ? s.minY : -64;
  const below = Number(s.y) < minY;
  out.void = { y: s.y != null ? r1(s.y) : null, minY, below, voidUnder: !s.onGround && s.fall === null, dps: below ? VOID_DPS : 0, ttdSec: below ? ttd(hp, VOID_DPS) : null };

  // ---- самое срочное ----
  let worst = null;
  for (const k of ['air', 'fire', 'lava', 'hunger', 'fall', 'damage', 'void']) {
    const t = out[k] && out[k].ttdSec;
    if (t != null && (!worst || t < worst.ttdSec)) worst = { kind: k, ttdSec: t };
  }
  out.worst = worst;
  return out;
}

// Высота до опоры под ногами: первый не-воздушный блок вниз до дна мира. -> {height, landing} | null (пустота)
function fallScan(bot, minY) {
  const p = bot.entity.position;
  const V = p.constructor;
  for (let y = Math.floor(p.y) - (Number.isInteger(p.y) ? 1 : 0); y >= minY; y--) {
    let b = null; try { b = bot.blockAt(new V(Math.floor(p.x), y, Math.floor(p.z))); } catch (e) {}
    if (!b) return { height: null, landing: 'чанк не загружен' };
    if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || (b.boundingBox === 'empty' && !['water', 'lava', 'bubble_column', 'cobweb', 'powder_snow', 'scaffolding'].includes(b.name))) continue;
    const top = b.boundingBox === 'block' ? y + 1 : y + (b.name === 'water' || b.name === 'lava' ? 0.9 : 1);
    return { height: Math.max(0, p.y - top), landing: b.name };
  }
  return null;
}

function hasEffect(bot, name) {
  try {
    const eff = bot.registry.effectsByName && bot.registry.effectsByName[name];
    const effs = bot.entity.effects || {};
    return !!(eff && (effs[eff.id] || Object.values(effs).some(e => e && e.id === eff.id)));
  } catch (e) { return false; }
}

// Состояние из живого бота
function state(ctx) {
  const bot = ctx.bot, p = bot.entity.position;
  const at = dy => { try { const b = bot.blockAt(p.offset(0, dy, 0)); return b ? b.name : null; } catch (e) { return null; } };
  const minY = bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64;
  const flags = bot.entity.metadata && bot.entity.metadata[0];
  let fall = null;
  if (!bot.entity.onGround) { fall = fallScan(bot, minY); if (fall && fall.height == null) fall = { height: 0, landing: fall.landing }; }
  return {
    hp: bot.health, food: bot.food, saturation: bot.foodSaturation, difficulty: bot.game && bot.game.difficulty,
    y: p.y, minY, head: at(1.6), feet: at(0.1),
    headUnderSec: ctx.headUnderSince ? (Date.now() - ctx.headUnderSince) / 1000 : 0,
    air: bot.oxygenLevel != null ? bot.oxygenLevel * 15 : null, // mineflayer: 0..20 «пузырей», 1 пузырь = 15 тиков
    onFire: typeof flags === 'number' && (flags & 1) === 1, fireResistance: hasEffect(bot, 'fire_resistance'),
    onGround: !!bot.entity.onGround, velY: bot.entity.velocity ? bot.entity.velocity.y : 0, fall,
    hurt: ctx.hurtLog || [], now: Date.now()
  };
}

// /snapshot: блок danger
function decorate(ctx, snap) {
  try {
    if (!snap || !snap.ready || !ctx.bot || !ctx.bot.entity) return snap;
    snap.danger = compute(state(ctx));
  } catch (e) { if (snap) snap.danger = { error: String(e && e.message || e) }; }
  return snap;
}

module.exports = { compute, state, decorate, fallScan, fallTimeSec, AIR_SEC, DROWN_DPS, LAVA_DPS, VOID_DPS };
