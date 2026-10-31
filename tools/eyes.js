// «Глаза» мухи: кадры с окна настоящего Minecraft (наблюдатель в режиме зрителя прицеплен к мухе) -> Gemini Live;
// раз в N секунд и при важном событии спрашиваем «что было с прошлого вопроса» и пишем ответ в data/eyes.log (его читает учитель).
// Тонкая обёртка: процессы (ffmpeg, powershell), HTTP к телу, настоящая WebSocket. Вся логика — lib/eyes.js (test/eyes.js).
// Запуск: eyes.cmd (цикл). Проверка связи:  node tools/eyes.js --probe
// Клиент-наблюдатель (FlyEyes) запускаем сами (autoClient): когда муха в мире — старт, когда её нет дольше 2 минут — стоп.
// Сухая проверка команды клиента (ничего не запускает):  node tools/eyes.js --client-cmd
// Датапак, который держит наблюдателя на мухе, ставится один раз:  node tools/eyes_install.js
// К телу — только GET с x-observer: 1 и НИКОГДА /wait (он двигает курсор событий мозга).
// Пульт (data/switches.json, вкладка «Пульт» в аудите): глаза выключены — закрываем Live, захват и клиент-наблюдатель и ждём
// включения (статус state: 'off' пишется дальше, чтобы аудит видел: процесс жив). Включили — поднимаемся сами.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execFileSync } = require('child_process');
const E = require('../lib/eyes');
const C = require('../lib/eyes_client');
const { QUIET } = require('../lib/events');
const switches = require('../lib/switches');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const F = {
  cfg: path.join(DATA, 'eyes.json'), log: path.join(DATA, 'eyes.log'), status: path.join(DATA, 'eyes_status.json'),
  prompt: path.join(ROOT, 'brain', 'EYES_PROMPT.md'),
  clientDir: path.join(DATA, 'eyes_client'), clientLog: path.join(DATA, 'eyes_client.log'), clientPid: path.join(DATA, 'eyes_client.pid'),
  archive: path.join(DATA, 'eyes_archive')   // все наблюдения по дням, без удаления (lib/eyes.js archiveLine)
};
const BODY = process.env.FLYBOT_URL || 'http://127.0.0.1:3199';
const FFMPEG_FALLBACK = 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
const ANSWER_TIMEOUT_MS = 30000;
const RETRY_WINDOW_MS = 30000;
const FIND_CLIENT_MS = 2000;          // окно своего клиента ищем часто: оно появляется через секунды после запуска
const LOADING_WAIT_MS = 90000;        // столько ждём «Multiplayer» в заголовке; дольше — снимаем что есть
const NO_FRAMES_MS = 60000;           // захват жив, а кадров нет столько — перезапускаем ffmpeg
const HEALTH_EVERY_MS = 5000;
const SWITCH_EVERY_MS = 3000;         // как часто смотрим на пульт

const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = E.readKey();
const safe = s => E.redact(s, key);

function getPrompt() { try { return fs.readFileSync(F.prompt, 'utf8'); } catch (e) { return 'Ты — глаза Minecraft-бота. Отвечай коротко по-русски.'; } }

