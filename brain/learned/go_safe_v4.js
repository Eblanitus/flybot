// версия: как v3 + лава/огонь/вода на пути — обход или отказ; в гору выше max_climb не лезет
// go_safe — дойти до точки перебежками: смотрим и мобов, и лаву/огонь/воду, и высоту на пути.
// Заявка учителя (случай 20261022-022921-27, урок L019; раньше L017 — про мобов):
//   прежняя перебежка шла вслепую (legacy goto тела — голый pathfinder без проверки лавы):
//   pathfinder увёл муху с y=77 в гору (y=100) прямо в озеро лавы, HP 6 → смерть,
//   а запуск потом ещё 80 с держал исполнителя («исполнитель занят навыком go_safe»).
// Правки:
//   1) перед каждой перебежкой — снимок (hazards: «лава N м», «горю», «под водой»; blocks.lava/water)
//      и survey коридора: лава/вода на пути → не начинаем, отказ с причиной;
//   2) не лезем в гору: рельеф выше текущей высоты на max_climb (6) — обход вбок или отказ;
//      высоту следим и по ходу перебежки, а не только в конце;
//   3) перебежка короткая (step 12, hop_timeout 20 с), снимок раз в секунду:
//      «горю»/лава/вода → сразу отпускаем тело (stop) и отказываем;
//   4) смерть мухи — конец запуска: счётчик смертей вырос или позиция скакнула (респавн)
//      → stop и отказ «муха погибла», исполнитель освобождается сразу, а не через минуту.
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

