// Итог игрового дня: сколько блоков поставлено, что добыто, смерти, пройдено, выученные навыки.
// Копим за сутки (смена bot.time.day) и в конце дня: строка в data/days.log (JSON), одна строка в чат (до 200 символов),
// событие day_report, поле day в /snapshot (сегодня и вчера кратко). Состояние живёт в data/daylog.json (переживает рестарт тела).
// Установка блоков считаем на общем слое — событие mineflayer blockPlaced (place_at, укрытия, мосты, стройки выученных навыков —
// всё в итоге идёт через bot.placeBlock); добычу — обёртка bot.dig. «Построено» = блоки, поставленные навыком place_at
// (и старыми командами place/platform); всё остальное (укрытие, столбы, мосты, подпорки пути, факелы) — «служебные», отдельным числом.
'use strict';
const fs = require('fs');
const path = require('path');

const SKILLS_STATS = path.join(__dirname, '..', 'brain', 'skills_stats.json');
const SAVE_MS = 30000;
const LINE_MAX = 200;
const IGNORE_MINED = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'seagrass', 'tall_seagrass', 'fire']);
const BUILD_TASKS = new Set(['place_at']); // имена навыков тела, чьи блоки — «стройка»

const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return (m >= 11 && m <= 14) ? c : k === 1 ? a : (k >= 2 && k <= 4) ? b : c; };
const topN = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
const listStr = (obj, n) => topN(obj, n).map(([k, v]) => `${k} ${v}`).join(', ');
const sum = obj => Object.values(obj || {}).reduce((s, v) => s + v, 0);

function readSkills(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v && typeof v === 'object') out[k] = { ok: Number(v.ok) || 0, fail: Number(v.fail) || 0 };
    return out;
  } catch (e) { return null; }
}

function fresh(ctx, day, tod) {
  return {
    day, t0: Date.now(), startTod: tod || 0, restarts: 0,
    built: 0, builtItems: {}, aux: 0, auxItems: {},
    mined: {}, deaths: 0, lost: {},
    dist0: Math.round(ctx.stats && ctx.stats.distanceTraveled || 0),
    skills0: readSkills(ctx.daylogSkillsFile || SKILLS_STATS)
  };
}

// Итог из состояния (чистая функция)
function summarize(ctx, s, skillsNow) {
  const dist = Math.max(0, Math.round((ctx.stats && ctx.stats.distanceTraveled || 0) - s.dist0));
  let sk = null;
  if (s.skills0 && skillsNow) {
    sk = { ok: 0, fail: 0, by: {} };
    for (const [name, v] of Object.entries(skillsNow)) {
      const b = s.skills0[name] || { ok: 0, fail: 0 };
      const dok = Math.max(0, v.ok - b.ok), dfail = Math.max(0, v.fail - b.fail);
      if (dok || dfail) { sk.ok += dok; sk.fail += dfail; sk.by[name] = [dok, dfail]; }
    }
  }
  return {
    day: s.day, built: s.built, builtItems: s.builtItems, aux: s.aux, auxItems: s.auxItems,
    mined: s.mined, minedTotal: sum(s.mined), deaths: s.deaths, lost: s.lost, lostTotal: sum(s.lost),
    dist, skills: sk, partial: (s.startTod || 0) > 1200, restarts: s.restarts || 0
  };
}

// Строка для чата: «День N: построено X блоков (…), добыто …, смертей Y» — всегда до 200 символов
function formatLine(r) {
  const build = (items) => {
    let t = `построено ${r.built} ${plural(r.built, 'блок', 'блока', 'блоков')}`;
    if (r.built > 0 && items > 0) t += ` (${listStr(r.builtItems, items)})`;
    if (r.aux > 0) t += `, служебных +${r.aux}`;
    return t;
  };
  const mined = n => r.minedTotal > 0 ? `добыто ${listStr(r.mined, n)}` : 'добыто ничего';
  const dead = () => `смертей ${r.deaths}` + (r.deaths > 0 && r.lostTotal > 0 ? ` (выпало ${r.lostTotal} предм.)` : '');
  const head = `День ${r.day}${r.partial ? ' (неполный)' : ''}: `;
  const tries = [];
  for (const [items, mn, extra] of [[3, 5, true], [3, 5, false], [2, 4, false], [1, 3, false], [0, 3, false], [0, 2, false], [0, 1, false]]) {
    const parts = [build(items), mined(mn), dead()];
    if (extra) {
      parts.push(`прошла ${r.dist} бл`);
      if (r.skills && (r.skills.ok || r.skills.fail)) parts.push(`навыки ok ${r.skills.ok}/провал ${r.skills.fail}`);
    }
    tries.push(head + parts.join(', '));
  }
  for (const t of tries) if (t.length <= LINE_MAX) return t;
  return tries[tries.length - 1].slice(0, LINE_MAX - 1) + '…';
}

