// версия: как v3, но max_y — потолок подъёма: если уже выше, ищет спуск и ведёт вниз, а не отказывает
// home_path — дорога по ЗАДАННОМУ маршруту точек: по поверхности, по порядку, без гор.
//
// Правка по заявке мозга (проект «Цитадель над Бездной», случай 20261022-045900-00,
// уроки L008/L020/L027): дорога спавн→база (330 м) убивала муху каждый раз (смерти 9, 10, 11).
//   было: pathfinder вёл в горы — муха забиралась на y=112 (пик x=-280), там ночью зомоби убили
//   её вместе со всем грузом; go_safe отказывался («залезла в гору»), автопилот шёл по прямой.
//
//   стало:
//   1) маршрут идём ТОЧКА ЗА ТОЧКОЙ (не перепрыгиваем): каждый шаг планируем по земле —
//      survey вдоль пути, и если рельеф поднимается выше max_climb (по умолчанию 6) —
//      ищем обход вбок (дольше по горизонтали, ниже по высоте), а не лезем вверх;
//   2) max_y (по умолчанию 100) — жёсткий потолок высоты: путь выше — отказ с причиной,
//      на пик не лезем (пик x=-280 — это y=112);
//   3) night_wait: 1 (по умолчанию) — ночью переждать до утра (как было), 0 — идти и ночью
//      (день 10 мин не хватает на дорогу + стройку, муха работала ночью в открытом поле);
//   4) причина отказа — в error: «не дошла до <точка>: <почему>»;
//   5) в ответе — пройденные точки и фактическое время (passed, sec), чтобы было видно,
//      где дорога ломается.
//
// Правка по заявке учителя (случай 20261022-063011-57, смерть 19, уроки L039/L040/L002):
//   было: max_y был заморозкой — если тело уже выше потолка, навык отказывал от маршрута
//   целиком («сейчас y=103 выше max_y=100 — в гору не иду»), хотя точки маршрута ниже (y=67):
//   муха стояла на склоне в 300 м от базы, мозг повторял тот же вызов (L002), а через минуту
//   зомби убил её на сборе брёвен (смерть 19).
//   стало:
//   1) max_y — потолок ПОДЪЁМА, а не заморозка: выше потолка не отказываем, а ищем спуск
//      (точки маршрута ниже) и ведём вниз — в лог «спускаюсь с y=…». Отказ «в гору не иду»
//      остался только там, где подъём выше потолка действительно нужен;
//   2) перебежку, ушедшую выше потолка, не бросаем там: возвращаем тело вниз (назад по своему
//      следу / ступень вниз) и продолжаем путь;
//   3) отказ по высоте или по мобу не оставляет тело в поле: заканчиваем укрытием
//      (wait_night ночью, shelter днём); если укрытия нет — отказ с причиной, а не тишина;
//   4) бегство от моба не повторяем 5 раз подряд: после побега моб рядом — второй раз не бегаем,
//      уходим в укрытие или отказываем честно;
//   5) ночное пережидание — независимо от расстояния до цели: ночью/в сумерках с мобом рядом
//      укрытие сразу, даже если цель близко.
//
// Правила прошлых правок (учитель, урок L022) сохранены:
//   HP<8 и врагов рядом нет — escape не зовём (пустая команда): про HP решаем один раз —
//   еда в инвентаре есть → eat и ждём регена, еды нет → явный отказ «HP N, еды нет — идти нельзя»;
//   escape — только когда враг реально рядом; провал точки: обходы перебежкой/pillar_up/dig_at.
'use strict';

const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
// еда, которую тело согласится съесть (гнилое/ядовитое/золотые яблоки pickFood отбрасывает)
const FOODS = /^(cooked_[a-z_]+|baked_potato|bread|apple|golden_carrot|carrot|beef|porkchop|mutton|rabbit|cod|salmon|melon_slice|sweet_berries|dried_kelp|pumpkin_pie|cookie|mushroom_stew|beetroot_soup|rabbit_stew)$/;
const REGEN_FOOD = 18;   // порог сытости для регена (в теле так же)

const TAIGA = [[-64, 78, 9], [-73, 70, 12], [-60, 78, 23]];
const TUNNEL = [[-367, 48, 37], [-350, 50, 37], [-378, 54, 28]];
const SURFACE_POINT = [-330, 68, 36];

const TREE_RE = /(_log|_leaves|_wood)$/;   // листва/стволы — не земля
const SURVEY_SAFE = 3800;                  // объём survey (ядро просит ≤ 4096 блоков)
const OFFSETS = [8, -8, 16, -16, 24, -24, 32, -32];   // обходы вбок, м

function parsePoints(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map(a => String(a).split(/[,\s]+/).map(Number))
      .filter(a => a.length >= 3 && a.slice(0, 3).every(Number.isFinite))
      .map(a => a.slice(0, 3).map(Math.round));
  }
  const nums = (String(v).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const out = [];
  for (let i = 0; i + 2 < nums.length; i += 3) out.push([nums[i], nums[i + 1], nums[i + 2]].map(Math.round));
  return out;
}

function near(p, x, z) { return dist2(p.x, p.z, x, z) <= 2.5; }

