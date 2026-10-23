// Варианты базовых действий: много способов сделать одно и то же (бой, бегство, укрытие...), муха пробует их
// в разных обстановках, запоминает исход и сама отсеивает, что где работает (бандит UCB1 + немного исследования).
// Вариант = файл lib/variants/<семейство>/<имя>.js (сканируется сам при старте); общее семейства — <семейство>/_family.js.
// Контракт — lib/variants/README.md. Статистика — data/variants.json (атомарная запись).
'use strict';
const fs = require('fs');
const path = require('path');
const { SkillError, entName, isHostile, r1 } = require('./util');

const DIR = path.join(__dirname, 'variants');
const MIN_N = 3;        // столько попыток на уровне ключа, чтобы ему доверять (иначе откат к более общему)
const NEW_P = 0.25;     // шанс дать попробовать ещё не пробованный вариант
const EPS = 0.08;       // шанс случайного применимого варианта
const UCB_C = 0.45;     // сила исследования в UCB1 (оценки в [0,1])

// ---------- реестр ----------
let REG = null; // { families: Map<name, {name, def, variants: Map}>, errors: [] }

function defaultFamily(name) {
  return {
    family: name, label: name, prior: [],
    sitKeys: sit => [sit && sit.key, sit && sit.target, '*'].filter(Boolean),
    score: ({ result, error }) => ({ ok: !error, score: error ? 0 : 1 })
  };
}

function validVariant(v, fam) {
  if (!v || typeof v !== 'object') return 'экспорт не объект';
  if (!v.name || typeof v.name !== 'string') return 'нет name';
  if (v.family && v.family !== fam) return `family=${v.family}, а лежит в ${fam}`;
  if (typeof v.run !== 'function') return 'нет run()';
  if (v.applies != null && typeof v.applies !== 'function') return 'applies не функция';
  return null;
}

// Просканировать каталог семейств. Битый файл — предупреждение в лог и в errors, тело не падает.
function load(dir = DIR, { log = console.log } = {}) {
  const reg = { dir, families: new Map(), errors: [] };
  const warn = (file, msg) => { reg.errors.push({ file, error: msg }); try { log(`[variants] пропущен ${file}: ${msg}`); } catch (e) {} };
  let fams = [];
  try { fams = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return reg; }
  for (const fname of fams.sort()) {
    const fdir = path.join(dir, fname);
    let def = defaultFamily(fname);
    const ff = path.join(fdir, '_family.js');
    if (fs.existsSync(ff)) {
      try { delete require.cache[require.resolve(ff)]; def = { ...def, ...require(ff), family: fname }; } catch (e) { warn(path.relative(dir, ff), e.message); }
    }
    const fam = { name: fname, def, variants: new Map() };
    let files = [];
    try { files = fs.readdirSync(fdir).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort(); } catch (e) {}
    for (const f of files) {
      const full = path.join(fdir, f), rel = fname + '/' + f;
      try {
        delete require.cache[require.resolve(full)];
        const v = require(full);
        const bad = validVariant(v, fname);
        if (bad) { warn(rel, bad); continue; }
        if (fam.variants.has(v.name)) { warn(rel, `имя ${v.name} уже занято`); continue; }
        fam.variants.set(v.name, { family: fname, desc: '', applies: () => true, ...v, file: rel });
      } catch (e) { warn(rel, String(e && e.message || e).split('\n')[0]); }
    }
    reg.families.set(fname, fam);
  }
  return reg;
}
function registry() { if (!REG) REG = load(); return REG; }
function reload(dir) { REG = load(dir); return REG; }
function setRegistry(reg) { REG = reg; }
function family(name) { const f = registry().families.get(name); if (!f) throw new SkillError(`нет семейства вариантов ${name}`); return f; }

// ---------- обстановка (sit) ----------
const isSolid = b => !!b && b.boundingBox === 'block';
const isWaterB = b => !!b && (b.name === 'water' || b.name === 'bubble_column' || b.name === 'kelp' || b.name === 'seagrass' || b.name === 'tall_seagrass');
const CLIMB = new Set(['ladder', 'vine', 'scaffolding', 'twisting_vines', 'weeping_vines', 'cave_vines']);
const PLACEABLE = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'diorite', 'andesite', 'granite', 'tuff', 'coarse_dirt', 'deepslate', 'calcite', 'sandstone', 'blackstone'];

