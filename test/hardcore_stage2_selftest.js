// Этап 2: самопроверка поведения (behavior selfTest) проходит с теми же переменными, что стенд даёт телу мухи.
// 05.11: с HC_STAGE2 проверка падала («ночью без упавшего навыка — пережидаем»: туннель зовётся hc_night_mine) —
// тело оставалось без поведения, все мухи стояли.
'use strict';
const ENV = { HC_STAND: '1', HC_STAGE2: '1', HC_POOL: '1', HC_BR_PREFIX: 'HC_' };

(async () => {
  for (const extra of [{}, { HC_EXPLORE: '0' }]) {
    const keep = {};
    for (const [k, v] of Object.entries({ ...ENV, ...extra })) { keep[k] = process.env[k]; process.env[k] = v; }
    try {
      await require('../behavior/index').selfTest();
      if (process.env.HC_STAGE2 !== '1') throw new Error('selfTest не вернул HC_STAGE2');
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  console.log('hardcore_stage2_selftest: ok');
})().catch(e => { console.error(e); process.exit(1); });