// ---- состояние мухи: HP, сытость, еда в инвентаре, враги рядом ----
function hpOf(snap) {
  const v = snap && snap.eyes && snap.eyes.vitals && snap.eyes.vitals.hp;
  if (Number.isFinite(Number(v))) return Number(v);
  const h = snap && snap.health;
  return Number.isFinite(Number(h)) ? Number(h) : 20;
}
function foodLevel(snap) {
  const v = snap && snap.eyes && snap.eyes.vitals && snap.eyes.vitals.food;
  if (Number.isFinite(Number(v))) return Number(v);
  const f = snap && snap.food;
  return Number.isFinite(Number(f)) ? Number(f) : 20;
}
function invFood(snap) {
  const names = [];
  let n = 0;
  for (const i of (snap && snap.inventory) || []) {
    if (i && i.name && FOODS.test(i.name)) { n += (i.count || 0); names.push(i.name); }
  }
  return { n, names };
}
// враг рядом: враг-игрок (eyes.threats) или враждебный моб (eyes.enemies). Пусто — врагов нет.
function foeNear(eyes, cfg) {
  const th = (eyes.threats || []).filter(t => t && t.d != null && t.d <= cfg.threatD)[0];
  if (th) return { name: th.name, d: th.d, kind: 'игрок' };
  const mob = (eyes.enemies || []).filter(e => e && e.d != null && e.d <= cfg.mobD)[0];
  if (mob) return { name: mob.name, d: mob.d, kind: 'моб' };
  return null;
}

function isNight(t) {
  if (!t) return false;
  if (t.phase === 'ночь') return true;
  return t.phase === 'закат' && Number.isFinite(Number(t.nightIn)) && Number(t.nightIn) <= 60;
}
// темно: ночь, сумерки (закат) и рассвет — в это время мобы опасны, укрытие нужно сразу
function isDark(t) {
  if (!t) return false;
  if (t.phase === 'ночь') return true;
  if (t.phase === 'рассвет') return true;
  return t.phase === 'закат' && Number.isFinite(Number(t.nightIn)) && Number(t.nightIn) <= 90;
}

