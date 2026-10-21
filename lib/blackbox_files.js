// Файлы чёрного ящика (data/blackbox): список, краткая сводка, безопасное чтение. Без зависимостей — этим же пользуется программа
// «Аудит» (audit/server.js), когда тело не отвечает или ещё не перезапущено. Только чтение; запись и очистку делает lib/blackbox.js.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_RE = /^(death|near)-[0-9A-Za-z_.-]+\.json$/;
const MAX_READ = 8 * 1024 * 1024;

// Имена своих файлов, старые первыми (порядок по времени в имени; death- и near- вперемешку)
function listFiles(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const key = n => n.replace(/^(death|near)-/, '');
  return names.filter(n => FILE_RE.test(n)).sort((a, b) => key(a).localeCompare(key(b)));
}

// Краткая сводка одного файла для списка
function summaryItem(name, rec, st) {
  const s = rec && rec.summary ? rec.summary : {};
  return {
    name, kind: rec ? rec.kind : name.split('-')[0], savedAt: rec ? rec.savedAt : null, ts: rec && rec.savedAt ? Date.parse(rec.savedAt) : st.mtimeMs,
    cause: s.cause || null, message: s.message || null, pos: s.pos || null, phase: s.phase || null, minHp: s.minHp != null ? s.minHp : null,
    lastTask: s.lastTask ? { name: s.lastTask.name, by: s.lastTask.by } : null, by: s.lastTask ? s.lastTask.by : null,
    worst: s.worst || null, mobs: s.mobs || [], frames: rec && rec.frames ? rec.frames.length : 0, lostTotal: rec && rec.lost ? rec.lost.total : null,
    series: s.series || null, sizeKb: Math.round(st.size / 1024), broken: !rec
  };
}

// -> { ok, dir, total, items: [новые сверху] }; cache — Map (имя -> {key, item}) чтобы не перечитывать неизменившиеся файлы
function list(dir, limit = 100, cache = new Map(), maxFiles = 200) {
  const all = listFiles(dir);
  const out = [];
  for (const n of all.slice().reverse().slice(0, Math.max(1, Math.min(limit, maxFiles)))) {
    const file = path.join(dir, n);
    let st; try { st = fs.statSync(file); } catch (e) { continue; }
    const key = st.size + ':' + st.mtimeMs;
    let c = cache.get(n);
    if (!c || c.key !== key) {
      let rec = null; try { if (st.size <= MAX_READ) rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      c = { key, item: summaryItem(n, rec, st) };
      if (cache.size > 400) cache.clear();
      cache.set(n, c);
    }
    out.push(c.item);
  }
  return { ok: true, dir: 'data/blackbox', total: all.length, items: out };
}

// Прочитать один файл: только data/blackbox, имя строго death-*.json / near-*.json (никаких ../ и подпапок)
function readFile(dir, name) {
  if (typeof name !== 'string' || !FILE_RE.test(name) || name !== path.basename(name)) return { ok: false, status: 400, error: 'плохое имя файла (нужно death-*.json или near-*.json)' };
  const file = path.join(dir, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return { ok: false, status: 400, error: 'плохое имя файла' };
  let st; try { st = fs.statSync(file); } catch (e) { return { ok: false, status: 404, error: 'нет такого файла' }; }
  if (st.size > MAX_READ) return { ok: false, status: 413, error: 'файл слишком большой' };
  try { return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, status: 500, error: 'файл не читается: ' + e.message }; }
}

module.exports = { FILE_RE, MAX_READ, listFiles, list, readFile, summaryItem };
