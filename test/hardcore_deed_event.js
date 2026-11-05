// Офлайн-проверка события «deed» (этап 2, шаг А2): автопилот шлёт итог дела только при HC_STAND.
'use strict';
const assert = require('assert');
const AP = require('../behavior/autopilot');

async function runOnce(result) {
  const events = [];
  const ctx = { events: { push: (type, data) => events.push({ type, ...data }) }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap = AP.create(ctx);
  ctx.runSkill = async () => result;
  ap._start({ key: 'collect_log', kind: 'body', name: 'collect', params: {}, why: 'тест' });
  await ap.running.promise;
  return events;
}

(async () => {
  // со стендом: провал и успех дают событие deed с итогом
  process.env.HC_STAND = '1';
  let ev = await runOnce({ ok: false, error: 'нет брёвен' });
  let deed = ev.filter(e => e.type === 'deed');
  assert.strictEqual(deed.length, 1, 'провал: одно событие deed');
  assert.strictEqual(deed[0].verdict, 'провал');
  assert.strictEqual(deed[0].key, 'collect_log');
  assert(/нет брёвен/.test(deed[0].error), deed[0].error);
  console.log('deed при провале: OK');

  ev = await runOnce({ ok: true });
  deed = ev.filter(e => e.type === 'deed');
  assert.strictEqual(deed.length, 1, 'успех: одно событие deed');
  assert.strictEqual(deed[0].verdict, 'ok');
  assert(!('error' in deed[0]), 'успех: без error');
  console.log('deed при успехе: OK');

  // без стенда событий deed нет
  delete process.env.HC_STAND;
  ev = await runOnce({ ok: false, error: 'нет брёвен' });
  assert.strictEqual(ev.filter(e => e.type === 'deed').length, 0, 'без HC_STAND deed не шлём');
  console.log('без HC_STAND: OK');

  console.log('hardcore_deed_event: OK');
})().catch(e => { console.error(e); process.exit(1); });
