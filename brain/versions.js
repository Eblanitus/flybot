// Версии выученных навыков: все версии навыка лежат рядом и вызываются по своему имени.
//   brain/learned/build_hut.js      — версия без номера (та, что была текущей при переходе на версии 22.10)
//   brain/learned/build_hut_v3.js   — версия 3; у каждой свой счёт runs/ok/fail в skills_stats.json
// Первая строка файла версии: «// версия: когда подходит / чем отличается от других версий».
// Исправление навыка = новая версия <имя>_v<N+1>; старые не трогаются и не удаляются.
// Здесь только чтение/копирование файлов, без сервера: использует runner.js, проверяет test/versions.js.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION_RE = /^([a-z][a-z0-9_]*?)_v(\d{1,3})$/;
const HIST_RE = /^([a-z][a-z0-9_]{1,39})\.(\d{14}-\d{3})\.js$/;
const NOTE_RE = /^﻿?[ \t]*\/\/[ \t]*версия:[ \t]*(.*?)[ \t]*\r?$/;
const NO_NOTE = 'отличие: см. код, не описано';

const sha = s => crypto.createHash('sha1').update(s).digest('hex');
// build_hut_v3 -> {base:'build_hut', n:3}; build_hut -> {base:'build_hut', n:0}
function parseName(name) {
  const m = VERSION_RE.exec(String(name || ''));
  return m ? { base: m[1], n: parseInt(m[2], 10) } : { base: String(name || ''), n: 0 };
}
const baseOf = name => parseName(name).base;

// строка «// версия: …» — только первая строка файла
function noteOf(src) {
  const first = String(src || '').split('\n', 1)[0];
  const m = NOTE_RE.exec(first);
  return m ? (m[1] || null) : null;
}
// текст без строки версии — по нему сравниваем версии (одинаковый код = одна версия)
function stripNote(src) {
  src = String(src || '');
  const i = src.indexOf('\n');
  const first = i < 0 ? src : src.slice(0, i);
  return NOTE_RE.test(first) ? (i < 0 ? '' : src.slice(i + 1)) : src.replace(/^﻿/, '');
}
const codeHash = src => sha(stripNote(src).replace(/\r\n/g, '\n'));
const withNote = (note, src) => `// версия: ${String(note).replace(/[\r\n]+/g, ' ').trim()}\n` + stripNote(src);

const listJs = dir => { try { return fs.readdirSync(dir).filter(f => /^[a-z][a-z0-9_]*\.js$/.test(f)); } catch (e) { return []; } };

// все версии навыка base в папке: [{name, n, file}] по номеру (без номера — первой)
function versionsOf(dir, base) {
  const out = [];
  for (const f of listJs(dir)) {
    const name = f.slice(0, -3), p = parseName(name);
    if (p.base === base) out.push({ name, n: p.n, file: path.join(dir, f) });
  }
  return out.sort((a, b) => a.n - b.n);
}
const nextName = (dir, base) => base + '_v' + (versionsOf(dir, base).reduce((m, v) => Math.max(m, v.n), 0) + 1);

// Вытащить версии из .history в рабочие навыки (копия, .history не трогается).
// Одинаковый код (без строки версии) второй раз не кладём. Возвращает [{name, from, base}].
function importHistory(dir, opts = {}) {
  const hist = opts.historyDir || path.join(dir, '.history');
  let files = [];
  try { files = fs.readdirSync(hist).filter(f => HIST_RE.test(f)); } catch (e) { return []; }
  files.sort((a, b) => HIST_RE.exec(a)[2].localeCompare(HIST_RE.exec(b)[2]) || a.localeCompare(b)); // старые первыми
  const known = new Map(); // base -> Set(hash)
  const hashes = base => {
    if (!known.has(base)) {
      const s = new Set();
      for (const v of versionsOf(dir, base)) { try { s.add(codeHash(fs.readFileSync(v.file, 'utf8'))); } catch (e) {} }
      known.set(base, s);
    }
    return known.get(base);
  };
  const made = [];
  for (const f of files) {
    const m = HIST_RE.exec(f), base = baseOf(m[1]);
    let src;
    try { src = fs.readFileSync(path.join(hist, f), 'utf8'); } catch (e) { continue; }
    const h = codeHash(src), set = hashes(base);
    if (set.has(h)) continue;
    const name = nextName(dir, base);
    if (name.length > 40) continue;
    const note = (opts.noteFor && opts.noteFor(name, f)) || `из истории ${m[2]}; ${NO_NOTE}`;
    fs.writeFileSync(path.join(dir, name + '.js'), withNote(note, src), { flag: 'wx' });
    set.add(h);
    made.push({ name, from: f, base });
  }
  return made;
}

