// Клиент-наблюдатель для «глаз» мухи: чистая логика для tools/eyes.js (процессы, powershell и настоящая сеть — там; здесь всё проверяется без них).
// Что тут: офлайн-UUID, сборка команды java из version json Modrinth (наследование, rules, библиотеки, аргументы), options.txt,
// установка датапака flyeyes в мир, аргументы ffmpeg для захвата окна (gfxcapture / gdigrab), присмотр за процессом клиента
// (запуск, когда муха в мире; гашение без мухи; перезапуск с растущей паузой).
// Ничего не скачиваем: берём только то, что Modrinth уже положил в %APPDATA%\ModrinthApp\meta.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OBSERVER = 'FlyEyes';          // ник наблюдателя; тот же зашит в датапаке (tools/eyes_datapack)
const FLY = 'FlyBot_01';
const WIDTH = 854, HEIGHT = 480;
const IDLE_STOP_MS = 2 * 60 * 1000;  // муха не в мире дольше — клиент гасим
const PAUSE_MIN_MS = 30 * 1000, PAUSE_MAX_MS = 5 * 60 * 1000;
const STABLE_MS = 5 * 60 * 1000;     // проработал столько — пауза перезапуска сбрасывается

// ---------- UUID ----------
// Как у сервера в офлайн-режиме: UUID v3 (MD5) от "OfflinePlayer:<ник>"
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

