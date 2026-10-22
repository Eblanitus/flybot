// версия: была текущей на 22.10; как v6, но листву считает пустотой, а ствол — опорой
// go_safe — дойти до точки перебежками: смотрим и мобов, и лаву/огонь/воду, и высоту на пути.
// Заявки учителя:
//   L017 (случай 20261022-022921-27) — мобы; L019 — лава/огонь/вода/горы/смерть внутри запуска.
//   L031 (случай 20261022-044423-42) — ОБРЫВ (эта правка). Прежние правки не трогаем.
// Правки (прежние, L019):
//   1) перед каждой перебежкой — снимок (hazards: «лава N м», «горю», «под водой»; blocks.lava/water)
//      и survey коридора: лава/вода на пути → не начинаем, отказ с причиной;
//   2) не лезем в гору: рельеф выше текущей высоты на max_climb (6) — обход вбок или отказ;
//      высоту следим и по ходу перебежки, а не только в конце;
//   3) перебежка короткая (step 12, hop_timeout 20 с), снимок раз в секунду:
//      «горю»/лава/вода → сразу отпускаем тело (stop) и отказываем;
//   4) смерть мухи — конец запуска: счётчик смертей вырос или позиция скакнула (респавн)
//      → stop и отказ «муха погибла», исполнитель освобождается сразу, а не через минуту.
// Правки (новые, L031 — обрыв):
//   5) «обрыв» в снимке (eyes.hazards) — запрет ходьбы наравне с лавой и огнём:
//      курс в сторону края → перебежку не начинаем, ищем обход вбок (0/±8/±16 м)
//      или отказываем с причиной («край 1-2 м ЮЗ — не иду»);
//   6) ночью перебежка с места, где снимок называет край, не начинается вообще —
//      независимо от расстояния до цели (раньше ночь ограничивал только night_max=40 м);
//   7) survey коридора: невидимые клетки («?») — это НЕ «земля видна не везде», а возможный край:
//      земли не видно → глубокий survey этой колонки (если земля есть — идём, перепад посчитан);
//      если и там пусто/не видно → край: перебежку не начинаем; максимум — укоротить её так,
//      чтобы край остался за спиной;
//   8) край проверяется ДО шага (survey до перебежки, с цифрами: сколько вниз и где), а не ловится
//      по факту падения (danger.fall) — отказ приходит до смерти, а не после;
//   9) во время перебежки снимок раз в секунду: край по курсу движения → stop и отказ.
'use strict';

const POLL_MS = 1000;         // как часто смотрим снимок во время перебежки
const MAX_SURVEY = 4096;      // предел объёма survey (ядро)
const DETOURS = [0, 8, -8, 16, -16];  // обходы вбок, если путь прямо не годится
const TREE_RE = /(_log|_leaves|_wood)$/;
const DIR_VEC = { 'С': [0, -1], 'СВ': [0.71, -0.71], 'В': [1, 0], 'ЮВ': [0.71, 0.71], 'Ю': [0, 1], 'ЮЗ': [-0.71, 0.71], 'З': [-1, 0], 'СЗ': [-0.71, -0.71] };

