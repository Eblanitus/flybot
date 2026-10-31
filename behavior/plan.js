// Очередь «## План» в brain/notes.md (v0.3, шаг 3: работа без мозга). Пишут хозяин и Claude (и мозг, если включён), тело notes.md
// НЕ пишет: оно только читает очередь и ведёт свою память о пунктах в data/autopilot_plan.json (вне git).
//   ## План
//   - [ ] stair_down_2 -415 50 21 rot=0 | пролёт 2             <- «Постройка:» без слова «Постройка:»
//   - [ ] Автопилот: farm_plot x=-388 y=67 z=40 size=5          <- микроцель, как строка «Автопилот:» в «Текущей цели»
//   - [x] base_pad -393 67 36 rot=0                             <- [x] готово, [-] пропуск (ставят люди или мозг)
// Текст после « | » — комментарий. Строку разбирают готовые parseBuild / parseGoal ядра (lib/basegoal.js) на подставленном тексте.
// Здесь чистые функции (parsePlan, planPick, planStatus — проверяются без бота) и чтение/запись памяти пунктов.
// Встраивание — refreshGoal в behavior/autopilot.js: дальше работает прежняя машина buildSt / goal без изменений.
'use strict';
const fs = require('fs');
const L = require('./core');
const { parseGoal, parseBuild } = L('basegoal');
const T = require('./thresholds');

// ---------- разбор ----------
// заголовок раздела: «## План» (не «## Планы» и не «## Планирование»)
const HEAD = /^##\s*План(?![A-Za-zА-Яа-яЁё0-9_])/;
const ITEM = /^\s*[-*]\s*\[([ xXхХ\-])\]\s*(.*)$/;   // допустимы и русская «х», раз хозяин печатает с русской раскладкой
const CMT = /\s\|(?:\s|$)/;                           // « | комментарий»

// txt -> { found, items: [{ n, mark:' '|'x'|'-', raw, comment, kind:'build'|'goal'|null, build?, goal?, sig, bad?, reason? }] }
// found — раздел «## План» есть в тексте (пустой раздел = пустая очередь). Пункт без разбора -> bad (+ reason), sig 'bad:<строка>'.
function parsePlan(txt) {
  const lines = String(txt || '').split(/\r?\n/);
  const i0 = lines.findIndex(l => HEAD.test(l));
  if (i0 < 0) return { found: false, items: [] };
  const items = [];
  for (let i = i0 + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = ITEM.exec(lines[i]);
    if (!m) continue;
    const mark = m[1] === ' ' ? ' ' : m[1] === '-' ? '-' : 'x';
    const raw = lines[i].trim();
    let body = m[2], comment = '';
    const c = CMT.exec(body);
    if (c) { comment = body.slice(c.index + c[0].length).trim(); body = body.slice(0, c.index); }
    body = body.trim();
    const it = { n: items.length, mark, raw, comment, kind: null, sig: 'bad:' + raw };
    if (!body) { it.bad = true; it.reason = 'пустая строка'; items.push(it); continue; }
    if (/^[\s>*_`-]*Автопилот\s*:/i.test(body)) {
      const g = parseGoal('## Текущая цель\n' + body);
      if (g) { it.kind = 'goal'; it.goal = g; it.sig = g.sig; } else { it.bad = true; it.reason = 'не разобрать «Автопилот:» (нужно: Автопилот: навык ключ=значение …)'; }
    } else {
      const b = parseBuild('## Текущая цель\nПостройка: ' + body.replace(/^[\s>*_`-]*Постройка\s*:[\s*]*/i, ''));
      if (b) { it.kind = 'build'; it.build = b; it.sig = b.sig; } else { it.bad = true; it.reason = 'не разобрать «чертёж x y z [rot=…]»'; }
    }
    items.push(it);
  }
  return { found: true, items };
}

