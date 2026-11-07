// Лента мира: автономный HTML из worlds.jsonl / lives.jsonl, без библиотек и сервера.
//   node hardcore/timeline.js [dataDir] — перерисовать ленты и общий index.html.
'use strict';
const fs = require('fs');
const path = require('path');
const { GROUP_TEXT, groupLabel } = require('./lib');
const CP = require('./points_checkpoint'); // контрольная точка очков: старые минусы не участвуют в выводах

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = {
  start: { c: 'var(--start)', label: 'старт' }, eat: { c: 'var(--eat)', label: 'поел' }, flee: { c: 'var(--warn)', label: 'бежит' },
  lowhp: { c: 'var(--bad)', label: 'HP низкий' }, night: { c: 'var(--muted)', label: 'ночь' }, night_survived: { c: 'var(--good)', label: 'пережил ночь' },
  day: { c: 'var(--muted)', label: 'новый день' }, death: { c: 'var(--bad)', label: 'смерть' }, end: { c: 'var(--muted)', label: 'конец' },
  stage: { c: 'var(--good)', label: 'ступень' }, shelter: { c: 'var(--nightband)', label: 'укрылся' }, leave: { c: 'var(--start)', label: 'вышел из укрытия' },
  stuck: { c: 'var(--warn)', label: 'застрял' }, fight: { c: 'var(--warn)', label: 'дерётся' },
  hunt: { c: 'var(--eat)', label: 'охота' }, kill: { c: 'var(--bad)', label: 'убил муху' }
};
// Авторские векторные пиктограммы: один язык линий, без шрифтов, CDN и сторонних наборов.
const ICONS = {
  fly: '<path d="M10 9 7 5M14 9l3-4M9 11 4 8 2 11l5 4M15 11l5-3 2 3-5 4M8 17l-3 3M16 17l3 3"/><rect x="8" y="9" width="8" height="11" rx="3"/><path d="M9 14h6M11 11h2"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10L3 7m9 5 9-5m-9 5v10M7 5l9 5"/>',
  clock: '<path d="M8 2h8M12 2v3m7 2 2-2"/><circle cx="12" cy="14" r="8"/><path d="M12 9v5l3 2"/>',
  signal: '<path d="M3 8a13 13 0 0 1 18 0M6 11a9 9 0 0 1 5-2m5 2 2 1M10 15l2-2 2 2M3 3l18 18"/><circle cx="12" cy="19" r="1"/>',
  wand: '<path d="m4 20 12-12 4 4L8 24M3 7h6M6 4v6M18 2v4M16 4h4M19 18h3M21 16v4" transform="translate(0 -2)"/>',
  moon: '<path d="M16 3a8 8 0 1 0 5 12A8 8 0 0 1 16 3Z"/><path d="M6 4v4M4 6h4M19 18v4M17 20h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  shield: '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Zm-4 10 3 3 5-6"/>',
  skull: '<path d="M6 16c-4-4-3-12 6-12s10 8 6 12l-2 1v4H8v-4ZM10 18v3M14 18v3"/><rect x="7" y="10" width="3" height="3" rx="1"/><rect x="14" y="10" width="3" height="3" rx="1"/>',
  archive: '<path d="m3 5 3-3h12l3 3v4H3Zm2 4v12h14V9M9 13h6M10 17h4"/>',
  search: '<path d="m15 15 6 6"/><circle cx="10" cy="10" r="7"/><path d="M7 10a3 3 0 0 1 3-3"/>',
  arrow: '<path d="M5 19 19 5M7 5h12v12"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  trace: '<path d="M3 18h4l3-12 4 15 3-9h4"/><circle cx="3" cy="18" r="1"/><circle cx="21" cy="12" r="1"/>',
  trophy: '<path d="M7 3h10v7a5 5 0 0 1-10 0ZM7 5H3v3c0 3 2 4 5 4M17 5h4v3c0 3-2 4-5 4M12 15v5M8 21h8"/>',
  leaf: '<path d="M4 20 18 6M7 17C-1 8 12 3 21 3c0 9-5 22-14 14ZM9 15v-4M13 11h4"/>',
  run: '<circle cx="15" cy="4" r="2"/><path d="m8 9 4-2 4 5 5 1M12 7l-2 7 5 3v5M10 14l-4 5H2M2 6h4M1 11h3"/>',
  shelter: '<path d="m2 11 10-8 10 8M5 9v12h14V9M10 21v-7h4v7M8 5V2h4"/>',
  sword: '<path d="m5 19 12-12 4-4v6L9 21M3 15l6 6M2 22l4-4M14 6l4 4"/>',
  food: '<path d="M8 20C-1 15 6 2 15 3c7 1 10 8 5 13-3 3-5 1-7 3-2 2-3 3-5 1ZM8 16c-3-3 1-8 5-9M13 7l3 3"/>',
  step: '<path d="M3 21v-6h6V9h6V3h6M3 3h5m-3-2 3 2-3 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>'
};
function icon(name, cls = '') {
  const key = Object.prototype.hasOwnProperty.call(ICONS, name) ? name : 'fly';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="icon ${esc(cls)}" data-icon="${key}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[key]}</svg>`;
}
function identityHash(s) {
  let n = 2166136261;
  for (const c of String(s)) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return n;
}
// У десяти мух — свои черты; незнакомый ник получает устойчивый процедурный портрет.
const PORTRAITS = {
  krot: { hue: 36, detail: '<path d="M14 21h20v7H14Z"/><path d="M38 29v12m-3-2 3 3 3-3"/>' },
  shmel: { hue: 47, detail: '<path d="M16 29h16M17 33h14M18 37h12"/><path d="m14 14-4-5m24 5 4-5"/>' },
  kaktus: { hue: 145, detail: '<path d="M23 15V6h4v9M23 11h-5V7m9 6h6V9"/><path d="M16 30h3m10 0h3M22 36h4"/>' },
  turbo: { hue: 193, detail: '<path d="m26 17-7 12h8l-4 10 10-15h-9Z"/><path d="M4 25h5M3 30h5"/>' },
  zubilo: { hue: 24, detail: '<path d="m16 17 8-8 8 8M20 13h8M20 32l4 4 4-4"/>' },
  glitch: { hue: 282, detail: '<path d="M13 21h9v4h-9m13-2h9v4h-9M16 34h6v3h10M38 13h4v4h-4M5 34h4"/>' },
  bagor: { hue: 164, detail: '<path d="M34 11v24a4 4 0 0 1-8 0v-3M16 33h5"/>' },
  pixel: { hue: 217, detail: '<path d="M14 19h6v6h-6Zm14 0h6v6h-6ZM21 31h6v6h-6Z"/>' },
  viper: { hue: 102, detail: '<path d="m14 21 7 4m13-4-7 4M19 33l5 3 5-3m-5 3v5m0-1-3 2m3-2 3 2"/>' },
  tormoz: { hue: 347, detail: '<path d="M18 19v9m12-9v9M18 34h12M15 12h18"/>' }
};
function avatar(nick, cls = '') {
  const key = String(nick || '').split('_').pop().toLowerCase(), hash = identityHash(nick || 'flybot');
  const known = Object.prototype.hasOwnProperty.call(PORTRAITS, key) ? PORTRAITS[key] : null;
  const hue = known ? known.hue : hash % 360;
  const detail = known ? known.detail : `<path d="M15 ${20 + hash % 3}h6m6 0h6M20 34h8"/><path d="m18 13-3-${3 + hash % 4}m15 0 3-${3 + (hash >>> 3) % 4}"/>`;
  return `<svg class="bot-avatar ${esc(cls)}" data-avatar="${esc(nick)}" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false" style="--avatar-hue:${hue}"><rect class="avatar-bg" x="1" y="1" width="46" height="46" rx="13"/><g class="avatar-ink" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 20C2 8 3 33 15 30m18-10c13-12 12 13 0 10"/><path d="M18 14h12l4 10-3 15H17l-3-15Z"/>${detail}</g></svg>`;
}
function habitatArt(seed) {
  const h = identityHash(seed || 'flybot'), sparkX = 270 + h % 45;
  return `<svg class="habitat-art" viewBox="0 0 440 280" width="440" height="280" aria-hidden="true" focusable="false"><g fill="none" stroke="var(--line)" stroke-width="1"><path d="m10 180 210-122 210 122-210 122Zm0-45 210-122 210 122M75 215l210-122M140 253 350 131M10 180l210 122M75 142l210 122" opacity=".6"/><circle cx="258" cy="119" r="94" stroke-dasharray="2 9"/></g><ellipse cx="221" cy="238" rx="140" ry="18" fill="var(--line)" opacity=".3"/><path d="m63 159 155-88 163 94-159 91Z" fill="var(--accent-soft)" stroke="var(--start)" stroke-opacity=".35"/><path d="m63 159 159 91v24L63 183Z" fill="var(--raised)" stroke="var(--line)"/><path d="m222 250 159-85v23l-159 86Z" fill="var(--panel)" stroke="var(--line)"/><path d="m99 165 120-69 126 72-123 69Z" fill="var(--day)" stroke="var(--start)" stroke-opacity=".2"/><path d="m146 163 51-30 62 36-51 30Z" fill="var(--panel)" stroke="var(--line)"/><path d="m146 163 62 36v21l-62-36Zm62 36 51-30v22l-51 29Z" fill="var(--raised)" stroke="var(--line)"/><path d="m157 158 44-26 43 25-44 26Z" fill="var(--start)" opacity=".22"/><path d="M126 102v64M115 157l11 6 11-6" fill="none" stroke="var(--start)" stroke-width="3"/><path d="m126 56-28 48h56Zm0 24-35 51h70Z" fill="var(--accent-soft)" stroke="var(--start)" stroke-width="1.3"/><path d="m126 95-38 48h76Z" fill="var(--accent-soft)" stroke="var(--start)" stroke-width="1.3"/><path d="M322 141v38M322 106l-22 37h44Z" fill="var(--accent-soft)" stroke="var(--start)" stroke-width="1.3"/><path d="m253 211 14-8 18 11-14 8Z" fill="var(--warn)" opacity=".3"/><path d="m259 211 13-9m-10-5 15 15" fill="none" stroke="var(--warn)" stroke-width="3"/><path d="M265 202c-11-10 2-14 3-24 10 7 3 10 8 13 4-4 2-8 1-9 15 11 9 25-2 25Z" fill="var(--warn)" opacity=".85"/><g class="art-drone"><path d="M222 57c-29-31-42-2-9 16m23-15c31-25 42 4 9 16" fill="var(--panel)" stroke="var(--start)" stroke-width="1.8"/><path d="m221 47-7-10m22 9 7-10M219 85l-9 9m29-9 9 9" fill="none" stroke="var(--start)" stroke-width="2"/><rect x="216" y="48" width="25" height="41" rx="11" fill="var(--raised)" stroke="var(--start)" stroke-width="1.8"/><path d="M221 60h15m-15 15h15" stroke="var(--start)" stroke-width="2"/><rect x="222" y="54" width="4" height="3" fill="var(--start)"/><rect x="231" y="54" width="4" height="3" fill="var(--start)"/></g><path d="M254 66c89-11 111 48 55 68" fill="none" stroke="var(--start)" stroke-dasharray="3 5" opacity=".65"/><path d="m${sparkX} 42 3-7 3 7 7 3-7 3-3 7-3-7-7-3Z" fill="var(--eat)" opacity=".8"/><path d="M374 50a20 20 0 1 0 15 23 20 20 0 0 1-15-23Z" fill="var(--nightband)" opacity=".65"/><circle cx="59" cy="69" r="2" fill="var(--start)"/><circle cx="350" cy="91" r="2" fill="var(--eat)"/></svg>`;
}
// Только ПК: минимальная ширина 1000px, адаптивов под телефон и планшет нет.
const CSS = `
:root{color-scheme:dark;--bg:#101416;--panel:#171d20;--raised:#1e262a;--fg:#edf2f2;--muted:#9eafb5;--line:#2c383d;--start:#72d7bb;--good:#72d7bb;--eat:#e6c477;--warn:#e6b279;--bad:#f29a9a;--day:#203a33;--nightband:#708bb8;--life:#72d7bb;--accent-soft:#203a33;--danger-soft:#352628}
:root[data-theme="light"]{color-scheme:light;--bg:#f3f5f5;--panel:#fff;--raised:#edf1f1;--fg:#192b32;--muted:#536970;--line:#d5dfe1;--start:#12745b;--good:#12745b;--eat:#806319;--warn:#956018;--bad:#ad3535;--day:#e3efdf;--nightband:#637ba4;--life:#12745b;--accent-soft:#e2f2ec;--danger-soft:#fbecec}
*{box-sizing:border-box}body{min-width:1000px;margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--start);text-decoration:none}a:hover{text-decoration:underline}button,input,select{font:inherit}button,select{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--start);outline-offset:4px}button{color:var(--fg)}[hidden]{display:none!important}.wrap{max-width:1320px;margin:auto;padding:0 32px 40px}.topbar{display:flex;justify-content:space-between;align-items:center;min-height:80px;border-bottom:1px solid var(--line);gap:16px}.brand{display:flex;align-items:center;gap:12px;color:var(--fg);font-size:19px;font-weight:700;letter-spacing:-.6px}.brand:hover{text-decoration:none}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--start);color:var(--bg);font:700 20px monospace}.brand small{color:var(--muted);font-size:10px;letter-spacing:2px;font-weight:600;border-left:1px solid var(--line);padding-left:12px}.top-actions{display:flex;align-items:center;gap:16px}.pill,.badge{display:inline-flex;align-items:center;gap:7px;border-radius:6px;padding:4px 9px;font-size:12px;white-space:nowrap;background:var(--raised);color:var(--muted)}.pill:before,.badge:before{content:"";width:5px;height:5px;background:currentColor;border-radius:50%;flex-shrink:0}.badge.good{color:var(--good);background:var(--accent-soft)}.badge.bad{color:var(--bad);background:var(--danger-soft)}.badge.warn{color:var(--warn)}.theme-button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:7px 12px;font-size:12px}.hero{padding:34px 0 25px}.eyebrow{color:var(--start);text-transform:uppercase;letter-spacing:2.5px;font-size:10px;font-weight:700;margin:0 0 10px}.hero-line{display:flex;justify-content:space-between;align-items:center;gap:24px}h1{font-size:38px;letter-spacing:-1.2px;line-height:1.2;margin:0;font-weight:650;overflow-wrap:anywhere}h2{margin:0;font-size:18px;font-weight:600;letter-spacing:-.3px}p{margin:0}.intro{color:var(--muted);margin-top:12px;max-width:780px}.muted{color:var(--muted)}.mono{font-family:Consolas,"SFMono-Regular",monospace;font-variant-numeric:tabular-nums}.button-link{display:inline-flex;align-items:center;gap:16px;padding:11px 16px;background:var(--accent-soft);border:1px solid var(--start);border-radius:9px;color:var(--start);font-weight:600;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:24px}.metric{padding:19px 22px;border:1px solid var(--line);background:var(--panel);border-radius:12px;min-width:0}.metric-label{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;font-size:30px;font-weight:600;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1.25;margin:8px 0 5px}.metric small{color:var(--muted);font-size:11px}.metric.warn strong{color:var(--warn)}.latest{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 24px;margin-bottom:30px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--start);border-radius:12px}.latest .eyebrow{margin-bottom:5px}.latest-id{font-size:17px;color:var(--fg);font-weight:600}.latest-meta{color:var(--muted);font-size:12px;margin-top:6px}.latest-right{display:flex;align-items:center;gap:24px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:26px 0 14px}.section-heading p{font-size:12px;color:var(--muted);margin-top:4px}.section-count{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}.toolbar{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:1px solid var(--line);flex-wrap:wrap}.search{flex:1;min-width:180px;position:relative}.search span{position:absolute;left:13px;top:9px;color:var(--muted);font-size:17px;pointer-events:none}.search input{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px 12px 10px 38px;min-height:42px}.select-label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.select-label select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:42px;max-width:210px}.table-scroll{overflow-x:auto}.archive-table{min-width:900px}.world-table{min-width:880px}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.5px;padding:13px 18px;background:var(--raised);white-space:nowrap}td{padding:16px 18px;border-top:1px solid var(--line);vertical-align:middle}tbody tr{transition:background .15s}tbody tr:hover{background:var(--raised)}tbody tr:first-child td{border-top:0}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.world-id{color:var(--fg);font-weight:600;font-size:12px;white-space:nowrap}.world-id:hover{color:var(--start)}.row-sub{display:block;color:var(--muted);font-size:11px;margin-top:4px}.night-stat{display:flex;align-items:center;gap:9px;justify-content:flex-end}.meter{width:44px;height:4px;background:var(--line);border-radius:4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--start)}.problem-number{color:var(--warn)}.empty-filter{text-align:center;padding:30px;color:var(--muted)}.table-footer{display:flex;justify-content:space-between;gap:16px;padding:13px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}.alert{border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:10px;padding:17px 20px;margin:0 0 20px;background:var(--panel)}.alert strong{display:block;color:var(--warn);margin-bottom:5px}.alert p{color:var(--muted);font-size:13px}.world-meta{display:flex;align-items:center;gap:12px 24px;flex-wrap:wrap;color:var(--muted);font-size:12px;padding:0 0 18px}.world-meta b{color:var(--fg);font-weight:500}.group-line{color:var(--muted);font-size:12px;margin-bottom:20px}.empty-timeline{text-align:center;padding:40px 24px}.empty-icon{display:grid;place-items:center;margin:0 auto 14px;border:1px dashed var(--line);border-radius:14px;width:54px;height:54px;color:var(--warn);font:24px monospace}.empty-timeline h2{font-size:17px}.empty-timeline p{color:var(--muted);max-width:580px;margin:10px auto 0;font-size:13px}.legend-details{border-bottom:1px solid var(--line);padding:12px 20px;color:var(--muted);font-size:12px}.legend-details summary{cursor:pointer;width:fit-content}.legend{display:flex;gap:10px 20px;flex-wrap:wrap;padding-top:12px}.legend span{display:inline-flex;align-items:center;gap:6px}.dot{width:8px;height:8px;border-radius:50%;display:inline-block}.timeline-scroll{overflow-x:auto;padding:16px}.timeline-scroll svg{display:block;width:100%;min-width:1080px;height:auto}svg text{font-family:"Segoe UI",system-ui,sans-serif;fill:var(--fg);font-size:12px}svg .s{font-size:10.5px;fill:var(--muted)}.reason{color:var(--muted);min-width:170px;max-width:300px;overflow-wrap:anywhere}.bot-name{font-weight:600}.footnote{display:flex;justify-content:space-between;gap:20px;margin-top:24px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}.breadcrumb{display:inline-block;color:var(--muted);font-size:12px;margin-bottom:16px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* Только ПК: фиксированная минимальная ширина, брейкпоинтов под узкие экраны нет. */
@media(prefers-reduced-motion:reduce){*{transition:none!important}}@media print{.top-actions,.toolbar,.button-link{display:none!important}.wrap{max-width:none;padding:0}.table-scroll{overflow:visible}.metrics{break-inside:avoid}body{min-width:0;background:white;color:black}}
`;

