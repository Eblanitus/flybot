// База очков жизни (этап 2, шаг А5): средние очки мухи по последним мирам и проверка «готово» (шаг Б12).
//   node hardcore/baseline.js [--worlds 3]          — средние по последним N мирам с очками (pointsAvg)
//   node hardcore/baseline.js --worlds 3 --write    — записать hardcore/data/baseline.json (база для --check)
//   node hardcore/baseline.js --check               — последние 3 мира с учащимися: каждый не ниже 2 × базы; код 0 — готово, 1 — нет
// Миры читаются из hardcore/data/worlds.jsonl (одна строка на мир, пишет стенд).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const WORLDS_FILE = path.join(DATA, 'worlds.jsonl');
const BASELINE_FILE = path.join(DATA, 'baseline.json');
const GOAL_MULT = 2;   // признак «готово» этапа 2: учащиеся не меньше 2× базы

// строка, которую не разобрать как JSON, пропускается (остальные миры читаются)
function readWorlds(file = WORLDS_FILE) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (e) {} }
  return out;
}

// база: среднее pointsAvg по последним n мирам, где оно есть (старые миры без очков пропускаются); нет таких — null
function baselineOf(worlds, n = 3) {
  const ws = worlds.filter(w => w && typeof w.pointsAvg === 'number').slice(-n);
  if (!ws.length) return null;
  const pointsAvg = Math.round(ws.reduce((a, w) => a + w.pointsAvg, 0) / ws.length * 100) / 100;
  return { pointsAvg, worlds: ws.map(w => w.id) };
}

// готово: последние n миров с учащимися (pointsByGroup.learn) — каждый не ниже GOAL_MULT × базы, и миров должно быть n
function checkDone(worlds, base, n = 3) {
  const ws = worlds.filter(w => w && w.pointsByGroup && typeof w.pointsByGroup.learn === 'number').slice(-n);
  const need = base ? GOAL_MULT * base.pointsAvg : null;
  const rows = ws.map(w => ({ world: w.id, learn: w.pointsByGroup.learn, need, ok: need != null && w.pointsByGroup.learn >= need }));
  return { done: need != null && ws.length === n && rows.every(r => r.ok), rows, need };
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const n = Number(arg('worlds', 3)) || 3;
  const worlds = readWorlds();
  if (argv.includes('--check')) {
    let base = null;
    try { base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) {}
    if (!base || typeof base.pointsAvg !== 'number') { console.log(`нет базы: ${BASELINE_FILE} (сначала --write)`); return 1; }
    const r = checkDone(worlds, base, n);
    for (const x of r.rows) console.log(`${x.world}: учащиеся ${x.learn}, нужно ${x.need} — ${x.ok ? 'да' : 'нет'}`);
    if (r.rows.length < n) console.log(`миров с учащимися ${r.rows.length} из ${n}`);
    console.log(r.done ? 'готово' : 'ещё нет');
    return r.done ? 0 : 1;
  }
  const base = baselineOf(worlds, n);
  if (!base) { console.log('нет миров с очками (pointsAvg) в worlds.jsonl'); return 1; }
  console.log(`база: ${base.pointsAvg} очка в среднем по ${base.worlds.length} мирам (${base.worlds.join(', ')})`);
  if (argv.includes('--write')) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ at: new Date().toISOString(), worlds: base.worlds, pointsAvg: base.pointsAvg }, null, 1));
    console.log(`записано: ${BASELINE_FILE}`);
  }
  return 0;
}

module.exports = { readWorlds, baselineOf, checkDone, GOAL_MULT };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
