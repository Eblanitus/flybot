// Автопилот: когда мозг молчит >= 30 с и тело свободно, тело само делает полезное — по одному навыку за раз
// (source:'autopilot'): защита → ночь (укрытие, night_mine) → день (day_routine) → простые навыки.
// Мозг всегда главнее: любая его команда вытесняет навык автопилота (tasks.js) и прерывает выученный навык,
// запущенный автопилотом через исполнитель (POST :3200/abort). Задачи рефлексов автопилот не трогает никогда.
// Решение — чистая функция decide(state), её можно проверять без бота.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { goals } = require('mineflayer-pathfinder');
const { isHostile, isAnimal, isBuildBlock, entName, SkillError } = require('./util');
const A = require('./actions');
const { timeInfo } = require('./perception');
const threats = require('./threats');
const AG = require('./aggressors');
const vision = require('./vision');

const RUNNER = (process.env.RUNNER_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const IDLE_MS = 30000;     // столько мозг должен молчать (и тело стоять), чтобы автопилот взялся за дело
const TICK_MS = 2000;
const ENEMY_R = 16;        // враг-игрок ближе — реагировать сразу
const FAIL_MAX = 3;        // провалов подряд до паузы
const BACKOFF_MS = 60000;
const CHAT_MS = 60000;     // не чаще одного сообщения в чат в минуту
const GAME = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat'];
// команды мозга, которые только читают/говорят: время молчания сбрасывают, но автопилот не прерывают
const READONLY = new Set(['survey', 'snapshot', 'status', 'task', 'recipes', 'scan', 'chat', 'wait']);
const norm = s => String(s || '').toLowerCase().replace(/[\s_\-]/g, '');
const NOTES = path.join(__dirname, '..', 'brain', 'notes.md');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Цель мозга ----------
// В notes.md раздел «## Текущая цель» может содержать машинную строку «Автопилот: <навык> ключ=значение …»
// (например «Автопилот: collect block=stone count=60»). Днём автопилот продолжает её сам, пока мозг молчит.
function parseGoal(text) {
  const lines = String(text || '').split(/\r?\n/);
  let i = lines.findIndex(l => /^##\s*Текущая цель/.test(l));
  if (i < 0) return null;
  let line = null;
  for (i++; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^[\s>*_-]*Автопилот\s*:[\s*]*(.+)$/i.exec(lines[i]);
    if (m) { line = m[1]; break; }
  }
  if (!line) return null;
  const toks = line.replace(/[`*]/g, ' ').trim().split(/\s+/);
  const name = toks.shift();
  if (!name || !/^[A-Za-z_][\w-]*$/.test(name)) return null;
  const params = {};
  for (const t of toks) {
    const k = t.indexOf('=');
    if (k <= 0) continue;
    const v = t.slice(k + 1);
    let val = v; try { if (/^(-?\d|true$|false$|\[|\{)/.test(v)) val = JSON.parse(v); } catch (e) {}
    params[t.slice(0, k)] = val;
  }
  return { name, params, sig: name + ' ' + JSON.stringify(params) };
}

// ---------- База проекта ----------
// Машинная строка «База: x y z [радиус=N]» в любом месте notes.md (допустимы маркер списка и **жирный**), берётся первая
// найденная с тремя числами. Днём, если муха дальше радиуса (по горизонтали), автопилот сначала ведёт её на базу.
const BASE_R = 96;
function parseBase(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^[\s>*_-]*База\s*:[\s*]*(.+)$/i.exec(line);
    if (!m) continue;
    const rest = m[1].replace(/[`*]/g, ' ');
    const c = /(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)/.exec(rest);
    if (!c) continue;
    const rm = /радиус\s*=\s*(\d+(?:\.\d+)?)/i.exec(rest);
    const r = rm ? Number(rm[1]) : BASE_R;
    return { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]), r: r > 0 ? r : BASE_R };
  }
  return null;
}

