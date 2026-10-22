// «Консоль ролей» для аудита: журналы мозга, учителя, инженера и сторожа построчно, как в терминале — со временем и типом строки.
// Только чтение файлов. Журналы:
//   мозг     — data/night.log и data/night-*.log (вывод opencode run через tools/tstamp.js: «[ЧЧ:ММ:СС] строка»; старые строки без метки),
//              «===== [дата время] brain start, model X =====» — начало сессии;
//   учитель  — data/teacher-<случай>.log (по файлу на случай), инженер — data/engineer-<заявка>.log и data/engineer-core-<id>.log
//              (в файл дописываются все попытки; «> build · модель» — начало попытки). Метки времени — с этого обновления сторожа;
//   сторож   — data/guard.log («[ГГГГ-ММ-ДД ЧЧ:ММ:СС] текст»): когда учитель/инженер взяли случай и закончили.
// У строк без метки время ПРИМЕРНОЕ (approx): попытка роли длилась от «взял» до «закончил» по guard.log (у мозга — от «brain start» до
// следующего запуска), строка ставится внутрь по доле байтов. Так и показывается: «≈».
'use strict';
const fs = require('fs');
const path = require('path');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = s => String(s).replace(ANSI, '');
const STAMP = /^\[(\d\d):(\d\d):(\d\d)\] /;
const HEADER = /^=====\s*\[(\d\d)\.(\d\d)\.(\d{4})\s+(\d{1,2}):(\d\d):(\d\d)[,.]?\d*\]\s*(.*?)\s*=====\s*$/;
const BUILD = /^>\s*build\b/;

// ======================= файлы =======================

function fstat(file) { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { return null; } }
function readRange(file, start, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.max(0, end - start), buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (n <= 0) break; got += n; }
    return buf.subarray(0, got);
  } catch (e) { return null; } finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) {} } }
}
function decodeLine(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
  try { return new TextDecoder('windows-1251').decode(buf); } catch (e) { return buf.toString('latin1'); }
}
// Буфер -> строки с абсолютным смещением начала (base — смещение буфера в файле). Последняя строка без \n тоже берётся.
function splitLines(buf, base) {
  const out = []; let p = 0;
  while (p < buf.length) {
    let q = buf.indexOf(10, p); const last = q < 0; if (last) q = buf.length;
    let b = buf.subarray(p, q);
    if (base + p === 0 && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
    out.push({ off: base + p, raw: decodeLine(b).replace(/\r/g, '') });
    p = q + 1;
  }
  return out;
}

// ======================= метки начала попыток (сканирование всего файла, с запоминанием) =======================
// -> [{off, abs?, sec?, model?}] : abs — «brain start» (точное время с датой), sec — метка «[ЧЧ:ММ:СС]» у «> build»
const markScan = new Map();
function scanMarks(file) {
  const st = fstat(file); if (!st) return [];
  let sc = markScan.get(file);
  if (!sc || st.size < sc.pos) sc = { pos: 0, items: [], tail: '' };
  if (st.size > sc.pos) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const CH = 1024 * 1024;
      let pos = sc.pos - sc.tail.length;   // недочитанная строка с прошлого раза
      let carry = sc.tail;
      let read = sc.pos;
      while (read < st.size) {
        const len = Math.min(CH, st.size - read), buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, read); if (got <= 0) break;
        const text = carry + buf.subarray(0, got).toString('latin1'); // latin1: символ = байт, смещения совпадают
        read += got;
        let p = 0;
        for (;;) {
          const q = text.indexOf('\n', p); if (q < 0) break;
          const line = stripAnsi(text.slice(p, q)).replace(/\r/g, '');
          const s = STAMP.exec(line), body = s ? line.slice(s[0].length) : line;
          let m;
          if ((m = HEADER.exec(body)) && /brain start/.test(m[7])) {
            const mm = /model\s+(\S+)/.exec(m[7]);
            sc.items.push({ off: pos + p, abs: new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime(), model: mm ? mm[1] : null, kind: 'start' });
          } else if (BUILD.test(body)) {
            sc.items.push({ off: pos + p, sec: s ? (+s[1] * 60 + +s[2]) * 60 + +s[3] : null, model: body.replace(/^>\s*build\s*·?\s*/, '').trim() || null, kind: 'build' });
          }
          p = q + 1;
        }
        carry = text.slice(p); pos += p;
      }
      sc.tail = carry; sc.pos = read;
    } catch (e) {} finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) {} } }
    markScan.set(file, sc);
  }
  return sc.items;
}

