// Офлайн-проверка программы «Аудит» (audit/server.js, lib/audit_api.js): разбор форматов журналов на образцах строк из реальных файлов,
// хвост файла, /owner_msg отклоняет «/», запросы наблюдателя не считаются «мозг жив». Без Minecraft и без реального тела.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const A = require('../audit/server');
const API = require('../lib/audit_api');

const ESC = '\x1b';

function testTail(dir) {
  // маленький файл — все строки целиком, CRLF не мешает
  const small = path.join(dir, 'small.log');
  fs.writeFileSync(small, 'один\r\nдва\r\nтри\r\n');
  assert.deepStrictEqual(A.tailLines(small, 1000).lines, ['один', 'два', 'три']);
  // большой файл с русскими буквами (по 2 байта): хвост по байтам, оборванная первая строка выброшена, ни одного битого символа
  const big = path.join(dir, 'big.log');
  const rows = []; for (let i = 0; i < 5000; i++) rows.push(`строка номер ${i} — привет мир`);
  fs.writeFileSync(big, rows.join('\n') + '\n');
  for (const n of [1000, 1001, 1003, 4999]) {
    const t = A.tailLines(big, n);
    assert(t.lines.length > 5 && t.lines.length < 200, 'хвост ' + n);
    assert.strictEqual(t.lines[t.lines.length - 1], rows[rows.length - 1]);
    for (const l of t.lines) { assert(!l.includes('\ufffd'), 'битый символ'); assert(/^строка номер \d+ — привет мир$/.test(l), 'целая строка: ' + l); }
  }
  // читаем именно хвост, а не весь файл: размер не больше запрошенного
  assert(A.readTail(big, 500).buf.length === 500);
  assert.strictEqual(A.tailLines(path.join(dir, 'нет-такого.log'), 100), null);
  // windows-1251 (handover.log, его пишет PowerShell) и UTF-8 с BOM (guard.log)
  const cp = Buffer.from([0x5b, 0x31, 0x32, 0x3a, 0x32, 0x38, 0x3a, 0x31, 0x33, 0x5d, 0x20, 0xed, 0xee, 0xe2, 0xfb, 0xe9, 0x20, 0xec, 0xee, 0xe7, 0xe3, 0x0d, 0x0a]);
  fs.writeFileSync(path.join(dir, 'cp.log'), cp);
  assert.deepStrictEqual(A.tailLines(path.join(dir, 'cp.log'), 100).lines, ['[12:28:13] новый мозг']);
  fs.writeFileSync(path.join(dir, 'bom.log'), '\ufeff[2026-10-21 16:36:32] сторож запущен\r\n');
  assert.strictEqual(A.parseGuardLine(A.tailLines(path.join(dir, 'bom.log'), 100).lines[0]).text, 'сторож запущен');
}

function testTimes() {
  // events.log хранит время по UTC без даты. Идём от времени изменения файла назад; переход через полночь = минус сутки
  const end = Date.UTC(2026, 9, 22, 0, 10, 0); // 22.10 00:10 UTC
  const ts = A.resolveTimes([23 * 3600 + 50 * 60, 23 * 3600 + 59 * 60 + 59, 0, 5 * 60], end, true);
  assert.strictEqual(new Date(ts[0]).toISOString(), '2026-10-21T23:50:00.000Z');
  assert.strictEqual(new Date(ts[1]).toISOString(), '2026-10-21T23:59:59.000Z');
  assert.strictEqual(new Date(ts[2]).toISOString(), '2026-10-22T00:00:00.000Z');
  assert.strictEqual(new Date(ts[3]).toISOString(), '2026-10-22T00:05:00.000Z');
  // местное время получается сдвигом часового пояса, а не «как написано»
  const e = A.parseEventLines(['{"id":4534,"t":"11:22:05","type":"task_started","taskId":1692,"name":"wait_night","params":{"max_sec":720},"source":"brain"}'], Date.UTC(2026, 9, 21, 11, 22, 30));
  assert.strictEqual(e[0].ts, Date.UTC(2026, 9, 21, 11, 22, 5));
  assert.strictEqual(A.hmsToSec('11:22:05'), 40925);
  assert.strictEqual(A.hmsToSec('мусор'), null);
}

// образцы строк из data/events.log
const EV = [
  '{"id":4531,"t":"11:21:22","type":"info","msg":"автопилот: дневная работа (day_routine)","autopilot":true}',
  '{"id":4532,"t":"11:21:22","type":"info","msg":"автопилот: day_routine: прерван мозгом","autopilot":true}',
  '{"id":4533,"t":"11:21:33","type":"danger","kind":"night_soon","nightIn":77}',
  '{"id":4534,"t":"11:22:05","type":"task_started","taskId":1692,"name":"wait_night","params":{"max_sec":720},"source":"brain"}',
  '{"id":4469,"t":"11:22:09","type":"task_started","taskId":1680,"name":"shelter","params":{},"source":"reflex"}',
  '{"id":4467,"t":"11:22:10","type":"info","msg":"рефлекс: shelter (выживал 0/0 здесь; варианты escape/shelter/fight)"}',
  '{"id":4526,"t":"11:22:12","type":"task_done","taskId":1680,"name":"shelter","result":{"ok":1},"sync":true}',
  '{"id":4280,"t":"11:22:20","type":"task_failed","taskId":1692,"name":"wait_night","reason":"нет в инвентаре: stone_pickaxe","sync":true}',
  '{"id":4543,"t":"11:22:27","type":"danger","kind":"enemy","name":"stray","d":9.1,"dir":"ЮЗ","hp":10}',
  '{"id":4470,"t":"11:22:28","type":"danger","kind":"attacked","by":"zombie","hp":6,"d":0.5}',
  '{"id":4474,"t":"11:22:29","type":"death","cause":"zombie","message":"FlyTest was slain by Zombie","at":[-395,65,33],"phase":"ночь","deaths":64}',
  '{"id":202,"t":"11:22:30","type":"chat","from":"Eblanitus228","text":"муха, стой"}',
  '{"id":198,"t":"11:22:31","type":"chat","from":"FlyBot","text":"Set own game mode to Survival Mode]"}',
  '{"id":197,"t":"11:22:32","type":"chat","kind":"system","from":null,"text":"FlyBot joined the game"}',
  '{"id":4600,"t":"11:22:33","type":"info","msg":"мозг сказал в чат","say":"Иду на базу"}',
  '{"id":4601,"t":"11:22:34","type":"owner_msg","text":"привет из программы","from":"eblanitus228 (из программы)"}',
  'это не JSON',
  '{"id":4602,"t":"11:22:35","type":"task_started","taskId":1693,"name":"find","params":{"block":"bed","steps":6},"source":"brain"}',
  '{"id":4603,"t":"11:22:36","type":"task_failed","taskId":1693,"name":"find","reason":"неизвестный блок: bed","sync":true}'
];

