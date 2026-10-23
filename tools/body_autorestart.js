// Автоперезапуск тела (bot.js), чтобы включились правки ядра, которые инженер сделал после запуска тела.
// Зовёт сторож (brain_guard.ps1) раз в минуту отдельным процессом: ошибка здесь не роняет сторожа.
//   node tools/body_autorestart.js [--log data\night.log]
// Перезапуск — только если: есть сделанные правки тела (bot.js, lib/, behavior/) новее запуска тела, инженер сейчас ядро не правит,
// прошлый перезапуск был не раньше 30 мин назад и момент безопасный:
//   — в закрытом укрытии (крыша и 8 стен) и не идёт навык с ходьбой — днём и ночью, зомби рядом не важны;
//   — днём на открытом месте: HP >= 10, на земле, нет врагов и угроз рядом, не в бою, навыка с ходьбой нет.
// Тело не вошло в мир за 3 мин или упало 3 раза за 15 мин после перезапуска — откат последней правки тела
// (из резерва data/core_tasks/<id>/backup), запрос помечается «откат», тело запускается снова.
// Пишет: data/guard.log и журнал петли (--log), события body_restart — в data/events.log, своё — data/body_restart.json.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BODY_RE = /^(bot\.js$|lib\/|behavior\/|package\.json$)/;   // что включается только перезапуском тела
const CALM_TASKS = new Set(['wait_night', 'wait', 'sleep']);   // навыки без ходьбы — можно перезапускать
const GAP_MS = 30 * 60 * 1000;
const READY_MS = 3 * 60 * 1000;
const CRASH_WINDOW_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const BODY_CMD = `cd /d ${ROOT} && node bot.js localhost 25565 FlyBot_01 3199 >> data\\flybot.out.log 2>&1`;

const P = {
  state: path.join(DATA, 'body_restart.json'),
  lock: path.join(DATA, 'body_restart.lock'),
  core: path.join(DATA, 'core_requests_state.json'),
  tasks: path.join(DATA, 'core_tasks'),
  glog: path.join(DATA, 'guard.log'),
  events: path.join(DATA, 'events.log')
};

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (e) { return def; } };
const writeJson = (f, o) => { const t = f + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// --- чистые проверки (их гоняет test/body_autorestart.js) ---

// безопасно ли выйти из мира сейчас: { ok, why }
function safety(s, task) {
  if (!s || !s.ready) return { ok: false, why: 'тело не в мире' };
  const walking = task && !CALM_TASKS.has(task.name);
  if (walking) return { ok: false, why: `идёт навык ${task.name}` };
  if (s.sheltered && s.sheltered.closed) return { ok: true, why: 'в закрытом укрытии' };
  const enemies = (s.eyes && s.eyes.enemies || []).length, threats = (s.eyes && s.eyes.threats || []).length;
  if (s.timeOfDay !== 'day') return { ok: false, why: 'ночь, а укрытие не закрыто' };
  if (!(s.health >= 10)) return { ok: false, why: `HP ${Math.round(s.health)} < 10 на открытом месте` };
  if (!s.onGround) return { ok: false, why: 'не на земле' };
  if (enemies || threats) return { ok: false, why: `рядом враги/угрозы: ${enemies + threats}` };
  if (s.autopilot && /бой|побег|убега|отбив|escape|fight/i.test(String(s.autopilot.doing || ''))) return { ok: false, why: `автопилот: ${s.autopilot.doing}` };
  return { ok: true, why: 'день, спокойно' };
}

// сделанные правки тела новее запуска тела: [{ id, title, finishedAt, changed }] — от старых к новым
function pendingEdits(core, bodyStartMs) {
  const reqs = core && core.requests || {};
  return Object.keys(reqs).map(id => ({ id, ...reqs[id] }))
    .filter(r => r.status === 'done' && r.finishedAt > bodyStartMs && (r.changed || []).some(f => BODY_RE.test(f)))
    .sort((a, b) => a.finishedAt - b.finishedAt)
    .map(r => ({ id: r.id, title: r.title, finishedAt: r.finishedAt, changed: r.changed }));
}

const coreBusy = core => Object.values(core && core.requests || {}).some(r => r.status === 'working');

// откат одной правки из её резерва: изменённые файлы — из backup, добавленные — удалить
function revertEdit(root, tasksDir, id, changed) {
  const dir = path.join(tasksDir, id);
  const before = readJson(path.join(dir, 'before.json'), null);
  if (!before || !before.files) return { ok: false, error: 'нет снимка «до»' };
  const done = [];
  for (const rel of changed || []) {
    const dst = path.join(root, rel), src = path.join(dir, 'backup', rel);
    if (before.files[rel] && fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); done.push(rel); }
    else if (!before.files[rel]) { try { fs.unlinkSync(dst); done.push(rel); } catch (e) {} }
  }
  return { ok: true, files: done };
}