function short(s) {
  const t = String(s == null ? '' : s);
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}
function num(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function dist(ax, az, bx, bz) { return Math.hypot((ax || 0) - bx, (az || 0) - bz); }
function isNight(t) { return !!t && t.phase === 'ночь'; }
function defending(t) { return !!t && ['escape', 'shelter', 'fight', 'defend'].includes(t.name); }
function hpOf(snap) {
  const v = snap && snap.eyes && snap.eyes.vitals && snap.eyes.vitals.hp;
  if (Number.isFinite(v)) return v;
  const h = snap && snap.health;
  return Number.isFinite(h) ? h : 20;
}
function mobsNear(eyes, maxD) {
  return ((eyes && eyes.enemies) || []).filter(e => e && e.d != null && e.d <= maxD);
}
async function snapOf(api) {
  try { return await api.snapshot(); } catch (e) { return null; }
}
// перепад вниз, который ещё переживём: урон падения = перепад - 3, запас 2 HP
function safeDrop(hp) { return Math.max(3, Math.min(16, hp + 1)); }
// направление блока/лавы относительно курса: 1 — прямо, 0 — вбок, -1 — за спиной
function align(dir, ux, uz) {
  const v = DIR_VEC[String(dir || '').replace(/[↑↓]/g, '').slice(0, 2)];
  if (!v) return 0;
  const len = Math.hypot(ux, uz) || 1;
  return (v[0] * ux + v[1] * uz) / len;
}

// ---- опасности в снимке ----
function hazardsOf(snap) {
  const eyes = (snap && snap.eyes) || {};
  const hz = (eyes.hazards || []).map(String);
  const danger = (snap && snap.danger) || {};
  const fire = danger.fire || {};
  const lava = danger.lava || {};
  const blocks = eyes.blocks || {};
  return {
    hz,
    burning: !!fire.burning || hz.some(h => /горю/.test(h)),
    inLava: !!lava.inLava,
    underWater: !!(danger.air && danger.air.underWater) || hz.some(h => /под водой/.test(h)),
    lavaNear: hz.some(h => /лава/.test(h)),
    lavaBlock: blocks.lava || null,
    waterBlock: blocks.water || null
  };
}

// ---- край (обрыв) в снимке: «обрыв СЗ,З,С» → направления края ----
function cliffOf(snap) {
  const eyes = (snap && snap.eyes) || {};
  const hz = (eyes.hazards || []).map(String);
  for (const h of hz) {
    const m = /^обрыв\s*(.+)$/.exec(h.trim());
    if (!m) continue;
    const dirs = m[1].replace(/[↑↓\s]/g, '').split('').filter(d => DIR_VEC[d]);
    if (dirs.length) return { dirs, text: dirs.join(','), raw: h };
  }
  return null;
}
// край прямо по курсу? (скалярное произведение > 0.5 — в пределах ~60°)
function cliffHit(cliff, ux, uz) {
  if (!cliff) return [];
  const hits = [];
  for (const d of cliff.dirs) {
    const v = DIR_VEC[d];
    const a = v[0] * ux + v[1] * uz;
    if (a > 0.5) hits.push({ dir: d, a });
  }
  return hits;
}
function cliffReason(cl) {
  if (!cl) return '';
  if (cl.kind === 'eyes') return `край ${cl.dirs} (1-2 м) по курсу — не иду`;
  if (cl.kind === 'void') return `обрыв ≥ ${cl.drop} м у ${cl.x} ${cl.z} (дно не видно) — не иду`;
  return `край в ${cl.dist} м у ${cl.x} ${cl.z} (землю не видно — возможен обрыв) — не иду`;
}

// ---- смерть/респавн: конец запуска, тело надо отпустить сразу ----
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

// ---- survey: сетка клеток ----
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
// что видно в колонке (x,z): земля / вода / лава / дерево + признаки «не видно» и «пусто»
function columnAt(cell, sv, x, z) {
  let groundY = null, waterY = null, lavaY = null, treeY = null, unknown = false, air = false;
  for (let y = sv.origin.y + sv.size.y - 1; y >= sv.origin.y; y--) {
    const c = cell(x, y, z);
    if (c === '?') { unknown = true; continue; }
    if (c === 'air') { air = true; continue; }
    if (c === 'lava') { if (lavaY === null) lavaY = y; continue; }
    if (c === 'water') { if (waterY === null) waterY = y; continue; }
    if (TREE_RE.test(c)) { if (treeY === null) treeY = y; continue; }
    if (groundY === null) groundY = y;
  }
  return { groundY, waterY, lavaY, treeY, unknown, air };
}

// ---- глубокий survey по одной колонке: где кончается земля (край) ----
// groundY — верхний твёрдый блок (null = земли нет), emptyTo — самый глубокий видимый пустой блок
async function probeDrop(api, x, z, y0) {
  const depth = 48;
  let sv;
  try { sv = await api.cmd('survey', { x1: x, y1: y0 - depth, z1: z, x2: x, y2: y0 + 1, z2: z }); }
  catch (e) { return null; }
  if (!sv || !sv.layers) return null;
  const cell = gridOf(sv);
  let groundY = null, ground = null, emptyTo = null;
  for (let y = y0; y >= y0 - depth; y--) {
    const c = cell(x, y, z);
    if (c === '?') continue;
    // листва держит плохо — считаем пустотой; ствол (log/wood) — твёрдая опора
    if (c === 'air' || /_leaves$/.test(c)) { if (groundY == null) emptyTo = y; continue; }
    groundY = y; ground = c;
    break;
  }
  return { groundY, ground, emptyTo };
}

// ---- проверка участка пути: лава/вода/высота/край ----
// ok=false + reason — почему идти нельзя (навык обязан вернуть отказ с причиной)
// cliff — найденный край (до шага!), safeLen — до какого расстояния путь ещё чист
async function checkPath(api, from, to, hp, o, limitY) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = -uz, pz = ux;
  const w = 2;                                   // полуширина коридора
  const xs = [], zs = [];
  for (const s of [-2, len + 3]) for (const t of [-w, w]) { xs.push(from.x + ux * s + px * t); zs.push(from.z + uz * s + pz * t); }
  const x1 = Math.floor(Math.min.apply(null, xs)), x2 = Math.floor(Math.max.apply(null, xs));
  const z1 = Math.floor(Math.min.apply(null, zs)), z2 = Math.floor(Math.max.apply(null, zs));
  const y0 = Math.floor(from.y);
  // глубину коридора держим побольше (нужно видеть край), режем вверх и только потом вниз
  let below = 8, above = o.maxClimb + 4;
  const cols = (x2 - x1 + 1) * (z2 - z1 + 1);
  while (cols * (below + above + 1) > MAX_SURVEY && above > 3) above--;
  while (cols * (below + above + 1) > MAX_SURVEY && below > 4) below--;
  while (cols * (below + above + 1) > MAX_SURVEY && (below > 2 || above > 3)) { if (above > 3) above--; else below--; }
  let sv;
  try { sv = await api.cmd('survey', { x1, y1: y0 - below, z1, x2, y2: y0 + above, z2 }); }
  catch (e) { return { ok: false, reason: 'survey не удался: ' + short(e.message) }; }
  if (!sv || !sv.layers) return { ok: false, reason: 'survey без слоёв' };
  const cell = gridOf(sv);
  const n = Math.max(2, Math.round(len));
  let prevY = from.y, topY = from.y, maxDrop = 0, dropAt = null, unknown = 0, canopy = 0;
  let cliff = null, probed = false;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(from.x + dx * t), cz = Math.round(from.z + dz * t);
    const center = columnAt(cell, sv, cx, cz);
    // лава/вода рядом с дорогой (центр и кромки коридора)
    for (const off of [-w, 0, w]) {
      const side = off === 0 ? center : columnAt(cell, sv, Math.round(cx + px * off), Math.round(cz + pz * off));
      const sWalk = side.groundY != null ? side.groundY + 1 : null;
      if (side.lavaY != null && (sWalk == null || side.lavaY >= sWalk - 2)) {
        return { ok: false, reason: `лава на пути (${Math.round(cx + px * off)} ${side.lavaY} ${Math.round(cz + pz * off)})`, lava: true };
      }
      if (side.waterY != null && side.groundY != null && side.waterY - side.groundY >= 2) {
        return { ok: false, reason: `вода на пути (${Math.round(cx + px * off)} ${side.waterY} ${Math.round(cz + pz * off)}) — вплавь не иду`, water: true };
      }
    }
    let walkY = center.groundY != null ? center.groundY + 1 : null;
    if (walkY == null) {
      unknown++;
      // под кроной землю не видно — это не край (как в gather_wood)
      if (center.treeY != null) { canopy++; continue; }
      // земли не видно: глубокий survey этой колонки — вдруг земля есть, просто не видно
      if (!cliff && !probed) {
        probed = true;
        const dp = await probeDrop(api, cx, cz, y0);
        if (dp && dp.groundY != null) walkY = dp.groundY + 1;
        else if (dp && dp.emptyTo != null) {
          cliff = { dist: Math.round(i * len / n), x: cx, z: cz, kind: 'void', drop: Math.max(1, y0 - dp.emptyTo) };
        }
      }
      if (walkY == null) {
        if (!cliff) cliff = { dist: Math.round(i * len / n), x: cx, z: cz, kind: 'hidden', drop: null };
        continue;
      }
    }
    if (walkY > topY) topY = walkY;
    const drop = prevY - walkY;
    if (drop > maxDrop) { maxDrop = drop; dropAt = [cx, walkY, cz]; }
    prevY = walkY;
  }
  const climb = topY - from.y;
  if (cliff) {
    return {
      ok: false, reason: cliffReason(cliff), cliff,
      safeLen: Math.max(0, cliff.dist - 2),   // можно укоротить перебежку: край остаётся за спиной
      climb, drop: maxDrop, unknown, canopy
    };
  }
  if (climb > o.maxClimb) return { ok: false, reason: `маршрут в гору: +${climb} м (предел ${o.maxClimb}) — не лезу`, climb };
  if (topY > limitY) return { ok: false, reason: `маршрут идёт в гору до y=${topY} (предел ${limitY}) — не повторяю такой путь`, climb };
  const allow = safeDrop(hp);
  if (maxDrop > allow) return { ok: false, reason: `обрыв ${maxDrop} м (предел ${allow} м) у ${dropAt}`, drop: maxDrop };
  return { ok: true, climb, drop: maxDrop, unknown, canopy };
}