function testEvents() {
  const evs = A.parseEventLines(EV, Date.UTC(2026, 9, 21, 11, 23, 0));
  assert.strictEqual(evs.length, EV.length - 1, 'битая строка пропущена');
  const rf = A.reflexFeed(evs, 50); // новые сверху
  const txt = rf.map(x => x.who + ': ' + x.text);
  assert(txt.some(t => /^автопилот: дневная работа/.test(t)), 'автопилот info');
  assert(txt.some(t => /^рефлекс: начал: прячется в укрытие/.test(t)), 'старт рефлекса');
  assert(txt.some(t => /^рефлекс: shelter \(выживал/.test(t)), 'info рефлекса');
  assert(txt.some(t => /^рефлекс: готово: прячется в укрытие/.test(t)), 'конец рефлекса по taskId');
  assert(txt.some(t => /^угроза: бьют: zombie/.test(t)) && txt.some(t => /скоро ночь/.test(t)));
  assert(txt.some(t => /^тело: СМЕРТЬ №64: zombie/.test(t)));
  assert(!txt.some(t => /wait_night|пережидает/.test(t) && /^рефлекс|^автопилот/.test(t) && /нет в инвентаре/.test(t)), 'провал задачи мозга — не в ленте автопилота');
  assert(!txt.some(t => /stray/.test(t)), 'enemy-шум не в ленте');
  assert(rf[0].ts >= rf[rf.length - 1].ts, 'новые сверху');
  const bc = A.brainCommands(evs, 10);
  assert.strictEqual(bc.length, 2);
  assert.strictEqual(bc[0].name, 'find'); assert.strictEqual(bc[0].status, 'не вышло'); assert.strictEqual(bc[0].note, 'неизвестный блок: bed');
  assert.strictEqual(bc[1].name, 'wait_night'); assert.strictEqual(bc[1].status, 'не вышло');
  const ch = A.chatFeed(evs, 50, false);
  assert.deepStrictEqual(ch.map(m => m.role), ['owner', 'player', 'brain', 'owner']);
  assert.strictEqual(ch[0].text, 'муха, стой');
  assert.strictEqual(ch[2].text, 'Иду на базу');
  assert(ch[3].app && ch[3].text === 'привет из программы');
  assert.strictEqual(A.chatFeed(evs, 50, true).length, 5, 'системные строки — по запросу');
}

function testNightLog() {
  const L = [
    ' ', '===== [21.10.2026 16:37:32,21] brain start ===== ', `${ESC}[0m`, `> build · minimax-m3.1-flash-free`, `${ESC}[0m`,
    `${ESC}[0m→ ${ESC}[0mRead brain/BRAIN_PROMPT.md`, `I'll start by reading the brain files.`, '',
    `${ESC}[0m$ ${ESC}[0mcurl.exe -s "http://127.0.0.1:3199/do?action=build_blueprint&name=bridge_stone&x=-406&y=66&z=29&rot=90"`,
    '{"ok":true,"taskId":1675,"started":"build_blueprint","status":"running"}', `${ESC}[0m`,
    `${ESC}[0m← ${ESC}[0mEdit brain/notes.md`, 'Index: C:\\Users\\user\\flybot\\brain\\notes.md', '===================================================================',
    '--- C:\\Users\\user\\flybot\\brain\\notes.md', '+++ C:\\Users\\user\\flybot\\brain\\notes.md', '@@ -94,8 +94,10 @@', ' - строка контекста', '+- [2026-10-21 11:06] Смерть 64 в хижине', '',
    'Муха снова погибла в пещере (скелеты). Последняя попытка спасти броню.', 'Вторая строка того же абзаца.', '',
    `${ESC}[0m$ ${ESC}[0mcurl.exe -s "http://127.0.0.1:3199/do?action=chat&text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%D1%85%D0%BE%D0%B7%D1%8F%D0%B8%D0%BD"`,
    '{"ok":true,"snapshot":{"ready":true}}', '',
    `${ESC}[0m$ ${ESC}[0mcurl.exe -s -X POST -H "Content-Type: application/json" -d '{"name":"gather_wood"}' "http://127.0.0.1:3200/enable"`, '{"ok":true}', '',
    `${ESC}[91m${ESC}[1mError: ${ESC}[0mThe user has specified a rule which prevents you from using this specific tool call.`,
    `${ESC}[91m${ESC}[1mError: ${ESC}[0mCannot connect to API: Unable to connect. Is the computer able to access the url?`, '',
    `${ESC}[0m✗ ${ESC}[0mTest-Path -LiteralPath "x" failed`, 'Error: The user has specified a rule which prevents you from using this specific tool call.', '',
    'Финальный текст модели.'
  ];
  const e = A.parseNightLog(L);
  const kinds = e.map(x => x.k);
  assert(!kinds.includes('out') === false, 'ответ curl сохранён');
  const start = e.find(x => x.k === 'start');
  assert.strictEqual(new Date(start.ts).getTime(), new Date(2026, 9, 21, 16, 37, 32).getTime(), 'время запуска — местное');
  assert(e.some(x => x.k === 'model' && /minimax/.test(x.text)));
  assert(e.some(x => x.k === 'tool' && x.text === 'Read brain/BRAIN_PROMPT.md' && !x.write));
  assert(e.some(x => x.k === 'tool' && x.text === 'Edit brain/notes.md' && x.write));
  const texts = e.filter(x => x.k === 'text').map(x => x.text);
  assert.deepStrictEqual(texts, ["I'll start by reading the brain files.", 'Муха снова погибла в пещере (скелеты). Последняя попытка спасти броню.\nВторая строка того же абзаца.', 'Финальный текст модели.'], 'только слова модели; дифф не просачивается: ' + JSON.stringify(texts));
  const cmds = e.filter(x => x.k === 'cmd');
  assert.strictEqual(cmds.length, 3);
  assert.strictEqual(cmds[0].target, 'тело'); assert.strictEqual(cmds[0].title, 'build_blueprint');
  assert(/name=bridge_stone/.test(cmds[0].args) && /rot=90/.test(cmds[0].args));
  assert.strictEqual(cmds[1].say, 'Привет хозяин', 'текст чата декодируется');
  assert.strictEqual(cmds[2].target, 'исполнитель'); assert.strictEqual(cmds[2].method, 'POST'); assert(/gather_wood/.test(cmds[2].args));
  assert(e.some(x => x.k === 'err' && /Cannot connect/.test(x.text)));
  assert(!e.some(x => /specified a rule/.test(x.text || '')), 'шум запретов не показываем');
  // склейка однотипных опросов /wait
  const polls = []; for (let i = 0; i < 4; i++) { polls.push({ k: 'cmd', target: 'тело', title: 'wait', args: 'timeout=' + i }, { k: 'out', text: '{}' }); }
  polls.push({ k: 'cmd', target: 'тело', title: 'craft', args: '' });
  const c = A.collapsePolls(polls);
  assert.strictEqual(c.length, 3); assert.strictEqual(c[0].n, 4); assert.strictEqual(c[2].title, 'craft');
  // parseCurl
  assert.strictEqual(A.parseCurl('curl.exe -s "http://127.0.0.1:3200/go?name=smelt_all&what=raw_copper&timeout_sec=500"').title, 'запуск навыка smelt_all');
  assert.strictEqual(A.parseCurl('echo hi'), null);
  assert.strictEqual(A.stripAnsi(`${ESC}[91m${ESC}[1mError: ${ESC}[0mx`), 'Error: x');
}

function testSmallLogs() {
  const d = A.parseDeathLine('[2026-10-21T11:06:13.987Z] Death #64 at (-395, 65, 33) cause: zombie | FlyTest was slain by Zombie timeOfDay: ночь');
  assert.deepStrictEqual([d.n, d.x, d.y, d.z, d.cause, d.timeOfDay, d.msg], [64, -395, 65, 33, 'zombie', 'ночь', 'FlyTest was slain by Zombie']);
  assert.strictEqual(d.ts, Date.UTC(2026, 9, 21, 11, 6, 13, 987));
  assert.strictEqual(A.parseDeathLine('мусор'), null);
  const day = A.parseDayLine('{"t":"2026-10-21T10:32:22.883Z","day":51,"built":1,"aux":11,"deaths":0,"dist":139,"minedTotal":0,"lostTotal":0,"skills":{"ok":3,"fail":1},"line":"День 51: построено 1 блок"}');
  assert.strictEqual(day.day, 51); assert.strictEqual(day.line, 'День 51: построено 1 блок'); assert.strictEqual(day.skills.ok, 3);
  assert.strictEqual(A.parseDayLine('{"нет":1}'), null);
  const g = A.parseGuardLine('\ufeff[2026-10-21 20:39:05] инженер: взял заявку bring_bed_home (pid 18680)');
  assert.strictEqual(g.ts, new Date(2026, 9, 21, 20, 39, 5).getTime()); assert(/bring_bed_home/.test(g.text));
  const h = A.parseHandoverLine('[16:37:22] handover: запущен');
  assert.strictEqual(h.sec, 16 * 3600 + 37 * 60 + 22);
  const n = A.parseNotes('# Блокнот мозга\n\n## Текущая цель\nШаг проекта: мост.\nНе хватает: досок.\n\n## Состояние проекта (на 21.10)\nбаза\n\n## Указание хозяина (21.10)\nПиши в чат\n\n## Проект\nЦитадель\n');
  assert.strictEqual(n.goal, 'Шаг проекта: мост.\nНе хватает: досок.'); assert.strictEqual(n.ownerNote, 'Пиши в чат'); assert.strictEqual(n.project, 'Цитадель');
}

function testFiles(dir) {
  // инженер: статусы заявок
  const br = path.join(dir, 'brain'), sr = path.join(br, 'skill_requests'), data = path.join(dir, 'data');
  fs.mkdirSync(sr, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  const w = (f, s, t) => { fs.writeFileSync(f, s); if (t) fs.utimesSync(f, t / 1000, t / 1000); };
  const now = Date.now();
  w(path.join(sr, 'a_wait.md'), '# Заявка: `a_wait` — ждёт\n', now - 5000);
  w(path.join(sr, 'b_work.md'), '# Заявка: b_work\n', now - 9000); w(path.join(sr, 'b_work.working'), '', now - 3000);
  w(path.join(sr, 'c_done.md'), '# Заявка: c_done\nтекст', now - 9000); w(path.join(sr, 'c_done.done.md'), '# c_done: готово\n\nЗапуск:', now - 4000);
  w(path.join(sr, 'd_bad.md'), '# Заявка: d_bad\n', now - 9000); w(path.join(sr, 'd_bad.done.md'), '# d_bad: не готово\nпричина', now - 4000);
  w(path.join(sr, 'e_again.md'), '# Заявка: e_again (повторная)\n', now - 1000); w(path.join(sr, 'e_again.done.md'), '# e_again: готово\n', now - 8000);
  w(path.join(data, 'engineer-c_done.log'), `${ESC}[0m> build · deepseek\n\nГотово, навык записан.\n`);
  const cfg = { dataDir: data, brainDir: br };
  const st = Object.fromEntries(A.engineerList(cfg).map(i => [i.name, i.status]));
  assert.deepStrictEqual(st, { a_wait: 'waiting', b_work: 'working', c_done: 'done', d_bad: 'notdone', e_again: 'waiting' });
  const det = A.engineerDetail(cfg, 'c_done');
  assert(det.ok && /текст/.test(det.request) && /готово/.test(det.answer) && det.log.some(x => /Готово, навык записан/.test(x.text)));
  assert(!A.engineerDetail(cfg, '../notes').ok, 'путь за пределы папки не принимается');
  assert(!A.engineerDetail(cfg, 'нет_такой').ok);
  // самый свежий night-лог (по времени изменения) и все «brain start» в нём (читаются кусками)
  w(path.join(data, 'night-20261021-100000.log'), '===== [21.10.2026 10:00:00,00] brain start =====\n', now - 100000);
  const filler = ('x'.repeat(99) + '\n').repeat(12000); // > 1 МБ между запусками
  w(path.join(data, 'night-20261021-110000.log'), '===== [21.10.2026 11:00:00,10] brain start =====\r\n' + filler + '===== [21.10.2026 12:30:05,99] brain start =====\r\nМысль модели.\r\n', now - 1000);
  assert.strictEqual(A.latestNightLog(data).name, 'night-20261021-110000.log');
  const starts = A.scanBrainStarts(data);
  assert.deepStrictEqual(starts.map(s => new Date(s.ts).getHours() + ':' + new Date(s.ts).getMinutes()), ['12:30', '11:0', '10:0']);
  const bl = A.loadBrainLog(cfg);
  assert.strictEqual(bl.file, 'night-20261021-110000.log');
  assert(bl.entries.some(e => e.k === 'text' && e.text === 'Мысль модели.'));
  // перечитывание после дозаписи не теряет и не дублирует запуски
  fs.appendFileSync(path.join(data, 'night-20261021-110000.log'), '===== [21.10.2026 13:00:00,00] brain start =====\r\n');
  assert.strictEqual(A.scanBrainStarts(data).length, 4);
  assert.strictEqual(A.scanBrainStarts(data).length, 4);
  // метки времени tools/tstamp.js, час без ведущего нуля в «brain start», night.log тоже журнал мозга
  const P = A.parseNightLog(['===== [22.10.2026  9:50:21,24] brain start, model x =====', '[09:51:02] Думаю про хижину.', '', '[09:51:05] $ curl.exe -s "http://127.0.0.1:3199/snapshot"', '[09:51:06] {"ok":true}', 'старая строка без метки']);
  const hm = e => { const d = new Date(e.ts); return d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds(); };
  assert.strictEqual(P[0].k, 'start'); assert.strictEqual(hm(P[0]), '9:50:21');
  const th = P.find(e => e.k === 'text' && /хижину/.test(e.text)); assert(th && hm(th) === '9:51:2', 'у мысли есть время');
  const cm = P.find(e => e.k === 'cmd'); assert(cm && cm.title === 'snapshot' && hm(cm) === '9:51:5', 'у команды есть время, метка не мешает разбору');
  const P2 = A.parseNightLog(['===== [22.10.2026 23:59:50,00] brain start =====', '[00:00:10] после полуночи']);
  assert.strictEqual(new Date(P2[1].ts).getDate(), 23, 'переход через полночь');
  w(path.join(data, 'night.log'), '===== [21.10.2026 14:00:00,00] brain start =====\n[14:00:01] Сейчас.\n', Date.now() + 60000);
  assert.strictEqual(A.latestNightLog(data).name, 'night.log');
  fs.unlinkSync(path.join(data, 'night.log'));
  // события: время изменения файла = последняя строка
  const evf = path.join(data, 'events.log'); w(evf, EV.join('\n') + '\n');
  const le = A.loadEvents(cfg);
  assert.strictEqual(le.events.length, EV.length - 1);
  assert.strictEqual(new Date(le.events[le.events.length - 1].ts).getUTCHours() >= 0, true);
  // guard.log, handover.log, deaths.log, days.log
  w(path.join(data, 'guard.log'), '\ufeff[2026-10-21 16:36:32] сторож запущен\r\n[2026-10-21 16:37:32] петля закрыта\r\n');
  fs.writeFileSync(path.join(data, 'handover.log'), Buffer.concat([Buffer.from('[12:28:13] handover: '), Buffer.from([0xed, 0xee, 0xe2, 0xfb, 0xe9]), Buffer.from('\r\n')]));
  w(path.join(data, 'deaths.log'), '[2026-10-21T09:38:49.255Z] Death #62 at (-368, 40, 38) cause: zombie | FlyTest was slain by Zombie timeOfDay: день\n[2026-10-21T09:41:15.557Z] Death #63 at (-378, 40, 37) cause: spider | FlyTest was slain by Spider timeOfDay: день\n');
  w(path.join(data, 'days.log'), '{"t":"2026-10-21T10:32:22.883Z","day":51,"line":"День 51"}\n{"t":"2026-10-21T10:52:22.882Z","day":52,"line":"День 52"}\n');
  const sv = A.loadService(cfg);
  assert.strictEqual(sv.guard.length, 2); assert(/петля закрыта/.test(sv.guard[0].text), 'новые сверху');
  assert.strictEqual(sv.handover.length, 1); assert(/новый/.test(sv.handover[0].text));
  const ds = A.loadDeaths(cfg);
  assert.deepStrictEqual(ds.deaths.map(x => x.n), [63, 62]); assert.deepStrictEqual(ds.days.map(x => x.day), [52, 51]);
}

// Проверка без сервера: «наблюдатель» не считается признаком «мозг жив», а /owner_msg не пропускает «/».
function testObserverAndOwnerMsg() {
  assert.strictEqual(API.isObserver({ headers: { 'x-observer': '1' } }), true);
  assert.strictEqual(API.isObserver({ headers: { 'x-observer': 'true' } }), true);
  assert.strictEqual(API.isObserver({ headers: {} }), false);
  assert.strictEqual(API.isObserver({ headers: { 'user-agent': 'curl/8' } }), false, 'curl мозга — не наблюдатель');
  assert.strictEqual(API.isObserver({ headers: { 'x-observer': '0' } }), false);
  // та же проверка в самом bot.js: исключение стоит на той же строке, что и lastBrainContact, и маршрут /owner_msg есть
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const line = src.split(/\r?\n/).find(l => /ctx\.lastBrainContact = Date\.now\(\);/.test(l) && /pathname/.test(l));
  assert(line && /isObserver\(req\)/.test(line) && /\/health/.test(line), 'bot.js: наблюдатель не обновляет lastBrainContact');
  assert(/url\.pathname === '\/owner_msg'/.test(src), 'bot.js: есть POST /owner_msg');
  const cmdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'commands.js'), 'utf8');
  assert(/say: text/.test(cmdSrc), 'реплики мозга попадают в events.log');
  // имитация обработчика: контакт обновляется всеми, кроме /health и наблюдателя
  const ctx = { lastBrainContact: 0 };
  const touch = (pathname, req) => { if (pathname !== '/health' && !API.isObserver(req)) ctx.lastBrainContact = Date.now(); };
  touch('/snapshot', { headers: { 'x-observer': '1' } }); assert.strictEqual(ctx.lastBrainContact, 0);
  touch('/wait', { headers: {} }); assert(ctx.lastBrainContact > 0);

  const pushed = [];
  const fake = { events: { push: (type, data) => { pushed.push({ type, ...data }); return { id: pushed.length }; } } };
  for (const bad of ['/tp', '  /give', '\u200b/op', '\uff0f/x', '\n/kill', '', '   ', null, 5, 'я'.repeat(301)]) {
    const r = API.ownerMsg(fake, { text: bad });
    assert.strictEqual(r.ok, false, 'отклонено: ' + JSON.stringify(bad)); assert(r.error);
  }
  assert.strictEqual(pushed.length, 0, 'ничего не попало в ленту');
  assert.strictEqual(API.ownerMsg(fake, null).ok, false);
  const ok = API.ownerMsg(fake, { text: '  Привет, мозг! Строй мост / не бойся  ' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(pushed.length, 1);
  assert.strictEqual(pushed[0].type, 'owner_msg');
  assert.strictEqual(pushed[0].text, 'Привет, мозг! Строй мост / не бойся');
  assert(/из программы/.test(pushed[0].from));
  // owner_msg не в «тихих» типах — будит мозг в /wait
  assert(!require('../lib/events').QUIET.has('owner_msg'));
  const hub = new (require('../lib/events').EventHub)();
  const origLog = console.log; console.log = () => {};
  try { API.ownerMsg({ events: hub }, { text: 'эй' }); } finally { console.log = origLog; }
  assert.strictEqual(hub.wakeSince(0).length, 1);
}

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function request(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...(headers || {}) };
    if (payload) { h['Content-Length'] = payload.length; if (!h['Content-Type']) h['Content-Type'] = 'application/json'; }
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: h }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, text: s, json: (() => { try { return JSON.parse(s); } catch (e) { return null; } })() }));
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

