// Решатель дел (этап 2, хозяин 04.11 «один решатель всегда»): навыки, охота, побег, пережидание — один список,
// выбор по опыту всех мух в похожей обстановке (общая память hardcore/data/shared/decider.json), с пробами.
// Часть без mineflayer: sitOf, statsFor, pickOption, rewards. Проверка — test/hardcore_decider.js.
'use strict';
const K = 3;                 // подсказка автопилота весит как 3 запуска
const PROBE_RUNS = 5;        // меньше 5 запусков в этой обстановке — новичок, пробуется первым
const EXPLORE_HI = 0.30, EXPLORE_LO = 0.10, EXPLORE_RUNS = 200;   // доля проб: 30% → 10% к 200 делам в обстановке
const MIN_EXACT = 3;         // в точной обстановке меньше 3 запусков дела — берём грубую (фаза|инструменты|враг)

const BIOMES = [[/desert|badlands/, 'dry'], [/snow|frozen|ice|grove|jagged/, 'snow'], [/ocean|river|beach|swamp/, 'water'],
  [/jungle|forest|taiga|bamboo|cherry/, 'forest'], [/peak|slope|hill|mountain|windswept|stony/, 'mount'], [/plain|savanna|meadow|field/, 'plain']];
const biomeGroup = name => { const n = String(name || ''); for (const [re, g] of BIOMES) if (re.test(n)) return g; return 'other'; };
const TOOLS = ['none', 'wood', 'stone', 'iron'];

// s — состояние gather() автопилота; biome — имя биома под ногами
function sitOf(s, biome) {
  const t = s.tools || {};
  const o = {
    phase: s.isNight ? 'night' : 'day',
    place: s.sheltered ? 'shelter' : s.underground ? 'under' : 'open',
    hp: s.hp < 8 ? 'low' : s.hp < 14 ? 'mid' : 'high',
    tools: TOOLS[Math.min(3, Math.max(0, t.pickaxe || 0))],
    enemy: (s.enemies && s.enemies.length) ? 'fly' : s.hostilesNear > 0 ? 'mob' : 'none',
    biome: biomeGroup(biome)
  };
  return { ...o, key: [o.phase, o.place, o.hp, o.tools, o.enemy, o.biome].join('|'), coarse: [o.phase, o.tools, o.enemy].join('|') };
}
// статистика дел для обстановки: точная, а где в точной мало — грубая
function statsFor(mem, sit) {
  const ex = (mem.exact || {})[sit.key] || {}, co = (mem.coarse || {})[sit.coarse] || {};
  const out = {};
  for (const k of new Set([...Object.keys(ex), ...Object.keys(co)])) out[k] = ex[k] && ex[k].n >= MIN_EXACT ? ex[k] : (co[k] || ex[k]);
  return out;
}
const runsIn = st => Object.values(st).reduce((a, x) => a + (x.n || 0), 0);
const exploreRate = runs => Math.max(EXPLORE_LO, EXPLORE_HI - (EXPLORE_HI - EXPLORE_LO) * Math.min(1, runs / EXPLORE_RUNS));
// оценка: подсказка автопилота (счёт/100) как K запусков + средние очки дела
const value = (o, st) => { const x = st[o.key] || { n: 0, sum: 0 }; return (o.prior * K + x.sum) / (K + x.n); };
// opts: [{ key, prior, act }]; calm — можно ли пробовать (решатель стенда пробует везде, хозяин 05.11; false — для тестов и этапа 2м); rate — доля проб
function pickOption(opts, st, { calm = true, rate = EXPLORE_HI, rnd = Math.random } = {}) {
  if (!opts.length) return null;
  const runs = o => (st[o.key] ? st[o.key].n : 0);
  if (calm && rate > 0 && rnd() < rate) {
    const fresh = opts.filter(o => runs(o) < PROBE_RUNS);
    const from = fresh.length ? fresh : opts;
    const o = from[Math.floor(rnd() * from.length) % from.length];
    return { ...o, explore: true, why: fresh.length ? `пробую новичка (${runs(o)} раз здесь)` : 'пробую наугад' };
  }
  let best = opts[0];
  for (const o of opts) if (value(o, st) > value(best, st)) best = o;
  return { ...best, explore: false, why: `лучшее по опыту: ${value(best, st).toFixed(2)} очка (${runs(best)} раз здесь)` };
}
// награда дела = итог матча: очки жизни мухи за весь мир (хозяин 05.11: «та муха, которая лучше выжила, используя
// из сотни навыков конкретные, та и круче»). Каждое дело жизни получает итог этой жизни; оценка дела в обстановке —
// средние очки жизней по его запускам. Смерть — конец счёта: у рано погибшей мухи мало очков, и все её дела получают мало.
function rewards(deeds, total) {
  return deeds.map(d => ({ ...d, r: total }));
}
// --- часть с живой мухой (Б5): решатель в автопилоте ---
let MEM = null;
function memory() { // общая память решателя: читается раз за жизнь (пишет её стенд между мирами, Б10); нет файла — пусто
  if (MEM) return MEM;
  MEM = { exact: {}, coarse: {} };
  if (process.env.HC_DECIDER_MEM) try { MEM = JSON.parse(require('fs').readFileSync(process.env.HC_DECIDER_MEM, 'utf8')); } catch (e) {}
  return MEM;
}
function biomeOf(bot) { // как biomeName в lib/perception.js (там не экспортирован — старый файл не трогаем)
  try {
    const b = bot.blockAt(bot.entity.position);
    if (b && b.biome) { if (b.biome.name) return b.biome.name; const r = bot.registry && bot.registry.biomes && bot.registry.biomes[b.biome.id]; if (r && r.name) return r.name; }
  } catch (e) {}
  return 'unknown';
}
// выбор дела: out.cands — все кандидаты автопилота (score = подсказка); без out.cands — дело автопилота как было
function choose(ctx, s, act, out) {
  const sit = sitOf(s, biomeOf(ctx.bot));
  const tag = a => (a ? { ...a, sit: sit.key, coarse: sit.coarse } : a);
  if (!out || !out.cands) return tag(act);
  const opts = out.cands.map(c => ({ key: c.act.key, prior: c.score / 100, act: c.act }));
  if (!opts.length) return tag(act);
  const st = statsFor(memory(), sit);
  const rate = process.env.HC_EXPLORE === '0' ? 0 : exploreRate(runsIn(st)); // пробы везде: муху никак не ограничиваем (хозяин 05.11)
  const ch = pickOption(opts, st, { rate });
  return tag({ ...ch.act, score: Math.round(ch.prior * 100), explore: ch.explore, why: `${ch.act.why} — решатель: ${ch.why}` });
}
const _reset = () => { MEM = null; }; // для тестов

module.exports = { sitOf, biomeGroup, statsFor, exploreRate, runsIn, value, pickOption, rewards, choose, memory, biomeOf, _reset, K, PROBE_RUNS, EXPLORE_HI, EXPLORE_LO };
