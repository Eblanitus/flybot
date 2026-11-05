// Офлайн-проверка сводки по делам (этап 2, шаг В1): средние, проценты провалов, лучшая и худшая обстановка, худшие 5, выбор миров.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../hardcore/skills_report');

const row = (key, coarse, r, verdict, extra = {}) => ({ key, coarse, r, verdict, world: 'w1', nick: 'HC_1', group: 'learn', ...extra });
const C1 = 'day|none|none', C2 = 'night|none|mob';

// 1) 3 дела (включая пул), 2 обстановки
const rows = [
  // day_routine: 5 запусков в C1 (очки 10, ok) и 2 в C2 (очки 2, провал) — C2 с 2 запусками в лучшую/худшую не идёт
  ...Array.from({ length: 5 }, () => row('day_routine', C1, 10, 'ok')),
  row('day_routine', C2, 2, 'провал'), row('day_routine', C2, 2, 'провал'),
  // explore: 6 запусков в C1 (очки 4): 4 ok, 2 провал
  ...Array.from({ length: 4 }, () => row('explore', C1, 4, 'ok')),
  ...Array.from({ length: 2 }, () => row('explore', C1, 4, 'провал')),
  // пул: одна строка с итогом без вердикта; строка без итога жизни — не считается вовсе
  row('pool:v1.mineWoodLog', C2, 0, null),
  row('без_итога', C1, undefined, 'ok')
];
{
  const S = R.summarize(rows);
  assert.deepStrictEqual(S.deeds.map(x => x.key), ['day_routine', 'explore'], 'дела по числу запусков, без пула');
  assert.deepStrictEqual(S.pool.map(x => x.key), ['pool:v1.mineWoodLog']);
  assert.strictEqual(S.total, 14, 'строка без итога не считается: 5 + 2 + 4 + 2 + 1');
  const dr = S.deeds[0];
  assert.strictEqual(dr.n, 7);
  assert(Math.abs(dr.avg - 54 / 7) < 1e-9, 'среднее очков: (5×10 + 2×2) / 7');
  assert(Math.abs(dr.failPct - 2 / 7 * 100) < 1e-9, 'провалов: 2 из 7 дел с итогом');
  assert.strictEqual(dr.best.coarse, C1, 'лучшая — C1 (C2 с 2 запусками не участвует)');
  assert.strictEqual(dr.worst.coarse, C1, 'худшая — тоже C1: другой обстановки с 5 запусками нет');
  const ex = S.deeds[1];
  assert.strictEqual(ex.n, 6); assert.strictEqual(ex.avg, 4);
  assert(Math.abs(ex.failPct - 2 / 6 * 100) < 1e-9);
  const pool = S.pool[0];
  assert.strictEqual(pool.failPct, null, 'без вердикта — без процента провалов');
  assert.strictEqual(pool.best, null, 'в обстановке меньше 5 запусков лучшей нет');
  console.log('сводка по делам: средние, провалы, лучшая и худшая обстановка, пул отдельно: OK');

  const md = R.render(S, { worlds: 2 });
  assert(md.includes('| day_routine | 7 | 7.7 | 28.6 | day\\|none\\|none (10.0) | day\\|none\\|none (10.0) |'), md);
  assert(md.includes('| explore | 6 | 4.0 | 33.3 |'), md);
  assert(md.includes('## Навыки пула') && md.includes('| pool:v1.mineWoodLog | 1 | 0.0 | — | — | — |'), md);
  console.log('таблица в Markdown: вертикальная черта в обстановке экранирована: OK');
}

// 2) худшие 5: только дела не меньше чем с 20 запусками, от худших к лучшим
{
  const many = [];
  for (let k = 1; k <= 7; k++) for (let i = 0; i < 20; i++) many.push(row('d' + k, C1, k, 'ok'));
  for (let i = 0; i < 19; i++) many.push(row('few', C1, 0, 'ok'));   // 19 запусков — не в списке, даже с худшими очками
  const S = R.summarize(many);
  assert.deepStrictEqual(S.worst.map(x => x.key), ['d1', 'd2', 'd3', 'd4', 'd5'], JSON.stringify(S.worst.map(x => x.key)));
  assert.strictEqual(S.worst[0].avg, 1);
  console.log('худшие 5 дел: от худших, не меньше 20 запусков: OK');
}

// 3) выбор миров: последние N из worlds.jsonl; строки других миров в сводку не попадают
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcskills-'));
  try {
    fs.writeFileSync(path.join(dir, 'worlds.jsonl'), ['w1', 'w2', 'w3'].map(id => JSON.stringify({ id })).join('\n') + '\n');
    const lines = [
      row('old_only', C1, 3, 'ok', { world: 'w1' }),
      row('day_routine', C1, 5, 'ok', { world: 'w2' }),
      row('day_routine', C1, 7, 'провал', { world: 'w3' })
    ];
    fs.writeFileSync(path.join(dir, 'deeds_all.jsonl'), lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    const out = R.main(['--worlds', '2', '--data', dir]);
    const md = fs.readFileSync(out, 'utf8');
    assert(!md.includes('old_only'), 'старый мир не в сводке');
    assert(md.includes('| day_routine | 2 | 6.0 | 50.0 |'), md);
    assert(md.includes('последние миры: 2'), md);
    console.log('выбор миров: последние N из worlds.jsonl: OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('hardcore_skills_report: OK');
