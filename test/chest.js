// Офлайн-проверка открытия сундука (lib/skills/build.js openNearestChest): предпроверки до ожидания окна — сундук есть,
// не завален сверху, не кошка, дотянуться; окно ждём 5 с, а не 20, и отвечаем честной причиной с позициями. Запуск: node test/chest.js
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const build = require('../lib/skills/build');

function world(blocks, { open } = {}) {
  const set = Object.assign({}, blocks);
  const bot = {
    entity: { position: new Vec3(0.5, 64, 2.5) }, entities: {},
    registry: { blocksByName: {}, itemsByName: {} }, inventory: { items: () => [] }, pathfinder: { setGoal() {} },
    blockAt: p => { const k = `${p.x},${p.y},${p.z}`, n = set[k] || (p.y < 64 ? 'stone' : 'air'); return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'air' || n === 'glass' ? (n === 'glass' ? 'block' : 'empty') : 'block', transparent: n === 'air' || n === 'glass' }; },
    openContainer: open || (async () => ({ close() {}, containerItems: () => [] }))
  };
  const t = { check() {}, onAbort() { return () => {}; }, sleep: async () => {}, progress() {} };
  return { ctx: { bot }, t, bot, set };
}

module.exports = async () => {
  const at = { x: 0, y: 64, z: 0 };
  // не сундук
  let w = world({});
  await assert.rejects(build.openNearestChest(w.ctx, w.t, at), /в \(0, 64, 0\) не сундук, а air/);
  // над сундуком камень — сразу причина, без 20 с ожидания
  w = world({ '0,64,0': 'chest', '0,65,0': 'stone' });
  let t0 = Date.now();
  await assert.rejects(build.openNearestChest(w.ctx, w.t, at), e => /над сундуком твёрдый блок stone/.test(e.message) && !!e.extra && !!e.extra.chest && !!e.extra.me);
  assert(Date.now() - t0 < 1000);
  // стекло сверху не мешает; бочке камень сверху не мешает
  w = world({ '0,64,0': 'chest', '0,65,0': 'glass' });
  assert.deepStrictEqual((await build.openNearestChest(w.ctx, w.t, at)).at, [0, 64, 0]);
  w = world({ '0,64,0': 'barrel', '0,65,0': 'stone' });
  assert((await build.openNearestChest(w.ctx, w.t, at)).win);
  // кошка на сундуке
  w = world({ '0,64,0': 'chest' }); w.bot.entities[3] = { name: 'cat', position: new Vec3(0.5, 65, 0.5) };
  await assert.rejects(build.openNearestChest(w.ctx, w.t, at), /кошка/);
  // окно не пришло — 5 с и честная причина с позициями + диагностика
  w = world({ '0,64,0': 'chest' }, { open: () => new Promise(() => {}) });
  t0 = Date.now();
  await assert.rejects(build.openNearestChest(w.ctx, w.t, at), e => /сервер не открыл окно за 5 с/.test(e.message) && /над сундуком: air/.test(e.message) && /муха: 0 64 2/.test(e.message) && e.extra && e.extra.diag && e.extra.diag.above === 'air');
  assert(Date.now() - t0 < 7000);
  console.log('chest: OK');
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