async function testServer(dir) {
  // фальшивое тело: записывает, что у него спрашивали и с какими заголовками
  const seen = [];
  let ownerStatus = 200;
  const body = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c).on('end', () => {
      seen.push({ method: req.method, url: req.url, observer: req.headers['x-observer'], body: b });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/snapshot') return res.end(JSON.stringify({ ready: true, username: 'FlyTest', summary: 'тест', health: 12, food: 18, position: { x: 1, y: 64, z: 2 }, armor: [], inventory: [{ name: 'stick', count: 3 }], eyes: { enemies: [{ name: 'zombie', d: 5, dir: 'С' }], task: { name: 'wait_night' } }, autopilot: { on: true } }));
      if (req.url === '/owner_msg' && req.method === 'POST') { res.statusCode = ownerStatus; return res.end(ownerStatus === 200 ? '{"ok":true,"id":7}' : '{"ok":false,"error":"not found"}'); }
      res.statusCode = 404; res.end('{"ok":false,"error":"not found"}');
    });
  });
  const bport = await listen(body);
  const runner = http.createServer((req, res) => { seen.push({ runner: true, url: req.url, observer: req.headers['x-observer'] }); res.setHeader('Content-Type', 'application/json'); res.end(req.url.startsWith('/health') ? '{"ok":true,"runner":{"port":3200,"uptimeSec":5,"active":null}}' : req.url.startsWith('/log') ? '{"ok":true,"entries":[]}' : '{"ok":true,"skills":[]}'); });
  const rport = await listen(runner);
  const audit = A.createServer({ port: 0, dataDir: path.join(dir, 'data'), brainDir: path.join(dir, 'brain'), bodyUrl: 'http://127.0.0.1:' + bport, runnerUrl: 'http://127.0.0.1:' + rport });
  const aport = await listen(audit);
  try {
    let r = await request(aport, 'GET', '/');
    assert.strictEqual(r.status, 200); assert(/Аудит мухи/.test(r.text));
    for (const name of ['summary', 'body', 'reflex', 'brain', 'engineer', 'deaths', 'service', 'chat']) {
      r = await request(aport, 'GET', '/api/' + name);
      assert.strictEqual(r.status, 200, name); assert(r.json && !r.json.error, name + ': ' + r.text.slice(0, 120));
    }
    r = await request(aport, 'GET', '/api/summary'); assert.strictEqual(r.json.body.ok, true); assert.strictEqual(r.json.body.hp, 12);
    r = await request(aport, 'GET', '/api/body'); assert.strictEqual(r.json.snap.enemies[0].name, 'zombie');
    r = await request(aport, 'GET', '/api/request?name=a_wait'); assert.strictEqual(r.status, 200);
    assert.strictEqual((await request(aport, 'GET', '/api/' + encodeURIComponent('нет'))).status, 404);
    // всё, что программа спросила у тела и исполнителя, — с заголовком X-Observer: 1
    assert(seen.length >= 4);
    for (const s of seen) assert.strictEqual(s.observer, '1', 'X-Observer у ' + s.url);

    // чат: «/» отклоняется ещё до тела
    const before = seen.length;
    for (const t of ['/tp', ' /op me', '\u200b/x']) {
      r = await request(aport, 'POST', '/api/say', { text: t });
      assert.strictEqual(r.status, 400, t); assert.strictEqual(r.json.ok, false);
    }
    assert.strictEqual(seen.length, before, 'тело даже не спросили');
    assert.strictEqual((await request(aport, 'POST', '/api/say', { text: '   ' })).status, 400);
    assert.strictEqual((await request(aport, 'POST', '/api/say', 'не json')).status, 400);
    assert.strictEqual((await request(aport, 'POST', '/api/say', { text: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.strictEqual((await request(aport, 'POST', '/api/say', { text: 'x' }, { Origin: 'http://evil.example' })).status, 403, 'чужой сайт');
    assert.strictEqual((await request(aport, 'GET', '/api/summary', null, { Host: 'evil.example' })).status, 403, 'DNS-rebinding');
    // нормальное сообщение уходит телу как POST /owner_msg {text} с X-Observer
    r = await request(aport, 'POST', '/api/say', { text: 'Привет, мозг' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true);
    const m = seen.filter(s => s.url === '/owner_msg'); assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(JSON.parse(m[0].body), { text: 'Привет, мозг' }); assert.strictEqual(m[0].observer, '1'); assert.strictEqual(m[0].method, 'POST');
    // старое тело без /owner_msg: понятная ошибка, а не «успех»
    ownerStatus = 404;
    r = await request(aport, 'POST', '/api/say', { text: 'ещё раз' });
    assert.strictEqual(r.status, 502); assert.strictEqual(r.json.ok, false); assert(/перезапуст/.test(r.json.error));
  } finally { for (const s of [audit, body, runner]) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); } }
  // тело не запущено: страница не падает
  const dead = A.createServer({ port: 0, dataDir: path.join(dir, 'data'), brainDir: path.join(dir, 'brain'), bodyUrl: 'http://127.0.0.1:1', runnerUrl: 'http://127.0.0.1:1' });
  const dport = await listen(dead);
  try {
    let r = await request(dport, 'GET', '/api/body'); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, false); assert(r.json.error);
    r = await request(dport, 'GET', '/api/summary'); assert.strictEqual(r.json.body.ok, false); assert.strictEqual(r.json.runner.ok, false);
    r = await request(dport, 'POST', '/api/say', { text: 'привет' }); assert.strictEqual(r.status, 502);
  } finally { dead.close(); if (dead.closeAllConnections) dead.closeAllConnections(); }
}

// Чёрный ящик и учёт в аудите: со старым телом (404) — «тело ещё не перезапущено» и файлы с диска; с новым — данные тела; плохие имена файлов отклоняются
async function testBlackboxAudit(dir) {
  const data = path.join(dir, 'bbdata'); fs.mkdirSync(path.join(data, 'blackbox'), { recursive: true });
  const rec = { v: 1, kind: 'death', savedAt: '2026-10-21T12:00:00.000Z', summary: { cause: 'drowned', message: 'муха drowned', pos: [1, 60, 2], lastTask: { name: 'collect', by: 'skill:miner' }, worst: { kind: 'air', ttdSec: 2 }, mobs: [] },
    lost: { items: { dirt: 3 }, total: 3 }, frames: [{ t: 1, why: 'тик', hp: 20, air: { under: true, sec: 4 }, worst: { kind: 'air', ttdSec: 14 }, task: { name: 'collect', by: 'skill:miner' }, mobs: [] }] };
  fs.writeFileSync(path.join(data, 'blackbox', 'death-20261021-120000.json'), JSON.stringify(rec));
  fs.writeFileSync(path.join(data, 'blackbox', 'notes.txt'), 'чужой файл');
  fs.writeFileSync(path.join(data, 'ledger.json'), JSON.stringify({ v: 1, since: '2026-10-21T10:00:00.000Z', days: { 5: { cobblestone: { in: { mined: { 'skill:miner': 4 } }, out: { placed: { brain: 1 } } } } } }));
  const mk = (handler) => { const s = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (!handler(req, res)) { res.statusCode = 404; res.end('{"ok":false,"error":"not found"}'); } }); return s; };
  const old = mk(() => false); const oport = await listen(old);
  const fresh = mk((req, res) => {
    if (req.url.startsWith('/blackbox/file')) { res.end(JSON.stringify(rec)); return true; }
    if (req.url.startsWith('/blackbox')) { res.end(JSON.stringify({ ok: true, total: 1, items: [{ name: 'death-20261021-120000.json', kind: 'death', cause: 'из тела' }] })); return true; }
    if (req.url === '/ledger') { res.end(JSON.stringify({ ok: true, totals: { in: 9, out: 0, unknownIn: 0, unknownOut: 0 }, items: [], byDay: [], byReason: { in: {}, out: {} }, bySource: {} })); return true; }
    return false;
  });
  const fport = await listen(fresh);
  const a1 = A.createServer({ port: 0, dataDir: data, brainDir: path.join(dir, 'brain'), bodyUrl: 'http://127.0.0.1:' + oport, runnerUrl: 'http://127.0.0.1:1' });
  const a2 = A.createServer({ port: 0, dataDir: data, brainDir: path.join(dir, 'brain'), bodyUrl: 'http://127.0.0.1:' + fport, runnerUrl: 'http://127.0.0.1:1' });
  const p1 = await listen(a1), p2 = await listen(a2);
  try {
    let r = await request(p1, 'GET', '/api/deaths'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.blackbox.from, 'диск'); assert.strictEqual(r.json.blackbox.notRestarted, true); assert(/ещё не перезапущено/.test(r.json.blackbox.note));
    assert.strictEqual(r.json.blackbox.items.length, 1, 'чужой notes.txt в список не попал'); assert.strictEqual(r.json.blackbox.items[0].by, 'skill:miner'); assert.strictEqual(r.json.blackbox.items[0].cause, 'drowned');
    assert.strictEqual(r.json.ledger.from, 'диск'); assert(/ещё не перезапущено/.test(r.json.ledger.note)); assert.strictEqual(r.json.ledger.ledger.totals.in, 4);
    assert.strictEqual(r.json.ledger.ledger.bySource['skill:miner'].in, 4);
    r = await request(p1, 'GET', '/api/blackbox_file?name=death-20261021-120000.json'); assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.data.frames.length, 1);
    for (const bad of ['../ledger.json', 'notes.txt', '..%2f..%2fstats.json', '', 'death-/../x.json'])
      assert.strictEqual((await request(p1, 'GET', '/api/blackbox_file?name=' + bad)).json.ok, false, 'отказ: ' + bad);
    r = await request(p2, 'GET', '/api/deaths');
    assert.strictEqual(r.json.blackbox.from, 'тело'); assert.strictEqual(r.json.blackbox.items[0].cause, 'из тела'); assert.strictEqual(r.json.ledger.from, 'тело'); assert.strictEqual(r.json.ledger.ledger.totals.in, 9);
    r = await request(p2, 'GET', '/api/blackbox_file?name=death-20261021-120000.json'); assert.strictEqual(r.json.ok, true);
  } finally { for (const s of [a1, a2, old, fresh]) { s.close(); if (s.closeAllConnections) s.closeAllConnections(); } }
  // команды наблюдателю тело не принимает, новые GET на месте (bot.js читаем как текст)
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  assert(/case '\/blackbox':/.test(src) && /case '\/blackbox\/file':/.test(src) && /case '\/ledger':/.test(src), 'bot.js: GET /blackbox, /blackbox/file, /ledger');
  assert((src.match(/isObserver\(req\)\) return send\(res, 403/g) || []).length >= 2, 'bot.js: наблюдатель не отдаёт команды (/do и POST /cmd)');
}

