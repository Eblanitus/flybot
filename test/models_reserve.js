// Выключатель запасной модели (models_config.js, вкладка «Модели» в аудите): выключена — роль всегда на своей модели,
// даже когда та отказывает; сохранение моделей ролей выключатель не теряет. Всё на временной папке и своём журнале opencode.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../models_config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'));
const log = path.join(dir, 'opencode.log');
const now = new Date().toISOString();
const err = `timestamp=${now} level=ERROR message="stream error" providerID=opencode modelID=nemo-free small=false error.error="Free usage limit reached"\n`;
fs.writeFileSync(log, err + err + err);
assert(M.save({ engineer: 'opencode/nemo-free' }, dir).ok);

// по умолчанию запасная включена: три отказа — роль на запасной
assert(M.reserveOn(dir));
assert.deepStrictEqual(M.effective('engineer', dir, log), { id: M.RESERVE, reserve: true });

// выключил — своя модель, хоть и отказывает
assert(M.setReserve(false, dir).ok);
assert(!M.reserveOn(dir));
assert.deepStrictEqual(M.effective('engineer', dir, log), { id: 'opencode/nemo-free', reserve: false });

// смена модели роли выключатель не сбрасывает
assert(M.save({ teacher: 'opencode/other-free' }, dir).ok);
assert(!M.reserveOn(dir));
assert.strictEqual(M.get('engineer', dir), 'opencode/nemo-free');

// включил обратно; мусор не принимается
assert(M.setReserve(true, dir).ok);
assert(M.reserveOn(dir));
assert.strictEqual(M.effective('engineer', dir, log).reserve, true);
assert(!M.setReserve('нет', dir).ok);

fs.rmSync(dir, { recursive: true, force: true });
console.log('models_reserve: ok');
