// Исполнитель выученных навыков («мозг учится»).
// Запуск: node brain/runner.js   (HTTP на 127.0.0.1:3200; env RUNNER_PORT, BODY_URL)
// Каждый запуск навыка — отдельный дочерний процесс (worker.js): файл читается заново (горячая подгрузка),
// зависание или падение навыка не трогает исполнитель.
//
// Эндпоинты:
//   GET  /skills                         — выученные навыки + статистика (каждая версия — отдельной строкой)
//   GET  /catalog[?name=X]               — коротко для мозга: навык -> версии, лучшие по счёту сверху (текст)
//   GET  /log?since=N&limit=100          — журнал запусков
//   GET  /health                         — состояние исполнителя и доступность тела
//   POST /run      {name, params, timeout_sec?}  — запустить и дождаться (по умолчанию 300 с, максимум 1800)
//   POST /check    {name}                — проверить файл без запуска
//   POST /rollback {name}                — отменить правку файла на месте (вернуть содержимое из .history)
//   POST /enable | /disable {name}       — включить / выключить
//   POST /abort                          — убить текущий запуск и отправить телу stop
// POST — только с Content-Type: application/json, тело до 64 КБ.
// Версии (brain/versions.js): build_hut, build_hut_v2, build_hut_v3… — отдельные файлы, отдельный счёт.
// Версию исполнитель сам не выключает: провалы и успехи каждой версии считаются и видны мозгу, решает мозг (/disable).
// Всё, что попало в .history (правка на месте), само становится новой версией — ничего не теряется.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const { fork } = require('child_process');
const bodyapi = require('./bodyapi');
const V = require('./versions');

const PORT = parseInt(process.env.RUNNER_PORT || '3200', 10);
const BODY_URL = (process.env.BODY_URL || bodyapi.DEFAULT_URL).replace(/\/+$/, '');
const DIR = __dirname;
const DATA = process.env.RUNNER_DATA ? path.resolve(process.env.RUNNER_DATA) : DIR; // для проверок: своя папка с learned/ и статистикой
const LEARNED = path.join(DATA, 'learned');
const HISTORY = path.join(LEARNED, '.history');
const TRASH = path.join(LEARNED, '.trash');
const STATS_FILE = path.join(DATA, 'skills_stats.json');
const LOG_FILE = path.join(DATA, 'runner.log');
const WORKER = path.join(DIR, 'worker.js');

const DEFAULT_TIMEOUT = 300, MAX_TIMEOUT = 1800, CHECK_TIMEOUT = 10;
const MAX_BODY = 64 * 1024;
const HISTORY_KEEP = 20;      // версий навыка в истории
const LOG_RING = 500;
const NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;

for (const d of [LEARNED, HISTORY, TRASH, path.join(LEARNED, ".tmp")]) fs.mkdirSync(d, { recursive: true });

const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const fileOf = name => path.join(LEARNED, name + '.js');
const tsName = () => nowIso().replace(/[-:T]/g, '').replace('.', '-').replace('Z', ''); // 20261021123456-789

// ---------- Журнал ----------
let logSeq = 0;
const logBuf = [];
function logAdd(type, data = {}) {
  const e = { id: ++logSeq, time: nowIso(), type, ...data };
  logBuf.push(e);
  if (logBuf.length > LOG_RING) logBuf.splice(0, logBuf.length - LOG_RING);
  fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {});
  if (type !== 'log') console.log('[runner]', type, JSON.stringify(data).slice(0, 200));
  return e;
}
(function restoreLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-LOG_RING);
    for (const l of lines) { try { const e = JSON.parse(l); logBuf.push(e); logSeq = Math.max(logSeq, e.id); } catch (er) {} }
  } catch (e) { console.log('[runner] не смог восстановить журнал:', e.message); }
})();

