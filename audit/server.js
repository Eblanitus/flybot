// «Аудит»: локальная страница, где видно, что делает каждая роль мухи (тело, автопилот и рефлексы, мозг, инженер, учитель, сторож),
// и можно написать мозгу. Голый Node (http, fs), без npm-зависимостей. Порт 3300, только 127.0.0.1.
// Файлы мухи только читает. Три записи: POST /owner_msg в тело (через его HTTP-API), вкладка «Модели» — файл data/models.json (модель мозга, учителя, инженера)
// и кнопка «Разрешить» у запроса на правку ядра — файл data/core_requests_state.json (lib/core_requests.js; сам brain/core_requests.md не меняется).
// Все запросы к телу и исполнителю идут с заголовком X-Observer: 1 — тело не считает их признаком «мозг жив».
// Запуск: node audit/server.js   (или audit.cmd в корне проекта)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const modelsCfg = require('../models_config'); // data/models.json: какая модель у какой роли (его же читают night.cmd и brain_guard.ps1)
const { checkOwnerText } = require('../lib/audit_api');
const bbFiles = require('../lib/blackbox_files'); // файлы чёрного ящика (без зависимостей): запасной путь, когда тело не отвечает
const ledgerSummary = require('../lib/ledger_summary');
const showcaseLib = require('../lib/showcase');
const coreReq = require('../lib/core_requests'); // запросы на правку ядра: список с состоянием и «Разрешить» (только data/core_requests_state.json) // витрина навыков (без зависимостей): запасной путь, когда тело старое или не отвечает

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
  port: +process.env.AUDIT_PORT || 3300,
  dataDir: path.join(ROOT, 'data'),
  brainDir: path.join(ROOT, 'brain'),
  bodyUrl: process.env.AUDIT_BODY_URL || 'http://127.0.0.1:3199',
  runnerUrl: process.env.AUDIT_RUNNER_URL || 'http://127.0.0.1:3200',
  neighborUrl: process.env.AUDIT_NEIGHBOR_URL || 'http://127.0.0.1:3099', // Ассасин (бот Хермеса): его витрина навыков
  root: ROOT,
  page: path.join(__dirname, 'index.html')
};

// ======================= чтение файлов =======================

// Хвост файла по байтам: не больше maxBytes с конца. Первая (возможно оборванная) строка отбрасывается.
function readTail(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, start + got); if (n <= 0) break; got += n; }
    return { buf: buf.subarray(0, got), size: st.size, mtimeMs: st.mtimeMs, partial: start > 0 };
  } catch (e) {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

// utf-8, а если не получается (журналы, написанные PowerShell) — windows-1251
function decodeBuf(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
  try { return new TextDecoder('windows-1251').decode(buf); } catch (e) { return buf.toString('latin1'); }
}

// -> { lines, size, mtimeMs } | null. Для обрезанного с начала хвоста первая строка выкидывается (она оборвана).
function tailLines(file, maxBytes) {
  const t = readTail(file, maxBytes);
  if (!t) return null;
  let buf = t.buf;
  if (t.partial) { const i = buf.indexOf(10); buf = i < 0 ? Buffer.alloc(0) : buf.subarray(i + 1); }
  const lines = decodeBuf(buf).split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, size: t.size, mtimeMs: t.mtimeMs };
}

// Кэш по (файл, размер, mtime): разбор не повторяется, пока файл не менялся
const cache = new Map();
function cached(key, stamp, fn) {
  const c = cache.get(key);
  if (c && c.stamp === stamp) return c.value;
  const value = fn();
  cache.set(key, { stamp, value });
  return value;
}
function statStamp(file) {
  try { const s = fs.statSync(file); return s.size + ':' + s.mtimeMs; } catch (e) { return 'none'; }
}

// ======================= время =======================

// В events.log время — только «ЧЧ:ММ:СС» по UTC (new Date().toISOString().slice(11,19)), без даты.
// Восстанавливаем полную метку: идём с конца, привязав последнюю строку к времени изменения файла (endMs);
// если время «больше» следующего — значит это было накануне. utc=false — время местное (журналы PowerShell).
function resolveTimes(secs, endMs, utc) {
  const out = new Array(secs.length);
  let cur = endMs;
  for (let i = secs.length - 1; i >= 0; i--) {
    if (secs[i] == null) { out[i] = null; continue; }
    const d = new Date(cur);
    const day0 = utc ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let cand = day0 + secs[i] * 1000;
    while (cand > cur + 120000) cand -= 86400000;
    out[i] = cand;
    cur = cand;
  }
  return out;
}
function hmsToSec(s) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

// ======================= события тела (data/events.log) =======================

const EVENTS_TAIL = 600 * 1024;

function parseEventLines(lines, mtimeMs) {
  const evs = [];
  for (const l of lines) {
    if (!l || l[0] !== '{') continue;
    try { const e = JSON.parse(l); if (e && typeof e === 'object' && e.type) evs.push(e); } catch (e) {}
  }
  const ts = resolveTimes(evs.map(e => hmsToSec(e.t)), mtimeMs, true);
  evs.forEach((e, i) => { e.ts = ts[i]; });
  return evs;
}

function loadEvents(cfg) {
  const file = path.join(cfg.dataDir, 'events.log');
  return cached('events:' + file, statStamp(file), () => {
    const t = tailLines(file, EVENTS_TAIL);
    if (!t) return { events: [], mtimeMs: 0 };
    return { events: parseEventLines(t.lines, t.mtimeMs), mtimeMs: t.mtimeMs };
  });
}

const TASK_RU = {
  dig_at: 'копает блок', place_at: 'ставит блок', craft: 'крафтит', collect: 'добывает', equip_best: 'надевает лучшее',
  chest_take: 'берёт из сундука', chest_store: 'кладёт в сундук', shelter: 'прячется в укрытие', wait_night: 'пережидает ночь',
  pickup: 'подбирает', explore: 'исследует', recover: 'забирает вещи со смерти', smelt: 'плавит', hunt: 'охотится', sleep: 'спит',
  escape: 'убегает', look_at: 'смотрит', fight: 'дерётся', find: 'ищет', eat: 'ест', go_home: 'идёт домой', waypoints: 'метки',
  pillar_up: 'столбом вверх', mark: 'ставит метку', activate: 'нажимает', use_item: 'использует предмет', equip_item: 'берёт предмет',
  build_blueprint: 'строит по чертежу', goto: 'идёт', night_mine: 'ночная копка', day_routine: 'дневная работа', stop: 'стоп'
};
const taskRu = n => TASK_RU[n] || n;

function shortParams(p) {
  if (!p || typeof p !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(p)) {
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 40) s = s.slice(0, 40) + '…';
    parts.push(k + '=' + s);
    if (parts.length >= 6) break;
  }
  return parts.join(' ');
}

const DANGER_RU = {
  attacked: e => `бьют: ${e.by || '?'}${e.hp != null ? ', HP ' + e.hp : ''}`,
  low_hp: e => `мало здоровья: ${e.hp}/20${e.lastDamage ? ' (' + e.lastDamage + ')' : ''}`,
  hunger: e => 'голод, есть нечего',
  night_soon: e => `скоро ночь (через ${e.nightIn} с)`,
  enemy_player: e => `рядом игрок-враг${e.name ? ' ' + e.name : ''}`
};

