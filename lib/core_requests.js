// Запросы на правку ядра (brain/core_requests.md) и путь к ним инженера.
// Пишут запросы мозг и учитель (раздел «## [дата] <что>» в brain/core_requests.md). Хозяин в аудите жмёт «Разрешить» —
// только разрешённый запрос берёт инженер. Сторож (brain_guard.ps1) зовёт:
//   node lib/core_requests.js take          — взять разрешённый: снимок файлов ядра + прогон тестов «до», задание data/core_tasks/<id>.md
//   node lib/core_requests.js finish <id>   — после инженера: что изменено, тесты «после»; стало хуже — откат его правки и запись почему
//   node lib/core_requests.js release       — сторож перезапущен: «в работе» без правки — снова «разрешён», с правкой — проверка тестами
// Тесты — каждый файл test/*.js отдельно (tools/run_tests.js). Правка проходит, если не упал ни один тест, который проходил до неё
// (часть тестов может падать и до правки — это видно в записи, правку за чужое не откатываем).
// Состояние — data/core_requests_state.json (сам файл запросов не меняется: его пишут мозг и учитель).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
// что считается ядром для снимка и отката (всё, что может поправить инженер по разрешённому запросу)
const CORE_DIRS = ['lib', 'behavior', 'test', 'tools', 'audit', 'mcp'];
const CORE_EXT = /\.(js|json|md|cmd|ps1|html)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.history', '.trash', '.tmp']);
const MAX_FILE = 4 * 1024 * 1024;

function paths(cfg = {}) {
  const root = cfg.root || ROOT;
  const dataDir = cfg.dataDir || path.join(root, 'data');
  const brainDir = cfg.brainDir || path.join(root, 'brain');
  return {
    root, dataDir, brainDir,
    file: path.join(brainDir, 'core_requests.md'),
    state: path.join(dataDir, 'core_requests_state.json'),
    tasks: path.join(dataDir, 'core_tasks')
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function loadState(P) { try { const o = JSON.parse(fs.readFileSync(P.state, 'utf8')); if (o && o.requests && typeof o.requests === 'object') return o; } catch (e) {} return { version: 1, requests: {} }; }

const idOf = heading => crypto.createHash('sha1').update(String(heading).trim()).digest('hex').slice(0, 10);

// brain/core_requests.md → [{ id, title, text }]: каждый раздел «## …» — один запрос (с его «ПОВТОР»-ами внутри)
function parse(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^##\s+/.test(line)) { cur = { id: idOf(line), title: line.replace(/^##\s+/, '').trim(), lines: [line] }; out.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  return out.map(r => ({ id: r.id, title: r.title, text: r.lines.join('\n').trim() }));
}

const STATUS_RU = { new: 'ждёт разрешения', approved: 'разрешён, ждёт инженера', working: 'инженер правит', done: 'сделано, тесты прошли', reverted: 'откат: тесты стали хуже', failed: 'не сделано' };

// Список запросов с состоянием (для аудита)
function list(cfg = {}) {
  const P = paths(cfg);
  let text = null; try { text = fs.readFileSync(P.file, 'utf8'); } catch (e) {}
  const st = loadState(P);
  const items = parse(text).map(r => {
    const s = st.requests[r.id] || {};
    const status = s.status || 'new';
    return { id: r.id, title: r.title, text: r.text.slice(0, 20000), status, statusRu: STATUS_RU[status] || status,
      approvedAt: s.approvedAt || null, startedAt: s.startedAt || null, finishedAt: s.finishedAt || null, note: s.note || null, changed: s.changed || [] };
  });
  return { exists: text != null, items };
}

// Хозяин разрешил (кнопка в аудите). Можно разрешить снова после «сделано»/«откат»/«не сделано».
function approve(cfg = {}, id) {
  const P = paths(cfg), now = cfg.now ? cfg.now() : Date.now();
  let text = null; try { text = fs.readFileSync(P.file, 'utf8'); } catch (e) {}
  const r = parse(text).find(x => x.id === id);
  if (!r) return { ok: false, error: 'нет такого запроса (файл brain/core_requests.md изменился?)' };
  const st = loadState(P);
  const s = st.requests[id] || {};
  if (s.status === 'working') return { ok: false, error: 'инженер уже правит этот запрос' };
  st.requests[id] = { ...s, title: r.title, status: 'approved', approvedAt: now };
  writeJson(P.state, st);
  return { ok: true, id, status: 'approved' };
}

// ---------- снимок файлов ядра ----------
function walk(root) {
  const out = [];
  const add = rel => {
    const abs = path.join(root, rel);
    let s; try { s = fs.statSync(abs); } catch (e) { return; }
    if (s.isFile() && s.size <= MAX_FILE && CORE_EXT.test(rel)) out.push(rel.replace(/\\/g, '/'));
  };
  const dir = rel => {
    let names = []; try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return; }
    for (const d of names) {
      const r = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) dir(r); } else add(r);
    }
  };
  // корень (bot.js, package.json, SKILLS.md, *.cmd, *.ps1 …) — только файлы
  try { for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isFile()) add(d.name); } catch (e) {}
  for (const d of CORE_DIRS) dir(d);
  // brain/*.js — исполнитель навыков и его части (не выученные навыки и не файлы мозга)
  try { for (const d of fs.readdirSync(path.join(root, 'brain'), { withFileTypes: true })) if (d.isFile() && /\.js$/.test(d.name)) add(path.join('brain', d.name)); } catch (e) {}
  return out.sort();
}
const hashFile = f => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; } };