function create(ctx) {
  const dir = () => ctx.dataDir || path.join(__dirname, '..', 'data');
  const file = () => path.join(dir(), 'daylog.json');
  const logFile = () => path.join(dir(), 'days.log');
  const dl = { state: null, last: null, dirty: false, lastReport: null };

  // ---- сохранение ----
  dl.save = () => {
    if (!dl.dirty) return;
    dl.dirty = false;
    try {
      fs.mkdirSync(dir(), { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ cur: dl.state, last: dl.last }));
      fs.renameSync(tmp, file());
    } catch (e) { /* не критично */ }
  };
  dl.load = () => {
    try {
      const o = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (o && o.cur && typeof o.cur === 'object' && o.cur.day != null) { dl.state = o.cur; dl.state.restarts = (dl.state.restarts || 0) + 1; }
      if (o && o.last) dl.last = o.last;
    } catch (e) {}
  };

  // ---- накопление ----
  const need = () => { if (!dl.state) dl.state = fresh(ctx, null, 0); return dl.state; };
  const bump = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };

  // кто сейчас строит: навык place_at (или старая команда тела place/platform) — стройка; остальное — служебное
  dl.isBuilding = () => {
    const T = ctx.tasks; if (!T) return false;
    if (T.current) return BUILD_TASKS.has(T.current.name);
    return T.legacyBusy > 0;
  };
  dl.onPlaced = name => {
    if (!name || name === 'air') return;
    const s = need();
    if (!/torch/.test(name) && dl.isBuilding()) { s.built++; bump(s.builtItems, name); }
    else { s.aux++; bump(s.auxItems, name); }
    dl.dirty = true;
  };
  dl.onMined = name => {
    if (!name || IGNORE_MINED.has(name)) return;
    bump(need().mined, name); dl.dirty = true;
  };
  dl.onDeath = items => {
    const s = need(); s.deaths++;
    for (const i of items || []) if (i && i.name && i.count > 0) bump(s.lost, i.name, i.count);
    dl.dirty = true; dl.save();
  };

  // ---- смена суток ----
  dl.finishDay = (newDay, newTod) => {
    const s = need();
    const r = summarize(ctx, s, readSkills(ctx.daylogSkillsFile || SKILLS_STATS));
    const line = formatLine(r);
    const rec = { t: new Date().toISOString(), ...r, line };
    try { fs.mkdirSync(dir(), { recursive: true }); fs.appendFileSync(logFile(), JSON.stringify(rec) + '\n'); } catch (e) {}
    dl.last = { day: r.day, line, built: r.built, aux: r.aux, deaths: r.deaths, minedTotal: r.minedTotal, dist: r.dist, partial: r.partial };
    dl.lastReport = rec;
    try { if (ctx.ready && ctx.bot) ctx.bot.chat(line.replace(/^\/+/, '').slice(0, LINE_MAX)); } catch (e) {}
    try {
      ctx.events.push('day_report', { day: r.day, line, built: r.built, aux: r.aux, builtItems: topN(r.builtItems, 5).map(([k, v]) => `${k} ${v}`),
        mined: topN(r.mined, 5).map(([k, v]) => `${k} ${v}`), deaths: r.deaths, lostTotal: r.lostTotal, dist: r.dist, skills: r.skills, partial: r.partial,
        ...(r.built === 0 ? { warn: 'стройка за день не сдвинулась: 0 блоков построено' } : {}) });
    } catch (e) {}
    dl.state = fresh(ctx, newDay, newTod);
    dl.dirty = true; dl.save();
    return rec;
  };
  // вызывать на каждое обновление времени
  dl.onTime = bot => {
    const t = bot && bot.time; if (!t) return;
    const day = Number(t.day); if (!Number.isFinite(day)) return;
    const tod = Number(t.timeOfDay) || 0;
    const s = dl.state;
    if (!s) { dl.state = fresh(ctx, day, tod); dl.dirty = true; return; }
    if (s.day == null) { s.day = day; s.startTod = tod; dl.dirty = true; return; } // накопленное до первого пакета времени не теряем
    if (day !== s.day) dl.finishDay(day, tod);
  };

  // ---- для /snapshot ----
  dl.today = () => {
    const s = need(); const r = summarize(ctx, s, null);
    return {
      day: s.day, built: r.built, aux: r.aux, builtItems: listStr(r.builtItems, 3) || null, mined: listStr(r.mined, 3) || null,
      minedTotal: r.minedTotal, deaths: r.deaths, dist: r.dist,
      line: `день ${s.day}: построено ${r.built}${r.aux ? ` (+${r.aux} служебных)` : ''}, добыто ${r.minedTotal ? listStr(r.mined, 3) : 'ничего'}, смертей ${r.deaths}`
    };
  };
  dl.decorate = snap => {
    try { snap.day = { today: dl.today(), yesterday: dl.last ? { day: dl.last.day, built: dl.last.built, deaths: dl.last.deaths, line: dl.last.line } : null }; } catch (e) {}
    return snap;
  };

  dl.load();
  return dl;
}

function decorate(ctx, snap) { return ctx.daylog ? ctx.daylog.decorate(snap) : snap; }

// Один раз на экземпляр бота (из bot.js). Состояние ctx.daylog живёт между переподключениями.
function attach(ctx, session) {
  const bot = session.bot || ctx.bot;
  const dl = ctx.daylog || (ctx.daylog = create(ctx));
  bot.on('blockPlaced', (oldBlock, newBlock) => { try { dl.onPlaced(newBlock && newBlock.name); } catch (e) {} });
  if (typeof bot.dig === 'function' && !bot.__daylogDig) {
    bot.__daylogDig = true;
    const orig = bot.dig;
    bot.dig = function (block, ...rest) {
      const name = block && block.name;
      return Promise.resolve(orig.call(this, block, ...rest)).then(r => { try { dl.onMined(name); } catch (e) {} return r; });
    };
  }
  bot.on('death', () => { try { dl.onDeath(bot.inventory ? bot.inventory.items() : []); } catch (e) {} });
  const tick = () => { try { dl.onTime(bot); } catch (e) { console.log('[daylog]', e && e.message); } };
  bot.on('time', tick);
  bot.on('spawn', tick);
  session.timers.push(setInterval(() => { if (!session.ended) dl.save(); }, SAVE_MS));
  return dl;
}

module.exports = { attach, create, decorate, summarize, formatLine, readSkills, plural, IGNORE_MINED };
