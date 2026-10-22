// Офлайн-проверка пути к правке ядра (lib/core_requests.js): разбор brain/core_requests.md, «Разрешить» из аудита,
// взятие только разрешённого, снимок файлов, итог по тестам (новое падение — откат правки, старые падения — не повод),
// «ничего не изменил», лимит модели. Всё на временной папке, тесты подменены — настоящие файлы и тесты не трогаются.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/core_requests');
const A = require('../audit/server');

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corereq-'));
  for (const d of ['data', 'brain', 'lib', 'test']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'bot.js'), '// тело\n');
  fs.writeFileSync(path.join(root, 'lib', 'blackbox.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'brain', 'core_requests.md'),
    '# Заявки на датчики\nшапка\n\n## [2026-10-22] Ящик смерти: кадры теряются\nчто: кольцо сбрасывается\n\nПОВТОР: ещё раз\n\n## [2026-10-22] от мозга: не видно сундука\nтекст\n');
  return root;
}

function run() {
  const root = mk();
  let now = Date.UTC(2026, 9, 22, 12, 0, 0);
  let tests = { ok: true, results: [{ file: 'test/a.js', ok: true }, { file: 'test/b.js', ok: false, tail: 'старая беда' }] };
  const cfg = { root, now: () => now, runTests: () => tests };
  // разбор: два запроса, ПОВТОР — внутри первого; id стабилен
  let l = C.list(cfg);
  assert.strictEqual(l.items.length, 2);
  assert(/ПОВТОР/.test(l.items[0].text) && l.items[0].status === 'new');
  assert.strictEqual(l.items[0].id, C.idOf('## [2026-10-22] Ящик смерти: кадры теряются'));
  // неразрешённые не берутся
  assert.deepStrictEqual(C.take(cfg), { none: true });
  assert(!C.approve(cfg, 'ffffffffff').ok, 'нет такого');
  const [r1, r2] = l.items;
  assert(C.approve(cfg, r1.id).ok);
  // берётся разрешённый: задание, снимок
  let t = C.take(cfg);
  assert.strictEqual(t.id, r1.id);
  const task = fs.readFileSync(path.join(root, t.taskFile), 'utf8');
  assert(/кольцо сбрасывается/.test(task) && /test\/b\.js/.test(task), 'в задании текст запроса и что падало до правки');
  assert.deepStrictEqual(C.take(cfg), { busy: true }, 'один за раз');
  assert(!C.approve(cfg, r1.id).ok, 'в работе — не разрешить заново');
  // инженер сломал тест, который проходил: откат его правки и честная запись
  fs.writeFileSync(path.join(root, 'lib', 'blackbox.js'), 'сломано\n');
  fs.writeFileSync(path.join(root, 'lib', 'new.js'), 'новый\n');
  tests = { ok: false, results: [{ file: 'test/a.js', ok: false, tail: 'AssertionError: кадров 0' }, { file: 'test/b.js', ok: false, tail: 'старая беда' }] };
  let f = C.finish(cfg, r1.id, 'ok');
  assert.strictEqual(f.status, 'reverted'); assert.deepStrictEqual(f.worse, ['test/a.js']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'lib', 'blackbox.js'), 'utf8'), 'module.exports = 1;\n', 'правка откачена');
  assert(!fs.existsSync(path.join(root, 'lib', 'new.js')), 'новый файл убран');
  const res = fs.readFileSync(path.join(root, 'data', 'core_tasks', r1.id + '.result.md'), 'utf8');
  assert(/test\/a\.js/.test(res) && /кадров 0/.test(res), 'запись почему');
  l = C.list(cfg); assert.strictEqual(l.items[0].status, 'reverted');
  // разрешили снова: правка без новых падений (старая беда test/b.js — не повод) — остаётся
  assert(C.approve(cfg, r1.id).ok);
  tests = { ok: true, results: [{ file: 'test/a.js', ok: true }, { file: 'test/b.js', ok: false, tail: 'старая беда' }] };
  t = C.take(cfg); assert.strictEqual(t.id, r1.id);
  fs.writeFileSync(path.join(root, 'lib', 'blackbox.js'), 'module.exports = 2;\n');
  f = C.finish(cfg, r1.id, 'ok');
  assert.strictEqual(f.status, 'done');
  assert.strictEqual(fs.readFileSync(path.join(root, 'lib', 'blackbox.js'), 'utf8'), 'module.exports = 2;\n');
  assert(/lib\/blackbox\.js/.test(C.list(cfg).items[0].note));
  // второй: лимит модели без правки — снова ждёт инженера; потом инженер ничего не изменил — «не сделано»
  assert(C.approve(cfg, r2.id).ok);
  t = C.take(cfg); assert.strictEqual(t.id, r2.id);
  assert.strictEqual(C.finish(cfg, r2.id, 'limit').status, 'approved');
  t = C.take(cfg); assert.strictEqual(t.id, r2.id);
  fs.writeFileSync(path.join(root, 'data', 'core_tasks', r2.id + '.done.md'), '# не готово: нужно поле в снимке\n');
  f = C.finish(cfg, r2.id, 'ok');
  assert.strictEqual(f.status, 'failed'); assert(/ничего не изменил/.test(C.list(cfg).items[1].note) && /нужно поле/.test(C.list(cfg).items[1].note));
  // сторож перезапущен посреди правки: правка проверяется тестами, не теряется
  assert(C.approve(cfg, r2.id).ok); C.take(cfg);
  fs.writeFileSync(path.join(root, 'bot.js'), '// тело 2\n');
  const rel = C.release(cfg);
  assert.deepStrictEqual(rel.released, [r2.id]); assert.deepStrictEqual(rel.results, ['done']);
  // снимок не заходит в data/ и выученные навыки
  fs.mkdirSync(path.join(root, 'brain', 'learned'), { recursive: true }); fs.writeFileSync(path.join(root, 'brain', 'learned', 'x.js'), '1');
  fs.writeFileSync(path.join(root, 'data', 'y.js'), '1');
  const w = C.walk(root);
  assert(w.includes('bot.js') && w.includes('lib/blackbox.js') && !w.some(x => /learned|^data\//.test(x)));
  console.log('core requests: OK');
  return root;
}

async function audit(root) {
  const cfg = { ...A.DEFAULTS, root, dataDir: path.join(root, 'data'), brainDir: path.join(root, 'brain'), bodyUrl: 'http://127.0.0.1:9', runnerUrl: 'http://127.0.0.1:9' };
  const d = await A.api(cfg, 'core_requests', new URLSearchParams());
  assert(d.ok && d.items.length === 2 && d.items[0].status === 'done' && /изменено/.test(d.items[0].result || ''));
  // кнопка «Разрешить»: POST /api/core_requests/approve
  const server = A.createServer({ ...cfg, port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (body, headers) => new Promise((res, rej) => {
    const req = require('http').request({ host: '127.0.0.1', port, path: '/api/core_requests/approve', method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) } }, r => {
      let s = ''; r.on('data', c => s += c); r.on('end', () => res({ status: r.statusCode, json: JSON.parse(s) }));
    });
    req.on('error', rej); req.end(JSON.stringify(body));
  });
  try {
    let r = await post({ id: d.items[1].id });
    assert.strictEqual(r.status, 200); assert(r.json.ok);
    assert.strictEqual(C.list({ root }).items[1].status, 'approved');
    r = await post({ id: 'плохой' }); assert.strictEqual(r.status, 400);
    r = await post({ id: d.items[1].id }, { Origin: 'http://evil.example' }); assert.strictEqual(r.status, 403);
  } finally { server.close(); }
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit', 'index.html'), 'utf8');
  assert(/data-approve/.test(html) && /\/api\/core_requests\/approve/.test(html));
  console.log('core requests audit: OK');
}

module.exports = async function () { const root = run(); await audit(root); };
if (require.main === module) module.exports().then(() => console.log('core_requests: all OK'), e => { console.error(e); process.exit(1); });
