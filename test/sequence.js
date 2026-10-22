// Офлайн-проверка пачки команд (sequence/macro, lib/commands.js legacy): шаги идут как внутренние запросы исполнителя —
// честный итог каждого шага, без автоочереди. Раньше sequence падала на «internal is not defined». Запуск: node test/sequence.js
'use strict';
const assert = require('assert');
const perception = require('../lib/perception');
const experience = require('../lib/experience');
const { makeDispatcher } = require('../lib/commands');
const { TaskManager } = require('../lib/tasks');

module.exports = async () => {
  const snap0 = perception.snapshot, dec0 = experience.decorate;
  perception.snapshot = () => ({ summary: 'тест' }); experience.decorate = (c, s) => s; // снимок без живого бота
  const ctx = { ready: true, events: { push: () => {} }, haltBody: () => {}, stats: { blocksPlaced: 0, blocksMined: 0 } };
  ctx.bot = { entity: { position: { x: 0, y: 64, z: 0 } } };
  ctx.tasks = new TaskManager(ctx);
  const dispatch = makeDispatcher(ctx);
  const seen = [];
  ctx.runSkill = null;
  // шаг-навык: смотрим, с какими опциями он стартует (noQueue — внутренний запрос)
  const orig = ctx.tasks.start.bind(ctx.tasks);
  ctx.tasks.start = (name, params, fn, opts) => { seen.push({ name, noQueue: !!opts.noQueue, wait: !!opts.wait }); return Promise.resolve({ ok: true, result: {} }); };
  const r = await dispatch({ action: 'sequence', params: { steps: [{ action: 'pillar_up', params: { n: 1 } }, { action: 'dig_at', params: { x: 1, y: 2, z: 3 } }] } });
  assert(!/internal is not defined/.test(r.error || ''), r.error);
  assert.deepStrictEqual(seen.map(s => s.name), ['pillar_up', 'dig_at'], JSON.stringify(r));
  assert(seen.every(s => s.noQueue && s.wait), 'шаги пачки — внутренние: без очереди, с честным итогом');
  ctx.tasks.start = orig; perception.snapshot = snap0; experience.decorate = dec0;
  console.log('sequence: OK');
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
