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
const { VER } = require('./points');   // версия формулы очков: база и «готово» — только по мирам этой версии (pointsVer)
const CP = require('./points_checkpoint'); // контрольная точка: очки старых версий не источник выводов
const LIVES_FILE = path.join(DATA, 'lives.jsonl');

// строка, которую не разобрать как JSON, пропускается (остальные миры читаются)
function readWorlds(file = WORLDS_FILE) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (e) {} }
  return out;
}

// Стенд не всегда пишет pointsVer в мирах; тогда версию берём из карточек жизни.
// cards — все строки lives.jsonl (или null, если их нет): мир без явной версии годится,
// только если все его карточки не старше контрольной точки.
function versionOk(w, ver, cards) {
  if (ver == null) return true;
  if (w.pointsVer != null) return Number(w.pointsVer) >= ver;
  if (!cards || !cards.length) return false;
  const own = cards.filter(c => c && c.world === w.id);
  return own.length > 0 && own.every(c => CP.cardUsable(c));
}

// база: среднее pointsAvg по последним n мирам, где оно есть и версия не старее контрольной точки
function baselineOf(worlds, n = 3, ver = null, cards = null) {
  const ws = worlds.filter(w => w && typeof w.pointsAvg === 'number' && versionOk(w, ver, cards)).slice(-n);
  if (!ws.length) return null;
  const pointsAvg = Math.round(ws.reduce((a, w) => a + w.pointsAvg, 0) / ws.length * 100) / 100;
  return { pointsAvg, worlds: ws.map(w => w.id), ...(ver != null ? { ver } : {}) };
}

// готово: последние n миров с учащимися (pointsByGroup.learn) — каждый не ниже GOAL_MULT × базы, и миров должно быть n
// ver — только миры этой версии очков, и база должна быть той же версии (база по старым очкам — не годится)
function checkDone(worlds, base, n = 3, ver = null, cards = null) {
  const ws = worlds.filter(w => w && w.pointsByGroup && typeof w.pointsByGroup.learn === 'number' && versionOk(w, ver, cards)).slice(-n);
  const need = base && (ver == null || base.ver === ver) ? GOAL_MULT * base.pointsAvg : null;
  const rows = ws.map(w => ({ world: w.id, learn: w.pointsByGroup.learn, need, ok: need != null && w.pointsByGroup.learn >= need }));
  return { done: need != null && ws.length === n && rows.every(r => r.ok), rows, need };
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const n = Number(arg('worlds', 3)) || 3;
  const worlds = readWorlds();
  let cards = [];
  try { cards = fs.readFileSync(LIVES_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  if (argv.includes('--check')) {
    let base = null;
    try { base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (e) {}
    if (!base || typeof base.pointsAvg !== 'number') { console.log(`нет базы: ${BASELINE_FILE} (сначала --write)`); return 1; }
    if (base.ver !== VER) { console.log(`база посчитана по старым очкам (версия ${base.ver || 1}, сейчас ${VER}) — пересчитайте: --write`); return 1; }
    const r = checkDone(worlds, base, n, VER, cards);
    for (const x of r.rows) console.log(`${x.world}: учащиеся ${x.learn}, нужно ${x.need} — ${x.ok ? 'да' : 'нет'}`);
    if (r.rows.length < n) console.log(`миров с учащимися ${r.rows.length} из ${n}`);
    console.log(r.done ? 'готово' : 'ещё нет');
    return r.done ? 0 : 1;
  }
  const base = baselineOf(worlds, n, VER, cards);
  if (!base) { console.log(`нет миров с очками версии ${VER}+ (pointsAvg, pointsVer/карточки) в worlds.jsonl — ${CP.NOTE}`); return 1; }
  console.log(`база: ${base.pointsAvg} очка в среднем по ${base.worlds.length} мирам (${base.worlds.join(', ')})`);
  if (argv.includes('--write')) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ at: new Date().toISOString(), worlds: base.worlds, pointsAvg: base.pointsAvg, ver: VER }, null, 1));
    console.log(`записано: ${BASELINE_FILE}`);
  }
  return 0;
}

module.exports = { readWorlds, baselineOf, checkDone, versionOk, GOAL_MULT, VER };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