function at(bot, x, y, z) { try { const V = bot.entity.position.constructor; return bot.blockAt(new V(Math.floor(x), Math.floor(y), Math.floor(z))); } catch (e) { return null; } }

// Местность у ног: вода, лестница, высота потолка (свободных блоков от ног вверх, до 5), обрыв (≥3 вниз) в 2 блоках
function terrain(bot) {
  const p = bot.entity.position, out = { water: false, ladder: false, ceiling: 5, cliff: false };
  const feet = at(bot, p.x, p.y + 0.01, p.z), head = at(bot, p.x, p.y + 1, p.z);
  out.water = !!bot.entity.isInWater || isWaterB(feet) || isWaterB(head);
  out.ladder = !!(feet && CLIMB.has(feet.name)) || !!(head && CLIMB.has(head.name));
  for (let i = 0; i < 5; i++) { const b = at(bot, p.x, p.y + 0.01 + i, p.z); if (isSolid(b)) { out.ceiling = i; break; } }
  const y = Math.floor(p.y + 0.01);
  outer: for (const r of [1, 2]) for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    const b1 = at(bot, x, y - 1, z), b2 = at(bot, x, y - 2, z), b3 = at(bot, x, y - 3, z);
    if (b1 && b2 && b3 && !isSolid(b1) && !isSolid(b2) && !isSolid(b3) && !isWaterB(b1) && !isSolid(at(bot, x, y, z))) { out.cliff = true; break outer; }
  }
  return out;
}

function hasShield(bot) {
  const off = bot.inventory.slots && bot.inventory.slots[45];
  return !!(off && off.name === 'shield') || bot.inventory.items().some(i => i.name === 'shield');
}

// Обстановка для выбора варианта: ключ опыта (experience.js) + цель + местность + наша экипировка.
// extra — признаки вызова (например { defend: true }).
function situation(ctx, target = null, extra = {}) {
  const bot = ctx.bot;
  let base = null;
  try { base = require('./experience').situation(ctx); } catch (e) {}
  if (!base) base = { phase: 'day', place: 'outdoors', armor: 'none', weapon: 'nowpn', hp: 'high', enemy: 'none', count: '0', key: 'day|outdoors|none|nowpn|high|none|0' };
  const s = { ...base, expKey: base.key };
  s.hpNum = r1(bot.health || 0); s.food = bot.food != null ? bot.food : 20;
  s.held = bot.heldItem ? bot.heldItem.name : null;
  try { s.shield = hasShield(bot); } catch (e) { s.shield = false; }
  try { s.blocks = bot.inventory.items().filter(i => PLACEABLE.includes(i.name)).reduce((a, i) => a + i.count, 0); } catch (e) { s.blocks = 0; }
  try { Object.assign(s, terrain(bot)); } catch (e) { Object.assign(s, { water: false, ladder: false, ceiling: 5, cliff: false }); }
  if (target) {
    const eq = target.equipment || [];
    s.target = entName(target); s.targetId = target.id;
    s.pvp = target.type === 'player';
    s.targetType = s.pvp ? 'player' : 'mob';
    s.ranged = require('./felt').RANGED.has(s.target);
    s.creeper = s.target === 'creeper';
    s.targetWeapon = (target.heldItem && target.heldItem.name) || (eq[0] && eq[0].name) || null;
    s.targetShield = !!(eq[1] && eq[1].name === 'shield');
    try { const P = require('./felt').posOf(target); s.dist = P ? r1(bot.entity.position.distanceTo(P)) : null; } catch (e) { s.dist = null; }
  } else { s.pvp = false; s.target = null; }
  const F = require('./felt');
  const p = bot.entity.position;
  let rangedNearby = false;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    if (isHostile(e) || (e.type === 'player' && require('./aggressors').isAggressorEntity(ctx, e))) {
      const name = entName(e);
      if (F.RANGED.has(name)) {
        const ep = F.posOf(e) || e.position;
        if (ep.distanceTo(p) <= 25) { rangedNearby = true; break; }
      }
    }
  }
  s.rangedNearby = rangedNearby;
  Object.assign(s, extra);
  return s;
}