// Навык автопилота «goto»: дойти до базы скачками по ~64 блока (длинный путь pathfinder за раз ведёт ненадёжно), как go_safe.
// params: {x,y,z,r,timeout(с)}. Бросает SkillError, если не дошла (нет продвижения / вышло время).
async function baseTravel(ctx, t, p) {
  const bot = ctx.bot;
  const hd = () => Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z);
  const arrive = Math.min(12, Math.max(2, (p.r || BASE_R) * 0.5));
  const deadline = Date.now() + (Number(p.timeout) > 0 ? Number(p.timeout) : 420) * 1000;
  let stalls = 0, lastErr = null;
  t.progress(`иду на базу (${Math.round(hd())} м)`);
  for (let hop = 0; hop < 14 && hd() > arrive; hop++) {
    t.check();
    const left = deadline - Date.now();
    if (left < 5000) throw new SkillError(`на базу не дошла: вышло время (осталось ${Math.round(hd())} м)`);
    const before = hd(), me = bot.entity.position;
    const goal = before <= 64 ? new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 3)
      : new goals.GoalNearXZ(Math.round(me.x + (p.x - me.x) * 64 / before), Math.round(me.z + (p.z - me.z) * 64 / before), 3);
    try { await A.goto(ctx, t, goal, { timeout: Math.min(left, 120000), sprint: true }); }
    catch (e) { if (e.aborted) throw e; lastErr = e.message; }
    if (before - hd() < 4) { if (++stalls >= 2) throw new SkillError(`на базу не дошла: ${lastErr || 'нет продвижения'} (осталось ${Math.round(hd())} м)`); }
    else stalls = 0;
  }
  if (hd() > arrive) throw new SkillError(`на базу не дошла: осталось ${Math.round(hd())} м`);
  return { arrived: true, left: Math.round(hd()) };
}

// ---------- Решение (чистая функция) ----------
// s: {on, idle, task:{name,source}|null, running:{key}|null, runnerOther, hp, food, hasFood, hasWeapon, hasPickaxe,
//     blocks, logs, cobble, phase, isNight, nightIn, sheltered, inLava, suffocating, stuck, underWater,
//     hostilesNear, enemies:[{name,d,why,aggressor}], alone, freeBed, animals, recoverable, blocked:{key:true},
//     goal:{name,params,kind:'body'|'learned'}|null (цель мозга из notes.md), goalDone,
//     base:{x,y,z,r}|null (строка «База:» из notes.md), baseDist (горизонтальная дистанция до базы, null если не считается)}
// -> null | {key, kind:'body'|'learned', name, params, why, preempt?}
function decide(s) {
  if (!s.on) return null;
  if (s.task && s.task.source !== 'autopilot') return null; // мозг или рефлекс заняли тело — не лезем
  if (s.runnerOther) return null;                            // мозг запустил выученный навык
  const run = s.running ? s.running.key : null;
  const ok = k => !(s.blocked && s.blocked[k]);
  const body = (key, name, params, why, preempt) => ({ key, kind: 'body', name, params: params || {}, why, ...(preempt ? { preempt: true } : {}) });
  const learned = (key, name, params, why) => ({ key, kind: 'learned', name, params: params || {}, why });

  // 1. враг-игрок рядом — сразу, даже если мозг говорил недавно (тело свободно или работает автопилот)
  const en = (s.enemies || [])[0];
  if (en) {
    if (run === 'fight_player' || run === 'escape_player') return null;
    if (en.aggressor && s.hasWeapon && s.hp >= 12 && s.alone && ok('fight_player'))
      return body('fight_player', 'fight', { target: en.name, radius: 16, flee_hp: 8, timeout: 45 }, `отбиваюсь от ${en.name}`, true);
    if (ok('escape_player')) return body('escape_player', 'escape', { distance: 24, shelter: true }, `убегаю от ${en.name} (${en.why})`, true);
  }
  if (run || s.task) return null; // свой навык идёт — не дёргать
  if (!s.idle) return null;       // мозг недавно командовал — ждём

  // 2. безопасность
  if ((s.inLava || s.suffocating || s.stuck || s.underWater) && ok('unstuck'))
    return body('unstuck', 'explore', { distance: 8 }, s.inLava ? 'выбираюсь из лавы' : s.suffocating ? 'выбираюсь из блока' : s.underWater ? 'выплываю из воды' : 'выбираюсь: застрял');
  if (s.hp < 10) {
    if (s.hostilesNear > 0 && ok('lowhp_escape')) return body('lowhp_escape', 'escape', { distance: 16, shelter: true }, `мало HP (${s.hp}) — убегаю`);
    if (!s.sheltered && ok('lowhp_shelter')) return body('lowhp_shelter', 'shelter', {}, `мало HP (${s.hp}) — укрываюсь`);
    return null; // в укрытии восстанавливаемся (ест рефлекс)
  }
  const night = s.isNight || s.nightIn < 40;
  if (night && !s.sheltered && s.hostilesNear > 0 && ok('night_shelter')) return body('night_shelter', 'shelter', {}, 'монстры рядом ночью — укрываюсь');

  // 3. после смерти — за вещами (днём; если у места смерти враг — recover откажет сам)
  if (s.recoverable && !night && ok('recover')) return body('recover', 'recover', {}, 'иду за вещами к месту смерти');

  // 4. ночь: укрытие → туннель night_mine → кровать → переждать
  if (night) {
    if (!s.sheltered) {
      if (s.blocks < 9 && s.hostilesNear === 0 && ok('night_dirt')) return body('night_dirt', 'collect', { block: 'dirt', count: 10 - s.blocks }, 'запасаю землю на укрытие');
      if (s.hasPickaxe && ok('night_shelter_dig')) return body('night_shelter_dig', 'shelter', { mode: 'dig' }, 'ночь: закапываюсь');
      if (ok('night_shelter')) return body('night_shelter', 'shelter', {}, 'ночь: строю укрытие');
    }
    if ((s.phase === 'ночь' || s.phase === 'закат') && ok('night_mine')) return learned('night_mine', 'night_mine', {}, 'копаю туннель ночью');
    if (s.isNight && s.freeBed && ok('sleep')) return body('sleep', 'sleep', {}, 'сплю в кровати');
    if (s.isNight && ok('wait_night')) return body('wait_night', 'wait_night', { max_sec: 720 }, 'пережидаю ночь');
    return null;
  }

  // 5a. день, далеко от базы проекта — сначала на базу (до цели мозга и day_routine); пока пауза после провала — стоим, а не уходим дальше
  if (s.base && s.baseDist != null && s.baseDist > s.base.r) {
    if (!ok('go_base')) return null;
    return body('go_base', 'goto', { x: s.base.x, y: s.base.y, z: s.base.z, r: s.base.r, timeout: 420 }, 'иду на базу');
  }

  // 5. день: цель мозга (строка «Автопилот:» в notes.md), потом длинный навык, иначе простые
  if (s.goal && !s.goalDone && ok('goal')) {
    const g = s.goal, why = `продолжаю цель мозга: ${g.name}${Object.keys(g.params).length ? ' ' + JSON.stringify(g.params) : ''}`;
    return g.kind === 'learned' ? learned('goal', g.name, g.params, why) : body('goal', g.name, g.params, why);
  }
  if (ok('day_routine')) return learned('day_routine', 'day_routine', { max_sec: 600 }, 'дневная работа (day_routine)');
  if (s.food < 14 && !s.hasFood && s.animals > 0 && ok('hunt')) return body('hunt', 'hunt', { count: 2 }, 'охочусь: нечего есть');
  if (!s.hasPickaxe && s.logs >= 3 && ok('craft_pick')) return body('craft_pick', 'craft', { item: 'wooden_pickaxe' }, 'делаю деревянную кирку');
  if (!s.hasPickaxe && s.logs < 8 && ok('collect_log')) return body('collect_log', 'collect', { block: 'log', count: 6 }, 'рублю дерево');
  if (s.hasPickaxe && s.cobble < 24 && ok('collect_stone')) return body('collect_stone', 'collect', { block: 'stone', count: 12 }, 'добываю камень');
  if (ok('explore')) return body('explore', 'explore', { distance: 48 }, 'исследую окрестности');
  return null;
}

