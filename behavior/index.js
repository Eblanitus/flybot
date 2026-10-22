// Поведение мухи: всё, что решает «как и когда» (автопилот, рефлексы, выбор способа боя, пороги).
// Ядро (lib/behavior_host.js) загружает этот файл, проверяет (selfTest) и только потом включает; сломанную или
// зависшую версию откатывает на последнюю рабочую (data/behavior_versions/). Контракт — behavior/README.md.
'use strict';
const autopilot = require('./autopilot');
const reflexes = require('./reflexes');
const { chooseMelee } = require('./combat');
const thresholds = require('./thresholds');

const API = 1; // версия интерфейса ядро↔поведение

// api: { ctx, bot, every(ms, fn, name), after(ms, fn, name), on(emitter, event, fn), handle(event, fn), log(type, data) }
function attach(api) {
  const parts = [autopilot.attach(api), reflexes.attach(api)];
  return {
    async detach(reason) {
      for (const h of parts) { if (h && typeof h.detach === 'function') { try { await h.detach(reason); } catch (e) {} } }
    }
  };
}

// Быстрая офлайн-проверка перед включением (без бота и сервера)
function selfTest() { return require('./test')(); }

module.exports = { API, name: 'учебные колёса', attach, selfTest, chooseMelee, thresholds };