function nearest(p, list) {
  let best = list[0], bd = Infinity;
  for (const q of list) {
    const d = dist2(p.x, p.z, q[0], q[2]);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function defaultRoute(p, surface) {
  if (surface) {
    const pts = [];
    const d = dist2(p.x, p.z, SURFACE_POINT[0], SURFACE_POINT[2]);
    if (d > 60) {
      const n = Math.min(12, Math.ceil(d / 48));
      for (let i = 1; i < n; i++) {
        const k = i / n;
        pts.push([Math.round(p.x + (SURFACE_POINT[0] - p.x) * k), null, Math.round(p.z + (SURFACE_POINT[2] - p.z) * k)]);
      }
    }
    pts.push(SURFACE_POINT);
    return pts;
  }
  const pts = [];
  const taiga = nearest(p, TAIGA);
  if (dist2(p.x, p.z, taiga[0], taiga[2]) <= 80) pts.push(taiga);
  for (const q of TUNNEL) pts.push(q);
  return pts;
}

// ---- снимок, опасности, смерть ----
async function snapOf(api) { try { return await api.snapshot(); } catch (e) { return null; } }
async function stopBody(api) { try { await api.stop(); } catch (e) { /* тело и так молчит */ } await api.sleep(250); }
function hazardsOf(snap) {
  const eyes = (snap && snap.eyes) || {};
  const danger = (snap && snap.danger) || {};
  const fire = danger.fire || {}, lava = danger.lava || {}, air = danger.air || {};
  const hz = (eyes.hazards || []).map(String);
  return {
    burning: !!fire.burning || hz.some(h => /горю/.test(h)),
    inLava: !!lava.inLava || hz.some(h => /лава/.test(h)),
    underWater: !!air.underWater || hz.some(h => /под водой/.test(h))
  };
}
function deathInfo(snap, o) {
  if (!snap || snap.ready === false || !snap.position) return 'муха погибла (тело не отвечает)';
  const d = snap.stats && Number(snap.stats.deaths);
  if (Number.isFinite(d) && d > o.deaths0) return 'муха погибла (респавн)';
  const p = snap.position;
  if (o.lastPos && p) {
    const jump = Math.hypot((p.x || 0) - o.lastPos.x, (p.y || 0) - o.lastPos.y, (p.z || 0) - o.lastPos.z);
    if (jump > 30) return `муха погибла (позиция скакнула на ${Math.round(jump)} м — респавн)`;
  }
  return null;
}

// ================= ЗЕМЛЯ: смотрим рельеф через survey =================
function gridOf(sv) {
  const legend = sv.legend || {};
  return (x, y, z) => {
    const rows = sv.layers['y=' + y];
    if (!rows) return '?';
    const row = rows[z - sv.origin.z];
    if (row == null) return '?';
    const ch = row[x - sv.origin.x];
    if (ch == null) return '?';
    if (ch === '.') return 'air';
    if (ch === '?') return '?';
    return legend[ch] || ch;
  };
}
// верхний твёрдый блок в колонке (не дерево) — на него можно встать
function groundAt(cell, sv, x, z) {
  for (let y = sv.origin.y + sv.size.y - 1; y >= sv.origin.y; y--) {
    const c = cell(x, y, z);
    if (c === '?' || c === 'air') continue;
    if (TREE_RE.test(c)) continue;
    return y;
  }
  return null;
}
// Подбираем участок survey так, чтобы объём влез в 4096 блоков.
// deep — смотрим глубже под ноги (спуск с горы): под нами может быть земля на 15+ м ниже.
function planSurvey(from, to, cfg, deep) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const y1 = Math.floor(from.y) - (deep ? 16 : 2);
  const y2 = Math.floor(from.y) + (deep ? 3 : cfg.maxClimb + 4);   // смотрим и выше предела: гора видна как «подъём»
  const layers = y2 - y1 + 1;
  for (const L of [cfg.step, 20, 16, 12, 10, 8]) {
    const l = Math.min(L, len);
    if (l < 3) continue;
    const ax = from.x + ux * l, az = from.z + uz * l;
    const x1 = Math.floor(Math.min(from.x, ax)), x2 = Math.floor(Math.max(from.x, ax));
    const z1 = Math.floor(Math.min(from.z, az)), z2 = Math.floor(Math.max(from.z, az));
    if ((x2 - x1 + 1) * (z2 - z1 + 1) * layers <= SURVEY_SAFE) {
      return { x1, y1, z1, x2, y2, z2, len: l, ux, uz };
    }
  }
  return null;
}
// Профиль земли вдоль отрезка: где верх (topY), где обрыв (drop), сколько неизвестного.
// endY — высота земли в конце отрезка, lowY/lowAt — самое низкое место на нём (куда и спускаемся).
async function profileLeg(api, from, to, cfg, deep) {
  const plan = planSurvey(from, to, cfg, deep);
  if (!plan) return { ok: false, reason: 'не получилось подобрать объём survey' };
  let sv;
  try { sv = await api.cmd('survey', { x1: plan.x1, y1: plan.y1, z1: plan.z1, x2: plan.x2, y2: plan.y2, z2: plan.z2 }); }
  catch (e) { return { ok: false, reason: 'survey не удался: ' + short(e.message) }; }
  if (!sv || !sv.layers) return { ok: false, reason: 'survey без слоёв' };
  const cell = gridOf(sv);
  const n = Math.max(2, Math.round(plan.len));
  let topY = -Infinity, prevY = null, drop = 0, unknown = 0, known = 0;
  let lowY = Infinity, lowAt = null, endY = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(from.x + plan.ux * plan.len * t);
    const cz = Math.round(from.z + plan.uz * plan.len * t);
    const g = groundAt(cell, sv, cx, cz);
    if (g == null) { unknown++; prevY = null; continue; }
    known++;
    const walkY = g + 1;
    if (walkY > topY) topY = walkY;
    if (walkY < lowY) { lowY = walkY; lowAt = [cx, walkY, cz]; }
    endY = walkY;
    if (prevY != null) { const d = prevY - walkY; if (d > drop) drop = d; }
    prevY = walkY;
  }
  return {
    ok: true, len: plan.len, ux: plan.ux, uz: plan.uz,
    topY: topY === -Infinity ? from.y : topY,
    lowY: lowY === Infinity ? from.y : lowY, lowAt,
    endY: endY == null ? from.y : endY,
    drop, unknown, known, samples: n + 1
  };
}
// жёсткие причины: подъём выше max_climb или (если ещё не выше потолка) высота выше max_y.
// Если тело УЖЕ выше потолка — потолок не причина: вверх не идём (подъём), но спуск обязателен.
function hardBlock(prof, from, cfg) {
  const climb = prof.topY - from.y;
  if (from.y > cfg.maxY) {
    if (climb > cfg.maxClimb) return `путь в гору от y=${Math.round(from.y)}: подъём +${Math.round(climb)} м — вверх не иду (потолок max_y=${cfg.maxY} уже пройден)`;
    return null;
  }
  if (prof.topY > cfg.maxY) return `путь идёт до y=${Math.round(prof.topY)} (предел max_y=${cfg.maxY})`;
  if (climb > cfg.maxClimb) return `путь в гору: подъём +${Math.round(climb)} м (предел +${cfg.maxClimb})`;
  return null;
}
// мягкая причина: обрыв на пути (смерть 10 — падение в каньон). Обход ищем, но если нет — идём.
function softBlock(prof, hp) {
  const allow = Math.max(3, Math.min(16, hp + 1));
  if (prof.drop > allow) return `обрыв ${Math.round(prof.drop)} м на пути (предел ${allow} м)`;
  return null;
}
// Обход: идём вбок (дольше по горизонтали), земля там ниже. Возвращает точку или null.
// deep — ищем обход НИЖЕ (спуск с горы): смотрим глубже под ноги.
async function findBypass(api, from, pt, cfg, hp, state, deep) {
  const dh = dist2(from.x, from.z, pt[0], pt[2]);
  if (dh < 4) return null;
  const ux = (pt[0] - from.x) / dh, uz = (pt[2] - from.z) / dh;
  const px = -uz, pz = ux;
  const fwd = Math.min(cfg.step, dh);
  const reasons = [];
  let best = null;
  for (const off of OFFSETS) {
    const wx = from.x + ux * fwd + px * off;
    const wz = from.z + uz * fwd + pz * off;
    if (dist2(wx, wz, pt[0], pt[2]) >= dh - 1) continue;         // без продвижения к цели — не обход
    const prof = await profileLeg(api, from, { x: wx, z: wz }, cfg, deep);
    if (!prof.ok) { reasons.push(`обход ${off}: ${prof.reason}`); continue; }
    const hard = hardBlock(prof, from, cfg);
    if (hard) { reasons.push(`обход ${off > 0 ? '+' : ''}${off} м: ${hard}`); continue; }
    const soft = softBlock(prof, hp);
    // при спуске важно идти НИЖЕ, при подъёме — не выше
    const score = deep
      ? (prof.lowY - from.y) + Math.abs(off) * 0.05 + (soft ? 5 : 0)
      : (prof.topY - from.y) + Math.abs(off) * 0.05 + (soft ? 5 : 0);
    if (!best || score < best.score) best = { x: wx, z: wz, off, score, soft, prof };
  }
  if (!best && reasons.length) state.lastBypass = reasons.slice(0, 3).join('; ');
  return best;
}

