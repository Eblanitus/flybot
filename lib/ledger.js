// Учёт ресурсов (ядро): что пришло в инвентарь и что ушло, с причиной и тем, КТО отдал действие (brain / autopilot / skill:<имя> ...).
// Считаем по изменениям инвентаря (раз в ~0,5 с и на закрытии окна) и по событиям mineflayer (диг, постановка блока, подбор, окна).
// Причина берётся только из того, что точно видно; не удалось установить — честно «unknown» (никаких догадок).
//   приход: mined (добыто), crafted (скрафчено), collected (подобрано), chest_take, furnace_out, trade_in, fished, unknown
//   расход: craft_spent, placed (поставлено), chest_put, furnace_in, trade_out, eaten, tossed, died (потеряно при смерти), unknown
// Хранение: data/ledger.json — { days: { <игровой день>: { <предмет>: { in: {причина: {источник: n}}, out: {...} } } } }, запись с
// троттлингом и атомарно. Ледже только записывает факты: решений и тактик в нём нет. Читается через GET /ledger.
'use strict';
const fs = require('fs');
const path = require('path');
const { invCounts } = require('./blackbox');
const { REASONS, summarize } = require('./ledger_summary');

const DEFAULTS = {
  TICK_MS: 500,          // как часто сравниваем инвентарь
  SETTLE_MS: 3000,       // после входа/респавна инвентарь ещё приезжает пакетами — только базовая линия
  SAVE_EVERY_MS: 15000,  // троттлинг записи
  DIG_WINDOW_MS: 15000,  // добытое подбирается не сразу
  DIG_CAP: 8,            // сколько предметов объясняет один выкопанный блок
  COLLECT_WINDOW_MS: 4000,
  PLACE_WINDOW_MS: 15000,
  MAX_DAYS: 120          // дни старше сливаются в 'older'
};
const NO_TASK = 'нет задачи';
// какую причину даёт задача, когда окна нет
const TASK_GAIN = { craft: 'crafted', smelt: 'furnace_out', chest_take: 'chest_take', trade: 'trade_in', fish: 'fished', pickup: 'collected' };
const TASK_LOSS = { craft: 'craft_spent', smelt: 'furnace_in', chest_store: 'chest_put', trade: 'trade_out', eat: 'eaten', toss: 'tossed', drop_junk: 'tossed',
  plant: 'placed', place_at: 'placed', build_blueprint: 'placed', bridge: 'placed', pillar_up: 'placed', light: 'placed', till: 'placed' };

const safe = (fn, def = null) => { try { const v = fn(); return v === undefined ? def : v; } catch (e) { return def; } };

// Окно -> 'chest' | 'furnace' | 'trade' | 'craft' | null
function windowKind(w) {
  if (!w) return null;
  const s = String(w.type || w.title || '').toLowerCase();
  if (/furnace|smoker/.test(s)) return 'furnace';
  if (/merchant|villager|trade/.test(s)) return 'trade';
  if (/crafting/.test(s)) return 'craft';
  if (/chest|generic_9x|shulker|hopper|dispenser|dropper|generic_3x3|barrel/.test(s)) return 'chest';
  return null;
}
const WIN_GAIN = { chest: 'chest_take', furnace: 'furnace_out', trade: 'trade_in', craft: 'crafted' };
const WIN_LOSS = { chest: 'chest_put', furnace: 'furnace_in', trade: 'trade_out', craft: 'craft_spent' };