// ---- отступ: освободить тело (если держим его перебежкой) и спрятаться/убежать ----
async function retreat(api, why, stopFirst) {
  const snap = await snapOf(api);
  const t = snap && snap.eyes && snap.eyes.task;
  if (defending(t)) { api.log('тело уже защищается (' + t.name + ')'); return; }
  if (stopFirst) {
    try { await api.stop(); } catch (e) { api.log('stop: ' + short(e.message)); }
    await api.sleep(300);
  }
  api.log('отступ: ' + why);
  try { await api.cmd('escape', { distance: 16, shelter: true }); return; }
  catch (e) {
    const m = short(e.message);
    if (/занят навыком (escape|shelter|fight|defend)/.test(m)) { api.log('тело уже защищается: ' + m); return; }
    api.log('escape не начался (' + m + ') — пробую с force');
    try { await api.cmd('escape', { distance: 16, shelter: true }, { force: true }); }
    catch (e2) { api.log('escape: ' + short(e2.message)); }
  }
}

// ---- ночь: переждать (укрытие/кровать), в поле не идти ----
async function restAtNight(api, deadline) {
  const remain = Math.floor((deadline - Date.now()) / 1000);
  if (remain < 90) return { ok: false, why: 'ночь, а время навыка кончается — идти не буду' };
  const sec = Math.max(60, Math.min(600, remain - 30));
  api.log(`ночь — пережидаю до утра (до ${sec} с), через поле не иду`);
  try { await api.cmd('wait_night', { max_sec: sec }); return { ok: true }; }
  catch (e) { api.log('wait_night: ' + short(e.message)); }
  try { await api.cmd('shelter', {}); } catch (e) { api.log('shelter: ' + short(e.message)); }
  const until = Math.min(deadline, Date.now() + 180000);
  while (Date.now() < until) {
    await api.sleep(5000);
    const s = await snapOf(api);
    if (!s) continue;
    const t = (s.eyes && s.eyes.time) || {};
    if (t.phase !== 'ночь') return { ok: true };
    const hp = hpOf(s);
    if (hp < 8) { await retreat(api, `HP ${hp}`, false); return { ok: false, why: `ночью HP ${hp} — переждать не вышло` }; }
  }
  return { ok: false, why: 'ночь не удалось переждать (время вышло)' };
}