// ---------- Статистика ----------
let stats = {};
try { if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) || {}; } catch (e) { console.log('[runner] skills_stats.json повреждён, начинаю заново:', e.message); stats = {}; }
function saveStats() {
  try {
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) { console.log('[runner] не смог записать статистику:', e.message); }
}
function stat(name) {
  if (!stats[name]) stats[name] = { enabled: true, runs: 0, ok: 0, fail: 0, consecutiveFails: 0, lastError: null, lastRun: null, lastOk: null };
  return stats[name];
}
const isEnabled = name => !(stats[name] && stats[name].enabled === false);
const statView = name => {
  const s = stats[name] || stat(name);
  return { runs: s.runs, ok: s.ok, fail: s.fail, consecutiveFails: s.consecutiveFails, lastError: s.lastError, lastRun: s.lastRun, lastOk: s.lastOk };
};

// ---------- История версий ----------
function historyList(name) {
  const re = new RegExp('^' + name + '\\.(\\d{14}-\\d{3})\\.js$');
  let files = [];
  try { files = fs.readdirSync(HISTORY).filter(f => re.test(f)); } catch (e) {}
  files.sort().reverse(); // новые первыми
  return files.map(f => {
    const full = path.join(HISTORY, f);
    return { file: f, full, hash: sha(fs.readFileSync(full, 'utf8')) };
  });
}
function trash(fullPath, label) {
  try { fs.renameSync(fullPath, path.join(TRASH, `${label}.${tsName()}.js`)); } catch (e) { try { fs.unlinkSync(fullPath); } catch (er) {} }
}
// Положить текущую версию в историю, если её там нет (вызывается после успешного check/run)
function snapshotVersion(name) {
  let src;
  try { src = fs.readFileSync(fileOf(name), 'utf8'); } catch (e) { return null; }
  const h = sha(src);
  const list = historyList(name);
  const same = list.findIndex(e => e.hash === h);
  if (same === 0) return null;                       // уже верхняя версия
  const newFile = `${name}.${tsName()}.js`;
  if (same > 0) { fs.renameSync(list[same].full, path.join(HISTORY, newFile)); return null; } // подняли наверх стека
  fs.writeFileSync(path.join(HISTORY, newFile), src);
  importVersions(); // до обрезки истории: старые снимки уже лежат версиями
  for (const old of historyList(name).slice(HISTORY_KEEP)) trash(old.full, old.file.replace(/\.js$/, ''));
  logAdd('version_saved', { name, file: newFile });
  return newFile;
}

// История -> версии: каждый снимок с новым кодом становится <имя>_v<N> (копия; .history не трогаем)
let importSig = null;
function importVersions() {
  let sig;
  try { sig = fs.readdirSync(HISTORY).sort().join('|'); } catch (e) { return []; }
  if (sig === importSig) return [];
  let made = [];
  try { made = V.importHistory(LEARNED, { historyDir: HISTORY }); } catch (e) { console.log('[runner] версии из истории:', e.message); return []; }
  importSig = sig;
  for (const m of made) logAdd('version_imported', { name: m.name, from: m.from });
  return made;
}