// События, которые решили автопилот или рефлексы. -> [{ts,id,who,text,level}]
function reflexFeed(events, limit) {
  const srcOf = new Map(); // taskId -> источник (по порядку: id могут повторяться после перезапуска тела — берём последний)
  const out = [];
  for (const e of events) {
    let who = null, text = null, level = '';
    if (e.type === 'task_started') {
      srcOf.set(e.taskId, e.source || 'brain');
      if (e.source === 'autopilot' || e.source === 'reflex') {
        who = e.source === 'autopilot' ? 'автопилот' : 'рефлекс';
        text = `начал: ${taskRu(e.name)}`; const pp = shortParams(e.params); if (pp) text += ` (${pp})`;
      }
    } else if (e.type === 'task_done' || e.type === 'task_failed' || e.type === 'task_aborted') {
      const s = srcOf.get(e.taskId);
      if (s === 'autopilot' || s === 'reflex') {
        who = s === 'autopilot' ? 'автопилот' : 'рефлекс';
        if (e.type === 'task_done') { text = `готово: ${taskRu(e.name)}`; level = 'ok'; }
        else if (e.type === 'task_failed') { text = `не вышло: ${taskRu(e.name)} — ${String(e.reason || '').slice(0, 140)}`; level = 'warn'; }
        else { text = `прервано: ${taskRu(e.name)} — ${String(e.reason || '').slice(0, 100)}`; level = 'warn'; }
      }
    } else if (e.type === 'info' && typeof e.msg === 'string') {
      if (e.autopilot) { who = 'автопилот'; text = e.msg.replace(/^автопилот:\s*/, ''); if (/провал/.test(text)) level = 'warn'; }
      else if (/^рефлекс:/.test(e.msg)) { who = 'рефлекс'; text = e.msg.replace(/^рефлекс:\s*/, ''); }
      else if (/^(судья|надел броню|съел)/.test(e.msg)) { who = 'тело'; text = e.msg; }
    } else if (e.type === 'danger' && DANGER_RU[e.kind]) {
      who = 'угроза'; text = DANGER_RU[e.kind](e); level = e.kind === 'night_soon' ? '' : 'warn';
    } else if (e.type === 'death') {
      who = 'тело'; text = `СМЕРТЬ №${e.deaths || '?'}: ${e.cause || '?'}${e.at ? ' в ' + e.at.join(' ') : ''}`; level = 'bad';
    } else if (e.type === 'spawn') {
      who = 'тело'; text = e.msg || 'появилась в мире';
    }
    if (text) out.push({ ts: e.ts, id: e.id, who, text, level });
  }
  return out.slice(-limit).reverse();
}

// Команды мозга телу: task_started с source=brain + чем кончилось. -> [{ts,id,name,label,params,status,note}]
function brainCommands(events, limit) {
  const list = []; const byId = new Map();
  for (const e of events) {
    if (e.type === 'task_started') {
      const it = { ts: e.ts, id: e.taskId, name: e.name, label: taskRu(e.name), params: shortParams(e.params), status: 'идёт', level: '', note: '', src: e.source || 'brain' };
      byId.set(e.taskId, it);
      if (it.src === 'brain') list.push(it);
    } else if (e.type === 'task_done' || e.type === 'task_failed' || e.type === 'task_aborted') {
      const it = byId.get(e.taskId);
      if (!it) continue;
      if (e.type === 'task_done') { it.status = 'готово'; it.level = 'ok'; }
      else if (e.type === 'task_failed') { it.status = 'не вышло'; it.level = 'warn'; it.note = String(e.reason || '').slice(0, 160); }
      else { it.status = 'прервано'; it.level = 'warn'; it.note = String(e.reason || '').slice(0, 100); }
    }
  }
  return list.slice(-limit).reverse();
}

// Чат: игровой чат (type chat), реплики мозга в игру (info.say — их тело пишет само) и сообщения хозяина из программы.
const OWNER_NAMES = new Set(['eblanitus228']);
const BRAIN_NAMES = new Set(['flytest', 'flybot_01']);   // ник тела: старый и новый
function chatFeed(events, limit, withSystem) {
  const out = [];
  for (const e of events) {
    if (e.type === 'owner_msg') out.push({ ts: e.ts, role: 'owner', app: true, who: 'Хозяин (из программы)', text: String(e.text || '') });
    else if (e.type === 'info' && e.say != null) out.push({ ts: e.ts, role: 'brain', who: 'Мозг (FlyBot_01)', text: String(e.say) });
    else if (e.type === 'chat') {
      const kind = e.kind || 'chat';
      if (kind === 'chat' && e.from) {
        const low = String(e.from).toLowerCase();
        const role = OWNER_NAMES.has(low) ? 'owner' : (BRAIN_NAMES.has(low) ? 'brain' : 'player');
        out.push({ ts: e.ts, role, who: role === 'brain' ? 'Мозг (FlyBot_01)' : e.from, text: String(e.text || '') });
      } else if (withSystem && kind === 'system') out.push({ ts: e.ts, role: 'system', who: 'сервер', text: String(e.text || '') });
    }
  }
  return out.slice(-limit);
}

// ======================= журнал мозга (data/night.log, data/night-*.log) =======================

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = s => String(s).replace(ANSI, '');