// ======================= сторож: сеансы учителя и инженера (data/guard.log) =======================
// -> [{role, key, log, S, E, model, pid, type, how}] ; E = null — ещё идёт (по журналу сторожа)
function parseGuardSessions(lines) {
  const out = [], open = new Map();
  const close = (k, ts, how) => { const s = open.get(k); if (s) { s.E = ts; s.how = how; open.delete(k); } };
  for (const l of lines) {
    const m0 = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]\s*(.*)$/.exec(String(l).replace(/^﻿/, '').replace(/\r/g, ''));
    if (!m0) continue;
    const ts = new Date(+m0[1], +m0[2] - 1, +m0[3], +m0[4], +m0[5], +m0[6]).getTime(), t = m0[7];
    let m;
    if (/^сторож запущен/.test(t)) { for (const k of [...open.keys()]) close(k, ts, 'сторож перезапущен'); continue; }
    if ((m = /^учитель: взял случай (\S+) \((\w+), pid (\d+), модель (\S+?)\)/.exec(t))) {
      const k = 'teacher:' + m[1]; close(k, ts, '?');
      const s = { role: 'teacher', key: m[1], log: 'teacher-' + m[1] + '.log', S: ts, E: null, type: m[2], pid: +m[3], model: m[4] };
      out.push(s); open.set(k, s); continue;
    }
    if ((m = /^учитель: (\S+) — (.*)$/.exec(t))) { if (!/^завис/.test(m[2])) close('teacher:' + m[1], ts, m[2]); continue; }
    if ((m = /^инженер: взял заявку (\S+) \(pid (\d+), модель (\S+?)\)/.exec(t))) {
      const k = 'engineer:' + m[1]; close(k, ts, '?');
      const s = { role: 'engineer', key: m[1], log: 'engineer-' + m[1] + '.log', S: ts, E: null, type: 'skill', pid: +m[2], model: m[3] };
      out.push(s); open.set(k, s); continue;
    }
    if ((m = /^ядро: инженер взял разрешённый запрос (\S+) \(pid (\d+), модель (\S+?)\)/.exec(t))) {
      const k = 'engineer:core-' + m[1]; close(k, ts, '?');
      const s = { role: 'engineer', key: m[1], log: 'engineer-core-' + m[1] + '.log', S: ts, E: null, type: 'core', pid: +m[2], model: m[3] };
      out.push(s); open.set(k, s); continue;
    }
    if ((m = /^инженер: (\S+) — (.*)$/.exec(t))) { if (!/^завис/.test(m[2])) close('engineer:' + m[1], ts, m[2]); continue; }
    if ((m = /^ядро: ([0-9a-f]{10}) — (.*)$/.exec(t))) { if (!/^завис/.test(m[2])) close('engineer:core-' + m[1], ts, m[2]); continue; }
  }
  return out;
}

