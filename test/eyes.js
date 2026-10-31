// «Глаза» мухи (lib/eyes.js, tools/eyes.js): без сети и ffmpeg. Разрезка потока JPEG, setup Live, склейка расшифровки и таймаут ответа
// на подделке WebSocket, учёт токенов за минуту, переподключение с handle, журнал и ротация, конфиг, выжимка для учителя.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../lib/eyes');
const T = require('../lib/teacher_triggers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (f, ms = 1000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('не дождались'); await sleep(5); } };

// ---------- JPEG ----------
function testSplitter() {
  const jpg = (n, fill) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);
  const a = jpg(50, 1), b = jpg(30, 2), c = jpg(10, 3);
  // кадр, разорванный между чанками (и маркер конца тоже)
  let s = new E.JpegSplitter();
  assert.deepStrictEqual(s.push(a.slice(0, 20)), []);
  assert.deepStrictEqual(s.push(a.slice(20, a.length - 1)), []);
  let r = s.push(a.slice(a.length - 1));
  assert.strictEqual(r.length, 1); assert(r[0].equals(a));
  // два кадра в одном чанке + начало третьего
  s = new E.JpegSplitter();
  r = s.push(Buffer.concat([Buffer.from([0x00, 0x11]), a, b, c.slice(0, 5)]));
  assert.strictEqual(r.length, 2); assert(r[0].equals(a) && r[1].equals(b), 'мусор перед кадром отброшен');
  r = s.push(c.slice(5)); assert.strictEqual(r.length, 1); assert(r[0].equals(c));
  // разорван внутри маркера начала
  s = new E.JpegSplitter();
  assert.deepStrictEqual(s.push(Buffer.from([0x01, 0xff])), []);
  r = s.push(Buffer.concat([Buffer.from([0xd8]), Buffer.alloc(4, 7), Buffer.from([0xff, 0xd9])]));
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].length, 8);
  // нескончаемый кадр не раздувает память
  s = new E.JpegSplitter(1000);
  s.push(Buffer.from([0xff, 0xd8])); s.push(Buffer.alloc(2000, 5));
  assert(s.buf.length <= 1000);
}

