// Хост поведения (ядро): загружает behavior/, проверяет, включает, перезагружает без перезапуска тела и откатывает.
// Поведение — всё, что решает «как и когда» (автопилот, рефлексы, выбор способа боя, пороги).
// Контракт поведения (behavior/index.js): { API: 1, attach(api) -> {detach?}, selfTest() -> Promise, thresholds?, chooseMelee? }.
// api — узкий: ctx, bot, every/after/on (таймеры и подписки, ядро снимет их само), handle(событие ядра), log.
// Проверка перед включением: файл грузится, экспорт правильный, selfTest проходит за CHECK_MS.
// Сломанная версия не включается. Включённую ядро само НЕ откатывает: исключения (FAULT_N за минуту), падение attach,
// зависание (таймер поведения не ответил HANG_MS) — считаются в счёт версии (faults/hangs в index.json и GET /behavior)
// и приходят мозгу событием behavior_trouble; откатить решает мозг (POST /behavior/rollback {to?}).
// Рабочая — продержалась GOOD_MS без сбоев и без подозрительно долгих ожиданий (GOOD_MS больше HANG_MS).
// Версии: data/behavior_versions/<id>/ (копия файлов) + index.json. Всё, что случилось, — событие 'behavior' в events.log.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
if (!process.env.FLYBOT_CORE) process.env.FLYBOT_CORE = ROOT; // behavior/core.js берёт ядро отсюда (и в сохранённых версиях)
const API = 1;
const DEFAULTS = { CHECK_MS: 15000, HANG_MS: 120000, FAULT_N: 20, FAULT_WINDOW_MS: 60000, GOOD_MS: 180000, WATCH_MS: 5000, RESTART_GAP_MS: 300000 };
const CORE_EVENTS = new Set(['player_attack', 'mob_hurt']); // какие события ядро передаёт поведению (api.handle)
const KEEP_VERSIONS = 30;

// ---------- файлы версии ----------
function listFiles(dir, rel = '') {
  let out = [];
  let ents = []; try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(dir, r));
    else if (/\.(js|json|md|txt)$/.test(e.name)) out.push(r);
  }
  return out.sort();
}
function hashDir(dir) {
  const h = crypto.createHash('sha1');
  for (const f of listFiles(dir)) { h.update(f + '\0'); try { h.update(fs.readFileSync(path.join(dir, f))); } catch (e) {} h.update('\0'); }
  return h.digest('hex').slice(0, 12);
}
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const errText = e => String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : (e && e.message) || e).slice(0, 400);

// Загрузить версию из каталога заново (без кэша) и проверить экспорт. Бросает при ошибке.
function loadDir(dir) {
  const abs = path.resolve(dir) + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(abs)) delete require.cache[k];
  const mod = require(path.join(abs, 'index.js'));
  const bad = validate(mod);
  if (bad) throw new Error(bad);
  return mod;
}
function validate(mod) {
  if (!mod || typeof mod !== 'object') return 'index.js экспортирует не объект';
  if (mod.API !== API) return `API=${mod.API}, ядро ждёт ${API}`;
  if (typeof mod.attach !== 'function') return 'нет attach(api)';
  if (typeof mod.selfTest !== 'function') return 'нет selfTest()';
  if (mod.chooseMelee != null && typeof mod.chooseMelee !== 'function') return 'chooseMelee не функция';
  return null;
}
function withTimeout(p, ms, what) {
  let tm;
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(`${what}: дольше ${Math.round(ms / 1000)} с`)), ms); })])
    .finally(() => clearTimeout(tm));
}
// Полная проверка каталога: загрузка + экспорт + selfTest. -> { ok, mod, error, ms }
async function check(dir, ms = DEFAULTS.CHECK_MS) {
  const t0 = Date.now();
  let mod;
  try { mod = loadDir(dir); } catch (e) { return { ok: false, error: 'не загрузилось: ' + errText(e), ms: Date.now() - t0 }; }
  try { await withTimeout(mod.selfTest(), ms, 'selfTest'); } catch (e) { return { ok: false, error: 'selfTest: ' + errText(e), ms: Date.now() - t0 }; }
  return { ok: true, mod, ms: Date.now() - t0 };
}

