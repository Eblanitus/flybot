# collect_tool — новый вариант skill collect с обеспечением инструмента спереди

Что не так (старый collect): skill `collect` пытается копать cobblestone/stone, но падает с ошибкой «нужен инструмент для cobblestone: wooden_pickaxe», когда в инвентаре нет деревянной кирки. Навык не обеспечивает инструмент сам, а просто отказывается, из-за чего build_blueprint стоит и муха простойт.

Доказательства:
- events.log #1398-1412: task collectStarted/Done x3, каждый раз «навык тела 'collect' не удается: нужен инструмент для cobblestone: wooden_pickaxe».
- runner.log #29: run_end gather_list ok:false sec 44.6 error «не добрал: cobblestone x66 (cobblestone: навык тела 'collect' не удается: заменён навыком escape)».
- runner.log #28: run_end gather_list ok:false sec 313.1 error «не добрал: cobblestone x100 (cobblestone: навык тела 'collect' не удается: нужен инструмент для cobblestone: wooden_pickaxe)».
- brain/learned/collect.js: тело skill collect не содержит логики обеспечения инструмента перед добычей.

Кто решил: skill:collect (тело) — падает без инструмента; autopilot — выбирал cobblestone для build_blueprint; reflex — прерывал collect escape из-за мобов.

Версия: — (текущая версия collect не имеет инструментообеспечения). Новый вариант: collect_tool (та же цель — копать блоки, но с обеспечением инструмента спереди). Подходит, когда требуется cobblestone/stone/coal, а кирки нет (после смерти, в новом мире или после долгого простоя). отличается от обычного collect (нет шага «инструмент») и от gather_list_alt_tool_v1 (там TypeError, а здесь — рабочая цепочка инструментов).

Что нужно (не код):
- skill `collect` должен проверять, нужен ли инструмент для добываемого блока (cobblestone, stone, coal_ore, iron_ore и др.)
- если инструмента нет — skill должен сначала обеспечивать инструмент: spruce_log (ломается голыми руками) → spruce_planks → stick → crafting_table → wooden_pickaxe, и только entonces копать requested block
- если брёвен рядом нет или не хватает досок/палок — честный отказ с причиной «нет брёвен для крафта кирки», а не «нужен инструмент»
- в ответе должен быть видно, что инструмент был сделан (crafted: wooden_pickaxe) и сколько блоко собрано (collected.cobblestone / collected.stone)
- обеспечение инструмента не должно заканчиваться по причине «сначала нужен инструмент» — этот шаг встроен в сам skill
- если список можно выполнить без инструмента (только доски/брёвна, которые не нуждаются в кирке) — старая логика без инструмента работает

Вариант: новый навык `collect_tool` — skill collect с обеспечением инструмента спереди. Подходит, когда требуется cobblestone/stone/coal, а кирки нет (после смерти, в новом мире или после долгого простоя). отличается от обычного collect (нет шага «инструмент») и от gather_list_alt_tool_v1 (там TypeError, а здесь — рабочая цепочка инструментов).

Простой до: 20 мин за сутки (до этого случая), самый длинный 156 мин (день 10, events.log #1403); построено за сутки: 0 (пrior to fix).

Как проверить: запуск collect с block="cobblestone" при пустой сумке и рядом брёвен → ok:true, в ответе crafted есть wooden_pickaxe, collected.cobblestone > 0; при отсутствии брёвен рядом — отказ с причиной про брёвна (не «нужен инструмент»); в brain/runner.log нет ошибок «нужен инструмент для cobblestone» и «targets is not iterable»; послеcollection в сумке растёт количество cobblestone.

Случай: 20261022-215030-1 (текущий) — муха зацикливается между gather_list и build_blueprint из-за отсутствия инструмента дляcollect.