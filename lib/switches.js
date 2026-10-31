// Пульт: какие части мухи включены. Один файл: data/switches.json (data/ вне git).
//   {"body":true,"brain":false,"teacher":false,"engineer":false,"eyes":true,"at":1761800000000}
// Пишет вкладка «Пульт» в аудите. Читают: bot.js (тело выходит из игры и не заходит), night.cmd (мозг — перед каждой
// сессией opencode), brain_guard.ps1 (учитель, инженер и помощник — перед каждым запуском), tools/eyes.js (глаза).
// «Выключено» = часть не берёт новую работу, её цикл жив и ждёт; идущую сессию никто не убивает.
// Нет файла или в нём мусор — всё включено (как было до пульта). Поле без true/false — включено.
// Без зависимостей. Из командной строки (для cmd и ps1):
//   node lib/switches.js get <часть> [--dir <папка data>]       -> on | off
//   node lib/switches.js set <часть> on|off [--dir <папка data>] -> on | off
//   node lib/switches.js show [--dir <папка data>]              -> одна строка JSON
'use strict';
const fs = require('fs');
const path = require('path');

const PARTS = ['body', 'brain', 'teacher', 'engineer', 'eyes'];
const LABELS = { body: 'Тело', brain: 'Мозг', teacher: 'Учитель', engineer: 'Инженер', eyes: 'Глаза' };
const FILE_NAME = 'switches.json';
const DEFAULT_DIR = path.join(__dirname, '..', 'data');
// готовые наборы для пульта
const PRESETS = {
  all_off: { body: false, brain: false, teacher: false, engineer: false, eyes: false },
  body_eyes: { body: true, brain: false, teacher: false, engineer: false, eyes: true },
  all_on: { body: true, brain: true, teacher: true, engineer: true, eyes: true }
};

function filePath(dir) { return path.join(dir || DEFAULT_DIR, FILE_NAME); }

function readRaw(dir) {
  try {
    let s = fs.readFileSync(filePath(dir), 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // BOM, если файл правили PowerShell-ом
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

// -> { body: true|false, ... }  (выключено только явное false)
function read(dir) {
  const raw = readRaw(dir), out = {};
  for (const p of PARTS) out[p] = raw[p] !== false;
  return out;
}
// когда пульт меняли последний раз (мс) или null
function changedAt(dir) { const a = readRaw(dir).at; return typeof a === 'number' && a > 0 ? a : null; }

function isOn(part, dir) {
  if (!PARTS.includes(part)) throw new Error('неизвестная часть: ' + part);
  return read(dir)[part];
}

const asBool = v => v === true || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'off' || v === 0 || v === '0' ? false : null;

// patch: { часть: true|false|'on'|'off' } или имя набора (PRESETS). Проверяет всё до записи; пишет целиком через временный файл.
// -> { ok, switches } | { ok:false, error }
function save(patch, dir) {
  if (typeof patch === 'string') { if (!PRESETS[patch]) return { ok: false, error: 'неизвестный набор: ' + patch.slice(0, 40) }; patch = PRESETS[patch]; }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'нужен объект {часть: true|false}' };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'пустой запрос' };
  const next = read(dir);
  for (const k of keys) {
    if (!PARTS.includes(k)) return { ok: false, error: 'неизвестная часть: ' + String(k).slice(0, 40) };
    const v = asBool(patch[k]);
    if (v == null) return { ok: false, error: `для «${k}» нужно true/false` };
    next[k] = v;
  }
  const file = filePath(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ ...next, at: Date.now() }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { return { ok: false, error: 'не удалось записать ' + FILE_NAME + ': ' + (e && e.message || e) }; }
  return { ok: true, switches: next };
}

// ---------- командная строка ----------
function cli(argv) {
  const a = argv.slice();
  let dir;
  const i = a.indexOf('--dir'); if (i >= 0) { dir = a[i + 1]; a.splice(i, 2); }
  const [cmd, part, val] = a;
  if (cmd === 'get' && PARTS.includes(part)) return { code: 0, out: isOn(part, dir) ? 'on' : 'off' };
  if (cmd === 'set' && PARTS.includes(part) && asBool(val) != null) {
    const r = save({ [part]: asBool(val) }, dir);
    return r.ok ? { code: 0, out: r.switches[part] ? 'on' : 'off' } : { code: 1, out: r.error };
  }
  if (cmd === 'show') return { code: 0, out: JSON.stringify(read(dir)) };
  return { code: 2, out: 'использование: node lib/switches.js get|set <' + PARTS.join('|') + '> [on|off] [--dir папка] | show' };
}

module.exports = { PARTS, LABELS, PRESETS, FILE_NAME, filePath, read, isOn, save, changedAt, cli };

if (require.main === module) {
  const r = cli(process.argv.slice(2));
  process.stdout.write(r.out + '\n');
  process.exitCode = r.code;
}
