// Законы игры (ядро): «время до смерти» по каждой угрозе — воздух, огонь, лава, голод, падение, входящий урон, пустота, мобы рядом
// (чем кончится бой: сколько ударов муха выдержит, успеет ли перебить — fight/outlook; по этому, а не по порогу HP, решает поведение).
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
const DRIPSTONE_DPS = 2; // pointed_dripstone: ~1-3 урона/с при стоянии на нём
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

  // ---- указалки (сталагмиты) ----
  const onDripstone = [s.feet, s.head].includes('pointed_dripstone');
  const dripstoneDps = onDripstone ? DRIPSTONE_DPS : 0;
  out.dripstone = { onDripstone, dps: dripstoneDps, ttdSec: ttd(hp, dripstoneDps) };

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

  // ---- мобы рядом: чем кончится бой здесь и сейчас ----
  if (s.mobs && s.mobs.length) out.mobs = fight({ hp, difficulty: s.difficulty, weapon: s.weapon, mobs: s.mobs });

  // ---- самое срочное ----
  let worst = null;
  if (out.mobs && !out.mobs.win && out.mobs.ttdSec != null) worst = { kind: 'mobs', ttdSec: out.mobs.ttdSec };
  for (const k of ['air', 'fire', 'lava', 'dripstone', 'hunger', 'fall', 'damage', 'void']) {
    const t = out[k] && out[k].ttdSec;
    if (t != null && (!worst || t < worst.ttdSec)) worst = { kind: k, ttdSec: t };
  }
  out.worst = worst;
  return out;
}

// ---- Бой: чем кончится встреча с этими мобами (по последствию, а не по порогу HP) ----
// Числа Java на нормальной сложности (лёгкая ×0.5+1, сложная ×1.5): dmg — урон за удар, every — с между ударами,
// hp — здоровье моба, speed — блок/с к мухе, ranged — бьёт издалека (подходить к нему надо мухе), boom — взрыв через fuse с.
const MOBS = {
  zombie: { dmg: 3, every: 1, hp: 20, speed: 2.3 }, husk: { dmg: 3, every: 1, hp: 20, speed: 2.3 },
  drowned: { dmg: 3, every: 1, hp: 20, speed: 2.3 }, zombie_villager: { dmg: 3, every: 1, hp: 20, speed: 2.3 },
  skeleton: { dmg: 3, every: 2, hp: 20, speed: 2.5, ranged: true }, stray: { dmg: 3, every: 2, hp: 20, speed: 2.5, ranged: true },
  bogged: { dmg: 3, every: 2, hp: 16, speed: 2.5, ranged: true },
  spider: { dmg: 2, every: 1, hp: 16, speed: 3 }, cave_spider: { dmg: 2, every: 1, hp: 12, speed: 3 },
  creeper: { dmg: 22, hp: 20, speed: 2, boom: true, fuse: 1.5 },
  enderman: { dmg: 7, every: 1, hp: 40, speed: 6 }, zombified_piglin: { dmg: 8, every: 1, hp: 20, speed: 2.3 },
  witch: { dmg: 6, every: 3, hp: 26, speed: 2.5, ranged: true }, pillager: { dmg: 4, every: 1.5, hp: 24, speed: 3, ranged: true },
  vindicator: { dmg: 13, every: 1, hp: 24, speed: 3.5 }, phantom: { dmg: 2, every: 1.5, hp: 20, speed: 5 },
  slime: { dmg: 4, every: 1, hp: 16, speed: 2 }, magma_cube: { dmg: 6, every: 1, hp: 16, speed: 2 },
  silverfish: { dmg: 1, every: 1, hp: 8, speed: 2.5 }, blaze: { dmg: 5, every: 1.5, hp: 20, speed: 2, ranged: true },
  wither_skeleton: { dmg: 8, every: 1, hp: 20, speed: 2.5 }, piglin_brute: { dmg: 13, every: 1, hp: 50, speed: 3.5 },
  hoglin: { dmg: 6, every: 1, hp: 40, speed: 3 }, ravager: { dmg: 12, every: 1, hp: 100, speed: 3 },
  guardian: { dmg: 6, every: 3, hp: 30, speed: 1.5, ranged: true }, warden: { dmg: 30, every: 1, hp: 500, speed: 3 }
};
const MOB_DEFAULT = { dmg: 3, every: 1, hp: 20, speed: 2.5 }; // неизвестный враждебный — как зомби
// Оружие мухи: урон за удар и ударов в секунду (полный замах); кулак — 1 урон
const WEAPONS = {
  fist: { dmg: 1, perSec: 2, knock: 0.3 }, // knock — на сколько с удар отбрасывает моба (у оружия — KNOCK_SEC)
  wooden_sword: { dmg: 4, perSec: 1.6 }, golden_sword: { dmg: 4, perSec: 1.6 }, stone_sword: { dmg: 5, perSec: 1.6 },
  iron_sword: { dmg: 6, perSec: 1.6 }, diamond_sword: { dmg: 7, perSec: 1.6 }, netherite_sword: { dmg: 8, perSec: 1.6 },
  wooden_axe: { dmg: 7, perSec: 0.8 }, golden_axe: { dmg: 7, perSec: 1 }, stone_axe: { dmg: 9, perSec: 0.8 },
  iron_axe: { dmg: 9, perSec: 0.9 }, diamond_axe: { dmg: 9, perSec: 1 }, netherite_axe: { dmg: 10, perSec: 1 },
  trident: { dmg: 9, perSec: 1.1 }, mace: { dmg: 6, perSec: 0.6 }
};
const MY_SPEED = 4.3, REACH = 2.5, MOB_R = 16, KNOCK_SEC = 1; // KNOCK_SEC — удар мухи отбрасывает моба ближнего боя на ~2 блока: бьёт снова не раньше чем через столько
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin']); // сами не нападают — в счёт, только если бьют муху
const weaponDps = n => { const w = WEAPONS[n] || WEAPONS.fist; return w.dmg * w.perSec; };
function bestWeapon(names) {
  let best = 'fist';
  for (const n of names || []) if (WEAPONS[n] && weaponDps(n) > weaponDps(best)) best = n;
  return best;
}
function mobInfo(name, difficulty) {
  const m = MOBS[name] || MOB_DEFAULT;
  const d = String(difficulty || 'normal');
  const k = d === 'hard' ? 1.5 : 1;
  const dmg = d === 'peaceful' ? 0 : d === 'easy' ? Math.round(m.dmg * 0.5 + 1) : Math.round(m.dmg * k * 10) / 10;
  return { ...m, dmg, known: !!MOBS[name] };
}