// ================= ХОДЬБА =================
// Идём к точке перебежкой и следим за высотой/мобами.
// Потолок подъёма на этом участке — ceilY: выше него тело подняться не должно.
// Если мы УЖЕ выше max_y (потолок пройден), ceilY = своя высота + 1.5 — то есть только спуск.
async function walkTo(api, g, o) {
  const remain = Math.floor((o.deadline - Date.now()) / 1000);
  const timeout = Math.max(20, Math.min(150, remain - 6));
  const goal = { x: Math.round(g.x), z: Math.round(g.z), timeout };
  if (g.y != null) goal.y = Math.round(g.y);
  let done = null;
  const pr = api.cmd('goto', goal).then(
    () => { done = { ok: true }; },
    e => { done = { ok: false, error: short(e.message) }; }
  );
  pr.catch(() => {});
  api.log(`home_path: иду → ${goal.x} ${goal.y == null ? '?' : goal.y} ${goal.z}`);
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout + 10) * 1000) {
    await api.sleep(1500);
    const snap = await snapOf(api);
    if (!snap) { if (done) break; continue; }
    const q = snap.position || {};
    o.lastPos = q;
    const dead = deathInfo(snap, o);
    if (dead) { await stopBody(api); return { kind: 'dead', why: dead }; }
    const y = Number(q.y);
    if (Number.isFinite(y)) {
      // запоминаем самое низкое место — туда можно вернуться, если залезли выше потолка
      if (o.state && y <= o.maxY + 0.5 && (!o.state.lastLow || y < o.state.lastLow.y)) {
        o.state.lastLow = { x: q.x, y, z: q.z };
      }
      // выше потолка этого участка — тело останавливаем (дальше разбираемся: спуск или отказ)
      if (y > o.ceilY + 0.5) { await stopBody(api); return { kind: 'climb', y, cap: o.ceilY }; }
    }
    const hz = hazardsOf(snap);
    if (hz.burning || hz.inLava || hz.underWater) {
      await stopBody(api);
      return { kind: 'hazard', why: hz.inLava ? 'муха в лаве' : hz.burning ? 'муха горит' : 'муха под водой' };
    }
    const hp = hpOf(snap);
    if (hp < o.hp0 - 3) { await stopBody(api); return { kind: 'damage', hp0: o.hp0, hp }; }
    if (dist2(q.x, q.z, goal.x, goal.z) <= 2.5) return { kind: 'ok', at: [q.x, q.y, q.z] };
    if (done) {
      return { kind: 'err', error: done.ok ? `goto закончился, а до ${goal.x} ${goal.z} не дошли` : done.error };
    }
  }
  await stopBody(api);
  return { kind: 'err', error: `переход не закончился за ${timeout} с` };
}

// ---- СПУСК: тело ушло выше потолка — вернуть его вниз, а не бросить на склоне ----
// 1) назад к последней точке ниже потолка, 2) ступень вниз (копим блок под ногами).
async function descendTo(api, from, cfg, state, deadline) {
  const tries = [];
  const low = state.lastLow;
  if (low && dist2(from.x, from.z, low.x, low.z) > 2) {
    api.log(`home_path: спускаюсь с y=${Math.round(from.y)} — назад к ${Math.round(low.x)} ${Math.round(low.z)} (y=${Math.round(low.y)})`);
    const r = await walkTo(api, { x: low.x, z: low.z, y: low.y }, {
      deadline, startY: from.y, ceilY: from.y + 1.5, climbCap: from.y + 1.5,
      maxY: cfg.maxY, hp0: from.hp != null ? from.hp : 20, cfg, state, lastPos: state.lastPos
    });
    if (r.kind === 'ok') return { ok: true, y: r.at ? r.at[1] : low.y, how: 'назад по своему следу' };
    tries.push('назад: ' + (r.error || r.kind));
  }
  for (let i = 0; i < 3; i++) {
    const snap = await snapOf(api);
    if (!snap) break;
    const p = snap.position || {};
    if (Number.isFinite(p.y) && p.y <= cfg.maxY) return { ok: true, y: p.y, how: 'выкопал ступень' };
    api.log(`home_path: спускаюсь с y=${Math.round(p.y)} — копаю ступень вниз`);
    try {
      await api.cmd('dig_at', { x: Math.round(p.x), y: Math.round(p.y) - 1, z: Math.round(p.z) });
      state.hops++;
      await api.sleep(900);
    } catch (e) { tries.push('dig_at: ' + short(e.message)); break; }
  }
  const snap = await snapOf(api);
  const y = snap && snap.position ? Number(snap.position.y) : NaN;
  if (Number.isFinite(y) && y <= cfg.maxY) return { ok: true, y, how: 'выкопал ступень' };
  return { ok: false, why: tries.join('; ') || 'пути вниз нет', y };
}

// ---- Отказ не должен оставлять муху в поле: укрываемся (ночью wait_night, днём shelter) ----
async function safeFinish(api, why, cfg, deadline, state) {
  const snap = await snapOf(api);
  const eyes = (snap && snap.eyes) || {};
  const foe = foeNear(eyes, cfg);
  const dark = isDark(eyes.time);
  if (!foe && !dark && !state.shelterNeeded) return { ok: true, how: 'укрытие не требовалось' };
  const remain = Math.floor((deadline - Date.now()) / 1000);
  if (remain < 30) return { ok: false, how: 'время вышло, укрыться не успели' };
  if (dark) {
    api.log('home_path: ночь — укрываюсь и пережидаю (wait_night)');
    try {
      await api.cmd('wait_night', { max_sec: Math.max(60, Math.min(420, remain - 15)) });
      return { ok: true, how: 'переждала ночь в укрытии' };
    } catch (e) { api.log('wait_night: ' + short(e.message)); }
  }
  api.log('home_path: укрываюсь (shelter) — в поле не остаюсь');
  try {
    await api.cmd('shelter', {});
    return { ok: true, how: 'укрылась (shelter)' };
  } catch (e) {
    api.log('shelter: ' + short(e.message));
    return { ok: false, how: short(e.message) };
  }
}

// моб рядом? (после побега — чтобы второй раз не бежать)
async function foeAfter(api, cfg) {
  const s = await snapOf(api);
  if (!s) return null;
  return foeNear(s.eyes || {}, cfg);
}

