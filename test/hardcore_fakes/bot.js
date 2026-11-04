// Поддельный бот для test/hardcore.js: пишет карточку и выходит. Ник HC_2 — без карточки (как будто упал).
// FAKE_BOT_WAIT_MS — пожить столько перед смертью (нужно тесту консоли хозяина).
'use strict';
const fs = require('fs');
const arg = k => process.argv[process.argv.indexOf('--' + k) + 1];
const name = arg('name');
if (name === 'HC_2') process.exit(1);
setTimeout(() => {
  fs.writeFileSync(arg('out'), JSON.stringify({ nick: name, result: 'death', lifeSec: 42, firstNightSurvived: true, wtStart: 0, wtEnd: 30000,
    events: [{ wt: 0, kind: 'start', text: 'старт' }, { wt: 5000, kind: 'eat', text: 'поел: bread' }, { wt: 23000, kind: 'night_survived', text: 'пережил первую ночь' }, { wt: 30000, kind: 'death', text: 'смерть: Zombie' }] }));
  process.exit(0);
}, +(process.env.FAKE_BOT_WAIT_MS || 0));