// ---------- setup ----------
function testSetup() {
  const cfg = { ...E.DEFAULTS };
  const m = E.buildSetup(cfg, 'промпт', null).setup;
  assert.strictEqual(m.model, 'models/gemini-3.8-live');
  assert.deepStrictEqual(m.generationConfig.responseModalities, ['AUDIO']);
  assert.strictEqual(m.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.strictEqual(m.generationConfig.maxOutputTokens, 1500);
  assert(!('thinkingConfig' in m.generationConfig), 'thinkingConfig только для thinking-моделей');
  assert.deepStrictEqual(m.outputAudioTranscription, {});
  assert.deepStrictEqual(m.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
  assert.deepStrictEqual(m.contextWindowCompression, { slidingWindow: { targetTokens: 4000 }, triggerTokens: 10000 });
  assert.deepStrictEqual(m.sessionResumption, {});
  assert.strictEqual(m.systemInstruction.parts[0].text, 'промпт');
  const js = JSON.stringify(E.buildSetup(cfg, 'x', null));
  assert(!/activity(Start|End)/.test(js) && !/"TEXT"/.test(js), 'без activityStart/End и TEXT');
  const th = E.buildSetup({ ...cfg, model: 'gemini-3.8-live-extended-thinking' }, 'x', 'H1').setup;
  assert.deepStrictEqual(th.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.deepStrictEqual(th.sessionResumption, { handle: 'H1' });
  assert.strictEqual(E.buildSetup({ ...cfg, model: 'models/foo' }, '', null).setup.model, 'models/foo');
  // сообщения кадра и вопроса
  assert.deepStrictEqual(E.frameMessage('QQ'), { realtimeInput: { video: { data: 'QQ', mimeType: 'image/jpeg' } } });
  assert.deepStrictEqual(E.questionMessage('?'), { clientContent: { turns: [{ role: 'user', parts: [{ text: '?' }] }], turnComplete: true } });
}

// ---------- подделка WebSocket ----------
class FakeWS {
  constructor(url) {
    this.url = url; this.sent = []; FakeWS.all.push(this); this.closed = false;
    setTimeout(() => this.onopen && this.onopen({}), 1);
  }
  send(s) {
    const m = JSON.parse(s); this.sent.push(m);
    if (m.setup) {
      if (FakeWS.refuseResume && m.setup.sessionResumption && m.setup.sessionResumption.handle) return setTimeout(() => this.drop(1007, 'bad handle'), 1);
      setTimeout(() => this.reply({ setupComplete: {} }), 1);
    }
  }
  reply(o, as) { const s = JSON.stringify(o); this.onmessage && this.onmessage({ data: as === 'blob' ? new Blob([s]) : as === 'ab' ? new TextEncoder().encode(s).buffer : s }); }
  drop(code, reason) { this.closed = true; this.onclose && this.onclose({ code, reason }); }
  close() { if (!this.closed) { this.closed = true; setTimeout(() => this.onclose && this.onclose({ code: 1000, reason: '' }), 1); } }
}
FakeWS.all = [];
const mkClient = (o = {}) => new E.LiveClient({ WS: FakeWS, key: 'SECRETKEY', cfg: { ...E.DEFAULTS }, getPrompt: () => 'P', connectTimeoutMs: 500, ...o });

async function testLive() {
  FakeWS.all = []; FakeWS.refuseResume = false;
  const c = mkClient();
  assert.strictEqual(await c.connect(), 'fresh');
  const ws = FakeWS.all[0];
  assert(/key=SECRETKEY/.test(ws.url));
  assert(ws.sent[0].setup, 'первым уходит setup');
  assert(c.sendFrame('AAA') && ws.sent[1].realtimeInput.video.data === 'AAA');
  // ответ: куски расшифровки (строка / Blob / ArrayBuffer), аудио выбрасывается, конец по turnComplete, usage в том же сообщении
  const p = c.ask('вопрос?', 1000);
  assert.strictEqual(ws.sent[2].clientContent.turns[0].parts[0].text, 'вопрос?');
  ws.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] } } });
  ws.reply({ serverContent: { outputTranscription: { text: 'Видно: ' } } });
  ws.reply({ serverContent: { outputTranscription: { text: 'лес.' } } }, 'blob');
  ws.reply({ serverContent: { outputTranscription: { text: ' Сверка: ок' } } }, 'ab');
  ws.reply({ sessionResumptionUpdate: { newHandle: 'H1', resumable: true } });
  ws.reply({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 3100, totalTokenCount: 3200 } });
  const r = await p;
  assert.strictEqual(r.text, 'Видно: лес. Сверка: ок');
  assert.deepStrictEqual(r.usage, { total: 3200, prompt: 3100 });
  assert(!r.timedOut && !r.error);
  assert.strictEqual(c.handle, 'H1');
  // нет turnComplete — по таймауту берём накопленное
  const p2 = c.ask('ещё?', 40);
  ws.reply({ serverContent: { outputTranscription: { text: 'Без изм' } } });
  const r2 = await p2;
  assert(r2.timedOut && r2.text === 'Без изм', JSON.stringify(r2));
  // хвост запоздавшего ответа не попадает в следующий вопрос
  ws.reply({ serverContent: { outputTranscription: { text: ' хвост' } } });
  ws.reply({ serverContent: { turnComplete: true } });
  await sleep(10);
  const p3 = c.ask('третий?', 1000);
  ws.reply({ serverContent: { outputTranscription: { text: 'чисто' }, turnComplete: true } });
  assert.strictEqual((await p3).text, 'чисто');
  // два вопроса сразу — второй отклонён
  const p4 = c.ask('a', 1000), p5 = await c.ask('b', 1000);
  assert(/ещё идёт/.test(p5.error));
  ws.reply({ serverContent: { turnComplete: true } }); await p4;
  c.close();
  assert((await c.ask('x', 50)).error, 'закрыто — вопрос не уходит');
  // setup без ответа -> таймаут подключения, ключа в ошибке нет
  const dead = class extends FakeWS { send() {} };
  const c2 = mkClient({ WS: dead, connectTimeoutMs: 30 });
  await assert.rejects(c2.connect(), e => /таймаут/.test(e.message) && !/SECRETKEY/.test(e.message));
}

