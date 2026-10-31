// Клиент-наблюдатель «глаз» (lib/eyes_client.js) и датапак flyeyes: без сети, без java, без ffmpeg и без запуска чего-либо.
// Офлайн-UUID, rules и аргументы version json, наследование (Fabric поверх ванили), сборка команды на подделке папки Modrinth,
// options.txt, установка датапака, аргументы захвата, присмотр за процессом (запуск/гашение/перезапуск с растущей паузой),
// и что муха не принимает наблюдателя за игрока (угроза, сосед, обидчик, чат).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('vec3');
const C = require('../lib/eyes_client');
const U = require('../lib/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eyesc-'));
const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const WIN = { os: 'windows', arch: 'x64' };

function testUuid() {
  assert.strictEqual(C.offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f', 'известное значение офлайн-UUID');
  assert.strictEqual(C.offlineUuid('FlyEyes'), '46bad3f8-033d-381c-85ec-2336d09e9c0c');
  assert.notStrictEqual(C.offlineUuid('FlyEyes'), C.offlineUuid('FlyBot_01'));
  assert.strictEqual(C.OBSERVER, 'FlyEyes');
}

function testRules() {
  assert.strictEqual(C.rulesAllow(undefined, WIN, {}), true, 'нет rules');
  assert.strictEqual(C.rulesAllow([{ action: 'allow', os: { name: 'linux' } }], WIN, {}), false, 'только linux');
  assert.strictEqual(C.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], WIN, {}), true);
  assert.strictEqual(C.rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], WIN, {}), false, 'последнее правило решает');
  assert.strictEqual(C.rulesAllow([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], WIN, {}), false, 'arch не совпал');
  const f = [{ action: 'allow', features: { has_custom_resolution: true } }];
  assert.strictEqual(C.rulesAllow(f, WIN, { has_custom_resolution: true }), true);
  assert.strictEqual(C.rulesAllow(f, WIN, {}), false);
  assert.deepStrictEqual(C.hostEnv('win32', 'x64'), WIN);
}

function testArgs() {
  const w = [];
  const out = C.expandArgs([
    '--username', '${auth_player_name}',
    { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] },
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
    '--x', '${нет_такого}'
  ], { auth_player_name: 'FlyEyes', resolution_width: 854 }, WIN, C.FEATURES, w);
  assert.deepStrictEqual(out, ['--username', 'FlyEyes', '--width', '854', '--x', '${нет_такого}']);
  assert.strictEqual(w.length, 1, 'неизвестная подстановка в предупреждение');
  assert.strictEqual(C.mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  assert.strictEqual(C.mavenPath('a.b:c:1.0@zip'), 'a/b/c/1.0/c-1.0.zip');
  assert.strictEqual(C.mavenPath('плохо'), null);
  assert.strictEqual(C.libFile({ name: 'x:y:1', downloads: { artifact: { path: 'q/r.jar' } } }), 'q/r.jar');
}

