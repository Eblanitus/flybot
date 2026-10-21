// Журнал чата: последние реплики игроков, системные строки и экшн-бар.
// Нужен, чтобы мозг видел чат в /snapshot, даже если событие пришло между опросами.
'use strict';

// kind: 'chat' (реплика игрока) | 'system' (системная строка) | 'action_bar' (полоса над хотбаром)
class ChatLog {
  constructor(size = 40) {
    this.size = size;
    this.buf = [];
    this.seq = 0;
  }

  push(kind, text, from = null) {
    const e = {
      id: ++this.seq,
      t: Date.now(),
      kind,
      from,
      text: String(text == null ? '' : text).slice(0, 300)
    };
    this.buf.push(e);
    if (this.buf.length > this.size) this.buf.splice(0, this.buf.length - this.size);
    return e;
  }

  since(id) { return this.buf.filter(e => e.id > (id || 0)).slice(-this.size); }
  last(n = 8) { return this.buf.slice(-n); }
  fresh(ms = 90000) {
    const cut = Date.now() - ms;
    return this.buf.filter(e => e.t >= cut);
  }
}

module.exports = { ChatLog };