// Модели ролей: data/models.json (models_config.js), список бесплатных, вкладка «Модели» в аудите, чтение файла сторожем и night.cmd
function testModelsConfig(dir) {
  const M = require('../models_config');
  const d = path.join(dir, 'mcfg');
  // файла нет — значения по умолчанию
  let r = M.read(d);
  assert.deepStrictEqual(r.models, M.DEFAULTS); assert.deepStrictEqual(Object.values(r.source), ['по умолчанию', 'по умолчанию', 'по умолчанию']);
  // допустимые id и мусор (id попадает в командную строку cmd — никаких пробелов, кавычек, & | % ^)
  for (const ok of ['opencode/minimax-m3.1-flash-free', 'opencode/big-pickle', 'openrouter/cohere/north-mini-code:free', 'a/b']) assert(M.validModelId(ok), ok);
  for (const bad of ['', 'minimax', 'opencode/', '/x', 'opencode/a b', 'opencode/a"b', 'opencode/a&calc', 'opencode/a|b', 'opencode/%PATH%', 'opencode/a^b', 'opencode/a;b', 'opencode/../x', '../x/y', 'opencode/a\nb', null, 5, {}, 'o/' + 'x'.repeat(130)])
    assert(!M.validModelId(bad), 'мусор принят: ' + String(bad).slice(0, 30));
  // сохранение: частично, остальные роли остаются
  r = M.save({ teacher: 'opencode/glm-5.3-flash-free' }, d);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.models.teacher, 'opencode/glm-5.3-flash-free'); assert.strictEqual(r.models.brain, M.DEFAULTS.brain);
  assert.strictEqual(M.get('teacher', d), 'opencode/glm-5.3-flash-free'); assert.strictEqual(M.read(d).source.teacher, 'файл');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(M.filePath(d), 'utf8'))), ['brain', 'teacher', 'engineer'], 'файл пишется целиком');
  assert.deepStrictEqual(fs.readdirSync(d), ['models.json'], 'временных файлов не осталось');
  // отказы ничего не меняют
  const before = fs.readFileSync(M.filePath(d), 'utf8');
  for (const bad of [{ teacher: '' }, { teacher: '  ' }, { teacher: 'no-slash' }, { boss: 'opencode/x' }, { teacher: 'opencode/x y' }, {}, null, [], { teacher: 'opencode/ok-free', engineer: 'bad id' }])
    assert.strictEqual(M.save(bad, d).ok, false, 'отказ: ' + JSON.stringify(bad));
  assert.strictEqual(fs.readFileSync(M.filePath(d), 'utf8'), before);
  // файл с BOM (правили PowerShell-ом) читается; битый JSON и плохой id в файле — значения по умолчанию, а не падение
  fs.writeFileSync(M.filePath(d), '\ufeff{"brain":"opencode/aa-free","teacher":"плохо x","engineer":5}');
  r = M.read(d); assert.strictEqual(r.models.brain, 'opencode/aa-free'); assert.strictEqual(r.models.teacher, M.DEFAULTS.teacher); assert.strictEqual(r.models.engineer, M.DEFAULTS.engineer);
  fs.writeFileSync(M.filePath(d), '{оборвано'); assert.deepStrictEqual(M.read(d).models, M.DEFAULTS);
  assert.throws(() => M.get('boss', d));
  // командная строка, как зовут night.cmd и сторож: одна строка с id
  const cli = path.join(__dirname, '..', 'models_config.js');
  const out = require('child_process').execFileSync(process.execPath, [cli, 'get', 'brain'], { encoding: 'utf8' }).trim();
  assert(M.validModelId(out), 'node models_config.js get brain: ' + out);
  assert.throws(() => require('child_process').execFileSync(process.execPath, [cli, 'get', 'boss'], { stdio: 'pipe' }));
}

