// Чёрный ящик (ядро): кольцевой буфер последних ~60 с жизни мухи. Кадр — раз в секунду и на важных событиях (урон, начало/конец
// задачи, сигнал опасности). В кадре только то, что муха честно знает: позиция, HP, еда, воздух, блоки у ног, «время до смерти»
// из lib/danger.js, текущая задача и КТО её отдал, мобы рядом (как в perception — без рентгена), последний урон, предмет в руке.
// Ящик только записывает факты, решений в нём нет.
//   Смерть        -> ящик замораживается, пишется data/blackbox/death-<время>.json (кадры + итог + что было в инвентаре = потеряно).
//   Почти-смерть  -> near-<время>.json: HP <= 4 или worst.ttdSec <= 3, а муха выжила >= 10 с. Серия таких моментов (с промежутками
//                    меньше 60 с) склеивается в один файл — чаще одной записи в 60 с не бывает.
// Событие blackbox_saved (с путём к файлу) уходит в events.log. Файлов не больше MAX_FILES, старые удаляются (только свои death-/near-).
// Файлы в data/blackbox — кэш для разбора, а не данные хозяина.
'use strict';
const fs = require('fs');
const path = require('path');
const { r1 } = require('./util');
const bf = require('./blackbox_files');
const danger = require('./danger');
const { entitiesNear, timeInfo } = require('./perception');

const DEFAULTS = {
  KEEP_MS: 60000,          // сколько хранит кольцевой буфер
  TICK_MS: 1000,           // обычный кадр — раз в секунду
  MIN_GAP_MS: 200,         // кадры по событиям не чаще (урон от толпы не раздувает буфер)
  MAX_FILES: 200,          // сколько файлов хранить
  NEAR_HP: 4,              // почти-смерть: HP <= 4
  NEAR_TTD: 3,             // ... или до смерти осталось <= 3 с
  NEAR_SURVIVE_MS: 10000,  // муха должна выжить столько после последнего такого момента
  NEAR_GAP_MS: 60000,      // запись не чаще раза в это время: новая серия в этот срок дописывается в прежний файл
  SERIES_MAX_FRAMES: 1200, // серия не растёт бесконечно
  DEATH_WAIT_MS: 5000      // ждём событие death (причина) после смерти; не пришло — пишем с тем, что есть
};
const { FILE_RE } = bf;
const TTD_KINDS = ['air', 'fire', 'lava', 'hunger', 'fall', 'damage', 'void'];

const safe = (fn, def = null) => { try { const v = fn(); return v === undefined ? def : v; } catch (e) { return def; } };

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Предметы, которые есть у мухи: инвентарь + броня + вторая рука (items() их не отдаёт) -> { имя: сколько }
function invCounts(bot) {
  const m = {};
  const add = it => { if (it && it.name) m[it.name] = (m[it.name] || 0) + (it.count || 1); };
  safe(() => bot.inventory.items().forEach(add));
  safe(() => [5, 6, 7, 8, 45].forEach(i => add(bot.inventory.slots[i])));
  return m;
}

// Кто сейчас двигает тело: задача (с источником) или простая команда
function taskNow(ctx, now) {
  const tm = ctx.tasks; if (!tm) return null;
  const t = tm.current;
  if (t) return { id: t.id, name: t.name, by: t.by || t.source || 'brain', source: t.source || 'brain', status: t.status, sec: Math.round((now - t.started) / 1000), ...(t.progressText ? { progress: String(t.progressText).slice(0, 80) } : {}) };
  if (tm.legacy) return { name: 'простая команда: ' + tm.legacy.name, by: tm.legacy.by, legacy: true, sec: Math.round((now - tm.legacy.since) / 1000) };
  return null;
}

