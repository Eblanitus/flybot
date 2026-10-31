// Офлайн-проверка бухгалтерии учителя (lib/teacher_ledger.js) и её связки с очередью (lib/teacher_triggers.js):
// разбор строк «Проводка», таяние, порог по загрузке инженера, выставление счёта, ПОВТОР, оплата → наблюдение → «не помогло» → закрытие,
// устаревание заявки (маркер .stale.md и сторож её не берёт), хозяин мимо порога, битый json. Время подставное.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../lib/teacher_ledger');
const T = require('../lib/teacher_triggers');

const H = 3600 * 1000;
function mkdirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const dataDir = path.join(root, 'data'), brainDir = path.join(root, 'brain');
  fs.mkdirSync(path.join(dataDir, 'blackbox'), { recursive: true }); fs.mkdirSync(path.join(dataDir, 'teacher'), { recursive: true });
  fs.mkdirSync(path.join(brainDir, 'skill_requests'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'events.log'), '{"id":1,"t":"10:00:00","type":"info"}\n');
  fs.writeFileSync(path.join(brainDir, 'runner.log'), '');
  return { root, dataDir, brainDir, req: path.join(brainDir, 'skill_requests') };
}
const touch = (f, ms, text) => { if (text != null) fs.writeFileSync(f, text); fs.utimesSync(f, new Date(ms), new Date(ms)); };