// ---- ночь: переждать (укрытие/кровать), в поле не идти ----
async function restAtNight(api, deadline, state) {
  state.nights++;
  const remain = Math.floor((deadline - Date.now()) / 1000);
  if (remain < 90) return { ok: false, why: 'ночь, а max_sec кончается — в поле не остаюсь' };
  if (state.nights > 6) return { ok: false, why: 'ночь не кончается (6 пережиданий)' };
  const sec = Math.max(60, Math.min(720, remain - 20));
  api.log(`home_path: ночь — пережидаю до утра (до ${sec} с)`);
  try { await api.cmd('wait_night', { max_sec: sec }); return { ok: true }; }
  catch (e) { api.log('wait_night: ' + short(e.message)); }
  try { await api.cmd('shelter', {}); }
  catch (e) {
    api.log('shelter: ' + short(e.message));
    return { ok: false, why: 'ночь: укрыться не вышло (' + short(e.message) + ') — в поле не остаюсь' };
  }
  const until = Math.min(deadline, Date.now() + 180000);
  while (Date.now() < until) {
    await api.sleep(5000);
    const s = await snapOf(api);
    if (!s) continue;
    if (!isDark(s.eyes && s.eyes.time)) return { ok: true };
  }
  return { ok: false, why: 'ночь не удалось переждать (нет укрытия)' };
}

// ---- про HP решаем один раз: еда/реген. Возвращает {ok:true} (можно идти) или {ok:false, why} ----
async function resolveLowHp(api, snap, state, cfg, deadline) {
  const hp = hpOf(snap);
  const lvl = foodLevel(snap);
  const inv = invFood(snap);
  if (state.hpDecided) {
    const why = `HP ${hp}, регена нет — идти нельзя`;
    state.hpWhy = why;
    api.log('home_path: ' + why);
    return { ok: false, why };
  }
  state.hpDecided = true;
  const canRegen = inv.n > 0 || lvl >= REGEN_FOOD;
  if (!canRegen) {
    const why = `HP ${hp}, еды нет — идти нельзя`;
    state.hpWhy = why;
    api.log(`home_path: ${why} (сытость ${lvl}, в инвентаре еды нет)`);
    return { ok: false, why };
  }
  if (inv.n > 0) {
    api.log(`home_path: HP ${hp}, еда есть (${inv.names.join(', ')}) — ем и жду регена`);
    try {
      const r = await api.cmd('eat', { count: 1 });
      api.log('home_path: eat: ' + JSON.stringify(r || {}).slice(0, 100));
    } catch (e) { api.log('home_path: eat: ' + short(e.message)); }
  } else {
    api.log(`home_path: HP ${hp}, сытость ${lvl} — жду регена (еды в инвентаре нет)`);
  }
  const end = Math.min(deadline, Date.now() + cfg.regenSec * 1000);
  let last = hp;
  while (Date.now() < end) {
    await api.sleep(5000);
    const s = await snapOf(api);
    if (!s) continue;
    const h2 = hpOf(s);
    if (h2 >= cfg.minHp) {
      api.log(`home_path: HP восстановился ${last} → ${h2} — иду дальше`);
      return { ok: true };
    }
    if (h2 < last) {
      const why = `HP ${h2} и падает${inv.n ? '' : ', еды нет'} — идти нельзя`;
      state.hpWhy = why;
      api.log('home_path: ' + why);
      return { ok: false, why };
    }
    last = h2;
    const f = foeNear(s.eyes || {}, cfg);
    if (f) {
      api.log(`home_path: жду регена, рядом враг ${f.name} ${f.d} м — escape`);
      try { await api.cmd('escape', { distance: 16, shelter: true }); }
      catch (e) { api.log('escape: ' + short(e.message)); }
    }
  }
  const lvl2 = foodLevel(snap);
  const why = `HP ${hp}, регена не было за ${cfg.regenSec} с (сытость ${lvl2}${inv.n ? '' : ', еды нет'}) — идти нельзя`;
  state.hpWhy = why;
  api.log('home_path: ' + why);
  return { ok: false, why };
}

