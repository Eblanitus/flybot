// Офлайн-проверка навыка shelter на фальшивом боте (плоская равнина со снегом, бот стоит не по центру клетки)
'use strict';
const assert = require('assert');
const { Vec3, sleep } = require('../lib/util');
const { Task } = require('../lib/tasks');
const survival = require('../lib/skills/survival');
const V = require('../lib/variants');

function world(inv, start, gen) {
  const blocks = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z;
  const mk = (name, bb, pos) => ({ name, boundingBox: bb, position: new Vec3(pos.x, pos.y, pos.z) });
  const bot = {
    entity: { position: new Vec3(start.x, start.y, start.z), yaw: 0 }, health: 20, username: 'FlyTest', _fwd: false,
    inventory: { items: () => inv.filter(i => i.count > 0) },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = key(x, y, z);
      if (blocks.has(k)) return mk(blocks.get(k)[0], blocks.get(k)[1], { x, y, z });
      if (gen) { const n = gen(x, y, z); if (n != null) return mk(n, y <= 65 ? 'block' : 'empty', { x, y, z }); }
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

async function run(inv, label, start, gen) {
  const w = world(inv, start, gen); const t = new Task(1, 'shelter', {}, 'brain');
  const ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
  try { const r = await survival.shelter(ctx, t, {}); assert(survival.isSheltered(w.bot)); console.log('shelter', label, 'OK', JSON.stringify(r)); }
  finally { w.stop(); }
}

module.exports = async () => {
  await run([{ name: 'cobblestone', count: 24 }], 'cobble24 не по центру', new Vec3(0.88, 66, 0.15));
  await run([{ name: 'dirt', count: 5 }, { name: 'cobblestone', count: 4 }], 'ровно 9 блоков', new Vec3(0.5, 66, 0.5));

  // ----- new tests -----
  // 1. dig variant applies returns false when water is nearby
  {
    V.setRegistry(null);
    const w = world([{ name: 'dirt', count: 20 }], new Vec3(0.5, 66, 0.5),
      (x, y, z) => (x === 1 && y === 66 && z === 0 ? 'water' : (y <= 65 ? 'dirt' : 'air')));
    const bot = w.bot, ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
    bot.entity.position = new Vec3(0.5, 66, 0.5);
    const sit = V.situation(ctx, null, { hostileNear: false });
    const digApplies = V.family('shelter').variants.get('dig').applies;
    assert.strictEqual(digApplies(ctx, sit), false, 'dig неприменим когда вода рядом');
    // без воды — применим
    const w2 = world([{ name: 'dirt', count: 20 }], new Vec3(0.5, 66, 0.5));
    const bot2 = w2.bot, ctx2 = { bot: w2.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
    bot2.entity.position = new Vec3(0.5, 66, 0.5);
    const sit2 = V.situation(ctx2, null, { hostileNear: false });
    assert.strictEqual(digApplies(ctx2, sit2), true, 'dig применим когда воды нет рядом');
    w.stop(); w2.stop();
    V.setRegistry(null);
    console.log('shelter: dig water check OK');
  }

  // 2. digIn refuses when HP < 10
  {
    const w = world([{ name: 'dirt', count: 20 }], new Vec3(0.5, 66, 0.5),
      (x, y, z) => (y <= 65 ? 'dirt' : 'air'));
    const bot = w.bot, ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
    bot.entity.position = new Vec3(0.5, 66, 0.5);
    bot.health = 6; // HP < 10
    const t = new Task(1, 'shelter', {}, 'test');
    const base = bot.entity.position.floored();
    try {
      await survival.digIn(ctx, t, base, base, 0);
      throw new Error('should have thrown');
    } catch (e) {
      assert(/HP < 10: вход в яму стоит 3 HP/.test(e.message), 'digIn отказывает при HP < 10: ' + e.message);
    }
    w.stop();
    console.log('shelter: digIn HP check OK');
  }

  // 3. isSheltered returns false for hole (floor not solid)
  {
    const w = world([{ name: 'dirt', count: 20 }], new Vec3(0.5, 66, 0.5),
      (x, y, z) => {
        // Яма 2 блока глубиной в (0,0): y=64,65 — air, y=66 — feet level
        if (x === 0 && z === 0 && (y === 64 || y === 65)) return 'air';
        if (y <= 63) return 'dirt';
        return 'air';
      });
    const bot = w.bot;
    bot.entity.position = new Vec3(0.5, 66, 0.5);
    // Пол под ногами (y=65) — air (выкопано), значит isSheltered = false
    assert.strictEqual(survival.isSheltered(bot), false, 'isSheltered false в яме (пол не твёрдый)');
    w.stop();
    console.log('shelter: isSheltered hole check OK');
  }

  // 4. shelterImpl doesn't fallback to dig when hostile mob nearby
  {
    V.setRegistry(null);
    const w = world([{ name: 'cobblestone', count: 20 }], new Vec3(0.5, 100, 0.5),
      (x, y, z) => {
        // Бот в воздухе (y=100), пола нет — стены не построить
        return 'air';
      });
    const bot = w.bot, ctx = { bot: w.bot, stats: { blocksPlaced: 0, blocksMined: 0 }, tasks: {} };
    bot.entity.position = new Vec3(0.5, 100, 0.5);
    // Добавить зомби рядом (5м)
    const mob = { id: 10, name: 'zombie', type: 'hostile', position: new Vec3(5.5, 100, 0.5), height: 1.95, width: 0.6 };
    if (!bot.entities) bot.entities = {};
    bot.entities[mob.id] = mob;
    const t = new Task(1, 'shelter', {}, 'test');
    try {
      await survival.shelterImpl(ctx, t, {}); // auto mode
      throw new Error('should have thrown');
    } catch (e) {
      assert(/моб рядом: яму копать нельзя/.test(e.message), 'fallback отказывает при мобе рядом: ' + e.message);
    }
    w.stop();
    V.setRegistry(null);
    console.log('shelter: fallback mob check OK');
  }

  console.log('shelter: all new tests OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
