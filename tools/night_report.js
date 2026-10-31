// Ночной отчёт одной страницей. ТОЛЬКО ЧТЕНИЕ: ничего не пишет, не трогает бота и сторожа.
//   node tools/night_report.js            — последние 12 часов
//   node tools/night_report.js 8          — последние 8 часов
//   node tools/night_report.js --since 2026-10-31T00:00:00Z
//   node tools/night_report.js 12 --data <папка data>   (по умолчанию data/ рядом с tools/)
// Источники: data/events.log (время только ЧЧ:ММ:СС по UTC — дату восстанавливаем от mtime файла, как audit/server.js),
// data/blackbox/death-*.json (savedAt, summary.cause), data/guard.log (метки местного времени), data/teacher_queue.json (снимок очереди).
// Чего нет в данных — пишем «нет данных», ничего не выдумываем.
'use strict';
const fs = require('fs');
const path = require('path');

const EVENTS_TAIL_BYTES = 24 * 1024 * 1024; // events.log читаем с хвоста: окно в часах, а файл растёт неделями
const DAY_MS = 86400000;

// ---------- чтение ----------
function readText(file, tailBytes) {
  try {
    const st = fs.statSync(file);
    if (!tailBytes || st.size <= tailBytes) return { text: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs, truncated: false };
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(tailBytes);
      fs.readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
      const text = buf.toString('utf8');
      return { text: text.slice(text.indexOf('\n') + 1), mtimeMs: st.mtimeMs, truncated: true }; // первую (обрезанную) строку выбрасываем
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
}
const hmsToSec = s => { const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null; };

// Полная метка времени (UTC) для событий: идём с конца, последняя строка привязана к mtime файла; время «больше» следующего — было накануне.
function resolveTimes(secs, endMs) {
  const out = new Array(secs.length);
  let cur = endMs;
  for (let i = secs.length - 1; i >= 0; i--) {
    if (secs[i] == null) { out[i] = null; continue; }
    const d = new Date(cur);
    let cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + secs[i] * 1000;
    while (cand > cur + 120000) cand -= DAY_MS;
    out[i] = cand; cur = cand;
  }
  return out;
}
function loadEvents(dataDir) {
  const r = readText(path.join(dataDir, 'events.log'), EVENTS_TAIL_BYTES);
  if (!r) return null;
  const evs = [];
  for (const l of r.text.split('\n')) {
    if (!l || l[0] !== '{') continue;
    try { const e = JSON.parse(l); if (e && typeof e === 'object' && e.type) evs.push(e); } catch (e) {}
  }
  const ts = resolveTimes(evs.map(e => hmsToSec(e.t)), r.mtimeMs);
  evs.forEach((e, i) => { e.ts = ts[i]; });
  return { events: evs, truncated: r.truncated };
}
function loadDeaths(dataDir) {
  const dir = path.join(dataDir, 'blackbox');
  let names; try { names = fs.readdirSync(dir).filter(n => /^death-.*\.json$/.test(n)); } catch (e) { return null; }
  const out = [];
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const t = Date.parse(o.savedAt);
      if (Number.isFinite(t)) out.push({ t, cause: (o.summary && o.summary.cause) || null, file: n });
    } catch (e) {}
  }
  return out;
}
function loadGuard(dataDir) {
  const r = readText(path.join(dataDir, 'guard.log'), 8 * 1024 * 1024);
  if (!r) return null;
  const out = [];
  for (const l of r.text.split('\n')) {
    const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (.*)$/.exec(l.replace(/\r$/, ''));
    if (m) out.push({ t: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), text: m[7] }); // местное время
  }
  return out;
}
function loadQueue(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'teacher_queue.json'), 'utf8')); } catch (e) { return null; }
}

// ---------- утилиты вывода ----------
const NO = 'нет данных';
const pad = n => String(n).padStart(2, '0');
const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const normReason = r => String(r == null ? '' : r).replace(/-?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90) || '(без причины)';