// ---- отпустить тело ----
async function stopBody(api) {
  try { await api.stop(); } catch (e) { api.log('stop: ' + short(e.message)); }
  await api.sleep(250);
}

// ---- одна перебежка: идём в фоне, каждую секунду смотрим снимок ----
// kind: ok | dead | hazard | damage | mob | climb | fall | err
async function hop(api, p, goal, o, hp0) {
  const g = { x: goal.x, z: goal.z, timeout: o.hopTimeout };
  if (Number.isFinite(goal.y)) g.y = goal.y;      // последний участок — с высотой цели
  api.log(`перебежка → ${goal.x} ${goal.z}${g.y != null ? ' ' + g.y : ''}`);
  let done = null;
  const hopP = api.cmd('goto', g).then(
    () => { done = { kind: 'done' }; },
    e => { done = { kind: 'err', error: short(e.message) }; }
  );
  const startY = p.y;
  let res = null;
  let dir = { ux: goal.x - p.x, uz: goal.z - p.z };
  const dlen = Math.hypot(dir.ux, dir.uz) || 1; dir = { ux: dir.ux / dlen, uz: dir.uz / dlen };
  let prevQ = { x: p.x, z: p.z };
  const end = Date.now() + o.hopTimeout * 1000;
  while (Date.now() < end) {
    await api.sleep(POLL_MS);
    const snap = await snapOf(api);
    const dead = deathInfo(snap, o);
    if (dead) { await stopBody(api); return { kind: 'dead', why: dead }; }
    if (!snap) { if (done) break; continue; }
    if (snap.position) o.lastPos = snap.position;
    const eyes = snap.eyes || {};
    const hp = hpOf(snap);
    // горит/лава/вода — спасаться тут бессмысленно: отпускаем тело и отказываем
    const hz = hazardsOf(snap);
    if (hz.burning || hz.inLava || hz.underWater) {
      await stopBody(api);
      return { kind: 'hazard', why: hz.inLava ? 'муха в лаве' : hz.burning ? 'муха горит' : 'муха под водой' };
    }
    if (hp < hp0) { await stopBody(api); return { kind: 'damage', hp0, hp }; }
    const mobs = mobsNear(eyes, o.mobD);
    if (mobs.length) { await stopBody(api); return { kind: 'mob', mob: mobs[0] }; }
    const q = snap.position || {};
    // курс движения (по перемещению) — чтобы понимать, в какую сторону край
    const mvx = q.x - prevQ.x, mvz = q.z - prevQ.z;
    const mlen = Math.hypot(mvx, mvz);
    prevQ = { x: q.x, z: q.z };
    if (mlen > 0.25) dir = { ux: mvx / mlen, uz: mvz / mlen };
    // край по курсу — останавливаемся ДО шага, а не ловим падение
    const cl = cliffOf(snap);
    const hits = cliffHit(cl, dir.ux, dir.uz);
    if (hits.length) {
      await stopBody(api);
      return { kind: 'cliff', dirs: hits.map(h => h.dir).join(','), at: [Math.round(q.x), Math.round(q.y), Math.round(q.z)] };
    }
    // залезли в гору — следим за высотой по ходу, а не только в конце
    if (Number.isFinite(q.y) && q.y > startY + o.maxClimb) {
      await stopBody(api);
      return { kind: 'climb', y: q.y, startY };
    }
    const fall = snap.danger && snap.danger.fall;
    if (fall && fall.height != null && fall.height > safeDrop(hp) + 2) {
      await stopBody(api);
      return { kind: 'fall', height: fall.height };
    }
    if (dist(q.x, q.z, goal.x, goal.z) <= 2.5) { res = { kind: 'ok' }; break; }
    if (done) { res = done.kind === 'done' ? { kind: 'ok' } : { kind: 'err', error: done.error }; break; }
  }
  await Promise.race([hopP, api.sleep(1200)]);
  if (!done) await stopBody(api);              // goto ещё идёт — тело освобождаем
  if (!res) res = { kind: 'err', error: 'перебежка не закончилась' };
  if (res.kind === 'ok') {
    const s = await snapOf(api);
    if (s) {
      const hp = hpOf(s);
      if (hp < hp0) return { kind: 'damage', hp0, hp };
      const mobs = mobsNear(s.eyes || {}, o.mobD);
      if (mobs.length) return { kind: 'mob', mob: mobs[0] };
    }
  }
  return res;
}

