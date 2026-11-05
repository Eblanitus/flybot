// Офлайн-проверка: поиск пещеры в пуле предлагается, только когда пещера видна рядом (решение хозяина 05.11)
'use strict';
const assert = require('assert');
const RUN = require('../hardcore/pool/run');

const survey = (layers, legend = {}) => ({ origin: { x: 0, z: 0 }, layers, legend });
const apiWith = sv => ({ cmd: async action => { assert.strictEqual(action, 'survey'); return sv; } });

(async () => {
  // 1) воздух ниже y 60 рядом — пещера видна
  assert.strictEqual(await RUN.caveInView(apiWith(survey({ 'y=40': ['..', '..'] }))), true, 'воздух ниже 60 рядом — пещера в виду');
  // 2) воздух только выше y 60 — это не пещера
  assert.strictEqual(await RUN.caveInView(apiWith(survey({ 'y=70': ['..'] }))), false, 'воздух над 60 — не пещера');
  // 3) вокруг камень — пещеры нет
  assert.strictEqual(await RUN.caveInView(apiWith(survey({ 'y=40': ['SS', 'SS'] }, { S: 'stone' }))), false, 'камень — пещеры нет');
  // 4) тело не ответило или не умеет снимок — пещеры нет
  assert.strictEqual(await RUN.caveInView({ cmd: async () => { throw new Error('нет тела'); } }), false, 'ошибка тела — пещеры нет');
  assert.strictEqual(await RUN.caveInView({}), false, 'нет cmd — пещеры нет');
  // 5) под фильтр попадают ровно два навыка поиска пещеры
  assert(RUN.CAVE.has('v2.exploreCave') && RUN.CAVE.has('v2.exploreCaveAndGatherResourcesV2') && RUN.CAVE.size === 2, 'навыки поиска пещеры');
  console.log('hardcore_pool_cave: OK');
})().catch(e => { console.error(e); process.exit(1); });
