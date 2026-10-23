# gather_list_alt_ensure_tools: готово
Версия: gather_list_alt_ensure_tools_v1 (базовая версия взята за модель gather_list_alt_tool_v2)
Запуск: curl.exe -s "http://127.0.0.1:3200/go?name=gather_list_alt_ensure_tools&items=cobblestone:2"
Params: items — список предметов для сбора (формат "имя:кол-во,…"); max_sec — ограничение времени (по умолчанию 600); dry=1 — только план (вернуть план без исполнения)
Что делает: Перед сбором проверяет, есть ли деревянная кирка wooden_pickaxe в инвентаре. Если инструмента нет — автоматически запускает цепочку: добор wood (spruce_log) → craft spruce_planks → craft stick → craft crafting_table → craft wooden_pickaxe, а затем proceeding with requested collection (cobblestone/stone). Если wood не хватает для крафта — делает priority-dobor wood first, then craft, then collect. Инструмент обеспечивается один раз и сохраняется в состоянии задачи. Возвращает {ok:true, collected, crafted: {wooden_pickaxe: 1}, sec} при успехе или {ok:false, error} при нехватке материалов.
Ограничения: Треет наличия деревьев/брёвен в радиусе досягаемости для крафта кирки. Честный отказ «нет древесины для крафта кирки», а не «нужен инструмент». Инструмент обеспечивается в начале задачи — при переключении task'ов состояние сохраняется.
сделал: помощник (модель учителя opencode/nemotron-3.5-lightning-free)