// ---------- статистика ----------
function file(ctx) { return ctx.variantsFile || (ctx.dataDir ? path.join(ctx.dataDir, 'variants.json') : null); }
function store(ctx) {
  if (ctx.variants) return ctx.variants;
  let d = null; const f = file(ctx);
  try { if (f && fs.existsSync(f)) d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  ctx.variants = { stats: (d && d.stats) || {}, recent: (d && d.recent) || [] };
  return ctx.variants;
}
function save(ctx) {
  const f = file(ctx); if (!f) return; // без файла (тесты) — только в памяти
  const x = store(ctx), tmp = f + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify({ stats: x.stats, recent: x.recent.slice(-60) }, null, 1)); fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch (er) {} }
}

function keysFor(fam, sit) {
  if (Array.isArray(sit)) return sit;
  if (typeof sit === 'string') return [sit];
  let k = []; try { k = fam.def.sitKeys(sit || {}) || []; } catch (e) {}
  k = k.filter(Boolean).map(String);
  if (!k.includes('*')) k.push('*');
  return [...new Set(k)];
}

// Записать исход: family, variant, ключи (или sit — ключи посчитает семейство), {ok, score∈[0,1]}
function record(ctx, familyName, variant, sitOrKeys, { ok, score } = {}) {
  const fam = family(familyName), x = store(ctx);
  const sc = Math.max(0, Math.min(1, Number.isFinite(Number(score)) ? Number(score) : ok ? 1 : 0));
  const keys = keysFor(fam, sitOrKeys);
  const F = (x.stats[familyName] = x.stats[familyName] || {});
  for (const k of keys) {
    const a = ((F[k] = F[k] || {})[variant] = F[k][variant] || { n: 0, ok: 0, sum: 0 });
    a.n++; if (ok) a.ok++; a.sum = Math.round((a.sum + sc) * 1000) / 1000;
  }
  x.recent.push({ t: new Date().toISOString().slice(0, 19), family: familyName, variant, key: keys[0], ok: !!ok, score: Math.round(sc * 100) / 100 });
  if (x.recent.length > 120) x.recent.splice(0, x.recent.length - 60);
  save(ctx);
  return { keys, score: sc };
}

// Статистика варианта: самый точный уровень ключа с ≥MIN_N попытками, иначе самый общий, где есть хоть что-то
function statFor(ctx, familyName, variant, keys) {
  const F = store(ctx).stats[familyName] || {};
  let last = null;
  for (const k of keys) { const a = F[k] && F[k][variant]; if (!a || !a.n) continue; if (a.n >= MIN_N) return { ...a, key: k }; last = { ...a, key: k }; }
  return last || { n: 0, ok: 0, sum: 0, key: null };
}

// Проверить style заранее: auto или имя варианта семейства, иначе SkillError со списком
function checkStyle(familyName, style) {
  const fam = family(familyName), s = style == null ? 'auto' : String(style).toLowerCase();
  if (s !== 'auto' && !fam.variants.has(s)) throw new SkillError(`style=${s}: такого варианта нет; есть: auto, ${[...fam.variants.keys()].join(', ')}`);
  return s;
}

function safeApplies(v, ctx, sit) { try { return !!v.applies(ctx, sit); } catch (e) { return false; } }

// Опасная обстановка: HP < 10, враждебный моб рядом (dist ≤ 10), ночь или подземелье
function isDangerous(sit) {
  const hpLow = sit.hpNum != null && sit.hpNum < 10;
  const foeNear = sit.dist != null && sit.dist <= 10 && (sit.targetType === 'mob' || sit.pvp);
  const nightOrUnderground = sit.phase === 'night' || sit.place === 'underground';
  return hpLow && foeNear && nightOrUnderground;
}