// ---------- Проверка файла ----------
function lintSource(src) {
  const w = [];
  if (/process\.exit/.test(src)) w.push('process.exit убьёт процесс навыка без отчёта: возвращай {ok:false, error} вместо этого');
  if (/child_process/.test(src)) w.push('child_process в навыке не нужен: используй api.cmd/api.start');
  if (/mineflayer/.test(src)) w.push('прямого доступа к mineflayer нет: собирай навык из api.cmd(...)');
  if (/require\(\s*['"]\.\.?[\/\\]/.test(src)) w.push('относительный require: навык должен быть самодостаточным (другие навыки — через api.skill)');
  if (/while\s*\(\s*(true|1)\s*\)/.test(src)) w.push('while(true): убедись, что есть выход и await; тайм-аут запуска по умолчанию 300 с');
  if (/text['"]?\s*:\s*['"`]\//.test(src)) w.push('в чат нельзя слать команды, начинающиеся с "/"');
  return w;
}

function syntaxCheck(src, file) {
  try {
    new vm.Script('(function (exports, require, module, __filename, __dirname) {' + src + '\n})', { filename: file });
    return null;
  } catch (e) {
    return String(e.stack || e.message).split('\n').filter(l => !/^\s+at /.test(l)).slice(0, 15).join('\n').replace(/\\/g, '/').split(DIR.replace(/\\/g, '/') + '/').join('brain/');
  }
}

// ---------- Дочерние процессы ----------
// msg отправляется в worker. onMessage — для сообщений log/nested. handle.abort(reason) убивает процесс.
function runChild(msg, timeoutSec, { onMessage, onHandle } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: process.env });
    } catch (e) { return resolve({ result: null, output: '', spawnError: e.message }); }
    let output = ''; let result = null; let done = false; let timedOut = false; let aborted = null;
    let timer = null;
    const finish = extra => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill(); } catch (e) {}
      resolve({ result, output: output.trim(), timedOut, aborted, ...extra });
    };
    const grab = c => { if (output.length < 6000) output += c.toString('utf8'); };
    child.stdout.on('data', grab); child.stderr.on('data', grab);
    child.on('message', m => {
      if (m && m.type === 'result') { result = m; finish({}); } else if (onMessage) onMessage(m);
    });
    child.on('exit', (code, signal) => finish({ exitCode: code, signal }));
    child.on('error', e => finish({ spawnError: e.message }));
    timer = setTimeout(() => { timedOut = true; finish({}); }, timeoutSec * 1000);
    if (onHandle) onHandle({ abort: reason => { aborted = reason || 'прервано'; finish({}); }, pid: child.pid });
    try { child.send(msg); } catch (e) { finish({ spawnError: 'не смог отправить задание: ' + e.message }); }
  });
}

const checkCache = new Map(); // name -> {key, res}
async function checkFile(name, { force = false } = {}) {
  const file = fileOf(name);
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, exists: false, errors: [`файла нет: learned/${name}.js`], warnings: [], meta: null }; }
  const key = `${st.mtimeMs}:${st.size}`;
  const c = checkCache.get(name);
  if (!force && c && c.key === key) return c.res;
  const src = fs.readFileSync(file, 'utf8');
  const warnings = lintSource(src);
  const syn = syntaxCheck(src, file);
  let res;
  if (syn) res = { ok: false, exists: true, errors: ['синтаксическая ошибка:\n' + syn], warnings, meta: null };
  else {
    const r = await runChild({ mode: 'check', file, name }, CHECK_TIMEOUT);
    if (r.result) res = { ok: !!r.result.ok, exists: true, errors: r.result.errors || [], warnings: warnings.concat(r.result.warnings || []), meta: r.result.meta };
    else if (r.timedOut) res = { ok: false, exists: true, errors: [`загрузка файла зависла (> ${CHECK_TIMEOUT} с): на верхнем уровне модуля не должно быть бесконечных циклов и запросов, всё — внутри run()`], warnings, meta: null };
    else res = { ok: false, exists: true, errors: ['процесс проверки упал: ' + (r.spawnError || `код ${r.exitCode}`) + (r.output ? '\n' + r.output.slice(0, 500) : '')], warnings, meta: null };
  }
  checkCache.set(name, { key, res });
  return res;
}

// ---------- Запись результата (счёт версии; выключает только мозг — /disable) ----------
function recordResult(name, ok, error, runId) {
  const s = stat(name);
  s.runs++; s.lastRun = nowIso();
  if (ok) { s.ok++; s.consecutiveFails = 0; s.lastOk = s.lastRun; }
  else { s.fail++; s.consecutiveFails++; s.lastError = String(error || 'неизвестная ошибка').slice(0, 2000); }
  saveStats();
  if (ok) { try { snapshotVersion(name); } catch (e) { console.log('[runner] история:', e.message); } }
}

// ---------- Запуск навыка ----------
let active = null; // {runId, name, startedAt, handle, timeoutSec}
let runSeq = 0;

function capResult(v) {
  try {
    const s = JSON.stringify(v);
    if (s && s.length > 40000) return { truncated: true, preview: s.slice(0, 40000) };
  } catch (e) { return { unserializable: true }; }
  return v;
}

