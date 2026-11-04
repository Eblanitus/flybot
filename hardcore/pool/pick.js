// Выбор навыка мухой «с температурой» (этап 2, хозяин 04.11: широкий пул навыков на каждое дело, муха сама пробует, счёт отсеет плохие).
// Память общая для всех мух и всех миров: hardcore/data/pool_runs.jsonl, строка на запуск {t, fly, delo, skill, ok, sec, err, gained}.
// Счёт навыка в деле = (ok+1)/(runs+2) — как у версий выученных навыков (brain/versions.js).
// 70% — лучший из опытных (запусков ≥ PROBE_RUNS) и родного навыка; 30% — новичок (меньше всех запусков, первыми — ни разу не пробованные).
'use strict';
const fs = require('fs');
const path = require('path');

const PROBE_RUNS = 5;       // меньше запусков — навык ещё новичок, его счёт не мерило
const EXPLOIT = 0.7;        // доля «лучший»; остальное — проба новичка
const statsFile = () => process.env.HC_POOL_RUNS || path.join(__dirname, '..', 'data', 'pool_runs.jsonl');
const keyOf = (delo, skill) => `${delo}/${skill}`;

let cache = { file: null, size: -1, mtime: 0, stats: new Map() };
// Счёт всех навыков: Map 'дело/навык' → {runs, ok, sec}. Битые строки пропускаем.
function readStats(file = statsFile()) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return new Map(); }
  if (cache.file === file && cache.size === st.size && cache.mtime === st.mtimeMs) return cache.stats;
  const stats = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return stats; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r || !r.delo || !r.skill) continue;
    const k = keyOf(r.delo, r.skill);
    const s = stats.get(k) || { runs: 0, ok: 0, sec: 0 };
    s.runs++; if (r.ok) s.ok++; s.sec += Number(r.sec) || 0;
    stats.set(k, s);
  }
  cache = { file, size: st.size, mtime: st.mtimeMs, stats };
  return stats;
}

function record(rec, file = statsFile()) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line); return true; } catch (e) { return false; }
}

const score = s => ((s ? s.ok : 0) + 1) / ((s ? s.runs : 0) + 2);

// cands: [{id, native?}] одного дела. Итог: {id, why, score, runs}.
// Родной навык сразу считается опытным: с ним муха и так жила, пробы чужих не должны отнимать у неё 100% времени.
function choose(delo, cands, stats = readStats(), rnd = Math.random) {
  if (!cands.length) return null;
  const rows = cands.map(c => { const s = stats.get(keyOf(delo, c.id)); return { id: c.id, native: !!c.native, runs: s ? s.runs : 0, sc: score(s) }; });
  const vets = rows.filter(r => r.native || r.runs >= PROBE_RUNS);
  const news = rows.filter(r => !r.native && r.runs < PROBE_RUNS);
  const best = list => list.slice().sort((a, b) => b.sc - a.sc || b.runs - a.runs)[0];
  let pick, why;
  if (vets.length && (!news.length || rnd() < EXPLOIT)) { pick = best(vets); why = 'лучший'; }
  else if (news.length) {
    const fewest = Math.min(...news.map(r => r.runs));
    const pool = news.filter(r => r.runs === fewest);
    pick = pool[Math.floor(rnd() * pool.length) % pool.length]; why = fewest === 0 ? 'новичок (ни разу)' : 'новичок';
  } else { pick = rows[Math.floor(rnd() * rows.length) % rows.length]; why = 'случай'; }
  return { id: pick.id, why, score: Math.round(pick.sc * 100) / 100, runs: pick.runs };
}

module.exports = { readStats, record, choose, score, keyOf, statsFile, PROBE_RUNS, EXPLOIT };