async function testReconnect() {
  FakeWS.all = []; FakeWS.refuseResume = false;
  const c = mkClient();
  await c.connect();
  let closed = null; c.on('close', i => { closed = i; });
  const goaway = []; c.on('goaway', g => goaway.push(g));
  FakeWS.all[0].reply({ sessionResumptionUpdate: { newHandle: 'H7', resumable: true } });
  FakeWS.all[0].reply({ goAway: { timeLeft: '50s' } });
  FakeWS.all[0].reply({ sessionResumptionUpdate: { newHandle: 'LOST', resumable: false } });   // нельзя продолжить — handle не меняем
  await waitFor(() => goaway.length === 1);
  assert.strictEqual(c.handle, 'H7');
  FakeWS.all[0].drop(1011, 'обрыв');
  await waitFor(() => closed);
  assert.strictEqual(closed.code, 1011); assert(!c.ready);
  // переподключение: setup идёт с handle
  assert.strictEqual(await c.connect(), 'resumed');
  const s2 = FakeWS.all[1].sent[0].setup;
  assert.deepStrictEqual(s2.sessionResumption, { handle: 'H7' });
  assert.strictEqual(c.resumed, 1);
  // сервер не принял handle — подключаемся с нуля
  FakeWS.refuseResume = true;
  FakeWS.all[1].drop(1006, '');
  assert.strictEqual(await c.connect(), 'fresh');
  const last = FakeWS.all[FakeWS.all.length - 1].sent[0].setup;
  assert.deepStrictEqual(last.sessionResumption, {});
  assert.strictEqual(c.handle, null);
  // закрытие во время вопроса не вешает вопрос
  const p = c.ask('q', 2000);
  FakeWS.all[FakeWS.all.length - 1].reply({ serverContent: { outputTranscription: { text: 'часть' } } });
  FakeWS.all[FakeWS.all.length - 1].drop(1006, 'x');
  const r = await p; assert.strictEqual(r.text, 'часть'); assert(r.error);
}

// ---------- токены, пауза, вопрос ----------
function testMeter() {
  const m = new E.TokenMeter();
  assert(m.canAsk(0));
  m.record(1000, 20000); m.record(10000, 20000);
  assert.strictEqual(m.used(20000), 40000);
  assert.strictEqual(m.lastCost, 20000);
  assert(!m.canAsk(20000), '55000-40000 < 20000 — откладываем');
  assert(m.waitMs(20000) > 0 && m.waitMs(20000) <= 41000, String(m.waitMs(20000)));
  assert.strictEqual(m.frameEvery(20000), 4, 'близко к потолку — кадры реже');
  assert.strictEqual(m.used(65000), 20000, 'старше минуты выпало');
  assert(m.canAsk(65000));
  assert.strictEqual(m.frameEvery(65000), 2, 'осталось меньше двух вопросов — вдвое реже');
  assert.strictEqual(m.frameEvery(80000), 1);
  assert.strictEqual(m.used(80000), 0);
  const b = new E.Backoff();
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8].map(() => b.next()), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  b.reset(); assert.strictEqual(b.next(), 2000);
  assert(E.isQuotaError('RESOURCE_EXHAUSTED') && E.isQuotaError('HTTP 429') && !E.isQuotaError('1007 not supported'));
}

