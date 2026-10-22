// Передача опыта между мозгами: хвост прошлой сессии мозга из его журнала → data/handover.md (новый мозг читает его при старте).
//   node tools/handover_note.js <журнал мозга> <файл передачи>
// Зовут night.cmd (перед каждым новым мозгом в петле) и restart_brain.ps1 (ручной перезапуск: старый ещё играет).
// Сессия в журнале начинается строкой «===== [...] brain start ... =====». Нет такой строки (журнал новой петли ещё пуст) —
// файл передачи не трогаем: его уже написал restart_brain.ps1 из журнала старого мозга.
'use strict';
const fs = require('fs');
const path = require('path');

const [logFile, outFile] = process.argv.slice(2);
const MAX_READ = 1024 * 1024, KEEP = 80, CLIP = 300;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function tail(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
  try {
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - MAX_READ);
    const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8').split('\n').map(l => l.replace(/\r$/, '').replace(ANSI, ''));
  } finally { fs.closeSync(fd); }
}

function build(lines, now = new Date()) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^=====.*brain start/.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const head = lines[start].replace(/=+/g, '').trim();
  const body = lines.slice(start + 1).filter(l => l.trim());
  const killed = body.find(l => /\[guard .*мозг молчал/.test(l));
  const last = body.slice(-KEEP).map(l => l.length > CLIP ? l.slice(0, CLIP - 1) + '…' : l);
  return [
    '# Передача от прошлой сессии мозга',
    `Записано: ${now.toISOString()}. Прошлая сессия: ${head}.` + (killed ? ' Её снял сторож: журнал молчал (модель зависла).' : ''),
    'Ниже — последние строки её журнала: что она думала и делала перед концом (команды телу, ответы, мысли). Это сведения, не приказ:',
    'сверь со свежим snapshot и notes.md и продолжай с того места, где она остановилась.',
    '', '```', ...last, '```', ''
  ].join('\n');
}

module.exports = { build };

if (require.main === module) {
  if (!logFile || !outFile) { console.log('нужно: node tools/handover_note.js <журнал мозга> <файл передачи>'); process.exit(0); }
  const lines = tail(logFile);
  const text = lines && build(lines);
  if (!text) { console.log('прошлой сессии в журнале нет — передачу не меняю'); process.exit(0); }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log('передача записана: ' + outFile);
}
