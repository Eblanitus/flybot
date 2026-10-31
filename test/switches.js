// Офлайн-проверка пульта: lib/switches.js (умолчания, битый файл, запись, CLI), проводка выключателей в night.cmd, brain_guard.ps1,
// bot.js, tools/eyes.js, tools/body_autorestart.js (по текстам) и API пульта в аудите на временной папке данных. Ничего не запускает.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const S = require('../lib/switches');

const ROOT = path.join(__dirname, '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ALL_ON = { body: true, brain: true, teacher: true, engineer: true, eyes: true };

function testLib(dir) {
  // нет файла — всё включено
  assert.deepStrictEqual(S.read(dir), ALL_ON);
  assert.strictEqual(S.isOn('teacher', dir), true);
  assert.strictEqual(S.changedAt(dir), null);
  assert.throws(() => S.isOn('nose', dir));
  // битый файл, массив, мусор в полях — всё включено; выключено только явное false
  const f = S.filePath(dir);
  fs.writeFileSync(f, '{ это не json');
  assert.deepStrictEqual(S.read(dir), ALL_ON);
  fs.writeFileSync(f, '[false]');
  assert.deepStrictEqual(S.read(dir), ALL_ON);
  fs.writeFileSync(f, '\ufeff{"brain":false,"teacher":"off","eyes":0,"engineer":null}');
  assert.deepStrictEqual(S.read(dir), { ...ALL_ON, brain: false }, 'BOM не мешает; строки и числа в файле — не выключатель');
  // запись: частичная правка не трогает остальное, без временных файлов, с отметкой времени
  fs.rmSync(f);
  let r = S.save({ teacher: false, engineer: 'off' }, dir);
  assert(r.ok, r.error);
  assert.deepStrictEqual(r.switches, { ...ALL_ON, teacher: false, engineer: false });
  assert.deepStrictEqual(S.read(dir), r.switches);
  assert(S.changedAt(dir) > Date.now() - 60000);
  assert(!fs.readdirSync(dir).some(n => /\.tmp/.test(n)), 'временный файл убран');
  r = S.save({ teacher: true }, dir);
  assert.deepStrictEqual(r.switches, { ...ALL_ON, engineer: false });
  // ошибки — файл не меняется
  const before = fs.readFileSync(f, 'utf8');
  for (const bad of [null, [], {}, { nose: false }, { body: 'может быть' }, { body: false, nose: true }, 'нет_такого']) assert(!S.save(bad, dir).ok, JSON.stringify(bad));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
  // наборы
  assert.deepStrictEqual(S.save('body_eyes', dir).switches, { body: true, brain: false, teacher: false, engineer: false, eyes: true });
  assert.deepStrictEqual(S.save('all_off', dir).switches, { body: false, brain: false, teacher: false, engineer: false, eyes: false });
  assert.deepStrictEqual(S.save('all_on', dir).switches, ALL_ON);
}

function testCli(dir) {
  const run = (...a) => { const p = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'switches.js'), ...a, '--dir', dir], { encoding: 'utf8' }); return { code: p.status, out: String(p.stdout).trim() }; };
  fs.rmSync(S.filePath(dir), { force: true });
  assert.deepStrictEqual(run('get', 'brain'), { code: 0, out: 'on' }, 'нет файла — on');
  assert.deepStrictEqual(run('set', 'brain', 'off'), { code: 0, out: 'off' });
  assert.deepStrictEqual(run('get', 'brain'), { code: 0, out: 'off' });
  assert.deepStrictEqual(run('get', 'teacher'), { code: 0, out: 'on' });
  fs.writeFileSync(S.filePath(dir), 'мусор');
  assert.deepStrictEqual(run('get', 'brain'), { code: 0, out: 'on' }, 'битый файл — on');
  assert.strictEqual(run('get', 'nose').code, 2);
  assert.strictEqual(run('set', 'brain', 'может').code, 2);
  assert.deepStrictEqual(JSON.parse(run('show').out), ALL_ON);
}