const IDENTITY_CSS = `
.icon{display:inline-block;width:20px;height:20px;flex-shrink:0;vertical-align:middle}.brand-mark{width:40px;height:40px;border-radius:12px;background:var(--accent-soft);color:var(--start);border:1px solid var(--start);box-shadow:0 0 24px color-mix(in srgb,var(--start) 10%,transparent)}.brand-mark .icon{width:29px;height:29px}.pill:before,.badge:before{display:none}.pill .icon,.badge .icon{width:14px;height:14px}.theme-button{display:inline-flex;align-items:center;gap:8px}.theme-button .icon{width:16px;height:16px}.theme-button .theme-moon{display:none}:root[data-theme="light"] .theme-button .theme-moon{display:block}:root[data-theme="light"] .theme-button .theme-sun{display:none}.button-link .icon{width:17px;height:17px}.search .search-mark{position:absolute;left:13px;top:12px;color:var(--muted)}.search .search-mark .icon{width:18px;height:18px}.search .sr-only{position:absolute;top:auto;left:auto}.metric{position:relative;overflow:hidden;transition:transform .18s,border-color .18s;min-height:142px}.metric:hover{transform:translateY(-3px);border-color:var(--start)}.metric-top{display:flex;align-items:center;gap:10px;padding-right:10px}.metric-icon{width:32px;height:32px;display:grid;place-items:center;border:1px solid var(--line);border-radius:9px;color:var(--start);background:var(--accent-soft)}.metric.warn .metric-icon{color:var(--warn);background:var(--raised)}.metric strong{position:relative;z-index:1}.metric:after{content:"";position:absolute;width:80px;height:80px;right:-24px;bottom:-35px;border:1px solid var(--line);transform:rotate(35deg);border-radius:16px}.feature-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 390px;gap:24px;align-items:center;padding:34px 32px;margin:26px 0 24px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(120deg,var(--panel),var(--bg));overflow:hidden}.feature-hero:before{content:"";position:absolute;inset:0;background-image:radial-gradient(var(--line) .7px,transparent .7px);background-size:18px 18px;opacity:.38;pointer-events:none}.feature-copy,.feature-scene{position:relative;z-index:1}.feature-hero h1{font-size:54px;letter-spacing:-2px}.feature-hero .intro{max-width:530px;margin:17px 0 22px;line-height:1.7}.feature-hero .eyebrow{display:flex;align-items:center;gap:9px}.feature-hero .eyebrow .icon{width:16px;height:16px}.feature-scene{min-width:0}.habitat-art{display:block;width:100%;height:auto}.scene-caption{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--muted);font:10px Consolas,monospace;letter-spacing:1.2px;padding:0 32px;margin-top:-5px}.scene-caption i{width:30px;height:1px;background:var(--start)}.scene-caption span{white-space:nowrap}.feature-tags{display:flex;align-items:center;gap:16px;margin-top:22px;color:var(--muted);font-size:11px}.feature-tags span{display:flex;align-items:center;gap:6px}.feature-tags .icon{width:15px;height:15px;color:var(--start)}.art-drone{animation:drone-hover 5s ease-in-out infinite;transform-box:fill-box;transform-origin:center}@keyframes drone-hover{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-7px) rotate(2deg)}}.section-heading h2{display:flex;align-items:center;gap:10px}.section-heading h2 .icon{color:var(--start);width:21px;height:21px}.latest{position:relative;background:linear-gradient(105deg,var(--panel),var(--accent-soft))}.latest-heading{display:flex;align-items:center;gap:14px;min-width:0}.latest-emblem{width:48px;height:48px;display:grid;place-items:center;border:1px solid var(--line);background:var(--panel);border-radius:12px;color:var(--start);flex-shrink:0}.latest-emblem .icon{width:28px;height:28px}.world-cell{display:flex;align-items:center;gap:10px}.world-cell .icon{width:21px;height:21px;color:var(--start)}.world-cell>div{min-width:0}.world-id .icon{width:11px;height:11px;margin-left:3px}.bot-avatar{display:block;width:38px;height:38px;flex-shrink:0}.avatar-bg{fill:var(--raised);stroke:var(--line)}.avatar-ink{stroke:hsl(var(--avatar-hue) 68% 70%)}:root[data-theme="light"] .avatar-ink{stroke:hsl(var(--avatar-hue) 60% 35%)}.bot-identity{display:flex;align-items:center;gap:10px}.bot-identity .bot-name{white-space:nowrap}.crew-panel{margin:0 0 24px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.crew-label{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted);padding:12px 18px 0}.crew-label .icon{width:16px;height:16px;color:var(--start)}.crew-strip{display:flex;gap:8px;overflow-x:auto;padding:12px 14px 14px}.crew-bot{flex:1;min-width:98px;border:1px solid transparent;background:transparent;padding:10px 6px 8px;border-radius:10px;color:var(--muted);text-align:center;transition:background .18s,border-color .18s}.crew-bot:hover,.crew-bot[aria-pressed="true"]{border-color:var(--line);background:var(--raised);color:var(--fg)}.crew-bot .bot-avatar{width:45px;height:45px;margin:0 auto 7px}.crew-bot span{display:block;font:10px Consolas,monospace}.crew-bot[aria-pressed="true"]{border-color:var(--start)}.empty-icon{width:66px;height:66px}.empty-icon .icon{width:34px;height:34px}.legend .icon{width:16px;height:16px}.breadcrumb{display:inline-flex;align-items:center;gap:6px}.breadcrumb .icon{width:14px;height:14px}.alert strong{display:flex;align-items:center;gap:8px}.alert strong .icon{width:18px;height:18px}.footnote>span:first-child{display:inline-flex;align-items:center;gap:7px}.footnote .icon{width:15px;height:15px}.timeline-scroll .bot-avatar{min-width:0;width:32px;height:32px}.timeline-scroll>svg{min-width:1180px}
/* ПК-макет: иллюстрация, метрики и таблицы не перестраиваются по ширине окна. */
@media(prefers-reduced-motion:reduce){.art-drone{animation:none}.metric:hover{transform:none}}
`;

