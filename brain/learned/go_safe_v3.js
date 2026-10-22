// версия: как v2; тело занято другим — ждёт, а не считает провалом
// go_safe — дойти до точки перебежками, с оглядкой на враждебных мобов.
// Заявка учителя (случай 20261022-022131-25, смерть у базы ночью):
//   1) перед каждой перебежкой смотрим eyes.enemies (враждебные мобы), а не только eyes.threats (игроки):
//      моб ближе mob_d (8 м) — не идём, отступаем (escape) и возвращаем отказ с причиной;
//   2) во время перебежки следим за HP: прилетел урон — честно ok:false (с потерей HP), а не ok:true;
//   3) ночью далеко не идём (через открытое поле) — пережидаем ночь (wait_night, иначе shelter);
//   4) тело держим коротко: перебежка идёт в фоне, каждые ~1.2 с смотрим снимок; опасно — сразу stop и escape.
'use strict';

const POLL_MS = 1200;        // как часто смотрим снимок во время перебежки
const HOP_WAIT_MS = 30000;   // сколько максимум ждём одну перебежку

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

// Отступ: освободить тело (если держим его перебежкой) и спрятаться/убежать.
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

// Ночь: переждать (укрытие/кровать), в поле не идти.
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

// Одна перебежка: идём в фоне и следим за HP и мобами. Возвращает {kind}: ok | mob | damage | err.
async function hop(api, p, tx, tz, ty, step, mobD, hp0) {
  const dx = tx - p.x, dz = tz - p.z;
  const d = Math.hypot(dx, dz) || 1;
  const k = d > step ? step / d : 1;
  const goal = { x: Math.round(p.x + dx * k), z: Math.round(p.z + dz * k), timeout: 25 };
  if (k === 1 && Number.isFinite(ty)) goal.y = ty;
  api.log(`перебежка → ${goal.x} ${goal.z}` + (goal.y != null ? ` ${goal.y}` : ''));

  let done = null;
  const hopP = api.cmd('goto', goal).then(
    () => { done = { kind: 'done' }; },
    e => { done = { kind: 'err', error: short(e.message) }; }
  );

  let res = { kind: 'ok' };
  const end = Date.now() + HOP_WAIT_MS;
  while (Date.now() < end) {
    await api.sleep(POLL_MS);
    const snap = await snapOf(api);
    if (!snap) { if (done) break; continue; }
    const eyes = snap.eyes || {};
    const hp = hpOf(snap);
    if (hp < hp0) {                       // прилетел урон — отпускаем тело и честно отказываем
      try { await api.stop(); } catch (e) {}
      res = { kind: 'damage', hp0, hp };
      break;
    }
    const mobs = mobsNear(eyes, mobD);    // моб подошёл вплотную
    if (mobs.length) {
      try { await api.stop(); } catch (e) {}
      res = { kind: 'mob', mob: mobs[0] };
      break;
    }
    const q = snap.position || {};
    if (dist(q.x, q.z, goal.x, goal.z) <= 2.5) { res = { kind: 'ok' }; break; }
    if (done) { res = done.kind === 'done' ? { kind: 'ok' } : { kind: 'err', error: done.error }; break; }
  }
  await Promise.race([hopP, api.sleep(1500)]);
  if (!done) {                          // перебежка не закончилась — отпускаем тело
    try { await api.stop(); } catch (e) {}
    return { kind: 'err', error: 'перебежка не закончилась' };
  }

  if (res.kind === 'ok') {
    const s = await snapOf(api);
    if (s) {
      const hp = hpOf(s);
      if (hp < hp0) return { kind: 'damage', hp0, hp };
      const mobs = mobsNear(s.eyes || {}, mobD);
      if (mobs.length) return { kind: 'mob', mob: mobs[0] };
    }
  }
  return res;
}

module.exports = {
  name: 'go_safe',
  description: 'Дойти до x,z (y необязательно) перебежками по step блоков (12). Перед каждой перебежкой проверяет и врагов-игроков (eyes.threats, d<=24), и враждебных мобов (eyes.enemies, d<=mob_d=8): моб ближе — не идёт, отступает (escape) и возвращает отказ с причиной. Урон во время перебежки — тоже отказ (ok:false, с потерей HP). Ночью дальше night_max (40 м) не идёт — пережидает ночь. Провал после 3 бегств или 3 неудачных переходов.',
  params: {
    x: 'цель x',
    z: 'цель z',
    y: 'цель y (необязательно)',
    step: 'длина перебежки, по умолчанию 12 (4..32)',
    mob_d: 'ближе какого расстояния враждебный моб = опасность (отказ), по умолчанию 8 м',
    night_wait: '1 (по умолчанию) — ночью не идти дальше night_max, переждать; 0 — идти и ночью',
    night_max: 'ночью не идти дальше этого расстояния, по умолчанию 40 м',
    min_hp: 'ниже этого HP не идём (отступ), по умолчанию 8',
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
    const deadline = Date.now() + maxSec * 1000;

    let hops = 0, escapes = 0, nights = 0, fails = 0;

    for (let i = 0; i < 80; i++) {
      if (Date.now() > deadline) {
        return { ok: false, error: `время навыка вышло (${maxSec} с)`, hops, escapes, nights };
      }
      const snap = await api.snapshot();
      if (!snap || !snap.position) throw new Error('тело не отвечает');
      const p = snap.position;
      const eyes = snap.eyes || {};
      const hp = hpOf(snap);
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

      // 6) перебежка со слежением за HP и мобами
      const h = await hop(api, p, tx, tz, ty, step, mobD, hp);
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