// Проводка: вызов opencode стоит под выключателем
function testWiring() {
  // night.cmd: мозг
  const night = rd('night.cmd');
  const loop = night.indexOf(':loop'), call = night.indexOf('call opencode run');
  assert(loop > 0 && call > loop);
  const checks = [...night.matchAll(/'node "%~dp0lib\\switches\.js" get brain 2\^>nul'\) do set BRAIN_SW=%%s\r?\nif \/i "%BRAIN_SW%"=="off" \(/g)].map(m => m.index);
  assert(checks.length >= 2, 'night.cmd проверяет выключатель мозга (в начале петли и перед сессией)');
  assert(checks.every(i => i > loop && i < call), 'проверки — внутри петли и до вызова opencode');
  const last = night.slice(checks[checks.length - 1], call);
  assert(/goto loop/.test(last) && !/opencode run/.test(last), 'выключено — назад в петлю, мимо opencode');
  assert(!/brain_wake\.js/.test(last), 'между последней проверкой и opencode ничего не ждём');
  assert.strictEqual((night.match(/opencode run/g) || []).length, 1, 'opencode в night.cmd зовётся в одном месте');
  assert(night.indexOf('get brain 2^>nul\') do set BRAIN_SW') < night.indexOf('node "%~dp0tools\\brain_wake.js"'),'выключенный мозг не ждёт повода (повод не съедается)');
  assert(/set BRAIN_SW=on/.test(night), 'сбой node — включено, как раньше');

  // brain_guard.ps1: учитель, инженер, помощник
  const g = rd('brain_guard.ps1');
  assert(/function SwitchOn\(\[string\]\$part\)/.test(g) && /lib\\switches\.js" get \$part/.test(g));
  const wl = g.indexOf('while ($true)');
  const sw = g.indexOf("$engOn = SwitchOn 'engineer'; $tchOn = SwitchOn 'teacher'");
  assert(sw > wl, 'пульт читается в цикле сторожа');
  // каждый запуск opencode — в блоке, условие которого содержит нужный выключатель
  const blockCond = idx => { const i = g.lastIndexOf('\n  if (', idx); return g.slice(i, g.indexOf('{', i)); };
  const starts = [...g.matchAll(/opencode run/g)].map(m => m.index);
  assert(starts.length === 3, 'opencode у сторожа: правка ядра, учитель, StartSkill');
  const core = g.indexOf("$c = Core @('take')"), teach = g.indexOf("$c = Teach @('take')");
  assert(core > sw && /\$engOn -and/.test(blockCond(core)), 'правку ядра берёт только включённый инженер');
  assert(teach > sw && /\$tchOn -and/.test(blockCond(teach)), 'случай берёт только включённый учитель');
  const pickE = g.indexOf('$name = PickReq $false'), pickH = g.indexOf('$name = PickReq $true');
  assert(/\$engOn -and/.test(blockCond(pickE)), 'заявку навыка берёт только включённый инженер');
  assert(/\$tchOn -and \$engOn -and/.test(blockCond(pickH)), 'помощник (модель учителя на заявке) — только когда включены оба');
  // StartSkill зовётся только из этих двух мест
  assert.strictEqual((g.match(/= StartSkill /g) || []).length, 2);
  // сканирование и бухгалтерия — без выключателя
  const scan = g.indexOf("$s = Teach @('scan')");
  assert(scan > sw && !/\$tchOn/.test(g.slice(g.lastIndexOf('\n', scan), scan)), 'scan идёт и при выключенном учителе');

  // тело
  const bot = rd('bot.js');
  assert(/require\('\.\/lib\/switches'\)/.test(bot) && /switches\.isOn\('body', DATA_DIR\)/.test(bot));
  assert(/ctx\.paused = true;[^\n]*link\.stop\(\)/.test(bot) && /ctx\.paused = false;[^\n]*link\.start\(\)/.test(bot), 'выкл — выйти, вкл — зайти');
  assert(/if \(!ctx\.paused\) link\.start\(\)/.test(bot) && /setInterval\(checkSwitch, \d+\)/.test(bot), 'при старте выключенное тело не заходит');
  assert(/'\/health'[^\n]*paused: !!ctx\.paused/.test(bot), '/health говорит, что тело на паузе');
  assert(/isOn\('body', DATA\)\) return/.test(rd('tools/body_autorestart.js')), 'автоперезапуск не трогает выключенное тело');
  // глаза
  const eyes = rd('tools/eyes.js');
  assert(/switches\.isOn\('eyes', DATA\)/.test(eyes) && /stopAll\(\); dropLive\(\)/.test(eyes), 'глаза закрывают всё своими stop-функциями');
  assert(/if \(checkSwitch\(now\)\) \{ publish\(false\); return; \}/.test(eyes), 'выключенные глаза ничего не поднимают, но статус пишут');
}

