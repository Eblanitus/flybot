# gather_list_alt_resources: готово
Версия: gather_list_alt_resources
Запуск: curl.exe -s "http://127.0.0.1:3200/go?name=gather_list_alt_resources&items=cobblestone:50,spruce_fence:5"
Params: items — список предметов, max_sec — ограничение по времени, dry — только план.
Что делает: Добирает список предметов с исправлением синонимов (stone→cobblestone) в missing/collected/plan, ранней проверкой недостижимых предметов до сбора, подсказками по инструменту (нужна кирка wooden_pickaxe) и гарантией минимальных количеств.
Ограничения: Требует наличия инструментов для добычи камня/руды или материалов для их крафта.