// Аналитика ботов: отдельный слой стилей, всё по-прежнему в одном автономном HTML.
const ANALYTICS_CSS = `
.main-nav{display:flex;align-items:center;gap:4px;padding:3px;background:var(--raised);border:1px solid var(--line);border-radius:9px}.main-nav a{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:6px;color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}.main-nav a:hover{color:var(--fg);text-decoration:none;background:var(--panel)}.main-nav a.active{color:var(--start);background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}.main-nav .icon{width:15px;height:15px}
.page-hero{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding:30px 0 22px}.page-hero h1{font-size:42px}.page-hero .intro{max-width:620px;margin-top:10px}.hub-actions{display:flex;gap:10px;flex-wrap:wrap}.small-button{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font-size:12px;white-space:nowrap}.small-button:hover{border-color:var(--start);color:var(--start);text-decoration:none}.small-button .icon{width:15px;height:15px}.small-button[aria-pressed="true"]{border-color:var(--start);color:var(--start);background:var(--accent-soft)}
.hall{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:24px}.hall-card{position:relative;padding:14px 16px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);min-width:0}.hall-card:hover{border-color:var(--start)}.hall-icon{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:var(--accent-soft);color:var(--start);margin-bottom:10px}.hall-icon .icon{width:17px;height:17px}.hall-label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:1px}.hall-value{display:block;font-size:24px;font-weight:650;letter-spacing:-.6px;margin:5px 0 2px;font-variant-numeric:tabular-nums}.hall-who{display:block;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hall-who a{color:var(--start)}
.split-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}.mini-panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:18px 20px;min-width:0}.mini-panel h2{display:flex;align-items:center;gap:9px;font-size:15px;margin-bottom:4px}.mini-panel h2 .icon{width:19px;height:19px;color:var(--start)}.mini-panel p.panel-note{color:var(--muted);font-size:11px;margin-bottom:14px}.bar-row{display:grid;grid-template-columns:152px 1fr 74px;align-items:center;gap:10px;margin:9px 0;font-size:11px}.bar-label{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-track{height:9px;border-radius:6px;background:var(--raised);overflow:hidden}.bar-fill{display:block;height:100%;border-radius:6px;background:var(--start)}.bar-fill.alt{background:var(--warn)}.bar-fill.bad{background:var(--bad)}.bar-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--fg)}.bar-sub{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:10px;margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.histogram{display:block;width:100%;height:150px}.histogram .bin{cursor:pointer;transition:opacity .15s}.histogram .bin:hover,.histogram .bin.active{opacity:1!important}.histogram .bin{opacity:.78}.histogram text{fill:var(--muted);font-size:10px}.histogram .axis{stroke:var(--line)}
.heatmap-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel);margin-bottom:24px}.heatmap-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 18px;border-bottom:1px solid var(--line)}.heatmap-head h2{display:flex;align-items:center;gap:9px;font-size:15px}.heatmap-head .icon{width:19px;height:19px;color:var(--start)}.heatmap-scroll{overflow-x:auto;padding:12px 16px 16px}.heatmap{border-collapse:separate;border-spacing:2px;font-size:10px}.heatmap th{position:sticky;left:0;z-index:1;background:var(--panel);text-align:left;padding:2px 8px 2px 2px;color:var(--muted);font-size:10px;font-weight:600;white-space:nowrap}.heatmap th a{color:var(--muted)}.heatmap th a:hover{color:var(--start)}.hm-cell{display:block;width:15px;height:15px;border-radius:3px;background:var(--raised);border:1px solid transparent}.hm-cell:hover{outline:2px solid var(--start);outline-offset:1px}.hm-death{background:#8d4a4a}.hm-crash{background:#a8793f}.hm-disconnect{background:#8a6b3d}.hm-timeout{background:#4f6b64}.hm-other{background:#556b80}.hm-empty{background:var(--raised);opacity:.55}.hm-q0{background:#31433f}.hm-q1{background:#3d6a5c}.hm-q2{background:#4c957b}.hm-q3{background:#65bd96}.hm-q4{background:#8ce0b7}.hm-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:10px;padding:0 18px 14px}.hm-legend span{display:inline-flex;align-items:center;gap:5px}.hm-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.toolbar.leader-toolbar{gap:10px}.mini-field{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px;white-space:nowrap}.mini-field select,.mini-field input[type=number]{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:7px 8px;font-size:12px;min-height:34px}.mini-field input[type=number]{width:62px}.check-field{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:11px;white-space:nowrap;cursor:pointer}.kbd{display:inline-block;padding:1px 5px;border:1px solid var(--line);border-radius:4px;background:var(--raised);font:10px Consolas,monospace;color:var(--muted)}
.leader-table{min-width:1080px}.leader-table th[data-col]{cursor:pointer;user-select:none;white-space:nowrap}.leader-table th[data-col]:hover{color:var(--start)}.leader-table .sort-mark{display:inline-block;width:12px;color:var(--start);font-size:10px}.leader-table th{padding:11px 10px}.leader-table td{padding:10px 10px}.leader-table .rank{color:var(--muted);font-size:11px;width:34px}.leader-table .bot-link{display:inline-flex;align-items:center;gap:9px;color:var(--fg);font-weight:600;white-space:nowrap}.leader-table .bot-link:hover{color:var(--start);text-decoration:none}.leader-table .bot-link .bot-avatar{width:28px;height:28px}.leader-table .bot-link .icon{width:13px;height:13px;opacity:0}.leader-table .bot-link:hover .icon{opacity:1}.spark{display:block;width:104px;height:26px}.compare-check{accent-color:var(--start);width:14px;height:14px;cursor:pointer}.group-tag{display:inline-block;padding:2px 7px;border-radius:5px;background:var(--raised);color:var(--muted);font-size:10px;white-space:nowrap}.group-tag.learn{color:var(--start);background:var(--accent-soft)}.group-tag.control{color:var(--warn);background:var(--raised)}
.compare-panel{border:1px solid var(--start);border-radius:12px;background:linear-gradient(120deg,var(--panel),var(--accent-soft));padding:18px 20px;margin:0 0 20px}.compare-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}.compare-head h2{display:flex;align-items:center;gap:9px;font-size:16px}.compare-head .icon{width:19px;height:19px;color:var(--start)}.compare-metric{margin:11px 0}.compare-metric-name{font-size:11px;color:var(--muted);margin-bottom:5px}.compare-lines{display:grid;gap:4px}.compare-line{display:grid;grid-template-columns:130px 1fr 92px;align-items:center;gap:10px;font-size:11px}.compare-line .who{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.compare-track{height:10px;border-radius:5px;background:var(--raised);overflow:hidden}.compare-fill{display:block;height:100%;border-radius:5px;background:var(--start)}.compare-line:nth-child(2) .compare-fill{background:var(--eat)}.compare-line:nth-child(3) .compare-fill{background:var(--warn)}.compare-val{text-align:right;font-variant-numeric:tabular-nums}.compare-val.best{color:var(--start);font-weight:700}.compare-note{color:var(--muted);font-size:10px;margin-top:12px}.compare-empty{color:var(--muted);font-size:12px}
.bot-hero{display:flex;align-items:center;gap:22px;padding:26px 0 22px}.bot-hero .bot-avatar{width:84px;height:84px;border-radius:20px}.bot-hero h1{font-size:40px}.bot-hero .hero-tags{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}.bot-hero .hero-tags .badge{font-size:11px}.bot-hero .hero-side{margin-left:auto;text-align:right;color:var(--muted);font-size:11px}.bot-hero .hero-side b{display:block;color:var(--fg);font-size:15px;font-weight:600}.kpi-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:24px}.kpi-grid .metric{min-height:126px}.kpi-grid .metric strong{font-size:27px}
.chart-card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:18px 20px;margin-bottom:24px}.chart-head{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px}.chart-head h2{display:flex;align-items:center;gap:9px;font-size:16px}.chart-head .icon{width:19px;height:19px;color:var(--start)}.metric-tabs{display:flex;gap:5px;flex-wrap:wrap}.metric-tabs button{padding:6px 11px;border:1px solid var(--line);border-radius:7px;background:var(--raised);color:var(--muted);font-size:11px}.metric-tabs button[aria-pressed="true"]{border-color:var(--start);color:var(--start);background:var(--accent-soft)}.chart-box{position:relative;min-height:250px}.chart-box svg{display:block;width:100%;height:auto}.chart-box .grid-line{stroke:var(--line);stroke-dasharray:3 5}.chart-box .zero-line{stroke:var(--muted);opacity:.5}.chart-box .axis-text{fill:var(--muted);font-size:10px}.chart-box .chart-line{fill:none;stroke:var(--start);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}.chart-box .chart-area{fill:var(--start);opacity:.06}.chart-box .chart-dot{fill:var(--start);stroke:var(--panel);stroke-width:1.5;cursor:pointer}.chart-box .chart-dot:hover{r:7}.chart-box .chart-dot.death{fill:var(--bad)}.chart-box .chart-dot.crash{fill:var(--warn)}.chart-empty{padding:60px 0;text-align:center;color:var(--muted);font-size:12px}.chart-tip{position:fixed;pointer-events:none;z-index:50;padding:8px 11px;border:1px solid var(--start);border-radius:8px;background:var(--panel);color:var(--fg);font-size:11px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap}.chart-tip b{color:var(--start)}
.stack-bar{display:flex;height:22px;border-radius:7px;overflow:hidden;background:var(--raised);margin:12px 0}.stack-seg{border:0;cursor:pointer;transition:opacity .15s;min-width:2px}.stack-seg:hover{opacity:.7}.stack-seg.active{outline:2px solid var(--fg);outline-offset:-2px}.chip-row{display:flex;gap:7px;flex-wrap:wrap}.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--line);border-radius:20px;background:var(--raised);color:var(--muted);font-size:11px;cursor:pointer}.chip:hover,.chip.active{border-color:var(--start);color:var(--start);background:var(--accent-soft)}.chip i{width:8px;height:8px;border-radius:50%;display:inline-block}.achievements{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}.achievement{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font-size:11px}.achievement .icon{width:15px;height:15px;color:var(--start)}.achievement.muted-ach{color:var(--muted)}
.form-strip{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:24px}.form-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);font-size:10px;color:var(--muted);white-space:nowrap}.form-chip:hover{border-color:var(--start);text-decoration:none}.form-chip i{width:7px;height:7px;border-radius:50%}.form-chip b{color:var(--fg);font-variant-numeric:tabular-nums}
.kind-bar{display:grid;grid-template-columns:120px 1fr 52px;gap:10px;align-items:center;font-size:11px;margin:7px 0}.kind-bar .kn{display:inline-flex;align-items:center;gap:7px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kind-bar .kn .icon{width:14px;height:14px}.kind-bar .kv{text-align:right;font-variant-numeric:tabular-nums}
.match-table{min-width:1000px}.match-table th[data-col]{cursor:pointer;user-select:none;white-space:nowrap}.match-table th[data-col]:hover{color:var(--start)}.match-table td{padding:11px 14px}.match-table .world-link{white-space:nowrap;font-weight:600}.match-table .muted-cell{color:var(--muted)}.bot-nav{display:flex;justify-content:space-between;gap:12px;margin:22px 0 0}.bot-nav a{display:inline-flex;align-items:center;gap:8px;padding:9px 13px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px}.bot-nav a:hover{border-color:var(--start);text-decoration:none}.bot-nav .icon{width:15px;height:15px}
.foot-hint{color:var(--muted);font-size:10px;margin-top:9px}.foot-hint .kbd{margin:0 2px}
@media print{.main-nav,.hub-actions,.toolbar,.metric-tabs,.compare-panel,.chart-tip,.small-button{display:none!important}.heatmap-wrap,.chart-card,.compare-panel{break-inside:avoid}}
`;

// Вся таблица доступна и без JS. Элементы управления появляются только после инициализации.
const SCRIPT = `
(() => {
  const root = document.documentElement;
  const theme = document.querySelector('[data-theme-toggle]');
  try { const saved = localStorage.getItem('flybot-timeline-theme'); if (saved === 'light') root.dataset.theme = saved; } catch (_) {}
  const labelTheme = () => { theme.querySelector('[data-theme-label]').textContent = root.dataset.theme === 'light' ? 'Тёмная тема' : 'Светлая тема'; };
  if (theme) { theme.hidden = false; labelTheme(); theme.addEventListener('click', () => { root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light'; labelTheme(); try { localStorage.setItem('flybot-timeline-theme', root.dataset.theme); } catch (_) {} }); }
  const toolbar = document.querySelector('[data-toolbar]');
  if (!toolbar) return;
  const body = document.querySelector('[data-rows]');
  const rows = Array.from(body.rows);
  const search = document.querySelector('[data-search]');
  const filter = document.querySelector('[data-filter]');
  const sort = document.querySelector('[data-sort]');
  const count = document.querySelector('[data-count]');
  const empty = document.querySelector('[data-empty]');
  const refresh = () => {
    const q = search.value.trim().toLocaleLowerCase('ru');
    let visible = 0;
    rows.forEach(row => { row.hidden = !((row.dataset.search || '').toLocaleLowerCase('ru').includes(q) && (!filter.value || (row.dataset.filter || '').split(' ').includes(filter.value))); if (!row.hidden) visible++; });
    const key = sort.value;
    const ordered = rows.slice().sort((a, b) => {
      if (key === 'newest') return Number(a.dataset.order) - Number(b.dataset.order);
      if (key === 'oldest') return Number(b.dataset.order) - Number(a.dataset.order);
      if (key === 'name') return a.dataset.search.localeCompare(b.dataset.search, 'ru');
      const av = a.dataset[key], bv = b.dataset[key];
      if (av === '' || bv === '') return av === bv ? Number(a.dataset.order) - Number(b.dataset.order) : av === '' ? 1 : -1;
      return Number(bv) - Number(av) || Number(a.dataset.order) - Number(b.dataset.order);
    });
    ordered.forEach(row => body.appendChild(row));
    count.textContent = 'Показано ' + visible + ' из ' + rows.length;
    empty.hidden = visible !== 0;
  };
  toolbar.hidden = false;
  const crew = Array.from(document.querySelectorAll('[data-bot-focus]'));
  const syncCrew = () => crew.forEach(button => button.setAttribute('aria-pressed', String(search.value === button.dataset.botFocus)));
  search.addEventListener('input', () => { refresh(); syncCrew(); }); filter.addEventListener('change', refresh); sort.addEventListener('change', refresh);
  crew.forEach(button => { button.disabled = false; button.addEventListener('click', () => {
    search.value = search.value === button.dataset.botFocus ? '' : button.dataset.botFocus;
    filter.value = ''; refresh(); syncCrew();
    document.querySelector('.world-table').closest('.panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }); });
  refresh();
})();
`;