function testQuestion() {
  const events = [{ id: 1, type: 'task_done', name: 'goto' }, { id: 2, type: 'danger', kind: 'enemy', name: 'zombie' }, { id: 3, type: 'info' }, { id: 4, type: 'death', cause: 'lava' }];
  const QUIET = require('../lib/events').QUIET;
  assert.strictEqual(E.pickEvent(events, QUIET).type, 'death');
  assert.strictEqual(E.pickEvent(events.slice(0, 3), QUIET).type, 'danger');
  assert.strictEqual(E.pickEvent([{ type: 'info' }, { type: 'progress_idle' }, { type: 'danger', sync: true }], QUIET), null);
  const base = { now: 100000, lastAskAt: 90000, askEverySec: 30, event: null };
  assert.strictEqual(E.dueReason(base), null);
  assert.strictEqual(E.dueReason({ ...base, lastAskAt: 70000 }), 'таймер');
  assert.strictEqual(E.dueReason({ ...base, event: { type: 'death' } }), 'событие death', 'прошло 10 с — сразу');
  assert.strictEqual(E.dueReason({ ...base, lastAskAt: 95000, event: { type: 'death' } }), null, 'чаще раза в 10 с нельзя');
  const raw = {
    task: { task: { name: 'collect', status: 'running', progress: 'log 3/8', sec: 14 } },
    autopilot: { autopilot: { on: true, doing: 'добыча дерева', build: { name: 'hut', status: 'добираю 4 planks' } } },
    snapshot: { ready: true, health: 14.2, food: 17, position: { x: 10.4, y: 64, z: -3.6 }, heldItem: { name: 'stone_axe' }, lightLevel: 3, eyes: { time: { phase: 'ночь' } } },
    events: [{ type: 'danger', kind: 'enemy', name: 'zombie' }], chat: [{ text: 'иду за деревом' }]
  };
  const ctx = E.bodyContext(raw);
  assert(ctx.length <= 600 && /collect/.test(ctx) && /HP 14/.test(ctx) && /иду за деревом/.test(ctx) && /danger enemy/.test(ctx) && ctx.includes('свет у мухи 3/15 (для неё темно), ночь'), ctx);
  assert(E.bodyContext({ chat: [{ text: 'x'.repeat(5000) }] }).length <= 600);
  assert.strictEqual(E.bodyContext(null), 'данные мухи недоступны');
  assert.strictEqual(E.bodyContext({ task: null, autopilot: null, snapshot: null }), 'данные мухи недоступны');
  const q = E.buildQuestion({ sec: 31.4, reason: 'событие death', body: ctx });
  assert(/^Что было с прошлого вопроса \(≈31 с\)\? Повод: событие death\. Муха сама сообщает: /.test(q) && /Ответь по формату\.$/.test(q), q);
  assert(/Повод: таймер/.test(E.buildQuestion({ sec: 30, reason: 'таймер', body: null })) && /данные мухи недоступны/.test(E.buildQuestion({ sec: 30, reason: 'таймер', body: null })));
  // промпт глаз на месте и со всеми разделами
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'brain', 'EYES_PROMPT.md'), 'utf8');
  assert(/«глаза» Minecraft-бота/.test(prompt) && /Без изменений/.test(prompt) && /Сверка:/.test(prompt));
}

