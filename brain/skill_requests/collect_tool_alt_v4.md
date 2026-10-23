# collect_tool_alt_v4 — новый вариант skill collect с обеспечением инструмента спереди (адаптирован под fail случай: prolonged probe + hut_west build block)

Что не так: skill `collect` падает с ошибкой «нужен инструмент для cobblestone/stone: wooden_pickaxe», когда в инвентаре нет деревянной кирки, из-за чего build_blueprint стоит, муха простойт extremel long — зацикливается между explore и collect. В отличие от обычного collect, здесь критически важно обеспечение инструмента спереди при долгом простоя и попытках восстановления прогресса.

Доказательства:
- signals: collect провалился дважды подряд: не вижу log (добыто 0/6) — исследуй или иди к другому месту
- events.log #519, #536, #546, #591-#592, #602-#603: task collect failed — «не вижу log/stone/spruce_log (добыто 0/6/1) — исследуй или иди к другому месту»
- events.log #547-548, #603: «постroyka hut_west: добор ничего не дал (cobblestone ×0, spruce_log ×0) — смена тактики — повтор через 180 с»
- runnerTail: multiple gather_list runs failed (run 38, 40, 43, 60+) с error «не добрал: cobblestone x1, spruce_log x1 (cobblestone: навык тела "collect" ne udalos: nuzhen instrument dlya stone: wooden_pickaxe / golden_pickaxe / stone_pickaxe; скрафтить не вышло»»
- brain/notes hut_west goal at -403 67 33, дверь на запад — ресурсы never delivered из-за отсутствия инструмента

Кто решал: skill:collect (тело) — падает без инструмента; autopilot — задал задачи collect для ресурсов hut_west; reflex — прерывал collect explore из-за блокированных путей.

Версия: — (текущая версия collect не имеет обеспечения инструмента). Новый вариант: collect_tool_alt_v4 (skill collect с обеспечением инструмента спереди, адаптирован под fail случай: prolonged probe + hut_west build block). отличается от collect_tool: адаптирован под сценарий prolonged fail с repeated probe 순회 и block hut_west, в то время как collect_tool — общий случай обеспечения инструмента после смерти/нового мира. отличия от collect_near: не адаптирован под mob pressure, а под Resource starvation при prolonged probe.

Чему нужно (не код):
- skill `collect` (вариант collect_tool_alt_v4) должен проверять, нужен ли инструмент для добываемого блока (cobblestone, stone, coal_ore и др.)
- если инструмента нет — skill должен сначала обеспечивать инструмент: spruce_log (ломается голыми руками) → spruce_planks → stick → crafting_table → wooden_pickaxe, и только entonces копать requested block
- если брёвен рядом нет или не хватает досок/палок — честный отказ с причиной «нет брёвен для крафта кирки», а не «нужен инструмент»
- в ответе должен быть видно, что инструмент был сделан (crafted: wooden_pickaxe) и сколько блоко собрано (collected.cobblestone / collected.stone)
- обеспечение инструмента не должно заканчиваться по причине «сначала нужен инструмент» — этот шаг встроен в сам skill, а не возвращается как ошибка
- сбор должен успехивать и при пустой сумке, если инструмент можно craftIFY из nearby ресурсов
- при провале collect skill должен пытаться обеспечить инструмент повторно, а не просто отказываться и переходить к explore

Вариант: новый вариант `collect_tool_alt_v4` — skill collect с обеспечением инструмента спереди, адаптирован под fail случай: prolonged probe + hut_west build block. Подходит, когда требуются cobblestone/stone/coal для постройки и история mehrfach probefailure. отличается от обычного collect (нет шага «инструмент», он встроен спереди) и от collect_tool (адаптирован под prolonged fail сценарий с repeated probe attempts и block of build_blueprint hut_west) и от collect_near (адаптирован под mob pressure и near-смерть, в то время как этот — под ресурсный голод при prolonged probe).

Простой до: 62 мин (самый длинный idleMin за сутки, events.log #102 t=01:39:53); построено за сутки: 0 (hut_west не достроен из-за отсутствия ресурсов); progress_idle 60 мин (events.log #566).

Как проверить: запуск collect с block="cobblestone" при пустой сумке и рядом spruce_log → ok:true, в ответе crafted есть wooden_pickaxe, collected.cobblestone > 0; при отсутствии брёвен рядом — отказ с причиной про брёвна (не «нужен инструмент»); в brain/runner.log нет ошибок «нужен инструмент для cobblestone» после внедрения варианта; после collection в сумке растёт количество cobblestone; build_blueprint hut_west перестает падать с «не хватает cobblestone/spruce_log» при условии что инструмент обеспечен.

Случай: 20261023-114107-60.