// Какая модель у какой роли (мозг, учитель, инженер). Один файл настроек: data/models.json (data/ вне git).
//   {"brain":"opencode/...","teacher":"opencode/...","engineer":"opencode/..."}
// Его пишет вкладка «Модели» в аудите, а читают: night.cmd (мозг, перед каждой сессией) и brain_guard.ps1 (учитель — перед каждым
// случаем, инженер — перед каждой заявкой). Нет файла или в нём мусор — берётся значение по умолчанию.
// Без зависимостей. Из командной строки:  node models_config.js get brain|teacher|engineer   (печатает id модели; если она
// недоступна — запасную, см. effective)
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
    const raw = readRaw(dir), keep = raw.reserve;   // запасную модель и её выключатель не терять при сохранении моделей ролей
    fs.writeFileSync(tmp, JSON.stringify({ brain: next.brain, teacher: next.teacher, engineer: next.engineer, ...(validModelId(keep) ? { reserve: keep } : {}), ...(raw.reserveOn === false ? { reserveOn: false } : {}) }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { return { ok: false, error: 'не удалось записать ' + FILE_NAME + ': ' + (e && e.message || e) }; }
  return { ok: true, models: next };
}

// Запасная модель (поле "reserve" в models.json; нет — Gemini Flash-Lite по ключу Google): берётся вместо модели роли, пока та
// за последние DOWN_MS дала в журнале opencode DOWN_N+ ошибок «модель недоступна / лимит» (так 22.10 тихо пропала minimax).
// Обрыв связи сюда не входит: без сети запасная не поможет. Через DOWN_MS без новых ошибок роль сама возвращается к своей модели.
const RESERVE = 'google/gemini-3.5-flash-lite';
const DOWN_MS = 2 * 3600e3, DOWN_N = 3;
const DOWN_RE = /Endpoint is unavailable|Insufficient account funds|ProviderModelNotFound|Model not found|Free usage limit|Rate limit exceeded/;
const OC_LOG = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'opencode', 'log', 'opencode.log');

function downCount(id, logFile = OC_LOG, now = Date.now()) {
  const [prov, ...rest] = id.split('/'), model = rest.join('/');
  let s = '';
  try {
    const fd = fs.openSync(logFile, 'r'); const size = fs.fstatSync(fd).size, n = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd); s = buf.toString('utf8');
  } catch (e) { return 0; }
  let c = 0;
  for (const line of s.split('\n')) {
    if (!line.includes('level=ERROR') || !line.includes(`providerID=${prov} `) || !line.includes(`modelID=${model} `) || !DOWN_RE.test(line)) continue;
    const t = Date.parse((line.match(/^timestamp=(\S+)/) || [])[1]);
    if (t && now - t < DOWN_MS) c++;
  }
  return c;
}

// Выключатель запасной (вкладка «Модели» в аудите, поле "reserveOn" в models.json; нет поля — включена).
// Хозяин выключает, когда запасная не годится: 23.10 без VPN сменился регион, Gemini отказал — инженер стоял.
function reserveOn(dir) { return readRaw(dir).reserveOn !== false; }
function setReserve(on, dir) {
  if (typeof on !== 'boolean') return { ok: false, error: 'reserveOn: нужно true или false' };
  const file = filePath(dir);
  try {
    const raw = readRaw(dir);
    if (on) delete raw.reserveOn; else raw.reserveOn = false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) { return { ok: false, error: 'не удалось записать ' + FILE_NAME + ': ' + (e && e.message || e) }; }
  return { ok: true, reserveOn: on };
}

// модель, которую роль реально запустит сейчас -> { id, reserve: bool }
function effective(role, dir, logFile) {
  const id = get(role, dir);
  const raw = readRaw(dir);
  if (raw.reserveOn === false) return { id, reserve: false };
  const reserve = validModelId(raw.reserve) ? raw.reserve : RESERVE;
  if (reserve === id || downCount(id, logFile) < DOWN_N || downCount(reserve, logFile) >= DOWN_N) return { id, reserve: false };
  return { id: reserve, reserve: true };
}

module.exports = { ROLES, DEFAULTS, FILE_NAME, RESERVE, validModelId, read, get, save, filePath, downCount, effective, reserveOn, setReserve };

if (require.main === module) {
  const [cmd, role] = process.argv.slice(2);
  if (cmd === 'get' && ROLES.includes(role)) { process.stdout.write(effective(role).id + '\n'); }
  else { console.error('использование: node models_config.js get brain|teacher|engineer'); process.exit(2); }
}