// ---------- журнал, статус, конфиг ----------
function testArchive() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-arch-')), dir = path.join(tmp, 'arch'), log = path.join(tmp, 'eyes.log');
  fs.writeFileSync(log + '.1', '[2026-10-29 23:59:00] (таймер) старое\n');
  fs.writeFileSync(log, '[2026-10-30 00:01:00] (таймер) вчера-сегодня\nмусор без даты\n');
  assert.strictEqual(E.archiveSeed(dir, log), 2, 'перенесены строки с датой');
  assert.strictEqual(E.archiveSeed(dir, log), 0, 'второй раз — ничего (архив уже есть)');
  assert(fs.existsSync(path.join(dir, '2026-10-29.log.gz')) && !fs.existsSync(path.join(dir, '2026-10-29.log')), 'прошлый день сжат');
  E.archiveLine(dir, '[2026-10-30 12:00:00] (событие death) умерла');
  E.archiveLine(dir, '[2026-10-31 08:00:00] (таймер) утро');
  assert(fs.existsSync(path.join(dir, '2026-10-30.log.gz')) && fs.existsSync(path.join(dir, '2026-10-31.log')), 'новый день сжал вчерашний');
  assert.strictEqual(E.readArchiveDay(dir, '2026-10-29'), '[2026-10-29 23:59:00] (таймер) старое\n');
  assert(/вчера-сегодня[\s\S]*умерла/.test(E.readArchiveDay(dir, '2026-10-30')), 'день читается из .gz');
  assert(!E.archiveLine(dir, 'без даты'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
function testLog() {
  const d = tmp(), f = path.join(d, 'eyes.log');
  const ms = new Date(2026, 9, 29, 14, 5, 9).getTime();
  assert.strictEqual(E.logLine(ms, 'таймер', 'Видно: лес.\nСверка: ок'), '[2026-10-29 14:05:09] (таймер) Видно: лес. Сверка: ок');
  assert.strictEqual(E.logLine(ms, 'событие danger', 'Без изменений'), '[2026-10-29 14:05:09] (событие danger) Без изменений');
  assert.strictEqual(E.logLine(ms, undefined, ''), '[2026-10-29 14:05:09] (таймер) (пустой ответ)');
  // ротация при лимите
  assert(E.appendLog(f, 'aaaa', 15)); assert(E.appendLog(f, 'bbbb', 15)); assert(E.appendLog(f, 'cccccccc', 15));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'aaaa\nbbbb\ncccccccc\n', 'до лимита — просто дописываем');
  assert(!fs.existsSync(f + '.1'));
  E.appendLog(f, 'dddd', 15);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'dddd\n');
  assert.strictEqual(fs.readFileSync(f + '.1', 'utf8'), 'aaaa\nbbbb\ncccccccc\n', 'старый журнал уехал в .1');
  fs.writeFileSync(f, 'xxxxxxxxxxxxxxxxxxxx\n'); E.appendLog(f, 'eeee', 15);
  assert.strictEqual(fs.readFileSync(f + '.1', 'utf8'), 'xxxxxxxxxxxxxxxxxxxx\n', '.1 перезаписывается');
  assert.strictEqual(E.LOG_MAX, 2 * 1024 * 1024);
  // статус пишется целиком
  const sf = path.join(d, 'eyes_status.json');
  assert(E.writeStatus(sf, { state: 'watching', reconnects: 2 }));
  assert.strictEqual(JSON.parse(fs.readFileSync(sf, 'utf8')).state, 'watching');
  assert(!fs.readdirSync(d).some(n => /tmp/.test(n)), 'временный файл переименован');
  // ключ не светится
  assert.strictEqual(E.redact('wss://x/y?key=SECRETKEY&a=1 SECRETKEY', 'SECRETKEY'), 'wss://x/y?key=*** &a=1 ***'.replace('*** &', '***&'));
}

