// «Глаза» мухи: чистая логика для tools/eyes.js (процессы ffmpeg, HTTP к телу и настоящая сеть — там; здесь всё проверяется без сети).
// Что тут: конфиг, разрезка потока JPEG, setup и клиент Gemini Live (WebSocket подставляется), учёт токенов за минуту,
// пауза переподключений, вопрос с контекстом мухи, журнал data/eyes.log с ротацией, статус, выжимка журнала для учителя.
// Ключ нигде не печатается и в журналы не пишется (redact).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

// maxOutputTokens считается в АУДИО-токенах (Live отвечает голосом, мы берём расшифровку): 250 — это одна фраза, 1500 — 5 строк с запасом
// Вторая половина — клиент-наблюдатель и захват окна (lib/eyes_client.js): autoClient false = окно открывает хозяин сам (тогда window — часть заголовка);
// capture 'gfx' (Windows Graphics Capture, снимает и перекрытое окно) | 'gdi' (gdigrab, пиксели экрана — запасной); world — папка мира для датапака;
// metaDir/java пусто = искать в Modrinth (%APPDATA%\ModrinthApp\meta), java из PATH — запасная.
const DEFAULT_WORLD = 'C:\\Users\\user\\AppData\\Roaming\\ModrinthApp\\profiles\\Vulkan Optimization\\saves\\muha 0_2';
const DEFAULTS = {
  model: 'gemini-3.8-live', window: '', fps: 1, width: 640, askEverySec: 30, maxOutputTokens: 1500,
  autoClient: true, capture: 'gfx', clientVersion: '26.1', clientMemoryMb: 2048, lanHost: 'localhost', lanPort: 25565,
  world: DEFAULT_WORLD, metaDir: '', java: ''
};
const LIMITS = { fps: [0.2, 5], width: [160, 1920], askEverySec: [10, 3600], maxOutputTokens: [300, 4000], clientMemoryMb: [512, 16384], lanPort: [1, 65535] };
const HOST_PATH = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const TOKENS_PER_MIN = 65000, TOKENS_SOFT = 55000;      // лимит провайдера и наш потолок
// каждый вопрос Live считает весь контекст: при 20K/8K три вопроса в минуту съедали лимит 55K (30.10 вопросы откладывались). 10K/4K — ~40 с кадров в памяти
const COMPRESS = { triggerTokens: 10000, targetTokens: 4000 };
const LOG_MAX = 2 * 1024 * 1024;
const MIN_EVENT_GAP_MS = 10000;

