// Какая модель у какой роли (мозг, учитель, инженер). Один файл настроек: data/models.json (data/ вне git).
//   {"brain":"opencode/...","teacher":"opencode/...","engineer":"opencode/..."}
// Его пишет вкладка «Модели» в аудите, а читают: night.cmd (мозг, перед каждой сессией) и brain_guard.ps1 (учитель — перед каждым
// случаем, инженер — перед каждой заявкой). Нет файла или в нём мусор — берётся значение по умолчанию.
// Без зависимостей. Из командной строки:  node models_config.js get brain|teacher|engineer   (печатает id модели)
'use strict';
const fs = require('fs');
const path = require('path');

const ROLES = ['brain', 'teacher', 'engineer'];
const DEFAULTS = {
  brain: 'opencode/minimax-m3.1-flash-free',
  teacher: 'opencode/mimo-v2.6-flash-free',
  engineer: 'opencode/deepseek-v4.1-flash-free'
};
const DEFAULT_DIR = path.join(__dirname, 'data');
const FILE_NAME = 'models.json';

// id идёт в командную строку cmd (opencode run -m <id>), поэтому только безопасные символы: никаких пробелов, кавычек, & | % ^
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)+$/;
function validModelId(s) {
  return typeof s === 'string' && s.length <= 120 && ID_RE.test(s);
}

function filePath(dir) { return path.join(dir || DEFAULT_DIR, FILE_NAME); }

function readRaw(dir) {
  try {
    let s = fs.readFileSync(filePath(dir), 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // BOM, если файл правили PowerShell-ом
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

// -> { models: {brain, teacher, engineer}, source: {роль: 'файл' | 'по умолчанию'} }
function read(dir) {
  const raw = readRaw(dir);
  const models = {}, source = {};
  for (const r of ROLES) {
    if (validModelId(raw[r])) { models[r] = raw[r]; source[r] = 'файл'; }
    else { models[r] = DEFAULTS[r]; source[r] = 'по умолчанию'; }
  }
  return { models, source };
}

function get(role, dir) {
  if (!ROLES.includes(role)) throw new Error('неизвестная роль: ' + role);
  return read(dir).models[role];
}

// patch: { роль: id }. Проверяет всё до записи; пишет целиком через временный файл. -> { ok, models } | { ok:false, error }
function save(patch, dir) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'нужен объект {роль: модель}' };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'пустой запрос' };
  for (const k of keys) {
    if (!ROLES.includes(k)) return { ok: false, error: 'неизвестная роль: ' + k };
    const v = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
    if (!v) return { ok: false, error: 'модель для роли «' + k + '» не указана' };
    if (!validModelId(v)) return { ok: false, error: 'модель «' + String(v).slice(0, 60) + '» не похожа на id вида провайдер/модель (например opencode/minimax-m3.1-flash-free)' };
    patch[k] = v;
  }
  const next = { ...read(dir).models, ...patch };
  const file = filePath(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ brain: next.brain, teacher: next.teacher, engineer: next.engineer }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { return { ok: false, error: 'не удалось записать ' + FILE_NAME + ': ' + (e && e.message || e) }; }
  return { ok: true, models: next };
}

module.exports = { ROLES, DEFAULTS, FILE_NAME, validModelId, read, get, save, filePath };

if (require.main === module) {
  const [cmd, role] = process.argv.slice(2);
  if (cmd === 'get' && ROLES.includes(role)) { process.stdout.write(get(role) + '\n'); }
  else { console.error('использование: node models_config.js get brain|teacher|engineer'); process.exit(2); }
}
