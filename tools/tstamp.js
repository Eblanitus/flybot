// Фильтр для журнала мозга: каждая непустая строка stdin → «[ЧЧ:ММ:СС] строка» (местное время) в stdout.
// night.cmd: opencode run … 2>&1 | node tools\tstamp.js >> data\night.log. Аудит снимает метку и показывает время.
const pad = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] `; };
let rest = '';
const out = s => { try { process.stdout.write(s); } catch (e) {} };
const line = l => out(l.replace(/\r$/, '') === '' ? l + '\n' : stamp() + l + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  const parts = (rest + chunk).split('\n');
  rest = parts.pop();
  for (const l of parts) line(l);
});
process.stdin.on('end', () => { if (rest) line(rest); });
