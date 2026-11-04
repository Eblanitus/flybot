// Поддельный сервер для test/hardcore.js: «генерирует» мир, пишет Done, на stop выходит. FAKE_FAIL=1 — падает сразу.
'use strict';
const fs = require('fs');
const path = require('path');
if (process.env.FAKE_FAIL === '1') { console.log('Error: fake crash'); process.exit(1); }
const props = fs.readFileSync('server.properties', 'utf8');
const level = /^level-name=(.*)$/m.exec(props)[1];
const seed = /^level-seed=(.*)$/m.exec(props)[1];
fs.mkdirSync(path.join(level, 'region'), { recursive: true });
fs.writeFileSync(path.join(level, 'level.dat'), 'seed=' + seed);
console.log('[00:00:01] [Server thread/INFO]: Preparing level "' + level + '"');
setTimeout(() => {
  console.log('[00:00:02] [Server thread/INFO]: Done (1.000s)! For help, type "help"');
  console.log('[00:00:02] [Server thread/INFO]: HC_1 joined the game');
  console.log('[00:00:02] [Server thread/INFO]: HC_2 joined the game');
  console.log('[00:00:03] [Server thread/INFO]: HC_1 was slain by Zombie');
}, 200);
process.stdin.on('data', d => { if (!/stop/.test(String(d))) console.log('[00:00:05] [Server thread/INFO]: got: ' + String(d).trim()); if (/stop/.test(String(d))) { console.log('[00:00:09] [Server thread/INFO]: Stopping server'); process.exit(0); } });