function testParse() {
  const L = B.DEFAULTS;
  let p = B.parsePostings('# смерть\nПроводка: shelter_ledge | Укрытие у обрыва | behavior | 40 | падение events.log #12\nмусор', { type: 'death' });
  assert.deepStrictEqual(p, [{ slug: 'shelter_ledge', title: 'Укрытие у обрыва', kind: 'behavior', min: 40, ev: 'падение events.log #12' }]);
  // минуты сверх потолка — потолок; нет минут — по умолчанию для типа
  assert.strictEqual(B.parsePostings('Проводка: a_b | x | skill | 500 | #1', { type: 'death' })[0].min, L.PRICE.death.max);
  assert.strictEqual(B.parsePostings('Проводка: a_b | x | skill | #1', { type: 'death' })[0].min, 30);
  assert.strictEqual(B.parsePostings('Проводка: a_b | x | skill | 9 | #1', { type: 'fail' })[0].min, 3, 'провал — до 3');
  assert.strictEqual(B.parsePostings('Проводка: a_b | x | skill | | #1', { type: 'fail' })[0].min, 2);
  // простой: по умолчанию — длительность из события, потолок 120
  const idle = { type: 'idle', items: [{ text: 'простой: муха не строит уже 30 мин подряд' }, { text: 'простой: муха не строит уже 50 мин подряд' }] };
  assert.strictEqual(B.parsePostings('Проводка: idle_x | ждёт | behavior | — | #5', idle)[0].min, 50);
  assert.strictEqual(B.parsePostings('Проводка: idle_x | ждёт | behavior | 300 мин | #5', idle)[0].min, 120);
  assert.strictEqual(B.parsePostings('Проводка: s | x | 99', { type: 'stuck' }).length, 0, 'slug из одной буквы — мусор');
  assert.strictEqual(B.parsePostings('Проводка: stuck_x | x | 99', { type: 'stuck' })[0].min, 30);
  assert.strictEqual(B.parsePostings('Проводка: near_x | x | 40', { type: 'near' })[0].min, 15);
  // неизвестный вид — поле уходит в текст, вид не задан; русские названия видов понимаются
  p = B.parsePostings('Проводка: dig_wall | Копает стену | хрень | 2 | #7', { type: 'fail' })[0];
  assert.strictEqual(p.kind, null); assert.strictEqual(p.title, 'Копает стену'); assert(/хрень/.test(p.ev) || /#7/.test(p.ev));
  assert.strictEqual(B.parsePostings('- **Проводка:** box_lost | Ящик | ядро | 5 | #3', { type: 'death' })[0].kind, 'core');
  // лишние поля — в доказательство; мусор и кириллица в slug — мимо; больше двух строк — две; одинаковый slug — один раз
  p = B.parsePostings('Проводка: a_b | t | skill | 5 | #1 | ещё | и ещё', { type: 'death' })[0];
  assert(/#1/.test(p.ev) && /и ещё/.test(p.ev));
  assert.strictEqual(B.parsePostings('Проводка:\nПроводка: | | |\nПроводка: укрытие | x | 5\nПроводка ничего', { type: 'death' }).length, 0);
  assert.strictEqual(B.parsePostings('Проводка: a_a | x | 5\nПроводка: a_a | y | 6\nПроводка: b_b | x | 5\nПроводка: c_c | x | 5', { type: 'death' }).map(x => x.slug).join(), 'a_a,b_b');
  assert.strictEqual(B.parsePostings('Проводка: Shelter-Ledge | x | 5', { type: 'death' })[0].slug, 'shelter_ledge');
}

function testMath() {
  const now = Date.UTC(2026, 9, 30, 12);
  const acc = { postings: [{ t: now - 24 * H, min: 40 }, { t: now, min: 10 }], resetAt: 0 };
  assert(Math.abs(B.balance(acc, now) - 30) < 1e-9, 'через 24 ч — вдвое');
  assert(Math.abs(B.balance(acc, now + 48 * H) - 7.5) < 1e-9);
  assert.strictEqual(B.balance({ ...acc, resetAt: now - 1 }, now), 10, 'до обнуления не считается');
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map(n => B.threshold(n, false)), [15, 45, 75, 105, null, null]);
  assert.strictEqual(B.threshold(1, true), 22.5, '«переделать» — вдвое ниже');
}

// полный путь через очередь учителя: проводки → счёт → заявка → оплата → «не помогло» → переделать → закрыт
function testFlow() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 30, 12);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now, neighborDir: null };
  const hms = ms => new Date(ms).toISOString().slice(11, 19);
  const ev = o => fs.appendFileSync(path.join(D.dataDir, 'events.log'), JSON.stringify({ t: hms(now), ...o }) + '\n');
  const st = () => T.loadState(T.paths(cfg));
  const led = () => B.load(B.paths(cfg), now);
  const report = (r, text) => touch(path.join(D.dataDir, 'teacher', path.basename(r.report)), now, text);
  T.scan(cfg);
  // старая открытая заявка (до бухгалтерии) — счёт не придумывается, но считается в загрузке
  touch(path.join(D.req, 'old_one.md'), now - 5 * H, '# old_one\n');
  assert.strictEqual(B.status(cfg).load, 1);
  assert.strictEqual(Object.keys(led().accounts).length, 0);

  // смерть: учитель разбирает, в материалах — выписка счетов, «случайность» без заявки допустима
  ev({ id: 2, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  let r = T.take(cfg); assert.strictEqual(r.type, 'death');
  let mat = JSON.parse(fs.readFileSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json'), 'utf8'));
  assert(Array.isArray(mat.accounts) && mat.accounts.length === 0, 'выписка есть (пустая)');
  report(r, '# смерть\nВердикт: случайность\nСделано: ничего\n');
  assert.strictEqual(T.finish(cfg, r.id, 'ok').status, 'done');
  assert.strictEqual(Object.keys(led().accounts).length, 0, 'случайность — без проводок');

  // смерть с проводкой 40 мин: при L=1 порог 45 — счёт копится
  ev({ id: 3, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  r = T.take(cfg);
  report(r, '# смерть\nПроводка: shelter_ledge | Укрытие у обрыва | behavior | 40 | падение events.log #3\n');
  T.finish(cfg, r.id, 'ok');
  let a = led().accounts.shelter_ledge;
  assert.strictEqual(a.status, 'open'); assert.strictEqual(a.postings.length, 1);
  assert(/проводки: shelter_ledge 40/.test(st().cases.find(c => c.id === r.id).result));
  T.scan(cfg);
  assert(!st().cases.some(c => c.type === 'invoice'), '40 < 45 — счёт не выставлен');
  // выписка в следующем случае показывает счёт
  ev({ id: 4, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  r = T.take(cfg);
  mat = JSON.parse(fs.readFileSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json'), 'utf8'));
  assert.strictEqual(mat.accounts[0].slug, 'shelter_ledge'); assert(/#3/.test(mat.accounts[0].evidence[0]));
  report(r, '# смерть\nПроводка: shelter_ledge | Укрытие у обрыва | behavior | 20 | снова обрыв events.log #4\n');
  T.finish(cfg, r.id, 'ok');
  // 60 ≥ 45 — ровно один случай-счёт, раньше обычных случаев
  ev({ id: 5, type: 'death', cause: 'fall' });
  T.scan(cfg); T.scan(cfg);
  let inv = st().cases.filter(c => c.type === 'invoice');
  assert.strictEqual(inv.length, 1, 'счёт выставлен ровно один раз');
  assert.strictEqual(led().accounts.shelter_ledge.status, 'queued');
  assert.strictEqual(B.status(cfg).load, 2, 'счёт в очереди учителя — тоже загрузка');
  now += 100000;
  r = T.take(cfg); assert.strictEqual(r.type, 'invoice', 'счёт раньше смерти');
  mat = JSON.parse(fs.readFileSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json'), 'utf8'));
  assert.strictEqual(mat.account.slug, 'shelter_ledge'); assert.strictEqual(mat.account.postings.length, 2); assert(/-invoice\.md$/.test(mat.report));
  assert.strictEqual(mat.account.where, 'brain/skill_requests/behavior_shelter_ledge.md');
  touch(path.join(D.req, 'behavior_shelter_ledge.md'), now, '# behavior_shelter_ledge — от учителя\nСлучай: x\n');
  report(r, '# счёт\nСделано: заявка brain/skill_requests/behavior_shelter_ledge.md\n');
  T.finish(cfg, r.id, 'ok');
  a = led().accounts.shelter_ledge;
  assert.strictEqual(a.status, 'invoiced'); assert.strictEqual(a.request.name, 'behavior_shelter_ledge');
  T.scan(cfg); assert.strictEqual(st().cases.filter(c => c.type === 'invoice').length, 1, 'по счёту с открытой заявкой — нового счёта нет');
  r = T.take(cfg); report(r, '# смерть\nВердикт: случайность\n'); T.finish(cfg, r.id, 'ok');

  // ПОВТОР: L ≥ 4, новая проводка по счёту с открытой заявкой — доказательство дописывается в заявку без модели
  for (const n of ['x1', 'x2']) touch(path.join(D.req, n + '.md'), now, '# ' + n + '\n');
  assert.strictEqual(B.status(cfg).load, 4);
  ev({ id: 6, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  r = T.take(cfg); report(r, 'Проводка: shelter_ledge | Укрытие у обрыва | behavior | 30 | третий обрыв events.log #6\n'); T.finish(cfg, r.id, 'ok');
  // инженер держит заявку — пропускаем
  touch(path.join(D.req, 'behavior_shelter_ledge.working'), now, 'x');
  T.scan(cfg);
  assert(!/ПОВТОР/.test(fs.readFileSync(path.join(D.req, 'behavior_shelter_ledge.md'), 'utf8')), 'в работе — не трогаем');
  fs.unlinkSync(path.join(D.req, 'behavior_shelter_ledge.working'));
  const s1 = T.scan(cfg);
  let txt = fs.readFileSync(path.join(D.req, 'behavior_shelter_ledge.md'), 'utf8');
  assert(/ПОВТОР от бухгалтерии/.test(txt) && /третий обрыв events\.log #6/.test(txt), 'ПОВТОР дописан');
  assert(s1.ledger.some(m => /ПОВТОР/.test(m)), 'сторож видит сообщение');
  T.scan(cfg); assert.strictEqual(fs.readFileSync(path.join(D.req, 'behavior_shelter_ledge.md'), 'utf8').split('ПОВТОР от').length, 2, 'одно и то же второй раз не дописывается');
  for (const n of ['x1', 'x2', 'old_one']) touch(path.join(D.req, n + '.done.md'), now + 1000, '# готово\n');

  // оплата: .done → наблюдение, баланс с нуля
  now += 60000;
  touch(path.join(D.req, 'behavior_shelter_ledge.done.md'), now, '# behavior_shelter_ledge: готово\n');
  T.scan(cfg);
  a = led().accounts.shelter_ledge;
  assert.strictEqual(a.status, 'watching'); assert.strictEqual(B.balance(a, now), 0);
  assert.strictEqual(B.status(cfg).load, 0);
  // новая проводка за 48 ч — «не помогло», следующая заявка — переделать, порог вдвое ниже (L=0: 7.5)
  now += 5 * H;
  ev({ id: 7, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  r = T.take(cfg); report(r, 'Проводка: shelter_ledge | Укрытие у обрыва | behavior | 10 | опять events.log #7\n'); T.finish(cfg, r.id, 'ok');
  a = led().accounts.shelter_ledge;
  assert.strictEqual(a.status, 'open'); assert.strictEqual(a.redo, true); assert.strictEqual(a.history[0].outcome, 'не помогло');
  T.scan(cfg);
  inv = st().cases.filter(c => c.type === 'invoice' && c.status === 'pending');
  assert.strictEqual(inv.length, 1, '10 ≥ 7.5 — счёт на переделку'); assert(/переделать/.test(inv[0].items[0].text));
  r = T.take(cfg);
  mat = JSON.parse(fs.readFileSync(path.join(D.dataDir, 'teacher_cases', r.id + '.json'), 'utf8'));
  assert.strictEqual(mat.account.redo, true); assert.strictEqual(mat.account.redoOf, 'behavior_shelter_ledge.md');
  assert.strictEqual(mat.account.pastRequests[0].outcome, 'не помогло'); assert(/готово/.test(mat.account.pastRequests[0].answer));
  touch(path.join(D.req, 'behavior_shelter_ledge.md'), now, '# behavior_shelter_ledge — переделать\n');
  report(r, 'Сделано: заявка behavior_shelter_ledge.md\n'); T.finish(cfg, r.id, 'ok');
  assert.strictEqual(led().accounts.shelter_ledge.status, 'invoiced');
  now += 60000; touch(path.join(D.req, 'behavior_shelter_ledge.done.md'), now, '# готово\n'); T.scan(cfg);
  assert.strictEqual(led().accounts.shelter_ledge.status, 'watching');
  // 48 ч тишины — закрыт
  now += 47 * H; T.scan(cfg); assert.strictEqual(led().accounts.shelter_ledge.status, 'watching');
  now += 2 * H; T.scan(cfg);
  a = led().accounts.shelter_ledge;
  assert.strictEqual(a.status, 'closed'); assert.strictEqual(a.redo, false); assert.strictEqual(a.history[1].outcome, 'помогло');

  // случай-счёт без заявки (учитель отказался) — счёт снова копится, повтор не раньше чем через 6 ч
  ev({ id: 8, type: 'death', cause: 'fall' }); T.scan(cfg); now += 100000;
  r = T.take(cfg); report(r, 'Проводка: lava_walk | Ходит по лаве | core | 60 | лава events.log #8\n'); T.finish(cfg, r.id, 'ok');
  T.scan(cfg); r = T.take(cfg); assert.strictEqual(r.type, 'invoice');
  report(r, '# счёт\nСделано: ничего — данных мало\n'); T.finish(cfg, r.id, 'ok');
  assert.strictEqual(led().accounts.lava_walk.status, 'open');
  T.scan(cfg); assert(!st().cases.some(c => c.type === 'invoice' && c.status === 'pending'), 'не сразу снова');
  now += 7 * H; T.scan(cfg); r = T.take(cfg); assert.strictEqual(r.type, 'invoice', 'через 6 ч — снова');
  // вид core: запрос в core_requests.md привязывается по новому заголовку
  fs.appendFileSync(path.join(D.brainDir, 'core_requests.md'), '\n## [2026-10-30] Тело не видит лаву под ногами\nдоказательства\n');
  report(r, '# счёт\nСделано: запрос в core_requests.md\n'); T.finish(cfg, r.id, 'ok');
  a = led().accounts.lava_walk;
  assert.strictEqual(a.status, 'invoiced'); assert.strictEqual(a.request.kind, 'core');
  assert.strictEqual(B.status(cfg).load, 0, 'запрос ядра без разрешения хозяина — не загрузка');
  console.log('ledger flow: OK');
  return D;
}

// устаревание: заявка не взята, счёт растаял ниже 5 мин и сутки без проводок — маркер .stale.md, сторож её не берёт
function testStale() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 30, 12);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now };
  const P = B.paths(cfg);
  fs.mkdirSync(D.dataDir, { recursive: true });
  fs.writeFileSync(P.state, JSON.stringify({ version: 1, accounts: { dig_wall: { slug: 'dig_wall', title: 'Копает стену', kind: 'skill', status: 'invoiced', postings: [{ t: now, min: 16, ev: '#1' }], resetAt: 0, redo: false,
    request: { kind: 'skill', name: 'dig_wall', at: now }, invoicedAt: now, repeatedUpTo: now, history: [{ request: 'dig_wall.md', kind: 'skill', name: 'dig_wall', at: now, outcome: 'ждёт инженера' }] } } }));
  touch(path.join(D.req, 'dig_wall.md'), now, '# dig_wall\n');
  now += 24 * H; B.sweep(cfg); assert.strictEqual(B.load(P, now).accounts.dig_wall.status, 'invoiced', '8 мин — ещё рано');
  now += 24 * H; touch(path.join(D.req, 'dig_wall.working'), now, 'x'); B.sweep(cfg);
  assert.strictEqual(B.load(P, now).accounts.dig_wall.status, 'invoiced', 'инженер держит — не снимаем');
  fs.unlinkSync(path.join(D.req, 'dig_wall.working'));
  const r = B.sweep(cfg);
  assert(r.msgs.some(m => /снята/.test(m)));
  assert(fs.existsSync(path.join(D.req, 'dig_wall.stale.md')) && !fs.existsSync(path.join(D.req, 'dig_wall.done.md')), 'маркер, не .done');
  const a = B.load(P, now).accounts.dig_wall;
  assert.strictEqual(a.status, 'closed'); assert.strictEqual(a.history[0].outcome, 'снята: муха справилась сама');
  assert.strictEqual(B.skillReqState(P, 'dig_wall', now), 'stale');
  assert.strictEqual(B.pickable(D.req, 'dig_wall.md'), false, 'сторож не берёт');
  assert.strictEqual(B.pickable(D.req, 'dig_wall.stale.md'), false);
  assert.strictEqual(B.engineerLoad(P, B.load(P, now), now).n, 0);
  // заявку переписали позже — снова открыта
  touch(path.join(D.req, 'dig_wall.md'), now + 5000, '# dig_wall — заново\n');
  assert.strictEqual(B.pickable(D.req, 'dig_wall.md'), true);
  // сторож (PowerShell): то же правило — .stale.md новее заявки пропускается
  const guard = fs.readFileSync(path.join(__dirname, '..', 'brain_guard.ps1'), 'utf8');
  const pick = guard.slice(guard.indexOf('function PickReq'), guard.indexOf('function StartSkill'));
  assert(/\$stale = "\$req\\\$name\.stale\.md"/.test(pick), 'PickReq знает маркер .stale.md');
  assert(/\(Test-Path \$stale\) -and \(Get-Item \$stale\)\.LastWriteTime -ge \$f\.LastWriteTime\) \{ continue \}/.test(pick), 'PickReq пропускает снятые');
  assert(/\.\(done\|stale\)\\\.md\$/.test(pick) || /stale/.test(pick));
  // запрос ядра: снимается в data/core_requests_state.json, инженер его не берёт
  const C = require('../lib/core_requests');
  fs.writeFileSync(path.join(D.brainDir, 'core_requests.md'), '# запросы\n\n## [2026-10-30] Не видно лаву\nтекст\n');
  const id = C.parse(fs.readFileSync(path.join(D.brainDir, 'core_requests.md'), 'utf8'))[0].id;
  const st = B.load(P, now);
  st.accounts.lava = { slug: 'lava', title: 'лава', kind: 'core', status: 'invoiced', postings: [{ t: now, min: 4, ev: '#9' }], resetAt: 0, request: { kind: 'core', id }, invoicedAt: now, history: [] };
  fs.writeFileSync(P.state, JSON.stringify(st));
  now += 25 * H; B.sweep(cfg);
  assert.strictEqual(C.list({ dataDir: D.dataDir, brainDir: D.brainDir }).items[0].status, 'stale');
  assert(C.take({ dataDir: D.dataDir, brainDir: D.brainDir, root: D.root, runTests: () => ({ ok: true, results: [] }) }).none, 'снятый запрос инженер не берёт');
  console.log('ledger stale: OK');
}

// откат/не сделано: заявка откачена тестами (core reverted/failed) или ответ «не готово» — это не «сделано, смотрим 48 ч»:
// счёт снова копится с прежним балансом, повторной заявки сразу нет (пауза INVOICE_RETRY_MS), сообщение честное
function testDead() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 30, 12);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now };
  const P = B.paths(cfg);
  const C = require('../lib/core_requests');
  fs.mkdirSync(D.dataDir, { recursive: true });
  fs.writeFileSync(path.join(D.brainDir, 'core_requests.md'), ['# запросы', '', '## [2026-10-30] Откатили', 'текст', '', '## [2026-10-30] Не вышло', 'текст', ''].join('\n'));
  const ids = C.parse(fs.readFileSync(path.join(D.brainDir, 'core_requests.md'), 'utf8')).map(r => r.id);
  const cst = { version: 1, requests: { [ids[0]]: { status: 'reverted' }, [ids[1]]: { status: 'failed' } } };
  fs.writeFileSync(path.join(D.dataDir, 'core_requests_state.json'), JSON.stringify(cst));
  const mk = (slug, request) => ({ slug, title: slug, kind: request.kind, status: 'invoiced', postings: [{ t: now, min: 40, ev: '#1' }], resetAt: 0, request, invoicedAt: now, repeatedUpTo: now,
    history: [{ request: request.name || 'core', kind: request.kind, name: request.name || null, id: request.id || null, at: now, outcome: 'ждёт инженера' }] });
  const stt = B.load(P, now);
  stt.accounts.core_rev = mk('core_rev', { kind: 'core', id: ids[0] });
  stt.accounts.core_fail = mk('core_fail', { kind: 'core', id: ids[1] });
  stt.accounts.skill_nr = mk('skill_nr', { kind: 'skill', name: 'skill_nr', at: now });
  stt.accounts.skill_ok = mk('skill_ok', { kind: 'skill', name: 'skill_ok', at: now });
  fs.writeFileSync(P.state, JSON.stringify(stt));
  touch(path.join(D.req, 'skill_nr.md'), now - 1000, '# skill_nr\n');
  touch(path.join(D.req, 'skill_nr.done.md'), now, '﻿# skill_nr: не готово\nИнженер не ответил\n');   // как пишет сторож (с BOM)
  touch(path.join(D.req, 'skill_ok.md'), now - 1000, '# skill_ok\n');
  touch(path.join(D.req, 'skill_ok.done.md'), now, '# skill_ok: готово\n');
  assert.strictEqual(B.skillReqState(P, 'skill_nr', now), 'notready'); assert.strictEqual(B.skillReqState(P, 'skill_ok', now), 'done');
  now += 60000;
  const r = B.sweep(cfg);
  const accs = B.load(P, now).accounts;
  for (const s of ['core_rev', 'core_fail', 'skill_nr']) {
    const a = accs[s];
    assert.strictEqual(a.status, 'open', s + ': не «сделано, смотрим 48 ч»'); assert(!a.paidAt && !a.resetAt, s + ': оплата не засчитана');
    assert(B.balance(a, now) > 39, s + ': баланс сохранён'); assert(a.retryAt >= now + 6 * H - 1000, s + ': пауза до новой заявки');
    assert(a.history[0].outcome !== 'ждёт инженера' && a.history[0].outcome !== 'сделано, смотрим 48 ч', s + ': ' + a.history[0].outcome);
  }
  assert.strictEqual(accs.skill_ok.status, 'watching', '«готово» — как было');
  assert(r.msgs.some(m => /core_rev/.test(m) && /откачена/.test(m) && /снова копится/.test(m)), r.msgs.join('|'));
  assert(r.msgs.some(m => /core_fail/.test(m) && /не сделана/.test(m)) && r.msgs.some(m => /skill_nr.*не сделана/.test(m)));
  assert(!r.msgs.some(m => /core_rev.*сделана — смотрим/.test(m)));
  // пауза: счёт с балансом выше порога повторно не выставляется, через 6 ч — выставляется
  assert(!B.due(cfg).due.some(d => /^(core_rev|core_fail|skill_nr)$/.test(d.slug)), 'сразу — нет');
  now += 7 * H; assert(B.due(cfg).due.some(d => d.slug === 'core_rev'), 'через 6 ч — снова можно выставить счёт');
  console.log('ledger dead: OK');
}

// хозяин: заявка сразу, мимо порога (даже при L ≥ 4) — и привязывается к счёту из проводки
function testOwner() {
  const D = mkdirs();
  let now = Date.UTC(2026, 9, 30, 12);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now, neighborDir: null };
  const hms = ms => new Date(ms).toISOString().slice(11, 19);
  T.scan(cfg);
  for (const n of ['a1', 'a2', 'a3', 'a4']) touch(path.join(D.req, n + '.md'), now - H, '# ' + n + '\n');
  fs.appendFileSync(path.join(D.dataDir, 'events.log'), JSON.stringify({ t: hms(now), id: 2, type: 'progress_idle', min: 40 }) + '\n');
  fs.appendFileSync(path.join(D.dataDir, 'events.log'), JSON.stringify({ t: hms(now), id: 3, type: 'owner_msg', text: 'ягоды можно есть' }) + '\n');
  T.scan(cfg); now += 100000;
  const r = T.take(cfg); assert.strictEqual(r.type, 'owner', 'хозяин — первым');
  touch(path.join(D.req, 'eat_berries.md'), now, '# eat_berries\n');
  touch(path.join(D.dataDir, 'teacher', path.basename(r.report)), now, 'Проводка: eat_berries | Не ест ягоды | skill | 10 | хозяин events.log #3\nСделано: заявка eat_berries.md\n');
  T.finish(cfg, r.id, 'ok');
  const a = B.load(B.paths(cfg), now).accounts.eat_berries;
  assert.strictEqual(a.status, 'invoiced'); assert.strictEqual(a.request.name, 'eat_berries');
  assert.strictEqual(B.status(cfg).load, 5); assert.strictEqual(B.status(cfg).threshold, null, 'L ≥ 4 — новых заявок нет');
  console.log('ledger owner: OK');
}

function testBroken() {
  const D = mkdirs();
  const now = Date.UTC(2026, 9, 30, 12);
  const cfg = { dataDir: D.dataDir, brainDir: D.brainDir, now: () => now };
  const P = B.paths(cfg);
  fs.writeFileSync(P.state, '{ "accounts": [не json');
  const s = B.status(cfg);
  assert.strictEqual(s.ok, true); assert.deepStrictEqual(s.accounts, []); assert(s.recovered);
  assert(fs.existsSync(P.state + '.bad'), 'битый файл отложен');
  B.caseFinished(cfg, { id: 'c1', type: 'death', items: [] }, 'done', 'Проводка: x_y | t | behavior | 5 | #1');
  assert.strictEqual(JSON.parse(fs.readFileSync(P.state, 'utf8')).accounts.x_y.postings.length, 1, 'после — пишется как обычно');
  // CLI отвечает одной ASCII-строкой JSON
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'lib', 'teacher_ledger.js'), 'nope']).toString();
  assert(/^[\x20-\x7e]+\n$/.test(out) && JSON.parse(out).ok === false, 'CLI ASCII');
  console.log('ledger broken: OK');
}

async function testAudit(D) {
  const A = require('../audit/server');
  const r = await A.api({ dataDir: D.dataDir, brainDir: D.brainDir, root: D.root }, 'ledger', new URLSearchParams());
  assert.strictEqual(r.ok, true); assert(r.accounts.some(a => a.slug === 'shelter_ledge' && a.statusRu)); assert('threshold' in r && 'load' in r);
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit', 'index.html'), 'utf8');
  assert(/\['ledger', 'Бухгалтерия'\]/.test(html) && /id="p-ledger"/.test(html) && /ledger: \['\/api\/ledger', renderLedger\]/.test(html), 'вкладка «Бухгалтерия» подключена');
  console.log('ledger audit: OK');
}

(async () => {
  testParse(); testMath();
  const D = testFlow();
  testStale(); testDead(); testOwner(); testBroken();
  await testAudit(D);
  console.log('teacher_ledger: all OK');
})().catch(e => { console.error(e); process.exit(1); });
