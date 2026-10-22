// Офлайн-проверка версий выученных навыков: brain/versions.js (имена, строка «// версия:», вытаскивание из .history без дублей,
// сжатый каталог для мозга) и настоящий brain/runner.js на временной папке (RUNNER_DATA) и свободном порту: запуск по имени версии,
// свой счёт у каждой версии, автовыключение только версии, /catalog, /rollback не теряет код. Тело не нужно (BODY_URL — закрытый порт).
// Запуск: node test/versions.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const V = require('../brain/versions');

const ROOT = path.join(__dirname, '..');
const skill = (name, body, extra = '') => `${extra}module.exports = {\n  name: '${name}',\n  description: 'проверочный ${name}',\n  params: {},\n  async run(api, params) { ${body} }\n};\n`;

function testUnit() {
  assert.deepStrictEqual(V.parseName('build_hut_v12'), { base: 'build_hut', n: 12 });
  assert.deepStrictEqual(V.parseName('build_hut'), { base: 'build_hut', n: 0 });
  assert.deepStrictEqual(V.parseName('go_v'), { base: 'go_v', n: 0 });
  assert.strictEqual(V.noteOf('// версия: для ночи\nmodule.exports={}'), 'для ночи');
  assert.strictEqual(V.noteOf('// другое\n// версия: нет'), null, 'строка версии — только первая');
  assert.strictEqual(V.stripNote('// версия: x\r\nкод'), 'код');
  assert.strictEqual(V.codeHash('// версия: a\nкод\n'), V.codeHash('код\r\n'), 'строка версии и CRLF на сравнение не влияют');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versions-'));
  const hist = path.join(dir, '.history'); fs.mkdirSync(hist);
  const cur = skill('hut', "return { ok: true, v: 'cur' };");
  const old = skill('hut', "return { ok: false, error: 'старая' };");
  fs.writeFileSync(path.join(dir, 'hut.js'), '// версия: текущая\n' + cur);
  fs.writeFileSync(path.join(hist, 'hut.20261020000000-000.js'), old);
  fs.writeFileSync(path.join(hist, 'hut.20261020000001-000.js'), old.replace(/\n/g, '\r\n'));   // тот же код
  fs.writeFileSync(path.join(hist, 'hut.20261021000000-000.js'), cur);                           // = текущая
  fs.writeFileSync(path.join(hist, 'hut.20261021000001-000.js'), 'module.exports = { сломано');   // не проходит проверку
  fs.writeFileSync(path.join(hist, 'other.txt'), 'не версия');
  const made = V.importHistory(dir);
  assert.deepStrictEqual(made.map(m => m.name), ['hut_v1', 'hut_v2'], JSON.stringify(made));
  assert(/^\/\/ версия: из истории 20261020000000-000; отличие: см\. код, не описано\n/.test(fs.readFileSync(path.join(dir, 'hut_v1.js'), 'utf8')));
  assert.strictEqual(fs.readdirSync(hist).length, 5, '.history не тронута');
  assert.deepStrictEqual(V.importHistory(dir), [], 'второй раз — ничего');
  assert.strictEqual(V.nextName(dir, 'hut'), 'hut_v3');
  // правка версии на месте тоже становится новой версией
  fs.writeFileSync(path.join(hist, 'hut_v1.20261022000000-000.js'), skill('hut', 'return 1;'));
  assert.deepStrictEqual(V.importHistory(dir).map(m => m.name), ['hut_v3']);
  assert.strictEqual(V.keepAsVersion(dir, 'hut', cur, 'x'), null, 'такой код уже есть');
  assert.strictEqual(V.keepAsVersion(dir, 'hut', cur, 'x', 'hut'), 'hut_v4', 'кроме самого файла — нет');

  const g = V.group([
    { name: 'hut', description: 'хижина', params: { x: 'x' }, valid: true, enabled: true, stats: { runs: 10, ok: 2, fail: 8 }, note: 'текущая' },
    { name: 'hut_v1', description: 'хижина', params: { x: 'x' }, valid: true, enabled: true, stats: { runs: 10, ok: 9, fail: 1 }, note: 'старая' },
    { name: 'hut_v2', description: null, params: null, valid: false, enabled: true, stats: { runs: 0, ok: 0, fail: 0 }, note: null },
    { name: 'hut_v3', description: 'хижина', params: {}, valid: true, enabled: false, stats: { runs: 3, ok: 3, fail: 0 }, note: 'выкл' },
    { name: 'wall', description: 'стена', params: {}, valid: true, enabled: true, stats: { runs: 0, ok: 0, fail: 0 }, note: null }
  ]);
  assert.deepStrictEqual(g.map(x => x.base), ['hut', 'wall']);
  assert.deepStrictEqual(g[0].versions.map(v => v.name), ['hut_v1', 'hut', 'hut_v3'], 'лучшие сверху, выключенные внизу');
  assert.deepStrictEqual(g[0].broken.map(v => v.name), ['hut_v2']);
  assert.strictEqual(g[0].next, 'hut_v4');
  const text = V.catalogText(g);
  assert(/рабочих версий: 4, не проходят проверку: 1/.test(text), text);
  assert(/\n {2}hut_v1 9\/10 — старая\n/.test(text) && /hut_v3 3\/3 \[выкл\] — выкл/.test(text), text);
  assert(!/\n {2}hut_v2 /.test(text) && /не проходят проверку: hut_v2/.test(text), 'сломанная версия не показана как готовая');
  assert(/wall 0\/0 — единственная версия/.test(text));
  assert(/новая версия будет: hut_v4/.test(V.catalogText(g, { full: true })));
  console.log('versions unit: OK');
}

