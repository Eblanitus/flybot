// Ближний бой: чистая математика досягаемости и решение «бить / отойти / подойти» + мелкие помощники движения.
// Досягаемость survival — 3.0 блока от глаз до ближайшей точки хитбокса цели (хитбокс = позиция ± width/2, высота height).
'use strict';

const REACH = 3.0;       // честная досягаемость survival
const HIT_REACH = 2.9;   // бьём с запасом 0.1 (лаг позиции моба), чтобы сервер не отбросил удар
const HOLD = 2.4;        // пока оружие заряжается, ближе этого (до хитбокса) — отходим
const CLOSE = 1.8;       // для стрелков: пока не бьём, всё равно сближаемся до этого
const LUNGE_MIN = 1.2;   // ближе — разбег бессмыслен
const LUNGE_MS = 70;     // дольше одного тика, чтобы сервер успел принять «спринт» раньше удара
const EYE = 1.62;

// Расстояние от точки (глаз) до ближайшей точки хитбокса, xyz — центр основания
function boxDist(eye, pos, width, height) {
  const hw = (width > 0 ? width : 0.6) / 2, h = height > 0 ? height : 1.8;
  const dx = Math.max(pos.x - hw - eye.x, 0, eye.x - (pos.x + hw));
  const dy = Math.max(pos.y - eye.y, 0, eye.y - (pos.y + h));
  const dz = Math.max(pos.z - hw - eye.z, 0, eye.z - (pos.z + hw));
  return Math.hypot(dx, dy, dz);
}

function posOf(e) { return e && e.vehicle && e.vehicle.position ? e.vehicle.position : e && e.position; }

function eyeOf(bot) {
  const p = bot.entity.position;
  return { x: p.x, y: p.y + (bot.entity.eyeHeight || EYE), z: p.z };
}

// От глаз бота до хитбокса цели (у всадника — по транспорту)
function reachDist(bot, e) {
  const p = posOf(e);
  return p ? boxDist(eyeOf(bot), p, e.width, e.height) : Infinity;
}

// Полный заряд оружия, мс (с небольшим запасом): меч 650, топор медленнее, кулак быстрее
function cooldownMs(item) {
  const n = String(item || '');
  if (!n) return 300;
  if (n.endsWith('_sword')) return 650;
  if (n.endsWith('_axe')) { const m = n.split('_')[0]; return m === 'netherite' || m === 'diamond' ? 1050 : m === 'iron' ? 1150 : 1300; }
  if (n.endsWith('_pickaxe')) return 850;
  if (n.endsWith('_shovel') || n.endsWith('_hoe')) return 1050;
  if (n === 'trident') return 950;
  if (n === 'mace') return 1700;
  return 300; // кулак и всё прочее
}

// Решение на тик. dist — до хитбокса, ready — оружие заряжено,
// close — цель стреляет издали (скелет): дистанцию не держим, сближаемся; keep — держать дистанцию при перезарядке.
// -> 'hit' | 'back' | 'hold' | 'approach'
function decide({ dist, ready, close = false, keep = true }) {
  if (ready) return dist <= HIT_REACH ? 'hit' : 'approach';
  if (close) return dist > CLOSE ? 'approach' : 'hold';
  if (keep && dist < HOLD) return 'back';
  return dist <= REACH ? 'hold' : 'approach';
}

// Стоит ли разбег (спринт-удар даёт доп. отбрасывание): сыт, есть место до цели, не крипер, цель в зоне удара
function shouldLunge({ food, dist, creeper = false, enabled = true }) {
  return !!enabled && !creeper && food > 6 && dist >= LUNGE_MIN && dist <= HIT_REACH;
}

const HAZARD = new Set(['lava', 'water', 'fire', 'soul_fire', 'cactus', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'powder_snow', 'bubble_column']);
const isSolid = b => !!b && b.boundingBox === 'block';

// Безопасно ли шагнуть от цели (направление: от неё к нам) на ~2 блока: проходимо, не лава/вода, не обрыв глубже 1
function backIsSafe(bot, from) {
  const me = bot.entity.position, p = posOf(from);
  if (!p) return false;
  const dx = me.x - p.x, dz = me.z - p.z, l = Math.hypot(dx, dz);
  if (l < 0.05) return false;
  const ax = dx / l, az = dz / l, y = Math.floor(me.y + 0.01);
  for (const s of [0.7, 1.4, 2.1]) {
    const x = me.x + ax * s, z = me.z + az * s;
    const feet = bot.blockAt(toVec(bot, x, y, z));
    const head = bot.blockAt(toVec(bot, x, y + 1, z));
    const f1 = bot.blockAt(toVec(bot, x, y - 1, z));
    if (!feet || !head || !f1) return false; // чанк не загружен
    if (isSolid(feet) || isSolid(head) || HAZARD.has(feet.name) || HAZARD.has(head.name)) return false;
    if (HAZARD.has(f1.name)) return false;
    if (!isSolid(f1)) { // дальше пустота: допустим спуск ровно на 1
      const f2 = bot.blockAt(toVec(bot, x, y - 2, z));
      if (!f2 || !isSolid(f2) || HAZARD.has(f2.name)) return false;
    }
  }
  return true;
}
function toVec(bot, x, y, z) { const V = bot.entity.position.constructor; return new V(Math.floor(x), y, Math.floor(z)); }

// Единственное «ручное» движение в бою: назад / вперёд-со-спринтом / стоим
function setMove(bot, mode) {
  bot.setControlState('back', mode === 'back');
  bot.setControlState('forward', mode === 'lunge');
  bot.setControlState('sprint', mode === 'lunge');
}
function stopMove(bot) { try { bot.clearControlStates(); } catch (e) {} }

module.exports = { REACH, HIT_REACH, HOLD, CLOSE, LUNGE_MIN, LUNGE_MS, boxDist, reachDist, eyeOf, cooldownMs, decide, shouldLunge, backIsSafe, setMove, stopMove, posOf };