function testModelsParsing() {
  const sample = 'opencode/beam-free\n{\n  "id": "beam-free",\n  "status": "active",\n  "cost": {\n    "input": 0,\n    "output": 0\n  }\n}\nopencode/gpt-5.5\n{\n  "id": "gpt-5.5",\n  "status": "active",\n  "cost": { "input": 5, "output": 30 }\n}\nopencode/big-pickle\n{\n  "id": "big-pickle", "status": "active",\n  "cost": { "input": 0, "output": 0 }\n}\nopencode/old-free\n{ "status": "deprecated", "cost": { "input": 0, "output": 0 } }\nopencode/broken\n{ нет\n';
  assert.deepStrictEqual(A.parseVerboseModels(sample), ['opencode/beam-free', 'opencode/big-pickle']);
  assert.deepStrictEqual(A.parseVerboseModels(''), []); assert.deepStrictEqual(A.parseVerboseModels('мусор'), []);
  assert.deepStrictEqual(A.parsePlainFree('opencode/a-free\r\nopencode/gpt-5\nopenrouter/x:free\nopencode/b-free\n'), ['opencode/a-free', 'opencode/b-free']);
  const ps = '7484\t"C:\\npm\\opencode.exe"    run --auto -m opencode/minimax-m3.1-flash-free "You are the brain of the Minecraft bot FlyBot_01. Read brain/BRAIN_PROMPT.md"\r\n'
    + '44548\t"C:\\npm\\opencode.exe" run --auto -m opencode/glm-5.3-flash-free "You are the teacher of the Minecraft bot FlyBot_01. Read x"\r\n99\topencode.exe serve\r\n';
  assert.deepStrictEqual(A.parseOpencodeProcs(ps), [{ pid: 7484, role: 'brain', model: 'opencode/minimax-m3.1-flash-free' }, { pid: 44548, role: 'teacher', model: 'opencode/glm-5.3-flash-free' }]);
  assert.deepStrictEqual(A.parseOpencodeProcs(''), []);
}

