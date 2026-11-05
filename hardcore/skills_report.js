// Сводка по делам (этап 2, шаг В1): какие дела приносили очки жизни, как часто кончались провалом, где лучше и где хуже.
// Строки — из <dataDir>/deeds_all.jsonl (стенд дописывает после каждого мира): { key, coarse, r, verdict, world, nick, group }.
// Запуск: node hardcore/skills_report.js --worlds 5 [--data <папка данных>] → skills_report.md в папке данных.
'use strict';
const fs = require('fs'), path = require('path');
const MIN_SIT = 5;     // обстановка идёт в «лучшую» и «худшую», если в ней не меньше 5 запусков дела
const MIN_WORST = 20;  // в «худших» — дела не меньше чем с 20 запусков
const WORST_TOP = 5;

const avg = (sum, n) => (n ? sum / n : null);
const fmt1 = x => (x == null ? '—' : x.toFixed(1));
const esc = s => String(s).replace(/\|/g, '\\|');   // «|» внутри ячейки таблицы Markdown ломает строку

// строки дел → по каждому делу: запусков, среднее очков, доля провалов, лучшая и худшая обстановка (coarse, не меньше MIN_SIT)
function summarize(rows) {
  const by = {};
  let total = 0;
  for (const r of rows || []) {
    if (!r || !r.key || typeof r.r !== 'number') continue;   // строка без итога жизни — не считаем
    total++;
    const a = by[r.key] = by[r.key] || { key: r.key, n: 0, sum: 0, ok: 0, fail: 0, sit: {} };
    a.n++; a.sum += r.r;
    if (r.verdict === 'ok') a.ok++; else if (r.verdict === 'провал') a.fail++;
    const co = r.coarse || '—';
    const s = a.sit[co] = a.sit[co] || { n: 0, sum: 0 };
    s.n++; s.sum += r.r;
  }
  const list = Object.values(by).map(a => {
    const sits = Object.entries(a.sit).filter(([, s]) => s.n >= MIN_SIT).map(([k, s]) => ({ coarse: k, n: s.n, avg: avg(s.sum, s.n) }));
    sits.sort((x, y) => y.avg - x.avg);
    return { key: a.key, n: a.n, avg: avg(a.sum, a.n), failPct: a.ok + a.fail ? a.fail / (a.ok + a.fail) * 100 : null,
      best: sits[0] || null, worst: sits[sits.length - 1] || null };
  });
  const byRuns = (x, y) => y.n - x.n || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  return {
    deeds: list.filter(x => !x.key.startsWith('pool:')).sort(byRuns),
    pool: list.filter(x => x.key.startsWith('pool:')).sort(byRuns),
    worst: list.filter(x => x.n >= MIN_WORST).sort((x, y) => x.avg - y.avg).slice(0, WORST_TOP),
    total
  };
}

const cell = sit => (sit ? `${esc(sit.coarse)} (${fmt1(sit.avg)})` : '—');
function table(rows) {
  const head = '| дело | запусков | очки в среднем | провалов, % | лучшая обстановка | худшая обстановка |\n|---|---|---|---|---|---|';
  const body = rows.map(x => `| ${esc(x.key)} | ${x.n} | ${fmt1(x.avg)} | ${x.failPct == null ? '—' : x.failPct.toFixed(1)} | ${cell(x.best)} | ${cell(x.worst)} |`);
  return [head, ...body].join('\n');
}
function render(sum, info = {}) {
  const out = [`# Сводка по делам${info.worlds ? ` (последние миры: ${info.worlds})` : ''}`, '',
    `Строк дел: ${sum.total}. Очки — итог жизни мухи за весь матч; по делу — среднее по его запускам. Провалы — доля из дел с итогом (ok или провал). Обстановка — coarse, не меньше ${MIN_SIT} запусков.`, ''];
  out.push('## Дела', '', sum.deeds.length ? table(sum.deeds) : 'нет данных', '');
  out.push('## Навыки пула', '', sum.pool.length ? table(sum.pool) : 'нет данных', '');
  out.push(`## Худшие ${WORST_TOP} дел (не меньше ${MIN_WORST} запусков)`, '');
  if (sum.worst.length) out.push('| дело | запусков | очки в среднем |', '|---|---|---|', ...sum.worst.map(x => `| ${esc(x.key)} | ${x.n} | ${fmt1(x.avg)} |`));
  else out.push('Таких дел пока нет.');
  return out.join('\n') + '\n';
}

// строки журнала; worldSet — только эти миры (null — все)
function readRows(file, worldSet) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const rows = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let r = null; try { r = JSON.parse(l); } catch (e) {}
    if (r && (!worldSet || worldSet.has(r.world))) rows.push(r);
  }
  return rows;
}

function main(argv) {
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt; };
  const N = Number(arg('--worlds', 5)) || 5;
  const dataDir = path.resolve(arg('--data', path.join(__dirname, 'data')));
  let worlds = null;   // миры в порядке записи (worlds.jsonl); берём последние N
  try { worlds = fs.readFileSync(path.join(dataDir, 'worlds.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id).filter(Boolean); } catch (e) {}
  const pick = worlds ? worlds.slice(-N) : null;
  const rows = readRows(path.join(dataDir, 'deeds_all.jsonl'), pick ? new Set(pick) : null);
  const sum = summarize(rows);
  const out = path.join(dataDir, 'skills_report.md');
  fs.mkdirSync(dataDir, { recursive: true });   // hardcore/data — в .gitignore, на новом стенде её может не быть
  fs.writeFileSync(out, render(sum, { worlds: pick ? pick.length : null }));
  console.log(`сводка: ${sum.total} строк дел из ${pick ? pick.length + ' миров' : 'всех миров'} → ${out}`);
  return out;
}

module.exports = { summarize, render, readRows, main, MIN_SIT, MIN_WORST, WORST_TOP };
if (require.main === module) main(process.argv.slice(2));
