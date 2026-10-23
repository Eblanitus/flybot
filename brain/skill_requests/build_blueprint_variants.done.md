# build_blueprint_variants: готово
Версия: build_blueprint_collect (новый навык)
Запуск: curl.exe -s "http://127.0.0.1:3200/go?name=build_blueprint_collect&blueprint=hut_west&x=0&y=64&z=0"
Params: 
- blueprint — имя чертежа (по умолчанию hut_west)
- x, y, z — северо-западный нижний угол постройки (обязательно)
- rot — поворот 0|90|180|270 (по умолчанию 0)
- radius — радиус сбора ресурсов, по умолчанию 48
- max_sec — лимит времени на всё, по умолчанию 1200
- dry — 1 = только план (dry build_blueprint + план сбора)
- pause_on_low_hp — 1 = при HP<12 и мобах рядом пауза (по умолчанию 1)
- min_hp — минимальный HP для продолжения, по умолчанию 12
- base_x, base_y, base_z — координаты базы для пополнения ресурсов (если сбор не удался)
Что делает: 
1. Делает dry-запуск body build_blueprint, узнаёт need/missing.
2. Если dry=1 — возвращает план стройки и план сбора.
3. Проверяет HP и угрозы (pause_on_low_hp).
4. Вызывает gather_list для сбора недостающих материалов (крафт + collect в радиусе 48).
5. Если не удалось собрать и заданы base_x/y/z — идёт к базе (go_safe) и пробует chest_take.
6. Запускает body build_blueprint.
При успехе: {ok:true, ...buildResult, collected:{...}}. При провале: {ok:false, error, missing, need, collected, paused:true}.
Ограничения: 
- Требует gather_list (есть) и body build_blueprint (есть).
- Сбор камня/руд требует кирку — gather_list умеет крафтить деревянную/каменную, но если нет дерева — не получится.
- Не умеет плавить руду (smelt) — для iron_ingot и др. нужен отдельный навык.
- Если ресурсы не собрать и нет базы — вернёт ok:false с missing и paused:true.