class BehaviorHost {
  // opts: { dir (behavior/), versionsDir (data/behavior_versions), limits }
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.dir = opts.dir || path.join(ROOT, 'behavior');
    this.versionsDir = opts.versionsDir || path.join(ctx.dataDir || path.join(ROOT, 'data'), 'behavior_versions');
    this.L = { ...DEFAULTS, ...(opts.limits || {}) };
    this.active = null;   // { mod, id, hash, dir, source, since, faults: [] }
    this.handle = null;   // что вернул attach
    this.bs = null;       // подключение к текущему боту: { bot, timers, listeners, handlers, inflight }
    this.session = null;  // сессия бота ядра (bot.js)
    this.history = [];    // загрузки, отказы, откаты
    this.busy = null;     // идёт перезагрузка/откат
    this.lastRestart = 0;
    ctx.behaviorHost = this;
    this.watch = setInterval(() => this.watchdog(), this.L.WATCH_MS);
    if (this.watch.unref) this.watch.unref();
    this.ensureLinks();
  }

  // Версии запускаются из data/behavior_versions/<id>/: require('../lib/…') и путь '../brain/…' оттуда
  // не резолвятся, и такая версия падает на каждом побеге (core_task 29181f0b08). Решение: рядом с версиями
  // кладём ссылки на каталоги проекта lib и brain — версии работают так же, как behavior/.
  ensureLinks() {
    try { fs.mkdirSync(this.versionsDir, { recursive: true }); } catch (e) {}
    for (const name of ['lib', 'brain']) {
      const target = path.join(ROOT, name), link = path.join(this.versionsDir, name);
      let points = false;
      try { points = path.normalize(fs.realpathSync(link)) === path.normalize(fs.realpathSync(target)); } catch (e) { points = false; }
      if (points) continue;
      try {
        if (fs.existsSync(link)) this.log('ссылка версий не тронута', { link: path.relative(ROOT, link), why: 'уже есть, но не на ' + name + ' проекта' });
        else { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); this.log('ссылка версий', { link: path.relative(ROOT, link), to: path.relative(ROOT, target) }); }
      } catch (e) {
        this.log('ссылка версий не создалась', { link: path.relative(ROOT, link), why: errText(e) + ' — require(\'../lib/…\') в версиях поведения будет падать' });
      }
    }
  }

  // ---------- журнал ----------
  log(what, data = {}) {
    const rec = { t: new Date().toISOString(), what, ...data };
    this.history.push(rec); if (this.history.length > 100) this.history.shift();
    try { this.ctx.events.push('behavior', { what, ...data }); } catch (e) {}
    try { console.log(`[behavior] ${what}${data.id ? ' ' + data.id : ''}${data.why ? ': ' + data.why : ''}${data.error ? ': ' + data.error : ''}`); } catch (e) {}
    return rec;
  }

  // ---------- версии ----------
  indexFile() { return path.join(this.versionsDir, 'index.json'); }
  readIndex() { try { const d = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')); return Array.isArray(d.versions) ? d : { versions: [] }; } catch (e) { return { versions: [] }; } }
  writeIndex(d) {
    try { fs.mkdirSync(this.versionsDir, { recursive: true }); const f = this.indexFile(), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d, null, 1)); fs.renameSync(tmp, f); } catch (e) {}
  }
  // Сохранить копию каталога как версию (если такой ещё нет) -> запись версии
  saveVersion(dir, hash, from) {
    const idx = this.readIndex();
    let v = idx.versions.find(x => x.hash === hash);
    if (v && fs.existsSync(path.join(this.versionsDir, v.id, 'index.js'))) return v;
    const id = stamp() + '-' + hash.slice(0, 6);
    const to = path.join(this.versionsDir, id);
    for (const f of listFiles(dir)) { fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true }); fs.copyFileSync(path.join(dir, f), path.join(to, f)); }
    v = { id, hash, savedAt: new Date().toISOString(), from: from || 'behavior/', good: false };
    idx.versions = idx.versions.filter(x => x.hash !== hash).concat(v);
    // старые нерабочие копии чистим, рабочие храним (не больше KEEP_VERSIONS всего)
    while (idx.versions.length > KEEP_VERSIONS) {
      const k = idx.versions.findIndex(x => !x.good); const drop = idx.versions.splice(k >= 0 ? k : 0, 1)[0];
      try { fs.rmSync(path.join(this.versionsDir, drop.id), { recursive: true, force: true }); } catch (e) {}
    }
    this.writeIndex(idx);
    return v;
  }
  // Отказавшая версия больше не рабочая (на неё не откатываться)
  markBad(hash, why) {
    const idx = this.readIndex(); const v = idx.versions.find(x => x.hash === hash);
    if (!v) return;
    v.good = false; v.badAt = new Date().toISOString(); v.bad = String(why).slice(0, 300); this.writeIndex(idx);
  }
  // Есть ли ожидание поведения дольше трети HANG_MS (похоже на зависание)
  slowInflight() {
    const bs = this.bs; if (!bs) return false;
    const now = Date.now();
    for (const [, f] of bs.inflight) if (now - f.t > this.L.HANG_MS / 3) return true;
    return false;
  }
  markGood(hash) {
    const idx = this.readIndex(); const v = idx.versions.find(x => x.hash === hash);
    if (!v || v.good) return;
    v.good = true; v.goodAt = new Date().toISOString(); this.writeIndex(idx);
    this.log('версия рабочая', { id: v.id, why: `продержалась ${Math.round(this.L.GOOD_MS / 1000)} с без сбоев` });
  }
  // Последняя рабочая версия (кроме хеша exclude)
  lastGood(exclude) {
    const vs = this.readIndex().versions.filter(v => v.good && v.hash !== exclude && fs.existsSync(path.join(this.versionsDir, v.id, 'index.js')));
    vs.sort((a, b) => String(a.goodAt || a.savedAt).localeCompare(String(b.goodAt || b.savedAt)));
    return vs.length ? vs[vs.length - 1] : null;
  }

  // ---------- запуск ----------
  // При старте тела: behavior/ -> если не прошла проверку, последняя рабочая -> иначе без поведения (только ядро)
  async init() {
    const r = await this.tryActivate(this.dir, 'behavior/', 'запуск');
    if (r.ok) return r;
    const g = this.lastGood(null);
    if (g) {
      const r2 = await this.tryActivate(path.join(this.versionsDir, g.id), 'версия ' + g.id, 'behavior/ не прошло проверку при запуске');
      if (r2.ok) { this.log('откат', { from: 'behavior/', to: g.id, why: r.error }); return r2; }
    }
    this.log('без поведения', { why: 'нет рабочей версии: ' + r.error });
    return r;
  }

  // Перечитать behavior/ (POST /behavior/reload). Сломанная версия не включается, активная остаётся.
  async reload(reason = 'вручную') {
    if (this.busy) return { ok: false, error: 'уже идёт перезагрузка/откат' };
    const hash = hashDir(this.dir);
    if (this.active && this.active.hash === hash && this.active.dir === path.resolve(this.dir)) return { ok: true, unchanged: true, active: this.info() };
    return this.tryActivate(this.dir, 'behavior/', reason);
  }

  async tryActivate(dir, source, reason) {
    this.busy = reason || 'загрузка';
    try {
      const hash = hashDir(dir);
      const r = await check(dir, this.L.CHECK_MS);
      if (!r.ok) { this.log('не включена', { source, hash, why: reason, error: r.error }); return { ok: false, error: r.error, hash }; }
      let v = null;
      try { v = this.saveVersion(dir, hash, source); } catch (e) { this.log('версия не сохранена', { error: errText(e) }); }
      await this.activate(r.mod, { id: v ? v.id : 'без-копии-' + hash, hash, dir: path.resolve(dir), source });
      this.log('включена', { id: this.active.id, source, why: reason, checkMs: r.ms });
      return { ok: true, active: this.info() };
    } finally { this.busy = null; this.afterBusy(); }
  }

  async activate(mod, meta) {
    await this.detach('смена версии поведения');
    this.active = { mod, ...meta, since: Date.now(), faults: [] };
    const act = this.active;
    clearTimeout(this.goodTimer);
    this.goodTimer = setTimeout(() => { if (this.active === act && !act.faults.length && !this.slowInflight()) this.markGood(act.hash); }, this.L.GOOD_MS);
    if (this.goodTimer.unref) this.goodTimer.unref();
    if (this.session && !this.session.ended) this.attachBot(this.session);
  }

  // ---------- подключение к боту ----------
  // Из bot.js на каждый новый экземпляр бота
  attachSession(session) {
    this.session = session;
    if (this.active) this.attachBot(session);
  }
  // Из bot.js при отключении: таймеры и подписки поведения снять
  sessionEnded(session) {
    if (this.session === session) this.dropBot();
  }

  attachBot(session) {
    this.dropBot();
    const bot = session.bot || this.ctx.bot;
    const bs = { bot, timers: [], listeners: [], handlers: {}, inflight: new Map(), seq: 0, version: this.active };
    this.bs = bs;
    try {
      const h = this.active.mod.attach(this.api(bs));
      this.handle = h || null;
    } catch (e) {
      this.handle = null;
      this.fault(e, 'attach', true);
    }
  }
  dropBot() {
    const bs = this.bs; if (!bs) return;
    this.bs = null;
    for (const tm of bs.timers) { clearInterval(tm); clearTimeout(tm); }
    for (const [em, ev, fn] of bs.listeners) { try { em.removeListener(ev, fn); } catch (e) {} }
    bs.inflight.clear();
  }
  // Выгрузить активную версию с бота (detach поведения + снять таймеры)
  async detach(reason) {
    const h = this.handle; this.handle = null;
    if (h && typeof h.detach === 'function') {
      try { await withTimeout(h.detach(reason), 10000, 'detach'); } catch (e) { this.log('detach с ошибкой', { error: errText(e) }); }
    }
    this.dropBot();
  }

  // Узкий интерфейс для поведения
  api(bs) {
    const host = this, ctx = this.ctx, bot = bs.bot;
    const live = () => host.bs === bs;
    // вызов кода поведения: исключение — сбой версии; promise — следим, чтобы не висел дольше HANG_MS
    const run = (name, fn, args) => {
      if (!live()) return;
      let r;
      try { r = fn(...args); } catch (e) { host.fault(e, name); return; }
      if (r && typeof r.then === 'function') {
        const id = ++bs.seq; bs.inflight.set(id, { name, t: Date.now() });
        r.then(() => bs.inflight.delete(id), e => { bs.inflight.delete(id); if (live()) host.fault(e, name); });
      }
      return r;
    };
    return {
      API, ctx, bot,
      // таймер; по умолчанию только когда бот в мире (как раньше в рефлексах); opts.always — всегда, пока это тот же бот
      every(ms, fn, name = 'таймер', opts = {}) {
        const tm = setInterval(() => {
          if (ctx.bot !== bot) return;
          if (!opts.always && !(ctx.ready && bot.entity)) return;
          run(name, fn, []);
        }, ms);
        bs.timers.push(tm); return tm;
      },
      after(ms, fn, name = 'отложенное') { const tm = setTimeout(() => run(name, fn, []), ms); bs.timers.push(tm); return tm; },
      on(emitter, event, fn, name) {
        const w = (...a) => run(name || ('событие ' + event), fn, a);
        emitter.on(event, w); bs.listeners.push([emitter, event, w]); return w;
      },
      handle(event, fn) {
        if (!CORE_EVENTS.has(event)) throw new Error(`ядро не передаёт событие ${event} (есть: ${[...CORE_EVENTS].join(', ')})`);
        bs.handlers[event] = fn;
      },
      log(type, data) { ctx.events.push(type, data); }
    };
  }

  // Событие ядра -> обработчик поведения (из lib/body_events.js)
  emit(event, payload) {
    const bs = this.bs; if (!bs) return;
    const fn = bs.handlers[event]; if (!fn) return;
    let r;
    try { r = fn(payload); } catch (e) { this.fault(e, event); return; }
    if (r && typeof r.then === 'function') r.catch(e => this.fault(e, event));
  }
  // Решение поведения, которое зовёт ядро (например chooseMelee из combat.js). Нет поведения/упало — fallback ядра.
  call(name, args, fallback) {
    const a = this.active; const fn = a && a.mod && a.mod[name];
    if (typeof fn !== 'function') return fallback(...args);
    try { return fn(...args); } catch (e) { this.fault(e, name); return fallback(...args); }
  }

  // ---------- сбои (счёт версии; откатывает мозг) ----------
  // Счёт версии в index.json: faults — исключения, crashes — падения attach, hangs — зависания
  countVersion(hash, field) {
    const idx = this.readIndex(); const v = idx.versions.find(x => x.hash === hash);
    if (!v) return null;
    v[field] = (v[field] || 0) + 1; this.writeIndex(idx);
    return v;
  }
  // Беда с поведением — мозгу (событие не тихое), не чаще раза в FAULT_WINDOW_MS на версию
  trouble(kind, why) {
    const a = this.active; if (!a) return;
    const now = Date.now();
    if (a.lastTrouble && now - a.lastTrouble < this.L.FAULT_WINDOW_MS) return;
    a.lastTrouble = now;
    const v = this.readIndex().versions.find(x => x.hash === a.hash) || {};
    const lg = this.lastGood(a.hash);
    const data = { id: a.id, kind, why, score: { faults: v.faults || 0, crashes: v.crashes || 0, hangs: v.hangs || 0 },
      lastGood: lg ? lg.id : null, how: 'решай сам: оставить, поправить behavior/ и POST /behavior/reload, или откатить POST /behavior/rollback {to?}' };
    this.log('беда', data);
    try { this.ctx.events.push('behavior_trouble', data); } catch (e) {}
  }
  fault(err, where, fatal = false) {
    const a = this.active; if (!a) return;
    const now = Date.now();
    a.faults.push({ t: now, where, error: errText(err) });
    a.faults = a.faults.filter(f => now - f.t <= this.L.FAULT_WINDOW_MS);
    this.countVersion(a.hash, fatal ? 'crashes' : 'faults');
    if (!a.lastFaultLog || now - a.lastFaultLog > 10000) { a.lastFaultLog = now; this.log('сбой', { id: a.id, where, error: errText(err) }); }
    if (!fatal && a.faults.length < this.L.FAULT_N) return;
    const why = fatal ? `${where} упал: ${errText(err)}` : `${a.faults.length} исключений за ${Math.round(this.L.FAULT_WINDOW_MS / 1000)} с (последнее в «${where}»: ${errText(err)})`;
    this.trouble(fatal ? 'упал' : 'исключения', why);
  }
  watchdog() {
    const bs = this.bs; if (!bs || this.busy) return;
    const now = Date.now();
    for (const [, f] of bs.inflight) {
      if (now - f.t > this.L.HANG_MS && !f.reported) {
        f.reported = true; // одно зависание — один раз в счёт
        if (this.active) this.countVersion(this.active.hash, 'hangs');
        this.trouble('завис', `«${f.name}» завис: не ответил ${Math.round((now - f.t) / 1000)} с`);
      }
    }
  }
  // Откат — только по решению мозга (POST /behavior/rollback): на версию to или на последнюю рабочую.
  // Если рабочая — это и есть активная, перезапуск её (не чаще раза в RESTART_GAP_MS).
  async rollback(why, to = null) {
    if (this.busy) return { ok: false, error: 'уже идёт ' + this.busy };
    const cur = this.active;
    const from = cur ? cur.id : null;
    if (to && !this.readIndex().versions.find(v => v.id === to && fs.existsSync(path.join(this.versionsDir, v.id, 'index.js')))) return { ok: false, error: 'нет такой версии: ' + to };
    this.busy = 'откат';
    try {
      if (cur) this.markBad(cur.hash, why);
      const g = to ? this.readIndex().versions.find(v => v.id === to) : this.lastGood(cur ? cur.hash : null);
      if (g) {
        const dir = path.join(this.versionsDir, g.id);
        const r = await check(dir, this.L.CHECK_MS);
        if (r.ok) {
          await this.activate(r.mod, { id: g.id, hash: g.hash, dir: path.resolve(dir), source: 'откат' });
          this.log('откат', { from, to: g.id, why });
          return { ok: true, to: g.id };
        }
        this.log('откат не удался', { to: g.id, error: r.error });
      }
      // откатывать не на что: рабочая версия — сама активная (или её нет)
      if (cur && Date.now() - this.lastRestart > this.L.RESTART_GAP_MS) {
        this.lastRestart = Date.now();
        await this.activate(cur.mod, { id: cur.id, hash: cur.hash, dir: cur.dir, source: cur.source });
        this.log('перезапуск', { id: cur.id, why: why + '; другой рабочей версии нет' });
        return { ok: true, restarted: cur.id };
      }
      this.log('откат невозможен', { id: from, why: why + '; другой рабочей версии нет, перезапуск был недавно' });
      return { ok: false, error: 'нет рабочей версии' };
    } finally { this.busy = null; this.afterBusy(); }
  }

  afterBusy() { this.pending = null; }

  // ---------- для GET /behavior ----------
  info() {
    const a = this.active; if (!a) return null;
    return { id: a.id, hash: a.hash, source: a.source, since: new Date(a.since).toISOString(), name: a.mod && a.mod.name || null,
      faults: a.faults.length, good: !!(this.readIndex().versions.find(v => v.hash === a.hash) || {}).good };
  }
  status() {
    const idx = this.readIndex();
    const lg = this.lastGood(null);
    return {
      active: this.info(), attached: !!this.bs, busy: this.busy,
      onDisk: { dir: path.relative(ROOT, this.dir) || 'behavior', hash: hashDir(this.dir) },
      lastGood: lg ? lg.id : null,
      versions: idx.versions.slice(-10).map(v => ({ id: v.id, good: !!v.good, from: v.from, faults: v.faults || 0, crashes: v.crashes || 0, hangs: v.hangs || 0 })),
      rollbacks: this.history.filter(h => /^(откат|перезапуск)/.test(h.what)).slice(-20),
      history: this.history.slice(-30)
    };
  }
  stop() { clearInterval(this.watch); clearTimeout(this.goodTimer); this.dropBot(); }
}

module.exports = { BehaviorHost, check, loadDir, validate, hashDir, API, CORE_EVENTS };