function markReverted(coreFile, id, note) {
  const st = readJson(coreFile, null);
  if (!st || !st.requests || !st.requests[id]) return;
  st.requests[id] = { ...st.requests[id], status: 'reverted', finishedAt: Date.now(), note: note.slice(0, 3000) };
  writeJson(coreFile, st);
}

// --- живое: тело, процессы, журналы ---

function getJson(url, ms = 5000) {
  return new Promise(res => {
    const rq = http.get(url, { timeout: ms }, r => { let s = ''; r.setEncoding('utf8'); r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s.replace(/^﻿/, ''))); } catch (e) { res(null); } }); });
    rq.on('timeout', () => rq.destroy()); rq.on('error', () => res(null));
  });
}

function bodyPids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -match 'bot\\.js localhost' } | Sort-Object CreationDate | % { $_.ProcessId }"],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch (e) { return null; }
}

function startBody() {
  const c = spawn('cmd.exe', ['/c', `start "flybot-body" /min cmd /c "${BODY_CMD}"`], { cwd: ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true });
  c.unref();
}

function killPids(pids) { for (const p of pids || []) { try { process.kill(p); } catch (e) {} } }

let loopLog = null;
function log(t) {
  try { fs.appendFileSync(P.glog, `[${stamp()}] тело: ${t}\n`); } catch (e) {}
  if (loopLog) try { fs.appendFileSync(loopLog, `\r\n[guard ${stamp().slice(11)}] тело: ${t}\r\n`); } catch (e) {}
}
function event(data) {
  const t = new Date().toISOString().slice(11, 19);   // как у тела: время UTC
  try { fs.appendFileSync(P.events, JSON.stringify({ id: 'guard', t, type: 'body_restart', ...data }) + '\n'); } catch (e) {}
}

// ждать, пока тело войдёт в мир; падение процесса — запустить снова (до 3 раз). → { ready, crashes, sec, server }
// server = false: тело живо и отвечает, но игровой сервер недоступен — правки тут ни при чём, откатывать нельзя
async function waitReady(t0) {
  let crashes = 0, last = null;
  while (Date.now() - t0 < READY_MS) {
    await sleep(5000);
    const h = await getJson('http://127.0.0.1:3199/health', 4000);
    if (h && h.ready) return { ready: true, crashes, sec: Math.round((Date.now() - t0) / 1000) };
    if (h) last = h;
    const pids = bodyPids();
    if (pids && !pids.length) {
      crashes++;
      log(`упало при запуске (${crashes}/3)`);
      if (crashes >= 3) break;
      startBody();
    }
  }
  return { ready: false, crashes, sec: Math.round((Date.now() - t0) / 1000), server: !(crashes < 3 && last && last.connected === false) };
}

// после успешного запуска два тела (петля night.cmd успела поднять своё) — оставить одно, старшее
function dedupe() {
  const pids = bodyPids();
  if (pids && pids.length > 1) { killPids(pids.slice(1)); log(`лишнее тело остановлено (pid ${pids.slice(1).join(', ')})`); }
}

// тело не встаёт с новыми правками: откатывать по одной, от новой к старой, пока не встанет
async function rollback(pending, why) {
  for (const r of [...pending].reverse()) {
    const rv = revertEdit(ROOT, P.tasks, r.id, r.changed);
    markReverted(P.core, r.id, `откат сторожем: ${why} — правка ${r.id} откачена (${(rv.files || []).join(', ') || rv.error})`);
    log(`ОТКАТ правки ${r.id} (${why}): ${(rv.files || []).join(', ') || rv.error}`);
    killPids(bodyPids()); await sleep(3000); startBody();
    const w = await waitReady(Date.now());
    event({ ok: w.ready, reverted: r.id, readySec: w.sec, why });
    if (!w.ready && !w.server) { log('после отката тело живо, но сервер недоступен — дальше не откатываю'); return false; }
    if (w.ready) { log(`тело встало после отката ${r.id} за ${w.sec} с`); dedupe(); return true; }
    why = 'не встало и после отката';
  }
  log('тело не встаёт и после всех откатов — нужен хозяин (смотри data\\flybot.out.log)');
  return false;
}