async function doRun(name, params, timeoutSec) {
  const runId = ++runSeq;
  const logs = [];
  const startedAt = Date.now();
  active = { runId, name, startedAt, timeoutSec, handle: null };
  logAdd('run_start', { runId, name, params, timeout_sec: timeoutSec });
  const disabled = Object.keys(stats).filter(n => stats[n].enabled === false);
  const r = await runChild(
    { mode: 'run', file: fileOf(name), name, params, bodyUrl: BODY_URL, learnedDir: LEARNED, disabled },
    timeoutSec,
    {
      onHandle: h => { active.handle = h; },
      onMessage: m => {
        if (m.type === 'log') { if (logs.length < 500) logs.push(m.msg); logAdd('log', { runId, name, msg: m.msg }); }
        else if (m.type === 'nested') {
          recordResult(m.name, m.ok, m.error, runId);
          logAdd('nested', { runId, name: m.name, ok: m.ok, ...(m.ok ? {} : { error: String(m.error).split('\n')[0] }) });
        }
      }
    }
  );
  const sec = Math.round((Date.now() - startedAt) / 100) / 10;
  let ok = false; let error = null; let value; let stopSent = null;

  if (r.timedOut || r.aborted) {
    error = r.timedOut
      ? `тайм-аут ${timeoutSec} с: процесс навыка убит, телу отправлен stop`
      : `запуск прерван (${r.aborted}): процесс навыка убит, телу отправлен stop`;
    try { const sr = await bodyapi.post(BODY_URL, '/cmd', { action: 'stop' }); stopSent = sr && sr.ok !== false ? 'ok' : 'тело ответило: ' + JSON.stringify(sr).slice(0, 200); }
    catch (e) { stopSent = 'не удалось: ' + e.message; }
  } else if (r.result) {
    ok = !!r.result.ok;
    if (ok) value = r.result.value; else { error = r.result.error; value = r.result.value; }
  } else {
    error = 'процесс навыка завершился без результата: ' + (r.spawnError || `код ${r.exitCode}${r.signal ? ', сигнал ' + r.signal : ''}`) + (r.output ? '\n' + r.output.slice(0, 1000) : '');
  }

  recordResult(name, ok, error, runId);
  logAdd('run_end', { runId, name, ok, sec, ...(ok ? {} : { error: String(error).split('\n')[0].slice(0, 300) }), ...(stopSent ? { stop: stopSent } : {}) });
  active = null;

  const out = { ok, name, runId, sec, stats: statView(name) };
  if (ok) out.result = capResult(value);
  else { out.error = error; if (value !== undefined) out.result = capResult(value); }
  if (stopSent) out.stop = stopSent;
  if (logs.length) out.logs = logs.length > 40 ? ['... (показаны последние 40)', ...logs.slice(-40)] : logs;
  if (r.output) out.output = r.output.slice(0, 1500);
  if (!ok) {
    const s = stats[name] || {};
    out.note = `Счёт версии "${name}": успешно ${s.ok || 0} из ${s.runs || 0}, провалов подряд ${s.consecutiveFails || 0}. Другие версии — GET /catalog?name=${V.baseOf(name)}, выключить эту — /disable; причину разбирает учитель (заявка инженеру).`;
  }
  return out;
}

// ---------- Обработчики ----------
function badName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return `плохое имя навыка: ${JSON.stringify(name)} (нужно ^[a-z][a-z0-9_]{1,39}$, как имя файла без .js)`;
  return null;
}