// Один кадр. Каждое поле берётся отдельно: сбой одного датчика не губит кадр.
function makeFrame(ctx, why, t) {
  const bot = ctx.bot;
  const fr = { t, why };
  if (!bot || !bot.entity) return fr;
  const p = bot.entity.position;
  fr.pos = [r1(p.x), r1(p.y), r1(p.z)];
  fr.hp = r1(bot.health); fr.food = bot.food;
  let st = null, dg = null;
  try { st = danger.state(ctx); dg = danger.compute(st); } catch (e) {}
  if (dg) {
    fr.air = { under: !!dg.air.underWater, sec: dg.air.airSec };
    const feet = st.feet, head = st.head;
    fr.env = { feet, head, below: safe(() => { const b = bot.blockAt(p.offset(0, -1, 0)); return b ? b.name : null; }) };
    fr.fire = !!(dg.fire.inFire || dg.fire.burning);
    fr.water = feet === 'water' || head === 'water' || feet === 'bubble_column';
    fr.lava = !!dg.lava.inLava;
    fr.ttd = {}; for (const k of TTD_KINDS) fr.ttd[k] = dg[k] ? dg[k].ttdSec : null;
    fr.worst = dg.worst || null;
  }
  fr.task = taskNow(ctx, t);
  const ents = safe(() => entitiesNear(bot, 24), null);
  if (ents) fr.mobs = ents.enemies.map(e => ({ kind: 'враг', name: e.name, d: e.d, dir: e.dir })).concat(ents.players.slice(0, 3).map(e => ({ kind: 'игрок', name: e.name, d: e.d, dir: e.dir })));
  const ld = ctx.lastDamage, hl = ctx.hurtLog;
  if (ld && t - ld.t <= 30000) fr.hurt = { cause: ld.cause || 'без источника', agoSec: r1((t - ld.t) / 1000), amount: hl && hl.length ? r1(hl[hl.length - 1].amount) : null };
  fr.held = safe(() => bot.heldItem ? bot.heldItem.name : null);
  const ti = safe(() => bot.time ? timeInfo(bot) : null);
  if (ti) { fr.day = ti.day; fr.phase = ti.phase; }
  return fr;
}

