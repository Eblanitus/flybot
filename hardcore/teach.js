// Учитель этапа 2 (В2–В3): правка навыка лежит в hardcore/teach/<id>/learned/ и идёт только учащимся группы А (HC_1–HC_5).
// Здесь — сборка папки навыков для группы А: копия brain/learned и правка поверх. Вердикт после проверки — В3 (verdictOf).
'use strict';
const fs = require('fs'), path = require('path');

// копия базовых навыков + файлы правки поверх (одноимённые заменяют базовые); возвращает имена файлов правки
function buildLearned(baseDir, overlayDir, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(baseDir)) if (f.endsWith('.js')) fs.copyFileSync(path.join(baseDir, f), path.join(outDir, f));
  let over = [];
  try { over = fs.readdirSync(overlayDir).filter(f => f.endsWith('.js')); } catch (e) {}
  for (const f of over) fs.copyFileSync(path.join(overlayDir, f), path.join(outDir, f));
  return over;
}

// вердикт проверки правки (В3): после n миров с обеими группами — средняя очков группы А не ниже средней Б → «оставить», иначе «откат»; раньше n миров — null
function verdictOf(result, n) {
  const ws = ((result && result.worlds) || []).filter(w => typeof w.A === 'number' && typeof w.B === 'number').slice(0, n);
  if (ws.length < n) return null;
  const mean = k => ws.reduce((s, w) => s + w[k], 0) / ws.length;
  return mean('A') >= mean('B') ? 'оставить' : 'откат';
}

module.exports = { buildLearned, verdictOf };