async function listSkills() {
  importVersions();
  let files = [];
  try { files = fs.readdirSync(LEARNED, { withFileTypes: true }).filter(d => d.isFile() && !d.name.startsWith('.')).map(d => d.name); } catch (e) {}
  const skills = []; const ignored = [];
  await Promise.all(files.map(async f => {
    const m = /^(.+)\.js$/.exec(f);
    if (!m || !NAME_RE.test(m[1])) { ignored.push(f); return; }
    const name = m[1];
    const c = await checkFile(name);
    const s = stats[name];
    let note = null;
    try { note = V.noteOf(fs.readFileSync(fileOf(name), 'utf8')); } catch (e) {}
    const pv = V.parseName(name);
    skills.push({
      name,
      base: pv.base, version: pv.n, note,
      description: c.meta ? c.meta.description : null,
      params: c.meta ? c.meta.params : null,
      enabled: isEnabled(name),
      ...(s && s.enabled === false ? { disabledReason: s.disabledReason || 'выключен вручную' } : {}),
      valid: c.ok,
      ...(c.ok ? {} : { errors: c.errors }),
      ...(c.warnings.length ? { warnings: c.warnings } : {}),
      stats: statView(name),
      history: historyList(name).length
    });
  }));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, skills, ...(ignored.length ? { ignoredFiles: ignored, ignoredHint: 'имя файла должно быть вида snake_case.js' } : {}), active: active ? { name: active.name, runId: active.runId } : null };
}

async function handleRun(b) {
  const bad = badName(b.name);
  if (bad) return [400, { ok: false, error: bad }];
  if (!fs.existsSync(fileOf(b.name))) return [404, { ok: false, error: `навык не найден: learned/${b.name}.js` }];
  if (!isEnabled(b.name)) {
    const s = stats[b.name];
    return [200, { ok: false, error: `версия "${b.name}" выключена: ${s.disabledReason || 'вручную'}. Другие версии навыка — GET /catalog?name=${V.baseOf(b.name)}; вернуть эту — /enable.` }];
  }
  if (b.params !== undefined && (b.params === null || typeof b.params !== 'object' || Array.isArray(b.params))) return [400, { ok: false, error: 'params должен быть объектом' }];
  if (active) return [200, { ok: false, error: `исполнитель занят навыком "${active.name}" (runId ${active.runId}, идёт ${Math.round((Date.now() - active.startedAt) / 1000)} с). Дождись или POST /abort.` }];
  let t = Number(b.timeout_sec);
  if (!Number.isFinite(t) || t <= 0) t = DEFAULT_TIMEOUT;
  t = Math.min(Math.max(t, 1), MAX_TIMEOUT);
  return [200, await doRun(b.name, b.params || {}, t)];
}

async function handleCheck(b) {
  const bad = badName(b.name);
  if (bad) return [400, { ok: false, error: bad }];
  const c = await checkFile(b.name, { force: true });
  if (!c.exists) return [404, { ok: false, error: c.errors[0] }];
  let saved = null;
  if (c.ok) saved = snapshotVersion(b.name);
  logAdd('check', { name: b.name, ok: c.ok, ...(c.ok ? {} : { error: c.errors[0].split('\n')[0].slice(0, 200) }) });
  return [200, { ok: c.ok, name: b.name, ...(c.ok ? { meta: c.meta } : {}), errors: c.errors, warnings: c.warnings, ...(saved ? { savedVersion: saved } : {}), enabled: isEnabled(b.name) }];
}

