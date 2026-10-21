// Запретные зоны (ядро проверяет, список даёт поведение — behavior/zones.js): где мухе нельзя копать.
// Зона — коробка { name, min:[x,y,z], max:[x,y,z] } (включительно) или шар { name, center:[x,y,z], r }; dim — по желанию.
'use strict';

const dimName = d => String(d || 'overworld').replace(/^minecraft:/, '');

// Ошибка в описании зон (строка) или null
function validate(list) {
  if (!Array.isArray(list)) return 'zones должен быть списком';
  for (let i = 0; i < list.length; i++) {
    const z = list[i], at = `зона ${i}${z && z.name ? ' «' + z.name + '»' : ''}`;
    if (!z || typeof z !== 'object') return at + ': не объект';
    const v3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    if (z.min || z.max) { if (!v3(z.min) || !v3(z.max)) return at + ': min/max — [x,y,z] числами'; }
    else if (z.center) { if (!v3(z.center) || !(Number(z.r) > 0)) return at + ': center [x,y,z] и r > 0'; }
    else return at + ': нужна коробка (min/max) или шар (center/r)';
  }
  return null;
}

function list(ctx) {
  const h = ctx && ctx.behaviorHost;
  try { const z = h ? h.zones() : []; return Array.isArray(z) ? z : []; } catch (e) { return []; }
}

function inside(z, x, y, z0) {
  if (z.min && z.max) {
    const lo = i => Math.min(z.min[i], z.max[i]), hi = i => Math.max(z.min[i], z.max[i]);
    return x >= lo(0) && x <= hi(0) && y >= lo(1) && y <= hi(1) && z0 >= lo(2) && z0 <= hi(2);
  }
  if (z.center) return Math.hypot(x + 0.5 - z.center[0], y + 0.5 - z.center[1], z0 + 0.5 - z.center[2]) <= Number(z.r);
  return false;
}

// Блок pos (Vec3 или [x,y,z]) в запретной зоне? Возвращает зону или null. dim — измерение бота (по умолчанию overworld)
function forbidden(ctx, pos, dim) {
  const zs = list(ctx);
  if (!zs.length || !pos) return null;
  const [x, y, z] = Array.isArray(pos) ? pos.map(Math.floor) : [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)];
  const d = dimName(dim || (ctx.bot && ctx.bot.game && ctx.bot.game.dimension));
  return zs.find(zn => (!zn.dim || dimName(zn.dim) === d) && inside(zn, x, y, z)) || null;
}

const label = zn => zn ? `запретная зона${zn.name ? ' «' + zn.name + '»' : ''}` : '';

// Для pathfinder: не ломать блоки зоны по пути (вес >= 100 — нельзя)
function breakExclusion(ctx) { return block => (block && block.position && forbidden(ctx, block.position)) ? 100 : 0; }

module.exports = { validate, list, forbidden, label, breakExclusion };