// Сохранить код как новую версию, если такого кода у навыка ещё нет (кроме файла skip). Возвращает имя или null.
function keepAsVersion(dir, base, src, note, skip) {
  const h = codeHash(src);
  for (const v of versionsOf(dir, base)) {
    if (skip && v.name === skip) continue;
    try { if (codeHash(fs.readFileSync(v.file, 'utf8')) === h) return null; } catch (e) {}
  }
  const name = nextName(dir, base);
  if (name.length > 40) return null;
  fs.writeFileSync(path.join(dir, name + '.js'), withNote(note || NO_NOTE, src), { flag: 'wx' });
  return name;
}

// Сжатый список для мозга: навык -> версии, лучшие по счёту сверху.
// skills: [{name, description, params, valid, enabled, stats:{runs,ok,fail}, note}]
const score = s => { const st = s.stats || {}; return ((st.ok || 0) + 1) / ((st.runs || 0) + 2); };
function group(skills) {
  const g = new Map();
  for (const s of skills) {
    const p = parseName(s.name);
    if (!g.has(p.base)) g.set(p.base, []);
    g.get(p.base).push({ ...s, n: p.n });
  }
  const out = [];
  for (const [base, list] of g) {
    const ready = list.filter(v => v.valid !== false), broken = list.filter(v => v.valid === false);
    ready.sort((a, b) => (b.enabled !== false) - (a.enabled !== false) || score(b) - score(a) || ((b.stats || {}).runs || 0) - ((a.stats || {}).runs || 0) || b.n - a.n);
    const head = ready.find(v => v.description) || list.find(v => v.description) || list[0];
    const next = base + '_v' + (list.reduce((m, v) => Math.max(m, v.n), 0) + 1);
    out.push({ base, description: head && head.description || null, params: head && head.params ? Object.keys(head.params) : [], versions: ready, broken, next });
  }
  return out.sort((a, b) => a.base.localeCompare(b.base));
}
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// текст каталога. full — заметки версий целиком (для одного навыка)
function catalogText(groups, { full = false } = {}) {
  const nv = groups.reduce((a, g) => a + g.versions.length, 0), nb = groups.reduce((a, g) => a + g.broken.length, 0);
  const lines = [`Выученные навыки: ${groups.length}, рабочих версий: ${nv}` + (nb ? `, не проходят проверку: ${nb} (скрыты, видны в /skills)` : '') + '.',
    'Навык: что делает | params. Под ним версии, лучшие по счёту сверху: имя ok/запусков — когда подходит / чем отличается. Запуск версии — /go?name=<имя версии>. [выкл] — выключена.'];
  for (const g of groups) {
    lines.push('');
    lines.push(`${g.base} — ${clip(g.description || 'без описания', full ? 600 : 150)}` + (g.params.length ? ` | ${g.params.join(' ')}` : ''));
    for (const v of g.versions) {
      const st = v.stats || {};
      const note = v.note || (g.versions.length + g.broken.length > 1 ? NO_NOTE : 'единственная версия');
      lines.push(`  ${v.name} ${st.ok || 0}/${st.runs || 0}${v.enabled === false ? ' [выкл]' : ''} — ${full ? note : clip(note, 110)}`);
    }
    if (g.broken.length) lines.push(`  не проходят проверку: ${g.broken.map(v => v.name).join(', ')}`);
    if (full) lines.push(`  новая версия будет: ${g.next}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { VERSION_RE, NO_NOTE, parseName, baseOf, noteOf, stripNote, codeHash, withNote, versionsOf, nextName, importHistory, keepAsVersion, group, catalogText, score };