// Выбрать вариант. opts: style ('auto' | имя), rng, exclude (Set имён). -> { variant, name, why, keys } | null
function choose(ctx, familyName, sit, opts = {}) {
  const fam = family(familyName);
  const rng = opts.rng || ctx.variantRand || Math.random;
  const exclude = opts.exclude || new Set();
  const keys = keysFor(fam, sit);
  const all = [...fam.variants.values()];
  const prior = fam.def.prior || [];
  const rank = v => { const i = prior.indexOf(v.name); return i < 0 ? prior.length + all.indexOf(v) : i; };
  const apps = all.filter(v => !exclude.has(v.name) && safeApplies(v, ctx, sit)).sort((a, b) => rank(a) - rank(b));
  const style = opts.style != null ? String(opts.style).toLowerCase() : 'auto';
  let note = '';
  if (style && style !== 'auto') {
    const v = fam.variants.get(style);
    if (!v) throw new SkillError(`style=${style}: такого варианта нет; есть: auto, ${[...fam.variants.keys()].join(', ')}`);
    if (apps.includes(v)) return { variant: v, name: v.name, why: 'задан style', keys };
    note = `style=${style} здесь неприменим; `;
  }
  if (!apps.length) return null;
  const st = new Map(apps.map(v => [v, statFor(ctx, familyName, v.name, keys)]));
  const fresh = apps.filter(v => !st.get(v).n), tried = apps.filter(v => st.get(v).n);
  const dangerous = isDangerous(sit);
  const pick = (v, why) => ({ variant: v, name: v.name, why: note + why, keys, stat: st.get(v) });
  if (fresh.length && (!tried.length || (dangerous ? false : rng() < NEW_P))) {
    if (!tried.length) return pick(fresh[0], 'опыта нет — по умолчанию');
    return pick(fresh[Math.floor(rng() * fresh.length) % fresh.length], 'пробую новый');
  }
  if (apps.length > 1 && !dangerous && rng() < EPS) return pick(apps[Math.floor(rng() * apps.length) % apps.length], 'исследую');
  const N = tried.reduce((a, v) => a + st.get(v).n, 0);
  let best = null, bu = -Infinity;
  for (const v of tried) {
    const a = st.get(v);
    if (dangerous && a.ok === 0 && tried.some(v2 => st.get(v2).ok > 0)) continue;
    const u = a.sum / a.n + UCB_C * Math.sqrt(Math.log(Math.max(N, 1)) / a.n);
    if (u > bu + 1e-9) { bu = u; best = v; }
  }
  if (!best) {
    const okVariants = tried.filter(v => st.get(v).ok > 0);
    if (okVariants.length) {
      let b = okVariants[0], bu2 = -Infinity;
      for (const v of okVariants) {
        const a = st.get(v), u = a.sum / a.n + UCB_C * Math.sqrt(Math.log(Math.max(N, 1)) / a.n);
        if (u > bu2 + 1e-9) { bu2 = u; b = v; }
      }
      const a2 = st.get(b);
      return pick(b, `лучший из рабочих ${a2.ok}/${a2.n} (${a2.key}); опасно: отсеян нерабочий`);
    }
    return null;
  }
  const a = st.get(best);
  return pick(best, `лучший ${a.ok}/${a.n} (${a.key})${dangerous ? '; опасная обстановка — исследование выкл' : ''}`);
}

// Выбор через поведение (behavior/combat.js, chooseVariant), как chooseMelee у боя; нет поведения/упало — choose здесь
function pick(ctx, familyName, sit, opts = {}) {
  const args = [ctx, familyName, sit, opts];
  return ctx.behaviorHost ? ctx.behaviorHost.call('chooseVariant', args, choose) : choose(...args);
}

// Счёт всех вариантов семейства в этой обстановке (для мозга: что тут пробовали и как вышло)
function scores(ctx, familyName, sit) {
  const fam = family(familyName), keys = keysFor(fam, sit), out = {};
  for (const v of fam.variants.values()) {
    const a = statFor(ctx, familyName, v.name, keys);
    out[v.name] = { applies: safeApplies(v, ctx, sit), n: a.n, ok: a.ok, avg: a.n ? Math.round(a.sum / a.n * 100) / 100 : null, key: a.key };
  }
  return out;
}
// Коротко для итога навыка: «sprint_away 3/4, zigzag 0/1, pillar —»
function scoreLine(sc) {
  return Object.entries(sc).map(([n, a]) => `${n} ${a.applies ? (a.n ? a.ok + '/' + a.n : '—') : 'неприменим'}`).join(', ');
}

