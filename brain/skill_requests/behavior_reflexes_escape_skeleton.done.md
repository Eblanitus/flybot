# behavior_reflexes_escape_skeleton: готово
Версия: behavior/reflexes.js, behavior/autopilot.js
Запуск: curl.exe -s -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3199/behavior/reload
Params: (поведение, не навык — параметров нет)
Что делает:
1. Reflex escape при атаке скелета (или другого ranged моба) и HP < 10 теперь использует экстренные варианты: cover_escape (поиск укрытия от линии огня) или wall_escape (стена между собой и скелетом, если близко и есть блоки), вместо sprint_away/zigzag. Ночью против мобов ближнего боя остаётся pillar.
2. Autopilot при активном reflex escape и HP < 10 не начинает свои задачи, отдавая тело рефлексам/защите.
Ограничения: Требует перезагрузки поведения (POST /behavior/reload). Работает только при HP < 10 (apLowHp). Для скелетов на дистанции > 5 блоков без блоков — используется cover_escape.