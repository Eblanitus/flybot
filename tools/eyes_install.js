// Ставит датапак flyeyes в мир хозяина: tools/eyes_datapack/flyeyes -> <мир>/datapacks/flyeyes.
// Мир берётся из data/eyes.json (ключ world) или по умолчанию это мир «muha 0_2». Запуск: node tools/eyes_install.js [путь_к_миру]
// Хозяину после установки один раз: /reload в игре (или перезайти в мир). Дальше датапак работает сам.
'use strict';
const path = require('path');
const E = require('../lib/eyes');
const C = require('../lib/eyes_client');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'eyes_datapack', 'flyeyes');

const cfg = E.readConfig(path.join(ROOT, 'data', 'eyes.json'));
const world = process.argv[2] || cfg.world;
const r = C.installDatapack(SRC, world);
if (!r.ok) { console.error('не установлен:', r.error); process.exit(1); }
console.log('датапак установлен:', r.dst);
console.log('файлов:', r.files.length);
for (const f of r.files) console.log('  ' + f);
console.log('Дальше: в игре один раз выполнить /reload (или перезайти в мир).');