// Интерактивная аналитика ботов: сортировка, фильтры, сравнение, гистограмма, теплокарта, CSV.
const BOTS_SCRIPT = `
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const node = $('[data-bots-data]');
  if (!node) return;
  const bots = JSON.parse(node.textContent);
  const byNick = Object.fromEntries(bots.map(b => [b.nick, b]));
  const tbody = $('[data-bot-rows]');
  const rows = $$('[data-bot-row]');
  const search = $('[data-bot-search]');
  const groupSel = $('[data-bot-group]');
  const modeSel = $('[data-bot-mode]');
  const minInput = $('[data-bot-min]');
  const ptsOnly = $('[data-bot-points-only]');
  const count = $('[data-bot-count]');
  const empty = $('[data-bot-empty]');
  const clearBtns = $$('[data-bot-clear]');
  const csvBtn = $('[data-bot-csv]');
  const headers = $$('[data-col]');
  let sortCol = 2, sortDir = -1, range = null;
  const sortMark = () => headers.forEach(h => {
    const mark = h.querySelector('.sort-mark');
    if (mark) mark.textContent = Number(h.dataset.col) === sortCol ? (sortDir === -1 ? '▼' : '▲') : '';
  });
  const sortRows = () => {
    rows.slice().sort((a, b) => {
      const av = a.dataset['c' + sortCol], bv = b.dataset['c' + sortCol];
      if (av === '' && bv === '') return Number(a.dataset.order) - Number(b.dataset.order);
      if (av === '') return 1;
      if (bv === '') return -1;
      const cmp = sortCol === 0 ? av.localeCompare(bv, 'ru') : Number(av) - Number(bv);
      return sortDir * cmp || Number(a.dataset.order) - Number(b.dataset.order);
    }).forEach((r, i) => { tbody.appendChild(r); const rank = r.querySelector('.rank'); if (rank) rank.textContent = i + 1; });
    sortMark();
  };
  const refresh = () => {
    const q = search.value.trim().toLocaleLowerCase('ru');
    const group = groupSel.value, mode = modeSel.value, min = Number(minInput.value) || 0;
    let visible = 0;
    rows.forEach(r => {
      const ok = (!q || (r.dataset.nick || '').toLocaleLowerCase('ru').includes(q))
        && (!group || r.dataset.group === group)
        && (!mode || (r.dataset.modes || '').split(' ').includes(mode))
        && Number(r.dataset.n) >= min
        && (!ptsOnly.checked || r.dataset.hasPoints === '1')
        && (!range || (r.dataset.points !== '' && Number(r.dataset.points) >= range[0] && Number(r.dataset.points) < range[1]));
      r.hidden = !ok; if (ok) visible++;
    });
    count.textContent = 'Показано ' + visible + ' из ' + rows.length;
    empty.hidden = visible !== 0;
  };
  headers.forEach(h => h.addEventListener('click', () => {
    const col = Number(h.dataset.col);
    if (col === sortCol) sortDir = -sortDir;
    else { sortCol = col; sortDir = h.dataset.type === 'text' ? 1 : -1; }
    sortRows();
  }));
  [search, groupSel, modeSel, minInput, ptsOnly].forEach(el => {
    el.addEventListener('input', refresh); el.addEventListener('change', refresh);
  });
  const bins = $$('[data-bin]');
  bins.forEach(bin => bin.addEventListener('click', () => {
    const lo = Number(bin.dataset.lo), hi = Number(bin.dataset.hi);
    range = (range && range[0] === lo && range[1] === hi) ? null : [lo, hi];
    bins.forEach(b => b.classList.toggle('active', !!range && Number(b.dataset.lo) === range[0]));
    refresh();
  }));
  const heatClasses = {death:'hm-death', crash:'hm-crash', disconnect:'hm-disconnect', timeout:'hm-timeout', other:'hm-other', '':'hm-empty'};
  const cells = $$('[data-hm-cell]');
  const recolor = mode => {
    if (mode === 'result') { cells.forEach(c => c.className = 'hm-cell ' + (heatClasses[c.dataset.r] || 'hm-other')); return; }
    const key = mode === 'points' ? 'p' : 'l';
    const nums = cells.map(c => c.dataset[key]).filter(v => v !== '' && v != null).map(Number);
    const lo = nums.length ? Math.min.apply(null, nums) : 0, hi = nums.length ? Math.max.apply(null, nums) : 1;
    cells.forEach(c => {
      const v = c.dataset[key];
      if (v === '' || v == null) { c.className = 'hm-cell hm-empty'; return; }
      const q = hi === lo ? 4 : Math.min(4, Math.max(0, Math.floor((Number(v) - lo) / (hi - lo) * 5)));
      c.className = 'hm-cell hm-q' + q;
    });
  };
  const heatSel = $('[data-heat-mode]');
  if (heatSel) heatSel.addEventListener('change', () => recolor(heatSel.value));
  const compareBoxes = $$('[data-compare]');
  const comparePanel = $('[data-compare-panel]');
  const compareBody = $('[data-compare-body]');
  const compareHint = $('[data-compare-hint]');
  const METRICS = [['pointsAvg','Очки за матч · среднее',1],['lifeMin','Жизнь за матч · среднее, мин',1],['nightRate','Пережил первую ночь',0],['eventsAvg','Событий за матч',1],['streakBest','Серия матчей без сбоев',0],['n','Матчей в карьере',0]];
  const fmt = (key, v, d) => {
    if (v == null) return '—';
    if (key === 'nightRate') return Math.round(v * 100) + '%';
    return String(d ? Math.round(v * 10) / 10 : Math.round(v));
  };
  const renderCompare = () => {
    const sel = compareBoxes.filter(b => b.checked).map(b => b.dataset.compare);
    if (sel.length < 2) { comparePanel.hidden = true; return; }
    comparePanel.hidden = false;
    const parts = METRICS.map(([key, name, digits]) => {
      const vals = sel.map(n => byNick[n] ? byNick[n][key] : null);
      const known = vals.filter(v => v != null);
      const lo = known.length ? Math.min.apply(null, known) : 0;
      const hi = known.length ? Math.max.apply(null, known) : 0;
      const best = known.length ? hi : null;
      const lines = sel.map((n, i) => {
        const v = vals[i];
        const w = v == null ? 0 : (hi === lo ? 100 : 14 + 86 * (v - lo) / (hi - lo));
        const cls = v != null && v === best ? ' best' : '';
        return '<div class="compare-line"><span class="who">' + E(n) + '</span><span class="compare-track"><i class="compare-fill" style="width:' + w.toFixed(1) + '%"></i></span><span class="compare-val' + cls + '">' + fmt(key, v, digits) + '</span></div>';
      }).join('');
      return '<div class="compare-metric"><div class="compare-metric-name">' + name + '</div><div class="compare-lines">' + lines + '</div></div>';
    });
    compareBody.innerHTML = parts.join('');
    compareHint.textContent = 'Шкала внутри выбранных ботов · прочерк = нет данных · выбрано ' + sel.length + ' из 3';
  };
  compareBoxes.forEach(b => b.addEventListener('change', () => {
    if (b.checked && compareBoxes.filter(x => x.checked).length > 3) { b.checked = false; renderCompare(); compareHint.textContent = 'Не больше трёх ботов за раз'; return; }
    renderCompare();
  }));
  const param = /[?&]compare=([^&]+)/.exec(location.search);
  if (param) {
    const nick = decodeURIComponent(param[1]);
    const box = compareBoxes.find(b => b.dataset.compare === nick);
    if (box) box.checked = true;
  }
  const csvEscape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const exportCsv = (name, head, lines) => {
    const text = [head].concat(lines).map(r => r.map(csvEscape).join(';')).join('\\r\\n');
    const blob = new Blob([String.fromCharCode(65279) + text], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  csvBtn.addEventListener('click', () => {
    const head = ['Бот','Группа','Режимы','Матчей','Очки/матч','Очки всего','Жизнь ср. мин','Первая ночь','Событий','Убийств','Сбоев','Серия'];
    const lines = rows.filter(r => !r.hidden).map(r => {
      const b = byNick[r.dataset.nick];
      return [b.nick, b.group || '—', (b.modes || []).join(' '), b.n, b.pointsAvg, b.pointsSum, b.lifeMin, b.nightRate == null ? null : Math.round(b.nightRate * 100) + '%', b.eventsTotal, b.killsTotal, b.crashes, b.streakBest];
    });
    exportCsv('flybot-bots.csv', head, lines);
  });
  const clearAll = () => {
    search.value = ''; groupSel.value = ''; modeSel.value = ''; minInput.value = 0; ptsOnly.checked = false; range = null;
    bins.forEach(b => b.classList.remove('active')); refresh();
  };
  clearBtns.forEach(b => b.addEventListener('click', clearAll));
  document.addEventListener('keydown', e => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') { e.preventDefault(); search.focus(); }
    if (e.key === 'Escape') clearAll();
  });
  sortRows(); refresh(); renderCompare(); recolor('result');
})();
`;

// Карточка бота: переключаемый график, подсказки, фильтр по исходам и таблица матчей.
const BOT_SCRIPT = `
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const node = $('[data-career-data]');
  if (!node) return;
  const data = JSON.parse(node.textContent);
  const chart = $('[data-chart-box]');
  const tip = $('[data-chart-tip]');
  const MET = {p:['очки',1], l:['жизнь, мин',1], d:['игровые дни',1], e:['события',0]};
  const fmt = (v, d) => v == null ? '—' : String(d ? Math.round(v * 10) / 10 : Math.round(v));
  const draw = key => {
    const usable = data.filter(d => d[key] != null);
    if (!usable.length) { chart.innerHTML = '<div class="chart-empty">Нет данных по этой метрике</div>'; return; }
    const W = 1000, H = 250, L = 64, R = 22, T = 18, B = 36;
    const all = usable.map(d => d[key]);
    const lo = Math.min.apply(null, [0].concat(all)), hi0 = Math.max.apply(null, [0].concat(all));
    const hi = hi0 === lo ? lo + 1 : hi0;
    const x = i => L + i * (W - L - R) / Math.max(1, data.length - 1);
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    let out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="График карьеры по матчам">';
    for (let g = 0; g <= 4; g++) {
      const v = lo + (hi - lo) * g / 4, gy = y(v);
      out += '<line class="grid-line" x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + gy.toFixed(1) + '"/><text class="axis-text" x="' + (L - 8) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">' + fmt(v, 1) + '</text>';
    }
    if (lo < 0 && hi > 0) out += '<line class="zero-line" x1="' + L + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - R) + '" y2="' + y(0).toFixed(1) + '"/>';
    const segments = [];
    let cur = [];
    data.forEach((d, i) => {
      if (d[key] == null) { if (cur.length) segments.push(cur); cur = []; return; }
      cur.push([x(i), y(d[key])]);
    });
    if (cur.length) segments.push(cur);
    const base = y(0).toFixed(1);
    segments.forEach(sg => {
      const pts = sg.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      if (sg.length > 1) {
        out += '<polygon class="chart-area" points="' + pts + ' ' + sg[sg.length - 1][0].toFixed(1) + ',' + base + ' ' + sg[0][0].toFixed(1) + ',' + base + '"/>';
        out += '<polyline class="chart-line" points="' + pts + '"/>';
      }
    });
    data.forEach((d, i) => {
      if (d[key] == null) return;
      const tone = d.r === 'death' ? ' death' : (d.r === 'crash' || d.r === 'disconnect' ? ' crash' : '');
      out += '<circle class="chart-dot' + tone + '" cx="' + x(i).toFixed(1) + '" cy="' + y(d[key]).toFixed(1) + '" r="5" data-i="' + i + '"><title>' + E(d.w) + '</title></circle>';
    });
    const step = Math.max(1, Math.ceil(data.length / 8));
    data.forEach((d, i) => {
      if (i % step === 0 || i === data.length - 1) out += '<text class="axis-text" x="' + x(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + E(d.label) + '</text>';
    });
    chart.innerHTML = out + '</svg>';
    Array.from(chart.querySelectorAll('.chart-dot')).forEach(dot => {
      const d = data[Number(dot.dataset.i)];
      dot.addEventListener('mouseenter', () => {
        tip.hidden = false;
        tip.innerHTML = '<b>' + E(d.w) + '</b><br>' + E(d.label) + ' · ' + E(d.result) + '<br>' + MET[key][0] + ': ' + fmt(d[key], MET[key][1]) + (d.p != null ? ' · очки ' + fmt(d.p, 1) : '');
      });
      dot.addEventListener('mousemove', ev => {
        tip.style.left = Math.min(innerWidth - 220, ev.clientX + 12) + 'px';
        tip.style.top = Math.max(0, ev.clientY - 64) + 'px';
      });
      dot.addEventListener('mouseleave', () => { tip.hidden = true; });
      dot.addEventListener('click', () => { if (d.page) location.href = d.page; });
    });
  };
  $$('[data-metric]').forEach(btn => btn.addEventListener('click', () => {
    $$('[data-metric]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    draw(btn.dataset.metric);
  }));
  draw('p');
  const matchBody = $('[data-match-rows]');
  const matchRows = $$('[data-match-row]');
  const mSearch = $('[data-match-search]');
  const mCount = $('[data-match-count]');
  const mEmpty = $('[data-match-empty]');
  const mHeaders = $$('[data-mcol]');
  const colTypes = mHeaders.map(h => h.dataset.type || 'num');
  let mSort = 0, mDir = 1, resultFilter = '';
  const mSortMark = () => mHeaders.forEach(h => {
    const mark = h.querySelector('.sort-mark');
    if (mark) mark.textContent = Number(h.dataset.mcol) === mSort ? (mDir === 1 ? '▲' : '▼') : '';
  });
  const mSortRows = () => {
    matchRows.slice().sort((a, b) => {
      const av = a.dataset['m' + mSort], bv = b.dataset['m' + mSort];
      if (av === '' && bv === '') return Number(a.dataset.order) - Number(b.dataset.order);
      if (av === '') return 1;
      if (bv === '') return -1;
      const c = colTypes[mSort] === 'text' ? av.localeCompare(bv, 'ru') : Number(av) - Number(bv);
      return mDir * c || Number(a.dataset.order) - Number(b.dataset.order);
    }).forEach(r => matchBody.appendChild(r));
    mSortMark();
  };
  const refreshMatches = () => {
    const q = mSearch.value.trim().toLocaleLowerCase('ru');
    let visible = 0;
    matchRows.forEach(r => {
      const ok = (!q || (r.dataset.search || '').toLocaleLowerCase('ru').includes(q)) && (!resultFilter || r.dataset.result === resultFilter);
      r.hidden = !ok; if (ok) visible++;
    });
    mCount.textContent = 'Показано ' + visible + ' из ' + matchRows.length;
    mEmpty.hidden = visible !== 0;
  };
  mHeaders.forEach(h => h.addEventListener('click', () => {
    const col = Number(h.dataset.mcol);
    if (col === mSort) mDir = -mDir;
    else { mSort = col; mDir = h.dataset.type === 'text' ? 1 : -1; }
    mSortRows();
  }));
  mSearch.addEventListener('input', refreshMatches);
  $$('[data-result]').forEach(el => el.addEventListener('click', () => {
    resultFilter = resultFilter === el.dataset.result ? '' : el.dataset.result;
    $$('[data-result]').forEach(x => x.classList.toggle('active', x.dataset.result === resultFilter));
    refreshMatches();
  }));
  const csvEscape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  $('[data-match-csv]').addEventListener('click', () => {
    const head = ['Мир','Режим','Группа','Итог','Очки','Жизнь мин','Игровых дней','Первая ночь','Событий','Причина'];
    const lines = matchRows.filter(r => !r.hidden).map(r => [r.dataset.world, r.dataset.mode, r.dataset.group, r.dataset.resultName, r.dataset.points === '' ? null : Number(r.dataset.points), r.dataset.life === '' ? null : Number(r.dataset.life), r.dataset.days === '' ? null : Number(r.dataset.days), r.dataset.night, r.dataset.events, r.dataset.cause]);
    const text = [head].concat(lines).map(r => r.map(csvEscape).join(';')).join('\\r\\n');
    const blob = new Blob([String.fromCharCode(65279) + text], {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'flybot-matches.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.addEventListener('keydown', e => {
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') { e.preventDefault(); mSearch.focus(); }
    if (e.key === 'Escape') { mSearch.value = ''; resultFilter = ''; $$('[data-result]').forEach(x => x.classList.remove('active')); refreshMatches(); }
  });
  mSortRows(); refreshMatches();
})();
`;