// Выбрать, выполнить, оценить, записать. Для семейств, где одна попытка = один вызов варианта.
// В итоге — какой вариант взят, почему и счёт всех вариантов здесь (scores), чтобы мозг видел, что где работает.
async function perform(ctx, t, familyName, params, sit, opts = {}) {
  const fam = family(familyName), bot = ctx.bot;
  const ch = pick(ctx, familyName, sit, opts);
  if (!ch) throw new SkillError(`нет применимых вариантов ${familyName} здесь`);
  const t0 = Date.now(), hp0 = bot && bot.health;
  let result = null, error = null;
  try { result = await ch.variant.run(ctx, t, params || {}, sit); } catch (e) { error = e; }
  if (error && error.aborted) throw error; // прерывание — не исход варианта
  let out = { ok: !error, score: error ? 0 : 1 };
  try { out = fam.def.score({ result, error, ms: Date.now() - t0, hp0, hp1: bot && bot.health, sit, ctx, params }) || out; } catch (e) {}
  record(ctx, familyName, ch.name, ch.keys, out);
  let sc = null; try { sc = scoreLine(scores(ctx, familyName, sit)); } catch (e) {}
  if (error) {
    if (error.extra && typeof error.extra === 'object') { error.extra.variant = ch.name; if (sc) error.extra.variants = sc; }
    else if (!error.extra) error.extra = { variant: ch.name, ...(sc ? { variants: sc } : {}) };
    throw error;
  }
  return { ...(result || {}), variant: ch.name, why: ch.why, ...(sc ? { variants: sc } : {}) };
}

// Оценить исход функцией семейства и записать (когда вариант запускает вызывающий сам, как fight)
function judge(ctx, familyName, variantName, keys, info) {
  const fam = family(familyName);
  let out = { ok: !info.error, score: info.error ? 0 : 1 };
  try { out = fam.def.score(info) || out; } catch (e) {}
  record(ctx, familyName, variantName, keys, out);
  return out;
}

// ---------- видимость ----------
function list() {
  const out = {};
  for (const [n, f] of registry().families) out[n] = { label: f.def.label, variants: [...f.variants.values()].map(v => ({ name: v.name, desc: v.desc || '', file: v.file })) };
  return { families: out, errors: registry().errors };
}
function stats(ctx, familyName) {
  const x = store(ctx), out = {};
  for (const [fn, F] of Object.entries(x.stats)) {
    if (familyName && fn !== familyName) continue;
    out[fn] = {};
    for (const [k, vs] of Object.entries(F)) {
      out[fn][k] = {};
      for (const [v, a] of Object.entries(vs)) out[fn][k][v] = { n: a.n, ok: a.ok, avg: Math.round(a.sum / Math.max(a.n, 1) * 100) / 100 };
    }
  }
  return { stats: out, recent: x.recent.slice(-15) };
}

// Короткая строка: «бой: лучший crit_jump 7/9 (zombie)» — только если есть данные
function line(ctx) {
  const x = store(ctx), parts = [];
  let near = null;
  try {
    const bot = ctx.bot, me = bot.entity.position; let bd = 16;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || !(isHostile(e) || e.type === 'player')) continue;
      if (e.type === 'player' && !require('./aggressors').isAggressorEntity(ctx, e)) continue;
      const d = e.position.distanceTo(me); if (d < bd) { bd = d; near = e; }
    }
  } catch (e) {}
  for (const [fn, F] of Object.entries(x.stats)) {
    let label = fn; try { label = family(fn).def.label || fn; } catch (e) {}
    const tg = near ? (near.type === 'player' ? 'player' : entName(near)) : null;
    const k = tg && F[tg] ? tg : '*';
    const vs = F[k]; if (!vs) continue;
    let best = null, ba = -1;
    for (const [v, a] of Object.entries(vs)) { if (a.n < 2) continue; const m = a.sum / a.n; if (m > ba) { ba = m; best = [v, a]; } }
    if (best) parts.push(`${label}: лучший ${best[0]} ${best[1].ok}/${best[1].n} (${k === '*' ? 'всё' : k})`);
  }
  return parts.length ? parts.join('; ') : null;
}
function decorate(ctx, snap) {
  try {
    if (!snap || !snap.ready) return snap;
    const l = line(ctx); if (!l) return snap;
    if (snap.eyes) snap.eyes.variants = l;
    if (snap.summary) snap.summary += ' ' + l + '.';
  } catch (e) {}
  return snap;
}

module.exports = { DIR, MIN_N, load, reload, registry, setRegistry, family, situation, terrain, record, judge, choose, pick, scores, scoreLine, checkStyle, perform, statFor, keysFor, list, stats, line, decorate, store };