async function testModelsServer(dir) {
  const M = require('../models_config');
  const data = path.join(dir, 'mdata'); fs.mkdirSync(data, { recursive: true });
  let listCalls = 0, listResult = { ok: true, list: ['opencode/b-free', 'opencode/a-free', 'opencode/a-free'] }, running = [{ pid: 5, role: 'teacher', model: 'opencode/a-free' }];
  const srv = A.createServer({ port: 0, dataDir: data, brainDir: path.join(dir, 'brain'), bodyUrl: 'http://127.0.0.1:1', runnerUrl: 'http://127.0.0.1:1',
    listFreeModels: async () => { listCalls++; return listResult; }, runningModels: async () => running });
  const port = await listen(srv);
  try {
    assert.strictEqual(srv.address().address, '127.0.0.1', 'аудит слушает только localhost');
    let r = await request(port, 'GET', '/api/models'); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.free.list, ['opencode/a-free', 'opencode/b-free']); assert.strictEqual(r.json.free.from, 'opencode');
    assert.deepStrictEqual(r.json.roles.map(x => x.role), ['brain', 'teacher', 'engineer']);
    assert.strictEqual(r.json.roles[1].model, M.DEFAULTS.teacher); assert.strictEqual(r.json.roles[1].source, 'по умолчанию');
    assert.deepStrictEqual(r.json.roles[1].running, [{ pid: 5, model: 'opencode/a-free' }]); assert.deepStrictEqual(r.json.roles[0].running, []);
    assert(r.json.roles.every(x => x.when && x.label));
    assert.strictEqual(r.json.guardReadsModels, null, 'нет guard.log — не знаем');
    await request(port, 'GET', '/api/models'); assert.strictEqual(listCalls, 1, 'список закэширован, opencode не дёргается на каждый запрос');
    assert(fs.existsSync(path.join(data, 'models_free.json')), 'кэш списка на диске');
    r = await request(port, 'GET', '/models'); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.roles.length, 3);
    // сохранение
    r = await request(port, 'POST', '/api/models', { teacher: ' opencode/b-free ' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ok, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data, 'models.json'), 'utf8')).teacher, 'opencode/b-free');
    r = await request(port, 'GET', '/api/models'); assert.strictEqual(r.json.roles[1].model, 'opencode/b-free'); assert.strictEqual(r.json.roles[1].source, 'файл');
    r = await request(port, 'POST', '/models', { engineer: 'opencode/a-free', brain: 'opencode/b-free' }); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(M.read(data).models, { brain: 'opencode/b-free', teacher: 'opencode/b-free', engineer: 'opencode/a-free' });
    // отказы: роль неизвестна, пусто, не похоже на id, чужой сайт, не JSON, большой запрос
    const saved = fs.readFileSync(path.join(data, 'models.json'), 'utf8');
    for (const bad of [{ boss: 'opencode/x' }, { teacher: '' }, { teacher: 'просто слово' }, { teacher: 'opencode/x"; calc' }, {}, [], { teacher: 5 }, { teacher: 'opencode/ok-free', zzz: 'opencode/x' }]) {
      r = await request(port, 'POST', '/api/models', bad); assert.strictEqual(r.status, 400, JSON.stringify(bad)); assert.strictEqual(r.json.ok, false); assert(r.json.error);
    }
    r = await request(port, 'POST', '/api/models', 'не json'); assert.strictEqual(r.status, 400);
    r = await request(port, 'POST', '/api/models', { teacher: 'opencode/x-free' }, { Origin: 'http://evil.example' }); assert.strictEqual(r.status, 403);
    r = await request(port, 'POST', '/api/models', '{"teacher":"opencode/x-free"}', { 'Content-Type': 'text/plain' }); assert.strictEqual(r.status, 415);
    r = await request(port, 'POST', '/api/models', { teacher: 'opencode/' + 'x'.repeat(5000) }); assert.strictEqual(r.status, 413);
    r = await request(port, 'POST', '/api/models', { teacher: 'opencode/ok-free' }, { Host: 'evil.example' }); assert.strictEqual(r.status, 403, 'DNS-rebinding');
    assert.strictEqual(fs.readFileSync(path.join(data, 'models.json'), 'utf8'), saved, 'после отказов файл не тронут');
    // сторож: старый (без упоминания models.json) и новый
    fs.writeFileSync(path.join(data, 'guard.log'), '\ufeff[2026-10-22 08:00:00] сторож запущен: петля 1, инженер x, учитель y\r\n[2026-10-22 08:01:00] учитель: взял случай 1\r\n');
    assert.strictEqual((await request(port, 'GET', '/api/models')).json.guardReadsModels, false);
    fs.appendFileSync(path.join(data, 'guard.log'), '[2026-10-22 09:00:00] сторож запущен: петля 2, инженер x, учитель y (модели берутся из data\\models.json при каждом запуске роли)\r\n');
    assert.strictEqual((await request(port, 'GET', '/api/models')).json.guardReadsModels, true);
    // opencode не отвечает: список из кэша на диске; потом — без списка, но страница жива
    listResult = { ok: false, error: 'opencode не найден' }; running = null;
    r = await request(port, 'GET', '/api/models?refresh=1'); assert.strictEqual(r.json.free.from, 'кэш на диске'); assert.deepStrictEqual(r.json.free.list, ['opencode/a-free', 'opencode/b-free']); assert(/не найден/.test(r.json.free.error));
    assert.strictEqual(r.json.roles[0].running, null, 'не знаем, что запущено — не выдумываем');
    fs.rmSync(path.join(data, 'models_free.json'));
    r = await request(port, 'GET', '/api/models?refresh=1'); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.free.from, 'нет'); assert.deepStrictEqual(r.json.free.list, []);
    assert.strictEqual(r.json.roles[1].model, 'opencode/b-free', 'текущие значения показываются и без списка');
  } finally { srv.close(); if (srv.closeAllConnections) srv.closeAllConnections(); }
}

