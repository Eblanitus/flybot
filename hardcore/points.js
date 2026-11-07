// Очки жизни мухи (этап 2, хозяин 04.11): развитие, убийства; минус за дневной простой, круг провалов и раннюю смерть.
// Хозяин 05.11 («кто быстрее развился и умер, тот лучше» — так быть не должно): +1 за пережитую ночь убран; вместо него
// смерть — штраф −(7 − прожито игровых дней), дробно с точностью 0,1 (умер в первую ночь ≈ −7, прожил 4 дня — −3,
// 7 дней и больше — 0). Живая муха на конце мира (срок вышел, последний выживший) штрафа не получает.
// Чистый счётчик: события подаёт hardcore/fly.js, карточка берёт toJSON(). Проверка офлайн — test/hardcore_points.js.
// Хозяин 06.11 («нужно фиксить провалы»): 3/4 провалов в deeds.jsonl короче 1 с — навык честно отказался
// до старта (нет кирки, обрыв, «ранее отказ здесь»), а не пытался и не смог. Такие отказы провалами не считаем.
// Раньше после каждых 3 провалов счётчик обнулялся и штраф капал заново по каждому ключу — до −84 за жизнь.
// Теперь штраф за ключ берётся один раз, до первого успеха. VER=3 — контрольная точка: все анализы обязаны
// игнорировать очки версий 1 и 2 (см. hardcore/points_checkpoint.js), старые минусы не источник выводов.
'use strict';
const IDLE_SEC = 120, IDLE_R = 3, CYCLE_FAILS = 3, DEATH_DAYS = 7, INSTANT_SEC = 1, VER = 3;   // VER: 3 — убраны мгновенные отказы и бесконечный штраф, 2 — штраф за смерть, 1 — старая (+1 за ночь)
// убийство: кулак, дерево, золото — 1; камень, медь и лучше, лук, арбалет, трезубец, булава — 2
const KILL2 = /^(stone|copper|iron|diamond|netherite)_|^(bow|crossbow|trident|mace)$/;
const killPoints = w => (KILL2.test(String(w || '')) ? 2 : 1);

function makePoints() {
  const list = [], byKind = {}, steps = new Set(), fails = {}, charged = new Set();
  let total = 0, anchor = null, lastInv = null;
  const r1 = x => Math.round(x * 10) / 10;   // штраф дробный — без хвостов float (0.1 + 0.2)
  const add = (t, kind, d, note) => { total = r1(total + d); byKind[kind] = r1((byKind[kind] || 0) + d); list.push({ t, kind, d, note }); };
  return {
    get total() { return total; },
    byKind, list,
    step(n, t) { if (n >= 1 && n <= 5 && !steps.has(n)) { steps.add(n); add(t, 'step', 1, `ступень ${n}`); } }, // 6-я (пережил ночь) очков не даёт
    // смерть: days — прожито игровых дней от старта мира (дробное); штраф −(7 − days), не больше 0; второй раз не считается
    death(days, t) {
      if (byKind.death != null) return;
      const d = r1(Math.max(0, Number(days) || 0));
      add(t, 'death', -r1(Math.max(0, DEATH_DAYS - d)), `смерть, прожито ${d} дн.`);
    },
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
    // итог дела автопилота. sec — сколько шёл запуск: ≤1 с means отказ до старта, это не провал.
    // Три реальных провала одного ключа — −1, и больше за этот ключ не снимаем, пока он не получится.
    deed(key, ok, t, sec) {
      if (ok) { fails[key] = 0; charged.delete(key); return; }
      if (sec != null && Number(sec) <= INSTANT_SEC) return;   // «нет кирки», «обрыв», «ранее отказ здесь»
      fails[key] = (fails[key] || 0) + 1;
      if (fails[key] >= CYCLE_FAILS && !charged.has(key)) {
        charged.add(key);
        add(t, 'cycle', -1, `${key}: ${CYCLE_FAILS} провала`);
      }
    },
    toJSON() { return { ver: VER, total, byKind, list: list.slice(-300) }; }
  };
}
module.exports = { makePoints, killPoints, IDLE_SEC, IDLE_R, CYCLE_FAILS, DEATH_DAYS, INSTANT_SEC, VER };
