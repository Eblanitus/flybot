// Лента мира (этап 1а, docs/goal_path.md): после каждого мира стенд рисует hardcore/data/timeline/<мир>.html и общий index.html.
// Время слева направо (полное время мира в тиках, 24000 = игровой день), строка на бота: старт → события → смерть с причиной.
// Внизу — полоса дня и ночи. Всё в одном файле, без библиотек: открывается двойным щелчком.
//   node hardcore/timeline.js            — перерисовать все ленты из hardcore/data/worlds/*
'use strict';
const fs = require('fs');
const path = require('path');
const { GROUP_TEXT, groupLabel } = require('./lib');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = {
  start: { c: 'var(--start)', label: 'старт' }, eat: { c: 'var(--eat)', label: 'поел' }, flee: { c: 'var(--warn)', label: 'бежит' },
  lowhp: { c: 'var(--bad)', label: 'HP низкий' }, night: { c: 'var(--muted)', label: 'ночь' }, night_survived: { c: 'var(--good)', label: 'пережил ночь' },
  day: { c: 'var(--muted)', label: 'новый день' }, death: { c: 'var(--bad)', label: 'смерть' }, end: { c: 'var(--muted)', label: 'конец' },
  stage: { c: 'var(--good)', label: 'ступень' }, shelter: { c: 'var(--nightband)', label: 'укрылся' }, leave: { c: 'var(--start)', label: 'вышел из укрытия' },
  stuck: { c: 'var(--warn)', label: 'застрял' }, fight: { c: 'var(--warn)', label: 'дерётся' },
  hunt: { c: 'var(--eat)', label: 'охота' }, kill: { c: 'var(--bad)', label: 'убил муху' }
};
const CSS = `
:root{--bg:#f4f6f1;--panel:#fff;--fg:#1d2419;--muted:#66705f;--line:#cdd5c4;--day:#e8efdc;--nightband:#9aa5b8;
--start:#3f7a2a;--eat:#7a6a12;--warn:#b5651d;--bad:#b3261e;--good:#2f7d32;--life:#3f7a2a}
@media (prefers-color-scheme: dark){:root{--bg:#131812;--panel:#1b2219;--fg:#e4ebdc;--muted:#a3ad98;--line:#35412f;--day:#2a3624;--nightband:#3b4458;
--start:#8fc76f;--eat:#d8c35a;--warn:#e89a55;--bad:#f08a80;--good:#8fd18f;--life:#8fc76f;color-scheme:dark}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,"Segoe UI",sans-serif;margin:0}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:1.5rem;margin:0 0 4px} .muted{color:var(--muted)} a{color:var(--start)}
.box{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:14px;overflow-x:auto}
svg text{font-family:system-ui,"Segoe UI",sans-serif;fill:var(--fg);font-size:12px} svg .s{font-size:10.5px;fill:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px} td,th{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600} .legend span{display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:13px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
`;

function dayLabel(wt) { const d = Math.floor(wt / 24000) + 1, tod = ((wt % 24000) + 24000) % 24000; return `день ${d}${tod >= 13000 && tod < 23000 ? ', ночь' : ''}`; }

