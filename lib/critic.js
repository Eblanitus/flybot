// Критик тела («ускоритель адаптации»): без LLM следит за затупами мозга и тела и будит мозг событием advice.
// Правила (раз в 60 с по скользящему окну): hand_tool, micro_cmds, repeat_fail, idle, stall, deaths.
// advice: не чаще раза в 3 мин на правило и раза в минуту всего. Состояние — data/critic.json, отчёт — data/critic_report.md (раз в 5 мин).
'use strict';
const fs = require('fs');
const path = require('path');

const MIN = 60000, HOUR = 3600000;
const CFG = {
  handWin: 5 * MIN, handN: 5, microWin: 3 * MIN, microN: 6, failWin: 10 * MIN, failN: 3,
  idleWin: 10 * MIN, idlePct: 25, stallMs: 30 * MIN, deathN: 2,
  ruleCooldown: 3 * MIN, globalCooldown: 60000, reportEvery: 5 * MIN, ignoredN: 3, sampleMs: 5000
};
const RULES = ['hand_tool', 'micro_cmds', 'repeat_fail', 'idle', 'stall', 'deaths'];
const PRIORITY = ['deaths', 'repeat_fail', 'hand_tool', 'micro_cmds', 'stall'];
const RULE_NAME = { hand_tool: 'работа без инструмента', micro_cmds: 'копание/ставка по блоку', repeat_fail: 'повтор одной ошибки', idle: 'простой', stall: 'нет прогресса', deaths: 'повторные смерти' };
const BODY_FIX = {
  hand_tool: 'автокрафт топора/кирки/лопаты перед collect, если материалы есть',
  micro_cmds: 'отказ или сжатие пачки dig_at/place_at в collect/build',
  repeat_fail: 'блокировка повтора одного и того же провала (бэкофф) или подсказка в task_failed',
  stall: 'автопилот: целенаправленный шаг к следующему тиру',
  deaths: 'рефлекс против повторяющейся причины смерти'
};

// какой инструмент нужен блоку (null — рука нормально)
const TOOL_OF = [
  ['axe', /(_log|_wood|_stem|_hyphae|_planks)$|^(crafting_table|chest|bookshelf|barrel|ladder)$/],
  ['shovel', /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|farmland|dirt_path|sand|red_sand|gravel|clay|mud|soul_sand|soul_soil|snow|snow_block|powder_snow)$/],
  ['pickaxe', /(stone|_ore|deepslate|andesite|diorite|granite|tuff|netherrack|obsidian|basalt|_bricks|terracotta|concrete|blackstone|calcite|dripstone)$|^(furnace|raw_\w+_block)$/]
];
function toolKindOf(name) { for (const [k, re] of TOOL_OF) if (re.test(name)) return k; return null; }
const KIND_RU = { axe: 'топора', pickaxe: 'кирки', shovel: 'лопаты' };
const WHAT_RU = { axe: 'дерево', pickaxe: 'камень/руду', shovel: 'землю/песок' };
const TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };
const FOOD_RE = /^(cooked_|baked_potato|bread|apple|golden_apple|golden_carrot|enchanted_golden_apple|carrot|beef|porkchop|mutton|chicken|rabbit|cod|salmon|melon_slice|sweet_berries|dried_kelp|pumpkin_pie|cookie|mushroom_stew|beetroot_soup|rabbit_stew)/;

const normErr = s => String(s || '').toLowerCase().replace(/-?\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 90);
function failHint(err) {
  if (/не вижу|не найд|нет .*рядом/.test(err)) return 'explore или другое место/копай туннель, а не повторяй find/collect тут же';
  if (/занят/.test(err)) return 'не шли поверх: дождись task_done или ставь queue/stop';
  if (/не хватает|нет (ингредиент|материал)|ингредиент|missing/.test(err)) return 'проверь recipes и добудь компоненты (collect/craft), потом повтори';
  if (/нужен инструмент|инструмент/.test(err)) return 'сначала craft нужного инструмента';
  if (/таймаут|timeout|не дошёл|путь|path|недоступ/.test(err)) return 'выбери другую цель/ближе, сделай explore, смени точку';
  return 'смени параметры, навык или порядок шагов';
}
function deathHint(cause) {
  const c = String(cause).toLowerCase();
  if (/лав|burn|огон|fire/.test(c)) return 'не копай вниз без проверки hazards, носи воду/блоки, держись от лавы';
  if (/пад|fall|высот/.test(c)) return 'не прыгай с высоты, спускайся лестницей/блоками';
  if (/утону|воды|drown/.test(c)) return 'следи за воздухом, не плыви глубоко без нужды';
  if (/голод|starv/.test(c)) return 'держи еду: hunt и smelt заранее, ешь до 6 сытости';
  if (/взрыв|creeper|крипер/.test(c)) return 'держи дистанцию до криперов, бей издали/отступай';
  if (/zombie|skeleton|spider|моб|убит|enderman|witch|pillager|drowned|husk|stray|phantom/.test(c)) return 'ночью укрытие (shelter/wait_night), броня и оружие раньше стройки, при low_hp — escape';
  return 'разберись в причине и поменяй поведение, не повторяй то же';
}