// сторож, night.cmd, teach.cmd и конфиги opencode читаются как текст: источник модели один
function testModelsWiring() {
  const root = path.join(__dirname, '..');
  const rd = f => fs.readFileSync(path.join(root, f), 'utf8');
  const guard = rd('brain_guard.ps1');
  assert(!/\[string\]\$(EngModel|TeachModel)/.test(guard), 'у сторожа нет параметров -EngModel/-TeachModel');
  assert(/RoleModel 'teacher'/.test(guard) && /RoleModel 'engineer'/.test(guard), 'модель берётся при каждом запуске роли');
  assert(/models_config\.js/.test(guard));
  assert(/-m \$teachModel/.test(guard) && /-m \$engModel/.test(guard), 'модель передаётся в opencode флагом -m');
  assert(!/\$(EngModel|TeachModel)\b/.test(guard.replace(/\$engModel|\$teachModel/g, '')), 'старых переменных не осталось');
  const night = rd('night.cmd'), teach = rd('teach.cmd');
  assert(/models_config\.js" get brain/.test(night), 'night.cmd читает модель мозга');
  assert(night.indexOf('models_config.js') > night.indexOf(':loop'), 'и делает это внутри петли — перед каждой сессией');
  assert(/-m %MODEL%/.test(night));
  assert(!/minimax|EngModel|TeachModel/.test(teach), 'teach.cmd не навязывает модели');
  for (const f of ['opencode.json', 'brain/opencode.teacher.json', 'brain/opencode.engineer.json']) assert(!('model' in JSON.parse(rd(f))), f + ': модель не задана в конфиге, чтобы не спорить с data/models.json');
  const html = rd('audit/index.html');
  assert(/\['models', 'Модели'\]/.test(html) && /id="p-models"/.test(html) && /models: \['\/api\/models', renderModels\]/.test(html), 'вкладка «Модели» подключена');
  assert(/function saveModel/.test(html) && /method: 'POST'/.test(html));
  assert(/server\.listen\(server\.cfg\.port, '127\.0\.0\.1'/.test(rd('audit/server.js')), 'аудит слушает только 127.0.0.1');
}

// Консоль ролей: разбор журналов opencode, время (точное и примерное), куски, сеансы сторожа, ошибки модели
async function testRoles(dir) {
  const R = require('../audit/roles');
  // 1) виды строк, ответы, дифф с пустой строкой внутри, метки времени
  const L = arr => { let off = 0; return arr.map(raw => { const o = { off, raw }; off += Buffer.byteLength(raw) + 1; return o; }); };
  const es = R.parseRoleLines(L([
    '> build · opencode/glm-5.3-flash-free',
    '[10:00:01] Смотрю, что с мухой.',
    '$ curl -s http://127.0.0.1:3199/snapshot',
    '{"ok":true,"health":20}',
    '',
    '→ Read brain/notes.md',
    '← Edit brain/notes.md',
    '@@ -1,2 +1,2 @@',
    '-старое',
    '',
    '+новое',
    '',
    '✗ bash failed',
    '',
    'Error: нельзя',
    '',
    ESC + '[31mкрасный текст' + ESC + '[0m'
  ]));
  const ks = es.map(e => e.k);
  assert.deepStrictEqual(ks, ['model', 'think', 'cmd', 'read', 'write', 'fail', 'err', 'think'], ks.join(','));
  assert.strictEqual(es[2].tag, 'тело · snapshot'); assert.deepStrictEqual(es[2].body, ['{"ok":true,"health":20}']);
  assert.deepStrictEqual(es[4].body, ['@@ -1,2 +1,2 @@', '-старое', '+новое'], 'дифф с пустой строкой — одна правка');
  assert.strictEqual(es[7].text, 'красный текст', 'ANSI убраны');
  // 2) время: метка — точно (назад от anchor), без метки — примерно внутри попытки
  const anchor = new Date(2026, 9, 22, 10, 5, 0).getTime();
  const S = new Date(2026, 9, 22, 9, 59, 0).getTime();
  R.assignTimes(es, { anchor, runs: [{ off: 0, end: 1000, S, E: anchor }] });
  assert.strictEqual(es[1].ts, new Date(2026, 9, 22, 10, 0, 1).getTime()); assert(!es[1].approx);
  assert(es[2].approx && es[2].ts >= S && es[2].ts <= anchor, 'без метки — примерно, в пределах сеанса');
  // 3) сеансы сторожа
  const ses = R.parseGuardSessions([
    '[2026-10-22 09:59:00] учитель: взял случай 20261022-1 (death, pid 11, модель opencode/m1)',
    '[2026-10-22 10:04:00] учитель: 20261022-1 — закончил (done)',
    '[2026-10-22 10:05:00] инженер: взял заявку chest (pid 12, модель opencode/m2)'
  ]);
  assert.strictEqual(ses.length, 2, JSON.stringify(ses));
  assert.strictEqual(ses[0].role, 'teacher'); assert.strictEqual(ses[0].log, 'teacher-20261022-1.log'); assert(ses[0].E > ses[0].S);
  assert.strictEqual(ses[1].role, 'engineer'); assert.strictEqual(ses[1].E, null); assert.strictEqual(ses[1].model, 'opencode/m2');
  // 4) ошибки модели из журнала opencode — к роли, чья модель в этот момент работала
  const ocText = [
    'timestamp=2026-10-22T07:06:00.000Z level=ERROR run=a message="stream error" modelID=m2 small=false error.error="AI_APICallError: Free usage limit reached. Subscribe"',
    'timestamp=2026-10-22T07:06:01.000Z level=ERROR run=a message="stream error" modelID=nano small=true error.error="AI_APICallError: Insufficient funds"',
    'timestamp=2026-10-22T07:06:02.000Z level=INFO run=a message="ok"'
  ].join('\n');
  const oe = R.parseOpencodeErrors(ocText);
  assert.strictEqual(oe.length, 1, 'small=true и INFO пропущены'); assert(/^Free usage limit reached/.test(oe[0].text));
  const at = R.attributeErrors([{ ...oe[0], ts: ses[1].S + 1000 }], ses, [], ses[1].S + 5000);
  assert.deepStrictEqual(at[0].roles, ['engineer']);
  // 5) файлы: куски журнала, from/before, API
  const data = path.join(dir, 'roles-data'), brain = path.join(dir, 'roles-brain');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(brain, 'skill_requests'), { recursive: true });
  const big = ['> build · opencode/m2'];
  for (let i = 0; i < 15000; i++) big.push('[10:05:' + String(i % 60).padStart(2, '0') + '] мысль номер ' + i, '');
  fs.writeFileSync(path.join(data, 'engineer-chest.log'), big.join('\n') + '\n');
  const now = new Date(), d2 = n => String(n).padStart(2, '0');
  const stamp = t => `${t.getFullYear()}-${d2(t.getMonth() + 1)}-${d2(t.getDate())} ${d2(t.getHours())}:${d2(t.getMinutes())}:${d2(t.getSeconds())}`;
  const took = new Date(now.getTime() - 60000);
  fs.writeFileSync(path.join(data, 'guard.log'), `[${stamp(new Date(now.getTime() - 3600e3))}] сторож запущен\n[${stamp(took)}] инженер: взял заявку chest (pid 12, модель opencode/m2)\n`);
  fs.writeFileSync(path.join(brain, 'skill_requests', 'chest.md'), '# Заявка: сундук\n');
  fs.writeFileSync(path.join(brain, 'skill_requests', 'chest.working'), '');
  const oc = path.join(dir, 'opencode.log');
  fs.writeFileSync(oc, ocText.replace('2026-10-22T07:06:00.000Z', new Date(took.getTime() + 2000).toISOString()));
  const cfg = { dataDir: data, brainDir: brain, root: path.join(__dirname, '..'), bodyUrl: 'http://127.0.0.1:1', runnerUrl: 'http://127.0.0.1:1', opencodeLog: oc,
    runningModels: async () => [{ pid: 12, role: 'engineer', model: 'opencode/m2' }], guardProcs: async () => [{ pid: 5 }] };
  const file = path.join(data, 'engineer-chest.log');
  const tail = R.readRoleLog(file, 'engineer', { max: 4096 });
  assert(tail.start > 0 && tail.entries.length > 10 && tail.entries.every(e => e.k === 'think'));
  const prev = R.readRoleLog(file, 'engineer', { before: tail.start, max: 4096 });
  assert(prev.entries.length && prev.entries[prev.entries.length - 1].off < tail.start, 'раньше — кусок до показанного');
  const rs = await A.api(cfg, 'roles', new URLSearchParams());
  assert(rs.engineer.working && rs.engineer.session.key === 'chest' && /сундук/.test(rs.engineer.what) && rs.engineer.model === 'opencode/m2', JSON.stringify(rs.engineer));
  assert(rs.engineer.modelError && /Free usage/.test(rs.engineer.modelError.text) && rs.engineer.modelError.fresh, 'ошибка модели видна у инженера');
  assert.strictEqual(rs.guard.working, true); assert.strictEqual(rs.teacher.working, false);
  const c1 = await A.api(cfg, 'console', new URLSearchParams('role=engineer'));
  assert(c1.ok && c1.file === 'engineer-chest.log' && c1.more && c1.entries.length > 100);
  const last = c1.entries[c1.entries.length - 1];
  fs.appendFileSync(file, '[10:06:00] новая строка\n');
  const c2 = await A.api(cfg, 'console', new URLSearchParams('role=engineer&file=engineer-chest.log&from=' + last.off));
  assert.strictEqual(c2.entries[0].off, last.off); assert.strictEqual(c2.entries[c2.entries.length - 1].text, 'новая строка');
  const bad = await A.api(cfg, 'console', new URLSearchParams('role=engineer&file=..%2F..%2Fsecret.log'));
  assert.strictEqual(bad.file, 'engineer-chest.log', 'чужой файл не открывается');
  const all = await A.api(cfg, 'console', new URLSearchParams('role=all'));
  assert(all.ok && all.entries.some(e => e.role === 'guard') && all.entries.some(e => e.role === 'engineer') && all.entries.some(e => e.k === 'modelerr'));
  for (let i = 1; i < all.entries.length; i++) assert(all.entries[i].ts >= all.entries[i - 1].ts, 'по времени');
  const same = await A.api(cfg, 'console', new URLSearchParams('role=all&sig=' + encodeURIComponent(all.sig)));
  assert(same.same, 'без изменений — пустой ответ');
  // навыки: тела и исполнителя нет — счёт вариантов с диска
  fs.writeFileSync(path.join(data, 'variants.json'), JSON.stringify({ stats: { melee: { '*': { kite: { n: 2, ok: 1, sum: 1.2 } } } }, recent: [] }));
  const sk = await A.api(cfg, 'skills', new URLSearchParams());
  assert(!sk.catalog.ok && sk.variants.from === 'диск' && sk.variants.stats.melee['*'].kite.n === 2);
  // новые события в ленте автопилота
  const rf = A.reflexFeed(A.parseEventLines([
    '{"id":1,"t":"10:00:00","type":"own_block_broken","at":[1,2,3],"block":"spruce_planks","now":"air","by":"mob:enderman"}',
    '{"id":2,"t":"10:00:01","type":"behavior_trouble","kind":"crash","why":"упало","score":{"faults":1,"crashes":2,"hangs":0},"lastGood":"v1"}'
  ], Date.UTC(2026, 9, 22, 10, 1, 0)), 10);
  assert(rf.some(x => x.who === 'свой блок' && /моб enderman/.test(x.text)), JSON.stringify(rf));
  assert(rf.some(x => x.who === 'поведение' && x.level === 'bad' && /откатить на v1/.test(x.text)));
  // страница
  const html = fs.readFileSync(path.join(__dirname, '..', 'audit', 'index.html'), 'utf8');
  assert(/\['console', 'Консоль ролей'\]/.test(html) && /\/api\/console\?role=/.test(html) && /\['skills', 'Навыки'\]/.test(html));
  assert(!/DeepSeek/.test(html), 'устаревшее «(DeepSeek)» убрано');
}

module.exports = async function testAudit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  try {
    testTail(dir);
    testTimes();
    testEvents();
    testNightLog();
    testSmallLogs();
    testFiles(dir);
    testObserverAndOwnerMsg();
    await testServer(dir);
    await testBlackboxAudit(dir);
    testModelsConfig(dir);
    testModelsParsing();
    await testModelsServer(dir);
    testModelsWiring();
    await testRoles(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('audit: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
