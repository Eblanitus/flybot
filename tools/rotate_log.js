// Ротация data/flybot.out.log перед стартом тела (его пишет cmd-редирект `>> data\flybot.out.log`, пока тело работает файл открыт).
//   node tools/rotate_log.js [файл] [--max-mb 20] [--keep 3]
// Файл больше порога -> переименовывается в flybot.out.<ГГГГММДД-ЧЧММСС>.log (рядом), остаются 3 последних архива, старые удаляются.
// Зовут night.cmd, restart_body.ps1 и tools/body_autorestart.js ДО запуска тела. Никогда не роняет запуск: любая ошибка (файл занят
// работающим телом, нет прав) — одна строка в вывод и код выхода 0. Новый flybot.out.log создаст сам редирект `>>`.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'flybot.out.log');
const MAX_BYTES = 20 * 1024 * 1024;
const KEEP = 3;
const pad = n => String(n).padStart(2, '0');
const stampOf = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// -> { rotated: имя|null, removed: [имена], reason?: строка }
function rotate({ file = DEFAULT_FILE, maxBytes = MAX_BYTES, keep = KEEP, now = new Date() } = {}) {
  const dir = path.dirname(file);
  const ext = path.extname(file);                 // .log
  const base = path.basename(file, ext);          // flybot.out
  const res = { rotated: null, removed: [] };
  let size;
  try { size = fs.statSync(file).size; } catch (e) { return { ...res, reason: 'файла нет' }; }
  if (size <= maxBytes) return { ...res, reason: `размер ${Math.round(size / 1048576)} МБ, не больше порога` };
  let target = path.join(dir, `${base}.${stampOf(now)}${ext}`);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${base}.${stampOf(now)}-${i}${ext}`);
  try { fs.renameSync(file, target); } catch (e) { return { ...res, reason: 'не удалось переименовать (файл занят?): ' + (e && e.code || e.message) }; }
  res.rotated = path.basename(target);
  // архивы: flybot.out.<цифры…>.log; метка в имени сортируется как время — оставляем keep последних
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.\\d{8}-\\d{6}(-\\d+)?' + ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  let old = [];
  try { old = fs.readdirSync(dir).filter(n => re.test(n)).sort().reverse(); } catch (e) {}
  for (const n of old.slice(Math.max(0, keep))) {
    try { fs.unlinkSync(path.join(dir, n)); res.removed.push(n); } catch (e) {}
  }
  return res;
}

module.exports = { rotate, MAX_BYTES, KEEP };

if (require.main === module) {
  try {
    const a = process.argv.slice(2);
    const opt = { };
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--max-mb') opt.maxBytes = Number(a[++i]) * 1048576;
      else if (a[i] === '--keep') opt.keep = Number(a[++i]);
      else opt.file = path.resolve(a[i]);
    }
    const r = rotate(opt);
    if (r.rotated) console.log(`rotate_log: ${r.rotated}` + (r.removed.length ? `; удалено старых: ${r.removed.join(', ')}` : ''));
    else if (r.reason && /не удалось/.test(r.reason)) console.log('rotate_log: ' + r.reason);
  } catch (e) { console.log('rotate_log: ' + (e && e.message)); }
  process.exit(0);
}
