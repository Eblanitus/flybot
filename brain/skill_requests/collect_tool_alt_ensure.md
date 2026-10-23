# collect_tool_alt_ensure — от учителя (вариант обеспечения инструмента collect)

Что не так (новый вариант collect_tool): skill `collect` по-прежнему падает с ошибкой «нужен инструмент для cobblestone: wooden_pickaxe», когда в инвентаре нет деревянной кирки, даже если ранее запрашивалась версия collect_tool. Bot зацикливается между gather_list и build_blueprint, ресурсы не собираются, bot попадает в уязвимое состояние (low HP, нет укрытия) и умирает. Смерть 20261023-115946-62: бот погиб от игрока Eblanitus228 после 80 мин progressive idle из-за неудач в добыче cobblestone/spruce_log — collect не обеспечивал инструмент, gather_list не блокировал следующие шаги.

Доказательства:
- events.log #806: gather_list провал — не добрал: cobblestone x1, spruce_log x1 (collect skill tool failure)
- runner.log #3718: gather_list ok:false sec 50.8 error «не добрал: cobblestone x1 (cobblestone: навык тела "collect" не удался: не вижу stone (добыто 0/1)»
- events.log #795-806: 7 consecutive collect failures for stone, then spruce_log — каждый раз «не вижу... нужен инструмент»
- events.log #837: progress_idle min: 80 — 80 мин progressive idle перед смертью
- signals death: reflex обработывал escape, но бот умер из-за уязвимого состояния от resource starvation
- Смерть предшествовала 2 атакам Eblanitus228 (записи #882-885) — bot не мог сбежать из-за отсутствия инструментов и low HP

Кто решил: skill:collect (тело), autopilot (инициатор задач), reflex (последняя попытка escape перед смертью)

Версия: — (текущая версия collect без ensure_tool; collect_tool.md существует но apparently не применялся или не sufficient для этого случая). Новый вариант: collect_tool_ensure — skill collect с гарантированным обеспечением инструмента спереди. отличается от collect_tool.md тем, что: (1) добавляет жесткий чек «нет инструмента — крафт Tools — только потом копать», (2) ensure_tool не отменяется при следующей задаче, (3) gather_list блокирует build_blueprint до тех пор пока ресурсы в inventory verified.

Что нужно (не код):
- skill `collect` должен проверять, нужен ли инструмент для добываемого блока (cobblestone, stone, coal_ore, и др.)
- если инструмента нет — skill должен последовательно обеспечивать: spruce_log → spruce_planks → stick → crafting_table → wooden_pickaxe, и только затем копать requested block
- ensure_tool шаг должен сохраняться в состоянии задачи до её completion, не сбрасываться при переключении task'ов
- если брёвен рядом нет — честный отказ с причиной «нет брёвен для крафта кирки», а не «нужен инструмент»
- в ответе должен быть видно: crafted wooden_pickaxe и collected.block > 0
- gather_list должен блокировать build_blueprint до тех пор, пока cobblestone/spruce_log количества sufficient в inventory build_blueprint'a

Вариант: 'исправление collect_tool_ensure' — когда skill collect гарантированно обеспечивает инструмент перед добычей, а gather_list координирует сбор с проверкой inventory перед build. Подходит для случаев после смерти, в новом мире или после долгого простоя, когда у бота нет инструментов. отличается от collect_tool.md (там ensureTool сбрысывается между task'ами) и от обычного collect (у ensureTool есть встроенный крафт цепочки).

Простой до: 80 мин (progress_idle #837 при 01:57:55; death через 2 мин позже); построено за сутки: hut_west в стадии, cobblestone ×0/1, spruce_log ×2/1 (недостающие ресурсы блокируют завершение)

Как проверить: запуск collect с block="cobblestone" при пустой сумке и рядом брёвен → ok:true, в ответе crafted есть wooden_pickaxe, collected.cobblestone > 0; при отсутствии брёвен рядом — отказ с причиной про брёвна (не «нужен инструмент»); runner.log не должен содержать ошибок «нужен инструмент для cobblestone» после collect; gather_list перед build_blueprint должен иметь verified cobblestone/spruce_log в inventory; смерть предотвращалась бы если ensure_tool работал гарантированно

Случай: 20261023-115946-62.

## ПОВТОР от хозяина (2026-10-23 19:43)
Прошлый ответ (collect_tool_alt_ensure.done.md): collect_tool_alt_ensure: не готово. Хозяин отдаёт заявку ещё раз.