// ---------- HTTP к исполнителю выученных навыков ----------
function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(new Error('исполнитель ответил не JSON')); } });
      res.on('error', reject);
    });
    req.on('error', e => reject(new Error('исполнитель недоступен: ' + (e.code || e.message))));
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('тайм-аут')));
    if (data) req.write(data);
    req.end();
  });
}
async function runnerActive() {
  try { const h = await httpJson('GET', RUNNER + '/health', undefined, 1500); return h && h.runner ? h.runner.active : null; }
  catch (e) { return null; }
}
function runnerGo(name, params, timeoutSec) {
  const q = new URLSearchParams({ name, wait: '1', timeout_sec: String(timeoutSec) });
  for (const [k, v] of Object.entries(params || {})) q.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return httpJson('GET', RUNNER + '/go?' + q.toString(), undefined, (timeoutSec + 60) * 1000);
}
const runnerAbort = () => httpJson('POST', RUNNER + '/abort', {}, 3000);

// ---------- Состояние мира для decide ----------
const baseDimOk = bot => String((bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '') === 'overworld';
function gather(ctx, ap) {
  const bot = ctx.bot;
  const now = Date.now();
  const p = bot.entity.position;
  const items = bot.inventory.items();
  const sum = re => items.filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0);
  let FOOD_BL = new Set(); try { FOOD_BL = require('./reflexes').FOOD_BLACKLIST; } catch (e) {}
  const foods = bot.registry.foodsByName || {};
  const head = bot.blockAt(p.offset(0, 1.6, 0)); const feet = bot.blockAt(p);
  const ents = Object.values(bot.entities).filter(e => e && e !== bot.entity && e.position);
  const hostiles = ents.filter(e => isHostile(e)).map(e => e.position.distanceTo(p));
  const enemies = threats.list(ctx).filter(t => t.d <= ENEMY_R).map(t => ({ ...t, aggressor: AG.isAggressor(ctx, t.name) }));
  let freeBed = false;
  try {
    const bedIds = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id);
    freeBed = vision.find(ctx, bedIds, { radius: 32, count: 20 }).map(q => bot.blockAt(q))
      .some(b => b && !(b.getProperties && b.getProperties().occupied));
  } catch (e) {}
  let sheltered = false; try { sheltered = require('./skills/survival').isSheltered(bot); } catch (e) {}
  const ti = timeInfo(bot);
  const cur = ctx.tasks.current;
  const ld = ctx.lastDeath;
  const blocked = {};
  for (const [k, t] of Object.entries(ap.until)) if (t > now) blocked[k] = true;
  return {
    on: ap.on, idle: now - Math.max(ap.lastBrainCmd, ap.lastBusy) >= IDLE_MS && now >= (ap.pausedUntil || 0), // pausedUntil — «стой» хозяина (lib/owner.js)
    task: cur ? { name: cur.name, source: cur.source } : null,
    running: ap.running ? { key: ap.running.key } : null, runnerOther: ap.runnerOther,
    hp: Math.round(bot.health), food: bot.food,
    hasFood: items.some(i => foods[i.name] && !FOOD_BL.has(i.name) && !i.name.endsWith('_bucket')),
    hasWeapon: items.some(i => /_sword$|_axe$/.test(i.name)),
    hasPickaxe: items.some(i => /_pickaxe$/.test(i.name)),
    blocks: items.filter(i => isBuildBlock(i.name) && !i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0),
    logs: sum(/_(log|stem)$/) + Math.floor(sum(/_planks$/) / 4), cobble: sum(/^(cobblestone|cobbled_deepslate)$/),
    phase: ti.phase, isNight: ti.isNight, nightIn: ti.nightIn, sheltered,
    inLava: [feet, head].some(b => b && b.name === 'lava'),
    suffocating: !!head && A.isSolid(head) && head.boundingBox === 'block',
    stuck: ap.stuckSince > 0 && now - ap.stuckSince > 6000,
    underWater: ap.wetSince > 0 && now - ap.wetSince > 10000,
    hostilesNear: hostiles.filter(d => d <= 10).length,
    enemies, alone: hostiles.filter(d => d <= 6).length === 0 && enemies.filter(e => e.d <= 10).length <= 1,
    freeBed, animals: ents.filter(e => isAnimal(e) && GAME.includes(entName(e)) && e.position.distanceTo(p) <= 32).length,
    recoverable: !!(ld && ld.at && now - ld.ts < 240000 && ap.recoverFor !== ld.ts),
    blocked, goal: ap.goal || null, goalDone: !!ap.goal && ap.goalDone === ap.goal.sig,
    base: ap.base || null, baseDist: ap.base && baseDimOk(bot) ? Math.hypot(ap.base.x - p.x, ap.base.z - p.z) : null
  };
}

