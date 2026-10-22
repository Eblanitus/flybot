// Прогон всех тестов: каждый файл test/*.js — отдельным процессом (упавший не мешает остальным).
//   node tools/run_tests.js          — по строке на файл и итог; код выхода 1, если что-то упало
//   node tools/run_tests.js --json   — одна строка JSON { ok, results: [{ file, ok, code, sec, tail }] } (для lib/core_requests.js)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const json = process.argv.includes('--json');
const dir = path.join(ROOT, 'test');
let files = []; try { files = fs.readdirSync(dir).filter(n => /\.js$/.test(n)).sort(); } catch (e) {}
const results = [];
for (const n of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, n)], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  const ok = r.status === 0 && !r.error;
  const out = String(r.stdout || '') + String(r.stderr || '') + (r.error ? '\n' + r.error.message : '');
  results.push({ file: 'test/' + n, ok, code: r.status, sec: Math.round((Date.now() - t0) / 100) / 10, tail: ok ? '' : out.slice(-1500) });
  if (!json) console.log(`${ok ? 'ok  ' : 'FAIL'} test/${n} (${results[results.length - 1].sec} с)`);
}
const ok = results.every(x => x.ok);
if (json) process.stdout.write(JSON.stringify({ ok, results }) + '\n');
else console.log(ok ? `все ${results.length} файлов прошли` : `упали: ${results.filter(x => !x.ok).map(x => x.file).join(', ')}`);
process.exitCode = ok ? 0 : 1;
