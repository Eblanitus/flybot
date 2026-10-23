// Скрипты PowerShell в корне (сторож brain_guard.ps1, restart_body.ps1 …) разбираются без ошибок.
// 23.10 правка инженера сломала сторожа («$lastId:» и строка на Python), а тесты этого не видели — сторож не запускался.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(ROOT).filter(n => /\.ps1$/i.test(n));
if (process.platform !== 'win32' || !files.length) { console.log('ps_parse: пропуск (не Windows или нет .ps1)'); process.exit(0); }
const script = files.map(n => {
  const p = path.join(ROOT, n).replace(/'/g, "''");
  return `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${p}',[ref]$null,[ref]$e); foreach($x in $e){ '${n}:' + $x.Extent.StartLineNumber + ': ' + $x.Message }`;
}).join('; ');
const out = execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script], { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
assert.strictEqual(out, '', 'ошибки разбора PowerShell:\n' + out);
console.log(`ps_parse: ok (${files.join(', ')})`);
