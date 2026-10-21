// Витрина навыков (этап H): что умеет бот и как у него это получается. Формат общий для всех ботов — см. SHOWCASE.md.
// Только чтение файлов, без зависимостей от бота: годится и для тела (bot.js), и для «Аудита» (audit/server.js).
//   build(opts)  -> { bot, version, format, updated, skills:[...] }
//   readCode(name, opts) -> { ok, status, name, kind, file, size, code } | { ok:false, status, error }
//   create(opts) -> { get(), code(name) } с кэшем (витрину пересчитываем не чаще раза в минуту)
// Статистика — только то, что уже пишется: events.log (task_done/task_failed), brain/skills_stats.json и runner.log,
// data/variants.json. Чего нет — null, ничего не выдумываем.
'use strict';
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const TTL_MS = 60 * 1000;          // не пересчитывать чаще
const MAX_CODE = 200 * 1024;       // исходник крупнее не отдаём
const MAX_LOG = 40 * 1024 * 1024;  // журнал больше — читаем хвост (since тогда не знаем)
const ERRORS_KEEP = 3, ERR_LEN = 200;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_\/.-]{0,79}$/;
const KINDS = ['body', 'learned', 'behavior', 'variant'];

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const readJson = f => { const t = readText(f); if (t == null) return null; try { return JSON.parse(t.replace(/^﻿/, '')); } catch (e) { return null; } };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
const listJs = dir => { try { return fs.readdirSync(dir).filter(f => /^[A-Za-z0-9][A-Za-z0-9_.-]*\.js$/.test(f)).sort(); } catch (e) { return []; } };
const listDirs = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d.name)).map(d => d.name).sort(); } catch (e) { return []; } };

// Строки JSON-журнала (по объекту на строку). Нет файла -> null. Слишком большой — только хвост.
function readJsonl(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - MAX_LOG), len = size - start;
    const buf = Buffer.alloc(len); let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (n <= 0) break; got += n; }
    let text = buf.subarray(0, got).toString('utf8');
    if (start > 0) { const i = text.indexOf('\n'); text = i < 0 ? '' : text.slice(i + 1); }
    const out = [];
    for (const l of text.split('\n')) { if (l && l[0] === '{') { try { out.push(JSON.parse(l)); } catch (e) {} } }
    return { items: out, partial: start > 0 };
  } catch (e) { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) {} } }
}

// ---------- описание навыков из исходников (без выполнения кода) ----------