function parseCurl(line) {
  const m = /"(https?:\/\/[^"]+)"/.exec(line) || /(https?:\/\/\S+)/.exec(line);
  if (!m) return null;
  let u; try { u = new URL(m[1]); } catch (e) { return null; }
  const target = u.port === '3199' ? 'тело' : u.port === '3200' ? 'исполнитель' : u.host;
  const args = []; for (const [k, v] of u.searchParams) args.push([k, v]);
  const get = k => { const a = args.find(x => x[0] === k); return a ? a[1] : null; };
  let title = u.pathname;
  if (u.pathname === '/do') title = get('action') || '/do';
  else if (u.pathname === '/go') title = 'запуск навыка ' + (get('name') || '?');
  else title = u.pathname.replace(/^\//, '');
  const rest = args.filter(([k]) => !(k === 'wait' || (k === 'action' && u.pathname === '/do') || (k === 'name' && u.pathname === '/go')))
    .map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + '…' : v}`).join(' ');
  const body = /-d\s+'([^']*)'/.exec(line) || /-d\s+"((?:\\"|[^"])*)"/.exec(line);
  const isPost = /-X\s+POST/i.test(line) || !!body;
  return { target, port: u.port, method: isPost ? 'POST' : 'GET', path: u.pathname, title, args: rest + (body ? ' ' + body[1].replace(/\\"/g, '"').slice(0, 120) : ''), say: u.pathname === '/do' && get('action') === 'chat' ? get('text') : null };
}

// Чистим журнал opencode: оставляем слова модели и вызовы curl; прочие инструменты — коротко; ответы и диффы — прячем.
// -> [{k:'start'|'model'|'text'|'cmd'|'out'|'tool'|'err', ...}]
function parseNightLog(rawLines) {
  const out = [];
  let mode = 'normal';
  let firstOut = false;
  let day = null, ts = null; // день — из последнего «brain start», время — из метки «[ЧЧ:ММ:СС] » (tools/tstamp.js)
  let lineTs = null; // время этой строки; у строк без метки (старые журналы) времени нет
  const push = e => { if (lineTs != null) e.ts = lineTs; out.push(e); };
  for (let raw of rawLines) {
    let line = stripAnsi(raw).replace(/\r/g, '');
    const st = /^\[(\d\d):(\d\d):(\d\d)\] /.exec(line);
    lineTs = null;
    if (st) {
      line = line.slice(st[0].length);
      if (day != null) { let t = day + ((+st[1] * 60 + +st[2]) * 60 + +st[3]) * 1000; if (ts != null && t < ts - 3600e3) { day += 86400e3; t += 86400e3; } ts = lineTs = t; }
    }
    if (line === '') { mode = 'normal'; continue; }
    let m;
    if ((m = /^=====\s*\[(\d\d)\.(\d\d)\.(\d{4})\s+(\d{1,2}):(\d\d):(\d\d)[,.]?\d*\]\s*(.*?)\s*=====\s*$/.exec(line))) {
      ts = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime(); day = new Date(+m[3], +m[2] - 1, +m[1]).getTime();
      out.push({ k: 'start', ts, text: m[7] || 'brain start' });
      mode = 'normal'; continue;
    }
    if (/^>\s*build\b/.test(line)) { push({ k: 'model', text: line.replace(/^>\s*/, '') }); mode = 'skip'; continue; }
    if (line.startsWith('$ ')) {
      const c = parseCurl(line);
      push(c ? { k: 'cmd', ...c, raw: line.slice(2, 300) } : { k: 'cmd', target: 'оболочка', title: line.slice(2, 160), args: '', raw: line.slice(2, 300) });
      mode = 'out'; firstOut = true; continue;
    }
    if ('→←✱✗↗'.includes(line[0]) && line[1] === ' ') {
      const sym = line[0];
      const body = line.slice(2);
      if (sym === '✗') { mode = 'skip'; continue; }
      push({ k: 'tool', text: body.slice(0, 200), write: sym === '←' });
      mode = sym === '←' ? 'skip' : 'normal'; continue;
    }
    if (mode === 'out') {
      if (firstOut) { firstOut = false; push({ k: 'out', text: line.slice(0, 220) }); }
      continue;
    }
    if (mode === 'skip') continue;
    if (/^Error:\s*The user has specified a rule/.test(line)) continue;
    if (/^Error:/.test(line)) { push({ k: 'err', text: line.slice(0, 240) }); continue; }
    if (/^Wrote file successfully/.test(line) || !line.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.k === 'text' && last.joined < 40) { last.text += '\n' + line; last.joined++; }
    else push({ k: 'text', text: line, joined: 1 });
  }
  for (const o of out) if (o.k === 'text') { delete o.joined; if (o.text.length > 1500) o.text = o.text.slice(0, 1500) + '…'; }
  return out;
}

// Мозг опрашивает тело одним и тем же /wait десятки раз подряд — склеиваем такие строки в одну («× N»), ответы к ним прячем
const POLL_TITLES = new Set(['wait', 'log', 'events', 'snapshot', 'health', 'task']);
function collapsePolls(entries) {
  const out = [];
  for (const e of entries) {
    if (e.k === 'cmd' && POLL_TITLES.has(e.title)) {
      let i = out.length - 1;
      while (i >= 0 && out[i].k === 'out') i--; // ответы тела между одинаковыми опросами не нужны
      const last = out[i];
      if (last && last.k === 'cmd' && last.title === e.title && last.target === e.target) {
        out.length = i + 1; last.n = (last.n || 1) + 1; last.args = e.args; if (e.ts) last.ts = e.ts; continue;
      }
    }
    out.push(e.k === 'cmd' ? { ...e } : e);
  }
  return out;
}

// Новые сверху, но ответ тела остаётся под своей командой
function newestFirst(entries) {
  const r = entries.slice().reverse();
  for (let i = 0; i + 1 < r.length; i++) if (r[i].k === 'out' && r[i + 1].k === 'cmd') { const t = r[i]; r[i] = r[i + 1]; r[i + 1] = t; i++; }
  return r;
}

function latestNightLog(dataDir) {
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dataDir); } catch (e) { return null; }
  for (const n of names) {
    if (!/^night(-.+)?\.log$/.test(n)) continue;
    let st; try { st = fs.statSync(path.join(dataDir, n)); } catch (e) { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { name: n, file: path.join(dataDir, n), mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

const NIGHT_TAIL = 400 * 1024;
function loadBrainLog(cfg) {
  const nl = latestNightLog(cfg.dataDir);
  if (!nl) return { file: null, entries: [] };
  return cached('night:' + nl.file, nl.size + ':' + nl.mtimeMs, () => {
    const t = tailLines(nl.file, NIGHT_TAIL);
    const lines = t ? t.lines.slice() : [];
    // оборванный с начала хвост: пропускаем до первой пустой строки, чтобы не принять кусок диффа за слова модели
    if (t && t.size > NIGHT_TAIL) { const i = lines.findIndex(l => stripAnsi(l).replace(/\r/g, '') === ''); if (i > 0) lines.splice(0, i); }
    return { file: nl.name, mtimeMs: nl.mtimeMs, size: nl.size, entries: parseNightLog(lines) };
  });
}

// Все «brain start» во всех night-логах (петля перезапускала мозг). Файлы читаем кусками, с запоминанием, докуда дочитали.
const startScan = new Map();
function scanBrainStarts(dataDir) {
  const res = [];
  let names = []; try { names = fs.readdirSync(dataDir); } catch (e) { return res; }
  for (const n of names) {
    if (!/^night(-.+)?\.log$/.test(n)) continue;
    const file = path.join(dataDir, n);
    let st; try { st = fs.statSync(file); } catch (e) { continue; }
    let sc = startScan.get(file);
    if (!sc || st.size < sc.pos) sc = { pos: 0, items: [] };
    if (st.size > sc.pos) {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const CH = 1024 * 1024, OV = 200;
        let pos = Math.max(0, sc.pos - OV);
        const seen = new Set(sc.items.map(i => i.ts));
        while (pos < st.size) {
          const len = Math.min(CH, st.size - pos);
          const buf = Buffer.alloc(len); const got = fs.readSync(fd, buf, 0, len, pos);
          if (got <= 0) break;
          const text = stripAnsi(buf.subarray(0, got).toString('latin1'));
          const re = /=====\s*\[(\d\d)\.(\d\d)\.(\d{4})\s+(\d{1,2}):(\d\d):(\d\d)[,.]?\d*\]\s*brain start\s*=====/g;
          let m;
          while ((m = re.exec(text))) {
            const ts = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
            if (!seen.has(ts)) { seen.add(ts); sc.items.push({ ts, file: n }); }
          }
          pos += got >= len && pos + got < st.size ? Math.max(1, got - OV) : got;
        }
      } catch (e) {} finally { if (fd != null) { try { fs.closeSync(fd); } catch (e) {} } }
      sc.pos = st.size;
    }
    startScan.set(file, sc);
    res.push(...sc.items);
  }
  return res.sort((a, b) => b.ts - a.ts);
}

// ======================= блокнот мозга =======================

function parseNotes(text) {
  const sections = {};
  let cur = null;
  for (const l of String(text).split(/\r?\n/)) {
    const m = /^##\s+(.*)$/.exec(l);
    if (m) { cur = m[1].trim(); sections[cur] = []; continue; }
    if (cur) sections[cur].push(l);
  }
  const get = re => { const k = Object.keys(sections).find(k => re.test(k)); return k ? sections[k].join('\n').trim() : ''; };
  return { goal: get(/^Текущая цель/), project: get(/^Проект/), ownerNote: get(/^Указание хозяина/), state: get(/^Состояние проекта/), sections: Object.keys(sections) };
}
function loadNotes(cfg) {
  const file = path.join(cfg.brainDir, 'notes.md');
  return cached('notes:' + file, statStamp(file), () => {
    try { const st = fs.statSync(file); return { ...parseNotes(fs.readFileSync(file, 'utf8')), mtimeMs: st.mtimeMs }; } catch (e) { return { goal: '', error: 'нет brain/notes.md' }; }
  });
}

// ======================= инженер =======================

function engineerList(cfg) {
  const dir = path.join(cfg.brainDir, 'skill_requests');
  let files = []; try { files = fs.readdirSync(dir); } catch (e) { return []; }
  const names = new Set();
  for (const f of files) {
    let m;
    if ((m = /^(.+)\.done\.md$/.exec(f))) names.add(m[1]);
    else if ((m = /^(.+)\.working$/.exec(f))) names.add(m[1]);
    else if ((m = /^(.+)\.md$/.exec(f))) names.add(m[1]);
  }
  const mt = f => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return null; } };
  const items = [];
  for (const name of names) {
    const req = mt(name + '.md'), done = mt(name + '.done.md'), work = mt(name + '.working');
    let status, ts, verdict = '';
    if (work != null) { status = 'working'; ts = work; }
    else if (done != null && (req == null || req <= done + 1000)) {
      ts = done;
      let first = ''; try { first = fs.readFileSync(path.join(dir, name + '.done.md'), 'utf8').split(/\r?\n/).find(l => l.trim()) || ''; } catch (e) {}
      verdict = first.replace(/^#+\s*/, '').slice(0, 160);
      status = /не\s*готов|не\s*удал|провал|ошибк|failed|не\s*получил|отказ/i.test(first) ? 'notdone' : 'done';
    } else { status = 'waiting'; ts = req != null ? req : done; }
    let title = ''; try { title = (fs.readFileSync(path.join(dir, name + '.md'), 'utf8').split(/\r?\n/).find(l => /^#\s/.test(l)) || '').replace(/^#\s*/, '').slice(0, 200); } catch (e) {}
    items.push({ name, status, ts, reqTs: req, doneTs: done, workTs: work, title, verdict });
  }
  return items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
const STATUS_RU = { waiting: 'ждёт', working: 'в работе', done: 'готово', notdone: 'не готово' };

function engineerDetail(cfg, name) {
  if (!/^[\w.-]+$/.test(name || '')) return { ok: false, error: 'плохое имя заявки' };
  const dir = path.join(cfg.brainDir, 'skill_requests');
  const rd = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 20000); } catch (e) { return null; } };
  const reqText = rd(name + '.md'), doneText = rd(name + '.done.md');
  if (reqText == null && doneText == null) return { ok: false, error: 'нет такой заявки' };
  let log = [];
  const lf = path.join(cfg.dataDir, 'engineer-' + name + '.log');
  const t = tailLines(lf, 120 * 1024);
  if (t) { const lines = t.lines.slice(); if (t.size > 120 * 1024) { const i = lines.findIndex(l => stripAnsi(l).replace(/\r/g, '') === ''); if (i > 0) lines.splice(0, i); } log = parseNightLog(lines).filter(e => e.k !== 'out').slice(-80).reverse(); }
  return { ok: true, name, request: reqText, answer: doneText, log, logMtime: t ? t.mtimeMs : null };
}

// ======================= учитель =======================
// Только диск: очередь data/teacher_queue.json, отчёты data/teacher/*.md, журнал уроков brain/lessons.json, учебник brain/lessons.md.
// Тело для этого не нужно — работает и со старым телом.
const TEACH_TYPE_RU = { death: 'смерть', near: 'почти-смерть', owner: 'сообщение хозяина', stuck: 'застряла', fail: 'провал', day: 'итог дня', neighbor: 'новое у соседа', migrate: 'разовая: перенос правил' };
const TEACH_STATUS_RU = { pending: 'ждёт', working: 'разбирает', done: 'разобран', failed: 'не вышло', dropped: 'выброшен (очередь полна)' };
const REPORT_RE = /^[\w.-]+\.md$/;
function readText(file, max) { try { return fs.readFileSync(file, 'utf8').slice(0, max || 60000); } catch (e) { return null; } }
function loadTeacher(cfg) {
  const qf = path.join(cfg.dataDir, 'teacher_queue.json');
  let q = null; try { q = JSON.parse(fs.readFileSync(qf, 'utf8')); } catch (e) {}
  const cases = q && Array.isArray(q.cases) ? q.cases.slice().reverse().slice(0, 60).map(c => ({
    id: c.id, type: c.type, typeRu: TEACH_TYPE_RU[c.type] || c.type, status: c.status, statusRu: TEACH_STATUS_RU[c.status] || c.status,
    firstAt: c.firstAt, lastAt: c.lastAt || c.firstAt, startedAt: c.startedAt || null, finishedAt: c.finishedAt || null, result: c.result || null,
    report: c.report || null, signals: (c.items || []).slice(0, 12).map(i => ({ kind: i.kind, text: i.text, ref: i.ref, by: i.by || null })), more: (c.items || []).length > 12 ? (c.items.length - 12 + (c.more || 0)) : (c.more || 0)
  })) : [];
  const rdir = path.join(cfg.dataDir, 'teacher');
  let names = []; try { names = fs.readdirSync(rdir).filter(n => REPORT_RE.test(n)); } catch (e) {}
  const reports = names.map(n => {
    let st = null; try { st = fs.statSync(path.join(rdir, n)); } catch (e) {}
    const text = readText(path.join(rdir, n), 4000) || '';
    const title = (text.split(/\r?\n/).find(l => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 200);
    const verdict = ((/^\s*Вердикт:\s*(.*)$/m.exec(text) || [])[1] || '').slice(0, 200);
    return { name: n, ts: st ? st.mtimeMs : null, title, verdict };
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 80);
  let lessons = null, lessonsError = null;
  const lj = readText(path.join(cfg.brainDir, 'lessons.json'), 400000);
  if (lj != null) { try { const o = JSON.parse(lj); lessons = Array.isArray(o) ? o : Array.isArray(o.lessons) ? o.lessons : []; } catch (e) { lessonsError = 'brain/lessons.json не читается: ' + e.message; } }
  const lmFile = path.join(cfg.brainDir, 'lessons.md');
  let lmMtime = null; try { lmMtime = fs.statSync(lmFile).mtimeMs; } catch (e) {}
  const book = readText(lmFile, 30000);
  const core = readText(path.join(cfg.brainDir, 'core_requests.md'), 30000);
  return {
    queue: { exists: !!q, created: q ? q.created : null, pending: cases.filter(c => c.status === 'pending').length, working: (cases.find(c => c.status === 'working') || {}).id || null, suppressed: q ? q.suppressed || 0 : 0, dropped: q ? q.dropped || 0 : 0 },
    cases, reports,
    lessons: (lessons || []).map(l => ({ id: l.id, date: l.date, signature: l.signature || {}, verdict: l.verdict, change: l.change, where: l.where, status: l.status, cases: l.cases || [], note: l.note })).reverse(),
    lessonsError, book, bookMtime: lmMtime, bookLines: book == null ? null : book.split(/\r?\n/).filter(l => l.trim()).length, coreRequests: core,
    core: loadCore(cfg)
  };
}
// Запросы на правку ядра с состоянием (ждёт разрешения / разрешён / инженер правит / сделано / откат) и записью итога
const coreCfg = cfg => ({ dataDir: cfg.dataDir, brainDir: cfg.brainDir, root: cfg.root });
function loadCore(cfg) {
  try {
    const l = coreReq.list(coreCfg(cfg));
    for (const it of l.items) it.result = readText(path.join(cfg.dataDir, 'core_tasks', it.id + '.result.md'), 6000);
    return { ok: true, ...l };
  } catch (e) { return { ok: false, error: String(e.message || e), items: [] }; }
}
function teacherReport(cfg, name) {
  if (typeof name !== 'string' || !REPORT_RE.test(name) || name !== path.basename(name)) return { ok: false, error: 'плохое имя отчёта' };
  const text = readText(path.join(cfg.dataDir, 'teacher', name), 60000);
  if (text == null) return { ok: false, error: 'нет такого отчёта' };
  // журнал opencode учителя: data/teacher-<id>.log (id — имя отчёта без -<тип>.md)
  const id = name.replace(/-[a-z]+\.md$/, '');
  let log = [], logMtime = null;
  const t = tailLines(path.join(cfg.dataDir, 'teacher-' + id + '.log'), 120 * 1024);
  if (t) { log = parseNightLog(t.lines).filter(e => e.k !== 'out').slice(-60).reverse(); logMtime = t.mtimeMs; }
  return { ok: true, name, text, log, logMtime };
}

// ======================= смерти и дни =======================

function parseDeathLine(l) {
  const m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s*Death #(\d+) at \((-?\d+),\s*(-?\d+),\s*(-?\d+)\) cause:\s*(.*?)\s*\|\s*(.*)$/.exec(l);
  if (!m) return null;
  const rest = m[7]; const tm = /\btimeOfDay:\s*(\S+)/.exec(rest);
  return { ts: Date.parse(m[1]), n: +m[2], x: +m[3], y: +m[4], z: +m[5], cause: m[6], msg: rest.replace(/\s*timeOfDay:.*$/, '').trim(), timeOfDay: tm ? tm[1] : '' };
}
function parseDayLine(l) {
  if (!l || l[0] !== '{') return null;
  try {
    const j = JSON.parse(l);
    if (!j || j.day == null) return null;
    return { ts: Date.parse(j.t), day: j.day, line: j.line || '', built: j.built, aux: j.aux, deaths: j.deaths, dist: j.dist, minedTotal: j.minedTotal, lostTotal: j.lostTotal, skills: j.skills ? { ok: j.skills.ok, fail: j.skills.fail } : null };
  } catch (e) { return null; }
}
function loadDeaths(cfg) {
  const df = path.join(cfg.dataDir, 'deaths.log'), yf = path.join(cfg.dataDir, 'days.log');
  const d = tailLines(df, 200 * 1024), y = tailLines(yf, 200 * 1024);
  const deaths = (d ? d.lines : []).map(parseDeathLine).filter(Boolean).reverse().slice(0, 100);
  const days = (y ? y.lines : []).map(parseDayLine).filter(Boolean).reverse().slice(0, 60);
  return { deaths, days };
}

// ======================= служебное =======================

// guard.log: «[2026-10-21 16:36:32] текст» (местное время, UTF-8 с BOM)
function parseGuardLine(l) {
  const m = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]\s*(.*)$/.exec(String(l).replace(/^\ufeff/, ''));
  return m ? { ts: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), text: m[7] } : null;
}
// handover.log: «[12:28:13] текст» — только время (местное), кодировка windows-1251
function parseHandoverLine(l) {
  const m = /^\[(\d\d:\d\d:\d\d)\]\s*(.*)$/.exec(String(l).replace(/^\ufeff/, ''));
  return m ? { sec: hmsToSec(m[1]), text: m[2] } : null;
}
function loadService(cfg) {
  const g = tailLines(path.join(cfg.dataDir, 'guard.log'), 100 * 1024);
  const guard = (g ? g.lines : []).map(parseGuardLine).filter(Boolean).reverse().slice(0, 40);
  const h = tailLines(path.join(cfg.dataDir, 'handover.log'), 100 * 1024);
  let handover = [];
  if (h) {
    const items = h.lines.map(parseHandoverLine).filter(Boolean);
    const ts = resolveTimes(items.map(i => i.sec), h.mtimeMs, false);
    handover = items.map((it, i) => ({ ts: ts[i], text: it.text })).reverse().slice(0, 40);
  }
  const starts = scanBrainStarts(cfg.dataDir).slice(0, 20);
  const rl = tailLines(path.join(cfg.dataDir, 'runner.out.log'), 60 * 1024);
  const runnerOut = rl ? rl.lines.slice(-40).reverse().map(s => s.slice(0, 300)) : [];
  return { guard, handover, starts, runnerOut };
}

// ======================= запросы к телу и исполнителю =======================

function httpJson(base, method, pathname, bodyObj, timeoutMs) {
  return new Promise(resolve => {
    let u; try { u = new URL(pathname, base); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj));
    const headers = { 'X-Observer': '1' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs || 3000 }, res => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => { s += c; if (s.length > 5e6) req.destroy(); });
      res.on('end', () => { try { resolve({ ok: true, status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ ok: false, status: res.statusCode, error: 'не JSON в ответе' }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'нет ответа' }); });
    req.on('error', e => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? 'не запущено' : String(e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Небольшой кэш, чтобы несколько открытых вкладок не долбили тело
const remote = new Map();
async function remoteCached(key, ttlMs, fn) {
  const c = remote.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.value;
  if (c && c.pending) return c.pending;
  const pending = fn().then(v => { remote.set(key, { at: Date.now(), value: v }); return v; });
  remote.set(key, { at: c ? c.at : 0, value: c ? c.value : null, pending });
  return pending;
}

// Чёрный ящик и учёт — сначала у тела (GET /blackbox, /ledger), иначе с диска. 404 от тела = оно ещё не перезапущено после обновления.
const NOT_RESTARTED = 'тело ещё не перезапущено — чёрного ящика и учёта в нём пока нет';
function bodyNote(r) {
  if (r.ok && r.status === 404) return { note: NOT_RESTARTED, notRestarted: true };
  if (r.ok) return { note: 'тело ответило ' + r.status };
  return { note: 'тело не отвечает (' + r.error + ')' };
}
async function loadBlackbox(cfg) {
  return remoteCached('bb:' + cfg.bodyUrl + '|' + cfg.dataDir, 5000, async () => {
    const r = await httpJson(cfg.bodyUrl, 'GET', '/blackbox?limit=100', null, 3000);
    if (r.ok && r.status === 200 && r.json && Array.isArray(r.json.items)) return { from: 'тело', total: r.json.total, items: r.json.items };
    const disk = bbFiles.list(path.join(cfg.dataDir, 'blackbox'), 100);
    return { from: 'диск', ...bodyNote(r), total: disk.total, items: disk.items };
  });
}
async function loadLedger(cfg) {
  return remoteCached('ledger:' + cfg.bodyUrl + '|' + cfg.dataDir, 5000, async () => {
    const r = await httpJson(cfg.bodyUrl, 'GET', '/ledger', null, 3000);
    if (r.ok && r.status === 200 && r.json && r.json.totals) return { from: 'тело', ledger: r.json };
    let o = null; try { o = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'ledger.json'), 'utf8')); } catch (e) {}
    const base = { from: 'диск', ...bodyNote(r) };
    if (!o || !o.days) return { ...base, ledger: null };
    return { ...base, ledger: { ok: true, since: o.since || null, updated: o.savedAt || null, labels: ledgerSummary.REASONS, ...ledgerSummary.summarize(o.days), inventory: null } };
  });
}
// Один файл ящика: у тела, а если оно не отвечает — с диска (имя проверяется до запроса)
async function loadBlackboxFile(cfg, name) {
  if (typeof name !== 'string' || !bbFiles.FILE_RE.test(name)) return { ok: false, error: 'плохое имя файла' };
  const r = await httpJson(cfg.bodyUrl, 'GET', '/blackbox/file?name=' + encodeURIComponent(name), null, 5000);
  if (r.ok && r.status === 200 && r.json && r.json.frames) return { ok: true, data: r.json };
  const d = bbFiles.readFile(path.join(cfg.dataDir, 'blackbox'), name);
  return d.ok ? { ok: true, data: d.data } : { ok: false, error: d.error };
}

// Витрина навыков: наша — у тела (GET /showcase), а если тело старое (404) или молчит — собираем из файлов теми же функциями;
// соседа — только у него самого. Нет ответа или нет эндпоинта — сосед просто «не отвечает», ничего не выдумываем.
async function loadShowcase(cfg) {
  const okShowcase = r => r.ok && r.status === 200 && r.json && Array.isArray(r.json.skills);
  const ours = await remoteCached('showcase:' + cfg.bodyUrl + '|' + cfg.dataDir, 30000, async () => {
    const r = await httpJson(cfg.bodyUrl, 'GET', '/showcase', null, 4000);
    if (okShowcase(r)) return { ok: true, from: 'тело', data: r.json };
    const note = r.ok && r.status === 404 ? 'тело ещё не перезапущено — витрины в нём нет, таблица собрана из файлов' : 'тело не отвечает (' + (r.error || r.status) + ') — таблица собрана из файлов';
    try { return { ok: true, from: 'диск', note, data: showcaseLib.build({ root: cfg.root || ROOT, dataDir: cfg.dataDir, brainDir: cfg.brainDir, bot: 'FlyBot_01', version: 'FlyBot 0.1' }) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  const neighbor = await remoteCached('showcase-n:' + cfg.neighborUrl, 30000, async () => {
    const r = await httpJson(cfg.neighborUrl, 'GET', '/showcase', null, 3000);
    if (okShowcase(r)) return { ok: true, data: r.json };
    if (r.ok && r.status === 404) return { ok: false, error: 'у соседа нет витрины (/showcase вернул 404)' };
    if (r.ok) return { ok: false, error: r.json ? 'у соседа витрина в другом виде' : 'сосед ответил не так (' + (r.error || r.status) + ')' };
    return { ok: false, error: 'сосед не отвечает (' + (r.error || '?') + ')' };
  });
  return { ours, neighbor };
}

async function loadBody(cfg) {
  return remoteCached('body:' + cfg.bodyUrl, 2000, async () => {
    const r = await httpJson(cfg.bodyUrl, 'GET', '/snapshot', null, 4000);
    if (r.ok && r.json) return { ok: true, snap: slimSnapshot(r.json) };
    const h = await httpJson(cfg.bodyUrl, 'GET', '/health', null, 2000);
    if (h.ok && h.json) return { ok: false, error: 'тело запущено, но не отвечает на /snapshot', health: h.json };
    return { ok: false, error: 'тело (bot.js, порт 3199) не отвечает: ' + (h.error || r.error || '?') };
  });
}
function slimSnapshot(s) {
  const eyes = s.eyes || {};
  return {
    ready: s.ready, username: s.username, summary: s.summary, health: s.health, food: s.food, position: s.position,
    heldItem: s.heldItem, armor: s.armor || [], inventory: (s.inventory || []).slice(0, 60), timeOfDay: s.timeOfDay, biome: s.biome, gameMode: s.gameMode,
    lightLevel: s.lightLevel, enemies: eyes.enemies || [], aggressors: eyes.aggressors || [], threats: eyes.threats || [], players: eyes.players || [],
    hazards: eyes.hazards || [], weather: eyes.weather, time: eyes.time, task: eyes.task || null, vitals: eyes.vitals || null,
    autopilot: s.autopilot || null, stats: s.stats || null, memory: s.memory || null, day: s.day || null, experience: eyes.experience || null
  };
}

async function loadRunner(cfg) {
  return remoteCached('runner:' + cfg.runnerUrl, 3000, async () => {
    const [h, l, sk] = await Promise.all([
      httpJson(cfg.runnerUrl, 'GET', '/health', null, 2500),
      httpJson(cfg.runnerUrl, 'GET', '/log?limit=60', null, 2500),
      httpJson(cfg.runnerUrl, 'GET', '/skills', null, 4000)
    ]);
    if (!h.ok && !l.ok) return { ok: false, error: 'исполнитель (runner.js, порт 3200) не отвечает: ' + (h.error || '?') };
    const entries = l.ok && l.json && l.json.entries ? l.json.entries.slice().reverse().map(e => ({ ...e, ts: Date.parse(e.time) })) : [];
    const skills = sk.ok && sk.json && sk.json.skills ? sk.json.skills.map(s => ({ name: s.name, enabled: s.enabled, reason: s.disabledReason || null, valid: s.valid, runs: s.stats && s.stats.runs, ok: s.stats && s.stats.ok, fail: s.stats && s.stats.fail, lastError: s.stats && s.stats.lastError, lastRun: s.stats && s.stats.lastRun ? Date.parse(s.stats.lastRun) : null })) : [];
    return { ok: true, runner: h.ok && h.json ? h.json.runner : null, entries, skills };
  });
}

// ======================= модели ролей (data/models.json) =======================
// Единственное, что аудит ПИШЕТ в файлы мухи. Читают файл night.cmd (мозг), brain_guard.ps1 (учитель, инженер) — при каждом запуске роли.

const ROLE_INFO = {
  brain: { label: 'Мозг', when: 'со следующей сессии мозга (сессия кончается сама или её перезапускают; сразу — restart_brain.cmd)' },
  teacher: { label: 'Учитель', when: 'со следующего случая учителя' },
  engineer: { label: 'Инженер', when: 'со следующей заявки инженера' }
};
const FREE_TTL = 6 * 3600 * 1000;

// Вывод `opencode models opencode --verbose`: строка «провайдер/модель», дальше JSON с ценой. Бесплатная = цена входа и выхода нулевая.
function parseVerboseModels(text) {
  const parts = String(text || '').split(/^([A-Za-z0-9_.-]+\/\S+)[ \t]*\r?$/m);
  const out = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    let j; try { j = JSON.parse(parts[i + 1]); } catch (e) { continue; }
    if (!j || typeof j !== 'object' || !j.cost) continue;
    if (j.status && j.status !== 'active') continue;
    if (j.cost.input === 0 && j.cost.output === 0 && modelsCfg.validModelId(parts[i])) out.push(parts[i]);
  }
  return out;
}
// запасной разбор простого списка `opencode models`: только провайдер opencode и суффикс -free
function parsePlainFree(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(s => /^opencode\/.+-free$/.test(s) && modelsCfg.validModelId(s));
}

function runShell(cmd, timeoutMs) {
  return new Promise(resolve => {
    try {
      execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], { timeout: timeoutMs, windowsHide: true, maxBuffer: 30 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err && !stdout ? { ok: false, error: err.killed ? 'не ответила за ' + Math.round(timeoutMs / 1000) + ' с' : String(err.message || err).split('\n')[0] } : { ok: true, text: stdout }));
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

const freeMem = new Map();
async function loadFreeModels(cfg, force) {
  const key = cfg.dataDir;
  const m = freeMem.get(key);
  if (!force && m && Date.now() - m.at < m.ttl) return m.value;
  const cacheFile = path.join(cfg.dataDir, 'models_free.json');
  let value, ttl = FREE_TTL;
  const live = cfg.listFreeModels ? await cfg.listFreeModels() : await (async () => {
    let r = await runShell('opencode models opencode --verbose', 30000);
    let list = r.ok ? parseVerboseModels(r.text) : [];
    if (!list.length) {
      const r2 = await runShell('opencode models opencode', 30000);
      if (r2.ok) list = parsePlainFree(r2.text);
      if (!list.length) return { ok: false, error: r.ok && r2.ok ? 'в ответе opencode нет бесплатных моделей' : (r.error || r2.error) };
    }
    return { ok: true, list };
  })();
  if (live && live.ok && Array.isArray(live.list) && live.list.length) {
    const list = [...new Set(live.list)].sort();
    value = { list, from: 'opencode', at: Date.now(), error: null };
    try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ at: value.at, list })); } catch (e) {}
  } else {
    ttl = 60000; // не дёргать opencode каждые 2,5 с, если он не отвечает
    let disk = null; try { disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
    const list = disk && Array.isArray(disk.list) ? disk.list.filter(modelsCfg.validModelId) : [];
    value = { list, from: list.length ? 'кэш на диске' : 'нет', at: list.length ? disk.at : null, error: (live && live.error) || 'opencode models не ответил' };
  }
  freeMem.set(key, { at: Date.now(), ttl, value });
  return value;
}

// Какие модели у запущенных сейчас opencode — по командным строкам процессов («opencode run --auto -m <модель> "You are the <роль> of the Minecraft bot…»)
function parseOpencodeProcs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const mm = /^(\d+)\t(.*)$/.exec(line); if (!mm) continue;
    const role = /You are the (brain|teacher|engineer) of the Minecraft bot/.exec(mm[2]);
    const model = /\s(?:-m|--model)[\s=]+"?([^\s"]+)/.exec(mm[2]);
    if (role && model) out.push({ pid: +mm[1], role: role[1], model: model[1] });
  }
  return out;
}
async function loadRunningModels(cfg) {
  if (cfg.runningModels) return cfg.runningModels();
  if (process.platform !== 'win32') return null;
  return remoteCached('running-models', 8000, () => new Promise(resolve => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='opencode.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve(err ? null : parseOpencodeProcs(stdout)));
    } catch (e) { resolve(null); }
  }));
}

// Сторож, запущенный до этого обновления, файл моделей не читает: его последняя строка «сторож запущен» без упоминания models.json
function guardReadsModels(cfg) {
  const g = tailLines(path.join(cfg.dataDir, 'guard.log'), 100 * 1024);
  if (!g) return null;
  for (let i = g.lines.length - 1; i >= 0; i--) if (/сторож запущен/.test(g.lines[i])) return /models\.json/.test(g.lines[i]);
  return null;
}

async function apiModels(cfg, q) {
  const cur = modelsCfg.read(cfg.dataDir);
  const [free, running] = await Promise.all([loadFreeModels(cfg, q && q.get('refresh') === '1'), loadRunningModels(cfg)]);
  const roles = modelsCfg.ROLES.map(r => ({
    role: r, label: ROLE_INFO[r].label, when: ROLE_INFO[r].when,
    model: cur.models[r], source: cur.source[r], default: modelsCfg.DEFAULTS[r],
    running: running ? running.filter(p => p.role === r).map(p => ({ pid: p.pid, model: p.model })) : null
  }));
  return { now: Date.now(), roles, free, guardReadsModels: guardReadsModels(cfg), file: path.join(cfg.dataDir, modelsCfg.FILE_NAME) };
}
function saveModels(cfg, body) {
  const patch = {};
  for (const r of modelsCfg.ROLES) if (body && Object.prototype.hasOwnProperty.call(body, r)) patch[r] = body[r];
  for (const k of Object.keys(body || {})) if (!modelsCfg.ROLES.includes(k)) return { ok: false, error: 'неизвестная роль: ' + String(k).slice(0, 40) };
  return modelsCfg.save(patch, cfg.dataDir);
}

// ======================= сборка ответов API =======================

function brainStatus(cfg) {
  const nl = latestNightLog(cfg.dataDir);
  if (!nl) return { file: null };
  const age = Math.round((Date.now() - nl.mtimeMs) / 1000);
  return { file: nl.name, mtimeMs: nl.mtimeMs, ageSec: age, sizeKb: Math.round(nl.size / 1024), state: age < 180 ? 'ok' : age < 600 ? 'slow' : 'silent' };
}

async function apiSummary(cfg) {
  const { events, mtimeMs } = loadEvents(cfg);
  const [body, run] = await Promise.all([loadBody(cfg), loadRunner(cfg)]);
  const sn = body.ok ? body.snap : null;
  return {
    now: Date.now(),
    body: { ok: !!body.ok, error: body.error || null, ready: sn ? !!sn.ready : false, hp: sn ? sn.health : null, food: sn ? sn.food : null },
    runner: { ok: !!run.ok, error: run.error || null, active: run.ok && run.runner ? run.runner.active : null },
    brain: brainStatus(cfg),
    events: { lastTs: events.length ? events[events.length - 1].ts : null, fileMtime: mtimeMs }
  };
}

async function api(cfg, name, q) {
  const now = Date.now();
  switch (name) {
    case 'summary': return apiSummary(cfg);
    case 'body': { const b = await loadBody(cfg); const { events } = loadEvents(cfg); return { now, ...b, recent: reflexFeed(events, 400).filter(x => x.who === 'угроза' || x.who === 'тело').slice(0, 15) }; }
    case 'reflex': { const { events } = loadEvents(cfg); const b = await loadBody(cfg); return { now, items: reflexFeed(events, 150), autopilot: b.ok ? b.snap.autopilot : null }; }
    case 'brain': {
      const { events } = loadEvents(cfg); const bl = loadBrainLog(cfg); const notes = loadNotes(cfg);
      const entries = newestFirst(collapsePolls(bl.entries.slice(-400)).slice(-250));
      return { now, status: brainStatus(cfg), goal: notes.goal, ownerNote: notes.ownerNote, notesMtime: notes.mtimeMs || null, notesError: notes.error || null, commands: brainCommands(events, 60), thoughts: entries, logFile: bl.file };
    }
    case 'engineer': return { now, items: engineerList(cfg).map(i => ({ ...i, statusRu: STATUS_RU[i.status] })) };
    case 'request': return engineerDetail(cfg, q.get('name'));
    case 'deaths': return { now, ...loadDeaths(cfg), blackbox: await loadBlackbox(cfg), ledger: await loadLedger(cfg) };
    case 'blackbox_file': return loadBlackboxFile(cfg, q.get('name'));
    case 'service': { const s = loadService(cfg); const r = await loadRunner(cfg); return { now, ...s, runner: r }; }
    case 'chat': { const { events } = loadEvents(cfg); return { now, items: chatFeed(events, 120, q.get('system') === '1') }; }
    case 'showcase': return { now, ...(await loadShowcase(cfg)) };
    case 'teacher': return { now, ...loadTeacher(cfg) };
    case 'teacher_report': return teacherReport(cfg, q.get('name'));
    case 'core_requests': return { now, ...loadCore(cfg) };
    case 'models': return apiModels(cfg, q);
  }
  return null;
}

// ======================= HTTP =======================

function createServer(opts) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const sendJson = (res, code, obj) => { if (res.writableEnded) return; res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    // защита от DNS-rebinding: только локальные имена хоста
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) { req.resume(); return sendJson(res, 403, { ok: false, error: 'bad host' }); }
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        let html; try { html = fs.readFileSync(cfg.page); } catch (e) { return sendJson(res, 500, { ok: false, error: 'нет audit/index.html' }); }
        res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/models') return sendJson(res, 200, await apiModels(cfg, url.searchParams));
      if (req.method === 'POST' && (url.pathname === '/api/models' || url.pathname === '/models')) {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { req.resume(); return sendJson(res, 403, { ok: false, error: 'чужой сайт' }); }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { req.resume(); return sendJson(res, 415, { ok: false, error: 'нужен Content-Type: application/json' }); }
        let s = ''; let big = false;
        req.on('data', c => { if (big) return; s += c; if (s.length > 4000) { big = true; req.resume(); sendJson(res, 413, { ok: false, error: 'слишком большой запрос' }); } });
        req.on('end', () => {
          if (big) return;
          let b; try { b = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
          if (!b || typeof b !== 'object' || Array.isArray(b)) return sendJson(res, 400, { ok: false, error: 'нужен объект {роль: модель}' });
          const r = saveModels(cfg, b);
          return sendJson(res, r.ok ? 200 : 400, r);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/core_requests/approve') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { req.resume(); return sendJson(res, 403, { ok: false, error: 'чужой сайт' }); }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { req.resume(); return sendJson(res, 415, { ok: false, error: 'нужен Content-Type: application/json' }); }
        let s = ''; let big = false;
        req.on('data', c => { if (big) return; s += c; if (s.length > 2000) { big = true; req.resume(); sendJson(res, 413, { ok: false, error: 'слишком большой запрос' }); } });
        req.on('end', () => {
          if (big) return;
          let b; try { b = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
          if (!b || typeof b.id !== 'string' || !/^[0-9a-f]{10}$/.test(b.id)) return sendJson(res, 400, { ok: false, error: 'нужен id запроса' });
          const r = coreReq.approve(coreCfg(cfg), b.id);
          return sendJson(res, r.ok ? 200 : 400, r);
        });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
        const r = await api(cfg, url.pathname.slice(5), url.searchParams);
        return r == null ? sendJson(res, 404, { ok: false, error: 'not found' }) : sendJson(res, 200, r);
      }
      if (req.method === 'POST' && url.pathname === '/api/say') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { req.resume(); return sendJson(res, 403, { ok: false, error: 'чужой сайт' }); }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { req.resume(); return sendJson(res, 415, { ok: false, error: 'нужен Content-Type: application/json' }); }
        let s = ''; let big = false;
        req.on('data', c => { if (big) return; s += c; if (s.length > 20000) { big = true; req.resume(); sendJson(res, 413, { ok: false, error: 'слишком большой запрос' }); } });
        req.on('end', async () => {
          if (big) return;
          let b; try { b = JSON.parse(s || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
          const chk = checkOwnerText(b && b.text);
          if (!chk.ok) return sendJson(res, 400, chk);
          const r = await httpJson(cfg.bodyUrl, 'POST', '/owner_msg', { text: chk.text }, 4000);
          if (!r.ok) return sendJson(res, 502, { ok: false, error: 'тело не приняло сообщение: ' + r.error });
          if (r.status === 404) return sendJson(res, 502, { ok: false, error: 'тело ещё не знает команды owner_msg — его нужно перезапустить (сообщение НЕ отправлено)' });
          if (r.status !== 200 || !r.json || !r.json.ok) return sendJson(res, 502, { ok: false, error: (r.json && r.json.error) || ('тело ответило ' + r.status) });
          return sendJson(res, 200, { ok: true, text: chk.text });
        });
        return;
      }
      req.resume();
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
  server.cfg = cfg;
  return server;
}

module.exports = {
  createServer, DEFAULTS, readTail, tailLines, decodeBuf, resolveTimes, hmsToSec, parseEventLines, reflexFeed, brainCommands, chatFeed,
  stripAnsi, parseCurl, parseNightLog, parseNotes, parseDeathLine, parseDayLine, parseGuardLine, parseHandoverLine,
  parseVerboseModels, parsePlainFree, parseOpencodeProcs, loadFreeModels, apiModels, saveModels,
  engineerList, engineerDetail, collapsePolls, loadShowcase, loadEvents, loadBrainLog, scanBrainStarts, latestNightLog, loadService, loadDeaths, loadBlackbox, loadLedger, loadBlackboxFile, loadTeacher, teacherReport, loadCore, api, taskRu
};

if (require.main === module) {
  const server = createServer();
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.log('[аудит] порт 3300 уже занят — наверное, программа уже запущена: http://127.0.0.1:3300'); process.exit(0); }
    console.log('[аудит] ошибка:', e.message); process.exit(1);
  });
  server.listen(server.cfg.port, '127.0.0.1', () => console.log('[аудит] http://127.0.0.1:' + server.cfg.port + '  (Ctrl+C — выход)'));
  process.on('unhandledRejection', e => console.log('[аудит] warn:', e && e.message ? e.message : e));
  process.on('uncaughtException', e => console.log('[аудит] warn:', e && e.stack ? e.stack : e));
}
