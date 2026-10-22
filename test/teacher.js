// Офлайн-проверка учителя: очередь и склейка случаев (lib/teacher_triggers.js), простой стройки (progress_idle) как главный случай,
// вкладка «Учитель» программы «Аудит» на фальшивых данных, права ролей. Без тела и без моделей.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/teacher_triggers');
const A = require('../audit/server');

function mkdirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-'));
  const dataDir = path.join(root, 'data'), brainDir = path.join(root, 'brain');
  fs.mkdirSync(path.join(dataDir, 'blackbox'), { recursive: true }); fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'events.log'), '{"id":1,"t":"10:00:00","type":"info"}\n');
  fs.writeFileSync(path.join(brainDir, 'runner.log'), '');
  return { root, dataDir, brainDir };
}
const hms = ms => new Date(ms).toISOString().slice(11, 19);

function testQueue() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 21, 12, 0, 0);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now, neighborDir: null };
  const ev = (o) => fs.appendFileSync(path.join(D.dataDir, 'events.log'), JSON.stringify({ t: hms(now), ...o }) + '\n');
  const run = (o) => fs.appendFileSync(path.join(D.brainDir, 'runner.log'), JSON.stringify({ time: new Date(now).toISOString(), ...o }) + '\n');
  const bb = (name, summary) => fs.writeFileSync(path.join(D.dataDir, 'blackbox', name), JSON.stringify({ kind: name.split('-')[0], savedAt: new Date(now).toISOString(), summary, frames: [{}] }));
  const st = () => T.loadState(T.paths(cfg));

  // старая смерть до первого запуска — не разбираем; разовых задач (migrate) больше нет — очередь пуста
  bb('death-20261021-110000.json', { cause: 'zombie' });
  let r = T.scan(cfg); assert(r.init);
  assert.deepStrictEqual(st().cases.map(c => c.type), [], 'первый запуск — пустая очередь');
  assert(T.take(cfg).none);
  fs.mkdirSync(path.join(D.dataDir, 'teacher'), { recursive: true });

  // всплеск: смерть в ящике + событие death + провал дважды подряд -> ОДИН случай типа death
  bb('death-20261021-120000.json', { cause: 'drowning', lastTask: { name: 'goto', by: 'brain' }, worst: { kind: 'air', ttdSec: 2 } });
  ev({ id: 10, type: 'death', cause: 'drowning', message: 'FlyTest drowned' });
  ev({ id: 11, type: 'task_failed', name: 'collect', reason: 'не нашёл log в радиусе 48 (добыто 0/5)', by: 'autopilot' });
  now += 20000;
  ev({ id: 12, type: 'task_failed', name: 'collect', reason: 'не нашёл log в радиусе 32 (добыто 1/5)', by: 'autopilot' });
  T.scan(cfg);
  let pend = st().cases.filter(c => c.status === 'pending');
  assert.strictEqual(pend.length, 1, 'склейка всплеска');
  assert.strictEqual(pend[0].type, 'death');
  assert.strictEqual(pend[0].items.length, 3, 'ящик + death + провал дважды: ' + JSON.stringify(pend[0].items.map(i => i.kind)));
  assert(pend[0].items.some(i => i.ref === 'data/blackbox/death-20261021-120000.json' && i.by === 'brain'));
  assert(pend[0].items.some(i => /events\.log #12/.test(i.ref) && i.kind === 'fail'));
  // ещё не тихо — не берём; через 90 с тишины — берём
  now += 30000; T.scan(cfg); assert(T.take(cfg).none, 'ждём тишины');
  now += 70000; T.scan(cfg);
  r = T.take(cfg); assert.strictEqual(r.type, 'death');
  assert(fs.existsSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json')));
  assert.deepStrictEqual(T.take(cfg), { busy: r.id }, 'один учитель за раз');
  // лимит запросов модели: случай обратно в очередь без штрафа; release — после перезапуска сторожа
  assert.strictEqual(T.finish(cfg, r.id, 'limit').status, 'pending', 'limit — обратно в очередь');
  assert.strictEqual(T.take(cfg).id, r.id, 'тот же случай снова');
  assert.deepStrictEqual(T.release(cfg).released, [r.id]);
  r = T.take(cfg); assert.strictEqual(r.type, 'death', 'после release снова берётся');
  const mat = JSON.parse(fs.readFileSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json'), 'utf8'));
  assert(mat.eventsTail.length >= 3 && /^data\/teacher\/.+-death\.md$/.test(mat.report));
  // учитель пишет отчёт -> разобран; провал collect уходит в паузу
  fs.writeFileSync(path.join(D.dataDir, 'teacher', path.basename(mat.report)), '# смерть: утонула\nВердикт: 1 — решал мозг\n');
  assert.strictEqual(T.finish(cfg, r.id, 'ok').status, 'done');

  // тот же провал снова (после разбора, в паузе) — не новый случай
  now += 60000;
  ev({ id: 13, type: 'task_failed', name: 'collect', reason: 'не нашёл log в радиусе 48 (добыто 0/5)' });
  ev({ id: 14, type: 'task_failed', name: 'collect', reason: 'не нашёл log в радиусе 48 (добыто 0/5)' });
  T.scan(cfg);
  assert.strictEqual(st().cases.filter(c => c.status === 'pending').length, 0, 'пауза после разбора');
  assert(st().suppressed >= 1);
  // разные ошибки подряд — не «дважды одно и то же»; успех сбрасывает счёт
  ev({ id: 15, type: 'task_failed', name: 'craft', reason: 'не хватает: stick' });
  ev({ id: 16, type: 'task_done', name: 'craft' });
  ev({ id: 17, type: 'task_failed', name: 'craft', reason: 'не хватает: stick' });
  ev({ id: 18, type: 'task_failed', name: 'craft', reason: 'нет верстака' });
  T.scan(cfg);
  assert.strictEqual(st().cases.filter(c => c.status === 'pending').length, 0, 'разные ошибки не склеиваются в провал');

  // выученный навык (версия): случай с первого же провала — повод заказать другой вариант; второй провал рядом — в тот же случай
  now += 10 * 60000;
  run({ id: 1, type: 'run_end', name: 'build_hut', ok: false, error: 'нет места у -397 66 29' });
  T.scan(cfg);
  pend = st().cases.filter(c => c.status === 'pending');
  assert.strictEqual(pend.length, 1, 'один провал версии — уже случай'); assert.strictEqual(pend[0].type, 'fail');
  run({ id: 2, type: 'run_end', name: 'build_hut', ok: false, error: 'нет места у -390 66 30' });
  T.scan(cfg);
  pend = st().cases.filter(c => c.status === 'pending');
  assert.strictEqual(pend.length, 1); assert.strictEqual(pend[0].type, 'fail');
  assert.strictEqual(pend[0].items[0].by, 'skill:build_hut');

  // сообщение хозяина (игра и аудит) — отдельный случай, склеивается сам с собой; итог дня случаем больше не заводится
  ev({ id: 20, type: 'chat', from: 'eblanitus228', text: 'ягоды можно сорвать и съесть' });
  ev({ id: 21, type: 'chat', from: 'someone', text: 'привет' });
  ev({ id: 22, type: 'owner_msg', from: 'eblanitus228 (из программы)', text: 'и пей воду' });
  ev({ id: 23, type: 'day_report', day: 41, line: 'День 41: построено 0 блоков' });
  T.scan(cfg);
  pend = st().cases.filter(c => c.status === 'pending');
  assert.deepStrictEqual(pend.map(c => c.type).sort(), ['fail', 'owner'], 'итог дня — не случай');
  assert.strictEqual(pend.find(c => c.type === 'owner').items.length, 2, 'хозяин: две реплики в одном случае, чужие не считаются');
  // порядок взятия: хозяин раньше провала
  now += 100000; T.scan(cfg);
  r = T.take(cfg); assert.strictEqual(r.type, 'owner');
  T.finish(cfg, r.id, 'ok');
  r = T.take(cfg); assert.strictEqual(r.type, 'fail');
  // потерянный учитель (сторож перезапустился) — через 40 мин случай закрывается и не держит очередь
  now += 41 * 60000;
  assert(T.take(cfg).none, 'зависший случай не держит очередь');
  assert(st().cases.some(c => c.status === 'failed' && /потерян/.test(c.result)));

  // застряла: 6 провалов разных задач за 10 мин, ни одного успеха (мелочи вроде eat не в счёт)
  now += 60 * 60000;
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((n, i) => { ev({ id: 30 + i, type: 'task_failed', name: 'goto_' + n, reason: 'путь не найден ' + n }); if (i === 2) ev({ id: 99, type: 'task_done', name: 'eat' }); });
  T.scan(cfg);
  pend = st().cases.filter(c => c.status === 'pending');
  assert(pend.some(c => c.keys.includes('stuck')), 'застряла');
  // повторный всплеск через 2 мин склеивается с тем же случаем, а не плодит новый
  now += 2 * 60000;
  ['g', 'h', 'i', 'j', 'k', 'l'].forEach((n, i) => ev({ id: 40 + i, type: 'task_failed', name: 'goto_' + n, reason: 'x' }));
  T.scan(cfg);
  assert.strictEqual(st().cases.filter(c => c.status === 'pending').length, 1, 'всплеск застревания — один случай');

  // обрезанный журнал и мусорные строки не ломают сторожа
  fs.writeFileSync(path.join(D.dataDir, 'events.log'), 'не json\n{"id":1,"t":"bad","type":"death"}\n');
  assert(T.scan(cfg).ok);
  // CLI отвечает одной ASCII-строкой JSON
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'lib', 'teacher_triggers.js'), 'nope']).toString();
  assert(/^[\x20-\x7e]+\n$/.test(out) && JSON.parse(out).ok === false, 'CLI ASCII');
  console.log('teacher queue: OK');
  return D;
}

