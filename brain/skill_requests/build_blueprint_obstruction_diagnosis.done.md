# build_blueprint_obstruction_diagnosis: готово
Версия: build_blueprint_obstruction_diagnosis
Запуск: curl.exe -s "http://127.0.0.1:3200/go?name=build_blueprint_obstruction_diagnosis&blueprint=hut_west&x=-403&y=67&z=33&rot=0"
Params: blueprint — имя чертежа из brain/blueprints (по умолчанию hut_west), x, y, z — северо-западный угол постройки, rot — поворот (0 по умолчанию), dry — 1 для сметы.
Что делает: Запускает build_blueprint с диагностикой сбоев. Различает отсутствие предметов в инвентаре и позиционные/опорные ошибки (нет опоры, подпорка, путь не найден). Если нужный материал есть в инвентаре, но разместить не удалось из-за позиционных проблем, не возвращает `missing`, предотвращая бесконечный добор (`gather_list`), а возвращает архитектурную ошибку (`obstruction: true`).
Ограничения: Требует корректных координат x, y, z чертежа.

сделал: помощник (модель учителя google/gemini-3.5-flash-lite)
