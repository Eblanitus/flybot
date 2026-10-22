// Связь тела с игровым сервером: подключение, честное состояние и бесконечное переподключение.
// Состояния: connecting — подключаюсь/вхожу в мир; online — в мире; offline — связи нет, жду следующей попытки.
// Пауза между попытками растёт 2 → 4 → 8 … → 60 с и дальше не растёт: тело пробует, пока сервер не вернётся.
// Неудачная попытка — тихое событие info (мозг не будится каждую минуту, но в журнале видно: попытка N, причина, когда
// следующая); вошёл в мир после разрыва или неудачных попыток — событие reconnected (будит мозг).
// Сторож входа: сервер принял соединение и молчит (minecraft-protocol сам не рвёт до первого keep_alive) — рвём и пробуем снова.
// Из bot.js: new Link(ctx, { host, port, user, createBot, attach(session), spawn(session, first), ended(session, reason) }).start()
'use strict';

const DEFAULTS = { BACKOFF_MIN_MS: 2000, BACKOFF_MAX_MS: 60000, LOGIN_TIMEOUT_MS: 60000, ERROR_END_MS: 5000 };

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return sec + ' с';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' мин';
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ' ч' + (mm ? ' ' + mm + ' мин' : '');
}
const errText = e => String((e && (e.code || e.message)) || e);