// сосед: новый или изменённый файл навыка в его папке — случай «новое у соседа»; без изменений — тихо; папки нет — тихо
function testNeighbor() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 22, 12, 0, 0);
  const nb = path.join(D.root, 'neighbor');
  fs.mkdirSync(path.join(nb, 'lib', 'skills'), { recursive: true }); fs.mkdirSync(path.join(nb, 'behavior'), { recursive: true });
  fs.writeFileSync(path.join(nb, 'lib', 'skills', 'combat.js'), '// бой\n');
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now, neighborDir: nb };
  const st = () => T.loadState(T.paths(cfg));
  T.scan(cfg);                                    // первый запуск: пустая очередь
  T.scan(cfg);
  let nbc = st().cases.filter(c => c.type === 'neighbor');
  assert.strictEqual(nbc.length, 1, 'первый взгляд на соседа — случай'); assert(/combat/.test(nbc[0].items[0].text));
  T.scan(cfg);
  assert.strictEqual(st().cases.filter(c => c.type === 'neighbor')[0].items.length, 1, 'без изменений — ничего нового');
  fs.writeFileSync(path.join(nb, 'behavior', 'mission.js'), '// миссия\n');
  T.scan(cfg);
  nbc = st().cases.filter(c => c.type === 'neighbor');
  assert.strictEqual(nbc.length, 1); assert(nbc[0].items.some(i => /mission/.test(i.text)), 'новый файл соседа — в тот же ожидающий случай');
  const D2 = mkdirs();
  const cfg2 = { dataDir: D2.dataDir, brainDir: D2.brainDir, now: () => now, neighborDir: path.join(D2.root, 'нет') };
  T.scan(cfg2); T.scan(cfg2);
  assert(!T.loadState(T.paths(cfg2)).cases.some(c => c.type === 'neighbor'), 'нет папки соседа — молча');
  console.log('teacher neighbor: OK');
}