const minute = s => s == null ? '—' : `${Math.round(s / 60)} мин`;
const value = n => n == null ? '—' : esc(n);
const timedEvents = c => (Array.isArray(c.events) ? c.events : []).filter(e => Number.isFinite(e.wt));
const badge = (label, tone = '', glyph) => `<span class="badge ${tone}">${icon(glyph || (tone === 'good' ? 'shield' : tone === 'bad' ? 'skull' : tone === 'warn' ? 'signal' : 'clock'))}${esc(label)}</span>`;
const metric = (label, n, hint, tone = '', glyph = 'cube') => `<div class="metric ${tone}"><div class="metric-top"><span class="metric-icon">${icon(glyph)}</span><span class="metric-label">${esc(label)}</span></div><strong>${esc(n)}</strong><small>${esc(hint)}</small></div>`;
function crewStrip(cards) {
  if (!cards.length) return '';
  return `<section class="crew-panel" aria-label="Участники мира"><p class="crew-label">${icon('fly')}Участники · нажмите на портрет, чтобы найти бота в таблице</p><div class="crew-strip">${cards.map(c => `<button type="button" class="crew-bot" data-bot-focus="${esc(c.nick)}" aria-label="Показать результат ${esc(c.nick)}" aria-pressed="false" disabled>${avatar(c.nick)}<span>${esc(c.nick)}</span></button>`).join('')}</div></section>`;
}
function stamp(w) {
  const m = /^w(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(w.id || '');
  return m ? `${m[3]}.${m[2]}.${m[1]} · ${m[4]}:${m[5]}` : '';
}
function worldFilters(w) {
  const filters = [];
  if (w.serverOk === false || w.crashes > 0 || w.disconnects > 0) filters.push('issues');
  if (w.cheats > 0) filters.push('assisted');
  return filters.length ? filters.join(' ') : 'clean';
}
function worldStatus(w) {
  if (w.serverOk === false) return { label: 'Сервер не запущен', tone: 'bad', filter: 'issues', glyph: 'signal' };
  if (w.crashes > 0 || w.disconnects > 0) return { label: `Сбои: ${(w.crashes || 0) + (w.disconnects || 0)}/${w.bots == null ? '—' : w.bots}`, tone: 'warn', filter: 'issues', glyph: 'signal' };
  if (w.cheats > 0) return { label: 'С вмешательством', tone: 'warn', filter: 'assisted', glyph: 'wand' };
  return { label: 'Без отмеченных сбоев', tone: 'good', filter: 'clean' };
}
function shell(title, body, page = '', extra = '') {
  const nav = `<nav class="main-nav" aria-label="Разделы архива"><a href="index.html" class="${page === 'index' ? 'active' : ''}">${icon('archive')}Миры</a><a href="bots.html" class="${page === 'bots' ? 'active' : ''}">${icon('fly')}Боты</a></nav>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=1000"><meta name="color-scheme" content="dark light"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(icon('fly').replace('stroke="currentColor"', 'stroke="#72d7bb"'))}"><title>${esc(title)}</title><style>${CSS}${IDENTITY_CSS}${ANALYTICS_CSS}</style></head><body><div class="wrap"><header class="topbar"><a class="brand" href="index.html" aria-label="flybot — ленты миров"><span class="brand-mark" aria-hidden="true">${icon('fly')}</span>flybot <small>HARDCORE / ХРОНИКА</small></a><div class="top-actions">${nav}<span class="pill">${icon('lock')}Локальный архив</span><button class="theme-button" type="button" data-theme-toggle hidden>${icon('sun', 'theme-sun')}${icon('moon', 'theme-moon')}<span data-theme-label>Светлая тема</span></button></div></header><main>${body}</main><footer class="footnote"><span>${icon('fly')}flybot / hardcore · хроника экспериментов</span><span>Автономный HTML · обновляется после завершения мира</span></footer></div><script>${SCRIPT}${extra}</script></body></html>`;
}
function toolbar(kind) {
  const world = kind === 'world';
  return `<div class="toolbar" data-toolbar hidden><label class="search"><span class="search-mark" aria-hidden="true">${icon('search')}</span><span class="sr-only">${world ? 'Поиск бота в таблице' : 'Поиск мира или сида'}</span><input type="search" data-search placeholder="${world ? 'Найти бота в таблице…' : 'Найти мир или сид…'}" autocomplete="off"></label><label class="select-label">${world ? 'Итог' : 'Запуски'}<select data-filter><option value="">Все</option>${world ? '<option value="death">Смерть</option><option value="crash">Сбой</option><option value="timeout">Лимит времени</option><option value="disconnect">Отключение</option>' : '<option value="issues">Со сбоями</option><option value="assisted">С вмешательством</option><option value="clean">Без отмеченных сбоев</option>'}</select></label><label class="select-label">Порядок<select data-sort>${world ? '<option value="newest">Исходный</option><option value="name">По имени</option><option value="points">Очки ↓</option><option value="life">Жизнь ↓</option>' : '<option value="newest">Новые сверху</option><option value="oldest">Старые сверху</option><option value="life">Медиана жизни ↓</option><option value="night">Первая ночь ↓</option><option value="points">Средние очки ↓</option>'}</select></label></div>`;
}
function tableFooter(count, hint) {
  return `<div class="empty-filter" data-empty hidden>Ничего не найдено. Измените поиск или фильтр.</div><div class="table-footer"><span data-count role="status" aria-live="polite">Показано ${count} из ${count}</span><span>${esc(hint)}</span></div>`;
}
function nightStat(n, bots) {
  const pct = Number.isFinite(n) && bots > 0 ? Math.min(100, Math.max(0, n / bots * 100)) : 0;
  return `<span class="night-stat"><span>${value(n)}${bots > 0 ? `<span class="muted"> / ${esc(bots)}</span>` : ''}</span><span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span></span>`;
}
function dayLabel(wt) { const d = Math.floor(wt / 24000) + 1, tod = ((wt % 24000) + 24000) % 24000; return `день ${d}${tod >= 13000 && tod < 23000 ? ', ночь' : ''}`; }

// Строки без хроники не создают вымышленную ось первого дня.
function svgFor(cards) {
  const all = cards.flatMap(c => timedEvents(c).map(e => e.wt));
  if (!all.length) return `<svg viewBox="0 0 1080 100" role="img" aria-label="Нет событий"><text x="24" y="40">Нет событий для построения ленты</text></svg>`;
  // Хроника может достичь лимита событий раньше конца жизни: сохраняем реальные границы.
  const bounds = all.concat(cards.filter(c => timedEvents(c).length).flatMap(c => [c.wtStart, c.wtEnd].filter(Number.isFinite)));
  let t0 = Math.floor(Math.min(...bounds) / 24000) * 24000, t1 = Math.max(...bounds);
  if (t1 - t0 < 24000) t1 = t0 + 24000;
  const L = 230, R = 1160, W = R - L, rowH = 78, top = 26, bandY = top + Math.max(1, cards.length) * rowH + 6, H = bandY + 40;
  const x = wt => L + ((Math.max(t0, Math.min(t1, wt)) - t0) / (t1 - t0)) * W;
  const out = [`<svg viewBox="0 0 1180 ${H}" width="1180" height="${H}" role="img" aria-label="лента мира"><title>Игровое время слева направо, строка на бота. 24 000 тиков = игровой день.</title>`];
  for (let d = t0; d < t1; d += 24000) {
    for (const [a, b, color] of [[d, d + 13000, 'var(--day)'], [d + 13000, d + 23000, 'var(--nightband)'], [d + 23000, d + 24000, 'var(--day)']]) {
      const xa = x(a), xb = x(b);
      if (xb > xa) out.push(`<rect x="${xa.toFixed(1)}" y="${top - 10}" width="${(xb - xa).toFixed(1)}" height="${bandY - top + 10}" fill="${color}" opacity=".09"/><rect x="${xa.toFixed(1)}" y="${bandY}" width="${(xb - xa).toFixed(1)}" height="10" rx="2" fill="${color}"/>`);
    }
    out.push(`<line x1="${x(d).toFixed(1)}" y1="${top - 10}" x2="${x(d).toFixed(1)}" y2="${bandY + 10}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${(x(d) + 4).toFixed(1)}" y="${bandY + 28}" class="s">день ${Math.floor(d / 24000) + 1}</text>`);
  }
  cards.forEach((c, i) => {
    const y = top + i * rowH + 16;
    const nick = `${c.nick || ''}${CP.pointsOf(c) != null ? ` · ${CP.pointsOf(c)} оч.` : ''}`;
    out.push(avatar(c.nick).replace('<svg ', `<svg x="6" y="${y - 17}" `));
    out.push(`<line x1="6" y1="${y + 49}" x2="${R}" y2="${y + 49}" stroke="var(--line)" opacity=".6"/><text x="48" y="${y + 4}"><title>${esc(nick)}</title>${esc(nick.length > 24 ? nick.slice(0, 23) + '…' : nick)}</text>`);
    const gl = groupLabel(c);
    if (gl) out.push(`<text x="48" y="${y + 20}" class="s">${esc(gl)}</text>`);
    const ev = timedEvents(c);
    if (!ev.length) { out.push(`<text x="${L}" y="${y + 4}" class="s">нет событий: ${esc(c.result || '')} ${esc(c.note || c.reason || '')}</text>`); return; }
    const a = x(Number.isFinite(c.wtStart) ? c.wtStart : ev[0].wt), b = x(Number.isFinite(c.wtEnd) ? c.wtEnd : ev[ev.length - 1].wt);
    out.push(`<line x1="${a.toFixed(1)}" y1="${y}" x2="${Math.max(a + 2, b).toFixed(1)}" y2="${y}" stroke="var(--life)" stroke-width="3" stroke-linecap="round"/>`);
    let lastLabelX = -1e9;
    for (const e of ev) {
      if (e.kind === 'night' || e.kind === 'day') continue;
      const ex = x(e.wt), k = KIND[e.kind] || KIND.end;
      const description = `${e.text || k.label} — ${dayLabel(e.wt)}`;
      if (e.kind === 'death' || e.kind === 'end') {
        const full = `${e.kind === 'death' ? '✕ ' : '■ '}${e.text || k.label}, ${dayLabel(e.wt)}`;
        out.push(`<circle cx="${ex.toFixed(1)}" cy="${y}" r="5" fill="${k.c}"><title>${esc(description)}</title></circle><text x="${ex.toFixed(1)}" y="${y - 12}" text-anchor="${ex > R - 240 ? 'end' : 'start'}" style="fill:${k.c};font-weight:600"><title>${esc(full)}</title>${esc(full.length > 44 ? full.slice(0, 43) + '…' : full)}</text>`);
        continue;
      }
      out.push(`<circle cx="${ex.toFixed(1)}" cy="${y}" r="${e.kind === 'start' ? 5 : 4}" fill="${k.c}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(description)}</title></circle>`);
      if (ex - lastLabelX > 110) {
        lastLabelX = ex;
        const label = String(e.text || k.label);
        out.push(`<text x="${ex.toFixed(1)}" y="${y + 24}" text-anchor="${ex < L + 70 ? 'start' : ex > R - 70 ? 'end' : 'middle'}" class="s"><title>${esc(description)}</title>${esc(label.length > 22 ? label.slice(0, 21) + '…' : label)}</text>`);
      }
    }
  });
  out.push('</svg>');
  return out.join('');
}
function legend(cards) {
  const used = new Set(cards.flatMap(c => timedEvents(c).map(e => e.kind)));
  const keys = Object.keys(KIND).filter(k => used.has(k) && k !== 'day' && k !== 'night' && k !== 'end');
  const glyphs = { start: 'fly', stage: 'step', eat: 'food', flee: 'run', shelter: 'shelter', leave: 'back', stuck: 'signal', lowhp: 'skull', night_survived: 'moon', hunt: 'sword', kill: 'skull', death: 'skull', fight: 'sword' };
  return `<details class="legend-details"><summary>Обозначения событий · ${keys.length}</summary><div class="legend">${keys.map(k => `<span style="color:${KIND[k].c}">${icon(glyphs[k] || 'trace')}${KIND[k].label}</span>`).join('')}<span>${icon('moon')}ночь</span></div></details>`;
}
function groupsLine(cards, w) {
  const by = {};
  for (const c of cards) if (c.group) (by[c.group] = by[c.group] || []).push(c.nick);
  const span = a => (a.length > 2 ? `${a[0]}–${a[a.length - 1]}` : a.join(', '));
  const names = { learn: 'учатся', control: 'контроль' };
  const parts = Object.entries(by).map(([g, ns]) => `${esc(names[g] || g)} ${esc(span(ns))}`);
  const pg = w && w.pointsByGroup ? Object.entries(w.pointsByGroup).filter(([g]) => g !== 'all').map(([g, v]) => `${esc(GROUP_TEXT[g] || g)} ${esc(v)}`) : [];
  if (pg.length) parts.push(`очки в среднем: ${pg.join(', ')}`);
  return parts.join(' · ');
}
function worldHtml(w, cards) {
  const gl = groupsLine(cards, w), withEvents = cards.filter(c => timedEvents(c).length), missing = cards.length - withEvents.length;
  const ptsOk = CP.worldUsable(w, cards);   // очки старой версии не показываем и не сравниваем
  const deaths = cards.filter(c => c.result === 'death').length, crashes = cards.filter(c => c.result === 'crash' || c.result === 'disconnect').length;
  const resultNames = { death: ['Смерть', 'bad'], crash: ['Сбой', 'warn'], disconnect: ['Отключение', 'warn'], timeout: ['Лимит времени', ''], alreadyDead: ['Уже погиб', 'bad'] };
  const rows = cards.map((c, i) => {
    const result = resultNames[c.result] || [c.result || 'Нет данных', ''];
    const night = c.firstNightSurvived === true ? 'да' : c.firstNightSurvived === false ? 'нет' : '—';
    return `<tr data-order="${i}" data-search="${esc(c.nick)}" data-filter="${esc(c.result)}" data-points="${esc(CP.pointsOf(c))}" data-life="${esc(c.lifeSec)}"><td><div class="bot-identity">${avatar(c.nick)}<a class="bot-name mono" href="${esc(botFile(c.nick))}" title="Карьера ${esc(c.nick)}">${esc(c.nick)}</a></div></td><td>${groupLabel(c) ? `<span class="row-sub">${esc(groupLabel(c))}</span>` : '<span class="muted">—</span>'}</td><td class="num">${value(CP.pointsOf(c))}</td><td>${badge(result[0], result[1], c.result === 'disconnect' || c.result === 'crash' ? 'signal' : c.result === 'death' || c.result === 'alreadyDead' ? 'skull' : 'clock')}<span class="row-sub mono">${esc(c.result)}</span></td><td class="num">${minute(c.lifeSec)}</td><td class="num">${value(c.gameDays)}</td><td>${night}</td><td class="reason">${esc(c.deathMessageServer || c.deathMessage || c.cause || c.reason || c.note || '—')}${c.exitCode != null ? `<span class="row-sub mono">exit ${esc(c.exitCode)}</span>` : ''}</td></tr>`;
  }).join('');
  return shell(`Мир ${w.id}`, `<section class="hero"><a class="breadcrumb" href="index.html">${icon('back')}все миры</a><p class="eyebrow">Карточка запуска / ${w.br ? 'Battle Royale' : 'Hardcore'}</p><div class="hero-line"><h1>Мир <span class="mono">${esc(w.id)}</span></h1>${badge(missing === cards.length && cards.length ? 'Без хроники' : crashes ? 'Есть сбои' : 'Запуск завершён', missing || crashes ? 'warn' : 'good')}</div><p class="intro">${esc(stamp(w))}${stamp(w) ? ' · ' : ''}События ботов, игровые дни и результаты одного мира.</p></section>
<div class="metrics">${metric('Ботов в запуске', cards.length, `${withEvents.length} с хроникой · ${missing} без событий`, '', 'fly')}${metric('Мир шёл', minute(w.durSec), 'реальное время, не время жизни бота', '', 'clock')}${metric('Пережили первую ночь', cards.filter(c => c.firstNightSurvived).length, 'подтверждено карточками ботов', '', 'moon')}${metric('Сбои / отключения', crashes, `умерло ${deaths} · сбой не равен смерти`, crashes ? 'warn' : '', 'signal')}</div>${crewStrip(cards)}
<div class="world-meta"><span>Сид <b class="mono">${esc(w.seed)}</b></span><span>Читов <b>${value(w.cheats)}</b></span>${ptsOk && w.pointsAvg != null ? `<span>очки в среднем ${value(w.pointsAvg)}</span>` : `<span class="muted">очки: ${esc(CP.SHORT_NOTE)}</span>`}${w.br ? `<span>Убийств муха→муха <b>${value(w.kills != null ? w.kills : cards.reduce((n, c) => n + (c.killCount || 0), 0))}</b>${cards.some(c => c.killCount) ? ` · ${cards.filter(c => c.killCount).map(c => `${esc(c.nick)} ${esc(c.killCount)}`).join(', ')}` : ''}</span>` : ''}${w.lastAlive ? `<span>Последний живой <b>${esc(w.lastAlive)}</b></span>` : ''}</div>${gl ? `<p class="group-line">${gl}</p>` : ''}${w.consoleCommands && w.consoleCommands.length ? `<div class="alert"><strong>Команды хозяина</strong><p>${esc(w.consoleCommands.join('; '))}</p></div>` : ''}
${missing ? `<aside class="alert"><strong>${icon('signal')}Нет событий у ${missing} из ${cards.length} ботов</strong><p>${withEvents.length ? 'Лента показывает только записанные события. Пустые строки не означают выживание.' : 'Карточки не содержат игровой хроники. Время жизни, игровые дни и исход первой ночи не восстановить; нули в сводке не доказывают выживание.'}</p></aside>` : ''}
<div class="section-heading"><div><h2>${icon('trace')}Хроника мира</h2><p>${withEvents.length ? 'Время слева направо · 24 000 тиков = игровой день · подробности при наведении' : 'Для построения ленты нужны события с игровым временем'}</p></div><span class="section-count">${withEvents.length} / ${cards.length} с событиями</span></div><section class="panel" aria-label="Хроника мира">${withEvents.length ? `${legend(cards)}<div class="timeline-scroll" tabindex="0" role="region" aria-label="Лента событий, горизонтальная прокрутка">${svgFor(cards)}</div>` : `<div class="empty-timeline"><div class="empty-icon" aria-hidden="true">${icon('signal')}</div><h2>Хроника не записана</h2><p>Нет точек старта, событий и игрового времени. Вместо вымышленной полосы дня и ночи — фактические результаты ботов ниже.</p></div>`}</section>
<div class="section-heading"><div><h2>${icon('trophy')}Результаты ботов</h2><p>Длительность — из исходных карточек. ${esc(CP.NOTE)} Прочерк означает отсутствие данных.</p></div><span class="section-count">${cards.length} ботов</span></div><section class="panel" aria-label="Результаты ботов">${toolbar('world')}<div class="table-scroll" tabindex="0" role="region" aria-label="Таблица результатов, горизонтальная прокрутка"><table class="world-table"><thead><tr><th>Бот</th><th>Группа</th><th>Очки</th><th>Итог</th><th>Прожил</th><th>Игровых дней</th><th>Первая ночь</th><th>Причина</th></tr></thead><tbody data-rows>${rows}</tbody></table></div>${tableFooter(cards.length, 'Поиск и фильтр меняют только таблицу результатов')}</section>`, 'index');
}
function indexHtml(worlds, lives = []) {
  const ordered = worlds.slice().reverse(), latest = ordered[0];
  const ptsOf = w => CP.worldUsable(w, lives) ? w.pointsAvg : null;   // старые минусы в расчёт не берём
  const issues = worlds.filter(w => worldStatus(w).filter === 'issues').length;
  const assisted = worlds.filter(w => w.cheats > 0).length;
  const duration = worlds.reduce((n, w) => n + (Number.isFinite(w.durSec) ? w.durSec : 0), 0);
  const rows = ordered.map((w, i) => {
    const status = worldStatus(w), serverFailed = w.serverOk === false;
    return `<tr data-order="${i}" data-search="${esc(`${w.id} ${w.seed || ''}`)}" data-filter="${worldFilters(w)}" data-life="${esc(w.medianLifeSec)}" data-night="${esc(w.firstNight)}" data-points="${esc(ptsOf(w))}"><td><div class="world-cell">${icon('cube')}<div>${serverFailed ? `<span class="world-id mono">${esc(w.id)}</span>` : `<a class="world-id mono" href="${esc(w.id)}.html">${esc(w.id)}${icon('arrow')}</a>`}<span class="row-sub">${esc(stamp(w))}${i === 0 ? ' · последний' : ''}</span></div></div></td><td>${badge(status.label, status.tone, status.glyph)}</td><td class="num">${value(w.bots)}</td><td class="num">${value(w.deaths)}</td><td class="num">${nightStat(w.firstNight, w.bots)}</td><td class="num">${minute(w.medianLifeSec)}</td><td class="num">${value(ptsOf(w))}</td><td class="num">${minute(w.durSec)}</td><td class="num ${w.cheats > 0 ? 'problem-number' : 'muted'}">${value(w.cheats)}</td></tr>`;
  }).join('');
  return shell('Ленты миров', `<section class="feature-hero"><div class="feature-copy"><p class="eyebrow">${icon('archive')}Архив экспериментов</p><h1>Ленты миров</h1><p class="intro">Маленькие мухи. Большие миры.<br>Каждый запуск — своя история выживания, ошибок и обучения.</p><div class="hub-actions">${latest && latest.serverOk !== false ? `<a class="button-link" href="${esc(latest.id)}.html">Последний мир ${icon('arrow')}</a>` : ''}<a class="button-link" href="bots.html">Карьеры ботов ${icon('fly')}</a></div><div class="feature-tags"><span>${icon('fly')}Летать</span><span>${icon('shield')}Выживать</span><span>${icon('leaf')}Учиться</span></div></div><div class="feature-scene">${habitatArt(latest && latest.seed)}<div class="scene-caption"><span>FLYBOT / LITTLE WORLDS</span><i></i><span>24 000 TICKS</span></div></div></section>
<div class="metrics">${metric('Миров в архиве', worlds.length, 'новые сверху · все сохранённые запуски', '', 'cube')}${metric('Время запусков', `${(duration / 3600).toFixed(1)} ч`, 'сумма записанных длительностей', '', 'clock')}${metric('Миров со сбоями', issues, 'сбой бота, отключение или отказ сервера', issues ? 'warn' : '', 'signal')}${metric('Миров с читами', assisted, 'зафиксировано вмешательство', '', 'wand')}</div>
${latest ? `<section class="latest" aria-label="Последний запуск"><div class="latest-heading"><span class="latest-emblem">${icon('cube')}</span><div><p class="eyebrow">Последний запуск</p>${latest.serverOk !== false ? `<a class="latest-id mono" href="${esc(latest.id)}.html">${esc(latest.id)}</a>` : `<span class="latest-id mono">${esc(latest.id)}</span>`}<p class="latest-meta">${esc(stamp(latest))} · ${value(latest.bots)} ботов · ${minute(latest.durSec)} · сид <span class="mono">${esc(latest.seed)}</span></p></div></div><div class="latest-right">${badge(worldStatus(latest).label, worldStatus(latest).tone, worldStatus(latest).glyph)}${latest.serverOk !== false ? `<a href="${esc(latest.id)}.html" aria-label="Открыть последний мир ${esc(latest.id)}">Открыть хронику →</a>` : ''}</div></section>` : ''}
<div class="section-heading"><div><h2>${icon('archive')}Все запуски</h2><p>Первая ночь — число подтверждённых выживших. Сбои не считаются смертями.</p></div><span class="section-count">${worlds.length} миров</span></div><section class="panel" aria-label="Архив миров">${toolbar('index')}<div class="table-scroll"><table class="archive-table"><thead><tr><th>Мир</th><th>Состояние</th><th class="num">Ботов</th><th class="num">Умерло</th><th class="num">Первая ночь</th><th class="num">Медиана жизни</th><th class="num">Средние очки</th><th class="num">Мир шёл</th><th class="num">Читов</th></tr></thead><tbody data-rows>${rows}</tbody></table></div>${tableFooter(worlds.length, `Показатели из worlds.jsonl · ${esc(CP.NOTE)} · прочерк = нет данных`)}</section>`, 'index');
}

// ---------- Карьера ботов: агрегаты, страницы и собственная аналитика ----------
const RESULT_NAMES = { death: 'Смерть', crash: 'Сбой', disconnect: 'Отключение', timeout: 'Лимит времени', alreadyDead: 'Уже погиб', '': 'Нет данных' };
const RESULT_TONE = { death: 'bad', crash: 'warn', disconnect: 'warn', timeout: '', alreadyDead: 'bad' };
const RESULT_COLOR = { death: '#8d4a4a', crash: '#a8793f', disconnect: '#8a6b3d', timeout: '#4f6b64', alreadyDead: '#8d4a4a', other: '#556b80', '': '#2c383d' };
const RESULT_CLASS = { death: 'hm-death', crash: 'hm-crash', disconnect: 'hm-disconnect', timeout: 'hm-timeout', alreadyDead: 'hm-death' };
const MODE_NAMES = { stage1a: 'Этап 1a', stage1b: 'Этап 1b', 'stage1v-br': 'Этап 1v · BR', stage2: 'Этап 2' };
const EVENT_GLYPHS = { start: 'fly', stage: 'step', eat: 'food', flee: 'run', shelter: 'shelter', leave: 'back', stuck: 'signal', lowhp: 'skull', night_survived: 'moon', hunt: 'sword', kill: 'skull', death: 'skull', fight: 'sword', night: 'moon', day: 'sun', end: 'clock' };
const finiteNum = v => Number.isFinite(v) ? v : null;
const rnd = (v, d = 0) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
const fnum = (v, d = 0) => v == null ? '—' : String(rnd(v, d));
const sumOf = a => a.reduce((n, v) => n + v, 0);
const meanOf = a => a.length ? sumOf(a) / a.length : null;
const medianOf = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctOf = v => v == null ? '—' : Math.round(v * 100) + '%';
const shortId = id => String(id || '').replace(/^w\d{8}-/, '') || '—';
const groupText = g => g === 'learn' ? 'Учатся' : g === 'control' ? 'Контроль' : g === 'смешанная' ? 'Смешанная' : 'Без группы';
const groupKey = g => g === '' ? 'none' : g === 'смешанная' ? 'mixed' : g;
const resultColor = r => RESULT_COLOR[r] || RESULT_COLOR.other;
const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
function botFile(nick) {
  const slug = String(nick || 'flybot').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'bot';
  return `bot-${slug}-${identityHash(nick).toString(36)}.html`;
}
function botStats(lives, worlds) {
  const order = new Map(worlds.map((w, i) => [w.id, i]));
  const by = new Map();
  for (const c of lives) {
    const nick = c && c.nick ? String(c.nick) : '';
    if (!nick) continue;
    let b = by.get(nick);
    if (!b) by.set(nick, b = { nick, matches: [], groups: {}, modes: {}, results: {}, kinds: {} });
    const ev = Array.isArray(c.events) ? c.events : [];
    const m = {
      world: String(c.world || ''), seed: c.seed, mode: c.mode || '', group: c.group || '', result: c.result || '',
      points: CP.pointsOf(c), life: finiteNum(c.lifeSec), days: finiteNum(c.gameDays),
      night: c.firstNightSurvived === true ? 1 : c.firstNightSurvived === false ? 0 : null,
      events: ev.length, kills: finiteNum(c.killCount),
      cause: String(c.deathMessageServer || c.deathMessage || c.cause || c.reason || c.note || ''),
      order: order.has(c.world) ? order.get(c.world) : 1e6
    };
    b.matches.push(m);
    b.groups[m.group] = (b.groups[m.group] || 0) + 1;
    b.modes[m.mode] = (b.modes[m.mode] || 0) + 1;
    b.results[m.result] = (b.results[m.result] || 0) + 1;
    for (const e of ev) b.kinds[e.kind] = (b.kinds[e.kind] || 0) + 1;
  }
  const out = [];
  for (const b of by.values()) {
    const ms = b.matches.slice().sort((a, z) => a.order - z.order);
    const vals = k => ms.map(m => m[k]).filter(v => v != null);
    const points = vals('points'), life = vals('life'), days = vals('days'), kills = vals('kills'), nights = vals('night');
    const groups = Object.keys(b.groups).filter(Boolean);
    let best = 0, cur = 0;
    for (const m of ms) { if (m.result === 'crash' || m.result === 'disconnect') cur = 0; else { cur++; if (cur > best) best = cur; } }
    const bestMatch = points.length ? ms.filter(m => m.points != null).reduce((a, z) => z.points > a.points ? z : a) : null;
    out.push({
      nick: b.nick, file: botFile(b.nick), matches: ms, n: ms.length,
      group: groups.length > 1 ? 'смешанная' : groups[0] || '', groupList: groups,
      modes: Object.keys(b.modes).filter(Boolean), results: b.results,
      deaths: b.results.death || 0, crashes: (b.results.crash || 0) + (b.results.disconnect || 0), timeouts: b.results.timeout || 0,
      pointsSum: points.length ? sumOf(points) : null, pointsN: points.length, pointsAvg: meanOf(points),
      pointsBest: points.length ? Math.max(...points) : null, pointsWorst: points.length ? Math.min(...points) : null,
      lifeSum: life.length ? sumOf(life) : null, lifeN: life.length, lifeAvg: meanOf(life), lifeMax: life.length ? Math.max(...life) : null,
      medianLife: medianOf(life), daysSum: days.length ? sumOf(days) : null, daysN: days.length, daysAvg: meanOf(days),
      nightYes: nights.length ? sumOf(nights) : null, nightN: nights.length, nightRate: nights.length ? meanOf(nights) : null,
      eventsTotal: sumOf(vals('events')), eventsAvg: meanOf(vals('events')),
      killsTotal: kills.length ? sumOf(kills) : null, killsN: kills.length,
      kinds: b.kinds, streakBest: best, form: ms.slice(-10),
      bestWorld: bestMatch ? bestMatch.world : '', first: ms.length ? ms[0].world : '', last: ms.length ? ms[ms.length - 1].world : '',
      spark: ms.slice(-12).map(m => m.points)
    });
  }
  return out.sort((a, b) => a.nick.localeCompare(b.nick, 'ru'));
}
function sparkline(values) {
  const pts = values.filter(v => v != null);
  if (pts.length < 2) return '<span class="muted">—</span>';
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const x = i => 2 + i * 100 / Math.max(1, values.length - 1), y = v => 23 - (v - lo) / span * 20;
  let out = '<svg class="spark" viewBox="0 0 104 26" aria-hidden="true"><line x1="2" y1="23" x2="102" y2="23" stroke="var(--line)"/>';
  const segs = []; let cur = [];
  values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (cur.length) segs.push(cur);
  for (const sg of segs) if (sg.length > 1) out += `<polyline fill="none" stroke="var(--start)" stroke-width="2" stroke-linecap="round" points="${sg.join(' ')}"/>`;
  const last = values[values.length - 1];
  if (last != null) out += `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5" fill="var(--start)"/>`;
  return out + '</svg>';
}
function hallHtml(stats) {
  const best = (fn, filter = () => true) => stats.filter(filter).map(s => ({ s, v: fn(s) })).filter(x => x.v != null).sort((a, b) => b.v - a.v)[0];
  const cards = [
    ['trophy', 'Лучший матч по очкам', best(s => s.pointsBest), x => `${fnum(x.v, 0)} оч.`, x => x.s.bestWorld ? ` · ${shortId(x.s.bestWorld)}` : ''],
    ['clock', 'Дольше всех жил', best(s => s.lifeMax), x => `${fnum(x.v / 60, 1)} мин`, () => ''],
    ['moon', 'Надёжнее в первую ночь', best(s => s.nightRate, s => s.nightN >= 3), x => pctOf(x.v), () => ''],
    ['shield', 'Серия без сбоев', best(s => s.streakBest), x => `${x.v} матчей`, () => ''],
    ['trace', 'Больше всех событий', best(s => s.eventsTotal), x => `${x.v}`, () => '']
  ];
  return `<div class="hall">${cards.map(([glyph, label, hit, show, extra]) => `<div class="hall-card"><div class="hall-icon">${icon(glyph)}</div><span class="hall-label">${esc(label)}</span><strong class="hall-value">${hit ? show(hit) : '—'}</strong><span class="hall-who">${hit ? `<a href="${esc(hit.s.file)}">${esc(hit.s.nick)}</a>${extra(hit)}` : 'нет данных'}</span></div>`).join('')}</div>`;
}
function histogramSvg(stats) {
  const vals = stats.map(s => s.pointsAvg).filter(v => v != null);
  if (vals.length < 2) return '<p class="panel-note">Недостаточно матчей с очками для распределения.</p>';
  const lo = Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals)), bins = 8, span = (hi - lo) / bins || 1;
  const counts = Array(bins).fill(0);
  vals.forEach(v => { counts[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / span)))]++; });
  const max = Math.max(...counts, 1), W = 460, bw = W / bins;
  let out = `<svg class="histogram" viewBox="0 0 ${W} 150" role="img" aria-label="Распределение средних очков ботов">`;
  for (let i = 0; i < bins; i++) {
    const h = counts[i] / max * 100, x = i * bw + 3, y = 112 - h, a = lo + i * span, b = lo + (i + 1) * span;
    out += `<rect class="bin" data-bin data-lo="${rnd(a, 2)}" data-hi="${rnd(b, 2)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="var(--start)" opacity=".78"><title>${fnum(a, 1)} … ${fnum(b, 1)}: ${counts[i]} ботов · клик — фильтр</title></rect>`;
    out += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${Math.max(10, y - 4).toFixed(1)}" text-anchor="middle">${counts[i]}</text><text x="${(i * bw + bw / 2).toFixed(1)}" y="132" text-anchor="middle">${rnd(a, 0)}</text>`;
  }
  return out + `<line class="axis" x1="0" y1="112" x2="${W}" y2="112"/></svg>`;
}
function groupCompareHtml(stats) {
  const groups = ['learn', 'control', ''];
  const agg = {};
  for (const g of groups) agg[g] = { n: 0, pts: [], life: [], nights: [], deaths: 0, crashes: 0, events: [] };
  for (const s of stats) for (const m of s.matches) {
    const g = m.group === 'learn' || m.group === 'control' ? m.group : '';
    const a = agg[g]; a.n++;
    if (m.points != null) a.pts.push(m.points);
    if (m.life != null) a.life.push(m.life / 60);
    if (m.night != null) a.nights.push(m.night);
    if (m.result === 'death') a.deaths++;
    if (m.result === 'crash' || m.result === 'disconnect') a.crashes++;
    a.events.push(m.events);
  }
  const metrics = [
    ['Очки / матч', a => meanOf(a.pts), v => fnum(v, 1), false],
    ['Жизнь, мин', a => meanOf(a.life), v => fnum(v, 1), false],
    ['Первая ночь', a => meanOf(a.nights), v => pctOf(v), true],
    ['Смертей', a => a.n ? a.deaths / a.n : null, v => pctOf(v), true],
    ['Сбоев', a => a.n ? a.crashes / a.n : null, v => pctOf(v), true],
    ['Событий / матч', a => meanOf(a.events), v => fnum(v, 0), false]
  ];
  let out = '';
  for (const [name, fn, show, rate] of metrics) {
    const vals = groups.map(g => fn(agg[g]));
    const max = rate ? 1 : Math.max(...vals.filter(v => v != null).map(v => Math.abs(v)), 0.001);
    for (let i = 0; i < 2; i++) {
      const v = vals[i], w = v == null ? 0 : Math.min(100, Math.abs(v) / max * 100);
      out += `<div class="bar-row"><span class="bar-label">${esc(name)} · ${esc(groupText(groups[i]))}</span><span class="bar-track"><i class="bar-fill ${i ? 'alt' : ''}" style="width:${w.toFixed(1)}%"></i></span><span class="bar-value">${v == null ? '—' : show(v)}</span></div>`;
    }
  }
  const withPoints = stats.reduce((n, s) => n + s.pointsN, 0), all = stats.reduce((n, s) => n + s.n, 0);
  return out + `<div class="bar-sub"><span>Ширина полосы — модуль значения относительно максимума, знак в числе.</span><span>Очки есть в ${withPoints} из ${all} матчей</span></div>`;
}
function heatmapHtml(stats, worlds) {
  const pages = new Set(worlds.filter(w => w.serverOk !== false).map(w => w.id));
  const cols = worlds.map(w => w.id);
  const lookup = new Map();
  for (const s of stats) { const m = new Map(); for (const x of s.matches) m.set(x.world, x); lookup.set(s.nick, m); }
  let out = '<table class="heatmap"><thead><tr><th>Бот</th>';
  cols.forEach((id, i) => { out += `<th title="${esc(id)}">${i % 5 === 0 ? i + 1 : ''}</th>`; });
  out += '</tr></thead><tbody>';
  for (const s of stats) {
    out += `<tr><th><a href="${esc(s.file)}">${esc(s.nick)}</a></th>`;
    for (const id of cols) {
      const m = lookup.get(s.nick).get(id), r = m ? m.result : '';
      const p = m && m.points != null ? rnd(m.points, 2) : '', l = m && m.life != null ? rnd(m.life / 60, 2) : '';
      const title = `${s.nick} · ${id} · ${m ? (RESULT_NAMES[r] || r || 'нет данных') : 'не участвовал'}${p !== '' ? ` · ${p} оч.` : ''}${l !== '' ? ` · ${l} мин` : ''}`;
      const cls = m ? (RESULT_CLASS[r] || 'hm-other') : 'hm-empty';
      const tag = pages.has(id) ? 'a' : 'span', href = pages.has(id) ? ` href="${esc(id)}.html"` : '';
      out += `<td><${tag} class="hm-cell ${cls}" data-hm-cell data-r="${esc(r)}" data-p="${esc(p)}" data-l="${esc(l)}"${href} title="${esc(title)}"></${tag}></td>`;
    }
    out += '</tr>';
  }
  return out + '</tbody></table>';
}
function kindBars(kinds) {
  const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return '<p class="panel-note">События не записаны.</p>';
  const max = entries[0][1];
  return entries.map(([k, n]) => `<div class="kind-bar"><span class="kn" style="color:${KIND[k] ? KIND[k].c : 'var(--muted)'}">${icon(EVENT_GLYPHS[k] || 'trace')}${esc(KIND[k] ? KIND[k].label : k)}</span><span class="bar-track"><i class="bar-fill" style="width:${(n / max * 100).toFixed(1)}%;background:${KIND[k] ? KIND[k].c : 'var(--start)'}"></i></span><span class="kv">${n}</span></div>`).join('');
}
function achievementsHtml(s) {
  const list = [
    ['Ветеран', s.n >= 25, 'trophy', `${s.n} матчей`],
    ['Ночной житель', s.nightYes != null && s.nightYes >= 10, 'moon', `${s.nightYes} ночей`],
    ['Долгожитель', s.lifeMax != null && s.lifeMax >= 1800, 'clock', `${fnum(s.lifeMax / 60, 0)} мин`],
    ['Без сбоев', s.crashes === 0 && s.n >= 3, 'shield', 'ни одного'],
    ['Серия', s.streakBest >= 5, 'step', `${s.streakBest} подряд`],
    ['Охотник', s.killsTotal != null && s.killsTotal >= 3, 'sword', `${s.killsTotal} мух`],
    ['Хроникёр', s.eventsTotal >= 500, 'trace', `${s.eventsTotal} событий`],
    ['Очки записаны', s.pointsN > 0, 'cube', `${s.pointsN} матчей`]
  ];
  const won = list.filter(x => x[1]);
  return `<div class="achievements">${won.length ? won.map(([name, , glyph, hint]) => `<span class="achievement" title="${esc(hint)}">${icon(glyph)}${esc(name)} <span class="muted">${esc(hint)}</span></span>`).join('') : '<span class="achievement muted-ach">Пока без достижений</span>'}</div>`;
}
function formStripHtml(s, pages) {
  return `<div class="form-strip">${s.form.map(m => {
    const color = resultColor(m.result), inner = `<i style="background:${color}"></i><b>${m.points == null ? '—' : fnum(m.points, 0)}</b> ${esc(shortId(m.world))}`;
    const title = `${m.world} · ${RESULT_NAMES[m.result] || m.result || 'нет данных'}${m.points == null ? '' : ` · ${m.points} оч.`}`;
    return pages.has(m.world) ? `<a class="form-chip" href="${esc(m.world)}.html" title="${esc(title)}">${inner}</a>` : `<span class="form-chip" title="${esc(title)}">${inner}</span>`;
  }).join('')}</div>`;
}
const LEADER_COLS = [
  { label: 'Бот', type: 'text', get: s => s.nick },
  { label: 'Матчей', type: 'num', get: s => s.n },
  { label: 'Очки / матч', type: 'num', get: s => rnd(s.pointsAvg, 2) },
  { label: 'Очки всего', type: 'num', get: s => rnd(s.pointsSum, 1) },
  { label: 'Жизнь ср., мин', type: 'num', get: s => s.lifeAvg == null ? null : rnd(s.lifeAvg / 60, 2) },
  { label: 'Первая ночь', type: 'num', get: s => rnd(s.nightRate, 3) },
  { label: 'Событий', type: 'num', get: s => s.eventsTotal },
  { label: 'Убийств мух', type: 'num', get: s => s.killsTotal },
  { label: 'Сбоев', type: 'num', get: s => s.crashes },
  { label: 'Серия', type: 'num', get: s => s.streakBest }
];
function botPayload(s) {
  return {
    nick: s.nick, file: s.file, group: s.group, modes: s.modes, n: s.n,
    pointsAvg: s.pointsAvg, pointsSum: s.pointsSum, pointsN: s.pointsN,
    lifeMin: s.lifeAvg == null ? null : rnd(s.lifeAvg / 60, 2), nightRate: s.nightRate,
    eventsTotal: s.eventsTotal, eventsAvg: s.eventsAvg, killsTotal: s.killsTotal,
    crashes: s.crashes, streakBest: s.streakBest
  };
}
function careerPayload(s, pages) {
  return s.matches.map(m => ({
    w: m.world, label: shortId(m.world),
    page: pages.has(m.world) ? `${m.world}.html` : '',
    p: m.points, l: m.life == null ? null : rnd(m.life / 60, 2), d: m.days, e: m.events,
    r: m.result, result: RESULT_NAMES[m.result] || m.result || 'Нет данных',
    seed: m.seed == null ? '' : String(m.seed), mode: m.mode, group: m.group,
    night: m.night, cause: m.cause
  }));
}
function botsHtml(stats, worlds) {
  const modes = [...new Set(stats.flatMap(s => s.modes))].sort();
  const headFirst = `<th data-col="0" data-type="text">Бот <span class="sort-mark"></span></th>`;
  const headers = LEADER_COLS.slice(1).map((c, i) => `<th data-col="${i + 1}" data-type="${c.type}" ${c.type === 'num' ? 'class="num"' : ''}>${esc(c.label)} <span class="sort-mark"></span></th>`).join('');
  const rows = stats.map((s, i) => {
    const attrs = LEADER_COLS.map((c, ci) => { const v = c.get(s); return ` data-c${ci}="${esc(v == null ? '' : v)}"`; }).join('');
    return `<tr data-bot-row data-order="${i}" data-nick="${esc(s.nick)}" data-group="${groupKey(s.group)}" data-modes="${esc(s.modes.join(' '))}" data-n="${s.n}" data-has-points="${s.pointsN ? 1 : 0}" data-points="${s.pointsAvg == null ? '' : rnd(s.pointsAvg, 2)}"${attrs}><td class="rank">${i + 1}</td><td><div class="bot-identity"><input type="checkbox" class="compare-check" data-compare="${esc(s.nick)}" aria-label="Сравнить ${esc(s.nick)}"><a class="bot-link" href="${esc(s.file)}">${avatar(s.nick)}<span>${esc(s.nick)}</span>${icon('arrow')}</a></div></td><td><span class="group-tag ${esc(s.group)}">${esc(groupText(s.group))}</span></td><td class="num">${s.n}</td><td class="num">${fnum(s.pointsAvg, 1)}</td><td class="num">${fnum(s.pointsSum, 1)}</td><td class="num">${fnum(s.lifeAvg == null ? null : s.lifeAvg / 60, 1)}</td><td class="num">${pctOf(s.nightRate)}</td><td class="num">${s.eventsTotal}</td><td class="num">${fnum(s.killsTotal, 0)}</td><td class="num">${s.crashes}</td><td class="num">${s.streakBest}</td><td>${sparkline(s.spark)}</td></tr>`;
  }).join('');
  const allKinds = {};
  for (const s of stats) for (const [k, n] of Object.entries(s.kinds)) allKinds[k] = (allKinds[k] || 0) + n;
  const toolbar = `<div class="toolbar leader-toolbar"><label class="search"><span class="search-mark" aria-hidden="true">${icon('search')}</span><span class="sr-only">Поиск бота</span><input type="search" data-bot-search placeholder="Найти бота…" autocomplete="off"></label><label class="mini-field">Группа<select data-bot-group><option value="">Все</option><option value="learn">Учатся</option><option value="control">Контроль</option><option value="mixed">Смешанная</option><option value="none">Без группы</option></select></label><label class="mini-field">Режим<select data-bot-mode><option value="">Все</option>${modes.map(m => `<option value="${esc(m)}">${esc(MODE_NAMES[m] || m)}</option>`).join('')}</select></label><label class="mini-field">Матчей от<input type="number" data-bot-min min="0" value="0"></label><label class="check-field"><input type="checkbox" data-bot-points-only> только с очками</label><button class="small-button" type="button" data-bot-clear>${icon('back')}Сбросить</button><button class="small-button" type="button" data-bot-csv>${icon('archive')}CSV</button></div>`;
  return shell('Карьеры ботов', `<section class="page-hero"><div><p class="eyebrow">${icon('fly')}Аналитика по всем запускам</p><h1>Карьеры ботов</h1><p class="intro">Каждая муха — отдельная история: все матчи, очки, выживание, события и сбои. Сортируйте, сравнивайте, смотрите теплокарту.</p></div><div class="hub-actions"><a class="button-link" href="index.html">Архив миров ${icon('arrow')}</a></div></section>
<details class="legend-details"><summary>Как считаем · важное про данные</summary><div class="legend"><span>${icon('cube')}всего из lives.jsonl</span><span>${icon('clock')}прочерк = данных нет, не ноль</span><span>${icon('signal')}сбой не равен смерти</span><span>${icon('moon')}первая ночь только по подтверждённым карточкам</span><span>${icon('trace')}очки есть не во всех эпохах</span></div></details>${hallHtml(stats)}
<div class="split-grid"><section class="mini-panel"><h2>${icon('shield')}Учатся против контроля</h2><p class="panel-note">Сводка по карточкам ботов, без пересчёта формулы очков.</p>${groupCompareHtml(stats)}</section><section class="mini-panel"><h2>${icon('trophy')}Распределение средних очков</h2><p class="panel-note">Клик по столбцу фильтрует таблицу ниже. Повторный клик снимает фильтр.</p>${histogramSvg(stats)}</section></div>
<section class="heatmap-wrap"><div class="heatmap-head"><h2>${icon('trace')}Теплокарта участия</h2><label class="mini-field">Раскраска<select data-heat-mode><option value="result">Исход</option><option value="points">Очки</option><option value="life">Жизнь</option></select></label></div><div class="heatmap-scroll">${heatmapHtml(stats, worlds)}</div><div class="hm-legend"><span><i class="hm-death"></i>смерть</span><span><i class="hm-crash"></i>сбой</span><span><i class="hm-disconnect"></i>отключение</span><span><i class="hm-timeout"></i>лимит времени</span><span><i class="hm-empty"></i>не участвовал / нет данных</span><span>${icon('archive')}столбцы — миры по порядку запуска, клетка ведёт на страницу мира</span></div></section>
<section class="compare-panel" data-compare-panel hidden><div class="compare-head"><h2>${icon('sword')}Сравнение ботов</h2><button class="small-button" type="button" data-bot-clear>${icon('back')}Сбросить фильтры</button></div><div data-compare-body></div><p class="compare-note" data-compare-hint>Отметьте 2–3 бота в таблице ниже.</p></section>
<div class="section-heading"><div><h2>${icon('fly')}Все боты</h2><p>Клик по заголовку сортирует · галочка добавляет к сравнению · тренд — очки последних матчей.</p></div><span class="section-count">${stats.length} ботов · ${stats.reduce((n, s) => n + s.n, 0)} матчей</span></div><section class="panel" aria-label="Таблица карьер">${toolbar}<div class="table-scroll"><table class="leader-table"><thead><tr><th>#</th>${headFirst}<th>Группа</th>${headers}<th>Тренд</th></tr></thead><tbody data-bot-rows>${rows}</tbody></table></div><div class="empty-filter" data-bot-empty hidden>Ничего не найдено. Измените фильтры.</div><div class="table-footer"><span data-bot-count role="status" aria-live="polite">Показано ${stats.length} из ${stats.length}</span><span><span class="kbd">/</span> поиск · <span class="kbd">Esc</span> сброс · CSV только видимые строки</span></div></section>
<div class="split-grid" style="margin-top:24px"><section class="mini-panel"><h2>${icon('trace')}Чего больше в хрониках</h2><p class="panel-note">Типы событий по всем карточкам ботов.</p>${kindBars(allKinds)}</section><section class="mini-panel"><h2>${icon('archive')}Что здесь можно</h2><p class="panel-note">Всё работает без сервера и внешних библиотек.</p><div class="legend" style="padding-top:0"><span>${icon('trophy')}клик по столбцу гистограммы — фильтр</span><span>${icon('shield')}2–3 галочки — сравнение</span><span>${icon('fly')}клик по портрету — карьера</span><span>${icon('clock')}переключатель раскраски теплокарты</span><span>${icon('archive')}экспорт видимых строк в CSV</span><span>${icon('moon')}светлая тема в шапке</span></div></section></div>`, 'bots', BOTS_SCRIPT).replace('<main>', `<script type="application/json" data-bots-data>${safeJson(stats.map(botPayload))}</script><main>`);
}
function botPageHtml(s, stats, worlds) {
  const pages = new Set(worlds.filter(w => w.serverOk !== false).map(w => w.id));
  const career = careerPayload(s, pages);
  const idx = stats.findIndex(x => x.nick === s.nick);
  const prev = stats[(idx - 1 + stats.length) % stats.length], next = stats[(idx + 1) % stats.length];
  const resultEntries = Object.entries(s.results).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const stack = resultEntries.map(([r, n]) => `<button type="button" class="stack-seg" data-result="${esc(r)}" style="width:${(n / s.n * 100).toFixed(1)}%;background:${resultColor(r)}" title="${esc(RESULT_NAMES[r] || r)} · ${n} из ${s.n}"></button>`).join('');
  const chips = resultEntries.map(([r, n]) => `<button type="button" class="chip" data-result="${esc(r)}"><i style="background:${resultColor(r)}"></i>${esc(RESULT_NAMES[r] || r || 'нет данных')} <b>${n}</b></button>`).join('');
  const MATCH_COLS = [
    ['Мир', 'text', m => m.world], ['Режим', 'text', m => MODE_NAMES[m.mode] || m.mode || '—'],
    ['Группа', 'text', m => m.group ? groupText(m.group) : '—'], ['Итог', 'text', m => RESULT_NAMES[m.result] || m.result || '—'],
    ['Очки', 'num', m => m.points == null ? null : rnd(m.points, 2)],
    ['Жизнь, мин', 'num', m => m.life == null ? null : rnd(m.life / 60, 2)],
    ['Игровых дней', 'num', m => m.days == null ? null : rnd(m.days, 2)],
    ['Первая ночь', 'text', m => m.night == null ? '—' : m.night ? 'да' : 'нет'],
    ['Событий', 'num', m => m.events], ['Причина', 'text', m => m.cause || '—']
  ];
  const mHeaders = MATCH_COLS.map(([label, type], i) => `<th data-mcol="${i}" data-type="${type}" ${type === 'num' ? 'class="num"' : ''}>${esc(label)} <span class="sort-mark"></span></th>`).join('');
  const mRows = s.matches.map((m, i) => {
    const attrs = MATCH_COLS.map(([, , get], ci) => { const v = get(m); return ` data-m${ci}="${esc(v == null ? '' : v)}"`; }).join('');
    const night = m.night == null ? '—' : m.night ? 'да' : 'нет';
    return `<tr data-match-row data-order="${i}" data-world="${esc(m.world)}" data-result="${esc(m.result)}" data-result-name="${esc(RESULT_NAMES[m.result] || m.result || '—')}" data-mode="${esc(MODE_NAMES[m.mode] || m.mode || '—')}" data-group="${esc(m.group ? groupText(m.group) : '—')}" data-points="${m.points == null ? '' : rnd(m.points, 2)}" data-life="${m.life == null ? '' : rnd(m.life / 60, 2)}" data-days="${m.days == null ? '' : rnd(m.days, 2)}" data-night="${night}" data-events="${m.events}" data-cause="${esc(m.cause)}" data-search="${esc(`${m.world} ${m.seed == null ? '' : m.seed} ${m.cause} ${m.result} ${m.mode}`)}"${attrs}><td>${pages.has(m.world) ? `<a class="world-link mono" href="${esc(m.world)}.html">${esc(m.world)}</a>` : `<span class="mono">${esc(m.world)}</span>`}</td><td class="muted-cell">${esc(MODE_NAMES[m.mode] || m.mode || '—')}</td><td><span class="group-tag ${esc(m.group)}">${esc(m.group ? groupText(m.group) : '—')}</span></td><td>${badge(RESULT_NAMES[m.result] || m.result || 'Нет данных', RESULT_TONE[m.result] || '', m.result === 'crash' || m.result === 'disconnect' ? 'signal' : m.result === 'death' ? 'skull' : 'clock')}</td><td class="num">${fnum(m.points, 1)}</td><td class="num">${fnum(m.life == null ? null : m.life / 60, 1)}</td><td class="num">${fnum(m.days, 1)}</td><td>${night}</td><td class="num">${m.events}</td><td class="muted-cell">${esc(m.cause || '—')}</td></tr>`;
  }).join('');
  const page = shell(`Карьера ${s.nick}`, `<a class="breadcrumb" href="bots.html">${icon('back')}все боты</a><section class="bot-hero">${avatar(s.nick)}<div><p class="eyebrow">Карточка бота</p><h1 class="mono">${esc(s.nick)}</h1><div class="hero-tags"><span class="group-tag ${esc(s.group)}">${esc(groupText(s.group))}</span>${s.modes.map(m => `<span class="group-tag">${esc(MODE_NAMES[m] || m)}</span>`).join('')}${badge(`${s.n} матчей`, '', 'cube')}</div></div><div class="hero-side">первый мир<b class="mono">${esc(shortId(s.first))}</b>последний мир<b class="mono">${esc(shortId(s.last))}</b></div></section>
<div class="kpi-grid">${metric('Матчей', s.n, 'все записанные запуски', '', 'cube')}${metric('Очки всего', fnum(s.pointsSum, 1), `из ${s.pointsN} матчей с очками`, '', 'trophy')}${metric('Очки / матч', fnum(s.pointsAvg, 1), s.pointsN ? 'среднее по матчам с очками' : 'очки не записывались', '', 'step')}${metric('Прожил всего', fnum(s.lifeSum == null ? null : s.lifeSum / 60, 0) + (s.lifeSum == null ? '' : ' мин'), `медиана ${fnum(s.medianLife == null ? null : s.medianLife / 60, 1)} мин`, '', 'clock')}${metric('Первая ночь', pctOf(s.nightRate), `${s.nightYes == null ? '—' : s.nightYes} из ${s.nightN} подтверждённых`, '', 'moon')}${metric('Сбои / смерти', `${s.crashes} / ${s.deaths}`, 'сбой не равен смерти', s.crashes ? 'warn' : '', 'signal')}</div>
<section class="chart-card"><div class="chart-head"><h2>${icon('trace')}Карьера по матчам</h2><div class="metric-tabs"><button type="button" data-metric="p" aria-pressed="true">Очки</button><button type="button" data-metric="l" aria-pressed="false">Жизнь</button><button type="button" data-metric="d" aria-pressed="false">Игровые дни</button><button type="button" data-metric="e" aria-pressed="false">События</button></div></div><div class="chart-box" data-chart-box><noscript><div class="chart-empty">График требует JavaScript, все значения есть в таблице ниже.</div></noscript></div><div class="chart-tip" data-chart-tip hidden></div><p class="foot-hint">Точка — матч. Наведение показывает детали, клик открывает мир. Разрывы линии — матчи без данных.</p></section>
<div class="split-grid"><section class="mini-panel"><h2>${icon('shield')}Исходы матчей</h2><p class="panel-note">Клик по полосе или чипу фильтрует таблицу матчей.</p><div class="stack-bar">${stack}</div><div class="chip-row">${chips}</div></section><section class="mini-panel"><h2>${icon('trace')}Профиль событий</h2><p class="panel-note">Что бот делал чаще всего за всю карьеру.</p>${kindBars(s.kinds)}</section></div>
<h2 class="section-heading" style="display:block;margin-top:24px">${icon('trophy')}Достижения</h2>${achievementsHtml(s)}<h2 class="section-heading" style="display:block">${icon('clock')}Форма · последние ${s.form.length} матчей</h2>${formStripHtml(s, pages)}
<div class="section-heading"><div><h2>${icon('archive')}Все матчи</h2><p>Клик по заголовку сортирует · поиск по миру, сиду и причине.</p></div><span class="section-count">${s.n} матчей</span></div><section class="panel" aria-label="Матчи бота"><div class="toolbar"><label class="search"><span class="search-mark" aria-hidden="true">${icon('search')}</span><span class="sr-only">Поиск матча</span><input type="search" data-match-search placeholder="Мир, сид, причина…" autocomplete="off"></label><button class="small-button" type="button" data-match-csv>${icon('archive')}CSV матчей</button></div><div class="table-scroll"><table class="match-table"><thead><tr>${mHeaders}</tr></thead><tbody data-match-rows>${mRows}</tbody></table></div><div class="empty-filter" data-match-empty hidden>Ничего не найдено. Измените поиск или фильтр.</div><div class="table-footer"><span data-match-count role="status" aria-live="polite">Показано ${s.n} из ${s.n}</span><span><span class="kbd">/</span> поиск · <span class="kbd">Esc</span> сброс</span></div></section>
<div class="bot-nav"><a href="${esc(prev.file)}">${icon('back')}<span>${esc(prev.nick)}</span></a><a class="small-button" href="bots.html?compare=${encodeURIComponent(s.nick)}">${icon('sword')}Сравнить с другими</a><a href="${esc(next.file)}"><span>${esc(next.nick)}</span>${icon('arrow')}</a></div>`, 'bots', BOT_SCRIPT);
  return page.replace('<main>', `<script type="application/json" data-career-data>${safeJson(career)}</script><main>`);
}
function writeBots(dataDir, worlds, lives) {
  const dir = path.join(dataDir, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  const stats = botStats(lives, worlds);
  fs.writeFileSync(path.join(dir, 'bots.html'), botsHtml(stats, worlds));
  for (const s of stats) fs.writeFileSync(path.join(dir, s.file), botPageHtml(s, stats, worlds));
  return stats.length;
}

// Записать ленту мира и пересобрать оглавление. worlds — все строки worlds.jsonl.
function write(dataDir, w, cards, worlds) {
  const dir = path.join(dataDir, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  const lives = readJsonl(path.join(dataDir, 'lives.jsonl'));
  if (w && cards) fs.writeFileSync(path.join(dir, `${w.id}.html`), worldHtml(w, cards));
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml(worlds || [], lives));
  writeBots(dataDir, worlds || [], lives);
  return path.join(dir, 'index.html');
}
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } }
function rebuild(dataDir) {
  const worlds = readJsonl(path.join(dataDir, 'worlds.jsonl'));
  const lives = readJsonl(path.join(dataDir, 'lives.jsonl'));
  const dir = path.join(dataDir, 'timeline');
  fs.mkdirSync(dir, { recursive: true });
  for (const w of worlds) if (w.serverOk !== false) fs.writeFileSync(path.join(dir, `${w.id}.html`), worldHtml(w, lives.filter(c => c.world === w.id)));
  return write(dataDir, null, null, worlds);
}
module.exports = { svgFor, worldHtml, indexHtml, write, rebuild, dayLabel, botStats, botFile, botsHtml, botPageHtml, writeBots };
if (require.main === module) console.log('готово:', rebuild(process.argv[2] || path.join(__dirname, 'data')));