function request(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(headers || {}) };
    const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => s += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    rq.on('error', reject); if (data) rq.write(data); rq.end();
  });
}
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

async function testApi(dir) {
  const A = require('../audit/server');
  // разбор процессов
  const lp = A.parseLoopProcs([
    '10\tcmd.exe\tC:\\WINDOWS\\system32\\cmd.exe /c ""C:\\Users\\user\\flybot\\night.cmd" "',
    '11\tcmd.exe\tcmd /c "C:\\Users\\user\\flybot\\data\\night-20261029-101010.cmd"',
    '12\tcmd.exe\tC:\\WINDOWS\\system32\\cmd.exe /c ""C:\\Users\\user\\flybot\\eyes.cmd" "',
    '13\tnode.exe\tnode "C:\\Users\\user\\flybot\\tools\\eyes.js"',
    '14\tnode.exe\tnode tools\\eyes.js --probe',
    '15\tnode.exe\tnode  bot.js localhost 25565 FlyBot_01 3199',
    '16\tcmd.exe\tcmd /c "cd /d C:\\flybot\\ && node bot.js localhost 25565 FlyBot_01 3199"'
  ].join('\r\n'));
  assert.deepStrictEqual(lp, { night: [10, 11], eyes: [12, 13], body: [15] });

  const data = path.join(dir, 'data'), brain = path.join(dir, 'brain');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(brain, 'skill_requests'), { recursive: true });
  // поддельное тело: /health с paused (или без — «старое тело»)
  let health = { ready: true, paused: false, connected: true };
  const body = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/health') ? health : { ok: false })); });
  const bport = await listen(body);
  let loops = { night: [77], eyes: [], body: [1] }, running = [], guards = [{ pid: 5 }];
  const launched = [];
  const audit = A.createServer({ port: 0, root: dir, dataDir: data, brainDir: brain, bodyUrl: 'http://127.0.0.1:' + bport, runnerUrl: 'http://127.0.0.1:1',
    loopProcs: async () => loops, runningModels: async () => running, guardProcs: async () => guards, launch: (cmd, what) => launched.push({ cmd, what }) });
  const port = await listen(audit);
  const rowOf = (d, p) => d.rows.find(r => r.part === p);
  try {
    // всё включено, глаз не было: глаза «не запущен» с кнопкой
    let d = (await request(port, 'GET', '/api/switches')).json;
    assert.deepStrictEqual(d.switches, ALL_ON);
    assert.strictEqual(rowOf(d, 'body').state, 'on');
    assert.strictEqual(rowOf(d, 'brain').state, 'on'); assert(/ждёт повода/.test(rowOf(d, 'brain').what));
    assert.strictEqual(rowOf(d, 'teacher').state, 'on');
    assert.strictEqual(rowOf(d, 'eyes').state, 'down'); assert.strictEqual(rowOf(d, 'eyes').start, 'eyes');

    // набор «только тело и глаза»; учитель ещё работает — «выключается, доделывает»
    running = [{ pid: 9, role: 'teacher', model: 'opencode/m1' }];
    let r = await request(port, 'POST', '/api/switches', { preset: 'body_eyes' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(S.read(data), { body: true, brain: false, teacher: false, engineer: false, eyes: true });
    d = r.json.pult;
    assert.strictEqual(rowOf(d, 'teacher').state, 'stopping');
    assert.strictEqual(rowOf(d, 'engineer').state, 'off');
    assert.strictEqual(rowOf(d, 'brain').state, 'off');
    // лампы: в сводке есть выключатели
    const sum = (await request(port, 'GET', '/api/summary')).json;
    assert.deepStrictEqual(sum.switches, S.read(data));

    // тело: выключили — старое тело (без paused) «выключается» с подсказкой, новое на паузе — «выключено»
    r = await request(port, 'POST', '/api/switches', { set: { body: false } });
    assert(r.json.ok);
    health = { ready: true, connected: true };
    d = (await request(port, 'GET', '/api/switches')).json;
    assert.strictEqual(rowOf(d, 'body').state, 'stopping'); assert(/перезапуска тела/.test(rowOf(d, 'body').note));
    health = { ready: false, paused: true, connected: false };
    d = (await request(port, 'GET', '/api/switches')).json;
    assert.strictEqual(rowOf(d, 'body').state, 'off');

    // глаза: свежий статус state=off при выключенных глазах — «выключено»
    await request(port, 'POST', '/api/switches', { set: { eyes: false } });
    fs.writeFileSync(path.join(data, 'eyes_status.json'), JSON.stringify({ state: 'off', updated: new Date().toISOString() }));
    loops = { night: [77], eyes: [12], body: [1] };
    d = (await request(port, 'GET', '/api/switches')).json;
    assert.strictEqual(rowOf(d, 'eyes').state, 'off');

    // «Запустить»: только незапущенное; сторож умер при живой петле — поднимаем сторожа к ней
    r = await request(port, 'POST', '/api/switches', { start: 'eyes' });
    assert.strictEqual(r.status, 400, 'глаза запущены — запускать нечего');
    guards = []; running = [];
    r = await request(port, 'POST', '/api/switches', { start: 'teacher' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(launched.length, 1); assert.strictEqual(launched[0].what, 'guard');
    assert(/brain_guard\.ps1" -Log ".*night\.log" -LoopPid 77$/.test(launched[0].cmd), launched[0].cmd);
    // петли нет — мозг «не запущен», кнопка — night.cmd
    loops = { night: [], eyes: [], body: [] };
    fs.rmSync(path.join(data, 'eyes_status.json'));
    d = (await request(port, 'GET', '/api/switches')).json;
    assert.strictEqual(rowOf(d, 'brain').state, 'down'); assert.strictEqual(rowOf(d, 'brain').start, 'night');
    r = await request(port, 'POST', '/api/switches', { start: 'brain' });
    assert(r.json.ok && /^start "" ".*night\.cmd"$/.test(r.json.cmd), r.json.cmd);
    r = await request(port, 'POST', '/api/switches', { start: 'eyes' });
    assert(r.json.ok && /eyes\.cmd"$/.test(r.json.cmd));
    // тело не отвечает — кнопка запускает bot.js
    body.close();
    d = (await request(port, 'GET', '/api/switches')).json;
    assert.strictEqual(rowOf(d, 'body').state, 'down');
    r = await request(port, 'POST', '/api/switches', { start: 'body' });
    assert(r.json.ok && /node bot\.js localhost 25565 FlyBot_01 3199/.test(r.json.cmd));
    assert.strictEqual(launched.length, 4);

    // защита и ошибки
    assert.strictEqual((await request(port, 'POST', '/api/switches', { set: { body: true } }, { Origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await request(port, 'POST', '/api/switches', 'body=1', { 'Content-Type': 'text/plain' })).status, 415);
    assert.strictEqual((await request(port, 'POST', '/api/switches', { set: { nose: false } })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/api/switches', { preset: 'всё_сразу' })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/api/switches', { start: 'nose' })).status, 400);
    assert.strictEqual((await request(port, 'POST', '/api/switches', '{битый')).status, 400);
    assert.strictEqual(launched.length, 4, 'ошибочные запросы ничего не запускают');
    assert((await request(port, 'POST', '/api/switches', { set: { body: true } }, { Origin: 'http://127.0.0.1:3300' })).json.ok);
  } finally { audit.close(); try { body.close(); } catch (e) {} }

  // страница: вкладка «Пульт» первой, лампы знают про выключатели, остальные вкладки на месте
  const html = rd('audit/index.html');
  assert(/const TABS = \[\['pult', 'Пульт'\], \['console', 'Консоль ролей'\]/.test(html));
  assert(/id="p-pult"/.test(html) && /pult: \['\/api\/switches', renderPult\]/.test(html));
  assert(/\['ledger', 'Бухгалтерия'\]/.test(html) && /Глаза: /.test(html), 'бухгалтерия и лампа «Глаза» сохранены');
  assert(/data-preset="all_off"/.test(html) && /data-preset="body_eyes"/.test(html) && /data-preset="all_on"/.test(html));
  assert(/SW\.body === false/.test(html) && /SW\.eyes === false/.test(html) && /SW\[r\] === false/.test(html), 'выключенная часть — серая лампа');
}

module.exports = async function testSwitches() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switches-test-'));
  try {
    testLib(dir);
    testCli(dir);
    testWiring();
    await testApi(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('switches: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
