# behavior_reflexes_escape_skeleton_lowhp: готово
Версия: behavior/reflexes.js, behavior/combat.js (правка поведения)
Что изменено:
- combat.js:18 chooseVariant — побег от стрелка при HP < 10 или под землёй: escape_to_base исключён (если других вариантов нет — прежний выбор).
- reflexes.js:240 rangedLowHpPlan + цикл mob_near reflexes.js:436 — HP < 10 и стрелок ближе rangedLowHpDist (16 м): побег сразу, не ждём 6 м. Стиль чередуется cover_escape / sprint_away, так что после fled=false следующий тик даёт второй побег другим стилем, а не паузу.
Как проверено: selfTest — HP 6, скелет 12 м → два плана с разными стилями, не escape_to_base; HP 20 → правила нет. combat.chooseVariant офлайн проверен только загрузкой (нужен реальный набор вариантов). Проверено офлайн: behavior/test.js (selfTest) — новые проверки по «Как проверить»; node test/behavior.js, test/autopilot.js, test/build_goal.js, test/defense.js — ok; npm test — всё ok, кроме test/offline.js (внутри test/chest.js: «сундук не открыл окно» — не поведение). Бот не запускался: правка включится после перезагрузки поведения хозяином.
