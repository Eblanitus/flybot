// Пороги поведения: числа HP/еды/дистанций/времени, по которым рефлексы и автопилот решают «когда».
// Перенесены из lib/reflexes.js и lib/autopilot.js как есть («учебные колёса»). Менять — только через проверку (test/behavior.js).
'use strict';
module.exports = {
  // ---- рефлексы: плавание ----
  swimLongUnderMs: 7000,     // голова под водой дольше — держать «прыжок», даже если идёт путь pathfinder
  // ---- рефлексы: еда ----
  eatFood: 14,               // есть, когда сытость <= этого
  eatHurtHp: 12,             // ...или когда сытость < 20 и HP <= этого
  desperateFood: 6,          // сытость <= этого: есть и гнилое мясо/сырую курицу; нечего есть — сигнал danger hunger
  hungerWarnResetFood: 10,   // сытость выше — снова можно предупредить о голоде
  // ---- рефлексы: защита от мобов ----
  defenseLowHp: 8,           // HP ниже — убегать/укрываться, а не драться
  defenseFightDist: 12,      // драться с обидчиком, только если он не дальше
  crowdR: 10, crowdN: 2,     // без оружия и врагов в crowdR >= crowdN (или ночь) — сначала укрытие
  shelterFailMs: 15000,      // укрытие только что не вышло — не предлагать его столько
  swatMinHp: 8,              // занят делом и HP не ниже — просто отмахнуться
  swatReach: 3.2,
  fightRadius: 12,
  // ---- рефлексы: защита от игроков ----
  playerFightHp: 12,         // драться с игроком: есть оружие, HP не ниже, посторонних врагов рядом нет
  playerOthersR: 6,
  playerFleeHp: 8, playerFightTimeout: 45,
  // ---- рефлексы: респаун ночью среди мобов ----
  respawnDelayMs: 1500, respawnHostilesR: 16,
  // ---- автопилот ----
  idleMs: 30000,             // столько мозг должен молчать (и тело стоять), чтобы автопилот взялся за дело
  tickMs: 2000,
  enemyR: 16,                // враг-игрок ближе — реагировать сразу
  failMax: 3,                // провалов подряд до паузы
  backoffMs: 60000,
  chatMs: 60000,             // не чаще одного сообщения в чат в минуту
  apFightHp: 12,             // драться с агрессором-игроком при HP не ниже
  apFightRadius: 16, apFleeHp: 8, apFightTimeout: 45, apEscapeDist: 24,
  apLowHp: 10,               // HP ниже — бежать (враги рядом) или укрываться
  apLowHpEscapeDist: 16,
  nightSoonSec: 40,          // до ночи меньше — считать, что ночь
  hostileR: 10,              // «враги рядом» для автопилота
  aloneR: 6, aloneEnemyR: 10,
  animalsR: 32,
  nightBlocksMin: 9,         // меньше блоков ночью — сначала накопать земли
  recoverMs: 240000,         // идти за вещами, если смерть была не раньше
  stuckMs: 6000, underWaterMs: 10000,
  unstuckDist: 8,
  waitNightSec: 720,
  dayRoutineSec: 600,
  huntFood: 14, huntCount: 2,
  pickLogs: 3, needLogs: 8, logCount: 6,
  cobbleWant: 24, stoneCount: 12,
  exploreDist: 48,
  baseTimeoutSec: 420
};
