// Офлайн-проверка «своих блоков» (lib/ownblocks.js): муха помнит поставленное и честно говорит, кто сломал. Запуск: node test/ownblocks.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Vec3 } = require('../lib/util');
const OB = require('../lib/ownblocks');

module.exports = async () => {
  const file = path.join(os.tmpdir(), 'flybot_own_' + process.pid + '.json');
  try { fs.unlinkSync(file); } catch (e) {}
  const ev = []; let t = 1000;
  const bot = new EventEmitter(); bot.entities = {};
  const ctx = { bot, tasks: { current: { by: 'skill:build_hut', source: 'brain' }, legacy: null }, events: { push: (type, d) => ev.push({ type, ...d }) } };
  const ob = OB.create(ctx, { file, now: () => t });
  const P = (x, y, z) => new Vec3(x, y, z);
  const blk = (name, p) => ({ name, position: p });

  ob.onPlaced('oak_planks', P(0, 64, 0)); ob.onPlaced('oak_door', P(1, 64, 0)); ob.onPlaced('cobblestone', P(2, 64, 0)); ob.onPlaced('torch', P(3, 64, 0)); ob.onPlaced('glass', P(4, 64, 0));
  assert.strictEqual(ob.size, 5); assert.strictEqual(ob.get(P(0, 64, 0)).by, 'skill:build_hut');
  // чужой (не свой) блок — тишина; смена состояния двери — не слом
  assert.strictEqual(ob.onUpdate(null, blk('air', P(9, 64, 9))), null);
  assert.strictEqual(ob.onUpdate(null, blk('oak_door', P(1, 64, 0))), null);
  // сама копает своё место по команде мозга: by = brain, мозг не будим (sync)
  ctx.tasks.current = null; ctx.tasks.legacy = { name: 'dig', by: 'brain' }; bot.__flyDigging = { name: 'oak_planks', position: P(0, 64, 0) };
  let f = ob.onUpdate(null, blk('air', P(0, 64, 0)));
  assert.strictEqual(f.by, 'brain'); assert.strictEqual(f.block, 'oak_planks'); assert.strictEqual(f.placedBy, 'skill:build_hut');
  assert.strictEqual(ev[0].type, 'own_block_broken'); assert.strictEqual(ev[0].sync, true);
  bot.__flyDigging = null; ctx.tasks.legacy = null;
  // игрок на глазах ломал — player:<ник>, будит мозг
  ob.onBreakSeen(P(2, 64, 0), { type: 'player', username: 'Steve' }); t += 500;
  f = ob.onUpdate(null, blk('air', P(2, 64, 0)));
  assert.strictEqual(f.by, 'player:Steve'); assert(!ev[1].sync);
  // взрыв рядом
  ob.onExplosion(P(4, 65, 1)); t += 100;
  assert.strictEqual(ob.onUpdate(null, blk('air', P(4, 64, 0))).by, 'взрыв');
  // старое наблюдение/взрыв не считаются; эндермен рядом
  t += 10000; bot.entities = { 1: { name: 'enderman', position: P(3, 64, 2) } };
  assert.strictEqual(ob.onUpdate(null, blk('air', P(3, 64, 0))).by, 'mob:enderman');
  // сломанный забыт; сохранение и загрузка
  assert.strictEqual(ob.size, 1); assert.strictEqual(ob.onUpdate(null, blk('air', P(0, 64, 0))), null);
  ob.save(); const ob2 = OB.create(ctx, { file, now: () => t }); assert.strictEqual(ob2.size, 1); assert(ob2.has(P(1, 64, 0)));
  bot.entities = {}; assert.strictEqual(ob2.onUpdate(null, blk('air', P(1, 64, 0))).by, 'неизвестно');
  // предел памяти
  for (let i = 0; i < OB.CAP + 10; i++) ob2.onPlaced('dirt', P(i, 70, 0));
  assert.strictEqual(ob2.size, OB.CAP); assert(!ob2.has(P(0, 70, 0)) && ob2.has(P(OB.CAP + 9, 70, 0)));
  // attach: события бота доходят
  const b3 = new EventEmitter(); b3.entities = {}; const ev3 = [];
  const c3 = { bot: b3, tasks: { current: null, legacy: null }, events: { push: (type, d) => ev3.push({ type, ...d }) }, ownBlocks: OB.create({ bot: b3, tasks: { current: null, legacy: null }, events: { push: (type, d) => ev3.push({ type, ...d }) } }, { file: file + '2' }) };
  const ses = { bot: b3, timers: [] }; OB.attach(c3, ses);
  b3.emit('blockPlaced', blk('air', P(0, 64, 0)), blk('stone', P(0, 64, 0)));
  b3.emit('blockBreakProgressObserved', blk('stone', P(0, 64, 0)), 3, { type: 'mob', name: 'zombie' });
  b3.emit('blockUpdate', blk('stone', P(0, 64, 0)), blk('air', P(0, 64, 0)));
  assert.strictEqual(ev3.length, 1); assert.strictEqual(ev3[0].by, 'mob:zombie');
  ses.timers.forEach(clearInterval);
  for (const x of [file, file + '2']) try { fs.unlinkSync(x); } catch (e) {}
  console.log('ownblocks: OK');
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
