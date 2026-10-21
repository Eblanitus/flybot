// Мелкие куски для программы «Аудит» (audit/server.js): признак «запрос от наблюдателя» и сообщение хозяина мозгу.
// Вынесено из bot.js, чтобы проверять без запуска бота (test/audit.js).
'use strict';

const OWNER = process.env.OWNER_NAME || 'eblanitus228';
const MAX_TEXT = 300;

// Аудит шлёт заголовок X-Observer: 1 — такой запрос НЕ считается признаком «мозг жив» (иначе автопилот замолчит).
function isObserver(req) {
  const v = req && req.headers ? req.headers['x-observer'] : null;
  return v === '1' || v === 'true';
}

// Убираем управляющие и невидимые символы (в том числе нулевой ширины), чтобы «/» нельзя было спрятать за ними.
function cleanText(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) continue;
    if (c === 127 || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) continue;
    out += ch;
  }
  return out.trim();
}

// -> { ok:true, text } | { ok:false, error }. Начинающееся с «/» отклоняем: это команда сервера, а не слова.
function checkOwnerText(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'text должен быть строкой' };
  const text = cleanText(raw);
  if (!text) return { ok: false, error: 'пустое сообщение' };
  if (text.length > MAX_TEXT) return { ok: false, error: `слишком длинное сообщение (максимум ${MAX_TEXT} знаков)` };
  if (text[0] === '/' || text.codePointAt(0) === 0xff0f) return { ok: false, error: 'сообщения, начинающиеся с «/», не принимаются (это команды сервера)' };
  return { ok: true, text };
}

// Кладёт событие owner_msg в обычную ленту (оно же уходит в data/events.log) — мозг увидит его в /wait и /events.
// В игровой чат НЕ пишется.
function ownerMsg(ctx, body) {
  const c = checkOwnerText(body && body.text);
  if (!c.ok) return c;
  const ev = ctx.events.push('owner_msg', { text: c.text, from: OWNER + ' (из программы)' });
  return { ok: true, id: ev && ev.id };
}

module.exports = { isObserver, checkOwnerText, ownerMsg, MAX_TEXT };
