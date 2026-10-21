// Связь поведения с ядром: органы чувств и руки ядра поведение берёт только так — L('perception'), L('actions')…
// Ядро поведение только читает и зовёт, но не меняет. Путь к ядру даёт хост (FLYBOT_CORE): сохранённые версии
// поведения лежат в data/behavior_versions/<id>/, а ядро у них общее.
'use strict';
const path = require('path');
const ROOT = process.env.FLYBOT_CORE || path.join(__dirname, '..');
module.exports = name => require(path.join(ROOT, 'lib', name));