// ---------- ffmpeg и окно ----------
function ffmpegBin() {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }, err => resolve(err && fs.existsSync(FFMPEG_FALLBACK) ? FFMPEG_FALLBACK : 'ffmpeg'));
  });
}
// powershell без профиля; скрипт кодируем (без проблем с кавычками). Возвращает stdout или null.
function psRun(script, timeout = 15000) {
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', C.encodePs(script)], { timeout, windowsHide: true, encoding: 'utf8' }, (err, out) => resolve(err ? null : String(out || '')));
  });
}
// Окно для захвата -> { hwnd, title } | null. Явный заголовок из конфига; иначе любое окно «Minecraft» (старый режим, autoClient: false).
async function findWindow(cfg) {
  const q = cfg.window ? String(cfg.window).replace(/'/g, "''") : '';
  if (cfg.window && cfg.capture === 'gdi') return { hwnd: '0', title: cfg.window };
  const cond = q ? `$_.MainWindowTitle.Contains('${q}')` : "$_.MainWindowTitle -match 'Minecraft' -and $_.MainWindowTitle -notmatch 'Launcher'";
  const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | ? { $_.MainWindowHandle -ne 0 -and " + cond + " } | select -First 1 | % { '{0}|{1}' -f $_.MainWindowHandle.ToInt64(), $_.MainWindowTitle }";
  return C.parseWindow(await psRun(ps));
}
// Окно нашего клиента по pid процесса
async function findClientWindow(pid) { return C.parseWindow(await psRun(C.windowScript(pid))); }
function foregroundHwnd() {                                      // синхронно: нужно ДО запуска окна клиента
  try { const o = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', C.encodePs(C.foregroundScript())], { timeout: 8000, windowsHide: true, encoding: 'utf8' }); return /^\d+$/.test(o.trim()) ? o.trim() : null; } catch (e) { return null; }
}
function startCapture(bin, target, cfg, onFrame, onExit) {
  let args;
  try { args = C.captureArgs(cfg, target); } catch (e) { setImmediate(() => onExit('захват не собрать: ' + e.message)); return { kill() {} }; }
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const split = new E.JpegSplitter();
  let err = '';
  p.stdout.on('data', ch => { for (const f of split.push(ch)) onFrame(f); });
  p.stderr.on('data', ch => { err = (err + ch).slice(-400); });
  p.on('error', e => onExit('не запустился ffmpeg: ' + e.message));
  p.on('exit', (code, sig) => onExit(`ffmpeg вышел (${code != null ? code : sig})${err ? ': ' + err.replace(/\s+/g, ' ').trim() : ''}`));
  return p;
}
// синтетический кадр (когда окна нет): один JPEG от ffmpeg lavfi
function syntheticFrame(bin, color) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; p.stdout.on('data', c => chunks.push(c));
    p.on('error', reject);
    p.on('exit', () => { const b = Buffer.concat(chunks); b.length > 100 ? resolve(b) : reject(new Error('ffmpeg не дал кадр')); });
  });
}