function testConfig() {
  const d = tmp(), f = path.join(d, 'eyes.json');
  assert.deepStrictEqual(E.readConfig(f), E.DEFAULTS, 'нет файла');
  fs.writeFileSync(f, '{мусор'); assert.deepStrictEqual(E.readConfig(f), E.DEFAULTS, 'мусор');
  fs.writeFileSync(f, '[1,2]'); assert.deepStrictEqual(E.readConfig(f), E.DEFAULTS, 'не объект');
  fs.writeFileSync(f, '﻿' + JSON.stringify({ model: 'gemini-3.8-live-extended-thinking', window: ' Minecraft 26.1 ', fps: 2, width: 800, askEverySec: 45, maxOutputTokens: 300 }));
  assert.deepStrictEqual(E.readConfig(f), { ...E.DEFAULTS, model: 'gemini-3.8-live-extended-thinking', window: 'Minecraft 26.1', fps: 2, width: 800, askEverySec: 45, maxOutputTokens: 300 }, 'BOM');
  fs.writeFileSync(f, JSON.stringify({ model: 'плохая модель; rm', fps: 'много', width: 99999, askEverySec: 1, maxOutputTokens: null, window: 5 }));
  const c = E.readConfig(f);
  assert.strictEqual(c.model, E.DEFAULTS.model); assert.strictEqual(c.fps, E.DEFAULTS.fps);
  assert.strictEqual(c.width, 1920, 'в пределы'); assert.strictEqual(c.askEverySec, 10);
  assert.strictEqual(c.maxOutputTokens, 1500); assert.strictEqual(c.window, '');
  // настройки клиента-наблюдателя: значения по умолчанию, проверка типов и пределов
  assert.strictEqual(E.DEFAULTS.autoClient, true); assert.strictEqual(E.DEFAULTS.capture, 'gfx');
  fs.writeFileSync(f, JSON.stringify({ autoClient: false, capture: 'gdi', clientMemoryMb: 100, lanPort: 25570.4, lanHost: 'bad host;', world: 'D:\\w', clientVersion: '26.1.2' }));
  const k = E.readConfig(f);
  assert.strictEqual(k.autoClient, false); assert.strictEqual(k.capture, 'gdi');
  assert.strictEqual(k.clientMemoryMb, 512, 'память в пределы'); assert.strictEqual(k.lanPort, 25570);
  assert.strictEqual(k.lanHost, E.DEFAULTS.lanHost, 'плохой хост отброшен'); assert.strictEqual(k.clientVersion, '26.1.2');
  fs.writeFileSync(f, JSON.stringify({ autoClient: 'да', capture: 'x11', lanPort: 99999 }));
  const k2 = E.readConfig(f);
  assert.strictEqual(k2.autoClient, true, 'не boolean -> по умолчанию'); assert.strictEqual(k2.capture, 'gfx'); assert.strictEqual(k2.lanPort, 65535);
  // ключ: из окружения; без него — из auth.json
  assert.strictEqual(E.readKey({ GEMINI_API_KEY: ' abc ' }), 'abc');
  const home = tmp(); fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), '﻿{"google":{"type":"api","key":"k-from-file"}}');
  assert.strictEqual(E.readKey({ USERPROFILE: home }), 'k-from-file');
  assert.strictEqual(E.readKey({ USERPROFILE: tmp() }), null);
}