function handleRollback(b) {
  const bad = badName(b.name);
  if (bad) return [400, { ok: false, error: bad }];
  if (active && active.name === b.name) return [200, { ok: false, error: 'навык сейчас запущен; дождись или POST /abort' }];
  importVersions(); // всё из истории уже лежит версиями — откат ничего не теряет
  const file = fileOf(b.name);
  const list = historyList(b.name);
  let curHash = null;
  try { curHash = sha(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const i = curHash ? list.findIndex(e => e.hash === curHash) : -1;
  const target = list[i + 1];
  if (!target) return [200, { ok: false, error: `нет предыдущей версии для "${b.name}" в learned/.history (версий: ${list.length})` }];
  if (curHash && fs.existsSync(file)) fs.copyFileSync(file, path.join(TRASH, `${b.name}.${tsName()}.js`)); // страховка
  let kept = null; // текущий код (правку на месте) не теряем: он остаётся отдельной версией
  try { if (curHash) kept = V.keepAsVersion(LEARNED, V.baseOf(b.name), fs.readFileSync(file, 'utf8'), `отменённая правка ${b.name} (rollback ${nowIso().slice(0, 16)}); ${V.NO_NOTE}`, b.name); } catch (e) { console.log('[runner] rollback: версия не сохранена:', e.message); }
  if (kept) logAdd('version_kept', { name: kept, from: b.name });
  for (let k = 0; k <= i; k++) trash(list[k].full, list[k].file.replace(/\.js$/, '')); // откатываемые версии уходят из стека
  fs.copyFileSync(target.full, file);
  checkCache.delete(b.name);
  const s = stat(b.name);
  s.enabled = true; s.consecutiveFails = 0; delete s.disabledReason; delete s.disabledAt;
  saveStats();
  logAdd('rollback', { name: b.name, restored: target.file });
  return [200, { ok: true, name: b.name, restored: target.file, versionsLeft: list.length - i - 1, ...(kept ? { keptAs: kept } : {}), note: 'отменена правка на месте: файл вернулся к прошлому содержимому, навык включён, счётчик провалов сброшен. Все прежние версии и так доступны по своим именам (GET /catalog?name=' + V.baseOf(b.name) + ').' }];
}

function handleToggle(b, on) {
  const bad = badName(b.name);
  if (bad) return [400, { ok: false, error: bad }];
  if (!fs.existsSync(fileOf(b.name))) return [404, { ok: false, error: `навык не найден: learned/${b.name}.js` }];
  const s = stat(b.name);
  s.enabled = on;
  if (on) { s.consecutiveFails = 0; delete s.disabledReason; delete s.disabledAt; }
  else { s.disabledReason = 'вручную' + (b.reason ? ': ' + String(b.reason).slice(0, 200) : ''); s.disabledAt = nowIso(); }
  saveStats();
  logAdd(on ? 'enable' : 'disable', { name: b.name, ...(b.reason ? { reason: String(b.reason).slice(0, 200) } : {}) });
  return [200, { ok: true, name: b.name, enabled: on, stats: statView(b.name) }];
}

async function handleAbort() {
  if (!active) return [200, { ok: true, note: 'ничего не запущено' }];
  const a = active;
  if (a.handle) a.handle.abort('POST /abort');
  return [200, { ok: true, aborted: a.name, runId: a.runId, note: 'процесс убит, телу уйдёт stop; результат придёт в ответ исходного /run' }];
}

async function health() {
  let body = null;
  try { body = await Promise.race([bodyapi.get(BODY_URL, '/health'), sleep(2000).then(() => ({ error: 'тайм-аут 2 с' }))]); }
  catch (e) { body = { error: e.message }; }
  return { ok: true, runner: { port: PORT, uptimeSec: Math.round(process.uptime()), active: active ? { name: active.name, runId: active.runId, sec: Math.round((Date.now() - active.startedAt) / 1000) } : null }, bodyUrl: BODY_URL, body };
}

// ---------- HTTP ----------
function send(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(res, 400, { ok: false, error: 'bad url' }); }
  // защита от DNS-rebinding: только локальные имена хоста
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) { req.resume(); return send(res, 403, { ok: false, error: 'bad host' }); }
  const q = url.searchParams;
  const guard = p => p.catch(e => send(res, 500, { ok: false, error: String(e && e.stack ? e.stack : e).split('\n').slice(0, 15).join('\n') }));

  if (req.method === 'GET') {
    switch (url.pathname) {
      case '/go': {
        // быстрый запуск без JSON-файла: /go?name=build_hut&x=-390&y=67&z=40 (сразу отвечает; итог — /log, ход — тело :3199/wait)
        // &wait=1 — дождаться конца (но shell мозга обрывает команды длиннее 120 с)
        const h = req.headers;
        if (h.origin || h.referer || (h['sec-fetch-site'] && h['sec-fetch-site'] !== 'none')) return send(res, 403, { ok: false, error: 'запрос из браузера запрещён' });
        const params = {};
        for (const [k, v] of q) { if (k === 'name' || k === 'wait' || k === 'timeout_sec') continue; try { params[k] = JSON.parse(v); } catch (e) { params[k] = v; } }
        const b = { name: q.get('name'), params, timeout_sec: q.get('timeout_sec') };
        const w = q.get('wait');
        if (w === '1' || w === 'true') return guard(handleRun(b).then(([code, obj]) => send(res, code, obj)));
        if (active) return send(res, 200, { ok: false, error: `исполнитель занят навыком "${active.name}" (runId ${active.runId}). Дождись или POST /abort.` });
        const p = handleRun(b); // active выставляется синхронно внутри doRun
        if (!active) return guard(p.then(([code, obj]) => send(res, code, obj))); // отказ (нет/выключен/плохое имя) — вернуть сразу
        p.catch(() => {});
        return send(res, 200, { ok: true, started: b.name, runId: active.runId, hint: 'ход: GET :3199/wait; итог: GET :3200/log' });
      }
      case '/skills': return guard(listSkills().then(r => send(res, 200, r)));
      case '/catalog': return guard(listSkills().then(r => {
        const one = q.get('name');
        let groups = V.group(r.skills);
        if (one) groups = groups.filter(g => g.base === V.baseOf(one));
        if (one && !groups.length) return send(res, 404, { ok: false, error: 'нет навыка ' + one });
        if (q.get('format') === 'json') return send(res, 200, { ok: true, skills: groups.map(g => ({ base: g.base, description: g.description, params: g.params, next: g.next,
          versions: g.versions.map(v => ({ name: v.name, note: v.note, enabled: v.enabled, runs: v.stats.runs, ok: v.stats.ok, fail: v.stats.fail })), broken: g.broken.map(v => v.name) })) });
        res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(V.catalogText(groups, { full: !!one }));
      }));
      case '/health': return guard(health().then(r => send(res, 200, r)));
      case '/log': {
        const since = parseInt(q.get('since') || '0', 10) || 0;
        const limit = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 500);
        return send(res, 200, { ok: true, entries: logBuf.filter(e => e.id > since).slice(-limit), lastId: logSeq });
      }
    }
    return send(res, 404, { ok: false, error: 'not found' });
  }
  if (req.method === 'POST') {
    const routes = {
      '/run': handleRun, '/check': handleCheck, '/rollback': handleRollback, '/abort': handleAbort,
      '/enable': b => handleToggle(b, true), '/disable': b => handleToggle(b, false)
    };
    const fn = routes[url.pathname];
    if (!fn) { req.resume(); return send(res, 404, { ok: false, error: 'not found' }); }
    // как в теле бота: только application/json — браузер не пошлёт такое со стороннего сайта без CORS-preflight
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) { req.resume(); return send(res, 415, { ok: false, error: 'нужен Content-Type: application/json' }); }
    let body = ''; let size = 0; let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; send(res, 413, { ok: false, error: 'тело больше 64КБ' }); req.resume(); }
      else body += c;
    });
    req.on('end', () => {
      if (tooBig) return;
      let b;
      try { b = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { ok: false, error: 'bad json' }); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { ok: false, error: 'ожидался JSON-объект' });
      guard(Promise.resolve(fn(b)).then(([code, obj]) => send(res, code, obj)));
    });
    return;
  }
  send(res, 404, { ok: false, error: 'not found' });
});
server.requestTimeout = 0; // /run может идти до 30 минут
server.headersTimeout = 60000;

process.on('unhandledRejection', e => console.log('[runner] unhandledRejection:', e && e.stack ? e.stack : e));
process.on('uncaughtException', e => console.log('[runner] uncaughtException:', e && e.stack ? e.stack : e));
const shutdown = () => { try { if (active && active.handle) active.handle.abort('shutdown'); } catch (e) {} saveStats(); setTimeout(() => process.exit(0), 200); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.on('error', e => { console.log('[runner] http error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
try { importVersions(); } catch (e) {}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[runner] http://127.0.0.1:${PORT}  тело: ${BODY_URL}  навыки: ${LEARNED}`);
  logAdd('start', { port: PORT, bodyUrl: BODY_URL });
});