// ---------- разделы ----------
function secDeaths(deaths, since, until) {
  if (!deaths) return `Смерти: ${NO} (нет data/blackbox)`;
  const w = deaths.filter(d => d.t >= since && d.t <= until);
  if (!w.length) return 'Смерти: 0';
  const by = {}; for (const d of w) { const c = d.cause || 'причина не записана'; by[c] = (by[c] || 0) + 1; }
  return `Смерти: ${w.length} (` + top(by, 8).map(([k, v]) => `${k} ${v}`).join(', ') + ')';
}
function secBuilt(evs, since, until) {
  const rep = evs.filter(e => e.type === 'day_report' && e.ts >= since && e.ts <= until);
  if (!rep.length) return [`Построено/вырублено: ${NO} (в окне нет day_report)`, `Здоровье и еда по дням: ${NO}`, `Самый долгий простой: ${idleLine(evs, rep, since, until)}`];
  const sum = f => rep.reduce((s, e) => s + (Number(e[f]) || 0), 0);
  const has = f => rep.some(e => e[f] != null);
  const zero = rep.filter(e => !(Number(e.built) > 0) && !(Number(e.cut) > 0)).length;
  const lines = [];
  lines.push(`Построено: ${sum('built')} бл., вырублено: ${has('cut') ? sum('cut') + ' бл.' : NO + ' (в day_report ещё нет поля cut)'}; служебных ${sum('aux')}; игровых дней ${rep.length}, из них без прогресса ${zero}`);
  const hp = rep.filter(e => e.minHp != null), low = rep.filter(e => e.lowHpMin != null), food = rep.filter(e => e.duskFood != null);
  const parts = [];
  parts.push(hp.length ? `минимум HP ${Math.min(...hp.map(e => e.minHp))}` : `минимум HP: ${NO}`);
  parts.push(low.length ? `при HP≤4 всего ${Math.round(low.reduce((s, e) => s + e.lowHpMin, 0) * 10) / 10} мин` : `минуты при HP≤4: ${NO}`);
  parts.push(food.length ? `еда на закате: ${food.map(e => e.duskFood).join(', ')}` : `еда на закате: ${NO}`);
  lines.push('Здоровье и еда по дням: ' + parts.join('; '));
  lines.push(`Самый долгий простой: ${idleLine(evs, rep, since, until)}`);
  return lines;
}
function idleLine(evs, rep, since, until) {
  const idle = evs.filter(e => e.type === 'progress_idle' && e.ts >= since && e.ts <= until && Number.isFinite(Number(e.min)));
  const fromEv = idle.length ? Math.max(...idle.map(e => Number(e.min))) : null;
  const fromRep = rep.filter(e => e.idleMaxMin != null).length ? Math.max(...rep.filter(e => e.idleMaxMin != null).map(e => Number(e.idleMaxMin))) : null;
  if (fromEv == null && fromRep == null) return idle.length || rep.length ? '0 мин' : NO;
  const best = Math.max(fromEv || 0, fromRep || 0);
  return `${best} мин (progress_idle: ${fromEv == null ? NO : fromEv + ' мин'}; day_report: ${fromRep == null ? NO : fromRep + ' мин'})`;
}
function secFails(evs, since, until) {
  const f = evs.filter(e => e.type === 'task_failed' && e.ts >= since && e.ts <= until);
  if (!f.length) return 'Провалы задач: 0';
  const by = {};
  for (const e of f) { const k = `${e.name || '?'} — ${normReason(e.reason)}`; by[k] = (by[k] || 0) + 1; }
  return `Провалы задач: ${f.length}; топ-5:\n` + top(by, 5).map(([k, v]) => `  ${v}× ${k}`).join('\n');
}
function secFled(evs, since, until) {
  const esc = evs.filter(e => e.type === 'task_done' && e.name === 'escape' && e.ts >= since && e.ts <= until && e.result && typeof e.result.fled === 'boolean');
  if (!esc.length) return `Побеги escape: ${NO}`;
  const bad = esc.filter(e => e.result.fled === false).length;
  return `Побеги escape: ${esc.length}, не убежала (fled:false) ${bad} = ${Math.round(bad * 100 / esc.length)}%`;
}
function secGuard(guard, since, until) {
  if (!guard) return [`Сторож убил мозг: ${NO} (нет data/guard.log)`, `Лимиты учителя: ${NO} (нет data/guard.log)`];
  const w = guard.filter(g => g.t >= since && g.t <= until);
  const kills = w.filter(g => /убиваю/.test(g.text)).length;
  const lim = {};
  for (const g of w) { if (!/лимит запросов/.test(g.text)) continue; const m = /^([^:]+):/.exec(g.text); const who = m ? m[1].trim() : 'другое'; lim[who] = (lim[who] || 0) + 1; }
  const limN = Object.values(lim).reduce((s, v) => s + v, 0);
  const took = w.filter(g => /^учитель: взял случай/.test(g.text)).length;
  const done = w.filter(g => /^учитель: .*закончил \(done\)/.test(g.text)).length;
  const failed = w.filter(g => /^учитель: .*закончил \(failed\)/.test(g.text)).length;
  return [`Сторож убил мозг: ${kills} раз`,
    `Лимиты учителя: ${limN ? `упёрлись в лимит запросов ${limN} раз (` + top(lim, 5).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : 'упёрлись в лимит 0 раз'}; случаев взято ${took}, закончено done ${done} / failed ${failed}`];
}
function secQueue(q) {
  if (!q || !Array.isArray(q.cases)) return `Очередь учителя сейчас: ${NO}`;
  const by = {}; for (const c of q.cases) by[c.status || '?'] = (by[c.status || '?'] || 0) + 1;
  return 'Очередь учителя сейчас (снимок, не за окно): ' + (top(by, 6).map(([k, v]) => `${k} ${v}`).join(', ') || 'пусто');
}

// ---------- сборка ----------
function parseArgs(argv) {
  const o = { hours: 12, since: null, data: path.join(__dirname, '..', 'data'), now: Date.now() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') { const t = Date.parse(argv[++i]); if (!Number.isFinite(t)) throw new Error('--since: не понимаю дату (нужен ISO, например 2026-10-31T00:00:00Z)'); o.since = t; }
    else if (a === '--data') o.data = path.resolve(argv[++i]);
    else if (a === '--now') o.now = Date.parse(argv[++i]);
    else if (/^\d+(\.\d+)?$/.test(a)) o.hours = Number(a);
    else throw new Error('неизвестный аргумент: ' + a);
  }
  return o;
}
function buildReport(opts) {
  const until = opts.now == null ? Date.now() : opts.now;
  const since = opts.since != null ? opts.since : until - (opts.hours == null ? 12 : opts.hours) * 3600000;
  const ev = loadEvents(opts.data);
  const evs = ev ? ev.events : null;
  const out = [];
  out.push(`Ночной отчёт: ${fmt(since)} — ${fmt(until)} (${Math.round((until - since) / 360000) / 10} ч, местное время)`);
  out.push(secDeaths(loadDeaths(opts.data), since, until));
  if (evs) {
    if (ev.truncated && evs.length && evs[0].ts > since) out.push(`(!) events.log прочитан с хвоста, начало окна могло не попасть`);
    out.push(...[].concat(secBuilt(evs, since, until)));
    out.push(secFails(evs, since, until));
    out.push(secFled(evs, since, until));
  } else {
    out.push(`Построено/вырублено: ${NO} (нет data/events.log)`, `Самый долгий простой: ${NO}`, `Провалы задач: ${NO}`, `Побеги escape: ${NO}`);
  }
  out.push(...secGuard(loadGuard(opts.data), since, until));
  out.push(secQueue(loadQueue(opts.data)));
  return out.join('\n');
}

module.exports = { buildReport, parseArgs, resolveTimes, normReason };

if (require.main === module) {
  try { console.log(buildReport(parseArgs(process.argv.slice(2)))); }
  catch (e) { console.error('night_report: ' + e.message); process.exit(2); }
}
