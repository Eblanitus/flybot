// Офлайн-проверка tools/rotate_log.js: только во временной папке, живой data/flybot.out.log не трогается.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rotate } = require('../tools/rotate_log');

module.exports = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-rotate-'));
  try {
    const f = path.join(dir, 'flybot.out.log');
    assert.strictEqual(rotate({ file: f }).rotated, null, 'файла нет — ничего не делаем');
    fs.writeFileSync(f, 'x'.repeat(1000));
    let r = rotate({ file: f, maxBytes: 2000 });
    assert.strictEqual(r.rotated, null); assert(fs.existsSync(f), 'меньше порога — на месте');
    // больше порога -> переименован, исходного нет (новый создаст редирект >>)
    const t = (h) => new Date(2026, 9, 31, h, 0, 0);
    r = rotate({ file: f, maxBytes: 500, now: t(1) });
    assert.strictEqual(r.rotated, 'flybot.out.20261031-010000.log'); assert(!fs.existsSync(f));
    assert.strictEqual(fs.readFileSync(path.join(dir, r.rotated), 'utf8').length, 1000, 'содержимое сохранено');
    // хранить 3 последних архива; чужие файлы не трогаем
    fs.writeFileSync(path.join(dir, 'flybot.out.log.bak'), 'не архив'); fs.writeFileSync(path.join(dir, 'runner.out.log'), 'чужой');
    for (const h of [2, 3, 4, 5]) { fs.writeFileSync(f, 'y'.repeat(1000)); r = rotate({ file: f, maxBytes: 500, now: t(h) }); }
    const left = fs.readdirSync(dir).filter(n => /^flybot\.out\.\d{8}-\d{6}/.test(n)).sort();
    assert.deepStrictEqual(left, ['flybot.out.20261031-030000.log', 'flybot.out.20261031-040000.log', 'flybot.out.20261031-050000.log']);
    assert.deepStrictEqual(r.removed, ['flybot.out.20261031-020000.log'], 'удалён только самый старый из лишних');
    assert(fs.existsSync(path.join(dir, 'flybot.out.log.bak')) && fs.existsSync(path.join(dir, 'runner.out.log')));
    // два запуска в одну секунду не затирают архив
    fs.writeFileSync(f, 'z'.repeat(1000)); const a = rotate({ file: f, maxBytes: 500, now: t(5) });
    assert.strictEqual(a.rotated, 'flybot.out.20261031-050000-1.log');
    // из командной строки: код 0, файл переименован; на несуществующем файле тоже 0
    fs.writeFileSync(f, 'w'.repeat(3 * 1048576));
    let p = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'rotate_log.js'), f, '--max-mb', '2'], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0); assert(/rotate_log: flybot\.out\.\d{8}-\d{6}/.test(p.stdout), p.stdout); assert(!fs.existsSync(f));
    p = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'rotate_log.js'), path.join(dir, 'нет.log')], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('rotate_log: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