function snapshot(root, backupDir) {
  const files = {};
  for (const rel of walk(root)) {
    const h = hashFile(path.join(root, rel)); if (!h) continue;
    files[rel] = h;
    const dst = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, rel), dst);
  }
  return files;
}
function diff(root, before) {
  const now = {}; for (const rel of walk(root)) { const h = hashFile(path.join(root, rel)); if (h) now[rel] = h; }
  const changed = [], added = [], removed = [];
  for (const rel of Object.keys(before)) { if (!(rel in now)) removed.push(rel); else if (now[rel] !== before[rel]) changed.push(rel); }
  for (const rel of Object.keys(now)) if (!(rel in before)) added.push(rel);
  return { changed, added, removed };
}

// ---------- тесты ----------
function runTests(cfg, root) {
  if (cfg.runTests) return cfg.runTests(root);
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'run_tests.js'), '--json'], { cwd: root, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (e) { return { ok: false, results: [], error: 'tools/run_tests.js не ответил: ' + String(r.error || r.stderr || '').slice(0, 300) }; }
}
const failedSet = t => new Set((t && t.results || []).filter(x => !x.ok).map(x => x.file));

// ---------- команды сторожа ----------
function take(cfg = {}) {
  const P = paths(cfg), now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P);
  if (Object.values(st.requests).some(s => s.status === 'working')) return { busy: true };
  let text = null; try { text = fs.readFileSync(P.file, 'utf8'); } catch (e) {}
  const reqs = parse(text);
  const next = reqs.filter(r => (st.requests[r.id] || {}).status === 'approved').sort((a, b) => st.requests[a.id].approvedAt - st.requests[b.id].approvedAt)[0];
  if (!next) return { none: true };
  const dir = path.join(P.tasks, next.id);
  fs.rmSync(dir, { recursive: true, force: true });
  const files = snapshot(P.root, path.join(dir, 'backup'));
  const before = runTests(cfg, P.root);
  writeJson(path.join(dir, 'before.json'), { at: new Date(now).toISOString(), files, tests: before });
  const taskFile = path.join(P.tasks, next.id + '.md');
  const doneFile = path.join(P.tasks, next.id + '.done.md');
  try { fs.unlinkSync(doneFile); } catch (e) {}
  const failedBefore = [...failedSet(before)];
  fs.writeFileSync(taskFile,
    `# Правка ядра ${next.id} (хозяин разрешил)\n\n` +
    `Тесты до правки: ${(before.results || []).length - failedBefore.length} прошли` + (failedBefore.length ? `, падали уже до тебя: ${failedBefore.join(', ')}` : ', все') + '.\n' +
    `Ответ запиши в data/core_tasks/${next.id}.done.md.\n\n` + next.text + '\n');
  st.requests[next.id] = { ...(st.requests[next.id] || {}), title: next.title, status: 'working', startedAt: now };
  writeJson(P.state, st);
  return { id: next.id, title: next.title, taskFile: 'data/core_tasks/' + next.id + '.md', doneFile: 'data/core_tasks/' + next.id + '.done.md' };
}

function restore(root, backupDir, d) {
  for (const rel of [...d.changed, ...d.removed]) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(backupDir, rel), dst);
  }
  for (const rel of d.added) { try { fs.unlinkSync(path.join(root, rel)); } catch (e) {} }
}

