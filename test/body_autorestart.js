// Офлайн-проверка автоперезапуска тела (tools/body_autorestart.js): когда момент безопасный, какие правки ждут перезапуска,
// откат правки из её резерва. Живое (процессы, сервер) не трогается — только чистые функции и временная папка.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../tools/body_autorestart');

const snap = o => ({ ready: true, health: 20, onGround: true, timeOfDay: 'day', eyes: { enemies: [], threats: [] }, sheltered: { closed: false }, autopilot: { doing: null }, stats: { uptime: 100 }, ...o });

// день, спокойно — можно
assert(B.safety(snap({}), null).ok);
// ночь в закрытом укрытии, зомби рядом, HP мало — можно (хозяин: «закрыта — тоже считается, даже если рядом зомби»)
assert(B.safety(snap({ timeOfDay: 'night', health: 3, eyes: { enemies: [{ name: 'zombie' }], threats: [] }, sheltered: { closed: true } }), { name: 'wait_night' }).ok);
// в укрытии, но собралась идти — нельзя
assert(!B.safety(snap({ sheltered: { closed: true } }), { name: 'collect' }).ok);
// ночь без закрытого укрытия — нельзя
assert(!B.safety(snap({ timeOfDay: 'night' }), null).ok);
// день: мало HP, враги, в воздухе, бой — нельзя
assert(!B.safety(snap({ health: 9 }), null).ok);
assert(!B.safety(snap({ eyes: { enemies: [{}], threats: [] } }), null).ok);
assert(!B.safety(snap({ eyes: { enemies: [], threats: [{}] } }), null).ok);
assert(!B.safety(snap({ onGround: false }), null).ok);
assert(!B.safety(snap({ autopilot: { doing: 'побег от зомби' } }), null).ok);
assert(!B.safety({ ready: false }, null).ok);

// ждут перезапуска только сделанные правки тела новее запуска тела
const core = { requests: {
  a: { status: 'done', finishedAt: 50, changed: ['lib/x.js'] },          // старше запуска тела — уже включена
  b: { status: 'done', finishedAt: 200, changed: ['lib/skills/y.js'] },
  c: { status: 'done', finishedAt: 300, changed: ['audit/index.html'] },  // не тело
  d: { status: 'reverted', finishedAt: 400, changed: ['bot.js'] },
  e: { status: 'done', finishedAt: 150, changed: ['test/z.js', 'bot.js'] }
} };
assert.deepStrictEqual(B.pendingEdits(core, 100).map(r => r.id), ['e', 'b']);
assert(!B.coreBusy(core));
assert(B.coreBusy({ requests: { q: { status: 'working' } } }));

// откат: изменённый файл — из резерва, добавленный — удалить
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bodyrs-'));
const tasks = path.join(root, 'data', 'core_tasks');
fs.mkdirSync(path.join(tasks, 'r1', 'backup', 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.writeFileSync(path.join(tasks, 'r1', 'before.json'), JSON.stringify({ files: { 'lib/a.js': 'h1', 'bot.js': 'h2' } }));
fs.writeFileSync(path.join(tasks, 'r1', 'backup', 'lib', 'a.js'), 'old');
fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'broken');
fs.writeFileSync(path.join(root, 'lib', 'new.js'), 'added');
const rv = B.revertEdit(root, tasks, 'r1', ['lib/a.js', 'lib/new.js']);
assert(rv.ok);
assert.strictEqual(fs.readFileSync(path.join(root, 'lib', 'a.js'), 'utf8'), 'old');
assert(!fs.existsSync(path.join(root, 'lib', 'new.js')));
assert(!B.revertEdit(root, tasks, 'nope', ['lib/a.js']).ok);
fs.rmSync(root, { recursive: true, force: true });

console.log('body_autorestart: ok');
