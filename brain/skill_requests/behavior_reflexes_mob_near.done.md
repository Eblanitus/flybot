# behavior_reflexes_mob_near: готово
Версия: behavior/autopilot.js (правка поведения)
Что изменено:
- Гейт прерывания wait_night: крипер ближе creeperInterruptDist (8 м) прерывает ожидание даже в укрытии и без ударов (раньше нужны были hitRecent или «не в укрытии»). Исправлен вызов nightDefense(s, true) → nightDefense(true): параметр съедал preempt.
- nightDefense: стены при крипере рядом не строим; побег, если в укрытии стоим дольше потолка (120 с), — с причиной.
Как проверено: selfTest — (1) ночь, идёт wait_night, крипер 5 м, в укрытии, без оружия → действие защиты с preempt, не null; (2) крипер вне hostileR (15 м) → null, wait_night продолжается; (3) selfTest проходит (node test/behavior.js ok). Проверено офлайн: behavior/test.js (selfTest) — новые проверки по «Как проверить»; node test/behavior.js, test/autopilot.js, test/build_goal.js, test/defense.js — ok; npm test — всё ok, кроме test/offline.js (внутри test/chest.js: «сундук не открыл окно» — не поведение). Бот не запускался: правка включится после перезагрузки поведения хозяином.
