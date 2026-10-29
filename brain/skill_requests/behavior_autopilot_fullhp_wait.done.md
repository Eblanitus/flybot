# behavior_autopilot_fullhp_wait: готово
Версия: behavior/autopilot.js, behavior/thresholds.js (правка поведения)
Что изменено:
- autopilot.js:99 lowHpOf — HP >= apFullHp (20), ударов нет и моб не ближе порога прерывания: «мало HP / опасность» не считается (outlook !win с крипером в 11 м больше не держит муху).
- autopilot.js:283-345 — у всех «жду» потолок apWaitMaxSec (120 с). waitSec считает тик (autopilot.js:1201, ap.waitSince). Прежний счётчик failInfo.lowhp_waitCount жил в свежем объекте каждого тика и не срабатывал никогда. После потолка: база / охота / поиск еды (explore).
- autopilot.js:410 — переход на базу не вышел: ждём не дольше потолка, потом дела рядом; autopilot.js:462 — дел нет дольше потолка: idle_move (шаг 16 м), а не ещё минута простоя.
- noteWait пишет «жду N с из 120, потом действую».
- thresholds.js: apWaitMaxSec, apEatWaitSec, apFullHp, rangedLowHpDist, safetyWorkDist.
Как проверено: selfTest — (1) HP 20, outlook !win, крипер вне hostileR, есть постройка → build; (2) HP 9, еда 4, еды нет: до потолка null, после → hunt/go_base/explore; HP 0 без еды после потолка → действие; дел нет 121 с → idle_move. Проверено офлайн: behavior/test.js (selfTest) — новые проверки по «Как проверить»; node test/behavior.js, test/autopilot.js, test/build_goal.js, test/defense.js — ok; npm test — всё ok, кроме test/offline.js (внутри test/chest.js: «сундук не открыл окно» — не поведение). Бот не запускался: правка включится после перезагрузки поведения хозяином.
