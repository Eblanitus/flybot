// Журнал событий (кольцевой буфер) + long-poll ожидание "разбудить мозг по делу".
'use strict';

// Типы, которые НЕ будят мозг (только пишутся в журнал)
const QUIET = new Set(['info', 'task_started', 'progress', 'spawn', 'behavior']); // behavior — версии/откаты поведения, для аудита

class EventHub {
  constructor(size = 200) {
    this.size = size;
    this.buf = [];
    this.seq = 0;
    this.waiters = new Set();
    this.delivered = 0; // курсор: до какого id события уже отданы через /wait
  }

  push(type, data = {}) {
    const ev = { id: ++this.seq, t: new Date().toISOString().slice(11, 19), type, ...data };
    this.buf.push(ev);
    if (this.buf.length > this.size) this.buf.splice(0, this.buf.length - this.size);
    console.log('[event]', type, JSON.stringify(data).slice(0, 200));
    if (!QUIET.has(type) && !data.sync) {
      for (const w of this.waiters) w();
    }
    return ev;
  }

  since(id, limit = 50) {
    const out = this.buf.filter(e => e.id > id);
    return out.slice(-limit);
  }

  wakeSince(id) { return this.buf.filter(e => e.id > id && !QUIET.has(e.type) && !e.sync); }

  // Ждать важное событие с id > since. since по умолчанию — серверный курсор.
  wait(since, timeoutMs) {
    const from = since == null ? this.delivered : since;
    const ready = this.wakeSince(from);
    if (ready.length) return Promise.resolve(this._deliver(ready, false));
    return new Promise(resolve => {
      let done = false;
      const finish = (timedOut) => {
        if (done) return; done = true;
        clearTimeout(timer); this.waiters.delete(onEv);
        resolve(this._deliver(this.wakeSince(from), timedOut));
      };
      const onEv = () => setTimeout(() => finish(false), 150); // чуть подождать — события часто идут пачкой
      const timer = setTimeout(() => finish(true), timeoutMs);
      this.waiters.add(onEv);
    });
  }

  _deliver(events, timedOut) {
    const last = events.length ? events[events.length - 1].id : this.seq;
    this.delivered = Math.max(this.delivered, events.length ? last : this.delivered);
    return { timedOut, events: events.slice(-30), cursor: this.delivered, lastId: this.seq };
  }
}

module.exports = { EventHub, QUIET };
