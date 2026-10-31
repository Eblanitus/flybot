// Бухгалтерия учителя: случаи копятся на счетах, заявка инженеру — только когда счёт набрал порог. Считает код, не модель.
// Счёт — одна проблема мухи (slug латиницей): заголовок, вид (behavior | skill | core), проводки (минуты потерянной стройки с доказательством).
// Учитель после разбора обычного случая пишет в отчёт строки «Проводка: <slug> | <заголовок> | <вид> | <минуты> | <доказательство>»,
// lib/teacher_triggers.js на finish отдаёт отчёт сюда (post). Баланс тает вдвое за сутки; порог зависит от загрузки инженера L
// (открытые заявки brain/skill_requests + разрешённые, но не сделанные запросы ядра + счета, уже стоящие в очереди учителя).
// Счёт набрал порог и заявки по нему нет — teacher_triggers ставит учителю случай «счёт» (invoice): одна сильная заявка из доказательств.
// Жизнь счёта: open → queued (случай-счёт в очереди) → invoiced (есть заявка) → watching (заявка сделана, баланс с нуля)
//   → closed (48 ч тишины) | open + «не помогло» (новые проводки за 48 ч: следующая заявка — «переделать», порог вдвое ниже).
// Заявка ещё не взята, а счёт растаял (< 5 мин и сутки без проводок) — снимается маркером <имя>.stale.md («муха справилась сама»).
// Состояние — data/teacher_ledger.json (атомарная запись; битый файл — копия .bad и пустая книга).
// CLI (ответ — одна ASCII-строка JSON):  post <caseId> <reportFile> | due | status | sweep
'use strict';
const fs = require('fs');
const path = require('path');
const coreReq = require('./core_requests');

const ROOT = path.join(__dirname, '..');
const H = 3600 * 1000;
const DEFAULTS = {
  HALF_LIFE_MS: 24 * H,             // баланс тает вдвое за сутки
  THRESHOLDS: [15, 45, 75, 105],    // порог в минутах по загрузке L = 0, 1, 2, 3; L ≥ длины — новых заявок нет
  // цена случая в минутах стройки: def — если учитель не написал, max — потолок (простой: def = его длительность из события)
  PRICE: {
    death: { def: 30, max: 60 }, idle: { def: null, max: 120 }, stuck: { def: 15, max: 30 }, fail: { def: 2, max: 3 },
    near: { def: 5, max: 15 }, owner: { def: 10, max: 30 }, neighbor: { def: 3, max: 10 }, other: { def: 5, max: 30 }
  },
  MAX_POSTINGS_PER_CASE: 2,         // учитель пишет 1–2 строки; лишние не проводятся
  WATCH_MS: 48 * H,                 // после оплаты: новые проводки за 48 ч — «не помогло», 48 ч тишины — счёт закрыт
  REDO_FACTOR: 0.5,                 // «переделать» — порог вдвое ниже
  STALE_BALANCE: 5, STALE_QUIET_MS: 24 * H,  // заявка не взята, баланс < 5 мин и сутки без проводок — «муха справилась сама»
  REPEAT_MIN_LOAD: 4,               // ПОВТОР в открытую заявку (новые доказательства без модели) — при загрузке L ≥ этого
  LOCK_MS: 15 * 60 * 1000,          // свежий <имя>.working — инженер держит заявку (как в brain_guard.ps1 PickReq: EngTimeoutMin + 5)
  INVOICE_RETRY_MS: 6 * H,          // случай-счёт не дал заявки (учитель отказался / сбой) — снова не раньше чем через 6 ч
  STATEMENT_MAX: 15, STATEMENT_EVIDENCE: 2, INVOICE_POSTINGS: 5,
  MAX_KEEP: 60, MAX_HISTORY: 10, MAX_ACCOUNTS: 300
};
const KINDS = { behavior: 'behavior', поведение: 'behavior', автопилот: 'behavior', рефлекс: 'behavior', skill: 'skill', навык: 'skill', core: 'core', ядро: 'core', датчик: 'core' };
const STATUS_RU = { open: 'копится', queued: 'счёт у учителя', invoiced: 'заявка ждёт инженера', watching: 'сделано, смотрим 48 ч', closed: 'закрыт' };
const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
const REQ_RE = /^[a-z0-9_]+$/;