// ======================= разбор строк журнала роли =======================
// Строка -> запись консоли: {off, k, text, ts?, approx?, body?: [строки], tag?, say?}
//   k: start (запуск мозга), model (попытка: «> build · модель»), think (слова модели), cmd ($ команда; ответ — body),
//      read (→ чтение / ✱ поиск), write (← правка/запись файла; дифф — body), fail (✗ отказ инструмента), err (Error:), guard (строка сторожа)
const BODY_MAX = 400; // строк в одном ответе/диффе (дальше — «…ещё N»)
function describeCmd(cmd) {
  const m = /"(https?:\/\/[^"]+)"/.exec(cmd) || /(https?:\/\/\S+)/.exec(cmd);
  if (!m) return { tag: 'оболочка' };
  let u; try { u = new URL(m[1]); } catch (e) { return { tag: 'оболочка' }; }
  const who = u.port === '3199' ? 'тело' : u.port === '3200' ? 'исполнитель' : u.port === '3099' ? 'сосед' : u.host;
  const g = k => u.searchParams.get(k);
  const what = u.pathname === '/do' ? (g('action') || 'do') : u.pathname === '/go' ? 'навык ' + (g('name') || '?') : u.pathname.replace(/^\//, '');
  return { tag: who + ' · ' + what, say: u.pathname === '/do' && g('action') === 'chat' ? g('text') : null };
}
function parseRoleLines(lines) {
  const out = [];
  let cur = null; // запись, к которой копятся строки ответа/диффа
  let lastDiff = null; // правка файла, чей дифф прервала пустая строка (пустая строка внутри диффа)
  for (const { off, raw } of lines) {
    let line = stripAnsi(raw);
    const s = STAMP.exec(line); let sec = null;
    if (s) { line = line.slice(s[0].length); sec = (+s[1] * 60 + +s[2]) * 60 + +s[3]; }
    if (line.trim() === '') { if (cur) lastDiff = cur.k === 'write' && cur.body.some(b => /^@@ /.test(b)) ? cur : null; cur = null; continue; }
    if (lastDiff && out[out.length - 1] === lastDiff && /^(\+|-|@@ )/.test(line)) cur = lastDiff;
    lastDiff = null;
    const push = e => { e.off = off; if (sec != null) e.sec = sec; out.push(e); return e; };
    if (cur) {
      if (cur.body.length < BODY_MAX) cur.body.push(line.length > 2000 ? line.slice(0, 2000) + '…' : line); else cur.cut = (cur.cut || 0) + 1;
      continue;
    }
    let m;
    if ((m = HEADER.exec(line))) {
      const mm = /model\s+(\S+)/.exec(m[7]);
      const e = push({ k: 'start', text: 'мозг запущен' + (mm ? ' — модель ' + mm[1] : ''), abs: new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime() });
      delete e.sec; continue;
    }
    if ((m = /^\[guard (\d\d):(\d\d):(\d\d)\]\s*(.*)$/.exec(line))) { const e = push({ k: 'guard', text: 'сторож: ' + m[4] }); e.sec = (+m[1] * 60 + +m[2]) * 60 + +m[3]; continue; }
    if (BUILD.test(line)) { push({ k: 'model', text: 'попытка: ' + line.replace(/^>\s*/, '') }); continue; }
    if (line.startsWith('$ ')) { const cmd = line.slice(2); const d = describeCmd(cmd); cur = push({ k: 'cmd', text: cmd.slice(0, 3000), tag: d.tag, ...(d.say ? { say: d.say } : {}), body: [] }); continue; }
    if ((line[0] === '→' || line[0] === '✱' || line[0] === '↗') && line[1] === ' ') { push({ k: 'read', text: line.slice(2) }); continue; }
    if (line[0] === '←' && line[1] === ' ') { cur = push({ k: 'write', text: line.slice(2), body: [] }); continue; }
    if (line[0] === '✗' && line[1] === ' ') { cur = push({ k: 'fail', text: line.slice(2), body: [] }); continue; }
    if (/^Error:/.test(line)) { push({ k: 'err', text: line.slice(0, 3000) }); continue; }
    push({ k: 'think', text: line.length > 4000 ? line.slice(0, 4000) + '…' : line });
  }
  for (const e of out) if (e.body && !e.body.length) delete e.body;
  return out;
}

// Время записей. Точное: метка «[ЧЧ:ММ:СС]» (день — от последнего «brain start» до неё, а без него — назад от anchor) и сам «brain start».
// Примерное: строки без метки — внутри своей попытки (runs: [{off, end, S, E}]) по доле байтов.
function assignTimes(entries, opts) {
  const { anchor, prevAbs, runs } = opts;
  // 1) вперёд от «brain start» (прошлый — prevAbs — если запись началась раньше куска)
  let base = prevAbs != null ? prevAbs : null, last = base;
  const dayOf = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const firstStart = entries.findIndex(e => e.abs != null);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.abs != null) { e.ts = e.abs; base = last = e.abs; continue; }
    if (e.sec == null || base == null) continue;
    let t = dayOf(last) + e.sec * 1000;
    while (t < last - 3600e3) t += 86400e3;   // перешли через полночь
    e.ts = last = t;
  }
  // 2) назад от anchor — метки до первого «brain start» (у учителя и инженера его нет вовсе)
  const upto = base == null || prevAbs == null ? (firstStart < 0 ? entries.length : firstStart) : 0;
  let cur = upto < entries.length && entries[upto].ts != null ? entries[upto].ts : anchor;
  for (let i = upto - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.sec == null || e.ts != null) { if (e.ts != null) cur = e.ts; continue; }
    const d = new Date(cur);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + e.sec * 1000;
    while (t > cur + 120000) t -= 86400e3;
    e.ts = cur = t;
  }
  // 3) без метки — примерно, внутри попытки
  let ri = 0;
  for (const e of entries) {
    if (e.ts != null) continue;
    while (ri + 1 < (runs || []).length && runs[ri + 1].off <= e.off) ri++;
    const r = runs && runs[ri] && runs[ri].off <= e.off ? runs[ri] : null;
    if (!r) { if (anchor != null) { e.ts = anchor; e.approx = true; } continue; }
    if (r.S == null && r.E == null) continue;
    const S = r.S != null ? r.S : r.E, E = r.E != null ? r.E : r.S;
    const frac = r.end > r.off ? Math.min(1, Math.max(0, (e.off - r.off) / (r.end - r.off))) : 0;
    e.ts = Math.round(S + (E - S) * frac); e.approx = true;
  }
  for (const e of entries) { delete e.sec; delete e.abs; }
  return entries;
}

