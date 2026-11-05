// Офлайн-проверка блоков для стен и крыши (этап 2, шаг Б1): hardcore/blocks.js и крючки в lib/util.js и lib/skills/survival.js.
// Баг пустыни и мезы 04.11: песок не был блоком, муха копала яму вниз без конца. Здесь — свойства блоков и две ямы на песке.
'use strict';
const assert = require('assert');
const HB = require('../hardcore/blocks');
const { Vec3, isBuildBlock } = require('../lib/util');
const { Task } = require('../lib/tasks');
const survival = require('../lib/skills/survival');

// --- свойства блоков ---
for (const n of ['sand', 'red_sand', 'gravel', 'dirt', 'cobblestone', 'sandstone', 'terracotta', 'red_terracotta', 'netherrack', 'stone', 'mud', 'clay'])
  assert.strictEqual(HB.isShelterBlock(n), true, 'годится на стену: ' + n);
for (const n of ['oak_log', 'crafting_table', 'oak_leaves', 'glass', 'tnt', 'oak_slab', 'chest', 'iron_ore', 'torch', 'iron_block', 'bedrock'])
  assert.strictEqual(HB.isShelterBlock(n), false, 'не годится: ' + n);
assert(HB.isGravity('sand') && HB.isGravity('red_sand') && HB.isGravity('gravel') && HB.isGravity('white_concrete_powder'));
assert(!HB.isGravity('sandstone') && !HB.isGravity('dirt'));
console.log('свойства блоков: OK');

// --- isBuildBlock: песка нет без HC_STAGE2, с ним есть; ценное не берём ни так, ни так ---
delete process.env.HC_STAGE2;
assert.strictEqual(isBuildBlock('sand'), false);
process.env.HC_STAGE2 = '1';
assert.strictEqual(isBuildBlock('sand'), true);
assert.strictEqual(isBuildBlock('oak_log'), false);
console.log('isBuildBlock: OK');

// --- яма на песке: фальшивый мир, как в test/shelter.js (блоки ниже 66 — от gen; у блоков выше 65 проходимость — по имени) ---
function world(inv, start, gen) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const mk = (name, bb, pos) => ({ name, boundingBox: bb, position: new Vec3(pos.x, pos.y, pos.z) });
  const bot = {
    entity: { position: new Vec3(start.x, start.y, start.z), yaw: 0 }, health: 20, username: 'FlyTest', _fwd: false,
    inventory: { items: () => inv.filter(i => i.count > 0) },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = key(x, y, z);
      if (blocks.has(k)) return mk(blocks.get(k)[0], blocks.get(k)[1], { x, y, z });
      if (gen) { const n = gen(x, y, z); if (n != null) return mk(n, n === 'air' || n === 'snow' ? 'empty' : 'block', { x, y, z }); }
      if (y <= 65) return mk('dirt', 'block', { x, y, z });
      if (y === 66) return mk('snow', 'empty', { x, y, z });
      return mk('air', 'empty', { x, y, z });
    },
    dig: async b => { blocks.set(key(b.position.x, b.position.y, b.position.z), ['air', 'empty']); const it = inv.find(i => i.name === b.name); if (it) it.count++; },
    equip: async it => { bot.held = it; }, lookAt: async () => {}, look: async yaw => { bot.entity.yaw = yaw; },
    setControlState(s, v) { if (s === 'forward') bot._fwd = v; }, clearControlStates() { bot._fwd = false; },
    placeBlock: async (ref, face) => {
      const d = ref.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0));
      if (d > 5) throw new Error('далеко');
      const t = ref.position.plus(face);
      blocks.set(key(t.x, t.y, t.z), [bot.held.name, 'block']); bot.held.count--;
    }
  };
  const timer = setInterval(() => { if (bot._fwd) { const y = bot.entity.yaw, p = bot.entity.position; p.x += -Math.sin(y) * 0.065; p.z += -Math.cos(y) * 0.065; } }, 50);
  return { bot, stop: () => clearInterval(timer) };
}

async function dig(gen, inv) {
  const w = world(inv, { x: 0.5, y: 66, z: 0.5 }, gen);
  let digs = 0; const dig0 = w.bot.dig; w.bot.dig = async b => { digs++; return dig0(b); };
  const ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
  const base = new Vec3(0, 66, 0);
  try {
    const r = await survival.digIn(ctx, new Task(1, 'shelter', {}, 'brain'), base, base, 0).then(v => ({ ok: true, v }), e => ({ ok: false, e }));
    return { ...r, digs, bot: w.bot };
  } finally { w.stop(); }
}

(async () => {
  process.env.HC_STAGE2 = '1';

  // 1) песок до y=65, муха на 66, в сумке только песок — крыть нечем, под ногами песок: не копаем
  {
    const sandFloor = (x, y, z) => (y <= 65 ? 'sand' : null);
    const r = await dig(sandFloor, [{ name: 'sand', count: 20 }]);
    assert(!r.ok && /нет блока на крышу ямы/.test(r.e.message), r.ok ? 'должен был отказать' : r.e.message);
    assert.strictEqual(r.digs, 0, 'ни одного dig');
    console.log('песок без крыши: отказ, не копаю: OK');
  }

  // 2) муха в яме (стены у ног и у головы со всех сторон), в сумке песок ×10 и земля ×2:
  //    вниз не копаем, крыша (y+2) — земля, не песок
  {
    const walls = new Set();
    for (const y of [66, 67]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) walls.add(`${dx},${y},${dz}`);
    const gen = (x, y, z) => (y <= 65 ? 'sand' : walls.has(`${x},${y},${z}`) ? 'stone' : null);
    const r = await dig(gen, [{ name: 'sand', count: 10 }, { name: 'dirt', count: 2 }]);
    assert(r.ok, r.e && r.e.message);
    assert.strictEqual(r.digs, 0, 'в яме не копаем');
    assert.strictEqual(r.bot.blockAt(new Vec3(0, 68, 0)).name, 'dirt', 'на крыше земля, не песок');
    console.log('яма: крыша из земли, вниз не копаю: OK');
  }

  // без HC_STAGE2 — как было: та же яма на песке копается (старый путь), отказа «нет блока на крышу» нет
  {
    delete process.env.HC_STAGE2;
    const sandFloor = (x, y, z) => (y <= 65 ? 'sand' : null);
    const r = await dig(sandFloor, [{ name: 'sand', count: 20 }]);
    assert(!(r.e && /нет блока на крышу ямы/.test(r.e.message)), r.e && r.e.message);
    assert(r.digs >= 1, 'без флага копаем вниз, как раньше');
    console.log('без HC_STAGE2 — как было: OK');
  }

  console.log('hardcore_blocks: OK');
})().catch(e => { console.error(e); process.exit(1); });
