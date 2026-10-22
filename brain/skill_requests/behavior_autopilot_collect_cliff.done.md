# behavior_autopilot_collect_cliff: готово
Версия: behavior/autopilot.js (исправление текущего поведения)
Запуск: curl.exe -s -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3199/behavior/reload
Params: edgeHazard — проверка s.snapshot.hazards на 'обрыв' || s.survey.edges с drop >= 3; при истинности collect_stone не начинал
Что делает: добавил проверку края перед задачей collect_stone (ст. 312 behave/autopilot.js). Если в снимке hazards есть 'обрыв' или survey.edges найдены с перепадом >= 3 блоков — задача collect_stone в кандидаты не добавляется, автопилот выбирает следующее дело или исследует место рядом. Это предотвращает падение мухи с Platform при выключенном day_routine.
Ограничения: работает только когда доступен s.snapshot и s.survey (после загрузки мира). Не заменяет проверку дня day_routine, добавляет защиту в автопилот. Сбор log/dirt similarly protected тем же условием.