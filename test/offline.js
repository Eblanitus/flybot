// Офлайн-проверки без сервера Minecraft: очередь/потолок ожидания TaskManager и навык shelter на фальшивом боте. Запуск: node test/offline.js
'use strict';
const assert = require('assert');
const { TaskManager } = require('../lib/tasks');
const { sleep, Vec3 } = require('../lib/util');

async function testTasks() {
  const events = []; let halts = 0;
  const ctx = { events: { push: (type, data) => events.push({ type, ...data }) }, haltBody: () => { halts++; } };
  const tm = new TaskManager(ctx); tm.waitCapMs = 300;
  const order = [];
  const skill = (name, ms, fail) => async t => { order.push(name); await t.sleep(ms); if (fail) throw new Error('boom'); return { name }; };
  const run = (name, ms, opts, fail) => tm.start(name, {}, skill(name, ms, fail), opts);

  // быстрый навык с wait — как раньше
  let r = await run('fast', 50, { wait: true }); assert(r.ok && r.result.name === 'fast' && !r.running);
  // потолок: долгий навык с wait отвечает running:true, остаётся жить, task_done не sync
  r = await run('long', 700, { wait: true }); assert(r.ok && r.running && r.taskId && r.task.status === 'running', 'cap');
  assert.strictEqual(tm.current.sync, false);
  // очередь FIFO: 3 команды мозга пока занято (в т.ч. wait=1 не блокирует)
  const q1 = await run('a', 50, { wait: true }), q2 = await run('b', 50, {}), q3 = await run('c', 50, { queue: true });
  assert.deepStrictEqual([q1.queued, q1.position, q2.position, q3.position], ['a', 1, 2, 3]);
  assert.deepStrictEqual(tm.info().queue, ['a', 'b', 'c']);
  await sleep(1200);
  assert.deepStrictEqual(order, ['fast', 'long', 'a', 'b', 'c'], 'FIFO ' + order);
  assert(events.find(e => e.type === 'task_done' && e.name === 'long' && !e.sync), 'long не sync');
  // лимит 5: шестая — ошибка «занят»
  await run('x', 400, {}); for (let i = 0; i < 5; i++) assert((await run('q' + i, 10, {})).queued);
  r = await run('over', 10, {}); assert(!r.ok && /занят/.test(r.error));
  // stop очищает очередь
  await tm.stop('stop'); assert.strictEqual(tm.queue.length, 0); await sleep(100); assert(!tm.current);
  // прерванный навык очищает очередь, упавший — нет
  await run('f', 100, {}, true); await run('after', 50, {}); assert.strictEqual(tm.queue.length, 1);
  await sleep(400); assert(order.includes('after'), 'после упавшего очередь идёт');
  await run('victim', 500, {}); await run('lost', 10, {}); tm.current.abort('смерть'); await sleep(200);
  assert.strictEqual(tm.queue.length, 0); assert(!order.includes('lost'));
  // автопилот вытесняется мозгом сразу, а за автопилотом не встают в очередь
  await run('ap', 2000, { source: 'autopilot', wait: false });
  r = await run('brain1', 50, { wait: true }); assert(r.ok && r.result.name === 'brain1', 'вытеснение автопилота'); assert(events.find(e => e.type === 'task_aborted' && e.name === 'ap'));
  await run('busy', 300, {}); await sleep(10);
  r = await run('ap2', 50, { source: 'autopilot', wait: true }); assert(!r.ok && !r.queued, 'автопилот не в очереди');
  // sequence (noQueue): занято -> ошибка, а не очередь; и без потолка
  r = await run('seq', 10, { wait: true, noQueue: true }); assert(!r.ok);
  await tm.stop(); await sleep(50);
  r = await run('seqlong', 600, { wait: true, noQueue: true }); assert(r.ok && !r.running && r.result.name === 'seqlong');
  // кто отдал действие: by по умолчанию = source, навык исполнителя пишется в события
  assert.strictEqual(events.find(e => e.type === 'task_started' && e.name === 'fast').by, 'brain');
  r = await run('viaskill', 20, { wait: true, by: 'skill:miner' }); assert(r.ok);
  assert(events.find(e => e.type === 'task_done' && e.name === 'viaskill' && e.by === 'skill:miner' && e.source === 'brain'), 'by в task_done');
  // старые простые команды
  assert.strictEqual((await tm.body(async () => ({ ok: true }))).ok, true);
  console.log('tasks: OK');
}

// Все test/variants_*.js (тесты семейств вариантов) подхватываются сами; каждый экспортирует async-функцию
async function runVariantTests() {
  const fs = require('fs'), path = require('path');
  for (const f of fs.readdirSync(__dirname).filter(f => /^variants_.+\.js$/.test(f)).sort()) {
    await require(path.join(__dirname, f))();
    console.log(f + ': OK');
  }
}

module.exports = { testTasks, runVariantTests };
if (require.main === module) testTasks().then(() => require('./shelter')()).then(() => require('./core_fixes')()).then(() => require('./craft')()).then(() => require('./link')()).then(() => require('./collect')()).then(() => require('./autopilot')()).then(() => require('./critic')()).then(() => require('./perception')()).then(() => require('./day_routine')()).then(() => require('./defense')()).then(() => require('./melee')()).then(() => require('./basic')()).then(() => require('./project_skills')()).then(() => require('./worldmem')()).then(() => require('./survival_skills')()).then(() => require('./variants')()).then(runVariantTests).then(() => require('./owner')()).then(() => require('./daylog')()).then(() => require('./blackbox')()).then(() => require('./ledger')()).then(() => require('./audit')()).then(() => require('./teacher')()).then(() => require('./behavior')()).then(() => require('./showcase')()).then(() => console.log('all OK'), e => { console.error(e); process.exit(1); });