function testHelpers() {
  assert.strictEqual(T.norm('не нашёл log в радиусе 48 (добыто 0/5)'), T.norm('Не нашёл log в радиусе 32 (добыто 1/5)'));
  const now = Date.UTC(2026, 9, 21, 0, 5, 0);
  assert.strictEqual(T.eventTime('00:04:00', now), now - 60000);
  assert.strictEqual(T.eventTime('23:59:00', now), Date.UTC(2026, 9, 20, 23, 59, 0), 'вчера');
}

// простой стройки (progress_idle) — главный случай: порог, приоритет выше смерти, свой cooldown
function testIdle() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 22, 12, 0, 0);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now, neighborDir: null };
  const ev = (o) => fs.appendFileSync(path.join(D.dataDir, 'events.log'), JSON.stringify({ t: hms(now), ...o }) + '\n');
  const st = () => T.loadState(T.paths(cfg));
  const idle = () => st().cases.filter(c => c.type === 'idle' && c.status === 'pending');
  T.scan(cfg);
  ev({ id: 2, type: 'progress_idle', min: 20 }); T.scan(cfg);
  assert.strictEqual(idle().length, 0, 'простой меньше порога — не случай');
  ev({ id: 3, type: 'progress_idle', min: T.DEFAULTS.IDLE_MIN }); T.scan(cfg);
  assert.strictEqual(idle().length, 1, 'простой от порога — случай'); assert(/30 мин/.test(idle()[0].items[0].text));
  // пока ждёт — следующая отметка в тот же случай
  now += 10 * 60000; ev({ id: 4, type: 'progress_idle', min: 40 }); T.scan(cfg);
  assert.strictEqual(idle().length, 1); assert.strictEqual(idle()[0].items.length, 2);
  // смерть рядом — отдельный случай (не склеивается с простоем), но простой берётся первым
  ev({ id: 5, type: 'death', cause: 'zombie' }); T.scan(cfg);
  assert.strictEqual(st().cases.filter(c => c.status === 'pending').length, 2);
  now += 100000; T.scan(cfg);
  const r = T.take(cfg); assert.strictEqual(r.type, 'idle', 'простой важнее смерти');
  fs.mkdirSync(path.join(D.dataDir, 'teacher'), { recursive: true });
  const rep = path.join(D.dataDir, 'teacher', r.id + '-idle.md');
  fs.writeFileSync(rep, '# простой\n'); fs.utimesSync(rep, new Date(now), new Date(now));
  assert.strictEqual(T.finish(cfg, r.id, 'ok').status, 'done');
  // в cooldown (60 мин) новый простой не заводится
  now += 10 * 60000; ev({ id: 6, type: 'progress_idle', min: 50 }); T.scan(cfg);
  assert.strictEqual(idle().length, 0, 'повтор в cooldown подавляется'); assert(st().suppressed >= 1);
  // чужой cooldown (застревание, провал) на простой не влияет; после часа — снова случай
  now += 61 * 60000; const s0 = st(); s0.cooldown.stuck = now + 3600000; s0.cooldown['fail:x:y'] = now + 3600000; fs.writeFileSync(T.paths(cfg).state, JSON.stringify(s0));
  ev({ id: 7, type: 'progress_idle', min: 120 }); T.scan(cfg);
  assert.strictEqual(idle().length, 1, 'после cooldown — снова случай');
  console.log('teacher idle: OK');
}

