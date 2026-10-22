// v0.2: будильник мозга. Мозг — архитектор («что и где»), он не живёт в бесконечной сессии и не ждёт /wait:
// night.cmd зовёт этот скрипт перед каждым запуском мозга — скрипт блокирует, пока нет повода, пишет повод
// в data/wake.md и выходит 0 (тогда петля запускает мозг на одно решение).
//   node tools/brain_wake.js         — ждать повода
//   node tools/brain_wake.js --now   — будить сразу (повод «вручную»)
// Поводы — ТОЛЬКО: build_done (нужна следующая постройка), day_report (новый день — следующий шаг проекта),
// owner_msg и chat от хозяина, в brain/notes.md нет строки «Постройка:» (не чаще NO_BUILD_MS), старт (нет курсора).
// Провалы, простой, смерти, goal_report мозг НЕ будят — это дело мухи (её варианты, учитель, инженер).
// Тело — BODY_URL (http://127.0.0.1:3199), GET /events?since=N раз в POLL_MS; тело недоступно — тихо ждём.
// Курсор — data/brain_wake.json {cursor, at, seen, lastWakeAt}: id событий сбрасываются при рестарте тела
// (lastId < cursor → курсор 0), а уже разбудившие события (seen — ключи без id) второй раз не будят.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { parseBuild } = require('../lib/basegoal');

const ROOT = path.join(__dirname, '..');
const BODY = (process.env.BODY_URL || 'http://127.0.0.1:3199').replace(/\/+$/, '');
const DATA = process.env.WAKE_DATA_DIR || path.join(ROOT, 'data'); // другой каталог — только для проверки
const STATE = path.join(DATA, 'brain_wake.json');
const WAKE = path.join(DATA, 'wake.md');
const NOTES = path.join(ROOT, 'brain', 'notes.md');
const OWNER = process.env.OWNER_NAME || 'eblanitus228'; // как lib/teacher_triggers.js
const POLL_MS = Number(process.env.WAKE_POLL_MS) || 15000;
const NO_BUILD_MS = Number(process.env.WAKE_NO_BUILD_MS) || 30 * 60000; // «нет Постройки» — не чаще (мозг мог решить, что строить нечего)
const SEEN_MAX = 100;
const LINES_MAX = 10;

// ---------- Поводы (чистые функции) ----------
const short = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isOwner = e => e.type === 'owner_msg' || (e.type === 'chat' && e.from === OWNER);
// событие-повод -> {key (без id: переживает рестарт тела), why (повод одной строкой)} | null
function reasonOf(e) {
  if (!e || !e.type) return null;
  if (e.type === 'build_done') {
    const at = Array.isArray(e.at) ? e.at.join(' ') : '';
    return { key: `build_done ${e.name} ${at}`, why: `build_done: ${e.name} у ${at} готова — нужна следующая постройка` };
  }
  if (e.type === 'day_report') return { key: `day_report ${e.day}`, why: `новый день (итог дня ${e.day}) — следующий шаг проекта` };
  if (isOwner(e)) {
    const text = short(e.text, 200);
    if (text.length < 2) return null;
    return { key: `${e.type} ${e.t} ${text}`, why: `хозяин: ${text}` };
  }
  return null;
}
function eventLine(e) {
  const head = `#${e.id} ${e.t || ''} ${e.type}`;
  if (e.type === 'build_done') return `${head} ${e.name} [${(e.at || []).join(', ')}]`;
  if (e.type === 'day_report') return `${head} день ${e.day}: ${short(e.line, 200)}`;
  if (e.type === 'chat' || e.type === 'owner_msg') return `${head} ${e.from || ''}: ${short(e.text, 200)}`;
  return `${head} ${short(JSON.stringify(e), 200)}`;
}
// { events, lastId, notes, st (null — файла нет), now, force } -> { wake: {reason, lines} | null, st (новый) }
function pickWake({ events = [], lastId = 0, notes = '', st = null, now = Date.now(), force = false }) {
  const fresh = !st;
  const s = { cursor: 0, at: null, seen: [], lastWakeAt: 0, ...(st || {}) };
  s.seen = Array.isArray(s.seen) ? s.seen.slice(-SEEN_MAX) : [];
  if (lastId < s.cursor) s.cursor = 0; // тело перезапущено: id пошли сначала
  const news = events.filter(e => e && e.id > s.cursor).sort((a, b) => a.id - b.id);
  s.cursor = Math.max(s.cursor, lastId, ...news.map(e => e.id));
  s.at = new Date(now).toISOString();
  const wake = (reason, lines = []) => { s.lastWakeAt = now; return { wake: { reason, lines: lines.slice(-LINES_MAX) }, st: s }; };
  if (fresh) return wake('старт: курсора нет — новый мозг или первый запуск');
  const hits = [];
  for (const e of news) {
    const r = reasonOf(e);
    if (!r || s.seen.includes(r.key)) continue;
    s.seen.push(r.key);
    hits.push({ e, r });
  }
  s.seen = s.seen.slice(-SEEN_MAX);
  if (hits.length) {
    const reasons = [...new Set(hits.map(h => h.r.why))];
    return wake(reasons.slice(0, 3).join('; ') + (reasons.length > 3 ? ` …и ещё ${reasons.length - 3}` : ''), hits.map(h => eventLine(h.e)));
  }
  if (force) return wake('вручную (--now)');
  if (!parseBuild(notes) && now - (s.lastWakeAt || 0) >= NO_BUILD_MS) return wake('в brain/notes.md нет строки «Постройка:» — нужна постройка проекта');
  return { wake: null, st: s };
}
const pad = n => String(n).padStart(2, '0');
const localTime = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
function wakeText(w, now = Date.now()) {
  return `# Повод разбудить мозг\nВремя: ${localTime(new Date(now))}\nПовод: ${w.reason}\n` +
    (w.lines.length ? `\n## События по поводу\n${w.lines.map(l => '- ' + l).join('\n')}\n` : '');
}

// ---------- Ожидание ----------
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('тайм-аут')));
  });
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const force = process.argv.includes('--now');
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  for (;;) {
    let r = null;
    const st = readJson(STATE);
    try { r = await getJson(`${BODY}/events?since=${(st && st.cursor) || 0}&limit=200`, 8000); } catch (e) { r = null; }
    if (r && Array.isArray(r.events)) {
      const now = Date.now();
      const out = pickWake({ events: r.events, lastId: Number(r.lastId) || 0, notes: readText(NOTES), st, now, force });
      fs.writeFileSync(STATE, JSON.stringify(out.st, null, 1));
      if (out.wake) {
        fs.writeFileSync(WAKE, wakeText(out.wake, now));
        console.log(`[${localTime(new Date(now))}] brain wake: ${out.wake.reason}`);
        return;
      }
    } else if (force) { // тело молчит, а будить велено сразу — будим (курсор не трогаем)
      fs.writeFileSync(WAKE, wakeText({ reason: 'вручную (--now), тело не ответило', lines: [] }));
      console.log(`[${localTime(new Date())}] brain wake: --now (тело не ответило)`);
      return;
    }
    await sleep(POLL_MS); // тело недоступно или повода нет — тихо ждём
  }
}

module.exports = { pickWake, reasonOf, eventLine, wakeText, OWNER, NO_BUILD_MS };
if (require.main === module) main().then(() => { process.exitCode = 0; }, e => { console.error('brain_wake:', e && e.message); process.exitCode = 1; });