const pad = n => String(n).padStart(2, '0');
const oneLine = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return n && s.length > n ? s.slice(0, n - 1) + '…' : s; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- конфиг ----------
function readJson(file) {
  try {
    let s = fs.readFileSync(file, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // BOM, если файл правили PowerShell-ом
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}
// нет файла или мусор — значения по умолчанию (поле за полем)
function readConfig(file) {
  const raw = readJson(file), cfg = { ...DEFAULTS };
  if (typeof raw.model === 'string' && /^(models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw.model.trim())) cfg.model = raw.model.trim();
  if (typeof raw.window === 'string') cfg.window = raw.window.trim().slice(0, 200);
  for (const k of Object.keys(LIMITS)) {
    const v = Number(raw[k]);
    if (raw[k] != null && raw[k] !== '' && Number.isFinite(v)) cfg[k] = clamp(v, LIMITS[k][0], LIMITS[k][1]);
  }
  cfg.clientMemoryMb = Math.round(cfg.clientMemoryMb); cfg.lanPort = Math.round(cfg.lanPort);
  if (typeof raw.autoClient === 'boolean') cfg.autoClient = raw.autoClient;
  if (raw.capture === 'gfx' || raw.capture === 'gdi') cfg.capture = raw.capture;
  if (typeof raw.clientVersion === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/.test(raw.clientVersion.trim())) cfg.clientVersion = raw.clientVersion.trim();
  if (typeof raw.lanHost === 'string' && /^[A-Za-z0-9.-]{1,100}$/.test(raw.lanHost.trim())) cfg.lanHost = raw.lanHost.trim();
  for (const k of ['world', 'metaDir', 'java']) if (typeof raw[k] === 'string' && raw[k].trim()) cfg[k] = raw[k].trim().slice(0, 400);
  return cfg;
}

// ---------- ключ ----------
function readKey(env = process.env) {
  if (env.GEMINI_API_KEY && String(env.GEMINI_API_KEY).trim()) return String(env.GEMINI_API_KEY).trim();
  const home = env.USERPROFILE || env.HOME || '';
  const j = readJson(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  const k = j.google && j.google.key;
  return typeof k === 'string' && k.trim() ? k.trim() : null;
}
const redact = (s, key) => { s = String(s == null ? '' : s); if (key) s = s.split(key).join('***'); return s.replace(/([?&]key=)[^&\s"']+/g, '$1***'); };

// ---------- поток JPEG ----------
// ffmpeg пишет mjpeg подряд в stdout; кадр — от FFD8 до FFD9. Чанки режутся как угодно.
class JpegSplitter {
  constructor(maxBuf = 4 * 1024 * 1024) { this.buf = Buffer.alloc(0); this.max = maxBuf; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    for (;;) {
      const s = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (s < 0) { this.buf = this.buf.length && this.buf[this.buf.length - 1] === 0xff ? this.buf.slice(-1) : Buffer.alloc(0); break; }
      const e = this.buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
      if (e < 0) { this.buf = s > 0 ? this.buf.slice(s) : this.buf; if (this.buf.length > this.max) this.buf = Buffer.alloc(0); break; }
      frames.push(this.buf.slice(s, e + 2));
      this.buf = this.buf.slice(e + 2);
    }
    return frames;
  }
}

// ---------- setup Live ----------
const isThinking = model => /thinking/i.test(String(model));
const modelName = model => String(model).startsWith('models/') ? String(model) : 'models/' + model;
// Проверено вручную: TEXT-ответ не поддержан — только AUDIO + расшифровка; activityStart/End с video дают 1007, поэтому автодетект выключен без них.
function buildSetup(cfg, prompt, handle) {
  const gen = { responseModalities: ['AUDIO'], mediaResolution: 'MEDIA_RESOLUTION_LOW', maxOutputTokens: cfg.maxOutputTokens };
  if (isThinking(cfg.model)) gen.thinkingConfig = { thinkingLevel: 'low' };
  return {
    setup: {
      model: modelName(cfg.model),
      generationConfig: gen,
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      contextWindowCompression: { slidingWindow: { targetTokens: COMPRESS.targetTokens }, triggerTokens: COMPRESS.triggerTokens },
      sessionResumption: handle ? { handle } : {},
      systemInstruction: { parts: [{ text: String(prompt || '') }] }
    }
  };
}
const frameMessage = b64 => ({ realtimeInput: { video: { data: b64, mimeType: 'image/jpeg' } } });
const questionMessage = text => ({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });

// сообщение сервера: строка, Blob, ArrayBuffer, Buffer -> объект (или null)
async function parseMessage(data) {
  try {
    let s;
    if (typeof data === 'string') s = data;
    else if (data && typeof data.text === 'function') s = await data.text();            // Blob
    else if (data instanceof ArrayBuffer) s = Buffer.from(data).toString('utf8');
    else if (ArrayBuffer.isView(data)) s = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    else s = String(data);
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch (e) { return null; }
}

const QUOTA_RE = /quota|429|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i;
const isQuotaError = s => QUOTA_RE.test(String(s || ''));

// ---------- клиент Live ----------
// События: 'close' {code, reason}, 'goaway' {timeLeft}, 'usage' {total, prompt}, 'error' строка.
class LiveClient extends EventEmitter {
  constructor(o) {
    super();
    this.WS = o.WS || globalThis.WebSocket;
    this.key = o.key || '';
    this.url = o.url || `${HOST_PATH}?key=${encodeURIComponent(this.key)}`;
    this.cfg = o.cfg;
    this.getPrompt = o.getPrompt || (() => '');
    this.connectTimeoutMs = o.connectTimeoutMs || 15000;
    this.handle = o.handle || null;
    this.ready = false; this.ws = null; this.pending = null; this.draining = false;
    this.lastUsage = null; this.chain = Promise.resolve();
    this.resumed = 0;
  }

  // Одна попытка. Возвращает 'resumed' | 'fresh'; при неудаче — Error без ключа.
  _open(handle) {
    return new Promise((resolve, reject) => {
      let done = false, ws;
      const fail = err => { if (done) return; done = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} reject(err); };
      const timer = setTimeout(() => fail(new Error('таймаут подключения')), this.connectTimeoutMs);
      try { ws = new this.WS(this.url); } catch (e) { return fail(new Error(redact(e && e.message || e, this.key))); }
      this.ws = ws; this.ready = false; this.goAway = false;
      ws.onopen = () => { try { ws.send(JSON.stringify(buildSetup(this.cfg, this.getPrompt(), handle))); } catch (e) { fail(new Error('не отправился setup')); } };
      ws.onerror = ev => { this.lastErr = redact(ev && (ev.message || (ev.error && ev.error.message)) || 'ошибка сокета', this.key); };
      ws.onclose = ev => {
        const info = { code: ev && ev.code, reason: redact(ev && ev.reason || '', this.key) };
        if (ws !== this.ws) return;
        // сначала разбираем уже пришедшие сообщения (они обрабатываются асинхронно), потом закрытие
        this.chain = this.chain.then(() => {
          if (ws !== this.ws) return;
          const was = this.ready; this.ready = false;
          if (!done) return fail(new Error(`закрыто до готовности: ${info.code || ''} ${info.reason || this.lastErr || ''}`.trim()));
          this._finishAsk(true, 'соединение закрыто');
          if (was) this.emit('close', info);
        }).catch(() => {});
      };
      ws.onmessage = ev => {
        this.chain = this.chain.then(async () => {
          const m = await parseMessage(ev && ev.data);
          if (!m) return;
          if (m.setupComplete !== undefined && !this.ready) {
            if (done) return; done = true; clearTimeout(timer); this.ready = true; resolve(handle ? 'resumed' : 'fresh'); return;
          }
          this._onServer(m);
        }).catch(() => {});
      };
    });
  }

  // С handle (продолжение контекста); не вышло — с нуля. Бросает, если не вышло и так.
  async connect() {
    this.close();
    if (this.handle) {
      try { const r = await this._open(this.handle); this.resumed++; return r; }
      catch (e) { this.lastResumeError = e.message; this.handle = null; }
    }
    return this._open(null);
  }

  close() { const ws = this.ws; this.ws = null; this.ready = false; this._finishAsk(true, 'закрыто'); if (ws) { try { ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null; ws.close(); } catch (e) {} } }

  _onServer(m) {
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.newHandle && u.resumable !== false) this.handle = u.newHandle;
    }
    if (m.goAway) this.emit('goaway', m.goAway);
    if (m.error) this.emit('error', redact(m.error.message || JSON.stringify(m.error), this.key).slice(0, 300));
    if (m.usageMetadata) {
      const u = m.usageMetadata;
      this.lastUsage = { total: Number(u.totalTokenCount) || 0, prompt: Number(u.promptTokenCount) || 0 };
      this.emit('usage', this.lastUsage);
    }
    const sc = m.serverContent;
    if (!sc) return;
    const t = sc.outputTranscription && sc.outputTranscription.text;
    if (typeof t === 'string' && this.pending && !this.draining) this.pending.text += t;   // аудио (modelTurn.inlineData) выбрасываем
    if (sc.turnComplete) {
      if (this.draining) this.draining = false;
      this._finishAsk(false);
    }
  }

  sendFrame(b64) {
    if (!this.ready || !this.ws) return false;
    try { this.ws.send(JSON.stringify(frameMessage(b64))); return true; } catch (e) { return false; }
  }

  // Вопрос -> { text, usage, timedOut, error }. Ответ закончен по turnComplete; нет его за timeoutMs — берём накопленное.
  ask(text, timeoutMs = 30000) {
    return new Promise(resolve => {
      if (!this.ready || !this.ws) return resolve({ text: '', usage: null, timedOut: false, error: 'нет соединения' });
      if (this.pending) return resolve({ text: '', usage: null, timedOut: false, error: 'предыдущий вопрос ещё идёт' });
      this.draining = false; this.lastUsage = null;
      this.pending = { text: '', resolve, timer: setTimeout(() => this._finishAsk(false, null, true), timeoutMs) };
      try { this.ws.send(JSON.stringify(questionMessage(text))); }
      catch (e) { this._finishAsk(true, 'не отправился вопрос'); }
    });
  }

  _finishAsk(failed, error, timedOut = false) {
    const p = this.pending; if (!p) return;
    this.pending = null; clearTimeout(p.timer);
    if (timedOut) this.draining = true;       // запоздавший хвост ответа не должен попасть в следующий
    p.resolve({ text: p.text.replace(/\s+/g, ' ').trim(), usage: this.lastUsage, timedOut, ...(failed || error ? { error: error || 'ошибка' } : {}) });
  }
}

// ---------- пауза переподключений: 2 -> 4 -> … -> 60 с ----------
class Backoff {
  constructor(min = 2000, max = 60000) { this.min = min; this.max = max; this.cur = 0; }
  next() { this.cur = this.cur ? Math.min(this.max, this.cur * 2) : this.min; return this.cur; }
  reset() { this.cur = 0; }
}

// ---------- токены за скользящую минуту ----------
class TokenMeter {
  constructor(o = {}) { this.soft = o.soft || TOKENS_SOFT; this.hard = o.hard || TOKENS_PER_MIN; this.items = []; this.lastCost = o.firstCost || 6000; }
  _trim(now) { const cut = now - 60000; while (this.items.length && this.items[0].t <= cut) this.items.shift(); }
  record(now, tokens) { tokens = Math.max(0, Number(tokens) || 0); if (!tokens) return; this.items.push({ t: now, tokens }); this.lastCost = tokens; this._trim(now); }
  used(now) { this._trim(now); return this.items.reduce((s, x) => s + x.tokens, 0); }
  // можно ли задать вопрос: до потолка остаётся не меньше, чем ушло на прошлый вопрос
  canAsk(now) { return this.soft - this.used(now) >= this.lastCost; }
  // когда в следующий раз стоит попробовать (мс): пока из окна не выпадет достаточно
  waitMs(now) {
    if (this.canAsk(now)) return 0;
    let used = this.used(now);
    for (const x of this.items) { used -= x.tokens; if (this.soft - used >= this.lastCost) return Math.max(1000, x.t + 60000 - now); }
    return 60000;
  }
  // через сколько кадров слать один: при подходе к потолку кадров меньше (1 — каждый)
  frameEvery(now) { const left = this.soft - this.used(now); return left < this.lastCost ? 4 : left < 2 * this.lastCost ? 2 : 1; }
}

// ---------- вопрос ----------
const BODY_MAX = 600;
// raw: { task, autopilot, snapshot, events: [..], chat: [..] } — ответы тела как есть (любое поле может отсутствовать)
function bodyContext(raw, max = BODY_MAX) {
  if (!raw) return 'данные мухи недоступны';
  const parts = [];
  const t = raw.task && raw.task.task, ap = raw.autopilot && (raw.autopilot.autopilot || raw.autopilot), sn = raw.snapshot;
  if (t && t.name) parts.push(`задача ${t.name}${t.status && t.status !== 'running' ? ' (' + t.status + ')' : ''}${t.progress ? ': ' + oneLine(t.progress, 80) : ''}${t.sec != null ? ', ' + t.sec + ' с' : ''}`);
  if (ap) {
    if (ap.doing) parts.push(`автопилот: ${oneLine(ap.doing, 90)}`);
    else if (ap.on === false) parts.push('автопилот выключен');
    if (ap.build && ap.build.name) parts.push(`стройка ${ap.build.name} — ${oneLine(ap.build.status, 70)}`);
    if (ap.goalFailed) parts.push(`цель не вышла: ${oneLine(ap.goalFailed, 80)}`);
  }
  if (sn && sn.ready !== false && sn.health != null) {
    const p = sn.position;
    parts.push(`HP ${Math.round(sn.health)}, еда ${Math.round(sn.food)}${p ? `, на ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` : ''}${sn.heldItem ? ', в руке ' + sn.heldItem.name : ''}`);
    // у наблюдателя ночное зрение (датапак) — картинка светлее, чем у мухи; настоящие свет и время суток — отсюда
    const tm = sn.eyes && sn.eyes.time, lt = sn.lightLevel;
    if (lt != null || (tm && tm.phase)) parts.push([lt != null ? `свет у мухи ${lt}/15${lt <= 7 ? ' (для неё темно)' : ''}` : '', tm && tm.phase ? tm.phase : ''].filter(Boolean).join(', '));
  }
  if (raw.events && raw.events.length) parts.push('события: ' + raw.events.map(e => `${e.type}${e.kind ? ' ' + e.kind : ''}${e.by ? ' от ' + e.by : ''}${e.name && e.type !== 'danger' ? ' ' + e.name : ''}${e.reason ? ' (' + oneLine(e.reason, 60) + ')' : ''}${e.cause ? ' (' + oneLine(e.cause, 40) + ')' : ''}`).slice(-4).join('; '));
  if (raw.chat && raw.chat.length) parts.push('её строки: ' + raw.chat.map(c => oneLine(c.text, 80)).slice(-3).join(' | '));
  if (!parts.length) return 'данные мухи недоступны';
  return oneLine(parts.join('; '), max);
}
function buildQuestion(o) {
  const sec = Math.max(1, Math.round(o.sec || 0));
  const why = o.reason && o.reason.startsWith('событие') ? o.reason : 'таймер';
  return `Что было с прошлого вопроса (≈${sec} с)? Повод: ${why}. Муха сама сообщает: ${o.body || 'данные мухи недоступны'}. Ответь по формату.`;
}
// событие, ради которого стоит спрашивать сразу: не тихое (QUIET из lib/events.js); приоритет death > danger > провал задачи > остальное
const EVENT_PRIO = { death: 0, danger: 1, task_failed: 2 };
function pickEvent(events, quiet) {
  let best = null;
  for (const e of events || []) {
    if (!e || !e.type || e.sync || (quiet && quiet.has(e.type))) continue;
    const p = EVENT_PRIO[e.type] != null ? EVENT_PRIO[e.type] : 9;
    if (!best || p < best.p) best = { p, e };
  }
  return best ? best.e : null;
}
// пора ли спрашивать: -> 'таймер' | 'событие <тип>' | null
function dueReason(o) {
  const since = o.now - o.lastAskAt;
  if (o.event && since >= MIN_EVENT_GAP_MS) return 'событие ' + o.event.type;
  if (since >= o.askEverySec * 1000) return 'таймер';
  return null;
}

// ---------- журнал ----------
function stampLocal(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function logLine(ms, reason, text) {
  const why = reason && String(reason).startsWith('событие') ? oneLine(reason, 60) : 'таймер';
  return `[${stampLocal(ms)}] (${why}) ${oneLine(text, 1200) || '(пустой ответ)'}`;
}
function appendLog(file, line, maxBytes = LOG_MAX) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0; try { size = fs.statSync(file).size; } catch (e) {}
    if (size >= maxBytes) { try { fs.rmSync(file + '.1', { force: true }); } catch (e) {} fs.renameSync(file, file + '.1'); }
    fs.appendFileSync(file, line + '\n');
    return true;
  } catch (e) { return false; }
}
// Архив наблюдений: eyes.log ротируется (последние ~4 МБ), а архив хранит всё — по файлу на день: <dir>/ГГГГ-ММ-ДД.log,
// прошлые дни сжимаются в .log.gz (≈150 КБ/сутки), ничего не удаляется. Дата — из штампа строки [ГГГГ-ММ-ДД ЧЧ:ММ:СС].
function archiveLine(dir, line) {
  const m = /^\[(\d{4}-\d\d-\d\d) /.exec(line);
  if (!m) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cur = path.join(dir, m[1] + '.log');
    if (!fs.existsSync(cur)) archivePack(dir, m[1]);       // начался новый день — сжать прошлые
    fs.appendFileSync(cur, line + '\n');
    return true;
  } catch (e) { return false; }
}
// сжать все несжатые дни, кроме keepDay: <день>.log -> <день>.log.gz (если .gz уже есть — дописать к нему вторым gzip-членом)
function archivePack(dir, keepDay) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d{4}-\d\d-\d\d)\.log$/.exec(name);
    if (!m || m[1] === keepDay) continue;
    try {
      const src = path.join(dir, name), gz = src + '.gz';
      fs.appendFileSync(gz, zlib.gzipSync(fs.readFileSync(src)));
      fs.rmSync(src); n++;
    } catch (e) {}
  }
  return n;
}
// при первом запуске архива: перенести то, что уже есть в eyes.log.1 и eyes.log (по дням), чтобы старое не пропало при ротации
function archiveSeed(dir, logFile) {
  if (fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of [logFile + '.1', logFile]) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const l of txt.split(/\r?\n/)) if (l && archiveLine(dir, l)) n++;
  }
  return n;
}
function readArchiveDay(dir, day) {   // текст дня: сжатый и/или текущий
  let out = '';
  try { out += zlib.gunzipSync(fs.readFileSync(path.join(dir, day + '.log.gz'))).toString('utf8'); } catch (e) {}
  try { out += fs.readFileSync(path.join(dir, day + '.log'), 'utf8'); } catch (e) {}
  return out;
}
function writeStatus(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

// ---------- выжимка для учителя ----------
const LINE_RE = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\] (.*)$/;
function parseLine(l) {
  const m = LINE_RE.exec(l); if (!m) return null;
  const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const body = m[7], r = /^\(([^)]*)\)\s*(.*)$/.exec(body);
  return { at, hm: `${m[4]}:${m[5]}`, line: l, text: r ? r[2] : body };
}
const SAME_RE = /^без изменений[.!]?$/i;
// Строки журнала с временем в [fromMs, toMs]; подряд идущие «Без изменений» склеиваются; не больше maxLines строк и maxBytes байт (свежие важнее).
function eyesForCase(dataDir, fromMs, toMs, o = {}) {
  const maxLines = o.maxLines || 40, maxBytes = o.maxBytes || 8 * 1024, base = path.join(dataDir, 'eyes.log');
  let raw = '';
  for (const f of [base + '.1', base]) { try { raw += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
  if (!raw.trim()) return [];
  const rows = [];
  for (const l of raw.split('\n')) { const r = parseLine(l.replace(/\r$/, '')); if (r && r.at >= fromMs && r.at <= toMs) rows.push(r); }
  rows.sort((a, b) => a.at - b.at);
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (SAME_RE.test(rows[i].text.trim())) {
      let j = i; while (j + 1 < rows.length && SAME_RE.test(rows[j + 1].text.trim())) j++;
      const n = j - i + 1;
      out.push(n === 1 ? rows[i].line : `Без изменений ×${n} (с ${rows[i].hm} по ${rows[j].hm})`);
      i = j + 1;
    } else { out.push(oneLine(rows[i].line, 700)); i++; }
  }
  let res = out.slice(-maxLines), bytes = res.reduce((s, x) => s + Buffer.byteLength(x) + 1, 0);
  while (res.length > 1 && bytes > maxBytes) { bytes -= Buffer.byteLength(res[0]) + 1; res = res.slice(1); }
  return res;
}

module.exports = {
  DEFAULTS, DEFAULT_WORLD, HOST_PATH, TOKENS_SOFT, TOKENS_PER_MIN, COMPRESS, LOG_MAX, MIN_EVENT_GAP_MS,
  readConfig, readKey, redact, JpegSplitter, buildSetup, frameMessage, questionMessage, parseMessage, isQuotaError, isThinking,
  LiveClient, Backoff, TokenMeter, bodyContext, buildQuestion, pickEvent, dueReason,
  stampLocal, logLine, appendLog, writeStatus, archiveLine, archivePack, archiveSeed, readArchiveDay, parseLine, eyesForCase
};