// Идём к одной точке маршрута. Возвращает {ok, at, why, blocked, shelter}.
async function walkPoint(api, pt, deadline, state, cfg) {
  const [tx, ty, tz] = pt;
  let lastWhy = '';
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
    const snap = await snapOf(api);
    if (!snap) return { ok: false, blocked: true, why: 'снимок тела не получился' };
    const p = snap.position || {};
    const eyes = snap.eyes || {};
    const hp = hpOf(snap);
    state.lastPos = p;
    if (Number.isFinite(p.y) && p.y <= cfg.maxY && (!state.lastLow || p.y < state.lastLow.y)) {
      state.lastLow = { x: p.x, y: p.y, z: p.z };
    }
    const dh = dist2(p.x, p.z, tx, tz);
    const dy = ty == null ? 0 : ty - p.y;
    if (dh <= 2.5 && Math.abs(dy) <= 3) return { ok: true, at: [p.x, p.y, p.z] };

    const foe = foeNear(eyes, cfg);
    const dark = isDark(eyes.time);

    // 1) HP ниже порога. Escape — только если враг реально рядом; иначе решаем про HP один раз.
    if (hp < cfg.minHp) {
      if (foe) {
        if (state.escapes >= cfg.maxEscapes) {
          return { ok: false, blocked: true, shelter: true, why: `HP ${hp}, враг ${foe.name} рядом (${foe.d} м) — бегства не помогли, идти нельзя` };
        }
        state.escapes++;
        api.log(`home_path: HP ${hp}, враг ${foe.name} ${foe.d} м — escape (${state.escapes}/${cfg.maxEscapes})`);
        try { await api.cmd('escape', { distance: 16, shelter: true }); }
        catch (e) { api.log('escape: ' + short(e.message)); }
        await api.sleep(800);
        const f2 = await foeAfter(api, cfg);
        if (f2) return { ok: false, blocked: true, shelter: true, why: `HP ${hp}, моб ${f2.name} не отстаёт (${f2.d} м после побега) — второй раз не бегу, укрываюсь` };
        continue;
      }
      const r = await resolveLowHp(api, snap, state, cfg, deadline);
      if (!r.ok) return { ok: false, blocked: true, shelter: true, why: r.why };
      continue;
    }

    // 2) ночь/сумерки и моб рядом — укрытие сразу, независимо от расстояния до цели
    if (dark && foe) {
      api.log(`home_path: ${(eyes.time && eyes.time.phase) || 'темно'}, моб ${foe.name} ${foe.d} м рядом — укрываюсь, до цели ${Math.round(dh)} м не иду`);
      const w = await restAtNight(api, deadline, state);
      if (!w.ok) return { ok: false, blocked: true, shelter: true, why: w.why };
      continue;
    }

    // 3) враг рядом (HP в норме) — одно бегство; если моб не отстал — укрытие/отказ, а не новое бегство
    if (foe) {
      if (state.escapes >= cfg.maxEscapes) {
        return { ok: false, blocked: true, shelter: true, why: `враг ${foe.name} не отстаёт (${foe.d} м) — бегства не помогли, идти нельзя` };
      }
      state.escapes++;
      api.log(`home_path: враг ${foe.name} ${foe.d} м рядом — escape (${state.escapes}/${cfg.maxEscapes})`);
      try { await api.cmd('escape', { distance: 16, shelter: true }); }
      catch (e) { api.log('escape: ' + short(e.message)); }
      await api.sleep(800);
      const f2 = await foeAfter(api, cfg);
      if (f2) return { ok: false, blocked: true, shelter: true, why: `моб ${f2.name} не отстаёт (${f2.d} м после побега) — второй раз не бегу, укрываюсь` };
      continue;
    }

    // 4) ночь: night_wait=1 — пережидаем до утра; night_wait=0 — идём и ночью
    if (cfg.nightWait && dark && dh > cfg.nightDist) {
      const w = await restAtNight(api, deadline, state);
      if (!w.ok) return { ok: false, blocked: true, shelter: true, why: w.why };
      continue;
    }

    // 5) высота: max_y — потолок ПОДЪЁМА, а не заморозка.
    //    Тело уже выше потолка, а маршрут ведёт вниз — спускаемся («спускаюсь с y=…»),
    //    отказ «в гору не иду» — только когда подъём выше потолка действительно нужен.
    const aboveCeil = p.y > cfg.maxY;
    let descendMode = false;
    if (aboveCeil) {
      const needUp = ty == null ? 0 : ty - p.y;
      if (needUp > cfg.maxClimb) {
        return { ok: false, blocked: true, shelter: true, why: `нужен подъём до y=${Math.round(ty)} (сейчас y=${Math.round(p.y)}, потолок max_y=${cfg.maxY}) — в гору не иду` };
      }
      descendMode = true;
      state.descents++;
      api.log(`home_path: спускаюсь с y=${Math.round(p.y)} (потолок max_y=${cfg.maxY} пройден, маршрут ниже)`);
    }
    const ux = (tx - p.x) / (dh || 1), uz = (tz - p.z) / (dh || 1);
    const stepLen = Math.min(cfg.step, dh);
    const stepT = { x: p.x + ux * stepLen, z: p.z + uz * stepLen };
    // потолок высоты на этот отрезок: не выше маршрута на max_climb и не выше max_y.
    // Если точка маршрута выше нас больше чем на max_climb — идём к ней постепенно (ищем обход),
    // иначе подъём разрешён только на max_climb от текущей высоты (в гору не лезем).
    // Если мы уже выше потолка — потолок не причина: вверх не идём (ceilY = своя высота + 1.5).
    const targetY = ty == null ? p.y : ty;
    const ceilY = aboveCeil ? p.y + 1.5 : Math.max(p.y, Math.min(cfg.maxY, targetY + cfg.maxClimb));
    const climbCap = aboveCeil ? p.y + 1.5 : Math.min(ceilY, p.y + cfg.maxClimb);
    let target = stepT;
    let hard = null, soft = null;
    let prof = null;
    const pr = await profileLeg(api, p, stepT, cfg, descendMode);
    if (!pr.ok) {
      api.log('home_path: survey не получился (' + pr.reason + ') — иду осторожно');
    } else {
      prof = pr;
      state.surveys++;
      target = { x: p.x + prof.ux * prof.len, z: p.z + prof.uz * prof.len };
      hard = hardBlock(prof, p, cfg);
      soft = softBlock(prof, hp);
      if (hard) api.log(`home_path: ${hard}`);
      else if (soft) api.log(`home_path: ${soft} — ищу обход`);
    }
    // 6) обход: путь в гору / выше max_y / обрыв — ищем дорогу вбок, ниже по высоте
    if (hard || soft) {
      const b = await findBypass(api, p, pt, cfg, hp, state, descendMode);
      if (b) {
        target = { x: b.x, z: b.z };
        state.detours++;
        api.log(`home_path: обход ${b.off > 0 ? '+' : ''}${b.off} м → ${Math.round(b.x)} ${Math.round(b.z)} (верх пути y=${Math.round(b.prof.topY)})${b.soft ? ', обрыв остался' : ''}`);
      } else if (hard) {
        return { ok: false, blocked: true, shelter: true, why: hard + ' — обхода не нашёл' };
      }
    }

    // 7) идём
    const goal = { x: target.x, z: target.z };
    if (ty != null && Math.abs(ty - p.y) <= cfg.maxClimb + 1 && dist2(target.x, target.z, tx, tz) <= 2.5) goal.y = ty;
    else if (descendMode && prof && prof.endY < p.y - 1) goal.y = prof.endY;   // ведём по земле вниз
    const w = await walkTo(api, goal, { deadline, startY: p.y, ceilY, climbCap, maxY: cfg.maxY, hp0: hp, cfg, state, lastPos: state.lastPos });
    if (w.kind === 'ok') continue;
    if (w.kind === 'climb') {
      lastWhy = `залезла в гору (y ${Math.round(p.y)} → ${Math.round(w.y)}, предел ${Math.round(w.cap)})`;
      api.log('home_path: ' + lastWhy + (descendMode ? ' — возвращаюсь вниз' : ' — ищу обход'));
      if (descendMode) {
        // тело ушло выше потолка — не бросаем его там: возвращаем вниз и продолжаем путь
        const d = await descendTo(api, { x: p.x, y: p.y, z: p.z, hp }, cfg, state, deadline);
        if (d.ok) {
          api.log(`home_path: спустилась до y=${Math.round(d.y)} (${d.how}) — продолжаю путь`);
          continue;
        }
        return { ok: false, blocked: true, shelter: true, why: lastWhy + '; спуститься не вышло: ' + d.why };
      }
      continue;
    }
    if (w.kind === 'hazard') return { ok: false, blocked: true, shelter: true, why: w.why + ' — идти нельзя' };
    if (w.kind === 'damage') return { ok: false, blocked: true, shelter: true, why: `урон по дороге: HP ${w.hp0} → ${w.hp} — идти нельзя` };
    if (w.kind === 'dead') return { ok: false, blocked: true, shelter: true, why: w.why };
    if (w.kind === 'err') {
      if (/занят|выполняется|прерван|abort/i.test(w.error || '')) { await api.sleep(1500); continue; }
      lastWhy = w.error || 'goto не сработал';
      api.log(`home_path: ${lastWhy}`);
      // рядом с целью — обходы точки: pillar_up / dig_at
      if (dist2(p.x, p.z, target.x, target.z) <= 14) {
        const need = ty == null ? Math.round(p.y) : ty;
        if (need - p.y >= 1.5) {
          try {
            const h = Math.max(1, Math.min(3, Math.round(need - p.y)));
            const r = await api.cmd('pillar_up', { height: h });
            api.log(`home_path: pillar_up +${r && r.raised != null ? r.raised : h}`);
            state.hops++;
          } catch (e) { api.log('pillar_up: ' + short(e.message)); }
        } else {
          try {
            await api.cmd('dig_at', { x: Math.round(target.x), y: need, z: Math.round(target.z) });
            state.hops++;
          } catch (e) { api.log('dig_at: ' + short(e.message)); }
        }
      }
      continue;
    }
  }
  return { ok: false, why: lastWhy || 'до точки не дошла (причина неизвестна)' };
}