async function testAudit(D) {
  fs.writeFileSync(path.join(D.brainDir, 'core_requests.md'), '# Заявки на датчики\n## [2026-10-21] не видно глубину воды\n');
  const cfg = { ...A.DEFAULTS, dataDir: D.dataDir, brainDir: D.brainDir, bodyUrl: 'http://127.0.0.1:9', runnerUrl: 'http://127.0.0.1:9' };
  const d = await A.api(cfg, 'teacher', new URLSearchParams());
  assert(d.queue.exists && d.cases.length >= 4);
  assert(d.cases.some(c => c.status === 'done' && c.typeRu === 'смерть'));
  assert(d.cases.some(c => c.status === 'failed' && c.statusRu === 'не вышло'));
  assert(!('lessons' in d) && !('book' in d) && !('lessonsError' in d), 'учебника и журнала уроков во вкладке больше нет');
  assert(/глубину/.test(d.coreRequests));
  assert.strictEqual(d.reports.length, 1); assert(/утонула/.test(d.reports[0].title) && /решал мозг/.test(d.reports[0].verdict));
  // отчёт и журнал учителя; чужие пути не читаются
  const id = d.reports[0].name.replace(/-[a-z]+\.md$/, '');
  fs.writeFileSync(path.join(D.dataDir, 'teacher-' + id + '.log'), 'разбираю ящик\n');
  const rep = await A.api(cfg, 'teacher_report', new URLSearchParams({ name: d.reports[0].name }));
  assert(rep.ok && /Вердикт/.test(rep.text) && rep.logMtime);
  for (const bad of ['../brain/notes.md', '..\\x.md', 'a/b.md', 'x.txt', '']) assert(!(await A.api(cfg, 'teacher_report', new URLSearchParams({ name: bad }))).ok, 'плохое имя ' + bad);
  // пустая папка (сторож ещё не запускался) — без падения
  const E = mkdirs();
  const e = await A.api({ ...cfg, dataDir: E.dataDir, brainDir: E.brainDir }, 'teacher', new URLSearchParams());
  assert(!e.queue.exists && e.cases.length === 0 && e.reports.length === 0);
  // страница знает вкладку
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit', 'index.html'), 'utf8');
  assert(/\['teacher', 'Учитель'\]/.test(html) && /id="p-teacher"/.test(html) && /\/api\/teacher_report/.test(html));
  console.log('audit teacher: OK');
}

