// Разбор 2-го мира этапа 2: бегун мухи сделал из своей истории копию старого hc_night_mine (hc_night_mine_v1, «из истории …»)
// без починки туннеля, и муха брала её в 2/3 ночей. Проверка: настоящий brain/runner.js с RUNNER_NO_VERSIONS=1 (так его зовёт hardcore/fly.js)
// версий из истории не делает, снимков в историю не пишет, а уже сделанную копию навыка стенда не показывает и не запускает.
// Без RUNNER_NO_VERSIONS — как раньше (копия из истории — версия). Тело не нужно (BODY_URL — закрытый порт).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const skill = (name, body) => `module.exports = {\n  name: '${name}',\n  description: 'проверочный ${name}',\n  params: {},\n  async run(api, params) { ${body} }\n};\n`;
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

async function withRunner(env, fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-runner-'));
  const L = path.join(data, 'learned'), H = path.join(L, '.history');
  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(path.join(L, 'hc_tunnel.js'), skill('hc_tunnel', "return { ok: true, v: 'fixed' };"));
  fs.writeFileSync(path.join(L, 'hc_tunnel_v1.js'), '// версия: из истории 20261105105144-031; отличие: см. код, не описано\n' + skill('hc_tunnel', "return { ok: true, v: 'old' };"));
  fs.writeFileSync(path.join(L, 'hc_tunnel_v2.js'), '// версия: ручная, для ночи\n' + skill('hc_tunnel', "return { ok: true, v: 'hand' };"));
  fs.writeFileSync(path.join(H, 'hc_tunnel.20261105000000-000.js'), skill('hc_tunnel', "return { ok: true, v: 'older' };"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'brain', 'runner.js')], { env: { ...process.env, RUNNER_PORT: String(port), RUNNER_DATA: data, BODY_URL: 'http://127.0.0.1:1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await req(port, 'GET', '/log')).json) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    await fn({ port, L, H, out: () => out });
  } finally { child.kill(); try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) {} }
}

(async () => {
  // стенд: копий из истории нет, ручная версия — есть, история не растёт
  await withRunner({ RUNNER_NO_VERSIONS: '1' }, async ({ port, L, H, out }) => {
    const r = await req(port, 'GET', '/skills');
    const names = r.json.skills.map(s => s.name);
    assert.deepStrictEqual(names, ['hc_tunnel', 'hc_tunnel_v2'], 'копия из истории не видна: ' + names.join() + '\n' + out());
    assert.deepStrictEqual(r.json.hiddenCopies, ['hc_tunnel_v1']);
    assert(!fs.existsSync(path.join(L, 'hc_tunnel_v3.js')), 'версий из истории бегун на стенде не делает: ' + fs.readdirSync(L).join());
    assert(fs.existsSync(path.join(L, 'hc_tunnel_v1.js')), 'файл копии не трогаем (его может звать идущий мир)');
    const run = await req(port, 'POST', '/run', { name: 'hc_tunnel_v1', params: {} });
    assert.strictEqual(run.status, 404, 'копию из истории не запускаем: ' + run.text);
    const ok = await req(port, 'POST', '/run', { name: 'hc_tunnel', params: {}, wait: true });
    assert(ok.status === 200, 'починенный навык запускается: ' + ok.text);
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(fs.readdirSync(H).length, 1, 'снимков в историю на стенде нет: ' + fs.readdirSync(H).join());
    console.log('стенд: копия из истории не видна и не запускается, версий из истории нет: OK');
  });
  // вне стенда — как раньше: история становится версией
  await withRunner({ RUNNER_NO_VERSIONS: '' }, async ({ port, L }) => {
    const r = await req(port, 'GET', '/skills');
    assert(r.json.skills.some(s => s.name === 'hc_tunnel_v1'), 'вне стенда копия — обычная версия');
    assert(fs.existsSync(path.join(L, 'hc_tunnel_v3.js')), 'вне стенда история раскладывается по версиям: ' + fs.readdirSync(L).join());
    console.log('вне стенда версии из истории — как раньше: OK');
  });
  console.log('hardcore_runner_copies: ok');
})().catch(e => { console.error(e); process.exit(1); });