// ---------- выжимка для учителя ----------
function testTeacher() {
  const d = tmp();
  const base = new Date(2026, 9, 29, 15, 0, 0).getTime();
  const line = (off, reason, text) => E.logLine(base + off * 1000, reason, text);
  const rows = [
    line(-400, 'таймер', 'слишком давно'),                       // раньше окна (−5 мин)
    line(-200, 'таймер', 'Видно: пещера.'),
    line(-170, 'таймер', 'Без изменений'),
    line(-140, 'таймер', 'Без изменений'),
    line(-110, 'таймер', 'Без изменений.'),
    line(-80, 'таймер', 'Без изменений'),
    line(10, 'событие death', 'Видно: лава. Сверка: пишет: иду; на деле: стоит.'),
    line(30, 'таймер', 'Без изменений'),
    line(50, 'таймер', 'Видно: темно.'),
    line(300, 'таймер', 'позже окна')                           // позже (+1 мин от сигнала)
  ];
  const lines = E.eyesForCase(d, 0, Infinity);
  assert.deepStrictEqual(lines, [], 'нет журнала — пусто');
  fs.writeFileSync(path.join(d, 'eyes.log'), rows.slice(5).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'eyes.log.1'), rows.slice(0, 5).join('\n') + '\n');    // старая часть — в .1
  const w = E.eyesForCase(d, base - 300000, base + 60000);
  assert.strictEqual(w.length, 5, w.join('\n'));
  assert(/Видно: пещера/.test(w[0]));
  assert.strictEqual(w[1], 'Без изменений ×4 (с 14:57 по 14:58)');
  assert(/лава/.test(w[2]) && /^\[2026-10-29 15:00:10\] \(событие death\)/.test(w[2]));
  assert.strictEqual(w[3], '[2026-10-29 15:00:30] (таймер) Без изменений', 'одиночную не склеиваем');
  assert(/темно/.test(w[4]));
  // лимиты: 40 строк и ~8 КБ, свежие важнее
  const many = []; for (let i = 0; i < 100; i++) many.push(line(i, 'таймер', 'Запись номер ' + i + ' ' + 'я'.repeat(300)));
  fs.writeFileSync(path.join(d, 'eyes.log'), many.join('\n') + '\n'); fs.rmSync(path.join(d, 'eyes.log.1'));
  const cut = E.eyesForCase(d, base - 1000, base + 200000);
  assert(cut.length <= 40 && cut.reduce((s, x) => s + Buffer.byteLength(x) + 1, 0) <= 8 * 1024, cut.length + ' строк');
  assert(/номер 99 /.test(cut[cut.length - 1]));

  // lib/teacher_triggers: поле eyes в материалах случая
  const root = tmp(), dataDir = path.join(root, 'data'), brainDir = path.join(root, 'brain');
  fs.mkdirSync(path.join(dataDir, 'blackbox'), { recursive: true }); fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'events.log'), '{"id":1,"t":"10:00:00","type":"info"}\n'); fs.writeFileSync(path.join(brainDir, 'runner.log'), '');
  let now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const cfg = { dataDir, brainDir, now: () => now, neighborDir: null };
  T.scan(cfg);
  const t0 = now;                                                  // сигнал: смерть
  fs.appendFileSync(path.join(dataDir, 'events.log'), JSON.stringify({ id: 2, t: new Date(now).toISOString().slice(11, 19), type: 'death', cause: 'lava' }) + '\n');
  const L = (off, reason, text) => E.logLine(t0 + off * 1000, reason, text);
  fs.writeFileSync(path.join(dataDir, 'eyes.log'), [
    L(-400, 'таймер', 'вне окна до'), L(-250, 'таймер', 'Видно: туннель.'), L(-200, 'таймер', 'Без изменений'), L(-150, 'таймер', 'Без изменений'),
    L(5, 'событие death', 'Видно: лава.'), L(50, 'таймер', 'Проблема: в лаве.'), L(400, 'таймер', 'вне окна после')
  ].join('\n') + '\n');
  now += 20000; T.scan(cfg); now += 100000; T.scan(cfg);
  const r = T.take(cfg);
  assert.strictEqual(r.type, 'death', JSON.stringify(r));
  const mat = JSON.parse(fs.readFileSync(path.join(root, r.caseFile), 'utf8'));
  assert.deepStrictEqual(mat.eyes.map(x => x.replace(/^\[[^\]]*\] /, '')), ['(таймер) Видно: туннель.', 'Без изменений ×2 (с ' + E.stampLocal(t0 - 200000).slice(11, 16) + ' по ' + E.stampLocal(t0 - 150000).slice(11, 16) + ')', '(событие death) Видно: лава.', '(таймер) Проблема: в лаве.']);
  // нет журнала — нет поля
  fs.rmSync(path.join(dataDir, 'eyes.log'));
  const root2 = tmp(), d2 = path.join(root2, 'data'), b2 = path.join(root2, 'brain');
  fs.mkdirSync(path.join(d2, 'blackbox'), { recursive: true }); fs.mkdirSync(b2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'events.log'), '{"id":1,"t":"10:00:00","type":"info"}\n'); fs.writeFileSync(path.join(b2, 'runner.log'), '');
  const cfg2 = { dataDir: d2, brainDir: b2, now: () => now, neighborDir: null };
  T.scan(cfg2);
  fs.appendFileSync(path.join(d2, 'events.log'), JSON.stringify({ id: 2, t: new Date(now).toISOString().slice(11, 19), type: 'death', cause: 'x' }) + '\n');
  now += 20000; T.scan(cfg2); now += 100000; T.scan(cfg2);
  const r2 = T.take(cfg2);
  assert(!('eyes' in JSON.parse(fs.readFileSync(path.join(root2, r2.caseFile), 'utf8'))), 'без журнала поля eyes нет');
}

(async () => {
  testSplitter(); testSetup();
  await testLive(); await testReconnect();
  testMeter(); testQuestion(); testLog(); testArchive(); testConfig(); testTeacher();
  console.log('eyes: ok');
})().catch(e => { console.error(e); process.exit(1); });
