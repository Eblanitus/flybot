// Общая память мух (этап 2, Б10): таблица решателя (decider.json), способы (variants.json), выживание (experience.json).
// Мир идёт — общие файлы только читаются (жизнь берёт свою копию); мир кончился — стенд сливает в них то, что добавила каждая учащаяся жизнь.
// Формат (проверен по lib/variants.js и lib/experience.js): { stats, recent } — в листьях stats только числа; recent не сливаем. Затухания нет.
'use strict';
const fs = require('fs'), path = require('path');
const FILES = ['variants.json', 'experience.json'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, f); };
// сумма без хвостов float (0.1 + 0.2 → 0.3); целые — как есть
const plus = (a, d) => (Number.isInteger(a) && Number.isInteger(d) ? a + d : Math.round((a + d) * 1000) / 1000);
// к общей (shared) прибавить то, что жизнь добавила к стартовой копии: числа — end − start, объекты — вглубь; массивы (recent) не сливаем
function addDelta(shared, start, end) {
  for (const [k, v] of Object.entries(end || {})) {
    if (typeof v === 'number') shared[k] = plus(typeof shared[k] === 'number' ? shared[k] : 0, v - (start && typeof start[k] === 'number' ? start[k] : 0));
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!shared[k] || typeof shared[k] !== 'object') shared[k] = {};
      addDelta(shared[k], start && start[k], v);
    }
  }
  return shared;
}
// строки deeds.jsonl → { exact: { обстановка: { дело: { n, sum } } }, coarse: { … } }; sum — сумма итогов матчей (очков жизней)
function foldDeeds(mem, rows) {
  mem.exact = mem.exact || {}; mem.coarse = mem.coarse || {};
  for (const r of rows) {
    if (!r || !r.key || !r.sit || typeof r.r !== 'number') continue;
    for (const [tab, k] of [['exact', r.sit], ['coarse', r.coarse]]) {
      if (!k) continue;
      const row = mem[tab][k] = mem[tab][k] || {};
      const a = row[r.key] = row[r.key] || { n: 0, sum: 0 };
      a.n++; a.sum = Math.round((a.sum + r.r) * 100) / 100;
    }
  }
  return mem;
}
// перед жизнью учащейся мухи: общие файлы — в данные жизни, и снимок «как было на старте»
function prepareLife(sharedDir, lifeDir) {
  fs.mkdirSync(path.join(lifeDir, 'data'), { recursive: true });
  for (const f of FILES) {
    const src = path.join(sharedDir, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(lifeDir, 'data', f));
    fs.copyFileSync(src, path.join(lifeDir, 'start_' + f));
  }
}
// после мира: разница жизни — в общие файлы; дела жизни — в таблицу решателя. Возвращает число строк дел.
function mergeLife(sharedDir, lifeDir) {
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const f of FILES) {
    const end = readJson(path.join(lifeDir, 'data', f), null);
    if (!end || !end.stats) continue;
    const start = readJson(path.join(lifeDir, 'start_' + f), { stats: {} });
    const shared = readJson(path.join(sharedDir, f), { stats: {}, recent: [] });
    if (!Array.isArray(shared.recent)) shared.recent = [];
    shared.stats = addDelta(shared.stats || {}, start.stats, end.stats);
    writeJson(path.join(sharedDir, f), shared);
  }
  let rows = [];
  try { rows = fs.readFileSync(path.join(lifeDir, 'deeds.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) {}
  const memF = path.join(sharedDir, 'decider.json');
  writeJson(memF, foldDeeds(readJson(memF, { exact: {}, coarse: {} }), rows));
  return rows.length;
}
module.exports = { addDelta, foldDeeds, prepareLife, mergeLife, FILES };
