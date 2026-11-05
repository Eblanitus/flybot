// Очки жизни мухи (этап 2, хозяин 04.11): развитие, ночи, убийства; минус за дневной простой и круг провалов. Смерть — 0.
// Чистый счётчик: события подаёт hardcore/fly.js, карточка берёт toJSON(). Проверка офлайн — test/hardcore_points.js.
'use strict';
const IDLE_SEC = 120, IDLE_R = 3, CYCLE_FAILS = 3;
// убийство: кулак, дерево, золото — 1; камень, медь и лучше, лук, арбалет, трезубец, булава — 2
const KILL2 = /^(stone|copper|iron|diamond|netherite)_|^(bow|crossbow|trident|mace)$/;
const killPoints = w => (KILL2.test(String(w || '')) ? 2 : 1);

function makePoints() {
  const list = [], byKind = {}, steps = new Set(), fails = {};
  let total = 0, nights = 0, anchor = null, lastInv = null;
  const add = (t, kind, d, note) => { total += d; byKind[kind] = (byKind[kind] || 0) + d; list.push({ t, kind, d, note }); };
  return {
    get total() { return total; },
    byKind, list,
    step(n, t) { if (n >= 1 && n <= 5 && !steps.has(n)) { steps.add(n); add(t, 'step', 1, `ступень ${n}`); } }, // 6-я — это ночь, её считает night()
    night(t) { nights++; add(t, 'night', 1, `ночь ${nights}`); },
    kill(weapon, t, victim) { add(t, 'kill', killPoints(weapon), `${victim || '?'} (${weapon || 'fist'})`); },
    // кадр раз в секунду: { t, day, pos: [x, y, z], inv: { имя: штук } }
    // днём 2 мин в радиусе 3 блоков без новой вещи — −1, и снова через 2 мин; ночью простоя нет
    frame(f) {
      if (!f || !f.pos) return;
      const inv = f.inv || {};
      const gained = !!lastInv && Object.entries(inv).some(([n, c]) => c > (lastInv[n] || 0));
      lastInv = inv;
      const moved = !!anchor && Math.hypot(f.pos[0] - anchor.pos[0], f.pos[1] - anchor.pos[1], f.pos[2] - anchor.pos[2]) > IDLE_R;
      if (!anchor || moved || gained || !f.day) { anchor = { t: f.t, pos: f.pos }; return; }
      if (f.t - anchor.t >= IDLE_SEC) { add(f.t, 'idle', -1, 'простой 2 мин'); anchor = { t: f.t, pos: anchor.pos }; }
    },
    // итог дела автопилота: один и тот же ключ провалился 3 раза (успех этого ключа обнуляет счёт) — −1
    deed(key, ok, t) {
      if (ok) { fails[key] = 0; return; }
      fails[key] = (fails[key] || 0) + 1;
      if (fails[key] >= CYCLE_FAILS) { fails[key] = 0; add(t, 'cycle', -1, `${key}: ${CYCLE_FAILS} провала`); }
    },
    toJSON() { return { total, byKind, nights, list: list.slice(-300) }; }
  };
}
module.exports = { makePoints, killPoints, IDLE_SEC, IDLE_R, CYCLE_FAILS };