// Подделка папки Modrinth: ванильная 1.0 + Fabric поверх неё
function fakeMeta({ withJar = true, withLib = true, withJava = true, withIndex = true } = {}) {
  const m = tmp();
  const base = {
    id: '1.0', type: 'release', mainClass: 'net.minecraft.client.main.Main', assets: '7', assetIndex: { id: '7' },
    javaVersion: { majorVersion: 21 },
    libraries: [
      { name: 'com.example:common:1.0' },
      { name: 'org.lwjgl:lwjgl:3.3.3' },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-windows', rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] }
    ],
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client.xml' } } },
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-Dbrand=${launcher_name}', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--uuid', '${auth_uuid}',
        { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] },
        { rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }], value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'] }]
    }
  };
  const fab = { id: '1.0-fabric', inheritsFrom: '1.0', mainClass: 'net.fabricmc.Main', libraries: [{ name: 'com.example:common:2.0' }, { name: 'net.fabricmc:loader:0.1' }], arguments: { jvm: ['-DFabricMark=1'], game: [] } };
  put(path.join(m, 'versions', '1.0', '1.0.json'), '\ufeff' + JSON.stringify(base));
  put(path.join(m, 'versions', '1.0-fabric', '1.0-fabric.json'), JSON.stringify(fab));
  if (withJar) put(path.join(m, 'versions', '1.0', '1.0.jar'));
  if (withLib) for (const p of ['com/example/common/1.0/common-1.0.jar', 'com/example/common/2.0/common-2.0.jar', 'net/fabricmc/loader/0.1/loader-0.1.jar',
    'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar', 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar']) put(path.join(m, 'libraries', ...p.split('/')));
  if (withIndex) put(path.join(m, 'assets', 'indexes', '7.json'), JSON.stringify({ objects: { 'a.png': { hash: 'ab12cd34' }, 'b.png': { hash: 'ff00ee11' } } }));
  put(path.join(m, 'assets', 'objects', 'ab', 'ab12cd34'));
  put(path.join(m, 'log_configs', 'client.xml'));
  if (withJava) { put(path.join(m, 'java_versions', 'zulu17.1-ca-jre17.0.1-win_x64', 'bin', 'javaw.exe')); put(path.join(m, 'java_versions', 'zulu21.1-ca-jre21.0.1-win_x64', 'bin', 'javaw.exe')); }
  return m;
}

function testVersion() {
  const m = fakeMeta();
  const v = C.loadVersion(m, '1.0-fabric');
  assert.strictEqual(v.mainClass, 'net.fabricmc.Main', 'главный класс — у наследника');
  assert.strictEqual(v.jarId, '1.0', 'jar берётся у родителя');
  assert.deepStrictEqual(v.chain, ['1.0-fabric', '1.0']);
  assert(v.libraries.some(l => l.name === 'com.example:common:2.0') && !v.libraries.some(l => l.name === 'com.example:common:1.0'), 'библиотека заменена новой версией');
  assert(v.arguments.jvm.includes('-DFabricMark=1') && v.arguments.jvm.includes('-cp'), 'аргументы дописаны');
  assert.throws(() => C.loadVersion(m, 'нет'), /нет version json/);
  // выбор версии
  assert.strictEqual(C.pickVersion(m, '1.0'), '1.0', 'точное совпадение раньше загрузчика');
  assert.strictEqual(C.pickVersion(m, '2.0'), null);
  const m2 = tmp();
  for (const id of ['26.1-fabric', '26.1.2', '26.1.1', '26.2']) put(path.join(m2, 'versions', id, id + '.json'), '{}');
  assert.strictEqual(C.pickVersion(m2, '26.1'), '26.1.2', 'чистая и новее, загрузчик позже');
  assert.strictEqual(C.pickVersion(m2, '26.1.1'), '26.1.1');
}

function testJava() {
  const m = fakeMeta();
  assert.strictEqual(C.findModrinthJava(m, 21).m, 21);
  assert.strictEqual(C.findModrinthJava(m, 17).m, 17, 'точная мажорная');
  assert.strictEqual(C.findModrinthJava(m, 18).m, 21, 'нет 18 — ближайшая новее');
  assert.strictEqual(C.findModrinthJava(m, 25), null);
  assert.strictEqual(C.javaMajorOfDir('zulu25.32.21-ca-jre25.0.2-win_x64'), 25);
  assert.strictEqual(C.findModrinthJava(tmp(), 21), null, 'нет папки');
}

function testBuild() {
  const m = fakeMeta(), gd = path.join(tmp(), 'game');
  const l = C.buildLaunch({ metaDir: m, versionId: '1.0-fabric', gameDir: gd, memoryMb: 3072, host: 'localhost', port: 25570, env: WIN });
  assert.deepStrictEqual(l.missing, [], JSON.stringify(l.missing));
  assert(l.ok);
  assert(/zulu21/.test(l.java) && /javaw\.exe$/.test(l.java), 'Java 21 от Modrinth');
  const a = l.args, i = a.indexOf('net.fabricmc.Main');
  assert(i > 0, 'главный класс на месте'); assert.strictEqual(a[0], '-Xmx3G');
  const cp = a[a.indexOf('-cp') + 1].split(';');
  assert(cp.some(p => p.endsWith('loader-0.1.jar')) && cp.some(p => p.endsWith('lwjgl-3.3.3-natives-windows.jar')), 'библиотеки по rules');
  assert(!cp.some(p => /natives-linux|common-1\.0/.test(p)), 'чужая ось и заменённая версия не в classpath');
  assert(cp[cp.length - 1].endsWith(path.join('1.0', '1.0.jar')), 'jar клиента последним');
  const g = a.slice(i + 1);
  const val = k => g[g.indexOf(k) + 1];
  assert.strictEqual(val('--username'), 'FlyEyes'); assert.strictEqual(val('--uuid'), C.offlineUuid('FlyEyes'));
  assert.strictEqual(val('--width'), '854'); assert.strictEqual(val('--height'), '480');
  assert.strictEqual(val('--quickPlayMultiplayer'), 'localhost:25570'); assert.strictEqual(val('--gameDir'), gd);
  assert(a.includes('-Dlog4j.configurationFile=' + path.join(m, 'log_configs', 'client.xml')), 'конфиг логов');
  assert(a.includes('-Djava.library.path=' + path.join(gd, 'natives')));
  assert.strictEqual(C.buildLaunch({ metaDir: m, versionId: '1.0', gameDir: gd, memoryMb: 1500, env: WIN }).args[0], '-Xmx1500M');
  // нет файлов — честный список
  const bad = C.buildLaunch({ metaDir: fakeMeta({ withJar: false, withLib: false, withJava: false, withIndex: false }), versionId: '1.0-fabric', gameDir: gd, env: WIN });
  assert(!bad.ok && bad.missing.length >= 7, bad.missing.join('\n'));
  for (const w of ['java', 'jar клиента', 'индекс ассетов', 'loader-0.1.jar']) assert(bad.missing.some(x => x.includes(w)), 'в списке нет: ' + w);
  assert.throws(() => C.buildLaunch({ metaDir: m, versionId: 'нет', gameDir: gd }), /нет version json/);
  // ассеты
  assert.deepStrictEqual(C.missingAssets(path.join(m, 'assets'), '7'), ['ff/ff00ee11']);
  assert.deepStrictEqual(C.missingAssets(path.join(m, 'assets'), 'нет'), []);
  // готовая строка
  const cmd = C.formatCommand('C:\\Program Files\\j\\javaw.exe', ['-Dx=a b', '--y']);
  assert.strictEqual(cmd, '"C:\\Program Files\\j\\javaw.exe" "-Dx=a b" --y');
}

function testOptions() {
  const o = C.buildOptions('');
  for (const k of ['pauseOnLostFocus:false', 'onboardAccessibility:false', 'soundCategory_master:0.0', 'maxFps:15', 'fullscreen:false']) assert(o.includes(k + '\n') || o.includes(k), 'нет ' + k);
  const o2 = C.buildOptions('lang:ru_ru\nmaxFps:260\nfov:0.5\nmaxFps:100\n');
  assert(o2.includes('lang:ru_ru') && o2.includes('fov:0.5'), 'чужие ключи не тронуты');
  assert.strictEqual(o2.split('\n').filter(l => l.startsWith('maxFps:')).length, 1, 'ключ не дублируется');
  assert(o2.includes('maxFps:15') && !o2.includes('maxFps:260'));
  assert.strictEqual(C.buildOptions(o2), o2, 'повтор ничего не меняет');
  const d = tmp(), f = C.writeOptions(path.join(d, 'g'));
  assert(fs.readFileSync(f, 'utf8').includes('pauseOnLostFocus:false'));
}

function testDatapack() {
  const src = path.join(__dirname, '..', 'tools', 'eyes_datapack', 'flyeyes');
  const mc = JSON.parse(fs.readFileSync(path.join(src, 'pack.mcmeta'), 'utf8'));
  assert.deepStrictEqual(mc.pack.min_format, [101, 1]); assert.strictEqual(mc.pack.max_format, 101);
  const fn = path.join(src, 'data', 'flyeyes', 'function');
  const tags = path.join(src, 'data', 'minecraft', 'tags', 'function');
  for (const t of ['tick', 'load']) {
    const j = JSON.parse(fs.readFileSync(path.join(tags, t + '.json'), 'utf8'));
    for (const v of j.values) assert(fs.existsSync(path.join(fn, v.replace('flyeyes:', '') + '.mcfunction')), 'тег ' + t + ' ссылается на ' + v);
  }
  // все вызываемые функции существуют; в чат не пишем; чужих игроков не трогаем
  const names = fs.readdirSync(fn).map(f => f.replace('.mcfunction', ''));
  let all = '';
  for (const f of fs.readdirSync(fn)) {
    const text = fs.readFileSync(path.join(fn, f), 'utf8'); all += text + '\n';
    for (const m of text.matchAll(/function flyeyes:(\w+)/g)) assert(names.includes(m[1]), f + ' зовёт несуществующую ' + m[1]);
  }
  for (const bad of ['tellraw', 'title ', 'say ', 'msg ', '@a ', '@a\n', '@e', '@p', '@r']) assert(!all.includes(bad), 'в датапаке не должно быть: ' + bad);
  for (const l of all.split('\n')) if (/@a\[/.test(l)) assert(/name=(FlyEyes|FlyBot_01)/.test(l), 'селектор не по нашим игрокам: ' + l);
  assert(/spectate FlyBot_01 FlyEyes/.test(all)); assert(/schedule function flyeyes:rearm 30s/.test(all));
  // установка
  const world = tmp(); put(path.join(world, 'level.dat'));
  put(path.join(world, 'datapacks', 'чужой', 'pack.mcmeta'), '{}');
  const r = C.installDatapack(src, world);
  assert(r.ok, JSON.stringify(r)); assert(r.files.includes('pack.mcmeta') && r.files.includes('data/flyeyes/function/tick.mcfunction'), r.files.join(','));
  assert(fs.existsSync(path.join(world, 'datapacks', 'чужой', 'pack.mcmeta')), 'чужие паки целы');
  put(path.join(world, 'datapacks', 'flyeyes', 'старьё.txt'));
  assert(C.installDatapack(src, world).ok); assert(!fs.existsSync(path.join(world, 'datapacks', 'flyeyes', 'старьё.txt')), 'переустановка чистая');
  assert(!C.installDatapack(src, tmp()).ok, 'не мир (нет level.dat)');
  assert(!C.installDatapack(src, '').ok); assert(!C.installDatapack(path.join(world, 'нет'), world).ok);
}

function testCapture() {
  const g = C.captureArgs({ capture: 'gfx', fps: 2, width: 640 }, { hwnd: '394018', title: 'x' });
  const src = g[g.indexOf('-i') + 1];
  assert(/^gfxcapture=hwnd=394018:/.test(src) && /hwdownload,format=bgra$/.test(src), src);
  assert(g.includes('lavfi') && g.includes('mjpeg') && g[g.length - 1] === '-');
  assert(g[g.indexOf('-vf') + 1].startsWith('fps=2,scale=640:-2'));
  const d = C.captureArgs({ capture: 'gdi', fps: 2, width: 640 }, { hwnd: '0', title: 'Minecraft 26.1' });
  assert(d.includes('gdigrab') && d.includes('title=Minecraft 26.1'));
  assert.throws(() => C.captureArgs({ capture: 'gfx', fps: 2, width: 640 }, { hwnd: '0' }), /hwnd/);
  assert.throws(() => C.captureArgs({ capture: 'gfx', fps: 2, width: 640 }, null), /hwnd/);
  assert.throws(() => C.captureArgs({ capture: 'gdi', fps: 2, width: 640 }, {}), /заголов/);
  // скрипты powershell: pid/hwnd только числа (никакой подстановки текста)
  assert.throws(() => C.windowScript('1; calc'), /pid/); assert.throws(() => C.sendToBackScript('1; calc'), /hwnd/);
  assert(/Id 77 /.test(C.windowScript(77)));
  assert(/\[IntPtr\]1, 0, 0, 0, 0, 0x4013/.test(C.sendToBackScript('100')), 'HWND_BOTTOM + без активации');
  assert(!/SetForegroundWindow\(\[IntPtr\]\[long\]/.test(C.sendToBackScript('100')) && /SetForegroundWindow\(\[IntPtr\]\[long\]55\)/.test(C.sendToBackScript('100', '55')), 'фокус возвращаем, только если знаем кому');
  assert(!/SetForegroundWindow\(\[IntPtr\]\[long\]/.test(C.sendToBackScript('100', '100')), 'тому же окну не возвращаем');
  assert(/Contains\('a''b'\)/.test(C.staleKillScript(5, "a'b")), 'кавычки в маркере удвоены');
  assert.strictEqual(Buffer.from(C.encodePs('A'), 'base64').toString('utf16le'), 'A');
  assert.deepStrictEqual(C.parseWindow('394018|Minecraft* 26.1 - Multiplayer (3rd-party Server)\r\n'), { hwnd: '394018', title: 'Minecraft* 26.1 - Multiplayer (3rd-party Server)' });
  assert.strictEqual(C.parseWindow(''), null); assert.strictEqual(C.parseWindow('0|x'), null); assert.strictEqual(C.parseWindow(null), null);
  assert(C.titleInGame('Minecraft* 26.1 - Multiplayer (3rd-party Server)') && !C.titleInGame('Minecraft* 26.1'));
}

// ---------- присмотр за процессом ----------
function fakeChild() {
  const h = {};
  return { pid: 1000 + Math.floor(Math.random() * 1000), killed: false, on(ev, f) { h[ev] = f; }, kill() { this.killed = true; setImmediate(() => h.exit && h.exit(1, null)); }, emit(ev, ...a) { h[ev] && h[ev](...a); } };
}
function testSupervisor() {
  let t = 1000000; const now = () => t; const kids = []; let okBuild = true; const logs = [];
  const sup = new C.ClientSupervisor({ spawn: () => { const c = fakeChild(); kids.push(c); return c; }, build: () => okBuild ? { ok: true, java: 'j', args: [] } : { ok: false, missing: ['нет jar'] }, now, log: m => logs.push(m) });
  // тела нет — не запускаем
  sup.update(t, null); assert.strictEqual(kids.length, 0); assert.strictEqual(sup.status(t).state, 'off');
  sup.update(t, false); assert.strictEqual(kids.length, 0, 'тело есть, мухи нет');
  // муха в мире — запускаем один раз
  sup.update(t, true); sup.update(t, true); assert.strictEqual(kids.length, 1); assert(sup.running && sup.pid === kids[0].pid);
  assert.strictEqual(sup.status(t).state, 'running');
  // муха пропала меньше чем на 2 минуты — клиент живёт
  t += 100000; sup.update(t, false); assert(!kids[0].killed);
  // вернулась — счётчик сбросился
  t += 1000; sup.update(t, true);
  t += 110000; sup.update(t, null); assert(!kids[0].killed, 'после возвращения отсчёт заново');
  t += 11000; sup.update(t, null); assert(kids[0].killed, 'дольше 2 минут без мухи — гасим');
  return new Promise(r => setImmediate(r)).then(() => {
    assert(!sup.running); assert.strictEqual(sup.crashes, 0, 'гашение — не падение'); assert.strictEqual(sup.status(t).state, 'off');
    sup.update(t, null); assert.strictEqual(kids.length, 1, 'без мухи не запускаем');
    // муха вернулась — сразу запускаем (пауз после ручного гашения нет)
    sup.update(t, true); assert.strictEqual(kids.length, 2);
    // падение: пауза 30 с, потом 60, 120, ... не больше 5 минут
    const pauses = [];
    for (let i = 0; i < 7; i++) {
      const c = kids[kids.length - 1];
      c.emit('exit', 1, null);
      assert(!sup.running);
      const st = sup.status(t); pauses.push(st.nextStartInSec); assert.strictEqual(st.state, 'waiting');
      const n = kids.length;
      t += st.nextStartInSec * 1000 - 1000; sup.update(t, true); assert.strictEqual(kids.length, n, 'до конца паузы не запускаем');
      t += 1000; sup.update(t, true); assert.strictEqual(kids.length, n + 1, 'после паузы запустили');
    }
    assert.deepStrictEqual(pauses, [30, 60, 120, 240, 300, 300, 300]);
    // долго проработал — пауза сбрасывается
    t += 6 * 60 * 1000; kids[kids.length - 1].emit('exit', 1, null);
    assert.strictEqual(sup.status(t).nextStartInSec, 30);
    // ошибка сборки (нет файла): пауза, честная ошибка, не падаем
    t += 31000; okBuild = false; const n = kids.length; sup.update(t, true);
    assert.strictEqual(kids.length, n); assert(/нет jar/.test(sup.status(t).lastError), sup.status(t).lastError);
    assert.strictEqual(sup.status(t).state, 'waiting');
    okBuild = true; t += 3 * 60 * 1000; sup.update(t, true); assert.strictEqual(kids.length, n + 1, 'после починки запустился');
    // ошибка spawn не валит присмотр
    const s2 = new C.ClientSupervisor({ spawn: () => { throw new Error('ENOENT'); }, build: () => ({ ok: true }), now });
    s2.update(t, true); assert(/ENOENT/.test(s2.status(t).lastError)); assert(!s2.running);
    // 'error' процесса
    const s3 = new C.ClientSupervisor({ spawn: () => { const c = fakeChild(); kids.push(c); return c; }, build: () => ({ ok: true }), now });
    s3.update(t, true); kids[kids.length - 1].emit('error', new Error('boom')); assert(!s3.running); assert.strictEqual(s3.crashes, 1);
  });
}

// ---------- муха не реагирует на наблюдателя ----------
function testObserverIgnored() {
  assert(U.isObserver('FlyEyes') && U.isObserver('flyeyes') && U.isObserver({ username: 'FlyEyes' }) && U.isObserver({ name: 'FLYEYES' }));
  assert(!U.isObserver('FlyBot_01') && !U.isObserver('eblanitus228') && !U.isObserver(null) && !U.isObserver(''));
  assert(U.mentionsObserver('FlyEyes joined the game') && U.mentionsObserver('FlyEyes left the game') && !U.mentionsObserver('Steve joined the game') && !U.mentionsObserver('FlyEyesTwo joined'));

  const threats = require('../lib/threats'), perception = require('../lib/perception'), AG = require('../lib/aggressors'), locator = require('../lib/locator');
  const me = new Vec3(0, 64, 0);
  const mk = (id, username, pos, extra = {}) => ({ id, type: 'player', username, name: 'player', position: pos, yaw: 0, ...extra });
  const eyes = mk(2, 'FlyEyes', new Vec3(0, 64, 0)), steve = mk(3, 'Steve', new Vec3(5, 64, 0));
  const bot = {
    username: 'FlyBot_01', entity: { id: 1, type: 'player', username: 'FlyBot_01', position: me, yaw: 0 },
    entities: { 2: eyes, 3: steve },
    players: { FlyBot_01: { username: 'FlyBot_01' }, FlyEyes: { username: 'FlyEyes', entity: eyes, gamemode: 0 }, Steve: { username: 'Steve', entity: steve, gamemode: 0 } },
    health: 20
  };
  const ctx = { bot, killers: { FlyEyes: { kills: 5 }, Steve: { kills: 1 } }, aggressors: { flyeyes: { name: 'FlyEyes', lastHit: Date.now(), hits: 3 }, steve: { name: 'Steve', lastHit: Date.now(), hits: 1 } } };
  // угрозы: даже если ник попал в killers/aggressors, наблюдатель не угроза
  assert.strictEqual(threats.isThreat(ctx, 'FlyEyes'), null);
  assert(threats.isThreat(ctx, 'Steve'), 'контроль: обычный убийца — угроза');
  assert.deepStrictEqual(threats.list(ctx).map(x => x.name), ['Steve']);
  // соседи
  const near = perception.entitiesNear(bot, 24);
  assert.deepStrictEqual(near.players.map(p => p.name.toLowerCase()), ['steve'], 'в соседях только Steve');
  // обидчик по взмаху руки
  const swings = new Map([[2, Date.now()], [3, Date.now()]]);
  assert.strictEqual(AG.guessAttacker(bot, swings) === null || AG.guessAttacker(bot, swings).username !== 'FlyEyes', true);
  eyes.position = new Vec3(0.5, 64, 0); eyes.yaw = Math.PI / 2;   // стоит вплотную и «смотрит» на муху
  const g = AG.guessAttacker(bot, new Map([[2, Date.now()]])); assert.strictEqual(g, null, 'взмах наблюдателя — не удар');
  assert.strictEqual(AG.isAggressorEntity(ctx, eyes), false); assert.strictEqual(AG.isAggressorEntity(ctx, steve), true, 'контроль');
  // панель локатора
  assert.deepStrictEqual(locator.playersOnBar(ctx).map(p => p.name), ['Steve']);
}

(async () => {
  testUuid(); testRules(); testArgs(); testVersion(); testJava(); testBuild(); testOptions(); testDatapack(); testCapture();
  await testSupervisor(); testObserverIgnored();
  console.log('eyes_client: ok');
})().catch(e => { console.error(e); process.exit(1); });