// Встреча: s = { hp, difficulty, weapon (имя предмета | 'fist'), mobs: [{name, d}] } -> что будет, если драться здесь и сейчас.
// Счёт по шагам 0.05 с: мобы подходят (speed), бьют по своему ритму; муха бьёт ближайшего живого (к стрелку сначала идёт).
// win — муха перебьёт всех и останется жива (запас 2 HP: броня и промахи не учтены; отброс от удара мухи — учтён). ttdSec — когда умрёт, если проиграет.
// hitsToDie — сколько ударов самого сильного моба муха выдержит. Броня и щит НЕ учтены.
function fight(s, passive = false) {
  const hp0 = Math.max(0, Number(s.hp) || 0);
  const weapon = WEAPONS[s.weapon] ? s.weapon : 'fist', W = passive ? { dmg: 0, perSec: 1 } : WEAPONS[weapon];
  const list = (s.mobs || []).filter(m => m && m.name).map(m => ({ name: m.name, d: Math.max(0, Number(m.d) || 0), ...mobInfo(m.name, s.difficulty) }));
  if (!list.length) return null;
  const per = list.map(m => {
    const arrive = m.ranged ? 0 : Math.max(0, m.d - REACH) / m.speed;
    const myTtk = W.dmg > 0 ? Math.ceil(m.hp / W.dmg) / W.perSec : Infinity;
    const hitsToKillMe = m.dmg > 0 ? Math.ceil(hp0 / m.dmg) : null;
    const theirTtd = m.dmg <= 0 ? null : m.boom ? (m.dmg >= hp0 ? r1(arrive + m.fuse) : null) : r1(arrive + (hitsToKillMe - 1) * m.every);
    return { name: m.name, d: r1(m.d), hitsToKillMe, theirTtdSec: theirTtd, myTtkSec: r1(myTtk + (m.ranged ? Math.max(0, m.d - REACH) / MY_SPEED : 0)), ...(m.known ? {} : { unknown: true }) };
  });
  // общий счёт
  const mobs = list.map(m => ({ ...m, left: m.hp, arrive: m.ranged ? 0 : Math.max(0, m.d - REACH) / m.speed, next: null, alive: true }));
  let hp = hp0, t = 0, myNext = 0, walk = 0;
  const DT = 0.05, END = 120;
  let ttd = null;
  while (t < END) {
    for (const m of mobs) {
      if (!m.alive || m.dmg <= 0) continue;
      if (m.next == null) m.next = m.arrive + (m.boom ? m.fuse : 0);
      if (t >= m.next) { hp -= m.dmg; if (m.boom) m.alive = false; else m.next += m.every; }
    }
    if (hp <= 0) { ttd = r1(t); break; }
    const alive = mobs.filter(m => m.alive);
    if (!alive.length) break;
    const reachIn = m => m.ranged ? Math.max(0, m.d - REACH) / MY_SPEED : m.arrive; // когда муха сможет ударить
    const tgt = alive.slice().sort((a, b) => reachIn(a) - reachIn(b) || a.d - b.d)[0];
    const near = tgt.ranged ? walk >= Math.max(0, tgt.d - REACH) / MY_SPEED : t >= tgt.arrive;
    if (!near) walk += DT;
    else if (t >= myNext) {
      tgt.left -= W.dmg; myNext = t + 1 / W.perSec;
      if (tgt.left <= 0) { tgt.alive = false; walk = 0; }
      else if (!tgt.ranged && !tgt.boom && tgt.next != null) tgt.next = Math.max(tgt.next, t + (W.knock != null ? W.knock : KNOCK_SEC)); // отброс: моб возвращается
    }
    t += DT;
  }
  const survived = ttd == null && mobs.every(m => !m.alive);
  const maxHit = Math.max(...list.map(m => m.dmg));
  return {
    weapon, hp: r1(hp0), mobs: per, win: survived && hp >= 2, ttdSec: ttd,
    killAllSec: survived ? r1(t) : null, hpLeft: survived ? r1(Math.max(0, hp)) : 0,
    hitsToDie: maxHit > 0 ? Math.ceil(hp0 / maxHit) : null,
    ...(passive ? {} : { passiveTtdSec: (fight(s, true) || {}).ttdSec }), // если не отбиваться (копать укрытие, ждать) — когда умрёт
    ...(s.typical ? { typical: true } : {})
  };
}