// ---------- память пунктов ----------
// st: { items: { sig: { status:'done'|'failed'|'skipped', at, reason, pauses } }, list: [строки пунктов — последняя копия], doneAt: мс последнего build_done }
const emptyPlan = () => ({ items: {}, list: [], doneAt: 0 });
function loadPlan(file) {
  const st = emptyPlan();
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object') {
      if (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) st.items = o.items;
      if (Array.isArray(o.list)) st.list = o.list.filter(s => typeof s === 'string');
      st.doneAt = Number(o.doneAt) || 0;
    }
  } catch (e) {}
  return st;
}
function savePlan(file, st) {
  if (!file) return false;
  try {
    const tmp = file + '.tmp-' + process.pid;
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}
// отметить пункт: status 'done' | 'failed' | 'open' (открыт, но уже были неудачи — pauses подряд)
function mark(st, sig, status, reason, now, pauses) {
  st.items[sig] = { status, at: now, reason: reason ? String(reason).slice(0, 160) : '', pauses: pauses || 0 };
}
// пункты, которых уже нет ни в списке, ни в копии, не копим бесконечно: остаются только sig из list (+ текущие), не старше 30 суток
function prune(st, sigs, now) {
  let n = 0;
  for (const [k, v] of Object.entries(st.items)) {
    if (!sigs.has(k) && now - (Number(v && v.at) || 0) > 30 * 86400000) { delete st.items[k]; n++; }
  }
  return n;
}

// Какой список считать: раздел есть в notes.md — он (и копия обновляется); раздела нет (мозг переписал файл) — последняя копия.
// -> { items, copy:boolean, changed:boolean (копию надо записать) }
function planList(txt, st) {
  const p = parsePlan(txt);
  if (p.found) {
    const list = p.items.map(i => i.raw);
    const changed = list.length !== st.list.length || list.some((s, k) => s !== st.list[k]);
    return { items: p.items, copy: false, changed, list };
  }
  const c = parsePlan('## План\n' + st.list.join('\n'));
  return { items: c.items, copy: true, changed: false, list: st.list };
}

// ---------- выбор ----------
// Закрыт ли пункт по памяти: done — навсегда; failed — до повтора (planRetryMs)
const retryDue = (e, now) => !!e && e.status === 'failed' && now - (e.at || 0) >= T.planRetryMs;
const closedBy = (e, now) => !!e && (e.status === 'done' || (e.status === 'failed' && !retryDue(e, now)));

// Чистая функция: что делает муха по цели — порядок:
//  1) «Постройка:» из «Текущей цели» (own), если она не готова и не провалена;
//  2) первый пункт `[ ]` очереди, ещё не готовый / проваленный (пропуск — пока чертежа или навыка нет — не навсегда: veto проверяется заново);
//     мозг включён — после build_done planBrainWaitMs ждём, не поставит ли он новую «Постройку»;
//  3) проваленное — повтор: пункт старше planRetryMs берётся в свой черёд (выше), иначе, когда открытых не осталось,
//     — не чаще раза в planRetryIdleMs;
//  4) «Автопилот:» из «Текущей цели» (как до очереди).
// p: { own, goal, items, state, now, brainOn, veto?(item)->{status,reason}|null }
// -> { via:'build'|'plan'|'goal'|null, build?, goal?, item?, retry?, waitMs?, skipped:[{item, reason}] }
// (retry: true — пункт уже проваливался, его пора начинать с чистого листа)
function planPick(p) {
  const { own, goal, items, state, now } = p;
  const st = state || emptyPlan();
  const skipped = [];
  const fallback = extra => ({ via: goal ? 'goal' : null, ...(goal ? { goal } : {}), skipped, ...extra });
  // 1) своя «Постройка:»
  if (own) {
    const e = st.items[own.sig];
    if (!closedBy(e, now)) return { via: 'build', build: own, retry: retryDue(e, now), skipped };
  }
  // 2) очередь
  let waitMs = 0;
  if (p.brainOn && st.doneAt && now - st.doneAt < T.planBrainWaitMs) waitMs = T.planBrainWaitMs - (now - st.doneAt);
  const open = [];
  for (const it of items || []) {
    if (it.mark !== ' ') continue;
    if (it.bad) { skipped.push({ item: it, reason: it.reason }); continue; }
    const e = st.items[it.sig];
    if (closedBy(e, now)) continue;
    const v = typeof p.veto === 'function' ? p.veto(it) : null;
    if (v) { skipped.push({ item: it, reason: v.reason }); continue; }
    open.push({ it, retry: retryDue(e, now) });
  }
  if (waitMs > 0) return fallback({ waitMs });
  const pickOf = (it, retry) => it.kind === 'build'
    ? { via: 'plan', build: it.build, item: it, retry, skipped }
    : { via: 'plan', goal: it.goal, item: it, retry, skipped };
  if (open.length) return pickOf(open[0].it, open[0].retry);
  // 3) открытых нет — повтор проваленного (своя «Постройка:» первой), не чаще planRetryIdleMs
  const stale = e => e && e.status === 'failed' && now - (e.at || 0) >= T.planRetryIdleMs;
  if (own && stale(st.items[own.sig])) return { via: 'build', build: own, retry: true, skipped };
  for (const it of items || []) {
    if (it.mark !== ' ' || it.bad || !stale(st.items[it.sig])) continue;
    const v = typeof p.veto === 'function' ? p.veto(it) : null;
    if (v) continue;
    return pickOf(it, true);
  }
  return fallback({});
}

// краткая подпись пункта для журнала и статуса
const label = it => it ? (it.kind === 'build' ? `${it.build.name} ${it.build.x} ${it.build.y} ${it.build.z}${it.build.rot ? ' rot=' + it.build.rot : ''}`
  : it.kind === 'goal' ? `Автопилот: ${it.goal.name}` : it.raw.replace(/^[-*]\s*\[.\]\s*/, '')) : '';

// статус очереди для /snapshot → autopilot.plan (видят аудит и учитель)
function planStatus(p) {
  const { items, state, now, pick } = p, st = state || emptyPlan();
  const out = { open: 0, done: 0, failed: 0, skipped: 0, total: (items || []).length };
  const failed = [], skipSigs = new Set(pick && pick.skipped ? pick.skipped.map(s => s.item.sig) : []);
  for (const it of items || []) {
    const e = st.items[it.sig];
    if (it.mark === 'x' || (e && e.status === 'done')) out.done++;
    else if (it.mark === '-') out.skipped++;
    else if (it.bad || skipSigs.has(it.sig)) out.skipped++;
    else if (e && e.status === 'failed') { out.failed++; failed.push(`${label(it)}: ${e.reason || 'провал'}`); }
    else out.open++;
  }
  if (failed.length) out.failedItems = failed.slice(0, 5);
  if (p.copy) out.source = 'копия (раздела в notes.md нет)';
  if (pick) {
    out.now = pick.via === 'plan' ? label(pick.item) : pick.via === 'build' ? 'Постройка: ' + label({ kind: 'build', build: pick.build }) : pick.via === 'goal' ? 'Автопилот из «Текущей цели»' : null;
    if (pick.waitMs > 0) out.brainWaitSec = Math.round(pick.waitMs / 1000);
    if (pick.skipped && pick.skipped.length) out.skippedItems = pick.skipped.slice(0, 5).map(s => `${label(s.item)}: ${s.reason}`);
  }
  return out;
}

module.exports = { parsePlan, planPick, planStatus, planList, loadPlan, savePlan, emptyPlan, mark, prune, closedBy, retryDue, label };