// SVG ленты одного мира. cards — карточки ботов этого мира (с events и wtStart/wtEnd, где есть).
function svgFor(cards) {
  const withT = cards.filter(c => Array.isArray(c.events) && c.events.some(e => e.wt != null));
  const all = withT.flatMap(c => c.events.filter(e => e.wt != null).map(e => e.wt));
  let t0 = all.length ? Math.min(...all) : 0, t1 = all.length ? Math.max(...all) : 24000;
  t0 = Math.floor(t0 / 24000) * 24000;                          // от начала первого дня
  if (t1 - t0 < 24000) t1 = t0 + 24000;
  const L = 150, R = 1060, W = R - L, rowH = 56, top = 24, rows = Math.max(1, cards.length);
  const bandY = top + rows * rowH + 6, H = bandY + 40;
  const x = wt => L + ((wt - t0) / (t1 - t0)) * W;
  const out = [`<svg viewBox="0 0 1080 ${H}" width="1080" height="${H}" role="img" aria-label="лента мира">`];
  // полоса дня и ночи + деления по дням
  for (let d = t0; d < t1; d += 24000) {
    const segs = [[d, d + 13000, 'var(--day)'], [d + 13000, d + 23000, 'var(--nightband)'], [d + 23000, d + 24000, 'var(--day)']];
    for (const [a, b, c] of segs) {
      const xa = Math.max(L, x(a)), xb = Math.min(R, x(Math.min(b, t1)));
      if (xb > xa) out.push(`<rect x="${xa.toFixed(1)}" y="${bandY}" width="${(xb - xa).toFixed(1)}" height="14" fill="${c}"/>`);
    }
    out.push(`<line x1="${x(d).toFixed(1)}" y1="${top - 10}" x2="${x(d).toFixed(1)}" y2="${bandY + 14}" stroke="var(--line)" stroke-width="1"/>`);
    out.push(`<text x="${(x(d) + 4).toFixed(1)}" y="${bandY + 30}" class="s">день ${Math.floor(d / 24000) + 1}</text>`);
  }
  cards.forEach((c, i) => {
    const y = top + i * rowH + 16;
    out.push(`<text x="6" y="${y + 4}">${esc(c.nick)}${c.pointsTotal != null ? ` · ${esc(c.pointsTotal)} оч.` : ''}</text>`);
    const gl = groupLabel(c);   // этап 2: группа мухи — второй строкой мелко (старые миры — без группы, строки нет)
    if (gl) out.push(`<text x="6" y="${y + 18}" class="s">${esc(gl)}</text>`);
    const ev = (c.events || []).filter(e => e.wt != null);
    if (!ev.length) { out.push(`<text x="${L}" y="${y + 4}" class="s">нет событий: ${esc(c.result || '')} ${esc(c.note || c.reason || '')}</text>`); return; }
    const a = x(c.wtStart != null ? c.wtStart : ev[0].wt), b = x(c.wtEnd != null ? c.wtEnd : ev[ev.length - 1].wt);
    out.push(`<line x1="${a.toFixed(1)}" y1="${y}" x2="${Math.max(a + 2, b).toFixed(1)}" y2="${y}" stroke="var(--life)" stroke-width="4" stroke-linecap="round"/>`);
    let lastLabelX = -1e9, alt = 0;
    for (const e of ev) {
      if (e.kind === 'night' || e.kind === 'day') continue;     // это видно по полосе внизу
      const ex = x(e.wt), k = KIND[e.kind] || KIND.end;
      if (e.kind === 'death' || e.kind === 'end') {
        const lbl = `${e.kind === 'death' ? '✕ ' : '■ '}${esc(e.text)}, ${dayLabel(e.wt)}`;
        out.push(ex > R - 230   // у правого края подпись уходит влево, над полоской
          ? `<text x="${ex.toFixed(1)}" y="${y - 9}" text-anchor="end" style="fill:${k.c};font-weight:700">${lbl}</text>`
          : `<text x="${(ex + 6).toFixed(1)}" y="${y + 4}" style="fill:${k.c};font-weight:700">${lbl}</text>`);
        continue;
      }
      out.push(`<circle cx="${ex.toFixed(1)}" cy="${y}" r="${e.kind === 'start' ? 5 : 4}" fill="${k.c}"><title>${esc(e.text)} — ${dayLabel(e.wt)}</title></circle>`);
      if (ex - lastLabelX > 70) { alt = 0; lastLabelX = ex; } else alt++;
      if (alt < 2) out.push(`<text x="${ex.toFixed(1)}" y="${y + 18 + alt * 12}" text-anchor="middle" class="s">${esc(e.text)}</text>`);
    }
  });
  out.push('</svg>');
  return out.join('');
}

function legend() {
  return '<div class="legend">' + ['start', 'stage', 'eat', 'flee', 'shelter', 'leave', 'stuck', 'lowhp', 'night_survived', 'hunt', 'kill', 'death'].map(k =>
    `<span><i class="dot" style="background:${KIND[k].c}"></i>${KIND[k].label}</span>`).join('') +
    '<span><i class="dot" style="background:var(--nightband);border-radius:2px"></i>ночь</span></div>';
}