class Ledger {
  // opts: { file, now, limits }
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.file = opts.file || path.join(ctx.dataDir || path.join(__dirname, '..', 'data'), 'ledger.json');
    this.L = { ...DEFAULTS, ...(opts.limits || {}) };
    this.now = opts.now || (() => Date.now());
    this.days = {}; this.since = new Date(this.now()).toISOString(); this.updated = null;
    this.prev = null;              // последний снимок инвентаря { имя: n }
    this.settleUntil = 0;
    this.dead = null;              // { base } — ждём респавна
    this.win = null;               // открытое окно
    this.digs = []; this.places = []; this.collects = [];
    this.food = null; this.sat = null;
    this.dirty = false; this.lastSave = 0;
    this.load();
  }

  load() {
    try {
      const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (o && o.days && typeof o.days === 'object') { this.days = o.days; if (o.since) this.since = o.since; }
    } catch (e) {}
  }

  // ---------- подключение ----------
  attach(session) {
    const ctx = this.ctx, bot = ctx.bot;
    this.prev = null; this.dead = null; this.win = null; this.digs = []; this.places = []; this.collects = [];
    this.settleUntil = this.now() + this.L.SETTLE_MS;
    session.timers.push(setInterval(() => { if (ctx.bot === bot && ctx.ready && bot.entity) { try { this.tick(); } catch (e) {} } }, this.L.TICK_MS));
    session.timers.push(setInterval(() => { try { this.save(); } catch (e) {} }, 5000));
    require('./dug').onDug(bot, block => this.onDig(block)); // не diggingCompleted: тот отдаёт воздух и снимается при смерти
    bot.on('blockPlaced', (oldB, newB) => { try { this.onPlace(newB); } catch (e) {} });
    bot.on('playerCollect', (collector, collected) => { try { this.onCollect(collector, collected); } catch (e) {} });
    bot.on('windowOpen', w => { try { this.diff(); this.win = windowKind(w) || 'other'; } catch (e) {} });
    bot.on('windowClose', w => { try { this.diff({ win: windowKind(w) }); this.win = null; } catch (e) {} });
    bot.on('death', () => { try { this.onDeath(); } catch (e) {} });
  }

  onEvent(type, data) {
    if (type === 'spawn') this.settleUntil = this.now() + this.L.SETTLE_MS;
    else if (type === 'task_done' || type === 'task_failed' || type === 'task_aborted') {
      // итог задачи пишем на неё же (к моменту события current может уже смениться)
      try { this.diff({ task: { name: data.name, by: data.by || data.source || 'brain' } }); } catch (e) {}
    }
  }

  // ---------- события mineflayer ----------
  onDig(block) {
    if (!block || !block.name) return;
    this.digs.push({ t: this.now(), block: block.name, drops: this.dropNames(block.name), left: this.L.DIG_CAP, by: this.by() });
    if (this.digs.length > 40) this.digs.shift();
  }

  dropNames(blockName) {
    const reg = this.ctx.bot.registry;
    const b = reg && reg.blocksByName ? reg.blocksByName[blockName] : null;
    if (!b || !Array.isArray(b.drops) || !b.drops.length) return null; // таблицы нет — объясняем любой предмет
    const s = new Set();
    for (const d of b.drops) { const id = typeof d === 'object' && d ? d.drop : d; const it = reg.items ? reg.items[id] : null; if (it) s.add(it.name); }
    return s;
  }

  onPlace(nb) {
    if (!nb || !nb.name) return;
    if (!this.ctx.ownBlocks || !this.ctx.ownBlocks.has(nb.position)) return;
    const names = new Set([nb.name, nb.name.replace(/^wall_/, '')]);
    const d = this.dropNames(nb.name); if (d) for (const n of d) names.add(n);
    this.places.push({ t: this.now(), names, by: this.by() });
    if (this.places.length > 200) this.places.shift();
  }

  onCollect(collector, collected) {
    const bot = this.ctx.bot;
    if (!bot.entity || !collector || collector.id !== bot.entity.id) return;
    let name = null;
    const it = safe(() => collected.getDroppedItem ? collected.getDroppedItem() : null);
    if (it) name = it.name;
    this.collects.push({ t: this.now(), name, by: this.by() });
    if (this.collects.length > 40) this.collects.shift();
  }

  onDeath() {
    // потерянное установим по инвентарю после респавна (вдруг keepInventory): здесь только запоминаем «что было»
    if (this.dead) return;
    this.dead = { base: { ...(this.prev || {}) } };
    this.settleUntil = Infinity; // до события spawn
  }

  // ---------- сравнение инвентаря ----------
  tick() { this.diff(); }

  by() {
    const tm = this.ctx.tasks; if (!tm) return NO_TASK;
    if (tm.current) return tm.current.by || tm.current.source || 'brain';
    if (tm.legacy) return tm.legacy.by || 'brain';
    return NO_TASK;
  }
  taskName() {
    const tm = this.ctx.tasks; if (!tm) return null;
    return tm.current ? tm.current.name : null;
  }

  diff(over) {
    const ctx = this.ctx, bot = ctx.bot;
    if (!bot || !bot.entity) return;
    const t = this.now();
    if (t < this.settleUntil) return;
    const cur = invCounts(bot);
    if (this.dead) { // респавн: что реально пропало по сравнению с тем, что было
      for (const n of Object.keys(this.dead.base)) { const lost = this.dead.base[n] - (cur[n] || 0); if (lost > 0) this.add(n, 'out', 'died', 'смерть', lost); }
      this.dead = null; this.prev = cur; this.syncFood(); return;
    }
    if (!this.prev) { this.prev = cur; this.syncFood(); return; }
    const win = over && 'win' in over ? over.win : (this.win === 'other' ? null : this.win);
    const task = over && over.task ? over.task : { name: this.taskName(), by: this.by() };
    const foodUp = this.foodUp();
    const names = new Set([...Object.keys(cur), ...Object.keys(this.prev)]);
    for (const n of names) {
      const d = (cur[n] || 0) - (this.prev[n] || 0);
      if (d > 0) this.classifyGain(n, d, t, win, task);
      else if (d < 0) this.classifyLoss(n, -d, t, win, task, foodUp);
    }
    this.prev = cur;
    this.trim(t);
  }

  syncFood() { const b = this.ctx.bot; this.food = b.food; this.sat = b.foodSaturation; }
  foodUp() {
    const b = this.ctx.bot;
    const up = (this.food != null && b.food > this.food) || (this.sat != null && b.foodSaturation > this.sat);
    this.syncFood();
    return !!up;
  }

  trim(t) {
    this.digs = this.digs.filter(x => t - x.t <= this.L.DIG_WINDOW_MS && x.left > 0);
    this.places = this.places.filter(x => t - x.t <= this.L.PLACE_WINDOW_MS);
    this.collects = this.collects.filter(x => t - x.t <= this.L.COLLECT_WINDOW_MS);
  }

  classifyGain(item, n, t, win, task) {
    let left = n;
    const by = task.by || NO_TASK;
    if (win && WIN_GAIN[win]) return this.add(item, 'in', WIN_GAIN[win], by, n);
    if (task.name === 'craft') return this.add(item, 'in', 'crafted', by, n);
    // добыто: недавний диг, чьи drops содержат предмет (или таблицы drops нет)
    for (let i = this.digs.length - 1; i >= 0 && left > 0; i--) {
      const g = this.digs[i];
      if (t - g.t > this.L.DIG_WINDOW_MS || g.left <= 0 || (g.drops && !g.drops.has(item))) continue;
      const k = Math.min(left, g.left); g.left -= k; left -= k; this.add(item, 'in', 'mined', g.by, k);
    }
    // подобрано: недавний подбор предмета с таким именем (или без имени)
    for (let i = this.collects.length - 1; i >= 0 && left > 0; i--) {
      const c = this.collects[i];
      if (t - c.t > this.L.COLLECT_WINDOW_MS || (c.name && c.name !== item)) continue;
      this.collects.splice(i, 1); this.add(item, 'in', 'collected', c.by, left); left = 0;
    }
    if (left > 0 && TASK_GAIN[task.name]) return this.add(item, 'in', TASK_GAIN[task.name], by, left);
    if (left > 0) this.add(item, 'in', 'unknown', by, left);
  }

  classifyLoss(item, n, t, win, task, foodUp) {
    let left = n;
    const by = task.by || NO_TASK;
    if (win && WIN_LOSS[win]) return this.add(item, 'out', WIN_LOSS[win], by, n);
    if (task.name === 'craft') return this.add(item, 'out', 'craft_spent', by, n);
    // поставлено: недавние блоки, чьё имя/drops совпадает с предметом
    for (let i = this.places.length - 1; i >= 0 && left > 0; i--) {
      const p = this.places[i];
      if (t - p.t > this.L.PLACE_WINDOW_MS || !p.names.has(item)) continue;
      this.places.splice(i, 1); left--; this.add(item, 'out', 'placed', p.by, 1);
    }
    if (left > 0 && (task.name === 'eat' || (foodUp && this.isFood(item)))) return this.add(item, 'out', 'eaten', by, left);
    if (left > 0 && TASK_LOSS[task.name]) return this.add(item, 'out', TASK_LOSS[task.name], by, left);
    if (left > 0) this.add(item, 'out', 'unknown', by, left);
  }

  isFood(name) { const r = this.ctx.bot.registry; return !!(r && r.foodsByName && r.foodsByName[name]); }

  // ---------- хранение ----------
  dayKey() { const d = safe(() => this.ctx.bot.time.day); return d != null && Number.isFinite(Number(d)) ? String(Number(d)) : 'unknown'; }

  add(item, dir, reason, by, n) {
    if (!(n > 0)) return;
    const day = this.dayKey();
    const rows = this.days[day] || (this.days[day] = {});
    const row = rows[item] || (rows[item] = { in: {}, out: {} });
    const r = row[dir][reason] || (row[dir][reason] = {});
    r[by] = (r[by] || 0) + n;
    this.dirty = true; this.updated = this.now();
  }

  compactDays() {
    const keys = Object.keys(this.days).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    while (keys.length > this.L.MAX_DAYS) {
      const k = keys.shift(), old = this.days[k]; delete this.days[k];
      const dst = this.days.older || (this.days.older = {});
      for (const item of Object.keys(old)) {
        const row = dst[item] || (dst[item] = { in: {}, out: {} });
        for (const dir of ['in', 'out']) for (const rs of Object.keys(old[item][dir])) {
          const r = row[dir][rs] || (row[dir][rs] = {});
          for (const b of Object.keys(old[item][dir][rs])) r[b] = (r[b] || 0) + old[item][dir][rs][b];
        }
      }
    }
  }

  save(force) {
    if (!this.dirty) return false;
    const t = this.now();
    if (!force && t - this.lastSave < this.L.SAVE_EVERY_MS) return false;
    try {
      this.compactDays();
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, since: this.since, savedAt: new Date(t).toISOString(), days: this.days }));
      fs.renameSync(tmp, this.file);
      this.dirty = false; this.lastSave = t;
      return true;
    } catch (e) { try { console.log('[ledger] не записался:', e.message); } catch (er) {} return false; }
  }
  flush() { return this.save(true); }

  // ---------- сводка (GET /ledger) ----------
  summary() {
    return {
      ok: true, since: this.since, updated: this.updated ? new Date(this.updated).toISOString() : null, labels: REASONS,
      ...summarize(this.days), inventory: safe(() => invCounts(this.ctx.bot), {})
    };
  }
}

module.exports = { Ledger, REASONS, windowKind, DEFAULTS };