// Враждебные рядом (в MOB_R) и лучшее оружие — из живого бота. attackerId — кто бьёт (нейтрала тогда считаем)
function fightState(bot, attackerId) {
  const p = bot.entity.position;
  const mobs = Object.values(bot.entities || {}).filter(e => e && e !== bot.entity && e.position && e.type !== 'player' &&
    (e.type === 'hostile' || MOBS[e.name]) && (!NEUTRAL.has(e.name) || e.id === attackerId) && e.position.distanceTo(p) <= MOB_R)
    .map(e => ({ name: e.name, d: e.position.distanceTo(p) }));
  let items = []; try { items = bot.inventory.items().map(i => i.name); } catch (e) {}
  return { hp: bot.health, difficulty: bot.game && bot.game.difficulty, weapon: bestWeapon(items), mobs };
}
// Исход встречи для поведения: с мобами рядом — с ними; никого нет — с обычным ночным мобом (зомби в 8 м), typical: true
function outlook(bot, attackerId) {
  try {
    const s = fightState(bot, attackerId);
    if (!s.mobs.length) return fight({ ...s, mobs: [{ name: 'zombie', d: 8 }], typical: true });
    return fight(s);
  } catch (e) { return null; }
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
    hurt: ctx.hurtLog || [], now: Date.now(),
    ...(() => { const f = fightState(bot); return { mobs: f.mobs, weapon: f.weapon }; })()
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

module.exports = { compute, state, decorate, fallScan, fallTimeSec, fight, fightState, outlook, bestWeapon, mobInfo, MOBS, WEAPONS, AIR_SEC, DROWN_DPS, LAVA_DPS, VOID_DPS, DRIPSTONE_DPS };
