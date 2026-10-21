// Офлайн-проверка навыка shelter на фальшивом боте (плоская равнина со снегом, бот стоит не по центру клетки)
'use strict';
const assert = require('assert');
const { Vec3, sleep } = require('../lib/util');
const { Task } = require('../lib/tasks');
const survival = require('../lib/skills/survival');

function world(inv, start) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const mk = (name, bb, pos) => ({ name, boundingBox: bb, position: new Vec3(pos.x, pos.y, pos.z) });
  const bot = {
    entity: { position: new Vec3(start.x, start.y, start.z), yaw: 0 }, health: 20, username: 'FlyTest', _fwd: false,
    inventory: { items: () => inv.filter(i => i.count > 0) },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = key(x, y, z);
      if (blocks.has(k)) return mk(blocks.get(k)[0], blocks.get(k)[1], { x, y, z });
      if (y <= 65) return mk('dirt', 'block', { x, y, z });
      if (y === 66) return mk('snow', 'empty', { x, y, z }); // снежный слой: проходимый
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

async function run(inv, label, start) {
  const w = world(inv, start); const t = new Task(1, 'shelter', {}, 'brain');
  const ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
  try { const r = await survival.shelter(ctx, t, {}); assert(survival.isSheltered(w.bot)); console.log('shelter', label, 'OK', JSON.stringify(r)); }
  finally { w.stop(); }
}

module.exports = async () => {
  await run([{ name: 'cobblestone', count: 24 }], 'cobble24 не по центру', new Vec3(0.88, 66, 0.15));
  await run([{ name: 'dirt', count: 5 }, { name: 'cobblestone', count: 4 }], 'ровно 9 блоков', new Vec3(0.5, 66, 0.5));
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
