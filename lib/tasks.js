// Менеджер навыков: одна задача, двигающая тело, за раз; прерывание (stop); блокировка для старых команд.
'use strict';
const { Aborted, sleep } = require('./util');

class Task {
  constructor(id, name, params, source) {
    this.id = id; this.name = name; this.params = params || {}; this.source = source || 'brain';
    this.started = Date.now(); this.status = 'running'; this.progressText = '';
    this.aborted = false; this.reason = null; this.result = null; this.error = null;
    this._abortFns = new Set();
  }
  abort(reason) {
    if (this.aborted) return;
    this.aborted = true; this.reason = reason || 'прервано';
    for (const fn of this._abortFns) { try { fn(this.reason); } catch (e) {} }
  }
  onAbort(fn) { this._abortFns.add(fn); return () => this._abortFns.delete(fn); }
  check() { if (this.aborted) throw new Aborted(this.reason); }
  progress(text) { this.progressText = String(text); }
  async sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { this.check(); await sleep(Math.min(100, end - Date.now())); }
    this.check();
  }
  // ждать до прерывания (для бесконечных навыков вроде follow)
  waitAbort() { return new Promise(res => { if (this.aborted) res(); else this.onAbort(() => res()); }); }
  info() {
    return {
      id: this.id, name: this.name, params: this.params, status: this.status,
      progress: this.progressText, sec: Math.round((Date.now() - this.started) / 1000),
      ...(this.error ? { error: this.error } : {}), ...(this.source !== 'brain' ? { source: this.source } : {})
    };
  }
}

class TaskManager {
  constructor(ctx) {
    this.ctx = ctx; this.seq = 0; this.current = null; this.history = [];
    this.legacyBusy = 0; this.chain = Promise.resolve();
  }

  busyInfo() {
    if (this.current) return `занят навыком ${this.current.name} (taskId ${this.current.id}); пошли {"action":"stop"} или force:true`;
    return null;
  }

  // Запустить навык. fn(task) -> результат (объект). wait=true — дождаться результата.
  async start(name, params, fn, opts = {}) {
    const { wait = false, force = false, queue = false, source = 'brain' } = opts;
    // мозг (и рефлекс) всегда главнее автопилота: его навык снимается без force и без очереди
    if (this.current && this.current.source === 'autopilot' && source !== 'autopilot') {
      await this.stop(source === 'reflex' ? 'вытеснен рефлексом' : 'вытеснен командой мозга');
    }
    if (this.current) {
      // очередь на одно место: мозг думает, пока тело работает; следующий навык стартует сразу после текущего
      if (queue && !force && !wait) {
        const replaced = this.pending ? this.pending.name : null;
        this.pending = { name, params, fn, opts: { ...opts, queue: false } };
        this.ctx.events.push('info', { msg: `в очереди: ${name} (после ${this.current.name})`, queued: name });
        return { ok: true, queued: name, after: this.current.id, ...(replaced ? { replaced } : {}), hint: 'стартует сам после текущего; stop очищает очередь' };
      }
      if (!force) return { ok: false, error: this.busyInfo(), task: this.current.info() };
      await this.stop('заменён навыком ' + name);
    }
    if (this.legacyBusy) {
      if (!force) return { ok: false, error: 'выполняется простая команда, повтори через секунду' };
      await this.chain.catch(() => {});
    }
    const task = new Task(++this.seq, name, params, source);
    task.sync = !!wait;
    this.current = task;
    task.onAbort(() => this.ctx.haltBody());
    this.ctx.events.push('task_started', { taskId: task.id, name, params, source });
    const done = this._run(task, fn);
    if (wait) {
      await done;
      return task.status === 'done'
        ? { ok: true, taskId: task.id, result: task.result }
        : { ok: false, taskId: task.id, error: task.error, result: task.result };
    }
    return { ok: true, taskId: task.id, started: name, hint: 'жди GET /wait' };
  }

  async _run(task, fn) {
    try {
      const res = await fn(task);
      task.check();
      task.status = 'done'; task.result = res || {};
      this.ctx.events.push('task_done', { taskId: task.id, name: task.name, result: task.result, ...(task.sync ? { sync: true } : {}) });
    } catch (e) {
      task.status = task.aborted ? 'aborted' : 'failed';
      task.error = task.aborted ? task.reason : String(e && e.message ? e.message : e);
      task.result = (e && e.extra) || task.result;
      this.ctx.events.push(task.aborted ? 'task_aborted' : 'task_failed',
        { taskId: task.id, name: task.name, reason: task.error, ...(task.result ? { result: task.result } : {}), ...(task.sync && !task.aborted ? { sync: true } : {}) });
    } finally {
      try { this.ctx.haltBody(); } catch (e) {}
      if (this.current === task) this.current = null;
      this.history.push(task.info());
      if (this.history.length > 20) this.history.shift();
      // прерванный навык (stop, смерть, рефлекс) очередь сбрасывает: она уже не к месту
      if (task.status === 'aborted') this.pending = null;
      const next = this.pending;
      if (next && !this.current) {
        this.pending = null;
        setImmediate(() => this.start(next.name, next.params, next.fn, next.opts).catch(() => {}));
      }
    }
  }

  // Прервать текущий навык и дождаться, пока он отпустит тело
  async stop(reason = 'stop') {
    const t = this.current;
    this.pending = null;
    try { this.ctx.haltBody(); } catch (e) {}
    if (!t) return false;
    t.abort(reason);
    for (let i = 0; i < 50 && this.current === t; i++) await sleep(100);
    return true;
  }

  // Старые простые команды, двигающие тело: по очереди и не во время навыка
  body(fn, { source = 'brain' } = {}) {
    if (this.current && this.current.source === 'autopilot' && source !== 'autopilot')
      return this.stop('вытеснен командой мозга').then(() => this.body(fn, { source: 'autopilot' })); // повторно не вытесняем: не снялся — «занят»
    if (this.current) return Promise.resolve({ ok: false, error: this.busyInfo() });
    this.legacyBusy++;
    const p = this.chain.then(() => {
      if (this.current) return { ok: false, error: this.busyInfo() };
      return fn();
    });
    this.chain = p.catch(() => {}).finally(() => { this.legacyBusy--; });
    return p;
  }

  info() { return this.current ? this.current.info() : null; }
}

module.exports = { TaskManager, Task };