// ---------- настоящий runner.js ----------
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let t = ''; res.setEncoding('utf8'); res.on('data', c => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, text: t, json }); });
    });
    r.on('error', reject); r.setTimeout(30000, () => r.destroy(new Error('тайм-аут запроса ' + p)));
    if (data) r.write(data); r.end();
  });
}

async function testRunner() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  const L = path.join(data, 'learned'), H = path.join(L, '.history');
  fs.mkdirSync(H, { recursive: true });
  const cur = skill('hut', "return { ok: true, v: 'cur' };");
  fs.writeFileSync(path.join(L, 'hut.js'), '// версия: текущая\n' + cur);
  fs.writeFileSync(path.join(L, 'wall.js'), skill('wall', 'return { ok: true };'));
  fs.writeFileSync(path.join(H, 'hut.20261020000000-000.js'), skill('hut', "return { ok: false, error: 'старая ломается' };"));
  fs.writeFileSync(path.join(H, 'hut.20261021000000-000.js'), cur);
  fs.writeFileSync(path.join(H, 'hut.20261021000001-000.js'), 'module.exports = { сломано');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'brain', 'runner.js')], { env: { ...process.env, RUNNER_PORT: String(port), RUNNER_DATA: data, BODY_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req(port, 'GET', '/log')).json) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    // при старте история уже разложена по версиям (копия: .history цела)
    assert(fs.existsSync(path.join(L, 'hut_v1.js')) && fs.existsSync(path.join(L, 'hut_v2.js')) && !fs.existsSync(path.join(L, 'hut_v3.js')), fs.readdirSync(L).join() + '\n' + out);
    assert.strictEqual(fs.readdirSync(H).length, 3);
    let r = await req(port, 'GET', '/skills');
    const by = n => r.json.skills.find(s => s.name === n);
    assert.deepStrictEqual(r.json.skills.map(s => s.name), ['hut', 'hut_v1', 'hut_v2', 'wall']);
    assert(by('hut_v1').valid && by('hut_v1').base === 'hut' && by('hut_v1').version === 1 && /из истории/.test(by('hut_v1').note), 'name hut в файле hut_v1.js допустим');
    assert.strictEqual(by('hut_v2').valid, false, 'сломанная версия помечена');
    assert.strictEqual(by('hut').note, 'текущая');

    // запуск по имени версии, свой счёт; 3 провала подряд выключают только эту версию
    for (let i = 1; i <= 3; i++) {
      r = await req(port, 'POST', '/run', { name: 'hut_v1' });
      assert.strictEqual(r.json.ok, false); assert(/старая ломается/.test(r.json.error));
      assert.strictEqual(!!r.json.autoDisabled, i === 3);
    }
    assert(/версия "hut_v1" выключена/.test(r.json.note) && /catalog\?name=hut/.test(r.json.note), r.json.note);
    r = await req(port, 'POST', '/run', { name: 'hut' });
    assert.strictEqual(r.json.ok, true, 'другая версия того же навыка работает: ' + JSON.stringify(r.json));
    r = await req(port, 'GET', '/go?name=hut_v1');
    assert(r.json.ok === false && /выключена/.test(r.json.error) && /catalog/.test(r.json.error), r.text);
    const st = JSON.parse(fs.readFileSync(path.join(data, 'skills_stats.json'), 'utf8'));
    assert.strictEqual(st.hut_v1.runs, 3); assert.strictEqual(st.hut_v1.fail, 3); assert.strictEqual(st.hut_v1.enabled, false);
    assert.strictEqual(st.hut.runs, 1); assert.strictEqual(st.hut.ok, 1); assert.notStrictEqual(st.hut.enabled, false);

    // каталог для мозга
    r = await req(port, 'GET', '/catalog');
    assert.strictEqual(r.status, 200);
    assert(/\nhut — проверочный hut\n {2}hut 1\/1 — текущая\n {2}hut_v1 0\/3 \[выкл\] — из истории/.test(r.text), r.text);
    assert(/не проходят проверку: hut_v2/.test(r.text) && !/\n {2}hut_v2 /.test(r.text));
    assert(/wall 0\/0 — единственная версия/.test(r.text));
    r = await req(port, 'GET', '/catalog?name=hut_v1');
    assert(/новая версия будет: hut_v3/.test(r.text) && !/wall/.test(r.text), r.text);
    assert.strictEqual((await req(port, 'GET', '/catalog?name=nope')).status, 404);
    r = await req(port, 'GET', '/catalog?format=json');
    assert.deepStrictEqual(r.json.skills.find(s => s.base === 'hut').versions.map(v => v.name), ['hut', 'hut_v1']);

    // правка на месте + /check + /rollback: ни один код не пропадает
    fs.writeFileSync(path.join(L, 'hut.js'), skill('hut', "return { ok: true, v: 'правка на месте' };"));
    r = await req(port, 'POST', '/check', { name: 'hut' });
    assert(r.json.ok && r.json.savedVersion, r.text);
    r = await req(port, 'POST', '/rollback', { name: 'hut' });
    assert(r.json.ok, r.text);
    const all = fs.readdirSync(L).filter(f => /^hut(_v\d+)?\.js$/.test(f)).map(f => fs.readFileSync(path.join(L, f), 'utf8'));
    assert(all.some(s => /правка на месте/.test(s)), 'отменённая правка осталась версией: ' + fs.readdirSync(L).join());
    assert(all.some(s => /'cur'/.test(s)) && all.some(s => /старая ломается/.test(s)));
    assert(/доступны по своим именам/.test(r.json.note));
    console.log('versions runner: OK');
  } finally { child.kill(); }
}

module.exports = async function () { testUnit(); await testRunner(); };
if (require.main === module) module.exports().then(() => { console.log('versions: OK'); process.exit(0); }, e => { console.error(e); process.exit(1); });
