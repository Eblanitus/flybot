// Этап 1в — баттл-рояль мух (docs/goal_path.md, утверждено хозяином 04.11). Чистые функции без игры и без файлов —
// их проверяет test/hardcore_br.js. Награда мухи — только убийства других мух; выжила ли сама и кто последний — неважно.
//   spawnPoints  — где поставить мух: каждая пара не ближе min и не дальше max блоков (хозяин: 100–300);
//   parseKill    — кто кого убил, из сообщения о смерти («HC_2 was slain by HC_4»);
//   huntDecision — что делать охотнику сейчас: ничего (работает автопилот), идти к мухе, драться, бросить охоту.
'use strict';

// Точки расстановки вокруг (cx, cz): каждая пара не ближе min, у каждой мухи ближайшая соседка не дальше max
// (хозяин: 100–300). 5 мух помещаются так, что и все пары ≤ max; 10 — уже нет (10 точек через 100 блоков не влезают
// в круг 300), поэтому правило — про ближайшую соседку. Круг подбора растёт, пока расстановка не выйдет; не вышло за tries —
// лучший найденный набор и ok: false.
function spawnPoints(n, { min = 100, max = 300, cx = 0, cz = 0, rand = Math.random, tries = 3000 } = {}) {
  let best = null, bestErr = Infinity;
  let R = max / 2;
  for (let k = 0; k < tries; k++) {
    if (k && k % 300 === 0) R *= 1.12;   // не влезает — круг шире
    const pts = [];
    for (let i = 0; i < n; i++) {
      let p = null;
      for (let j = 0; j < 60 && !p; j++) {
        const a = rand() * Math.PI * 2, r = R * Math.sqrt(rand());
        const q = { x: Math.round(cx + Math.cos(a) * r), z: Math.round(cz + Math.sin(a) * r) };
        if (pts.every(o => Math.hypot(o.x - q.x, o.z - q.z) >= min)) p = q;
      }
      pts.push(p || { x: Math.round(cx + (rand() - 0.5) * 2 * R), z: Math.round(cz + (rand() - 0.5) * 2 * R) });
    }
    const err = pairError(pts, min, max);
    if (err < bestErr) { best = pts; bestErr = err; }
    if (err === 0) break;
  }
  return { points: best, ok: bestErr === 0 };
}

// Нарушения (0 — расстановка годная): пары ближе min + у кого ближайшая соседка дальше max
function pairError(pts, min, max) {
  let e = 0;
  for (let i = 0; i < pts.length; i++) {
    let near = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      if (j > i && d < min) e += min - d;
      near = Math.min(near, d);
    }
    if (pts.length > 1 && near > max) e += near - max;
  }
  return e;
}

// Сообщение о смерти → { victim, killer } если смерть засчитана мухе (ник с префиксом), иначе null.
// Ванильные формы: «A was slain by B», «A was shot by B using …», «A didn't want to live in the same world as B»,
// «A drowned whilst trying to escape B», «A was doomed to fall by B»… Жертва — первое слово, убийца — последняя другая муха в тексте.
function parseKill(msg, prefix = 'HC_') {
  const s = String(msg || '').trim().replace(/^.*?\]: /, '');
  const words = s.split(/\s+/).map(w => w.replace(/[.,!:;'"]+$/, ''));
  const victim = words[0];
  if (!victim || !victim.startsWith(prefix) || words.length < 3) return null;
  const others = words.slice(1).filter(w => w.startsWith(prefix) && w !== victim && /^[A-Za-z0-9_]{3,16}$/.test(w));
  if (!others.length) return null;
  return { victim, killer: others[others.length - 1] };
}

// Чем бьёт: предмет в руке → «меч» / «топор» / «кулак» / имя предмета
function weaponOf(held) {
  const n = held && (held.name || held);
  if (!n || typeof n !== 'string') return 'fist';
  if (/_sword$/.test(n)) return n;
  if (/_axe$/.test(n)) return n;
  if (/^(bow|crossbow|trident|mace)$/.test(n)) return n;
  return 'fist';
}
const isWeapon = w => w && w !== 'fist';

// Пороги охотника (поведение, их потом подкручивает учитель). prepSec — сколько секунд жизни муха готовится, если
// оружия нет (с оружием охота разрешена сразу); fightDist — с какого расстояния вместо подхода начинаем бой.
const HUNT = { hp: 14, food: 12, prepSec: 600, fightDist: 12, memorySec: 120, maxFollowSec: 240 };

// s — что знает муха сейчас: { hp, food, lifeSec, armed, isNight, busy (тело занято не нами: рефлекс, еда, побег),
//   seen: [{ name, d, at, ago }] — мухи на панели локатора (ago — сколько секунд назад видели), ours: { kind, target, sec } | null }
// → { act: 'none' | 'follow' | 'fight' | 'stop', target?, why }
function huntDecision(s, T = HUNT) {
  const ours = s.ours || null;
  const ready = s.hp >= T.hp && s.food >= T.food && (s.armed || s.lifeSec >= T.prepSec);
  if (s.busy) return { act: 'none', why: 'тело занято (рефлекс или своё дело)' };
  if (!ready) {
    const why = s.hp < T.hp ? `HP ${s.hp} — сначала подлечиться` : s.food < T.food ? `сытость ${s.food} — сначала поесть` : 'без оружия — готовлюсь';
    return ours ? { act: 'stop', why } : { act: 'none', why };
  }
  const fresh = (s.seen || []).filter(m => m.ago <= T.memorySec).sort((a, b) => a.d - b.d);
  const tgt = fresh[0];
  if (!tgt) return ours ? { act: 'stop', why: 'муху потерял из виду' } : { act: 'none', why: 'мух на локаторе нет' };
  // ночью далеко не ходим: только если муха уже близко
  if (s.isNight && tgt.d > 32 && !ours) return { act: 'none', why: `ночь, ${tgt.name} далеко (${tgt.d} м)` };
  if (tgt.d <= T.fightDist && tgt.ago <= 3) {
    if (ours && ours.kind === 'fight' && ours.target === tgt.name) return { act: 'none', why: `дерусь с ${tgt.name}` };
    return { act: 'fight', target: tgt.name, why: `${tgt.name} в ${tgt.d} м — бой` };
  }
  if (ours && ours.kind === 'follow' && ours.target === tgt.name) {
    if (ours.sec > T.maxFollowSec) return { act: 'stop', why: `иду за ${tgt.name} дольше ${T.maxFollowSec} с — бросаю` };
    return { act: 'none', why: `иду к ${tgt.name} (${tgt.d} м)` };
  }
  return { act: 'follow', target: tgt.name, why: `${tgt.name} в ${tgt.d} м — иду` };
}

module.exports = { spawnPoints, pairError, parseKill, weaponOf, isWeapon, huntDecision, HUNT };