function paths(cfg = {}) {
  const dataDir = cfg.dataDir || path.join(ROOT, 'data');
  const brainDir = cfg.brainDir || path.join(ROOT, 'brain');
  return { dataDir, brainDir, state: path.join(dataDir, 'teacher_ledger.json'), requests: path.join(brainDir, 'skill_requests'),
    core: coreReq.paths({ dataDir, brainDir, root: cfg.root || path.dirname(dataDir) }) };
}
const lim = cfg => ({ ...DEFAULTS, ...(cfg.ledgerLimits || {}), PRICE: { ...DEFAULTS.PRICE, ...((cfg.ledgerLimits || {}).PRICE || {}) } });
const nowOf = cfg => cfg.now ? cfg.now() : Date.now();
const short = (s, n = 200) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const r1 = x => Math.round(x * 10) / 10;
const pad = n => String(n).padStart(2, '0');
const when = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return null; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
const fresh = now => ({ version: 1, created: new Date(now).toISOString(), accounts: {} });
// битый файл: не падаем — копия рядом (.bad) и пустая книга
function load(P, now) {
  const txt = readText(P.state);
  if (txt == null) return fresh(now);
  try { const o = JSON.parse(txt.replace(/^﻿/, '')); if (o && o.accounts && typeof o.accounts === 'object' && !Array.isArray(o.accounts)) return o; } catch (e) {}
  try { fs.copyFileSync(P.state, P.state + '.bad'); } catch (e) {}
  const st = fresh(now); st.recovered = 'битый файл отложен в teacher_ledger.json.bad'; return st;
}