async function testConfigs() {
  const root = path.join(__dirname, '..');
  const tc = JSON.parse(fs.readFileSync(path.join(root, 'brain', 'opencode.teacher.json'), 'utf8'));
  assert(!('model' in tc), 'модель учителя — в data/models.json, сторож передаёт её флагом -m; в конфиге она не задаётся');
  const allowEdit = Object.keys(tc.permission.edit).filter(k => tc.permission.edit[k] === 'allow');
  for (const k of allowEdit) assert(/(brain\/core_requests\.md|brain\/skill_requests\/\*|data\/teacher\/\*)$/.test(k), 'учителю лишнее: ' + k);
  assert.strictEqual(tc.permission.edit['*'], 'deny'); assert.strictEqual(tc.permission.webfetch, 'deny'); assert.strictEqual(tc.permission.bash['*'], 'deny');
  for (const k of ['*/do*', '*/cmd*', '*/go*', '*/run*', '* -d*', '* -X*']) assert.strictEqual(tc.permission.bash[k], 'deny', k);
  // мозг — архитектор: пишет только блокнот, чертежи и ready.flag; заявки (ядро, навыки) пишет учитель; телу команд не отдаёт
  const bc = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
  for (const k of Object.keys(bc.permission.edit)) if (bc.permission.edit[k] === 'allow') {
    assert(!/lessons|behavior|teacher/.test(k), 'мозгу лишнее: ' + k);
    assert(/(brain\/notes\.md|brain\/blueprints\/\*|brain\/ready\.flag)$/.test(k), 'мозгу лишнее: ' + k);
  }
  assert.notStrictEqual(bc.permission.edit['brain/core_requests.md'], 'allow', 'запросы на правку ядра пишет учитель, не мозг');
  assert.strictEqual(bc.permission.bash['*'], 'deny');
  assert(!('curl *' in bc.permission.bash) && !('curl.exe *' in bc.permission.bash), 'мозгу — только чтение, без любого curl');
  for (const k of ['*/do*', '*/cmd*', '*/go*', '*/run*', '* -d*', '* -X*']) assert.strictEqual(bc.permission.bash[k], 'deny', 'мозгу: ' + k);
  // как opencode: шаблон — glob (* — что угодно, ? — один знак), побеждает последнее совпадение
  const perm = (rules, cmd) => { let res = null; for (const [pat, act] of Object.entries(rules)) { const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's'); if (re.test(cmd)) res = act; } return res; };
  for (const c of ['curl.exe -s http://127.0.0.1:3199/snapshot', 'curl.exe -s http://127.0.0.1:3199/wait?timeout=240', 'curl.exe -s http://127.0.0.1:3199/events?limit=40',
    'curl.exe -s http://127.0.0.1:3199/autopilot', 'curl.exe -s http://127.0.0.1:3200/catalog?name=build_hut', 'curl.exe -s "http://127.0.0.1:3200/log"', 'curl.exe -s http://127.0.0.1:3199/memory?kind=iron_ore'])
    assert.strictEqual(perm(bc.permission.bash, c), 'allow', 'мозгу можно: ' + c);
  for (const c of ['curl.exe -s http://127.0.0.1:3199/do?action=chat', 'curl.exe -s http://127.0.0.1:3200/go?name=build_hut', 'curl.exe -s http://127.0.0.1:3199/autopilot?on=0',
    'curl.exe -s -X POST http://127.0.0.1:3199/cmd', 'curl.exe -s http://127.0.0.1:3200/run -d @x.json', 'curl.exe -s -H "Content-Type: application/json" http://127.0.0.1:3200/disable',
    'curl.exe -s http://127.0.0.1:3199/behavior/rollback', 'curl.exe -s http://127.0.0.1:3200/abort', 'curl.exe -s http://127.0.0.1:3099/showcase', 'curl.exe -s http://example.com/', 'curl.exe -s http://127.0.0.1:3199/snapshot > f'])
    assert.notStrictEqual(perm(bc.permission.bash, c), 'allow', 'мозгу нельзя: ' + c);
  // правка ядра по разрешённому запросу: всё, кроме судьи
  const cc = JSON.parse(fs.readFileSync(path.join(root, 'brain', 'opencode.core.json'), 'utf8'));
  assert.strictEqual(cc.permission.edit['lib/referee.js'], 'deny'); assert.strictEqual(cc.permission.edit['*/lib/referee.js'], 'deny');
  assert.strictEqual(bc.permission.edit['*'], 'deny');
}

module.exports = async function () {
  testHelpers();
  const D = testQueue();
  testNeighbor();
  testIdle();
  await testAudit(D);
  await testConfigs();
};
if (require.main === module) module.exports().then(() => console.log('teacher: all OK'), e => { console.error(e); process.exit(1); });