class BlackBox {
  // opts: { dir, now (функция времени для тестов), limits }
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.dir = opts.dir || path.join(ctx.dataDir || path.join(__dirname, '..', 'data'), 'blackbox');
    this.L = { ...DEFAULTS, ...(opts.limits || {}) };
    this.now = opts.now || (() => Date.now());
    this.frames = [];       // последние KEEP_MS
    this.frozen = null;     // после смерти: { frames, inv, held, timer, saved }
    this.series = null;     // открытая почти-смерть
    this.lastNearAt = 0;
    this.lastSaved = null;  // последняя запись почти-смерти: { name, rec, savedAt }
    this.inv = {}; this.held = null; this.armor = [];
    this.lastFrameAt = 0;
    this.sumCache = new Map();
  }

  // ---------- подключение к боту (один раз на экземпляр; таймеры живут в session) ----------
  attach(session) {
    const ctx = this.ctx, bot = ctx.bot;
    this.reset();
    const tm = setInterval(() => { if (ctx.bot === bot && ctx.ready && bot.entity) { try { this.tick(); } catch (e) {} } }, this.L.TICK_MS);
    session.timers.push(tm);
    let lastHp = null;
    bot.on('health', () => {
      try {
        if (lastHp != null && bot.health < lastHp) this.frame('урон');
        lastHp = bot.health;
      } catch (e) {}
    });
    bot.on('death', () => { try { this.freeze(); } catch (e) {} });
  }

  reset() {
    if (this.frozen && this.frozen.timer) clearTimeout(this.frozen.timer);
    this.frames = []; this.frozen = null; this.series = null; this.lastNearAt = 0;
  }

  // ---------- кадры ----------
  tick() { this.frame('тик', true); }

  frame(why, force = false) {
    if (this.frozen) return null;
    const ctx = this.ctx;
    if (!ctx.bot || !ctx.bot.entity) return null;
    const t = this.now();
    if (!force && t - this.lastFrameAt < this.L.MIN_GAP_MS) return null;
    this.lastFrameAt = t;
    const fr = makeFrame(ctx, why, t);
    this.inv = invCounts(ctx.bot); this.held = fr.held || null;
    this.armor = safe(() => [5, 6, 7, 8].map(i => ctx.bot.inventory.slots[i]).filter(Boolean).map(i => i.name), []);
    this.push(fr);
    this.watchNear(fr, t);
    return fr;
  }

  push(fr) {
    this.frames.push(fr);
    const cut = fr.t - this.L.KEEP_MS;
    while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
    if (this.series) { this.series.frames.push(fr); if (this.series.frames.length > this.L.SERIES_MAX_FRAMES) this.series.frames.shift(); }
  }

  // ---------- почти-смерть ----------
  isNear(fr) {
    if (!(fr.hp > 0)) return null;
    const why = [];
    if (fr.hp <= this.L.NEAR_HP) why.push('HP <= ' + this.L.NEAR_HP);
    if (fr.worst && fr.worst.ttdSec != null && fr.worst.ttdSec <= this.L.NEAR_TTD) why.push(`до смерти ${fr.worst.ttdSec} с (${fr.worst.kind})`);
    return why.length ? why : null;
  }

  watchNear(fr, t) {
    const why = this.isNear(fr);
    if (why) {
      this.lastNearAt = t;
      if (!this.series) this.openSeries(fr, t);
      const s = this.series;
      s.moments++;
      if (fr.hp < s.minHp) s.minHp = fr.hp;
      if (fr.worst && fr.worst.ttdSec != null && (!s.worst || fr.worst.ttdSec < s.worst.ttdSec)) s.worst = { ...fr.worst, t: fr.t };
      for (const w of why) if (!s.why.includes(w.replace(/[\d.]+ с/, 'N с'))) s.why.push(w.replace(/[\d.]+ с/, 'N с'));
    } else if (this.series && t - this.lastNearAt >= this.L.NEAR_SURVIVE_MS) {
      this.closeSeries(t);
    }
  }

  openSeries(fr, t) {
    const prev = this.lastSaved && t - this.lastSaved.savedAt < this.L.NEAR_GAP_MS ? this.lastSaved : null;
    let frames = this.frames.slice();
    if (prev) { // новая серия сразу после записанной: дописываем в тот же файл
      const have = new Set(prev.rec.frames.map(f => f.t));
      frames = prev.rec.frames.concat(frames.filter(f => !have.has(f.t)));
    }
    this.series = { firstAt: t, prev, frames, minHp: fr.hp, worst: null, why: [], moments: 0, first: fr };
  }

  closeSeries(t) {
    const s = this.series; this.series = null;
    if (!s) return null;
    const first = s.first;
    const prevSum = s.prev ? s.prev.rec.summary : null;
    const summary = {
      cause: 'почти-смерть (выжила)',
      startedAt: new Date(prevSum ? prevSum.startedAt_ms : s.firstAt).toISOString(), startedAt_ms: prevSum ? prevSum.startedAt_ms : s.firstAt,
      endedAt: new Date(t).toISOString(),
      minHp: prevSum ? Math.min(prevSum.minHp, s.minHp) : s.minHp,
      worst: s.worst && prevSum && prevSum.worst && prevSum.worst.ttdSec < s.worst.ttdSec ? prevSum.worst : (s.worst || (prevSum && prevSum.worst) || null),
      why: prevSum ? [...new Set(prevSum.why.concat(s.why))] : s.why,
      moments: (prevSum ? prevSum.moments : 0) + s.moments,
      series: (prevSum ? prevSum.series : 0) + 1,
      pos: prevSum ? prevSum.pos : first.pos || null,
      lastTask: prevSum ? prevSum.lastTask : (first.task || null),
      lastDamage: first.hurt || null,
      mobs: (first.mobs || []).slice(0, 5).map(m => m.name)
    };
    const rec = { v: 1, kind: 'near', savedAt: new Date(t).toISOString(), summary, frames: s.frames };
    let name;
    if (s.prev) name = s.prev.name; else name = this.freeName('near', t);
    if (!this.write(name, rec)) return null;
    this.lastSaved = { name, rec, savedAt: t };
    this.announce(name, rec, { merged: !!s.prev });
    return name;
  }

  // ---------- смерть ----------
  // Первое, что мы знаем о смерти: бот сообщил health<=0 (раньше события death с причиной от сервера)
  freeze() {
    if (this.frozen) return;
    const ctx = this.ctx, t = this.now();
    let last = null;
    if (ctx.bot && ctx.bot.entity) { try { last = makeFrame(ctx, 'смерть', t); } catch (e) {} }
    const frames = this.frames.slice(); if (last) frames.push(last);
    this.series = null; // серия поглощена смертью: всё это уже в кадрах смерти
    this.frozen = { t, frames, inv: { ...this.inv }, held: this.held, armor: this.armor.slice(), saved: false, timer: null };
    this.frozen.timer = setTimeout(() => { if (this.frozen && !this.frozen.saved) { try { this.saveDeath({}); } catch (e) {} } }, this.L.DEATH_WAIT_MS);
    if (this.frozen.timer.unref) this.frozen.timer.unref();
  }

  saveDeath(data) {
    const f = this.frozen; if (!f || f.saved) return null;
    f.saved = true; if (f.timer) clearTimeout(f.timer);
    const lastFr = f.frames.length ? f.frames[f.frames.length - 1] : null;
    const taskFr = f.frames.slice().reverse().find(x => x.task);
    const hurtFr = f.frames.slice().reverse().find(x => x.hurt);
    const items = f.inv, total = Object.values(items).reduce((a, n) => a + n, 0);
    const summary = {
      cause: data.cause || (hurtFr && hurtFr.hurt.cause) || 'неизвестно',
      message: data.message || null,
      pos: data.at || (lastFr && lastFr.pos) || null,
      phase: data.phase || (lastFr && lastFr.phase) || null,
      day: lastFr ? lastFr.day : null,
      deaths: data.deaths != null ? data.deaths : null,
      lastTask: taskFr ? taskFr.task : null,
      lastDamage: hurtFr ? hurtFr.hurt : null,
      worst: lastFr ? lastFr.worst || null : null,
      mobs: lastFr && lastFr.mobs ? lastFr.mobs.slice(0, 5).map(m => m.name) : []
    };
    const rec = { v: 1, kind: 'death', savedAt: new Date(f.t).toISOString(), summary, lost: { items, total, held: f.held, armor: f.armor }, frames: f.frames };
    const name = this.freeName('death', f.t);
    if (!this.write(name, rec)) return null;
    this.announce(name, rec, {});
    return name;
  }

  // ---------- события ядра (из bot.js) ----------
  onEvent(type, data) {
    switch (type) {
      case 'task_started': case 'task_done': case 'task_failed': case 'task_aborted': this.frame(type); break;
      case 'danger': this.frame('danger:' + (data.kind || '?')); break;
      case 'death': if (!this.frozen) this.freeze(); this.saveDeath(data); break;
      case 'spawn': this.reset(); break;
    }
  }

  // ---------- файлы ----------
  freeName(kind, t) {
    const base = `${kind}-${stamp(new Date(t))}`;
    let name = base + '.json', i = 2;
    while (fs.existsSync(path.join(this.dir, name))) name = `${base}-${i++}.json`;
    return name;
  }

  write(name, rec) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const head = { ...rec }; delete head.frames;
      const text = JSON.stringify(head, null, 1).replace(/\n\}$/, ',\n "frames": [\n' + rec.frames.map(f => JSON.stringify(f)).join(',\n') + '\n]\n}');
      const file = path.join(this.dir, name), tmp = file + '.tmp';
      fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
      this.sumCache.delete(name);
      this.prune();
      return true;
    } catch (e) {
      try { console.log('[blackbox] не записался:', e.message); } catch (er) {}
      return false;
    }
  }

  announce(name, rec, extra) {
    const s = rec.summary;
    try {
      this.ctx.events.push('blackbox_saved', { kind: rec.kind, file: path.join('data', 'blackbox', name).replace(/\\/g, '/'), cause: s.cause, frames: rec.frames.length,
        ...(rec.kind === 'near' ? { minHp: s.minHp } : {}), ...extra });
    } catch (e) {}
  }

  files() { return bf.listFiles(this.dir); }

  // Оставить не больше MAX_FILES; удаляются только свои файлы death-*/near-*.json
  prune() {
    const names = this.files();
    let extra = names.length - this.L.MAX_FILES;
    for (const n of names) {
      if (extra-- <= 0) break;
      if (this.lastSaved && this.lastSaved.name === n) continue;
      try { fs.unlinkSync(path.join(this.dir, n)); this.sumCache.delete(n); } catch (e) {}
    }
  }

  // GET /blackbox: список с краткой сводкой, новые сверху
  list(limit = 100) { return bf.list(this.dir, limit, this.sumCache, this.L.MAX_FILES); }

  // GET /blackbox/file?name=...: только файл из data/blackbox с правильным именем (никаких ../ и подпапок)
  readFile(name) { return bf.readFile(this.dir, name); }
}

module.exports = { BlackBox, makeFrame, invCounts, DEFAULTS, FILE_RE };