function finish(cfg = {}, id, how = 'ok') {
  const P = paths(cfg), now = cfg.now ? cfg.now() : Date.now();
  const st = loadState(P);
  const s = st.requests[id];
  if (!s) return { ok: false, error: 'нет запроса ' + id };
  const dir = path.join(P.tasks, id);
  let before = null; try { before = JSON.parse(fs.readFileSync(path.join(dir, 'before.json'), 'utf8')); } catch (e) {}
  if (!before) { st.requests[id] = { ...s, status: how === 'limit' || how === 'crash' ? 'approved' : 'failed', finishedAt: now, note: 'нет снимка «до» — проверить и откатить нечем' }; writeJson(P.state, st); return { ok: true, id, status: 'failed' }; }
  const d = diff(P.root, before.files);
  const touched = [...d.changed, ...d.added, ...d.removed];
  let answer = ''; try { answer = fs.readFileSync(path.join(P.tasks, id + '.done.md'), 'utf8'); } catch (e) {}
  const head = (answer.split(/\r?\n/).find(l => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 200);
  let status, note, after = null, worse = [];
  if (!touched.length && (how === 'limit' || how === 'crash')) {
    status = 'approved';   // модель упёрлась в лимит / сторож перезапущен — правки не было, запрос снова ждёт инженера
    note = how === 'limit' ? 'лимит запросов модели — повтор позже' : 'сторож перезапускался — повтор';
  } else if (!touched.length) {
    status = 'failed';
    note = (how === 'ok' ? 'инженер ничего не изменил в ядре' : `инженер не закончил (${how}), в ядре ничего не изменено`) + (head ? '; ответ: ' + head : '; ответа нет');
  } else {
    after = runTests(cfg, P.root);
    const was = failedSet(before.tests), now2 = failedSet(after);
    const names = new Set((before.tests && before.tests.results || []).map(x => x.file));
    worse = [...now2].filter(f => !was.has(f) || !names.has(f));
    if (!after.results || !after.results.length) worse = worse.length ? worse : ['тесты не запустились'];
    if (worse.length) {
      restore(P.root, path.join(dir, 'backup'), d);
      status = 'reverted';
      const tail = (after.results || []).filter(x => worse.includes(x.file)).map(x => `${x.file}: ${String(x.tail || '').slice(-400)}`).join('\n');
      note = `после правки упали тесты: ${worse.join(', ')} — правка инженера откачена (${touched.length} файл.)` + (tail ? '\n' + tail : after.error ? '\n' + after.error : '');
    } else {
      status = 'done';
      note = `изменено: ${touched.join(', ')}; тесты: новых падений нет` + (now2.size ? ` (падают и до правки: ${[...now2].join(', ')})` : ', все прошли') + (head ? '; ответ: ' + head : '');
    }
  }
  const result = [`# ${id}: ${STATUS_RU[status]}`, `Запрос: ${s.title}`, `Когда: ${new Date(now).toISOString()}`, `Итог: ${note}`,
    `Изменённые файлы: ${touched.join(', ') || '—'}`, after ? `Тесты после: ${(after.results || []).map(x => `${x.file} ${x.ok ? 'ok' : 'FAIL'}`).join(', ')}` : ''].filter(Boolean).join('\n') + '\n';
  fs.mkdirSync(P.tasks, { recursive: true });
  fs.writeFileSync(path.join(P.tasks, id + '.result.md'), result);
  st.requests[id] = { ...s, status, finishedAt: now, note: note.slice(0, 3000), changed: touched, how };
  writeJson(P.state, st);
  return { ok: true, id, status, changed: touched.length, worse };
}

function release(cfg = {}) {
  const P = paths(cfg), st = loadState(P);
  const w = Object.keys(st.requests).filter(k => st.requests[k].status === 'working');
  // сторож перезапущен посреди правки: правки нет — запрос снова ждёт инженера; есть — проверяем её тестами, как обычно
  const out = [];
  for (const id of w) out.push(finish(cfg, id, 'crash'));
  return { ok: true, released: w, results: out.map(r => r.status) };
}

module.exports = { paths, parse, idOf, list, approve, take, finish, release, walk, diff, STATUS_RU };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  let r;
  try {
    if (cmd === 'take') r = take();
    else if (cmd === 'finish') r = finish({}, a, b);
    else if (cmd === 'release') r = release();
    else if (cmd === 'list') r = list();
    else r = { ok: false, error: 'команды: take | finish <id> [ok|timeout|limit] | release | list' };
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  // только ASCII: PowerShell читает вывод в своей кодировке
  process.stdout.write(JSON.stringify(r).replace(/[\u0080-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
}
