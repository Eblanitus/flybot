// Диспетчер пула: что сейчас за дело у мухи, какой навык из пула взять (pick.js), запустить его и записать итог.
// Зовут его выученные базы day_routine_v7 и night_mine_v7 (brain/learned): в выборе участвует и родной навык (day_routine_v6,
// night_mine_v6) — он на равных с чужими, счёт у всех один: навык не бросил ошибку и в сумке что-то прибавилось (или надета броня).
// Вне стенда (нет HC_POOL_RUNS — его ставит hardcore/fly.js) пул выключен: база просто зовёт родной навык, как раньше.
'use strict';
const pick = require('./pick');
const { runForeign } = require('./shim');
const CATALOG = require('./catalog.json');

const DAY_DELA = ['wood', 'stone', 'food', 'farm', 'furnace', 'iron', 'bed', 'combat'];
const RAW = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/;
const EDIBLE = /^(cooked_\w+|bread|baked_potato|apple|golden_apple|carrot|potato|melon_slice|sweet_berries|pumpkin_pie|mushroom_stew|beetroot|beetroot_soup|rabbit_stew|cookie|dried_kelp)$/;
const IRON_ARMOR = /^iron_(helmet|chestplate|leggings|boots)$/;

function invOf(snap) { const m = {}; for (const i of (snap && snap.inventory) || []) m[i.name] = (m[i.name] || 0) + i.count; return m; }
const sum = (inv, re) => Object.entries(inv).filter(([n]) => re.test(n)).reduce((s, [, c]) => s + c, 0);

// Какое дело сейчас нужнее всего — по сумке, сытости и времени суток (rnd — для проверки)
function deloOf(snap, slot, rnd = Math.random) {
  const inv = invOf(snap);
  const seen = (snap && snap.eyes && snap.eyes.blocks) || {};
  const armed = sum(inv, /_sword$/) + (inv.bow ? 1 : 0) > 0;
  if (slot === 'night') return armed && rnd() < 0.3 ? 'combat' : 'night';
  if (!sum(inv, /_pickaxe$/)) return 'wood';
  if (!sum(inv, /^(stone|iron|diamond|netherite)_pickaxe$/)) return 'stone';
  const food = Number(snap && snap.food);
  if ((Number.isFinite(food) && food < 14) || sum(inv, EDIBLE) + sum(inv, RAW) < 4) return rnd() < 0.7 ? 'food' : 'farm';
  if (!(inv.furnace || seen.furnace) || !inv.torch) return 'furnace';
  const ironWorn = ((snap && snap.armor) || []).some(a => /^(iron|diamond|netherite)_/.test(a));
  if (!sum(inv, /^(iron|diamond|netherite)_pickaxe$/) || (!sum(inv, IRON_ARMOR) && !ironWorn)) return 'iron';
  if (!sum(inv, /_bed$/) && !seen.bed) return 'bed';
  return DAY_DELA[Math.floor(rnd() * DAY_DELA.length) % DAY_DELA.length];
}

// Кандидаты дела: чужие навыки из каталога + родной
function candidates(delo, native) {
  return [{ id: native, native: true }, ...(CATALOG[delo] || []).map(e => ({ id: e.id, entry: e }))];
}

function armorKey(snap) { return ((snap && snap.armor) || []).slice().sort().join(','); }
function gainedOf(a, b) { const out = {}; for (const [n, c] of Object.entries(b)) if (c > (a[n] || 0)) out[n] = c - (a[n] || 0); return out; }

// Родной навык через api.skill — тем же счётом, что и чужие
async function runNative(api, name, params) {
  const t0 = Date.now();
  const s0 = await api.snapshot();
  let res = null, err = null;
  try { res = await api.skill(name, params); if (res && res.ok === false) err = String(res.error || res.reason || 'ok:false').slice(0, 200); }
  catch (e) { err = String((e && e.message) || e).slice(0, 200); }
  let s1 = s0; try { s1 = await api.snapshot(); } catch (e) {}
  const gained = gainedOf(invOf(s0), invOf(s1));
  const progress = Object.keys(gained).length > 0 || armorKey(s0) !== armorKey(s1) || Number(s1 && s1.food) > Number(s0 && s0.food);
  return { id: name, ok: !err && progress, err: err || (progress ? null : 'ничего не прибавилось'), gained, res, sec: Math.round((Date.now() - t0) / 1000) };
}

// opts: {slot: 'day'|'night', native: 'day_routine_v6', maxSec}
async function dispatch(api, params = {}, opts = {}) {
  if (!process.env.HC_POOL_RUNS) return api.skill(opts.native, params);   // не стенд — как раньше
  const snap = await api.snapshot();
  const delo = deloOf(snap, opts.slot);
  const cands = candidates(delo, opts.native);
  const ch = pick.choose(delo, cands);
  api.log(`пул: дело ${delo}, беру ${ch.id} (${ch.why}, счёт ${ch.score}, запусков ${ch.runs}) из ${cands.length}`);
  const maxSec = Math.min(Number(params.max_sec) || opts.maxSec || 300, opts.maxSec || 300);
  const c = cands.find(x => x.id === ch.id);
  const r = c.native ? await runNative(api, c.id, params) : await runForeign(api, c.entry, { maxSec });
  pick.record({ fly: (snap && snap.username) || null, delo, skill: ch.id, why: ch.why, ok: r.ok, sec: r.sec, err: r.err, gained: r.gained });
  api.log(`пул: ${ch.id} ${r.ok ? 'удался' : 'не удался'} за ${r.sec} с` + (Object.keys(r.gained).length ? ', +' + Object.entries(r.gained).map(([n, k]) => `${n}×${k}`).join(' ') : '') + (r.err ? ` — ${r.err}` : ''));
  // родной навык возвращает свой итог как есть (автопилот читает его поля, его провал — провал v7, как было у v6).
  // Чужой — ok:true для автопилота, настоящий итог в pool.ok и в общей памяти: иначе автопилот по счёту версий (pickVersions,
  // память на мир) после первых провалов новичков вернулся бы к v6 и пул бы замолчал до конца мира.
  if (c.native) return r.res && typeof r.res === 'object' ? r.res : { ok: r.ok, ...(r.err ? { error: r.err } : {}) };
  return { ok: true, pool: { delo, skill: ch.id, why: ch.why, ok: r.ok, ...(r.err ? { error: r.err } : {}) }, gained: r.gained, calls: (r.calls || []).slice(-12) };
}

module.exports = { dispatch, deloOf, candidates, runNative, DAY_DELA };
