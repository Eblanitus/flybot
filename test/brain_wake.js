// Офлайн-проверка будильника мозга (tools/brain_wake.js): поводы без сети
'use strict';
const assert = require('assert');
const { pickWake, wakeText, NO_BUILD_MS } = require('../tools/brain_wake');

module.exports = async () => {
  const withBuild = '## Текущая цель\nПостройка: hut_west -390 67 40 rot=90\nБаза: -393 67 36\n';
  const noBuild = '## Текущая цель\nБаза: -393 67 36\n';
  const now = 1e12;
  // нет файла — будим сразу, курсор = lastId
  let r = pickWake({ events: [{ id: 5, type: 'info' }], lastId: 7, notes: withBuild, st: null, now });
  assert(r.wake && /старт/.test(r.wake.reason) && r.st.cursor === 7, JSON.stringify(r));
  let st = r.st;
  // провалы, простой, смерть, goal_report — не будят
  const quiet = [{ id: 8, type: 'task_failed', name: 'build_blueprint', reason: 'не достроено' }, { id: 9, type: 'progress_idle', min: 60 },
    { id: 10, type: 'death', cause: 'zombie' }, { id: 11, type: 'goal_report' }, { id: 12, type: 'chat', from: 'Stranger', text: 'привет' },
    { id: 13, type: 'info', msg: 'автопилот: постройка hut_west: провал — повтор через 180 с' }];
  r = pickWake({ events: quiet, lastId: 13, notes: withBuild, st, now: now + 1000 });
  assert.strictEqual(r.wake, null, 'провалы/простой/смерть/чужой чат не будят');
  assert.strictEqual(r.st.cursor, 13);
  st = r.st;
  // build_done будит; повторно (то же событие) — нет
  const bd = { id: 14, t: '10:00:00', type: 'build_done', name: 'hut_west', at: [-390, 67, 40] };
  r = pickWake({ events: [bd], lastId: 14, notes: withBuild, st, now: now + 2000 });
  assert(r.wake && /build_done: hut_west/.test(r.wake.reason) && r.wake.lines.length === 1 && /#14/.test(r.wake.lines[0]), JSON.stringify(r.wake));
  st = r.st;
  assert.strictEqual(pickWake({ events: [bd], lastId: 14, notes: withBuild, st, now: now + 3000 }).wake, null, 'старое событие не будит');
  // рестарт тела: lastId < cursor -> курсор 0; то же build_done с новым id не будит, новый день — будит
  r = pickWake({ events: [{ ...bd, id: 2 }], lastId: 3, notes: withBuild, st, now: now + 4000 });
  assert(r.wake === null && r.st.cursor === 3, 'после рестарта тела старый повод не будит: ' + JSON.stringify(r));
  st = r.st;
  r = pickWake({ events: [{ id: 4, t: '11:00:00', type: 'day_report', day: 3, line: 'день 3: 40 блоков' }], lastId: 4, notes: withBuild, st, now: now + 5000 });
  assert(r.wake && /новый день/.test(r.wake.reason), 'day_report будит');
  st = r.st;
  // хозяин: owner_msg и chat от eblanitus228
  r = pickWake({ events: [{ id: 5, t: '11:01:00', type: 'chat', from: 'eblanitus228', text: 'построй маяк' }], lastId: 5, notes: withBuild, st, now: now + 6000 });
  assert(r.wake && /хозяин: построй маяк/.test(r.wake.reason)); st = r.st;
  r = pickWake({ events: [{ id: 6, t: '11:02:00', type: 'owner_msg', from: 'eblanitus228 (из программы)', text: 'мост на север' }], lastId: 6, notes: withBuild, st, now: now + 7000 });
  assert(r.wake && /мост на север/.test(r.wake.reason)); st = r.st;
  // нет «Постройки:» — будит, но не чаще NO_BUILD_MS после прошлого пробуждения
  assert.strictEqual(pickWake({ events: [], lastId: 6, notes: noBuild, st, now: now + 8000 }).wake, null, 'только что будили — ждём');
  r = pickWake({ events: [], lastId: 6, notes: noBuild, st, now: now + 7000 + NO_BUILD_MS });
  assert(r.wake && /нет строки «Постройка:»/.test(r.wake.reason)); st = r.st;
  assert.strictEqual(pickWake({ events: [], lastId: 6, notes: withBuild, st, now: now + 9e9 }).wake, null, 'постройка есть, повода нет');
  // --now
  assert(/вручную/.test(pickWake({ events: [], lastId: 6, notes: withBuild, st, now: now + 1, force: true }).wake.reason));
  // много событий — до 10 строк
  const many = Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, t: '12:00:00', type: 'owner_msg', text: 'сообщение ' + i }));
  r = pickWake({ events: many, lastId: 114, notes: withBuild, st, now: now + 1 });
  assert(r.wake.lines.length === 10 && /…и ещё/.test(r.wake.reason));
  const txt = wakeText(r.wake, now);
  assert(/^# Повод разбудить мозг\nВремя: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\nПовод: /.test(txt) && /## События по поводу/.test(txt));
  console.log('brain_wake: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
