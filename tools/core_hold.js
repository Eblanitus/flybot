// Флаг «ядро сейчас правят руками» (data/core_hold): пока он стоит, инженер не берёт разрешённые запросы на правку ядра
// (lib/core_requests.js take → { busy, hold }, сторож пишет в guard.log «ядро держит …»). Флаг старше 12 часов игнорируется.
//   node tools/core_hold.js on [кто]   — поставить (по умолчанию «Claude»); перед работой над lib/, test/, tools/ …
//   node tools/core_hold.js off        — снять; после работы
//   node tools/core_hold.js status     — стоит ли (и сколько ему часов)
'use strict';
const C = require('../lib/core_requests');

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'on') {
  const r = C.setHold({}, rest.join(' ') || 'Claude');
  console.log('ядро занято: ' + r.hold);
} else if (cmd === 'off') {
  const r = C.clearHold({});
  console.log(r.cleared ? 'флаг снят' : 'флага и не было');
} else if (cmd === 'status') {
  const h = C.readHold({});
  console.log(h ? `занято: ${h.text} (${((Date.now() - h.since) / 3600000).toFixed(1)} ч, снимется само через ${C.HOLD_MAX_MS / 3600000} ч)` : 'свободно');
} else {
  console.log('команды: on [кто] | off | status');
  process.exitCode = 1;
}