// Попытки в файле: у мозга — от «brain start» до следующего (или до времени изменения файла);
// у учителя/инженера — «> build», сопоставленные с сеансами из guard.log с конца (последняя попытка ↔ последний сеанс).
function runsFor(file, role, sessions, st) {
  const marks = scanMarks(file);
  const out = [];
  if (role === 'brain') {
    const starts = marks.filter(m => m.kind === 'start');
    starts.forEach((m, i) => out.push({ off: m.off, end: i + 1 < starts.length ? starts[i + 1].off : st.size, S: m.abs, E: i + 1 < starts.length ? starts[i + 1].abs : st.mtimeMs }));
    return out;
  }
  const builds = marks.filter(m => m.kind === 'build');
  const ses = (sessions || []).filter(s => s.log === path.basename(file));
  for (let i = 0; i < builds.length; i++) {
    const j = ses.length - (builds.length - i);
    const s = j >= 0 ? ses[j] : null;
    const isLast = i === builds.length - 1;
    out.push({ off: builds[i].off, end: isLast ? st.size : builds[i + 1].off, S: s ? s.S : null, E: s && s.E != null ? Math.min(s.E, st.mtimeMs + 1000) : (isLast ? st.mtimeMs : (s ? s.S : null)) });
  }
  return out;
}

// Кусок журнала роли: from — дочитать с этого байта (живое обновление), before — кусок, кончающийся здесь («раньше»), иначе хвост.
// -> {file, size, mtimeMs, start, end, entries}
const TAIL = 400 * 1024;
function readRoleLog(file, role, opts) {
  opts = opts || {};
  const st = fstat(file); if (!st) return null;
  const max = opts.max || TAIL;
  let start, end = st.size, aligned = false;
  if (opts.from != null && opts.from >= 0 && opts.from <= st.size) { start = opts.from; if (end - start > max) { start = end - max; aligned = true; } }
  else if (opts.before != null && opts.before > 0 && opts.before <= st.size) { end = opts.before; start = Math.max(0, end - max); aligned = start > 0; }
  else { start = Math.max(0, end - max); aligned = start > 0; }
  const buf = readRange(file, start, end) || Buffer.alloc(0);
  let lines = splitLines(buf, start);
  if (aligned && lines.length) {
    lines.shift(); // первая строка оборвана
    // не начинать с середины ответа или диффа: до первой пустой строки (если она недалеко)
    const i = lines.findIndex(l => stripAnsi(l.raw).replace(STAMP, '').trim() === '');
    if (i > 0 && lines[i].off - start < 64 * 1024) lines = lines.slice(i);
  }
  const entries = parseRoleLines(lines);
  const runs = runsFor(file, role, opts.sessions, st);
  const marks = scanMarks(file);
  const firstOff = lines.length ? lines[0].off : start;
  const prev = marks.filter(m => m.kind === 'start' && m.off < firstOff).pop();
  const nextStart = marks.find(m => m.kind === 'start' && m.off >= end);
  const anchor = opts.anchor != null ? opts.anchor : nextStart ? nextStart.abs : st.mtimeMs;
  assignTimes(entries, { anchor, prevAbs: prev ? prev.abs : null, runs });
  return { file: path.basename(file), size: st.size, mtimeMs: st.mtimeMs, start: firstOff, end, entries };
}

// guard.log -> записи консоли (время точное)
function guardEntries(dataDir, max) {
  const file = path.join(dataDir, 'guard.log');
  const st = fstat(file); if (!st) return { file: 'guard.log', size: 0, mtimeMs: null, start: 0, end: 0, entries: [] };
  const start = Math.max(0, st.size - (max || 200 * 1024));
  let lines = splitLines(readRange(file, start, st.size) || Buffer.alloc(0), start);
  if (start > 0) lines.shift();
  const entries = [];
  for (const { off, raw } of lines) {
    const m = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]\s*(.*)$/.exec(raw.replace(/^﻿/, ''));
    if (!m) continue;
    entries.push({ off, k: 'guard', ts: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), text: m[7] });
  }
  return { file: 'guard.log', size: st.size, mtimeMs: st.mtimeMs, start: lines.length ? lines[0].off : start, end: st.size, entries };
}

