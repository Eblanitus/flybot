// Офлайн-проверка: pathfinder не ломает свои постройки (lib/actions.js makeMovements -> exclusionAreasBreak), но ломает временное
// (укрытия, столбы). Запуск: node test/own_break.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Vec3 } = require('../lib/util');
const A = require('../lib/actions');
const OB = require('../lib/ownblocks');
const mcData = require('minecraft-data');

module.exports = async () => {
  const file = path.join(os.tmpdir(), 'flybot_ownbreak_' + process.pid + '.json');
  try { fs.unlinkSync(file); } catch (e) {}
  const bot = new EventEmitter(); bot.entities = {};
  const tasks = { current: null, legacy: null };
  const ctx = { bot, tasks, events: { push: () => {} } };
  ctx.ownBlocks = OB.create(ctx, { file });
  const P = (x, y, z) => new Vec3(x, y, z);
  const place = (task, name, p) => { tasks.current = task ? { name: task, source: 'brain', by: 'brain' } : null; ctx.ownBlocks.onPlaced(name, p); };

  place('build_blueprint', 'spruce_fence', P(-415, 54, 25));
  place('build_blueprint', 'cobblestone', P(-416, 53, 25));
  place('build_blueprint', 'dirt', P(-417, 52, 25));
  place('shelter', 'dirt', P(0, 64, 0));
  place('shelter', 'cobblestone', P(1, 64, 0));
  place('pillar_up', 'cobblestone', P(2, 64, 0));
  place('goto', 'dirt', P(3, 64, 0));        // подпорка pathfinder-а при ходьбе
  place('goto', 'cobblestone', P(4, 64, 0)); // булыжник вне укрытия/столба — не землянной мусор
  tasks.current = null;

  // чистое правило
  assert.strictEqual(A.ownBreakProtected(null, 'stone'), false, 'не свой блок — ломать можно');
  assert.strictEqual(A.ownBreakProtected({ task: 'build_blueprint' }, 'dirt'), true, 'постройка: даже dirt нельзя');
  assert.strictEqual(A.ownBreakProtected({ task: 'shelter' }, 'cobblestone'), false, 'укрытие: булыжник можно');
  assert.strictEqual(A.ownBreakProtected({ name: 'dirt' }, 'dirt'), true, 'старая запись без task — нельзя');

  // функция из makeMovements (на настоящем реестре)
  const registry = mcData('1.21.1');
  const bot2 = Object.assign(new EventEmitter(), { registry, version: '1.21.1', inventory: { items: () => [] }, entity: { position: P(0, 64, 0) }, world: {}, entities: {}, blockAt: p => ({ name: 'air', position: p, type: 0, liquid: false, canFall: false, shapes: [], safe: true, physical: false }) });
  const m = A.makeMovements(bot2, { ctx });
  assert.strictEqual(m.exclusionAreasBreak.length, 1, 'исключение подключено');
  const f = m.exclusionAreasBreak[0];
  const blk = (name, p) => ({ name, position: p, type: registry.blocksByName[name].id });
  assert(f(blk('spruce_fence', P(-415, 54, 25))) >= 100, 'свой spruce_fence из build_blueprint — запрет');
  assert(f(blk('cobblestone', P(-416, 53, 25))) >= 100, 'свой булыжник из build_blueprint — запрет');
  assert(f(blk('dirt', P(-417, 52, 25))) >= 100, 'свой dirt из build_blueprint — запрет');
  assert.strictEqual(f(blk('dirt', P(0, 64, 0))), 0, 'свой dirt из shelter — можно');
  assert.strictEqual(f(blk('cobblestone', P(1, 64, 0))), 0, 'свой булыжник из shelter — можно');
  assert.strictEqual(f(blk('cobblestone', P(2, 64, 0))), 0, 'свой булыжник из pillar_up — можно');
  assert.strictEqual(f(blk('dirt', P(3, 64, 0))), 0, 'подпорка dirt при goto — можно');
  assert(f(blk('cobblestone', P(4, 64, 0))) >= 100, 'булыжник при goto — нельзя');
  assert.strictEqual(f(blk('stone', P(9, 9, 9))), 0, 'чужой блок — можно');
  // safeToBreak уважает исключение (>=100 -> не ломать)
  m.canDig = true;
  assert.strictEqual(!!m.safeToBreak({ ...blk('spruce_fence', P(-415, 54, 25)), diggable: true }), false, 'safeToBreak: свой забор нельзя');
  assert(m.safeToBreak({ ...blk('dirt', P(0, 64, 0)), diggable: true }), 'safeToBreak: земля укрытия можно');
  try { fs.unlinkSync(file); } catch (e) {}
  console.log('own_break: OK');
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