// ---------- rules ----------
// env: { os: 'windows', arch: 'x64' }; features: { has_custom_resolution: true, ... } (нет в списке = false)
function ruleMatches(rule, env, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== env.os) return false;
    if (rule.os.arch && rule.os.arch !== env.arch) return false;          // в json x86 = 32-бит; у нас x64
    if (rule.os.version && env.osVersion && !new RegExp(rule.os.version).test(env.osVersion)) return false;
  }
  if (rule.features) for (const k of Object.keys(rule.features)) if (!!(features || {})[k] !== !!rule.features[k]) return false;
  return true;
}
// нет rules — разрешено; иначе последнее подошедшее правило решает, ни одно не подошло — запрещено
function rulesAllow(rules, env, features) {
  if (!Array.isArray(rules) || !rules.length) return true;
  let allow = false;
  for (const r of rules) if (ruleMatches(r, env, features)) allow = r.action !== 'disallow';
  return allow;
}
function hostEnv(platform = process.platform, arch = process.arch) {
  return { os: platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux', arch: arch === 'ia32' ? 'x86' : arch };
}

// ---------- version json ----------
function readJsonFile(file, fsApi = fs) {
  let s = fsApi.readFileSync(file, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return JSON.parse(s);
}
const libKey = name => { const p = String(name).split(':'); return p.slice(0, 2).join(':') + (p[3] ? ':' + p[3] : ''); };   // группа:артефакт[:классификатор]
// Склейка по inheritsFrom: родитель первым; библиотеки с тем же ключом заменяются; аргументы дописываются
function loadVersion(metaDir, id, fsApi = fs, depth = 0) {
  if (depth > 5) throw new Error('inheritsFrom слишком глубоко: ' + id);
  const file = path.join(metaDir, 'versions', id, id + '.json');
  let j;
  try { j = readJsonFile(file, fsApi); } catch (e) { throw new Error(`нет version json ${id}: ${file}`); }
  if (!j.inheritsFrom) return { ...j, jarId: j.jar || id, chain: [id] };
  const p = loadVersion(metaDir, j.inheritsFrom, fsApi, depth + 1);
  const libs = new Map();
  for (const l of [...(p.libraries || []), ...(j.libraries || [])]) libs.set(libKey(l.name) + (l.rules ? '|' + JSON.stringify(l.rules) : ''), l);
  const a = k => [...(((p.arguments || {})[k]) || []), ...(((j.arguments || {})[k]) || [])];
  const hasArgs = p.arguments || j.arguments;
  return {
    ...p, ...j, libraries: [...libs.values()],
    ...(hasArgs ? { arguments: { game: a('game'), jvm: a('jvm') } } : {}),
    jarId: j.jar || p.jarId, chain: [id, ...p.chain]
  };
}
const isPlainVersion = id => /^\d+(\.\d+)*$/.test(id) ? 1 : 0;
const cmpVer = (a, b) => { const x = a.split(/[.-]/), y = b.split(/[.-]/); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d; } return 0; };
// какую версию взять: точное совпадение; иначе начинающиеся с want (чистая ванильная раньше загрузчиков, новее раньше старых)
function pickVersion(metaDir, want, fsApi = fs) {
  let dirs = []; try { dirs = fsApi.readdirSync(path.join(metaDir, 'versions')); } catch (e) {}
  const has = id => { try { return fsApi.existsSync(path.join(metaDir, 'versions', id, id + '.json')); } catch (e) { return false; } };
  if (has(want)) return want;
  const c = dirs.filter(d => (d.startsWith(want + '-') || d.startsWith(want + '.')) && has(d));
  c.sort((a, b) => (isPlainVersion(b) - isPlainVersion(a)) || cmpVer(b, a));
  return c[0] || null;
}

// ---------- библиотеки ----------
// group:artifact:version[:classifier][@ext] -> group/artifact/version/artifact-version[-classifier].ext
function mavenPath(name) {
  const [coord, ext = 'jar'] = String(name).split('@');
  const p = coord.split(':');
  if (p.length < 3) return null;
  const [g, a, v, cl] = p;
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${cl ? '-' + cl : ''}.${ext}`;
}
const libFile = lib => (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) || mavenPath(lib.name);

// ---------- Java ----------
const javaMajorOfDir = name => { const m = /jre(\d+)/i.exec(name) || /^(?:zulu|jdk|jre|java)?-?(\d+)/i.exec(name); return m ? +m[1] : null; };
// Java от Modrinth (meta/java_versions/*): нужная мажорная; нет — ближайшая более новая. null, если не нашлось.
function findModrinthJava(metaDir, major, fsApi = fs) {
  const root = path.join(metaDir, 'java_versions');
  let dirs = []; try { dirs = fsApi.readdirSync(root); } catch (e) { return null; }
  const c = [];
  for (const d of dirs) {
    const m = javaMajorOfDir(d); if (m == null || m < major) continue;
    for (const exe of ['javaw.exe', 'java.exe', 'java']) { const p = path.join(root, d, 'bin', exe); if (fsApi.existsSync(p)) { c.push({ m, p, d }); break; } }
  }
  c.sort((a, b) => a.m - b.m);
  return c[0] || null;
}

// ---------- аргументы ----------
const FEATURES = { has_custom_resolution: true, is_quick_play_multiplayer: true };
function expandArgs(list, vars, env, features, warnings) {
  const out = [];
  const sub = s => String(s).replace(/\$\{([^}]+)\}/g, (m, k) => { if (k in vars) return String(vars[k]); if (warnings) warnings.push('нет значения для ' + m); return m; });
  for (const a of list || []) {
    if (typeof a === 'string') { out.push(sub(a)); continue; }
    if (!a || !rulesAllow(a.rules, env, features)) continue;
    for (const v of Array.isArray(a.value) ? a.value : [a.value]) if (v != null) out.push(sub(v));
  }
  return out;
}

// o: { metaDir, versionId, gameDir, name, memoryMb, host, port, width, height, javaPath, javaMajor, env, fsApi }
// -> { ok, java, javaMajor, args, cwd, classpath, nativesDir, mainClass, versionId, missing: [..], warnings: [..] }
function buildLaunch(o) {
  const fsApi = o.fsApi || fs, env = o.env || hostEnv(), name = o.name || OBSERVER;
  const metaDir = o.metaDir, missing = [], warnings = [];
  const v = loadVersion(metaDir, o.versionId, fsApi);
  const need = (what, p) => { if (!fsApi.existsSync(p)) missing.push(`${what}: ${p}`); return p; };

  // Java
  const major = (v.javaVersion && v.javaVersion.majorVersion) || 0;
  let java = o.javaPath || null, javaMajor = o.javaMajor || null;
  if (!java) { const f = findModrinthJava(metaDir, major, fsApi); if (f) { java = f.p; javaMajor = f.m; } }
  if (!java) missing.push(`java ${major || '?'}+ (нет в ${path.join(metaDir, 'java_versions')}, java из PATH не подошла)`);
  else if (path.isAbsolute(java)) need('java', java);

  // classpath: библиотеки по rules, потом jar клиента
  const classpath = [];
  for (const l of v.libraries || []) {
    if (!rulesAllow(l.rules, env, FEATURES) || l.include_in_classpath === false) continue;
    const rel = libFile(l);
    if (!rel) { warnings.push('библиотека без пути: ' + l.name); continue; }
    const p = path.join(metaDir, 'libraries', rel);
    if (!fsApi.existsSync(p)) missing.push(`библиотека ${l.name}: ${p}`);
    classpath.push(p);
  }
  classpath.push(need('jar клиента', path.join(metaDir, 'versions', v.jarId, v.jarId + '.jar')));

  // ассеты и конфиг логов
  const assetsRoot = path.join(metaDir, 'assets');
  const assetsId = (v.assetIndex && v.assetIndex.id) || v.assets || 'legacy';
  need('индекс ассетов', path.join(assetsRoot, 'indexes', assetsId + '.json'));
  let logArg = null;
  const lf = v.logging && v.logging.client && v.logging.client.file;
  if (lf && lf.id) {
    const lp = path.join(metaDir, 'log_configs', lf.id);
    if (fsApi.existsSync(lp)) logArg = String(v.logging.client.argument || '').replace('${path}', lp) || null;   // нет файла — не страшно, обычный лог
  }

  const gameDir = o.gameDir, nativesDir = path.join(gameDir, 'natives');
  const vars = {
    auth_player_name: name, version_name: v.id, game_directory: gameDir, assets_root: assetsRoot, assets_index_name: assetsId,
    auth_uuid: offlineUuid(name), auth_access_token: '0', clientid: '0', auth_xuid: '0', user_type: 'legacy', user_properties: '{}',
    version_type: v.type || 'release', resolution_width: o.width || WIDTH, resolution_height: o.height || HEIGHT,
    quickPlayMultiplayer: `${o.host || 'localhost'}:${o.port || 25565}`, quickPlayPath: '', quickPlaySingleplayer: '', quickPlayRealms: '',
    natives_directory: nativesDir, launcher_name: 'flyeyes', launcher_version: '1', classpath: classpath.join(';'),
    classpath_separator: ';', library_directory: path.join(metaDir, 'libraries'), game_assets: assetsRoot, auth_session: '0'
  };
  let jvm, game;
  if (v.arguments) { jvm = expandArgs(v.arguments.jvm, vars, env, FEATURES, warnings); game = expandArgs(v.arguments.game, vars, env, FEATURES, warnings); }
  else {                                                                       // старый формат (до 1.13)
    jvm = ['-Djava.library.path=' + nativesDir];
    game = expandArgs(String(v.minecraftArguments || '').split(/\s+/).filter(Boolean), vars, env, FEATURES, warnings);
  }
  if (!jvm.some(a => a === '-cp' || a === '-classpath')) jvm.push('-cp', vars.classpath);
  const mem = Math.round(o.memoryMb || 2048);
  const xmx = mem % 1024 === 0 ? `-Xmx${mem / 1024}G` : `-Xmx${mem}M`;
  const args = [xmx, ...jvm, ...(logArg ? [logArg] : []), v.mainClass, ...game];
  return { ok: !missing.length && !!java, java, javaMajor, args, cwd: gameDir, classpath, nativesDir, mainClass: v.mainClass, versionId: v.id, jarId: v.jarId, assetsId, assetsRoot, missing, warnings };
}
// ассеты, которых нет на диске (по индексу); строки вида «ab/abcdef…». Пустой список = все на месте.
function missingAssets(assetsRoot, assetsId, fsApi = fs, limit = 20) {
  let idx; try { idx = readJsonFile(path.join(assetsRoot, 'indexes', assetsId + '.json'), fsApi); } catch (e) { return []; }
  const out = []; let n = 0;
  for (const o of Object.values(idx.objects || {})) {
    const h = o && o.hash; if (!h) continue;
    if (!fsApi.existsSync(path.join(assetsRoot, 'objects', h.slice(0, 2), h))) { n++; if (out.length < limit) out.push(h.slice(0, 2) + '/' + h); }
  }
  return n > out.length ? [...out, `…и ещё ${n - out.length}`] : out;
}
const quoteArg = a => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"');
const formatCommand = (java, args) => [java, ...args].map(quoteArg).join(' ');

// ---------- options.txt ----------
// Ключи 26.1 (сверено с options.txt хозяина). Остальное клиент допишет сам при выходе.
const CLIENT_OPTIONS = [
  ['pauseOnLostFocus', 'false'], ['onboardAccessibility', 'false'], ['skipMultiplayerWarning', 'true'], ['joinedFirstServer', 'true'],
  ['tutorialStep', 'none'], ['narrator', '0'], ['renderDistance', '8'], ['simulationDistance', '5'], ['maxFps', '15'],
  ['inactivityFpsLimit', '"minimized"'], ['enableVsync', 'false'], ['soundCategory_master', '0.0'], ['musicToast', '"never"'],
  ['fullscreen', 'false'], ['guiScale', '2'], ['realmsNotifications', 'false']
];
// существующий файл дополняем (наши ключи перезаписываем, остальные не трогаем)
function buildOptions(existing) {
  const lines = String(existing || '').split(/\r?\n/).filter(l => l.trim());
  const mine = new Map(CLIENT_OPTIONS);
  const out = [], seen = new Set();
  for (const l of lines) {
    const k = l.split(':')[0];
    if (mine.has(k)) { if (!seen.has(k)) { out.push(`${k}:${mine.get(k)}`); seen.add(k); } } else out.push(l);
  }
  for (const [k, v] of CLIENT_OPTIONS) if (!seen.has(k)) out.push(`${k}:${v}`);
  return out.join('\n') + '\n';
}
function writeOptions(gameDir, fsApi = fs) {
  fsApi.mkdirSync(gameDir, { recursive: true });
  const f = path.join(gameDir, 'options.txt');
  let cur = ''; try { cur = fsApi.readFileSync(f, 'utf8'); } catch (e) {}
  const next = buildOptions(cur);
  if (next !== cur) fsApi.writeFileSync(f, next);
  return f;
}

// ---------- датапак ----------
// Копирует исходник в <мир>/datapacks/flyeyes. Мир — только настоящий (есть level.dat). Чужие паки не трогаем.
function installDatapack(src, world, fsApi = fs) {
  if (!world) return { ok: false, error: 'не указан мир (data/eyes.json -> world)' };
  if (!fsApi.existsSync(path.join(world, 'level.dat'))) return { ok: false, error: 'это не папка мира (нет level.dat): ' + world };
  if (!fsApi.existsSync(path.join(src, 'pack.mcmeta'))) return { ok: false, error: 'нет исходника датапака: ' + src };
  const dst = path.join(world, 'datapacks', 'flyeyes');
  fsApi.mkdirSync(path.join(world, 'datapacks'), { recursive: true });
  fsApi.rmSync(dst, { recursive: true, force: true });
  fsApi.cpSync(src, dst, { recursive: true });
  const files = [];
  (function walk(d) { for (const e of fsApi.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(dst, p).replace(/\\/g, '/')); } })(dst);
  return { ok: true, dst, files: files.sort() };
}

// ---------- захват окна ----------
// target: { hwnd, title }. gfx — по hwnd нашего процесса (снимает и перекрытое окно, не свёрнутое); gdi — пиксели экрана по заголовку.
function captureArgs(cfg, target) {
  const head = ['-loglevel', 'error', '-nostats'];
  const tail = ['-q:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'];
  if (cfg.capture === 'gdi') {
    if (!target || !target.title) throw new Error('gdigrab: нет заголовка окна');
    return [...head, '-f', 'gdigrab', '-framerate', String(cfg.fps), '-i', 'title=' + target.title, '-vf', `scale=${Math.round(cfg.width)}:-2`, ...tail];
  }
  if (!target || !/^\d+$/.test(String(target.hwnd || '')) || String(target.hwnd) === '0') throw new Error('gfxcapture: нет hwnd окна');
  // gfxcapture отдаёт кадры d3d11 -> hwdownload + bgra. WGC шлёт кадр, когда картинка меняется (max_framerate — потолок); fps выравнивает до нужного
  const maxFr = Math.max(2, Math.ceil(cfg.fps * 2));
  const src = `gfxcapture=hwnd=${target.hwnd}:capture_cursor=0:max_framerate=${maxFr},hwdownload,format=bgra`;
  return [...head, '-f', 'lavfi', '-i', src, '-vf', `fps=${cfg.fps},scale=${Math.round(cfg.width)}:-2`, ...tail];
}
// powershell: окно процесса по pid -> «hwnd|заголовок» (пусто — окна ещё нет)
function windowScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('плохой pid');
  return "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if($p -and $p.MainWindowHandle -ne 0){ '{0}|{1}' -f $p.MainWindowHandle.ToInt64(), $p.MainWindowTitle }";
}
// P/Invoke-обвязка user32 для powershell-скриптов ниже
const WIN32 = "Add-Type -Namespace FE -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'; ";
// какое окно сейчас на переднем плане (чтобы вернуть ему фокус после появления окна клиента)
function foregroundScript() { return WIN32 + "[FE.W]::GetForegroundWindow().ToInt64()"; }
// окно клиента — на дно (не активируя), а фокус — вернуть тому, у кого он был (хозяин играет в своём окне, а не в нашем)
function sendToBackScript(hwnd, restore) {
  if (!/^\d+$/.test(String(hwnd))) throw new Error('плохой hwnd');
  let s = WIN32 + "[FE.W]::SetWindowPos([IntPtr][long]" + hwnd + ", [IntPtr]1, 0, 0, 0, 0, 0x4013) | Out-Null";
  if (restore != null && /^\d+$/.test(String(restore)) && String(restore) !== '0' && String(restore) !== String(hwnd))
    s += "; [FE.W]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [FE.W]::SetForegroundWindow([IntPtr][long]" + restore + ") | Out-Null; [FE.W]::keybd_event(0x12,0,2,[UIntPtr]::Zero)";
  return s;
}
// брошенный клиент прошлого запуска (eyes.js убили жёстко): гасим, только если командная строка процесса содержит наш gameDir
function staleKillScript(pid, marker) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('плохой pid');
  const m = String(marker).replace(/'/g, "''");
  return "$q=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' -ErrorAction SilentlyContinue; if($q -and $q.CommandLine -and $q.CommandLine.Contains('" + m + "')){ Stop-Process -Id " + pid + " -Force; 'killed' }";
}
const encodePs = script => Buffer.from(script, 'utf16le').toString('base64');   // powershell -EncodedCommand
function parseWindow(out) {
  const line = String(out || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
  const m = line && /^(\d+)\|(.*)$/.exec(line);
  return m && m[1] !== '0' ? { hwnd: m[1], title: m[2].trim() } : null;
}
// клиент уже в мире (в заголовке «Multiplayer»)? Нет — кадры загрузки в Live не шлём
const titleInGame = title => /multiplayer/i.test(String(title || ''));

// ---------- присмотр за клиентом ----------
// spawn(launch) -> ребёнок { pid, on('exit'|'error'), kill() }; build() -> результат buildLaunch (или бросает); now() — часы (для тестов).
// update(now, bodyState): bodyState true — муха в мире; false — тело отвечает, но муха не в мире; null — тела нет.
class ClientSupervisor {
  constructor(o) {
    this.spawn = o.spawn; this.build = o.build; this.log = o.log || (() => {}); this.nowFn = o.now || Date.now;
    this.idleStopMs = o.idleStopMs || IDLE_STOP_MS; this.pauseMin = o.pauseMin || PAUSE_MIN_MS; this.pauseMax = o.pauseMax || PAUSE_MAX_MS; this.stableMs = o.stableMs || STABLE_MS;
    this.child = null; this.startedAt = 0; this.lastUpAt = null; this.nextStartAt = 0; this.pause = 0;
    this.starts = 0; this.crashes = 0; this.lastExit = null; this.lastError = ''; this.stopping = false;
  }
  get running() { return !!this.child; }
  get pid() { return this.child ? this.child.pid : null; }
  update(now, bodyState) {
    if (bodyState === true) {
      this.lastUpAt = now;
      if (!this.child && now >= this.nextStartAt) this._start(now);
    } else if (this.child && this.lastUpAt != null && now - this.lastUpAt > this.idleStopMs) {
      this.log(`муха не в мире ${Math.round((now - this.lastUpAt) / 1000)} с — гашу клиент`);
      this.stop();
    }
  }
  _start(now) {
    let launch;
    try { launch = this.build(); } catch (e) { launch = { ok: false, missing: [e.message || String(e)] }; }
    if (!launch || !launch.ok) {                                               // честная ошибка (нет файла/java), повтор с паузой
      this.lastError = 'клиент не собрать: ' + ((launch && launch.missing && launch.missing.slice(0, 3).join('; ')) || 'неизвестно');
      this.nextStartAt = now + this._nextPause();
      this.log(this.lastError);
      return;
    }
    let ch;
    try { ch = this.spawn(launch); } catch (e) { this.lastError = 'не запустился: ' + (e && e.message || e); this.nextStartAt = now + this._nextPause(); this.log(this.lastError); return; }
    this.child = ch; this.startedAt = now; this.starts++; this.lastError = ''; this.stopping = false;
    let done = false;
    const gone = why => {
      if (done) return; done = true;
      if (this.child === ch) this.child = null;
      const t = this.nowFn();
      if (this.stopping) { this.stopping = false; this.nextStartAt = 0; this.lastExit = { at: t, why: 'остановлен: ' + why, crash: false }; return; }
      this.crashes++;
      if (t - this.startedAt >= this.stableMs) this.pause = 0;                 // долго жил — это не «падает при старте»
      const p = this._nextPause();
      this.nextStartAt = t + p;
      this.lastExit = { at: t, why, crash: true, pauseSec: Math.round(p / 1000) };
      this.lastError = `клиент вышел: ${why}`;
      this.log(`${this.lastError}; перезапуск через ${Math.round(p / 1000)} с`);
    };
    ch.on('exit', (code, sig) => gone(`код ${code != null ? code : sig}`));
    ch.on('error', e => gone('ошибка процесса: ' + (e && e.message || e)));
    this.log(`клиент запущен, pid ${ch.pid}`);
  }
  _nextPause() { this.pause = this.pause ? Math.min(this.pauseMax, this.pause * 2) : this.pauseMin; return this.pause; }
  stop() {
    const ch = this.child; if (!ch) return;
    this.stopping = true;
    try { ch.kill(); } catch (e) {}
  }
  status(now) {
    return {
      state: this.child ? 'running' : this.lastError && this.nextStartAt > now ? 'waiting' : 'off',
      pid: this.pid, starts: this.starts, crashes: this.crashes, lastError: this.lastError, lastExit: this.lastExit,
      nextStartInSec: !this.child && this.nextStartAt > now ? Math.ceil((this.nextStartAt - now) / 1000) : 0
    };
  }
}

module.exports = {
  OBSERVER, FLY, WIDTH, HEIGHT, IDLE_STOP_MS, PAUSE_MIN_MS, PAUSE_MAX_MS, STABLE_MS, FEATURES, CLIENT_OPTIONS,
  offlineUuid, rulesAllow, hostEnv, loadVersion, pickVersion, mavenPath, libFile, findModrinthJava, javaMajorOfDir, expandArgs,
  buildLaunch, missingAssets, formatCommand, buildOptions, writeOptions, installDatapack,
  captureArgs, windowScript, sendToBackScript, foregroundScript, staleKillScript, encodePs, parseWindow, titleInGame, ClientSupervisor
};