// Сеансы из guard.log (кэш по размеру файла)
let sesCache = null;
function loadSessions(dataDir) {
  const file = path.join(dataDir, 'guard.log');
  const st = fstat(file); if (!st) return [];
  const stamp = file + ':' + st.size + ':' + st.mtimeMs;
  if (sesCache && sesCache.stamp === stamp) return sesCache.value;
  const buf = readRange(file, Math.max(0, st.size - 4 * 1024 * 1024), st.size) || Buffer.alloc(0);
  const value = parseGuardSessions(splitLines(buf, 0).map(l => l.raw));
  sesCache = { stamp, value };
  return value;
}

// Ошибки модели из общего журнала opencode (~/.local/share/opencode/log/opencode.log):
// «timestamp=… level=ERROR … modelID=… small=false … error.error="…"». Строки small=true — служебный заголовок сеанса, их пропускаем.
// В журнал роли такие ошибки не попадают — роль просто молча висит, поэтому консоль показывает их отдельно.
function parseOpencodeErrors(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.indexOf('level=ERROR') < 0) continue;
    const ts = /^timestamp=(\S+)/.exec(line); const mid = /\bmodelID=(\S+)/.exec(line);
    const err = /\berror\.error="((?:[^"\\]|\\.)*)"/.exec(line) || /\berror\.error=(\S+)/.exec(line);
    if (!ts || !mid || !err || /\bsmall=true\b/.test(line)) continue;
    const t = Date.parse(ts[1]); if (!isFinite(t)) continue;
    const msg = /\bmessage="([^"]*)"/.exec(line);
    out.push({ ts: t, model: mid[1], text: err[1].replace(/\\"/g, '"').replace(/^AI_APICallError:\s*/, '').slice(0, 600), what: msg ? msg[1] : '' });
  }
  return out;
}
// Хвост журнала opencode (последние 3 МБ — он большой), кэш по размеру
let ocCache = null;
function loadOpencodeErrors(file) {
  const st = fstat(file); if (!st) return [];
  const stamp = file + ':' + st.size + ':' + st.mtimeMs;
  if (ocCache && ocCache.stamp === stamp) return ocCache.value;
  const start = Math.max(0, st.size - 3 * 1024 * 1024);
  const buf = readRange(file, start, st.size) || Buffer.alloc(0);
  const value = parseOpencodeErrors(buf.toString('utf8'));
  ocCache = { stamp, value };
  return value;
}
// Чья это ошибка: роль, у которой в этот момент шёл сеанс на этой модели (учитель/инженер — по сеансам guard.log, мозг — по «brain start»).
// brainRuns: [{S, E, model}]. Если не подошла ни одна роль — role: null.
function attributeErrors(errs, sessions, brainRuns, now) {
  const same = (a, b) => !!a && !!b && (a === b || a.replace(/^opencode\//, '') === b.replace(/^opencode\//, ''));
  return errs.map(e => {
    const who = [];
    for (const s of sessions || []) if ((s.role === 'teacher' || s.role === 'engineer') && same(s.model, e.model) && s.S - 5000 <= e.ts && e.ts <= (s.E != null ? s.E : now) + 5000) { if (!who.includes(s.role)) who.push(s.role); }
    for (const r of brainRuns || []) if (same(r.model, e.model) && r.S - 5000 <= e.ts && e.ts <= r.E + 5000) { if (!who.includes('brain')) who.push('brain'); break; }
    return { ...e, roles: who };
  });
}

// Журналы роли: новые сверху
const ROLE_FILES = { brain: /^night(-.+)?\.log$/, teacher: /^teacher-.+\.log$/, engineer: /^engineer-.+\.log$/, guard: /^guard\.log$/ };
function listRoleFiles(dataDir, role) {
  const re = ROLE_FILES[role]; if (!re) return [];
  let names = []; try { names = fs.readdirSync(dataDir).filter(n => re.test(n)); } catch (e) { return []; }
  return names.map(n => { const st = fstat(path.join(dataDir, n)); return st ? { name: n, size: st.size, mtimeMs: st.mtimeMs } : null; })
    .filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

module.exports = { stripAnsi, splitLines, scanMarks, parseGuardSessions, parseRoleLines, assignTimes, runsFor, readRoleLog, guardEntries, loadSessions, listRoleFiles, describeCmd, parseOpencodeErrors, attributeErrors, loadOpencodeErrors, ROLE_FILES, TAIL };