module.exports = {
  name: 'go_safe',
  description: 'Дойти до x,z (y необязательно) перебежками по step блоков (12). Перед каждой перебежкой проверяет и врагов-игроков (eyes.threats, d<=24), и враждебных мобов (eyes.enemies, d<=mob_d=8): моб ближе — не идёт, отступает (escape) и возвращает отказ с причиной. Лава/огонь/вода на пути (снимок + survey коридора) и подъём в гору (выше текущей высоты на max_climb) — не начинает перебежку: ищет обход или возвращает отказ с причиной. ОБРЫВ (край): «обрыв» в снимке (eyes.hazards) — запрет ходьбы наравне с лавой и огнём: курс в сторону края → перебежку не начинаем, ищем обход вбок или отказываем («край 1-2 м ЮЗ — не иду»); ночью с места, где снимок называет край, не идём вообще (независимо от night_max). В survey коридора невидимые клетки («?») — возможный край, а не ровная земля: земли не видно → глубокий survey колонки (если земля есть — идём); если пусто → край, перебежку не начинаем (максимум — укоротить так, чтобы край остался за спиной). Край проверяется ДО шага с цифрами (сколько вниз, где), а не ловится по факту падения. Во время перебежки снимок раз в секунду: горит/лава/вода/урон/моб/залезла в гору/край по курсу — отпускает тело и отказывается. Смерть мухи (респавн) — конец запуска с отказом «муха погибла». Ночью дальше night_max (40 м) не идёт — пережидает ночь. Провал после 3 бегств или 3 неудачных переходов.',
  params: {
    x: 'цель x',
    z: 'цель z',
    y: 'цель y (необязательно)',
    step: 'длина перебежки, по умолчанию 12 (4..32)',
    mob_d: 'ближе какого расстояния враждебный моб = опасность (отказ), по умолчанию 8 м',
    night_wait: '1 (по умолчанию) — ночью не идти дальше night_max, переждать; 0 — идти и ночью',
    night_max: 'ночью не идти дальше этого расстояния, по умолчанию 40 м',
    night_cliff: '1 (по умолчанию) — ночью с места, где снимок называет «обрыв», не идём вообще; 0 — только проверять край по курсу',
    min_hp: 'ниже этого HP не идём (отступ), по умолчанию 8',
    max_climb: 'на сколько блоков рельеф может подняться выше текущей высоты (и выше цели), по умолчанию 6',
    hop_timeout: 'предел одной перебежки, по умолчанию 20 с (5..60)',
    lava_d: 'на каком расстоянии лава рядом = отказ (по курсу — до 24 м), по умолчанию 8 м',
    detour: '1 (по умолчанию) — искать обход вбок, если путь прямо не годится; 0 — только прямо',
    max_sec: 'предел времени навыка, по умолчанию 240 с (ночью нужно больше — тогда ставь у запуска timeout_sec 600)'
  },
  async run(api, params) {
    const tx = Number(params.x), tz = Number(params.z), ty = Number(params.y);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) throw new Error('нужны x и z');
    const step = num(params.step, 12, 4, 32);
    const mobD = num(params.mob_d, 8, 2, 24);
    const nightWait = !(params.night_wait === 0 || params.night_wait === '0' || params.night_wait === false);
    const nightCliff = !(params.night_cliff === 0 || params.night_cliff === '0' || params.night_cliff === false);
    const nightMax = num(params.night_max, 40, 5, 400);
    const minHp = num(params.min_hp, 8, 1, 20);
    const maxSec = num(params.max_sec, 240, 15, 1800);
    const maxClimb = num(params.max_climb, 6, 1, 24);
    const hopTimeout = num(params.hop_timeout, 20, 5, 60);
    const lavaD = num(params.lava_d, 8, 2, 40);
    const detours = (params.detour === 0 || params.detour === '0' || params.detour === false) ? [0] : DETOURS;
    const deadline = Date.now() + maxSec * 1000;

    const o = { deaths0: 0, lastPos: null, maxClimb, hopTimeout, lavaD, step, mobD, detours };

    let hops = 0, escapes = 0, nights = 0, fails = 0;

    for (let i = 0; i < 80; i++) {
      if (Date.now() > deadline) {
        return { ok: false, error: `время навыка вышло (${maxSec} с)`, hops, escapes, nights };
      }
      const snap = await snapOf(api);
      if (!o.init) {                                   // первый снимок: запомнили счётчик смертей
        o.init = true;
        o.deaths0 = Number(snap && snap.stats && snap.stats.deaths) || 0;
      }
      const dead = deathInfo(snap, o);
      if (dead) {
        await stopBody(api);
        return { ok: false, error: dead, hops, escapes, nights };
      }
      const p = snap.position;
      const eyes = snap.eyes || {};
      const hp = hpOf(snap);
      o.lastPos = p;
      const d = dist(p.x, p.z, tx, tz);

      // 1) мало HP — не идём, отступаем
      if (hp < minHp) {
        await retreat(api, `HP ${hp}`, false);
        return { ok: false, error: `HP ${hp} — не иду, отступила`, hp, at: [p.x, p.y, p.z], hops, escapes };
      }

      // 2) враждебные мобы рядом — не идём (главное правило: и игроки, и мобы)
      const mobs = mobsNear(eyes, mobD);
      if (mobs.length) {
        const m = mobs[0];
        await retreat(api, `${m.name} ${m.d} м`, false);
        return {
          ok: false, error: `${m.name} ${m.d} м рядом — не иду, отступила`,
          mob: m.name, mob_d: m.d, hp, at: [p.x, p.y, p.z], hops, escapes
        };
      }

      // 3) враги-игроки
      const th = (eyes.threats || []).filter(t => t && t.d != null && t.d <= 24)[0];
      if (th) {
        if (++escapes > 3) {
          return { ok: false, error: `враг-игрок ${th.name} не отстаёт (${th.d} м) — 3 бегства`, at: [p.x, p.y, p.z], hops, escapes };
        }
        api.log(`враг-игрок ${th.name} ${th.d} м ${th.dir || ''} — убегаю`);
        await retreat(api, 'враг-игрок ' + th.name, false);
        continue;
      }

      // 4) дошли?
      if (d <= 2.5 && (!Number.isFinite(ty) || Math.abs(ty - p.y) <= 2.5)) {
        return { ok: true, at: [p.x, p.y, p.z], hops, escapes, nights, hp };
      }

      // 5) ночью через открытое поле не идём — безопаснее переждать
      if (nightWait && isNight(eyes.time) && d > nightMax) {
        if (++nights > 3) {
          return { ok: false, error: 'ночь не кончается (3 пережидания)', at: [p.x, p.y, p.z], hops, escapes, nights };
        }
        const r = await restAtNight(api, deadline);
        if (!r.ok) return { ok: false, error: r.why, at: [p.x, p.y, p.z], hops, escapes, nights };
        continue;
      }

      // 6) опасности вокруг: горит/лава/вода — никуда не идём
      const hz = hazardsOf(snap);
      if (hz.burning || hz.inLava || hz.underWater) {
        const why = hz.inLava ? 'муха в лаве' : hz.burning ? 'муха горит' : 'муха под водой';
        await stopBody(api);
        return { ok: false, error: `${why} — идти нельзя`, at: [p.x, p.y, p.z], hops, escapes };
      }
      const ux = (tx - p.x) / (d || 1), uz = (tz - p.z) / (d || 1);
      // 6а) край в снимке: ночью с такого места не идём вообще (независимо от расстояния до цели)
      const cliff = cliffOf(snap);
      if (cliff && nightWait && nightCliff && isNight(eyes.time)) {
        await stopBody(api);
        return {
          ok: false, error: `ночь, край ${cliff.text} (1-2 м рядом) — не иду`,
          cliff: cliff.text, at: [p.x, p.y, p.z], hops, escapes, nights
        };
      }
      if (hz.lavaBlock && hz.lavaBlock.d != null) {
        const a = align(hz.lavaBlock.dir, ux, uz);
        const near = hz.lavaBlock.d <= lavaD;
        const ahead = hz.lavaBlock.d <= 24 && a > 0.7;
        if ((near || ahead) && !(a < 0 && hz.lavaBlock.d <= lavaD)) {
          await stopBody(api);
          return {
            ok: false, error: `лава ${hz.lavaBlock.d} м ${hz.lavaBlock.dir || ''} на пути — не иду`,
            at: [p.x, p.y, p.z], lava: hz.lavaBlock.d, hops, escapes
          };
        }
      }
      if (hz.waterBlock && hz.waterBlock.d != null && hz.waterBlock.d <= 6 && align(hz.waterBlock.dir, ux, uz) > 0.8) {
        await stopBody(api);
        return {
          ok: false, error: `вода ${hz.waterBlock.d} м ${hz.waterBlock.dir || ''} прямо по курсу — не иду`,
          at: [p.x, p.y, p.z], hops, escapes
        };
      }

      // 7) выбрать перебежку: прямо, а если путь не годится — обход вбок (ищем путь ниже)
      const len = Math.min(step, d);
      const px = -uz, pz = ux;
      const limitY = Math.max(p.y, Number.isFinite(ty) ? ty : p.y) + maxClimb;
      const reasons = [];
      let goal = null, chk = null, off = 0, cut = 0, cliffBlock = null;
      for (const o2 of detours) {
        const cand = { x: Math.round(p.x + ux * len + px * o2), z: Math.round(p.z + uz * len + pz * o2) };
        const cdx = cand.x - p.x, cdz = cand.z - p.z;
        const clen = Math.hypot(cdx, cdz) || 1;
        // снимок называет край — в эту сторону не идём (обход вбок — можно)
        const hits = cliffHit(cliff, cdx / clen, cdz / clen);
        if (hits.length) {
          const dirs = hits.map(h => h.dir).join(',');
          reasons.push(`${o2 === 0 ? 'прямо' : `обход ${o2 > 0 ? '+' : ''}${o2} м`}: край ${dirs} (1-2 м) по курсу — не иду`);
          if (!cliffBlock) cliffBlock = { kind: 'eyes', dirs, dist: 2 };
          continue;
        }
        const c = await checkPath(api, p, cand, hp, o, limitY);
        if (c.ok) { goal = cand; chk = c; off = o2; break; }
        reasons.push((o2 === 0 ? 'прямо' : `обход ${o2 > 0 ? '+' : ''}${o2} м`) + ': ' + c.reason);
        if (c.cliff && !cliffBlock) cliffBlock = c.cliff;
        // край близко — укорачиваем перебежку так, чтобы край остался за спиной
        if (c.cliff && c.safeLen >= 3) {
          const tt = c.safeLen / len;
          const sc = { x: Math.round(p.x + cdx * tt), z: Math.round(p.z + cdz * tt) };
          const c2 = await checkPath(api, p, sc, hp, o, limitY);
          if (c2.ok) { goal = sc; chk = c2; off = o2; cut = c.safeLen; break; }
          reasons.push(`укорочено до ${c.safeLen} м: ${c2.reason}`);
          if (c2.cliff && !cliffBlock) cliffBlock = c2.cliff;
        }
      }
      if (!goal) {
        await stopBody(api);
        const err = cliffBlock ? cliffReason(cliffBlock) : `безопасного пути нет: ${reasons.slice(0, 3).join('; ')}`;
        return {
          ok: false, error: err,
          at: [p.x, p.y, p.z], hops, escapes, nights,
          blocked: reasons.slice(0, 5), cliff: cliffBlock || null
        };
      }
      // последний участок (цель впереди) — с высотой цели, если она не выше предела
      if (off === 0 && !cut && Number.isFinite(ty) && Math.abs(ty - p.y) <= maxClimb &&
          dist(goal.x, goal.z, tx, tz) <= 1.5) goal.y = ty;
      api.log(`перебежка ${off ? '(обход ' + off + ' м)' : ''}${cut ? ` (укорочено до ${cut} м — край за спиной)` : ''}: подъём ${chk.climb} м, яма ${chk.drop} м${chk.unknown ? `, земля видна не везде (${chk.unknown})` : ''}${chk.canopy ? ', под кронами' : ''}`);

      // 8) перебежка со слежением за HP, мобами, высотой, краем и смертью
      const h = await hop(api, p, goal, o, hp);
      if (h.kind === 'dead') {
        return { ok: false, error: h.why, at: [p.x, p.y, p.z], hops, escapes, nights };
      }
      if (h.kind === 'cliff') {
        return {
          ok: false, error: `край ${h.dirs} по курсу — перебежку бросил, не иду`,
          cliff: h.dirs, at: h.at || [p.x, p.y, p.z], hops, escapes, nights
        };
      }
      if (h.kind === 'hazard') {
        return {
          ok: false, error: `${h.why} — перебежку бросил, в лаве/огне спасаться нечем`,
          at: [p.x, p.y, p.z], hops, escapes, nights
        };
      }
      if (h.kind === 'climb') {
        return {
          ok: false, error: `залезла в гору (y ${h.startY} → ${h.y}, предел +${maxClimb}) — не повторяю такой путь`,
          at: [p.x, p.y, p.z], hops, escapes, nights
        };
      }
      if (h.kind === 'fall') {
        return {
          ok: false, error: `обрыв ${h.height} м на пути — не иду`,
          at: [p.x, p.y, p.z], hops, escapes, nights
        };
      }
      if (h.kind === 'damage') {
        await retreat(api, `урон ${h.hp0}→${h.hp}`, false);
        return {
          ok: false, error: `урон во время перебежки: HP ${h.hp0} → ${h.hp} — не иду дальше`,
          hp: h.hp, hp_lost: h.hp0 - h.hp, at: [p.x, p.y, p.z], hops, escapes
        };
      }
      if (h.kind === 'mob') {
        await retreat(api, `${h.mob.name} ${h.mob.d} м`, false);
        return {
          ok: false, error: `${h.mob.name} ${h.mob.d} м подошёл во время перебежки — не иду, отступила`,
          mob: h.mob.name, mob_d: h.mob.d, hp, at: [p.x, p.y, p.z], hops, escapes
        };
      }
      if (h.kind === 'err') {
        if (/занят|выполняется/.test(h.error || '')) {   // тело занято (рефлекс/автопилот) — не считаем провалом
          api.log('тело занято (' + h.error + ') — жду');
          await api.sleep(1200);
          continue;
        }
        if (++fails >= 3) {
          return { ok: false, error: `не дошла: ${h.error}`, at: [p.x, p.y, p.z], hops, escapes, fails };
        }
        api.log('goto: ' + h.error);
        continue;
      }
      hops++;
      fails = 0;
    }
    return { ok: false, error: 'слишком много перебежек', hops, escapes, nights };
  }
};