// ---------- проводки ----------
// цена: число из поля «минуты» (30, «30 мин», «~20»); нет или мусор — по умолчанию для типа случая; сверх потолка — потолок
function idleMinutes(items) {
  let m = 0; for (const i of items || []) { const x = /(\d+)\s*мин/.exec(i && i.text || ''); if (x) m = Math.max(m, +x[1]); }
  return m || null;
}
function price(type, raw, items, L) {
  const p = L.PRICE[type] || L.PRICE.other;
  let def = p.def; if (def == null) def = type === 'idle' ? (idleMinutes(items) || 30) : 5;
  let min = Number(String(raw == null ? '' : raw).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!(min > 0) || !Number.isFinite(min)) min = def;
  return r1(Math.min(min, p.max));
}
const MIN_RE = /^~?\s*\d+([.,]\d+)?\s*(мин\.?|минут[аы]?|min|m)?$/i;
// строки «Проводка: …» из отчёта → [{ slug, title, kind, min, ev }]; мусор пропускается
function parsePostings(text, caseInfo = {}, limits) {
  const L = limits || DEFAULTS, out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:[-*>]\s*)?\**\s*Проводка\s*\**\s*:\s*\**\s*(.+)$/i.exec(line);
    if (!m) continue;
    const f = m[1].split('|').map(s => s.replace(/`/g, '').trim());
    const slug = (f.shift() || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!SLUG_RE.test(slug)) continue;
    let kind = null, raw = null; const texts = [];
    for (const x of f) {
      const k = KINDS[x.toLowerCase()];
      if (k && !kind) kind = k;
      else if (raw == null && MIN_RE.test(x)) raw = x;
      else if (x) texts.push(x);
    }
    if (out.some(p => p.slug === slug)) continue;
    const title = short(texts[0] || '', 120), ev = short(texts.length > 1 ? texts.slice(1).join(' | ') : texts[0] || '', 300);
    out.push({ slug, title, kind, min: price(caseInfo.type, raw, caseInfo.items, L), ev });
    if (out.length >= L.MAX_POSTINGS_PER_CASE) break;
  }
  return out;
}

// баланс: проводки после обнуления (оплаты), каждая тает вдвое за HALF_LIFE_MS
function balance(acc, now, L = DEFAULTS) {
  let s = 0;
  for (const p of acc.postings || []) if (p.t > (acc.resetAt || 0) && p.t <= now) s += p.min * Math.pow(0.5, (now - p.t) / L.HALF_LIFE_MS);
  return s;
}
const sumIn = (acc, from, to) => (acc.postings || []).filter(p => p.t > (acc.resetAt || 0) && p.t > from && p.t <= to).reduce((s, p) => s + p.min, 0);
function trend(acc, now) {
  const a = sumIn(acc, now - 24 * H, now), b = sumIn(acc, now - 48 * H, now - 24 * H);
  return { last24: r1(a), prev24: r1(b), ru: a > b * 1.2 + 0.5 ? 'растёт' : a < b * 0.8 - 0.5 ? 'падает' : 'ровно' };
}
const lastAt = acc => (acc.postings || []).reduce((m, p) => Math.max(m, p.t), 0);

// ---------- заявки и загрузка инженера ----------
// Открытая заявка навыка — то же правило, что у сторожа (brain_guard.ps1 PickReq): <имя>.md, имя [a-z0-9_]+,
// и нет ни ответа <имя>.done.md, ни маркера снятия <имя>.stale.md новее заявки.
function skillReqState(P, name, now, L = DEFAULTS) {
  if (!REQ_RE.test(name || '')) return 'missing';
  const req = mtime(path.join(P.requests, name + '.md'));
  if (req == null) return 'missing';
  const done = mtime(path.join(P.requests, name + '.done.md')), stale = mtime(path.join(P.requests, name + '.stale.md'));
  if (done != null && done >= req) return 'done';
  if (stale != null && stale >= req) return 'stale';
  const lock = mtime(path.join(P.requests, name + '.working'));
  if (lock != null && now - lock < L.LOCK_MS) return 'working';
  return 'open';
}
// для сторожа и тестов: берётся ли файл заявки в работу (без учёта замка .working)
function pickable(dir, fileName) {
  if (/\.(done|stale)\.md$/.test(fileName) || !/\.md$/.test(fileName)) return false;
  const name = fileName.replace(/\.md$/, '');
  const st = skillReqState({ requests: dir }, name, Date.now(), { LOCK_MS: -1 });
  return st === 'open' || st === 'working';
}
function coreList(P) { try { return coreReq.list(P.core).items; } catch (e) { return []; } }
function coreReqState(P, id) {
  const it = coreList(P).find(x => x.id === id);
  if (!it) return 'missing';
  if (it.status === 'done') return 'done';
  if (it.status === 'stale') return 'stale';
  if (it.status === 'working') return 'working';
  return it.status === 'reverted' || it.status === 'failed' ? 'done' : 'open';   // откат/не сделано — тоже ответ: дальше решат проводки
}
const reqState = (P, r, now, L) => !r ? 'missing' : r.kind === 'core' ? coreReqState(P, r.id) : skillReqState(P, r.name, now, L);
const reqLabel = r => !r ? '' : r.kind === 'core' ? 'core_requests.md: ' + (r.title || r.id) : r.name + '.md';

function engineerLoad(P, st, now, L = DEFAULTS) {
  let names = []; try { names = fs.readdirSync(P.requests); } catch (e) {}
  const skill = names.filter(n => /^[a-z0-9_]+\.md$/.test(n)).map(n => n.slice(0, -3)).filter(n => { const s = skillReqState(P, n, now, L); return s === 'open' || s === 'working'; });
  const core = coreList(P).filter(x => x.status === 'approved' || x.status === 'working').map(x => x.id);
  const queued = Object.values(st.accounts).filter(a => a.status === 'queued').map(a => a.slug);
  return { skill, core, queued, n: skill.length + core.length + queued.length };
}
function threshold(n, redo, L = DEFAULTS) {
  const t = L.THRESHOLDS[n];
  return t == null ? null : r1(redo ? t * L.REDO_FACTOR : t);
}

// ---------- счета ----------
function account(st, slug, now) {
  if (!st.accounts[slug]) st.accounts[slug] = { slug, title: slug, kind: 'behavior', status: 'open', created: now, postings: [], resetAt: 0, redo: false, request: null, history: [] };
  return st.accounts[slug];
}
function addPosting(st, p, caseInfo, now, L, msgs) {
  const isNew = !st.accounts[p.slug];
  const a = account(st, p.slug, now);
  if (p.title && (isNew || a.title === a.slug)) a.title = p.title;
  if (p.kind && (isNew || !a.kind)) a.kind = p.kind;
  if (a.status === 'watching') {
    if (now - (a.paidAt || 0) <= L.WATCH_MS) {
      a.status = 'open'; a.redo = true;
      const h = a.history[a.history.length - 1]; if (h) h.outcome = 'не помогло';
      msgs.push(`счёт ${a.slug}: заявка не помогла (проводка через ${r1((now - a.paidAt) / H)} ч) — следующая «переделать»`);
    } else { a.status = 'open'; a.redo = false; }
  } else if (a.status === 'closed') { a.status = 'open'; a.redo = false; }
  a.postings.push({ t: now, min: p.min, ev: p.ev, caseId: caseInfo.id || null, type: caseInfo.type || null });
  if (a.postings.length > L.MAX_KEEP) a.postings = a.postings.slice(-L.MAX_KEEP);
  return a;
}
function link(st, a, req, now) {
  a.request = { ...req, at: now };
  a.status = 'invoiced'; a.invoicedAt = now; a.repeatedUpTo = now; delete a.queuedCase; delete a.retryAt;
  a.history.push({ request: reqLabel(req), kind: req.kind, name: req.name || null, id: req.id || null, at: now, redo: !!a.redo, outcome: 'ждёт инженера' });
  if (a.history.length > DEFAULTS.MAX_HISTORY) a.history = a.history.slice(-DEFAULTS.MAX_HISTORY);
}

// «Сделано: заявка <файл>» → имя заявки, если файл есть
function requestFromReport(P, text, startedAt) {
  const m = /Сделано\s*:?\**\s*[^\n]*?заявк[аиу]\s+`?(?:brain[\\/]skill_requests[\\/])?([A-Za-z0-9_]+)(?:\.md)?`?/i.exec(String(text || ''));
  if (m && REQ_RE.test(m[1]) && mtime(path.join(P.requests, m[1] + '.md')) != null) return { kind: 'skill', name: m[1] };
  if (startedAt) {   // строки нет — свежая заявка, записанная за время разбора
    let names = []; try { names = fs.readdirSync(P.requests).filter(n => /^[a-z0-9_]+\.md$/.test(n)); } catch (e) {}
    const fr = names.map(n => ({ n: n.slice(0, -3), t: mtime(path.join(P.requests, n)) })).filter(x => x.t != null && x.t >= startedAt - 2000).sort((a, b) => b.t - a.t)[0];
    if (fr && /Сделано\s*:[^\n]*заявк/i.test(String(text || ''))) return { kind: 'skill', name: fr.n };
  }
  return null;
}
function coreFromReport(P, text, coreIdsBefore) {
  if (!Array.isArray(coreIdsBefore) || !/Сделано\s*:[^\n]*core_requests/i.test(String(text || ''))) return null;
  const was = new Set(coreIdsBefore);
  const fresh = coreList(P).filter(x => !was.has(x.id)).pop();
  return fresh ? { kind: 'core', id: fresh.id, title: short(fresh.title, 120) } : null;
}
const coreIds = (cfg = {}) => coreList(paths(cfg)).map(x => x.id);

// Случай учителя закрыт (teacher_triggers.finish). status — 'done' (отчёт написан) или 'failed'.
// caseInfo: { id, type, items, startedAt, coreIds, slug (для invoice) }
function caseFinished(cfg, caseInfo, status, reportText) {
  const P = paths(cfg), L = lim(cfg), now = nowOf(cfg), msgs = [];
  const st = load(P, now);
  const out = { posted: [], linked: null, msgs };
  if (caseInfo.type === 'invoice') {
    const a = st.accounts[caseInfo.slug];
    if (a) {
      const req = status === 'done' ? (requestFromReport(P, reportText, caseInfo.startedAt) || coreFromReport(P, reportText, caseInfo.coreIds)) : null;
      if (req) { link(st, a, req, now); out.linked = reqLabel(req); msgs.push(`счёт ${a.slug}: выставлен — ${reqLabel(req)}`); }
      else { a.status = 'open'; delete a.queuedCase; a.retryAt = now + L.INVOICE_RETRY_MS; msgs.push(`счёт ${a.slug}: заявки нет (${status === 'done' ? 'учитель не написал' : 'разбор не вышел'}), снова через ${r1(L.INVOICE_RETRY_MS / H)} ч`); }
    }
  } else if (status === 'done') {
    const ps = parsePostings(reportText, caseInfo, L);
    for (const p of ps) { addPosting(st, p, caseInfo, now, L, msgs); out.posted.push(`${p.slug} ${p.min}`); }
    // хозяин (и прочие, если учитель всё же написал заявку): заявка привязывается к первому счёту из проводок
    const req = ps.length ? (requestFromReport(P, reportText, caseInfo.startedAt) || coreFromReport(P, reportText, caseInfo.coreIds)) : null;
    if (req) {
      const a = st.accounts[ps[0].slug];
      if (a && a.status !== 'queued') { link(st, a, req, now); out.linked = reqLabel(req); msgs.push(`счёт ${a.slug}: заявка сразу (${caseInfo.type}) — ${reqLabel(req)}`); }
    }
    if (ps.length) msgs.push(`проводки ${caseInfo.id}: ${out.posted.join(', ')}`);
  }
  const keys = Object.keys(st.accounts);
  if (keys.length > L.MAX_ACCOUNTS) {   // старые закрытые — вон
    keys.map(k => st.accounts[k]).filter(a => a.status === 'closed').sort((a, b) => lastAt(a) - lastAt(b)).slice(0, keys.length - L.MAX_ACCOUNTS).forEach(a => delete st.accounts[a.slug]);
  }
  writeJson(P.state, st);
  return out;
}

// ---------- ПОВТОР и снятие ----------
function appendRepeat(P, a, fresh, bal, now) {
  const lines = fresh.map(p => `- ${p.ev || '—'} [случай ${p.caseId || '?'}, ${p.min} мин]`).join('\n');
  if (a.request.kind === 'core') {
    const text = readText(P.core.file); if (text == null) return false;
    const rows = text.split(/\r?\n/); let i = rows.findIndex(l => /^##\s+/.test(l) && coreReq.idOf(l) === a.request.id);
    if (i < 0) return false;
    let j = i + 1; while (j < rows.length && !/^##\s+/.test(rows[j])) j++;
    while (j > i + 1 && !rows[j - 1].trim()) j--;
    rows.splice(j, 0, '', `ПОВТОР (бухгалтерия учителя, ${when(now)}, счёт ${a.slug}, баланс ${Math.round(bal)} мин):`, lines);
    fs.writeFileSync(P.core.file, rows.join('\n'));
    return true;
  }
  const f = path.join(P.requests, a.request.name + '.md');
  fs.appendFileSync(f, `\n\n## ПОВТОР от бухгалтерии учителя (${when(now)})\nСчёт ${a.slug} (${a.title}): баланс ${Math.round(bal)} мин. Новые доказательства:\n${lines}\n`);
  try { fs.utimesSync(f, new Date(now), new Date(now)); } catch (e) {}
  return true;
}
function markStale(P, a, bal, now) {
  const why = `счёт ${a.slug}: баланс ${r1(bal)} мин, проводок не было с ${when(lastAt(a) || a.invoicedAt || now)}`;
  if (a.request.kind === 'core') {
    if (!coreReq.markStale) return false;
    return coreReq.markStale(P.core, a.request.id, 'снят: муха справилась сама (' + why + ')').ok;
  }
  const f = path.join(P.requests, a.request.name + '.stale.md');
  fs.writeFileSync(f,
    `# ${a.request.name}: снята — муха справилась сама\n${why}.\nИнженер и сторож эту заявку не берут (это не ответ инженера и не «сделано»). Проблема вернётся — учитель выставит счёт заново, заявку можно переписать.\n`);
  try { fs.utimesSync(f, new Date(now), new Date(now)); } catch (e) {}   // время — по тем же часам, что и решение
  return true;
}

// Раз в цикл: оплата, «не помогло»/закрытие, устаревание, ПОВТОР, выставление счетов.
// liveCases — id ожидающих/разбираемых случаев учителя (счёт в очереди, а случая нет — вернуть в «копится»);
// enqueue(acc, info) → id нового случая-счёта или null. Без enqueue — только смотрим (due).
function tick(cfg = {}, opts = {}) {
  const P = paths(cfg), L = lim(cfg), now = nowOf(cfg), msgs = [];
  const st = load(P, now);
  const live = opts.liveCases ? new Set(opts.liveCases) : null;
  if (!opts.dry) for (const a of Object.values(st.accounts)) {
    if (a.status === 'queued' && live && !live.has(a.queuedCase)) { a.status = 'open'; delete a.queuedCase; a.retryAt = now + L.INVOICE_RETRY_MS; msgs.push(`счёт ${a.slug}: случай-счёт пропал из очереди, снова через ${r1(L.INVOICE_RETRY_MS / H)} ч`); }
    if (a.status === 'invoiced') {
      const s = reqState(P, a.request, now, L);
      const h = a.history[a.history.length - 1];
      if (s === 'done') {
        const paid = a.request.kind === 'skill' ? (mtime(path.join(P.requests, a.request.name + '.done.md')) || now) : now;
        a.status = 'watching'; a.paidAt = Math.min(paid, now); a.resetAt = a.paidAt;
        if (h) h.outcome = 'сделано, смотрим 48 ч';
        msgs.push(`счёт ${a.slug}: заявка ${reqLabel(a.request)} сделана — смотрим 48 ч`);
      } else if (s === 'missing' || s === 'stale') {
        a.status = 'open'; if (h && h.outcome === 'ждёт инженера') h.outcome = s === 'stale' ? 'снята' : 'заявки нет';
        msgs.push(`счёт ${a.slug}: заявки ${reqLabel(a.request)} больше нет — снова копится`);
      } else if (s === 'open') {
        const bal = balance(a, now, L);
        if (bal < L.STALE_BALANCE && now - (lastAt(a) || a.invoicedAt || 0) >= L.STALE_QUIET_MS) {
          if (markStale(P, a, bal, now)) {
            a.status = 'closed'; a.closedAt = now; a.note = 'муха справилась сама';
            if (h) h.outcome = 'снята: муха справилась сама';
            msgs.push(`счёт ${a.slug}: заявка ${reqLabel(a.request)} снята — муха справилась сама`);
          }
        }
      }
    }
    if (a.status === 'watching' && now - (a.paidAt || 0) >= L.WATCH_MS && !(a.postings || []).some(p => p.t > a.paidAt)) {
      a.status = 'closed'; a.closedAt = now; a.redo = false; a.note = 'помогло';
      const h = a.history[a.history.length - 1]; if (h) h.outcome = 'помогло';
      msgs.push(`счёт ${a.slug}: 48 ч тишины — закрыт`);
    }
  }
  const load0 = engineerLoad(P, st, now, L);
  // ПОВТОР: инженер завален, а по открытой заявке пришли новые доказательства — дописать их в заявку (не в работе сейчас)
  if (!opts.dry && load0.n >= L.REPEAT_MIN_LOAD) {
    for (const a of Object.values(st.accounts)) {
      if (a.status !== 'invoiced') continue;
      const fresh = (a.postings || []).filter(p => p.t > (a.repeatedUpTo || a.invoicedAt || 0));
      if (!fresh.length || reqState(P, a.request, now, L) !== 'open') continue;
      try { if (appendRepeat(P, a, fresh, balance(a, now, L), now)) { a.repeatedUpTo = now; msgs.push(`счёт ${a.slug}: ПОВТОР в ${reqLabel(a.request)} (+${fresh.length})`); } } catch (e) { msgs.push(`счёт ${a.slug}: ПОВТОР не записан: ${e.message}`); }
    }
  }
  // выставление: баланс ≥ порога при нынешней загрузке; каждый поставленный счёт сам добавляет загрузку
  let n = load0.n; const due = [];
  const cands = Object.values(st.accounts).filter(a => (a.status === 'open') && !(a.retryAt > now)).map(a => ({ a, bal: balance(a, now, L) })).sort((x, y) => y.bal - x.bal);
  for (const { a, bal } of cands) {
    const thr = threshold(n, a.redo, L);
    if (thr == null || bal < thr) continue;
    const info = { slug: a.slug, title: a.title, kind: a.kind, balance: r1(bal), threshold: thr, redo: !!a.redo, load: n };
    if (opts.enqueue) {
      const id = opts.enqueue(a, info);
      if (!id) continue;
      a.status = 'queued'; a.queuedCase = id; a.queuedAt = now;
      msgs.push(`счёт ${a.slug}: ${Math.round(bal)} мин ≥ порога ${thr} (L=${n}) — учителю случай-счёт ${id}`);
    }
    due.push(info); n++;
  }
  if (!opts.dry && msgs.length) writeJson(P.state, st);   // пишем только если что-то изменилось
  return { ok: true, load: load0.n, threshold: threshold(load0.n, false, L), due, msgs };
}
const sweep = (cfg = {}) => tick(cfg, {});
const due = (cfg = {}) => { const r = tick(cfg, { dry: true }); return { ok: true, load: r.load, threshold: r.threshold, due: r.due }; };

// ---------- выписки для учителя и аудита ----------
const statusRu = a => STATUS_RU[a.status] + (a.redo && a.status !== 'watching' ? ' (не помогло)' : '');
// короткая выписка в материалы обычного случая: сначала живые счета по балансу, потом недавно закрытые
function statement(cfg = {}) {
  const P = paths(cfg), L = lim(cfg), now = nowOf(cfg);
  const st = load(P, now);
  const all = Object.values(st.accounts).map(a => ({ a, bal: balance(a, now, L) }));
  const liveA = all.filter(x => x.a.status !== 'closed').sort((x, y) => y.bal - x.bal);
  const closed = all.filter(x => x.a.status === 'closed').sort((x, y) => lastAt(y.a) - lastAt(x.a));
  return liveA.concat(closed).slice(0, L.STATEMENT_MAX).map(({ a, bal }) => ({
    slug: a.slug, title: a.title, kind: a.kind, balance: r1(bal), status: statusRu(a),
    evidence: (a.postings || []).slice(-L.STATEMENT_EVIDENCE).map(p => short(p.ev, 160))
  }));
}
// материалы случая-счёта: всё, что нужно для одной сильной заявки
function invoiceMaterial(cfg = {}, slug) {
  const P = paths(cfg), L = lim(cfg), now = nowOf(cfg);
  const st = load(P, now), a = st.accounts[slug];
  if (!a) return null;
  const ps = (a.postings || []).filter(p => p.t > (a.resetAt || 0));
  const top = new Set(ps.slice().sort((x, y) => y.min - x.min).slice(0, 3).concat(ps.slice(-2)));
  const ld = engineerLoad(P, st, now, L);
  const past = (a.history || []).map(h => {
    let answer = null;
    if (h.kind === 'skill' && h.name) answer = short(((readText(path.join(P.requests, h.name + '.done.md')) || '').split(/\r?\n/).find(l => l.trim()) || '').replace(/^#+\s*/, ''), 160) || null;
    return { request: h.request, at: new Date(h.at).toISOString(), redo: !!h.redo, outcome: h.outcome, answer };
  });
  const prev = (a.history || []).filter(h => h.kind === 'skill' && h.name).pop();
  const suggest = a.redo && prev ? prev.name : a.kind === 'core' ? null : (a.kind === 'behavior' && !/^behavior_/.test(a.slug) ? 'behavior_' + a.slug : a.slug);
  return {
    slug: a.slug, title: a.title, kind: a.kind, balance: r1(balance(a, now, L)), threshold: threshold(Math.max(0, ld.n - 1), a.redo, L), load: ld.n,
    trend: trend(a, now), redo: !!a.redo,
    postings: ps.filter(p => top.has(p)).map(p => ({ at: new Date(p.t).toISOString(), min: p.min, caseId: p.caseId, type: p.type, evidence: p.ev })),
    pastRequests: past,
    where: a.kind === 'core' ? 'brain/core_requests.md' : 'brain/skill_requests/' + suggest + '.md',
    ...(a.redo && prev ? { redoOf: prev.name + '.md' } : {})
  };
}
// для аудита (вкладка «Бухгалтерия») и CLI status
function status(cfg = {}) {
  const P = paths(cfg), L = lim(cfg), now = nowOf(cfg);
  const exists = fs.existsSync(P.state);
  const st = load(P, now), ld = engineerLoad(P, st, now, L);
  const accounts = Object.values(st.accounts).map(a => ({
    slug: a.slug, title: a.title, kind: a.kind, status: a.status, statusRu: statusRu(a), redo: !!a.redo,
    balance: r1(balance(a, now, L)), threshold: threshold(ld.n, a.redo, L), day: (a.postings || []).filter(p => now - p.t <= 24 * H).length,
    lastAt: lastAt(a) || null, request: a.request ? reqLabel(a.request) : null, note: a.note || null
  })).sort((x, y) => (x.status === 'closed') - (y.status === 'closed') || y.balance - x.balance);
  return { ok: true, exists, recovered: st.recovered || null, load: ld.n, loadParts: { skill: ld.skill.length, core: ld.core.length, queued: ld.queued.length },
    threshold: threshold(ld.n, false, L), thresholds: L.THRESHOLDS, halfLifeH: L.HALF_LIFE_MS / H, accounts };
}

// CLI post: отчёт вручную (случай берётся из очереди учителя, если есть)
function postCli(cfg, caseId, reportFile) {
  const text = readText(reportFile);
  if (text == null) return { ok: false, error: 'нет отчёта ' + reportFile };
  let c = null; try { c = (JSON.parse(fs.readFileSync(path.join(paths(cfg).dataDir, 'teacher_queue.json'), 'utf8')).cases || []).find(x => x.id === caseId); } catch (e) {}
  const info = c ? { id: c.id, type: c.type, items: c.items, startedAt: c.startedAt, coreIds: c.coreIds, slug: c.slug } : { id: caseId, type: 'other', items: [] };
  return { ok: true, ...caseFinished(cfg, info, 'done', text) };
}

module.exports = { DEFAULTS, STATUS_RU, paths, load, parsePostings, price, balance, threshold, engineerLoad, skillReqState, pickable,
  caseFinished, tick, sweep, due, statement, invoiceMaterial, status, coreIds };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  let r;
  try {
    if (cmd === 'post') r = postCli({}, a, b);
    else if (cmd === 'due') r = due();
    else if (cmd === 'status') r = status();
    else if (cmd === 'sweep') r = sweep();
    else r = { ok: false, error: 'команды: post <caseId> <reportFile> | due | status | sweep' };
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  // только ASCII: PowerShell читает вывод в своей кодировке
  process.stdout.write(JSON.stringify(r).replace(/[\u0080-￿]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
}