// Первая строка-описание из шапки файла: «// имя — что делает» или «/* … */»
function headComment(src) {
  if (!src) return null;
  const lines = src.replace(/^﻿/, '').split(/\r?\n/);
  const parts = [];
  for (const l of lines) {
    const m = /^\s*\/\/\s?(.*)$/.exec(l);
    if (m) { parts.push(m[1]); if (parts.join(' ').length > 240) break; continue; }
    if (/^\s*$/.test(l) && !parts.length) continue;
    if (/^\s*['"]use strict['"]/.test(l) && !parts.length) continue;
    break;
  }
  const t = clip(parts.join(' '), 240);
  return t || null;
}
function unq(q, body) { return body.replace(/\\(.)/g, (m, c) => c === 'n' ? ' ' : c === 't' ? ' ' : c); }
// Строковый литерал после «ключ:» (первый); null если не нашли
function strProp(src, key) {
  const m = new RegExp('\\b' + key + '\\s*:\\s*([\'"`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1').exec(src || '');
  return m ? clip(unq(m[1], m[2]), 300) : null;
}
// Ключи объекта params: { ключ: 'подсказка', ... } -> { ключ: подсказка | null }; нет — null
function paramsProp(src) {
  const m = /\bparams\s*:\s*\{/.exec(src || '');
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, j = i, q = null;
  for (; j < src.length && depth > 0; j++) {
    const c = src[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c; else if (c === '{') depth++; else if (c === '}') depth--;
  }
  if (depth) return null;
  const body = src.slice(i, j - 1), out = {};
  const re = /(?:^|[,{\n])\s*([A-Za-z_]\w*|'[^']+'|"[^"]+")\s*:\s*(?:(['"`])((?:\\.|(?!\2)[^\\\n])*)\2)?/g;
  let r;
  while ((r = re.exec(body))) {
    const k = r[1].replace(/^['"]|['"]$/g, '');
    if (!(k in out)) out[k] = r[3] != null ? clip(unq(r[2], r[3]), 160) : null;
  }
  return Object.keys(out).length ? out : null;
}

// SKILLS.md: таблицы «| `имя` | params | что делает |» -> Map имя -> { params, about }
function parseSkillsMd(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line[0] !== '|') continue;
    const cells = line.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
    const m = cells[1] && /^`([a-z][a-z0-9_]*)`$/.exec(cells[1]);
    if (!m || cells.length < 4 || map.has(m[1])) continue;
    const about = clip(cells.slice(3, cells.length - 1).join(' | '), 300);
    const params = cells[2] && cells[2] !== '—' ? clip(cells[2], 200) : null;
    map.set(m[1], { params, about: about || null });
  }
  return map;
}

// lib/commands.js: таблица SKILLS -> [{name, file}]; файл — lib/skills/<модуль>.js, либо lib/commands.js (навык прямо в нём)
function parseCommandsSkills(text) {
  const mods = {};
  let r;
  const reMod = /const\s+(\w+)\s*=\s*require\('\.\/skills\/(\w+)'\)/g;
  while ((r = reMod.exec(text))) mods[r[1]] = r[2];
  const reDes = /const\s*\{\s*([^}]+)\}\s*=\s*require\('\.\/skills\/(\w+)'\)/g;
  while ((r = reDes.exec(text))) for (const v of r[1].split(',')) { const n = v.trim().split(/\s*:\s*/).pop(); if (n) mods[n] = r[2]; }
  const start = /const\s+SKILLS\s*=\s*\{/.exec(text);
  if (!start) return [];
  const out = [];
  for (const line of text.slice(start.index + start[0].length).split(/\r?\n/)) {
    if (/^\};?\s*$/.test(line)) break;
    const m = /^ {2}([A-Za-z_]\w*)\s*(?::\s*(.*?))?,?\s*(?:\/\/.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1], val = (m[2] || '').trim();
    let mod = null;
    const mm = /^(\w+)\.\w+$/.exec(val.replace(/,$/, ''));
    if (mm && mods[mm[1]]) mod = mods[mm[1]];
    else if (!val && mods[name]) mod = mods[name];
    out.push({ name, file: mod ? 'lib/skills/' + mod + '.js' : 'lib/commands.js' });
  }
  return out;
}

// ---------- перечень навыков: имя -> файл ----------
// Каждый элемент: { name, kind, family?, file (относительный), about, params }
function index(root) {
  const items = [];
  const rel = (...p) => p.join('/');
  // навыки тела
  const cmd = readText(path.join(root, 'lib', 'commands.js'));
  const md = parseSkillsMd(readText(path.join(root, 'SKILLS.md')));
  for (const s of parseCommandsSkills(cmd || '')) {
    const d = md.get(s.name) || {};
    items.push({ name: s.name, kind: 'body', file: s.file, about: d.about || null, params: d.params || null });
  }
  // выученные навыки (brain/learned/*.js, только чтение)
  for (const f of listJs(path.join(root, 'brain', 'learned'))) {
    if (f.startsWith('_')) continue;
    const src = readText(path.join(root, 'brain', 'learned', f)) || '';
    items.push({ name: f.replace(/\.js$/, ''), kind: 'learned', file: rel('brain', 'learned', f), about: strProp(src, 'description') || headComment(src), params: paramsProp(src) });
  }
  // варианты боя и прочие семейства: lib/variants/<семейство>/<имя>.js
  for (const fam of listDirs(path.join(root, 'lib', 'variants'))) {
    for (const f of listJs(path.join(root, 'lib', 'variants', fam))) {
      if (f.startsWith('_')) continue;
      const src = readText(path.join(root, 'lib', 'variants', fam, f)) || '';
      items.push({ name: fam + '/' + f.replace(/\.js$/, ''), kind: 'variant', family: fam, file: rel('lib', 'variants', fam, f), about: strProp(src, 'desc') || headComment(src), params: null });
    }
  }
  // поведение: behavior/*.js (кроме самопроверки)
  for (const f of listJs(path.join(root, 'behavior'))) {
    if (f === 'test.js') continue;
    const src = readText(path.join(root, 'behavior', f)) || '';
    items.push({ name: 'behavior/' + f.replace(/\.js$/, ''), kind: 'behavior', file: rel('behavior', f), about: headComment(src), params: null });
  }
  return items;
}

// ---------- статистика ----------
const noStats = () => ({ runs: null, ok: null, fail: null, lastErrors: null, since: null });

// events.log: task_done / task_failed по имени навыка тела. Даты в журнале нет (только ЧЧ:ММ:СС) — since не знаем.
function bodyStats(events) {
  if (!events) return null;
  const m = new Map();
  for (const e of events.items) {
    if (!e || !e.name || (e.type !== 'task_done' && e.type !== 'task_failed')) continue;
    const s = m.get(e.name) || { ok: 0, fail: 0, errors: [] };
    if (e.type === 'task_done') s.ok++; else { s.fail++; if (e.reason) s.errors.push(clip(e.reason, ERR_LEN)); }
    m.set(e.name, s);
  }
  return m;
}
// brain/skills_stats.json + runner.log (run_end): выученные навыки
function learnedStats(stats, runner) {
  const errs = new Map(), since = new Map();
  if (runner) for (const e of runner.items) {
    if (!e || !e.name || !e.time) continue;
    if ((e.type === 'run_start' || e.type === 'run_end') && !since.has(e.name)) since.set(e.name, e.time);
    if (e.type === 'run_end' && e.ok === false && e.error) { const a = errs.get(e.name) || []; a.push(clip(e.error, ERR_LEN)); errs.set(e.name, a); }
  }
  return { stats: stats && typeof stats === 'object' ? stats : null, errs, since, haveLog: !!runner };
}
// last N разных ошибок, самые свежие последними
function lastDistinct(arr, n) {
  const out = [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) if (!out.includes(arr[i])) out.unshift(arr[i]);
  return out;
}

// data/variants.json: stats[семейство][ключ][вариант] = { n, ok, sum }; уровень «*» — всё вместе
function variantStat(vj, family, variant) {
  if (!vj || !vj.stats) return null;
  const a = vj.stats[family] && vj.stats[family]['*'] && vj.stats[family]['*'][variant];
  if (!a) return { runs: 0, ok: 0, fail: 0, lastErrors: null, since: null, avg: null };
  const n = a.n || 0;
  return { runs: n, ok: a.ok || 0, fail: Math.max(0, n - (a.ok || 0)), lastErrors: null, since: null, avg: n ? Math.round((a.sum || 0) / n * 100) / 100 : null };
}

// ---------- сборка ----------
// opts: root (корень проекта), dataDir, bot (строка или функция), version, now (мс; для тестов)
function build(opts = {}) {
  const root = opts.root || path.join(__dirname, '..');
  const dataDir = opts.dataDir || path.join(root, 'data');
  const brainDir = opts.brainDir || path.join(root, 'brain');
  const now = opts.now != null ? opts.now : Date.now();
  const events = readJsonl(path.join(dataDir, 'events.log'));
  const runner = readJsonl(path.join(brainDir, 'runner.log'));
  const bs = bodyStats(events);
  const ls = learnedStats(readJson(path.join(brainDir, 'skills_stats.json')), runner);
  const vj = readJson(path.join(dataDir, 'variants.json'));

  const skills = index(root).map(it => {
    const o = { name: it.name, kind: it.kind };
    if (it.family) o.family = it.family;
    o.about = it.about;
    if (it.params) o.params = it.params;
    let st = noStats();
    if (it.kind === 'body' && bs) {
      const s = bs.get(it.name);
      st = s ? { runs: s.ok + s.fail, ok: s.ok, fail: s.fail, lastErrors: lastDistinct(s.errors, ERRORS_KEEP), since: null } : { runs: 0, ok: 0, fail: 0, lastErrors: [], since: null };
    } else if (it.kind === 'learned' && ls.stats) {
      const s = ls.stats[it.name];
      if (s) {
        let errors = lastDistinct(ls.errs.get(it.name) || [], ERRORS_KEEP);
        if (!errors.length && s.lastError) errors = [clip(s.lastError, ERR_LEN)];
        st = { runs: s.runs, ok: s.ok, fail: s.fail, lastErrors: errors, since: ls.since.get(it.name) || null };
        if (s.enabled === false) o.enabled = false;
      } else st = { runs: 0, ok: 0, fail: 0, lastErrors: [], since: null };
    } else if (it.kind === 'variant') {
      st = variantStat(vj, it.family, it.name.split('/')[1]) || noStats();
    }
    o.stats = st;
    return o;
  });
  const bot = typeof opts.bot === 'function' ? opts.bot() : opts.bot;
  return { bot: bot || null, version: opts.version || null, format: FORMAT, updated: new Date(now).toISOString(), skills };
}

// ---------- исходники ----------
// Имя берём только из перечня (index): путь собирается не из присланного текста, ../ и чужие файлы невозможны.
// Дополнительно: файл должен лежать внутри разрешённой папки (после realpath) и быть не крупнее MAX_CODE.
const ALLOWED_DIRS = ['lib/skills', 'lib/variants', 'lib/commands.js', 'brain/learned', 'behavior'];
function inside(root, file) {
  try {
    const real = fs.realpathSync(file), r = fs.realpathSync(root);
    const relp = path.relative(r, real).split(path.sep).join('/');
    if (!relp || relp.startsWith('..') || path.isAbsolute(relp)) return false;
    return ALLOWED_DIRS.some(d => relp === d || relp.startsWith(d + '/'));
  } catch (e) { return false; }
}
function readCode(name, opts = {}) {
  const root = opts.root || path.join(__dirname, '..');
  if (typeof name !== 'string' || !name) return { ok: false, status: 400, error: 'нужен name: /showcase/code?name=<имя навыка из /showcase>' };
  if (!NAME_RE.test(name) || name.includes('..')) return { ok: false, status: 400, error: 'плохое имя навыка' };
  const it = index(root).find(x => x.name === name && (!opts.kind || x.kind === opts.kind));
  if (!it) return { ok: false, status: 404, error: 'нет такого навыка в витрине: ' + name };
  const file = path.join(root, ...it.file.split('/'));
  if (!inside(root, file)) return { ok: false, status: 403, error: 'файл вне разрешённых папок' };
  let st; try { st = fs.statSync(file); } catch (e) { return { ok: false, status: 404, error: 'файла нет' }; }
  if (!st.isFile()) return { ok: false, status: 404, error: 'это не файл' };
  if (st.size > MAX_CODE) return { ok: false, status: 413, error: 'файл больше ' + Math.round(MAX_CODE / 1024) + ' КБ' };
  return { ok: true, status: 200, name, kind: it.kind, ...(it.family ? { family: it.family } : {}), file: it.file, size: st.size, code: fs.readFileSync(file, 'utf8') };
}

// Кэш: витрина пересчитывается не чаще раза в ttlMs
function create(opts = {}) {
  const ttl = opts.ttlMs != null ? opts.ttlMs : TTL_MS;
  let cache = null, at = 0;
  return {
    get() {
      const t = Date.now();
      if (!cache || t - at >= ttl) { cache = build({ ...opts, now: t }); at = t; }
      return cache;
    },
    code(name, kind) { return readCode(name, { ...opts, kind }); }
  };
}

// Витрина соседа или нашей — кратко, для таблицы аудита и проверок: ok/fail в процентах
const rate = s => (s && s.runs ? Math.round(s.ok / s.runs * 100) : null);

module.exports = { FORMAT, TTL_MS, MAX_CODE, KINDS, build, index, readCode, create, parseSkillsMd, parseCommandsSkills, strProp, paramsProp, headComment, bodyStats, learnedStats, variantStat, lastDistinct, readJsonl, rate };