function create(ctx, opts = {}) {
  const now = opts.now || Date.now;
  const dir = opts.dir || ctx.dataDir || path.join(__dirname, '..', 'data');
  const persist = opts.persist !== false;
  const FILE = path.join(dir, 'critic.json'), REPORT = path.join(dir, 'critic_report.md');
  const c = {
    digs: [], cmds: [], fails: [], deaths: [], advices: [], // {t,...}, храним ≤ часа
    since: {},            // rule -> время последнего совета: считаем только нарушения после него
    totals: {},           // rule -> {advices, last}
    progress: { seen: [], tier: 0, max: {}, lastAt: now() },
    samples: [], idle10: 0, idle60: 0, startedAt: now(), reportAt: 0, lastAdviceAt: 0, lastRuleAt: {}
  };
  for (const r of RULES) c.totals[r] = { advices: 0, last: null };
  const seen = new Set();

  // ---- загрузка состояния ----
  if (persist) {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const cut = now() - HOUR;
      for (const k of ['digs', 'cmds', 'fails', 'deaths', 'advices']) c[k] = (j[k] || []).filter(e => e && e.t > cut);
      for (const r of RULES) if (j.totals && j.totals[r]) c.totals[r] = j.totals[r];
      if (j.progress) { c.progress.tier = j.progress.tier || 0; c.progress.max = j.progress.max || {}; for (const n of j.progress.seen || []) seen.add(n); }
      c.since = j.since || {};
    } catch (e) {}
  }

  const inv = () => { try { return ctx.bot.inventory.items(); } catch (e) { return []; } };
  const trim = () => { const cut = now() - HOUR; for (const k of ['digs', 'cmds', 'fails', 'deaths', 'advices']) { const a = c[k]; let i = 0; while (i < a.length && a[i].t <= cut) i++; if (i) a.splice(0, i); if (a.length > 600) a.splice(0, a.length - 600); } };
  const counts = items => {
    const m = {}; for (const i of items) m[i.name] = (m[i.name] || 0) + i.count;
    const sum = re => Object.entries(m).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);
    return { m, logs: sum(/_(log|stem)$/), planks: sum(/_planks$/), sticks: m.stick || 0, cobble: sum(/^(cobblestone|cobbled_deepslate|blackstone)$/),
      coal: (m.coal || 0) + (m.charcoal || 0), iron: (m.iron_ingot || 0) + (m.raw_iron || 0), ingot: m.iron_ingot || 0, diamond: m.diamond || 0, food: sum(FOOD_RE) };
  };
  const tierOf = items => { let t = 0; for (const i of items) { const mm = /^(\w+?)_pickaxe$/.exec(i.name); if (mm && (TIER[mm[1]] || 0) > t) t = TIER[mm[1]]; } return t; };

  // ---- прогресс ----
  function pollProgress() {
    if (!ctx.ready) return;
    const items = inv(), p = c.progress, k = counts(items); let up = false;
    for (const i of items) if (!seen.has(i.name)) { seen.add(i.name); up = true; }
    const t = tierOf(items); if (t > p.tier) { p.tier = t; up = true; }
    for (const [key, v] of [['logs', k.logs], ['cobble', k.cobble], ['coal', k.coal], ['iron', k.iron], ['diamond', k.diamond], ['food', k.food]])
      if (v > (p.max[key] || 0)) { p.max[key] = v; up = true; }
    p.seen = [...seen];
    if (up && !c.baseline) { /* первый опрос — это базовая линия, не прогресс */ } else if (up) p.lastAt = now();
    c.baseline = true;
  }

  // ---- вход: события и копание ----
  function onEvent(type, d) {
    const t = now();
    if (type === 'task_started') { if ((d.name === 'dig_at' || d.name === 'place_at') && (d.source || 'brain') === 'brain') c.cmds.push({ t, name: d.name }); }
    else if (type === 'task_failed') c.fails.push({ t, skill: d.name, err: normErr(d.reason), raw: String(d.reason || '').slice(0, 120) });
    else if (type === 'death') c.deaths.push({ t, cause: String(d.cause || 'неизвестно') });
    else if (type === 'task_done') pollProgress();
  }
  function onDig(block) {
    if (!block || !block.name) return;
    const kind = toolKindOf(block.name);
    if (!kind) return;
    if (inv().some(i => i.name.endsWith('_' + kind))) return;
    c.digs.push({ t: now(), kind, block: block.name });
  }

  // ---- idle ----
  function sample() {
    if (!ctx.ready) return;
    pollProgress();
    const tk = ctx.tasks || {};
    const busy = !!(tk.current || (tk.queue && tk.queue.length) || tk.legacyBusy || ctx.manualControl);
    c.samples.push({ t: now(), idle: !busy });
    const cut = now() - HOUR; while (c.samples.length && c.samples[0].t <= cut) c.samples.shift();
  }
  const idlePct = ms => { const s = c.samples.filter(x => x.t > now() - ms); return s.length ? Math.round(100 * s.filter(x => x.idle).length / s.length) : 0; };

  // ---- правила: каждое возвращает {rule,msg,count} или null ----
  const after = (rule, e) => e.t >= (c.since[rule] || 0);
  function ruleHand() {
    const es = c.digs.filter(e => e.t > now() - CFG.handWin && after('hand_tool', e));
    const by = {}; for (const e of es) (by[e.kind] = by[e.kind] || []).push(e);
    const kind = Object.keys(by).sort((a, b) => by[b].length - by[a].length)[0];
    if (!kind || by[kind].length < CFG.handN) return null;
    const n = by[kind].length, k = counts(inv()), need = kind === 'shovel' ? 1 : 3;
    const blocks = [...new Set(by[kind].map(e => e.block))].slice(0, 2).join('/');
    const tool = k.cobble >= need ? 'stone_' + kind : 'wooden_' + kind;
    const mat = tool.startsWith('stone') ? k.cobble : k.planks;
    const matName = tool.startsWith('stone') ? 'cobble' : 'planks';
    const miss = [];
    if (mat < need) miss.push(`${matName} ${mat}/${need}`);
    if (k.sticks < 2) miss.push(`sticks ${k.sticks}/2` + (k.planks >= 2 || k.logs ? ' (craft stick из planks)' : ''));
    const have = `есть: cobble ${k.cobble}, planks ${k.planks}, sticks ${k.sticks}, logs ${k.logs}`;
    return { rule: 'hand_tool', count: n, msg: `добываю ${blocks} (${WHAT_RU[kind]}) без ${KIND_RU[kind]} уже ${n} раз — скрафти ${tool} (${have}; ${miss.length ? 'не хватает: ' + miss.join(', ') + ' — добудь/скрафти' : 'материалов хватает, craft ' + tool}). Потом работай с инструментом` };
  }
  function ruleMicro() {
    const es = c.cmds.filter(e => e.t > now() - CFG.microWin && after('micro_cmds', e));
    if (es.length < CFG.microN) return null;
    return { rule: 'micro_cmds', count: es.length, msg: `${es.length} команд dig_at/place_at за 3 мин — копаешь/ставишь по одному блоку. Используй collect block=stone count=N (или другой block) / build-навык из learned, а не поштучно` };
  }
  function ruleFail() {
    const es = c.fails.filter(e => e.t > now() - CFG.failWin && after('repeat_fail', e));
    const by = {}; for (const e of es) { const key = e.skill + '|' + e.err; (by[key] = by[key] || []).push(e); }
    const key = Object.keys(by).sort((a, b) => by[b].length - by[a].length)[0];
    if (!key || by[key].length < CFG.failN) return null;
    const list = by[key], f = list[list.length - 1];
    return { rule: 'repeat_fail', count: list.length, msg: `навык ${f.skill} провалился ${list.length} раза за 10 мин с одной ошибкой «${f.raw}» — не повторяй, сделай иначе: ${failHint(f.err)}` };
  }
  function ruleStall() {
    const last = Math.max(c.progress.lastAt, c.since.stall || 0);
    if (now() - last < CFG.stallMs) return null;
    const k = counts(inv()), t = tierOf(inv());
    let nxt;
    if (t === 0) nxt = `нет кирки (logs ${k.logs}, planks ${k.planks}, sticks ${k.sticks}) → collect log, craft planks/stick, craft wooden_pickaxe`;
    else if (t === 1) nxt = `следующий тир — stone_pickaxe: cobble ${k.cobble}/3, sticks ${k.sticks}/2 → collect stone, craft stone_pickaxe`;
    else if (t === 2) nxt = `следующий тир — iron_pickaxe: железа ${k.iron}/3 (слитков ${k.ingot}), угля ${k.coal} → collect coal и iron, smelt iron_ingot, craft iron_pickaxe`;
    else if (t === 3) nxt = `следующий тир — diamond_pickaxe: алмазов ${k.diamond}/3 → глубже (y -50…16), find/collect diamond`;
    else nxt = 'тиры инструментов закрыты — бери следующую цель из PROJECT.md';
    if (k.food === 0) nxt += '; еды нет → hunt, smelt';
    return { rule: 'stall', count: Math.round((now() - last) / MIN), msg: `прогресса нет ${Math.round((now() - last) / MIN)} мин (ни нового предмета, ни тира, ни рекордов ресурсов): ${nxt}` };
  }
  function ruleDeaths() {
    const es = c.deaths.filter(e => e.t > now() - HOUR);
    const by = {}; for (const e of es) (by[e.cause] = by[e.cause] || []).push(e);
    const cause = Object.keys(by).sort((a, b) => by[b].length - by[a].length)[0];
    if (!cause || by[cause].length < CFG.deathN) return null;
    if (!by[cause].some(e => after('deaths', e))) return null; // уже советовали, новых смертей нет
    return { rule: 'deaths', count: by[cause].length, msg: `смерть от «${cause}» ${by[cause].length} раза за час — ${deathHint(cause)}` };
  }
  const RUNNERS = { deaths: ruleDeaths, repeat_fail: ruleFail, hand_tool: ruleHand, micro_cmds: ruleMicro, stall: ruleStall };

  function emit(a) {
    const t = now();
    c.lastAdviceAt = t; c.lastRuleAt[a.rule] = t; c.since[a.rule] = t;
    c.advices.push({ t, rule: a.rule, msg: a.msg, count: a.count });
    c.totals[a.rule].advices++; c.totals[a.rule].last = new Date(t).toISOString();
    c.fresh = { t, rule: a.rule, msg: a.msg };
    // мозгу советы не шлём (решение хозяина 21.10): только отчёт data/critic_report.md для людей
    return a;
  }

  // раз в 60 с: пересчёт, не больше одного совета
  function tick() {
    trim(); pollProgress();
    c.idle10 = idlePct(CFG.idleWin); c.idle60 = idlePct(HOUR);
    const t = now(); let out = null;
    if (t - c.lastAdviceAt >= CFG.globalCooldown) {
      for (const r of PRIORITY) {
        if (t - (c.lastRuleAt[r] || 0) < CFG.ruleCooldown) continue;
        const a = RUNNERS[r](); if (a) { out = emit(a); break; }
      }
    }
    if (persist) save();
    if (t - c.reportAt >= CFG.reportEvery) writeReport();
    return out;
  }

  function summary() {
    const t = now(), hr = a => a.filter(e => e.t > t - HOUR);
    const deaths = {}; for (const e of hr(c.deaths)) deaths[e.cause] = (deaths[e.cause] || 0) + 1;
    const fails = {}; for (const e of hr(c.fails)) { const k = e.skill + ': ' + e.raw; fails[k] = (fails[k] || 0) + 1; }
    const handBy = {}; for (const e of hr(c.digs)) handBy[e.kind] = (handBy[e.kind] || 0) + 1;
    const adv = {}; for (const e of hr(c.advices)) adv[e.rule] = (adv[e.rule] || 0) + 1;
    const fixBody = Object.keys(adv).filter(r => adv[r] >= CFG.ignoredN).map(r => ({ rule: r, advices: adv[r], fix: BODY_FIX[r] || '' }));
    const k = counts(inv());
    return {
      ok: true, now: new Date(t).toISOString(), idle10: c.idle10, idle60: c.idle60,
      hour: { handDigs: handBy, microCmds: hr(c.cmds).length, repeatFails: fails, deaths, advices: adv },
      totals: c.totals, fixBody, lastAdvices: c.advices.slice(-10),
      progress: { tier: c.progress.tier, tierName: ['нет кирки', 'деревянная', 'каменная', 'железная', 'алмазная', 'незеритовая'][c.progress.tier] || '?', max: c.progress.max, now: { logs: k.logs, cobble: k.cobble, coal: k.coal, iron: k.iron, diamond: k.diamond, food: k.food }, noProgressMin: Math.round((t - c.progress.lastAt) / MIN), seenItems: seen.size }
    };
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const s = summary();
      fs.writeFileSync(FILE, JSON.stringify({ ...s, digs: c.digs, cmds: c.cmds, fails: c.fails, deaths: c.deaths, advices: c.advices, since: c.since, progress: { ...s.progress, seen: [...seen] } }, null, 1));
    } catch (e) {}
  }

  function reportText() {
    const s = summary(), h = s.hour, L = [];
    const hh = new Date(now()).toTimeString().slice(0, 5);
    L.push(`# Отчёт критика (${hh})`, '');
    L.push('## Топ проблем за последний час');
    const probs = [];
    const hand = Object.entries(h.handDigs).map(([k, n]) => `${KIND_RU[k] ? 'без ' + KIND_RU[k] : k}: ${n} блоков`);
    if (hand.length) probs.push(`- Добыча без инструмента: ${hand.join(', ')} (советов: ${h.advices.hand_tool || 0})`);
    if (h.microCmds) probs.push(`- dig_at/place_at от мозга: ${h.microCmds} (советов: ${h.advices.micro_cmds || 0})`);
    for (const [k, n] of Object.entries(h.repeatFails).sort((a, b) => b[1] - a[1]).slice(0, 5)) if (n >= 2) probs.push(`- Повтор провала ×${n}: ${k}`);
    if (h.advices.stall) probs.push(`- Нет прогресса: советов ${h.advices.stall}`);
    L.push(probs.length ? probs.join('\n') : '- нет', '');
    L.push('## Простой', `- тело без дела: ${s.idle10}% за 10 мин, ${s.idle60}% за час` + (s.idle10 > CFG.idlePct ? ' — много' : ''), '');
    L.push('## Смерти по причинам (час)');
    const dd = Object.entries(h.deaths); L.push(dd.length ? dd.map(([k, n]) => `- ${k}: ${n}`).join('\n') : '- нет', '');
    const p = s.progress;
    L.push('## Прогресс', `- лучшая кирка: ${p.tierName}`, `- рекорды: ${Object.entries(p.max).map(([k, v]) => k + ' ' + v).join(', ') || '—'}`,
      `- сейчас: ${Object.entries(p.now).map(([k, v]) => k + ' ' + v).join(', ')}`, `- без прогресса: ${p.noProgressMin} мин; видел типов предметов: ${p.seenItems}`, '');
    L.push('## Что чинить в теле');
    L.push(s.fixBody.length ? s.fixBody.map(f => `- ${f.rule} (${RULE_NAME[f.rule]}): ${f.advices} советов за час, мозг игнорирует → ${f.fix}`).join('\n') : '- пока нечего (нет правил, сработавших ≥3 раз после совета)', '');
    L.push('## Последние советы');
    L.push(s.lastAdvices.length ? s.lastAdvices.slice(-6).map(a => `- ${new Date(a.t).toTimeString().slice(0, 5)} [${a.rule}] ${a.msg}`).join('\n') : '- нет');
    return L.join('\n') + '\n';
  }
  function writeReport() {
    c.reportAt = now();
    if (!persist) return;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(REPORT, reportText()); } catch (e) {}
  }

  const freshAdvice = (ms = 120000) => (c.fresh && now() - c.fresh.t < ms ? c.fresh : null);
  return { onEvent, onDig, sample, tick, summary, reportText, writeReport, freshAdvice, state: c, cfg: CFG, pollProgress };
}

// Подключение к боту (один критик на процесс: счётчики живут между переподключениями)
function attach(ctx, session) {
  const bot = ctx.bot;
  let cr = ctx.critic;
  if (!cr) {
    cr = ctx.critic = create(ctx);
    const orig = ctx.events.push.bind(ctx.events);
    ctx.events.push = (type, data) => { const ev = orig(type, data); if (type !== 'advice') { try { cr.onEvent(type, data || {}); } catch (e) {} } return ev; };
  }
  const live = fn => () => { if (!session.ended && ctx.bot === bot) { try { fn(); } catch (e) {} } };
  try { require('./dug').onDug(bot, block => cr.onDig(block)); } catch (e) {} // не diggingCompleted: тот отдаёт воздух и снимается при смерти
  if (session.timers) {
    session.timers.push(setInterval(live(() => cr.sample()), CFG.sampleMs));
    session.timers.push(setInterval(live(() => cr.tick()), 60000));
  }
  return cr;
}

module.exports = { attach, create, toolKindOf, normErr, CFG };