// ---------- Подключение ----------
function create(ctx) {
  const ap = {
    on: true, lastBrainCmd: Date.now(), lastBusy: 0, running: null, runnerOther: false,
    goal: null, goalDone: null, goalMtime: -1, base: null, baseSig: '', goalSkills: { t: 0, names: new Set() },
    fails: {}, until: {}, lastChat: 0, recoverFor: 0, stuckSince: 0, wetSince: 0, lastPos: null, ticking: false, history: []
  };
  const note = (text, chat) => {
    ctx.events.push('info', { msg: 'автопилот: ' + text, autopilot: true });
    if (chat && Date.now() - ap.lastChat >= CHAT_MS && ctx.statusChat) { ap.lastChat = Date.now(); ctx.statusChat('автопилот: ' + text, true); }
  };

  // цель мозга из notes.md (кэш по mtime); learned — если такой навык есть в исполнителе, иначе навык тела
  async function refreshGoal() {
    let mt = 0; try { mt = fs.statSync(NOTES).mtimeMs; } catch (e) { ap.goal = null; ap.base = null; return; }
    if (mt !== ap.goalMtime) {
      ap.goalMtime = mt;
      let g = null, txt = ''; try { txt = fs.readFileSync(NOTES, 'utf8'); g = parseGoal(txt); } catch (e) {}
      ap.base = parseBase(txt);
      const bsig = ap.base ? `${ap.base.x} ${ap.base.y} ${ap.base.z} ${ap.base.r}` : '';
      if (bsig !== ap.baseSig) { ap.baseSig = bsig; delete ap.until.go_base; ap.fails.go_base = 0; } // новая база — пауза не действует
      if (!ap.goal || !g || g.sig !== ap.goal.sig) { delete ap.until.goal; ap.fails.goal = 0; }
      ap.goalRaw = g;
    }
    const g = ap.goalRaw;
    if (!g) { ap.goal = null; return; }
    const bodyName = (ctx.skillNames || []).find(k => norm(k) === norm(g.name));
    if (Date.now() - ap.goalSkills.t > 30000) {
      ap.goalSkills.t = Date.now();
      try { const r = await httpJson('GET', RUNNER + '/skills', undefined, 1500); ap.goalSkills.names = new Set((r.skills || []).map(x => x.name)); } catch (e) {}
    }
    if (ap.goalSkills.names.has(g.name)) ap.goal = { ...g, kind: 'learned' };
    else if (bodyName) ap.goal = { ...g, name: bodyName, kind: 'body' };
    else ap.goal = null;
  }

  // прервать свой текущий навык (и выученный навык в исполнителе) и дождаться, пока он отпустит тело
  ap.yieldAll = async reason => {
    const run = ap.running; if (!run) return;
    run.aborting = reason || 'прервано';
    if (run.kind === 'learned') { try { await runnerAbort(); } catch (e) {} await Promise.race([run.promise, sleep(6000)]); }
    else {
      const cur = ctx.tasks.current;
      if (cur && cur.source === 'autopilot') await ctx.tasks.stop(reason || 'автопилот');
      await Promise.race([run.promise, sleep(3000)]);
    }
  };

  // вызывает bot.js на каждую команду мозга (/cmd, /do), ДО выполнения команды
  ap.brainCommand = async action => {
    ap.lastBrainCmd = Date.now();
    if (READONLY.has(norm(action))) return;
    if (ap.running && ap.running.kind === 'learned') { note('уступаю мозгу: ' + action); await ap.yieldAll('команда мозга'); }
    // навык тела автопилота снимет сам tasks.start/body
  };
  // команды без User-Agent (node) идут от исполнителя; пока он выполняет навык автопилота — это команды автопилота
  ap.ownsRunner = () => !!(ap.running && ap.running.kind === 'learned');
  ap.setOn = async on => {
    ap.on = !!on;
    if (!ap.on) await ap.yieldAll('автопилот выключен');
    note(ap.on ? 'включён' : 'выключен');
    return ap.status();
  };
  ap.status = () => ({
    on: ap.on, active: !!ap.running, doing: ap.running ? ap.running.why : null,
    ...(ap.running ? { skill: ap.running.name, kind: ap.running.kind, sec: Math.round((Date.now() - ap.running.started) / 1000) } : {}),
    idleSec: Math.round((Date.now() - Math.max(ap.lastBrainCmd, ap.lastBusy)) / 1000),
    paused: Object.entries(ap.until).filter(([, t]) => t > Date.now()).map(([k, t]) => `${k} ${Math.round((t - Date.now()) / 1000)}с`)
  });

  function finish(run, res) {
    const now = Date.now(); const sec = (now - run.started) / 1000;
    const err = res && res.ok === false ? String(res.error || 'провал') : null;
    let verdict;
    if (run.kind === 'body' && res && res.taskId) {
      const h = ctx.tasks.history.find(x => x.id === res.taskId);
      if (h && h.status === 'aborted') run.aborting = run.aborting || h.error || 'прервано';
    }
    if (run.aborting) verdict = 'прерван';
    else if (err && /POST \/abort/.test(err)) { verdict = 'прерван мозгом'; ap.lastBrainCmd = now; }
    else if (err && /занят/.test(err)) { verdict = 'тело/исполнитель заняты'; ap.lastBusy = now; ap.until[run.key] = now + 5000; }
    else if (!err) {
      verdict = 'ok'; ap.fails[run.key] = 0;
      if (run.kind === 'learned' && sec < 20) ap.until[run.key] = now + 120000; // делать нечего — не крутить по кругу
      else if (sec < 3) ap.until[run.key] = now + 15000;
    } else {
      verdict = 'провал';
      const n = (ap.fails[run.key] || 0) + 1; ap.fails[run.key] = n;
      if (run.kind === 'learned') ap.until[run.key] = now + (/выключен|не найден/.test(err) ? 600000 : BACKOFF_MS); // не доводить до автоотключения
      else if (n >= FAIL_MAX) { ap.until[run.key] = now + BACKOFF_MS; ap.fails[run.key] = 0; }
      else ap.until[run.key] = now + 4000;
    }
    if (run.key === 'goal') { if (verdict === 'ok') ap.goalDone = run.sig; else if (verdict === 'провал') ap.until.goal = now + BACKOFF_MS; }
    ap.history.push({ key: run.key, name: run.name, verdict, sec: Math.round(sec), ...(err ? { error: err.split('\n')[0].slice(0, 160) } : {}) });
    if (ap.history.length > 20) ap.history.shift();
    note(`${run.name}: ${verdict}${err && verdict === 'провал' ? ' — ' + err.split('\n')[0].slice(0, 120) : ''}`);
    if (ap.running === run) ap.running = null;
  }

  function start(act) {
    const run = { ...act, started: Date.now(), aborting: null, ...(act.key === 'goal' && ap.goal ? { sig: ap.goal.sig } : {}) };
    ap.running = run;
    if (act.key === 'recover' && ctx.lastDeath) ap.recoverFor = ctx.lastDeath.ts;
    note(act.why, true);
    const p = act.kind === 'learned'
      ? runnerGo(act.name, act.params, act.name === 'day_routine' ? 720 : 900)
      : act.name === 'goto' // не навык из SKILLS: переход на базу — свой Task (source autopilot)
        ? ctx.tasks.start('goto', act.params, t => baseTravel(ctx, t, act.params), { source: 'autopilot', wait: true })
        : ctx.runSkill(act.name, act.params, { source: 'autopilot', wait: true });
    run.promise = Promise.resolve(p).then(r => finish(run, r), e => finish(run, { ok: false, error: e && e.message ? e.message : String(e) }));
  }

  ap.tick = async () => {
    const bot = ctx.bot;
    if (ap.ticking || !ctx.ready || !bot || !bot.entity || bot.health <= 0) return;
    ap.ticking = true;
    try {
      const now = Date.now();
      const cur = ctx.tasks.current;
      if ((cur && cur.source !== 'autopilot') || ctx.tasks.legacyBusy) ap.lastBusy = now;
      if (!ap.running) { const act = await runnerActive(); ap.runnerOther = !!act; if (act) ap.lastBusy = Date.now(); }
      else ap.runnerOther = false;
      // застрял (в воздухе без движения: лиана, паутина, яма) / долго под водой
      const p = bot.entity.position;
      const head = bot.blockAt(p.offset(0, 1.6, 0));
      const wet = !!head && head.name === 'water';
      ap.wetSince = wet ? (ap.wetSince || now) : 0;
      const still = ap.lastPos && ap.lastPos.distanceTo(p) < 0.05;
      ap.stuckSince = (!bot.entity.onGround && still && !wet && !cur) ? (ap.stuckSince || now) : 0;
      ap.lastPos = p.clone();
      if (!ap.on) return;
      await refreshGoal();
      const act = decide(gather(ctx, ap));
      if (!act) return;
      if (ap.running) { if (!act.preempt) return; await ap.yieldAll('безопасность: ' + act.why); if (ap.running) return; }
      if (ctx.tasks.current) return; // пока ждали, тело занял мозг или рефлекс
      start(act);
    } catch (e) {
      console.log('[autopilot] tick:', e && e.message);
    } finally { ap.ticking = false; }
  };
  return ap;
}

// Один раз на экземпляр бота (из reflexes.attach). Состояние живёт в ctx.autopilot между переподключениями.
function attach(ctx, session) {
  const ap = ctx.autopilot || (ctx.autopilot = create(ctx));
  const bot = session.bot || ctx.bot;
  try { bot.on('death', () => { ap.yieldAll('смерть').catch(() => {}); }); } catch (e) {}
  session.timers.push(setInterval(() => { if (!session.ended && ctx.bot === bot) ap.tick(); }, TICK_MS));
  return ap;
}

module.exports = { attach, decide, gather, create, parseGoal, parseBase, baseTravel, IDLE_MS, READONLY };