// ---- смерть/респавн: конец запуска, тело надо отпустить сразу ----
function deathInfo(snap, o) {
  if (!snap || snap.ready === false) return 'муха погибла (тело не отвечает)';
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
// что видно в колонке (x,z): земля / вода / лава
function columnAt(cell, sv, x, z) {
  let groundY = null, waterY = null, lavaY = null;
  for (let y = sv.origin.y + sv.size.y - 1; y >= sv.origin.y; y--) {
    const c = cell(x, y, z);
    if (c === '?' || c === 'air') continue;
    if (c === 'lava') { if (lavaY === null) lavaY = y; continue; }
    if (c === 'water') { if (waterY === null) waterY = y; continue; }
    if (TREE_RE.test(c)) continue;
    if (groundY === null) groundY = y;
  }
  return { groundY, waterY, lavaY };
}

// ---- проверка участка пути: лава/вода/высота ----
// ok=false + reason — почему идти нельзя (навык обязан вернуть отказ с причиной)
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
  let below = 6, above = o.maxClimb + 4;
  const cols = (x2 - x1 + 1) * (z2 - z1 + 1);
  while (cols * (below + above + 1) > MAX_SURVEY && (below > 2 || above > 3)) {
    if (above > 3) above--; else below--;
  }
  let sv;
  try { sv = await api.cmd('survey', { x1, y1: y0 - below, z1, x2, y2: y0 + above, z2 }); }
  catch (e) { return { ok: false, reason: 'survey не удался: ' + short(e.message) }; }
  if (!sv || !sv.layers) return { ok: false, reason: 'survey без слоёв' };
  const cell = gridOf(sv);
  const n = Math.max(2, Math.round(len));
  let prevY = from.y, topY = from.y, maxDrop = 0, dropAt = null, unknown = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = Math.round(from.x + dx * t), cz = Math.round(from.z + dz * t);
    const center = columnAt(cell, sv, cx, cz);
    const walkY = center.groundY != null ? center.groundY + 1 : null;
    // лава/вода рядом с дорогой (центр и кромки коридора)
    for (const off of [-w, 0, w]) {
      const side = off === 0 ? center : columnAt(cell, sv, Math.round(cx + px * off), Math.round(cz + pz * off));
      const sWalk = side.groundY != null ? side.groundY + 1 : walkY;
      if (side.lavaY != null && (sWalk == null || side.lavaY >= sWalk - 2)) {
        return { ok: false, reason: `лава на пути (${Math.round(cx + px * off)} ${side.lavaY} ${Math.round(cz + pz * off)})`, lava: true };
      }
      if (side.waterY != null && side.groundY != null && side.waterY - side.groundY >= 2) {
        return { ok: false, reason: `вода на пути (${Math.round(cx + px * off)} ${side.waterY} ${Math.round(cz + pz * off)}) — вплавь не иду`, water: true };
      }
    }
    if (walkY == null) { unknown++; continue; }
    if (walkY > topY) topY = walkY;
    const drop = prevY - walkY;
    if (drop > maxDrop) { maxDrop = drop; dropAt = [cx, walkY, cz]; }
    prevY = walkY;
  }
  const climb = topY - from.y;
  if (climb > o.maxClimb) return { ok: false, reason: `маршрут в гору: +${climb} м (предел ${o.maxClimb}) — не лезу`, climb };
  if (topY > limitY) return { ok: false, reason: `маршрут идёт в гору до y=${topY} (предел ${limitY}) — не повторяю такой путь`, climb };
  const allow = safeDrop(hp);
  if (maxDrop > allow) return { ok: false, reason: `обрыв ${maxDrop} м (предел ${allow} м) у ${dropAt}`, drop: maxDrop };
  return { ok: true, climb, drop: maxDrop, unknown };
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
  api.log(`перебежка → ${goal.x} ${goal.z}`);
  let done = null;
  const hopP = api.cmd('goto', g).then(
    () => { done = { kind: 'done' }; },
    e => { done = { kind: 'err', error: short(e.message) }; }
  );
  const startY = p.y;
  let res = null;
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
  if (!done) { await stopBody(api); return { kind: 'err', error: 'перебежка не закончилась' }; }
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
  description: 'Дойти до x,z (y необязательно) перебежками по step блоков (12). Перед каждой перебежкой проверяет и врагов-игроков (eyes.threats, d<=24), и враждебных мобов (eyes.enemies, d<=mob_d=8): моб ближе — не идёт, отступает (escape) и возвращает отказ с причиной. Лава/огонь/вода на пути (снимок + survey коридора) и подъём в гору (выше текущей высоты на max_climb) — не начинает перебежку: ищет обход или возвращает отказ с причиной. Во время перебежки снимок раз в секунду: горит/лава/вода/урон/моб/залезла в гору — отпускает тело и отказывается. Смерть мухи (респавн) — конец запуска с отказом «муха погибла». Ночью дальше night_max (40 м) не идёт — пережидает ночь. Провал после 3 бегств или 3 неудачных переходов.',
  params: {
    x: 'цель x',
    z: 'цель z',
    y: 'цель y (необязательно)',
    step: 'длина перебежки, по умолчанию 12 (4..32)',
    mob_d: 'ближе какого расстояния враждебный моб = опасность (отказ), по умолчанию 8 м',
    night_wait: '1 (по умолчанию) — ночью не идти дальше night_max, переждать; 0 — идти и ночью',
    night_max: 'ночью не идти дальше этого расстояния, по умолчанию 40 м',
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
      let goal = null, chk = null, off = 0;
      for (const o2 of detours) {
        const cand = { x: Math.round(p.x + ux * len + px * o2), z: Math.round(p.z + uz * len + pz * o2) };
        const c = await checkPath(api, p, cand, hp, o, limitY);
        if (c.ok) { goal = cand; chk = c; off = o2; break; }
        reasons.push((o2 === 0 ? 'прямо' : `обход ${o2 > 0 ? '+' : ''}${o2} м`) + ': ' + c.reason);
      }
      if (!goal) {
        await stopBody(api);
        return {
          ok: false, error: `безопасного пути нет: ${reasons.slice(0, 3).join('; ')}`,
          at: [p.x, p.y, p.z], hops, escapes, nights, blocked: reasons
        };
      }
      api.log(`перебежка ${off ? '(обход ' + off + ' м)' : ''}: подъём ${chk.climb} м, яма ${chk.drop} м${chk.unknown ? ', земля видна не везде' : ''}`);

      // 8) перебежка со слежением за HP, мобами, высотой и смертью
      const h = await hop(api, p, goal, o, hp);
      if (h.kind === 'dead') {
        return { ok: false, error: h.why, at: [p.x, p.y, p.z], hops, escapes, nights };
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