// ---------- тело (только чтение) ----------
async function getJson(p) {
  const r = await fetch(BODY + p, { headers: { 'x-observer': '1' }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---------- клиент-наблюдатель ----------
function metaDir(cfg) { return cfg.metaDir || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ModrinthApp', 'meta'); }
// Сборка команды из того, что Modrinth уже положил на диск. Ничего не пишет и не запускает.
function buildClient(cfg) {
  const md = metaDir(cfg);
  const id = C.pickVersion(md, cfg.clientVersion);
  if (!id) throw new Error(`нет версии ${cfg.clientVersion} в ${path.join(md, 'versions')}`);
  return C.buildLaunch({ metaDir: md, versionId: id, gameDir: F.clientDir, memoryMb: cfg.clientMemoryMb, host: cfg.lanHost, port: cfg.lanPort, width: C.WIDTH, height: C.HEIGHT, javaPath: cfg.java || null });
}
// --client-cmd: печатает команду и честно говорит, чего не хватает. Выход 0 — всё на месте.
function clientCmd() {
  const cfg = E.readConfig(F.cfg);
  say('конфиг: autoClient =', cfg.autoClient, '; capture =', cfg.capture, '; версия =', cfg.clientVersion, '; сервер =', `${cfg.lanHost}:${cfg.lanPort}`, '; память =', cfg.clientMemoryMb + ' МБ');
  say('мета Modrinth:', metaDir(cfg));
  let l;
  try { l = buildClient(cfg); } catch (e) { say('НЕ СОБРАТЬ:', e.message); process.exitCode = 3; return; }
  say('версия клиента:', l.versionId, '(jar:', l.jarId + ')');
  say('java:', l.java || '(нет)', l.javaMajor ? '(' + l.javaMajor + ')' : '');
  say('каталог игры:', l.cwd);
  say('библиотек в classpath:', l.classpath.length);
  say('UUID наблюдателя:', C.offlineUuid(C.OBSERVER), '(ник ' + C.OBSERVER + ')');
  const am = C.missingAssets(l.assetsRoot, l.assetsId);
  if (am.length) l.missing.push('ассетов нет на диске: ' + am.slice(0, 5).join(', '));
  for (const w of l.warnings) say('предупреждение:', w);
  if (l.missing.length) { say('НЕ ХВАТАЕТ (' + l.missing.length + '):'); for (const m of l.missing) say('  - ' + m); }
  else say('все файлы на месте (jar, библиотеки, ассеты, java)');
  say('--- команда ---');
  say(l.java ? C.formatCommand(l.java, l.args) : '(без java команды нет)');
  process.exitCode = l.ok ? 0 : 3;
}
// запуск клиента: вывод — в data/eyes_client.log (ротация 2 МБ), окно показываем (иначе его нечем снять)
function spawnClient(launch) {
  const prevFg = foregroundHwnd();
  fs.mkdirSync(launch.cwd, { recursive: true });
  const logLine = d => E.appendLog(F.clientLog, String(d).replace(/\r?\n$/, ''));
  logLine(`=== ${new Date().toISOString()} запуск клиента ${launch.versionId} ===`);
  const p = spawn(launch.java, launch.args, { cwd: launch.cwd, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', logLine); p.stderr.on('data', logLine);
  p.on('exit', (code, sig) => logLine(`=== клиент вышел: ${code != null ? code : sig} ===`));
  p.on('error', e => logLine('ошибка процесса: ' + e.message));
  p.prevFg = prevFg;
  try { if (p.pid) fs.writeFileSync(F.clientPid, String(p.pid)); } catch (e) {}
  return p;
}
// брошенный клиент прошлого запуска (eyes.js убили жёстко) — гасим по pid-файлу, если это наш gameDir
async function killStaleClient() {
  let pid = 0; try { pid = parseInt(fs.readFileSync(F.clientPid, 'utf8'), 10); } catch (e) {}
  if (!(pid > 0)) return;
  const out = await psRun(C.staleKillScript(pid, F.clientDir), 10000);
  if (out && /killed/.test(out)) say('погашен брошенный клиент прошлого запуска, pid', pid);
  try { fs.rmSync(F.clientPid, { force: true }); } catch (e) {}
}

// ---------- проверка связи ----------
async function probe() {
  if (!key) { say('нет ключа Gemini (GEMINI_API_KEY или %USERPROFILE%\\.local\\share\\opencode\\auth.json -> .google.key)'); process.exitCode = 1; return; }
  const cfg = E.readConfig(F.cfg), bin = await ffmpegBin();
  const frames = [];
  const target = await findWindow(cfg);
  const title = target && target.title;
  if (target) {
    say('окно:', title, '(hwnd ' + target.hwnd + ', захват ' + cfg.capture + ')');
    await new Promise(resolve => {
      const p = startCapture(bin, target, cfg, f => { frames.push(f); if (frames.length >= 3) { try { p.kill(); } catch (e) {} resolve(); } }, msg => { say(msg); resolve(); });
      setTimeout(() => { try { p.kill(); } catch (e) {} resolve(); }, 15000);
    });
  }
  if (frames.length < 3) {
    say(title ? 'кадров с окна мало, добираю синтетическими' : 'окна Minecraft нет, кадры синтетические (ffmpeg lavfi)');
    for (const c of ['red', 'green', 'blue']) { if (frames.length >= 3) break; frames.push(await syntheticFrame(bin, c)); }
  }
  say('кадров:', frames.length, 'байт:', frames.map(f => f.length).join('/'), 'модель:', cfg.model);
  const live = new E.LiveClient({ key, cfg, getPrompt });
  try {
    const how = await live.connect();
    say('подключено:', how);
    for (const f of frames) { live.sendFrame(f.toString('base64')); await sleep(400); }
    const r = await live.ask('Что на присланных кадрах? Муха сама сообщает: данные мухи недоступны (проверка связи). Ответь по формату.', ANSWER_TIMEOUT_MS);
    say('ответ:', r.text || '(пусто)');
    say('usage:', JSON.stringify(r.usage), r.timedOut ? '(таймаут ответа)' : '', r.error ? '(' + r.error + ')' : '');
    say('handle сессии получен:', !!live.handle);
    process.exitCode = r.text ? 0 : 2;
  } catch (e) { say('ошибка:', safe(e && e.message || e)); process.exitCode = 1; }
  finally { live.close(); }
}

// ---------- основной цикл ----------
async function run() {
  E.archiveSeed(F.archive, F.log);   // первый запуск с архивом: перенести уже накопленное в eyes.log
  const st = { state: 'no_window', model: '', window: '', lastAnswerAt: null, lastAnswerText: '', tokensPerMin: 0, connects: 0, reconnects: 0, resumes: 0, answers: 0, timeouts: 0, lastError: '', startedAt: new Date().toISOString() };
  let cfg = E.readConfig(F.cfg);
  const bin = await ffmpegBin();
  const meter = new E.TokenMeter(), backoff = new E.Backoff();
  let cap = null, capTitle = null, nextCaptureTry = 0, capStartedAt = 0, backedHwnd = null;
  let sup = null, nextHealth = 0;                                // присмотр за клиентом-наблюдателем (если cfg.autoClient)
  let live = null, connecting = false, nextLiveTry = 0, liveUpAt = 0, quotaUntil = 0, deferred = false;
  let frameN = 0, framesSinceAsk = 0, lastFrameAt = 0;
  let asking = false, lastAskAt = Date.now();
  let lastEventId = null, lastChatId = null, pendingEvent = null, eventsSinceAsk = [];
  let lastPoll = 0, lastStatus = 0;

  const publish = (force) => {
    const now = Date.now();
    if (!force && now - lastStatus < 3000) return;
    lastStatus = now;
    st.model = cfg.model; st.window = capTitle || cfg.window || ''; st.tokensPerMin = meter.used(now);
    st.capture = cfg.capture; st.autoClient = cfg.autoClient; st.client = sup ? sup.status(now) : null;
    E.writeStatus(F.status, { ...st, updated: new Date(now).toISOString() });
  };
  const setState = (s, err) => { if (err) st.lastError = safe(err).slice(0, 300); if (st.state !== s || err) { st.state = s; publish(true); } };

  const stopCapture = () => { const p = cap; cap = null; if (p) { try { p.kill(); } catch (e) {} } };
  let handleKeep = null;                                          // handle сессии: после зависания переподключаемся с продолжением контекста
  const dropLive = keep => { handleKeep = keep && live ? live.handle : null; if (live) { try { live.close(); } catch (e) {} } live = null; };

  const noWindow = msg => setState('no_window', st.lastError === msg ? undefined : msg);
  async function ensureCapture(now) {
    if (cap || now < nextCaptureTry) return;
    cfg = E.readConfig(F.cfg);
    const auto = cfg.autoClient && !cfg.window;                    // окно ищем у своего клиента, по pid
    nextCaptureTry = now + (auto ? FIND_CLIENT_MS : RETRY_WINDOW_MS);
    let target;
    if (auto) {
      if (!sup || !sup.pid) { dropLive(); capTitle = null; noWindow('клиент-наблюдатель не запущен'); return; }
      target = await findClientWindow(sup.pid);
      if (!target) { noWindow('окно клиента ещё не появилось'); return; }
      if (backedHwnd !== target.hwnd) {                            // окно новое: на дно, фокус — хозяину
        backedHwnd = target.hwnd;
        psRun(C.sendToBackScript(target.hwnd, sup.child && sup.child.prevFg)).catch(() => {});
      }
      if (!C.titleInGame(target.title) && Date.now() - sup.startedAt < LOADING_WAIT_MS) { noWindow('клиент грузится: ' + target.title); return; }
    } else {
      target = await findWindow(cfg);
      if (!target) { dropLive(); capTitle = null; setState('no_window', 'окно Minecraft не найдено'); return; }
    }
    capTitle = target.title; capStartedAt = Date.now(); lastFrameAt = 0;
    say('захват окна:', target.title, '(' + cfg.capture + ')');
    const p = startCapture(bin, target, cfg, f => {
      lastFrameAt = Date.now(); framesSinceAsk++; frameN++;
      if (live && live.ready && frameN % meter.frameEvery(lastFrameAt) === 0) live.sendFrame(f.toString('base64'));
    }, msg => {
      if (cap !== p && cap) return;
      cap = null; dropLive(); say(msg);
      setState('no_window', msg);
    });
    cap = p;
  }

  async function ensureLive(now) {
    if (!cap || connecting || (live && live.ready) || now < nextLiveTry || now < quotaUntil) return;
    if (!lastFrameAt || now - lastFrameAt > 15000) return;     // пока нет кадров, Live не держим
    connecting = true; setState('connecting');
    cfg = E.readConfig(F.cfg);
    const handle = (live && live.handle) || handleKeep;
    const c = new E.LiveClient({ key, cfg, getPrompt, handle });
    const had = st.connects > 0;
    try {
      const how = await c.connect();
      live = c; liveUpAt = Date.now(); handleKeep = null;
      st.connects++; if (had) st.reconnects++;
      if (how === 'resumed') st.resumes++;
      say('Live подключён:', how);
      c.on('goaway', g => say('goAway, осталось', g && g.timeLeft));
      c.on('usage', u => meter.record(Date.now(), u.total));
      c.on('close', info => {
        say('Live закрыт:', info.code, info.reason);
        if (E.isQuotaError(info.reason)) quotaUntil = Date.now() + 60000;
        if (Date.now() - liveUpAt > 60000) backoff.reset();
        nextLiveTry = Date.now() + backoff.next();
        setState(Date.now() < quotaUntil ? 'limit' : 'connecting', `закрыто ${info.code || ''} ${info.reason || ''}`.trim());
      });
      c.on('error', m => { setState(st.state, m); if (E.isQuotaError(m)) quotaUntil = Date.now() + 60000; });
      setState('watching');
    } catch (e) {
      const m = safe(e && e.message || e);
      if (E.isQuotaError(m)) quotaUntil = Date.now() + 60000;
      nextLiveTry = Date.now() + backoff.next();
      say('Live не подключился:', m, '- повтор через', Math.round(backoff.cur / 1000), 'с');
      setState(Date.now() < quotaUntil ? 'limit' : 'error', m);
      // live (закрытый) остаётся: его handle пригодится следующей попытке
    } finally { connecting = false; }
  }

  // жива ли муха в мире (GET /health, наблюдательский заголовок): true / false (тело есть, мухи нет) / null (тела нет)
  async function pollHealth(now) {
    if (!sup || now < nextHealth) return;
    nextHealth = now + HEALTH_EVERY_MS;
    let state = null;
    try { const h = await getJson('/health'); state = h && h.connected === true ? true : false; } catch (e) { state = null; }
    sup.update(now, state);
  }
  function watchdog(now) {                                        // захват жив, а кадров нет — перезапуск ffmpeg
    if (!cap || now - Math.max(lastFrameAt, capStartedAt) < NO_FRAMES_MS) return;
    say('нет кадров', Math.round((now - Math.max(lastFrameAt, capStartedAt)) / 1000), 'с — перезапускаю захват');
    stopCapture();
  }

  async function pollBody(now) {
    if (now - lastPoll < 2000) return;
    lastPoll = now;
    try {
      const r = await getJson('/events?since=' + (lastEventId == null ? 0 : lastEventId) + '&limit=200');
      if (lastEventId == null) lastEventId = r.lastId || 0;     // старую историю не разбираем
      else {
        lastEventId = r.lastId || lastEventId;
        const ev = (r.events || []).filter(e => e && e.id > 0);
        eventsSinceAsk.push(...ev.filter(e => !e.sync && !QUIET.has(e.type)));
        eventsSinceAsk = eventsSinceAsk.slice(-20);
        pendingEvent = E.pickEvent(ev.concat(pendingEvent ? [pendingEvent] : []), QUIET) || pendingEvent;
      }
    } catch (e) { /* тело недоступно — вопрос всё равно зададим */ }
  }

  async function gatherBody() {
    const [task, autopilot, snapshot, chat] = await Promise.all([
      getJson('/task').catch(() => null), getJson('/autopilot').catch(() => null), getJson('/snapshot').catch(() => null),
      getJson('/chat?since=' + (lastChatId || 0) + '&limit=30').catch(() => null)
    ]);
    if (!task && !autopilot && !snapshot && !chat) return null;
    let lines = [];
    if (chat) {
      if (lastChatId == null) lines = []; else lines = (chat.chat || []).filter(c => /^\[тело\]/.test(c.text || '') || c.from === 'FlyBot_01');
      lastChatId = chat.lastId || lastChatId || 0;
    }
    return { task, autopilot, snapshot, events: eventsSinceAsk, chat: lines.map(c => ({ text: String(c.text).replace(/^\[тело\]\s*/, '') })) };
  }

  async function maybeAsk(now) {
    if (asking || !live || !live.ready) return;
    const reason = E.dueReason({ now, lastAskAt, askEverySec: cfg.askEverySec, event: pendingEvent });
    if (!reason) return;
    if (!framesSinceAsk) return;                                  // кадров не было — спрашивать нечего
    if (now < quotaUntil || !meter.canAsk(now)) {                 // лимит: откладываем, кадры реже
      if (!deferred) say('вопрос отложен: токенов за минуту', meter.used(now));
      deferred = true; setState('limit'); return;
    }
    deferred = false; asking = true;
    const t0 = Date.now();
    try {
      const raw = await gatherBody();
      const q = E.buildQuestion({ sec: (t0 - lastAskAt) / 1000, reason, body: raw ? E.bodyContext(raw) : 'данные мухи недоступны' });
      lastAskAt = t0; framesSinceAsk = 0; pendingEvent = null; eventsSinceAsk = [];
      const r = await live.ask(q, ANSWER_TIMEOUT_MS);
      if (r.usage && !meter.items.some(x => x.t >= t0)) meter.record(Date.now(), r.usage.total);
      if (r.text) {
        const ln = E.logLine(Date.now(), reason, r.text);
        E.appendLog(F.log, ln); E.archiveLine(F.archive, ln);
        st.answers++; st.lastAnswerAt = new Date().toISOString(); st.lastAnswerText = r.text.slice(0, 200);
        // текст ответа — в eyes.log; в консольный журнал только пульс раз в 20 ответов и ответы по таймауту (он не ротируется сам)
        if (r.timedOut || st.answers % 20 === 1) say('ответ #' + st.answers + ':', r.text.slice(0, 120), r.timedOut ? '(по таймауту)' : '');
      }
      if (r.timedOut) st.timeouts++;
      if (!r.text) {
        const why = r.error || (r.timedOut ? 'нет ответа за ' + ANSWER_TIMEOUT_MS / 1000 + ' с' : 'пустой ответ');
        setState(st.state, why); say('нет ответа:', why);
        if (E.isQuotaError(why)) quotaUntil = Date.now() + 60000;
        if (r.timedOut || r.error) dropLive(true);                // сессия подвисла — переподключимся (с handle)
      }
      if (live && live.ready) setState('watching');
    } catch (e) { setState(st.state, 'вопрос: ' + (e && e.message || e)); }
    finally { asking = false; }
  }

  // пульт: выключено — всё закрыть (своими stop-функциями) и ждать; включено снова — сбросить паузы, цикл поднимет всё сам
  let off = false, nextSwitch = 0;
  function checkSwitch(now) {
    if (now >= nextSwitch) {
      nextSwitch = now + SWITCH_EVERY_MS;
      let on = true; try { on = switches.isOn('eyes', DATA); } catch (e) {}
      if (!on && !off) { off = true; say('пульт: глаза выключены — закрываю Live, захват и клиент-наблюдатель, жду включения'); stopAll(); dropLive(); capTitle = null; }
      else if (on && off) { off = false; say('пульт: глаза включены — поднимаюсь'); nextCaptureTry = 0; nextLiveTry = 0; nextHealth = 0; st.lastError = ''; setState('no_window'); }
    }
    if (off && st.state !== 'off') setState('off');            // захват, закрываясь, пишет своё состояние — пульт главнее
    return off;
  }

  const tick = async () => {
    const now = Date.now();
    try {
      if (checkSwitch(now)) { publish(false); return; }
      await pollHealth(now);
      watchdog(now);
      await ensureCapture(now);
      await ensureLive(now);
      await pollBody(now);
      await maybeAsk(now);
      publish(false);
    } catch (e) { setState(st.state, 'цикл: ' + (e && e.message || e)); }
  };
  const stopAll = () => { stopCapture(); if (sup) { try { sup.stop(); } catch (e) {} try { fs.rmSync(F.clientPid, { force: true }); } catch (e) {} } };
  const quit = () => { stopAll(); dropLive(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  process.on('exit', stopAll);
  if (cfg.autoClient) {
    await killStaleClient();
    sup = new C.ClientSupervisor({
      spawn: spawnClient, log: m => say('клиент:', m),
      build: () => { cfg = E.readConfig(F.cfg); const l = buildClient(cfg); if (l.ok) C.writeOptions(F.clientDir); return l; }
    });
  }
  say('глаза запущены; модель', cfg.model, '; тело', BODY, '; клиент-наблюдатель:', cfg.autoClient ? 'сам (autoClient)' : 'хозяин открывает окно', '; захват', cfg.capture);
  publish(true);
  for (;;) { await tick(); await sleep(500); }
}

process.on('uncaughtException', e => { console.error('необработанная ошибка:', safe(e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', e => { console.error('необработанный отказ:', safe(e && e.stack || e)); });

if (require.main === module) {
  if (!key && !process.argv.includes('--probe') && !process.argv.includes('--client-cmd')) {
    E.writeStatus(F.status, { state: 'error', lastError: 'нет ключа Gemini', updated: new Date().toISOString() });
    console.error('нет ключа Gemini (GEMINI_API_KEY или auth.json -> .google.key)');
    process.exit(1);
  }
  if (process.argv.includes('--client-cmd')) { clientCmd(); return; }
  (process.argv.includes('--probe') ? probe() : run()).catch(e => { console.error('ошибка:', safe(e && e.stack || e)); process.exit(1); });
}