class Link {
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.o = { ...DEFAULTS, ...(o.timing || {}) };
    this.host = o.host; this.port = o.port; this.user = o.user;
    this.createBot = o.createBot;
    this.onAttach = o.attach || (() => {});
    this.onSpawn = o.spawn || (() => {});
    this.onEnded = o.ended || (() => {});
    this.log = o.log || (s => console.log(s));
    this.state = 'idle';
    this.since = Date.now();
    this.backoff = this.o.BACKOFF_MIN_MS;
    this.attempts = 0; // попыток подключения с последнего входа в мир (включая идущую)
    this.offlineSince = null; // с какого момента нет связи; null — в мире (или ещё ни разу не пробовали)
    this.lastReason = null; // чем кончилась последняя попытка/сессия
    this.lastOnlineAt = null;
    this.nextRetryAt = null;
    this.timer = null;
    this.session = null;
    this.stopped = false;
    ctx.link = this; // снимок, /health, /wait и команды берут состояние связи отсюда
  }

  get online() { return this.state === 'online'; }
  _set(state) { if (this.state !== state) { this.state = state; this.since = Date.now(); } }

  start() { this.stopped = false; if (!this.session && !this.timer) this.connect(); return this; }

  // для тестов и выключения: не переподключаться, текущую сессию закрыть
  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const s = this.session;
    if (s && !s.ended) { try { s.bot.end('stop'); } catch (e) {} this._ended(s, 'stop'); }
  }

  connect() {
    this.timer = null; this.nextRetryAt = null;
    if (this.stopped) return;
    const ctx = this.ctx;
    this.attempts++;
    this._set('connecting');
    this.log(`[bot] connecting to ${this.host}:${this.port} as ${this.user}` + (this.attempts > 1 ? ` (попытка ${this.attempts})` : ''));
    let bot;
    try { bot = this.createBot(); } catch (e) {
      ctx.lastError = errText(e); this.log('[bot] createBot: ' + ctx.lastError);
      this.session = null; ctx.ready = false;
      this._offline('createBot: ' + ctx.lastError, false);
      return;
    }
    const session = { bot, timers: [], ended: false, spawned: false };
    this.session = session;
    ctx.bot = bot; ctx.ready = false;
    try { this.onAttach(session); } catch (e) { this.log('[bot] attach: ' + ((e && e.stack) || e)); }

    let first = true;
    bot.on('spawn', () => {
      if (session.ended) return;
      const wasFirst = first; first = false;
      session.spawned = true;
      ctx.ready = true; ctx.lastError = null;
      const outage = wasFirst ? this._online() : null;
      try { this.onSpawn(session, wasFirst); } catch (e) { this.log('[bot] spawn: ' + ((e && e.stack) || e)); }
      ctx.events.push('spawn', { msg: wasFirst ? 'вошёл в мир' : 'респавн' });
      this.log('[bot] spawned');
      if (outage) ctx.events.push('reconnected', outage);
    });
    const onEnd = reason => this._ended(session, reason);
    bot.on('end', onEnd);
    bot.on('kicked', reason => { ctx.lastError = 'kicked: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason)); this.log('[bot] kicked: ' + ctx.lastError); });
    bot.on('error', e => {
      ctx.lastError = errText(e); this.log('[bot] error: ' + ctx.lastError);
      // соединение так и не установилось, а 'end' не пришёл — закрыть самим
      if (!session.spawned) session.timers.push(setTimeout(() => { if (!session.ended) { try { bot.end(); } catch (er) {} onEnd('error: ' + ctx.lastError); } }, this.o.ERROR_END_MS));
    });
    // сторож входа: соединение есть, а в мир не пускают (сервер завис или ещё загружается)
    session.timers.push(setTimeout(() => {
      if (session.spawned || session.ended) return;
      ctx.lastError = `сервер не впустил в мир за ${fmtDur(this.o.LOGIN_TIMEOUT_MS / 1000)}`;
      this.log('[bot] login timeout');
      try { bot.end('loginTimeout'); } catch (e) {}
      onEnd('loginTimeout');
    }, this.o.LOGIN_TIMEOUT_MS));
  }

  // вошли в мир: сбросить паузу и счёт попыток; если перед этим связи не было — что было (для события reconnected)
  _online() {
    const now = Date.now();
    let outage = null;
    if (this.offlineSince != null) {
      const offlineSec = Math.round((now - this.offlineSince) / 1000);
      outage = {
        msg: `связь с сервером восстановлена: снова в мире после ${fmtDur(offlineSec)} без связи (попыток: ${this.attempts})`,
        offlineSec, attempts: this.attempts, lastReason: this.lastReason
      };
    }
    this.offlineSince = null; this.attempts = 0; this.backoff = this.o.BACKOFF_MIN_MS; this.lastOnlineAt = now;
    this._set('online');
    return outage;
  }

  _ended(session, reason) {
    if (session.ended) return;
    session.ended = true;
    const ctx = this.ctx;
    const wasOnline = session.spawned;
    ctx.ready = false;
    for (const tm of session.timers) { clearInterval(tm); clearTimeout(tm); }
    session.timers = [];
    try { this.onEnded(session, reason); } catch (e) { this.log('[bot] ended hook: ' + ((e && e.stack) || e)); }
    try { session.bot.removeAllListeners(); session.bot.on('error', () => {}); } catch (e) {}
    if (this.session === session) this.session = null;
    this.log('[bot] ended: ' + reason);
    this._offline(String(reason || ctx.lastError || 'unknown'), wasOnline);
  }

  // связи нет: запланировать следующую попытку и честно сказать об этом в журнал
  _offline(reason, wasOnline) {
    const ctx = this.ctx, now = Date.now();
    this.lastReason = reason;
    if (this.offlineSince == null) this.offlineSince = now;
    this._set('offline');
    if (this.stopped) return;
    const wait = this._schedule();
    const retryInSec = Math.round(wait / 1000);
    const err = ctx.lastError && ctx.lastError !== reason ? ctx.lastError : null;
    if (wasOnline) {
      ctx.events.push('disconnect', {
        reason, retryInSec, ...(err ? { error: err } : {}),
        msg: `связь с сервером потеряна (${reason}${err ? ', ' + err : ''}); переподключаюсь сам: первая попытка через ${fmtDur(retryInSec)}, дальше паузы растут до ${fmtDur(this.o.BACKOFF_MAX_MS / 1000)}`
      });
    } else {
      const offlineSec = Math.round((now - this.offlineSince) / 1000);
      ctx.events.push('info', {
        reason, retryInSec, attempt: this.attempts, offlineSec, ...(err ? { error: err } : {}),
        msg: `нет связи с сервером ${this.host}:${this.port}: попытка ${this.attempts} не удалась (${err || reason}); следующая через ${fmtDur(retryInSec)}; без связи ${fmtDur(offlineSec)}`
      });
    }
  }

  _schedule() {
    if (this.timer) return Math.max(0, (this.nextRetryAt || Date.now()) - Date.now());
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.o.BACKOFF_MAX_MS);
    this.nextRetryAt = Date.now() + wait;
    this.log(`[bot] reconnect in ${Math.round(wait / 1000)}s`);
    this.timer = setTimeout(() => this.connect(), wait);
    return wait;
  }

  // Для /health, /snapshot, /wait: состояние связи без вранья
  info() {
    const now = Date.now();
    const o = { state: this.state, online: this.online, host: this.host, port: this.port, sinceSec: Math.round((now - this.since) / 1000) };
    if (!this.online) {
      if (this.offlineSince != null) o.offlineSec = Math.round((now - this.offlineSince) / 1000);
      o.attempts = this.attempts;
      if (this.nextRetryAt) o.nextRetryInSec = Math.max(0, Math.round((this.nextRetryAt - now) / 1000));
      if (this.lastReason) o.lastReason = this.lastReason;
      if (this.ctx.lastError) o.lastError = this.ctx.lastError;
      o.text = this.line();
    }
    return o;
  }

  line() {
    const now = Date.now();
    if (this.online) return 'в мире';
    const off = this.offlineSince != null ? ` без связи ${fmtDur((now - this.offlineSince) / 1000)},` : '';
    if (this.state !== 'offline') return `подключаюсь к игровому серверу ${this.host}:${this.port} (попытка ${Math.max(1, this.attempts)}${off ? ',' + off.slice(0, -1) : ''})`;
    const why = this.ctx.lastError || this.lastReason || '?';
    const next = this.nextRetryAt ? `следующая через ${fmtDur((this.nextRetryAt - now) / 1000)}` : 'следующая скоро';
    return `нет связи с игровым сервером ${this.host}:${this.port} (${why}):${off} неудачных попыток ${this.attempts}, ${next} — тело переподключится само, как только сервер вернётся`;
  }
}

module.exports = { Link, DEFAULTS, fmtDur };
