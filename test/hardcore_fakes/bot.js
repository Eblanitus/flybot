// Поддельный бот для test/hardcore.js: пишет карточку и выходит. Ник HC_2 — без карточки (как будто упал).
'use strict';
const fs = require('fs');
const arg = k => process.argv[process.argv.indexOf('--' + k) + 1];
const name = arg('name');
if (name === 'HC_2') process.exit(1);
fs.writeFileSync(arg('out'), JSON.stringify({ nick: name, result: 'death', lifeSec: 42, firstNightSurvived: false }));