module.exports = {
  name: 'home_path',
  description: 'Дорога по ЗАДАННОМУ маршруту точек (по порядку, не перепрыгивая): каждый шаг планируется по земле (survey), в гору не лезем — если рельеф выше текущей высоты больше чем на max_climb (по умолчанию 6), ищем обход вбок (дольше по горизонтали, ниже по высоте), обхода нет — отказ с причиной. max_y (по умолчанию 100) — потолок ПОДЪЁМА, а не заморозка: если тело уже выше потолка, навык не отказывает, а ищет спуск (точки маршрута ниже) и ведёт вниз — в лог «спускаюсь с y=…»; отказ «в гору не иду» — только когда подъём выше потолка действительно нужен. Перебежку, ушедшую выше потолка, не бросаем: возвращаем тело вниз (назад по своему следу/ступень вниз) и продолжаем путь. night_wait: 1 (по умолчанию) — ночью переждать до утра, 0 — идти и ночью; ночью/в сумерках с мобом рядом — укрытие сразу, независимо от расстояния до цели. Бегство от моба не повторяем подряд (max_escapes, по умолчанию 2): после побега моб рядом — второй раз не бегаем, уходим в укрытие или отказываем. Отказ по высоте или по мобу не оставляет тело в поле: заканчиваем укрытием (wait_night ночью, shelter днём), нет укрытия — отказ с причиной. При HP<8 и отсутствии врагов escape не зовём: про HP решаем один раз (еда есть — eat и ждём регена, еды нет — отказ). Причина отказа — в поле error («не дошла до <точка>: <почему>»), в ответе — пройденные точки (passed) и фактическое время (sec).',
  params: {
    route: 'точки маршрута "x,y,z;x,y,z;…" (по умолчанию известный туннельный маршрут тайга→база)',
    points: 'то же, что route (синоним)',
    x: 'финальная цель x (по умолчанию -393)', y: 'финальная цель y (по умолчанию 67)', z: 'финальная цель z (по умолчанию 36)',
    surface: '1 — идти по поверхности (-330 68 36 -> база), 0 — по туннелям (по умолчанию)',
    min_hp: 'ниже этого HP не идём (отказ с причиной), по умолчанию 8',
    regen_sec: 'сколько ждать регена при низком HP, по умолчанию 60 (0 — не ждать)',
    max_sec: 'потолок времени, по умолчанию 900',
    max_climb: 'на сколько блоков рельеф может подняться выше текущей высоты (и выше высоты маршрута) — иначе ищем обход, по умолчанию 6',
    max_y: 'потолок ПОДЪЁМА, по умолчанию 100: выше него не лезем. Если тело уже выше потолка — не отказ, а спуск по маршруту вниз («спускаюсь с y=…»); отказ «в гору не иду» — только если подъём выше потолка действительно нужен',
    night_wait: '1 (по умолчанию) — ночью переждать до утра; 0 — идти и ночью (но с мобом рядом укрытие всё равно сразу)',
    max_escapes: 'сколько раз подряд можно бежать от моба за весь запуск, по умолчанию 2 (после побега моб рядом — укрытие или отказ, а не новое бегство)',
    step: 'длина шага планирования (сколько земли смотрим вперёд), по умолчанию 20 м',
    skip_failed: '1 — пройденную точку пропустить и идти к следующей (как раньше); 0 (по умолчанию) — остановиться с причиной'
  },
  async run(api, params) {
    params = params || {};
    const maxSec = Math.max(60, Math.min(num(params.max_sec, 900), 1800));
    const deadline = Date.now() + maxSec * 1000;
    const startedAt = Date.now();
    const surface = truthy(params.surface);
    const cfg = {
      minHp: Math.max(1, Math.min(20, Math.round(num(params.min_hp, 8)))),
      regenSec: Math.max(0, Math.min(300, Math.round(num(params.regen_sec, 60)))),
      nightDist: 60,
      threatD: 24,
      mobD: 8,
      maxEscapes: Math.max(1, Math.min(5, Math.round(num(params.max_escapes, 2)))),
      maxClimb: Math.max(1, Math.min(24, Math.round(num(params.max_climb, 6)))),
      maxY: Math.max(16, Math.min(320, Math.round(num(params.max_y, 100)))),
      nightWait: params.night_wait === undefined ? true : truthy(params.night_wait),
      step: Math.max(8, Math.min(48, Math.round(num(params.step, 20)))),
      skipFailed: truthy(params.skip_failed)
    };

    const snap0 = await api.snapshot();
    const start = snap0.position || { x: 0, y: 64, z: 0 };

    let route = parsePoints(params.route || params.points);
    const hasGoal = Number.isFinite(Number(params.x)) || Number.isFinite(Number(params.y)) || Number.isFinite(Number(params.z));
    let goal;
    if (hasGoal) goal = [Math.round(num(params.x, -393)), Math.round(num(params.y, 67)), Math.round(num(params.z, 36))];
    else if (route.length) goal = route[route.length - 1].slice();
    else goal = [-393, 67, 36];

    if (!route.length) route = defaultRoute(start, surface);

    // Убрать повторные точки, затем гарантировать финальную цель в конце.
    const pts = [];
    for (const q of route) {
      if (pts.length && dist2(pts[pts.length - 1][0], pts[pts.length - 1][2], q[0], q[2]) < 3) continue;
      pts.push(q);
    }
    const last = pts[pts.length - 1];
    if (!last || dist2(last[0], last[2], goal[0], goal[2]) > 3 || Math.abs((last[1] == null ? goal[1] : last[1]) - goal[1]) > 2) pts.push(goal);

    const state = {
      hops: 0, escapes: 0, nights: 0, hpDecided: false, hpWhy: null,
      passed: [], detours: 0, surveys: 0, lastPos: null, lastBypass: null,
      lastLow: null, descents: 0, shelterNeeded: false,
      deaths0: Number(snap0 && snap0.stats && snap0.stats.deaths) || 0
    };
    const failed = [];
    let stuck = null;
    let blockWhy = null;      // причина, по которой идти нельзя (показываем в error)

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (Date.now() >= deadline) {
        failed.push(`${pt.join(' ')}: время вышло`);
        stuck = pt;
        blockWhy = blockWhy || `не дошла до ${pt.join(' ')}: время вышло (${maxSec} с)`;
        break;
      }
      const legsLeft = pts.length - i;
      const legMs = Math.max(60000, Math.min(300000, Math.floor((deadline - Date.now()) / legsLeft)));
      const legDeadline = Math.min(deadline, Date.now() + legMs);
      api.log(`home_path: точка ${i + 1}/${pts.length} → ${pt[0]} ${pt[1] == null ? '?' : pt[1]} ${pt[2]}`);

      let r;
      try { r = await walkPoint(api, pt, legDeadline, state, cfg); }
      catch (e) { r = { ok: false, blocked: true, why: short(e.message) }; }
      if (r.ok) {
        state.passed.push([pt[0], pt[1], pt[2]]);
        continue;
      }
      failed.push(`${pt.join(' ')}: ${r.why}`);
      stuck = pt;
      if (r.shelter) state.shelterNeeded = true;
      if (r.blocked || !cfg.skipFailed) {
        // точка не пройдена — маршрут останавливаем, причина в error
        blockWhy = `не дошла до ${pt.join(' ')}: ${r.why}`;
        api.log(`home_path: отказ: ${r.why} (точка ${pt.join(' ')}) — маршрут остановлен`);
        break;
      }
      api.log(`home_path: точка ${pt.join(' ')} не пройдена: ${r.why} — иду дальше по маршруту`);
    }

    const snap = await api.snapshot();
    const p = snap.position || {};
    const arrived = near(p, goal[0], goal[2]) && Math.abs(goal[1] - p.y) <= 3;
    const at = [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
    const sec = Math.round((Date.now() - startedAt) / 1000);
    const common = {
      at, route: pts, passed: state.passed, sec, hops: state.hops, detours: state.detours,
      surveys: state.surveys, escapes: state.escapes, nights: state.nights, descents: state.descents,
      stuck: stuck || goal, failed
    };
    if (arrived) return { ok: true, arrived: true, ...common };
    const base = blockWhy || `не дошла до ${(stuck || goal).join(' ')}: время вышло`;
    // Отказ не должен оставлять тело в поле: укрываемся (ночью wait_night, днём shelter).
    const safe = await safeFinish(api, base, cfg, deadline, state);
    const error = safe.ok
      ? `${base}; ${safe.how}`
      : `${base}; укрыться не вышло (${safe.how})`;
    return { ok: false, error, arrived: false, sheltered: safe.ok ? safe.how : null, ...common };
  }
};