async function main() {
  const i = process.argv.indexOf('--log'); if (i > 0) loopLog = process.argv[i + 1];
  const st = readJson(P.state, {});
  const now = Date.now();

  // 1) только что перезапускали: следим, не падает ли (3 падения за 15 мин — откат)
  if (st.watch && now - st.watch.at < CRASH_WINDOW_MS) {
    const h = await getJson('http://127.0.0.1:3199/health', 4000);
    const pids = bodyPids();
    if (!h && pids && !pids.length) {
      st.watch.crashes = (st.watch.crashes || 0) + 1;
      log(`упало после перезапуска (${st.watch.crashes}/3 за 15 мин)`);
      writeJson(P.state, st);
      if (st.watch.crashes >= 3) { fs.writeFileSync(P.lock, String(now)); try { await rollback(st.watch.pending, 'упало 3 раза за 15 мин'); } finally { delete st.watch; writeJson(P.state, st); try { fs.unlinkSync(P.lock); } catch (e) {} } }
      else startBody();
    }
    return;
  }
  if (st.watch) { delete st.watch; writeJson(P.state, st); }

  if (st.lastAt && now - st.lastAt < GAP_MS) return;
  try { if (now - fs.statSync(P.lock).mtimeMs < LOCK_STALE_MS) return; } catch (e) {}

  const s = await getJson('http://127.0.0.1:3199/snapshot', 8000);
  if (!s || !s.ready || !s.stats) return;
  const core = readJson(P.core, {});
  const pending = pendingEdits(core, now - s.stats.uptime * 1000);
  const report = why => { const o = { at: now, pending: pending.map(p => p.id), why }; if (JSON.stringify({ ...st.check, at: 0 }) !== JSON.stringify({ ...o, at: 0 })) { st.check = o; writeJson(P.state, st); } };
  if (!pending.length) return report('правок тела, ждущих перезапуска, нет');
  if (coreBusy(core)) return report('инженер правит ядро — жду');
  const h = await getJson('http://127.0.0.1:3199/health', 4000);
  const safe = safety(s, h && h.task);
  if (!safe.ok) return report(`жду безопасного момента: ${safe.why}`);

  // 2) перезапуск
  fs.writeFileSync(P.lock, String(now));   // пока лежит — сторож не даёт инженеру новую правку ядра
  try {
    const ids = pending.map(p => p.id).join(', ');
    log(`перезапуск, чтобы включить правки ${ids} (${safe.why}, HP ${Math.round(s.health)})`);
    st.lastAt = now; writeJson(P.state, st);
    killPids(bodyPids()); await sleep(3000); startBody();
    const w = await waitReady(Date.now());
    if (w.ready) {
      log(`тело в мире через ${w.sec} с, правки включены: ${ids}`);
      event({ ok: true, ids: pending.map(p => p.id), readySec: w.sec, why: safe.why });
      dedupe();
      st.watch = { at: Date.now(), crashes: 0, pending };
      st.check = { at: Date.now(), pending: [], why: 'перезапущено: ' + ids };
      writeJson(P.state, st);
    } else if (!w.server) {
      log(`тело живо, но игровой сервер недоступен (${w.sec} с) — правки не откатываю, тело войдёт само, когда сервер вернётся`);
      event({ ok: false, ids: pending.map(p => p.id), readySec: w.sec, why: 'сервер недоступен' });
      st.watch = { at: Date.now(), crashes: 0, pending }; writeJson(P.state, st);
    } else {
      const why = w.crashes >= 3 ? 'упало 3 раза при запуске' : 'не вошло в мир за 3 мин';
      event({ ok: false, ids: pending.map(p => p.id), readySec: w.sec, why });
      await rollback(pending, why);
    }
  } finally { try { fs.unlinkSync(P.lock); } catch (e) {} }
}

module.exports = { safety, pendingEdits, coreBusy, revertEdit, BODY_RE };

if (require.main === module) main().catch(e => log('ошибка: ' + (e && e.message || e)));
