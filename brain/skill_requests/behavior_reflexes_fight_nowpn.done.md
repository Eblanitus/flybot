# behavior_reflexes_fight_nowpn: готово
Версия: behavior/reflexes.js (правка поведения)
Что изменено:
- reflexes.js:219 mobNearPlan (решение цикла mob_near вынесено в функцию) — бой только с мечом/топором; без оружия — укрытие, вплотную (< 2 м) или после неудачного укрытия — отход, с причиной «нет оружия, укрываюсь/отхожу».
- reflexes.js:100 defensePrior — без оружия fight в вариантах нет (было через canFight).
- mob_hurt с sure:false (обидчик угадан) — вместо боя побег; урон от упавшего сталактита (what:'сталактит') — побег.
Как проверено: selfTest — (1) паук 5 м, HP 20, без оружия → shelter/escape; (2) с железным мечом против зомби → fight; (3) defensePrior без оружия — без fight. test/defense.js: ожидание ['escape','shelter','fight'] заменено на ['escape','shelter'] — оно закрепляло бой голыми руками, который заявка запрещает. Проверено офлайн: behavior/test.js (selfTest) — новые проверки по «Как проверить»; node test/behavior.js, test/autopilot.js, test/build_goal.js, test/defense.js — ok; npm test — всё ok, кроме test/offline.js (внутри test/chest.js: «сундук не открыл окно» — не поведение). Бот не запускался: правка включится после перезагрузки поведения хозяином.