// этап 2: кто в какой группе и средние очки по группам — в шапку мира; у старых миров (без групп) — пусто
function groupsLine(cards, w) {
  const by = {};
  for (const c of cards) if (c.group) (by[c.group] = by[c.group] || []).push(c.nick);
  const span = a => (a.length > 2 ? `${a[0]}–${a[a.length - 1]}` : a.join(', '));
  const names = { learn: 'учатся', control: 'контроль' };
  const parts = Object.entries(by).map(([g, ns]) => `${names[g] || g} ${esc(span(ns))}`);
  const pg = w && w.pointsByGroup ? Object.entries(w.pointsByGroup).filter(([g]) => g !== 'all').map(([g, v]) => `${GROUP_TEXT[g] || g} ${esc(v)}`) : [];
  if (pg.length) parts.push(`очки в среднем: ${pg.join(', ')}`);
  return parts.join(' · ');
}
function worldHtml(w, cards) {
  const gl = groupsLine(cards, w);
  const rows = cards.map(c => `<tr><td>${esc(c.nick)}</td><td>${esc(groupLabel(c))}</td><td>${c.pointsTotal != null ? esc(c.pointsTotal) : '—'}</td><td>${esc(c.result)}</td><td>${c.lifeSec != null ? Math.round(c.lifeSec / 60) + ' мин' : '—'}</td>` +
    `<td>${c.gameDays != null ? c.gameDays : '—'}</td><td>${c.firstNightSurvived ? 'да' : 'нет'}</td><td>${esc(c.deathMessageServer || c.deathMessage || c.cause || c.reason || c.note || '')}</td></tr>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Мир ${esc(w.id)}</title><style>${CSS}</style></head><body><div class="wrap">
<p class="muted"><a href="index.html">← все миры</a></p>
<h1>Мир ${esc(w.id)}</h1>
<p class="muted">сид ${esc(w.seed)} · ботов ${cards.length} · умерло ${cards.filter(c => c.result === 'death').length} · пережили первую ночь ${cards.filter(c => c.firstNightSurvived).length}${w.pointsAvg != null ? ` · очки в среднем ${esc(w.pointsAvg)}` : ''} · мир шёл ${w.durSec != null ? Math.round(w.durSec / 60) + ' мин' : '—'} · читов ${w.cheats != null ? w.cheats : '—'}${w.br ? ` · убийств муха→муха ${w.kills != null ? w.kills : cards.reduce((n, c) => n + (c.killCount || 0), 0)}${cards.some(c => c.killCount) ? ' (' + cards.filter(c => c.killCount).map(c => `${esc(c.nick)} ${c.killCount}`).join(', ') + ')' : ''}` : ''}${w.consoleCommands && w.consoleCommands.length ? ` · команды хозяина: ${esc(w.consoleCommands.join('; '))}` : ''}</p>
${gl ? `<p class="muted">${gl}</p>` : ''}
<div class="box">${legend()}${svgFor(cards)}</div>
<div class="box"><table><tr><th>Бот</th><th>Группа</th><th>Очки</th><th>Итог</th><th>Прожил</th><th>Игровых дней</th><th>Первая ночь</th><th>Причина</th></tr>${rows}</table></div>
</div></body></html>`;
}

function indexHtml(worlds) {
  const rows = worlds.slice().reverse().map(w => `<tr><td><a href="${esc(w.id)}.html">${esc(w.id)}</a></td><td>${w.serverOk === false ? 'сервер не поднялся' : esc(w.bots)}</td>` +
    `<td>${w.deaths != null ? w.deaths : '—'}</td><td>${w.firstNight != null ? w.firstNight : '—'}</td><td>${w.medianLifeSec != null ? Math.round(w.medianLifeSec / 60) + ' мин' : '—'}</td>` +
    `<td>${w.durSec != null ? Math.round(w.durSec / 60) + ' мин' : '—'}</td><td>${w.cheats != null ? w.cheats : '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ленты миров</title><style>${CSS}</style></head><body><div class="wrap">
<h1>Ленты миров</h1><p class="muted">Новые сверху. Миров: ${worlds.length}. Лента рисуется стендом сама после каждого мира.</p>
<div class="box"><table><tr><th>Мир</th><th>Ботов</th><th>Умерло</th><th>Пережили 1-ю ночь</th><th>Медиана жизни</th><th>Мир шёл</th><th>Читов</th></tr>${rows}</table></div>
</div></body></html>`;
}

// Записать ленту мира и пересобрать оглавление. worlds — все строки worlds.jsonl (с этим миром).
function write(dataDir, w, cards, worlds) {
  const dir = path.join(dataDir, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  if (w && cards) fs.writeFileSync(path.join(dir, `${w.id}.html`), worldHtml(w, cards));
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml(worlds || []));
  return path.join(dir, 'index.html');
}

function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } }

// Перерисовать всё из data/worlds.jsonl и data/lives.jsonl (если ленты потерялись или поменялся вид).
function rebuild(dataDir) {
  const worlds = readJsonl(path.join(dataDir, 'worlds.jsonl'));
  const lives = readJsonl(path.join(dataDir, 'lives.jsonl'));
  for (const w of worlds) if (w.serverOk !== false) write(dataDir, w, lives.filter(c => c.world === w.id), worlds);
  return write(dataDir, null, null, worlds);
}

module.exports = { svgFor, worldHtml, indexHtml, write, rebuild, dayLabel };
if (require.main === module) console.log('готово:', rebuild(process.argv[2] || path.join(__dirname, 'data')));
