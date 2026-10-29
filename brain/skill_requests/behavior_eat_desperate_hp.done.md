# behavior_eat_desperate_hp: готово
Версия: behavior/reflexes.js, behavior/autopilot.js (правка поведения)
Что изменено:
- reflexes.js:304 — автоеда ест «отчаянно» (rotten_flesh, сырая курица) не только при сытости <= 6, но и при HP <= eatHurtHp (12).
- autopilot.js:781 — hasFood при HP <= 12 считает rotten_flesh/chicken едой (раньше «еды нет» при сумке гнилого мяса → вечное «жду»).
- autopilot.js:329 — мало HP, регена нет (еда < 18), съедобное есть, рефлекс за apEatWaitSec (6 с) не съел — автопилот сам зовёт eat {desperate:true, count:2}.
Как проверено: selfTest — pickFood для раненой даёт rotten_flesh; HP 3, еда 10, есть съедобное, waitSec 7 → lowhp_eat с desperate. Проверено офлайн: behavior/test.js (selfTest) — новые проверки по «Как проверить»; node test/behavior.js, test/autopilot.js, test/build_goal.js, test/defense.js — ok; npm test — всё ok, кроме test/offline.js (внутри test/chest.js: «сундук не открыл окно» — не поведение). Бот не запускался: правка включится после перезагрузки поведения хозяином.
