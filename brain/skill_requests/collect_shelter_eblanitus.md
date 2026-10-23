# collect_shelter_eblanitus — от учителя
Что не так: Skill `collect` падает с ошибкой «не вижу dirt/stone/spruce_log (добыто 0/Х)» когда в инвентаре нет подходящего инструмента (нужен wooden_pickaxe/golden_pickaxe/stone_pickaxe), а skill `shelter` завершается ошибкой «нечем закрыть яму» когда материала нет для закрытия яды. Навыки не обеспечивают свои prerequisites (инструмент/материал) самi, а просто отказываются, оставляя муху беззащитной. Накопленные провалы collect/shelter случились в последние 1–3 минуты перед смертью, когда муха пыталась убежать от eblanitus228, не имеяTool/Material, и погибла от falling anvil пока escape(autopilot) был активен.

Доказательства:
- events.log #949 (02:04:09): task_failed collect — «не вижу dirt (добыто 0/10)» — autopilot
- events.log #961 (02:05:04): task_failed shelter — «нечем закрыть яму» — autopilot (3-я подряд неудача)
- events.log #975 (02:05:31): death — «FlyBot_01 was squashed by a falling anvil», lastActions: ["escape(autopilot) 22с назад","escape(reflex) 0с назад"] — autopilot
- events.log #880 (01:59:24): info — «убегаю от Eblanitus228 (убивал меня 2 р.) — в поле» — autopilot
- events.log #889 (01:59:44): info — «мало HP (7) — не вижу dirt (добыто 0/10) — исследуй (explore) или иди к другому месту» — autopilot
- runnerTail: runs 1–16 gather_list mostly failed due to collect skill missing tool for stone/cobblestone
- brain/learned/collect.js: тело skill collect не содержит логики обеспечения инструмента перед добычей

Кто решал: autopilot — задачи collect, shelter, escape отданы автопилоту; сборка и укрытие принимались autopilot'ом без обеспечения prerequisites

Версия: — (текущие версии collect и shelter не имеют обеспечения инструментом/материалом)

Что нужно: Skill `collect` должен проверять, нужен ли инструмент для добываемого блока (cobblestone, stone, coal_ore, iron_ore и др.) и, если инструмента нет, обеспечивать его: spruce_log (ломается голыми руками) → spruce_planks → stick → crafting_table → wooden_pickaxe, и только затем копать requested block. Если брёвен рядом нет или не хватает досок/палок — честный отказ с причиной «нет брёвен для крафта кирки», а не «нужен инструмент». Skill `shelter` должен проверять, есть ли материал для закрытия ямы, и обеспечивать его перед стартом. Если материал недоступен — Skill должен приостановиться с понятной причиной, а не оставлять муху беззащитной в опасной ситуации.

Вариант: «исправление collect_tool + shelter с проверкой материала» — новый вариант collect с обеспечением инструмента спереди (аналогично collect_tool.md) и новый вариант shelter, который проверяет наличие материалов перед построением. Подходит, когда требуется cobblestone/stone/а другие блоки, а кирки нет (после смерти, в новом мире или после долгого простоя), и когда материал для укрытия недоступен. отличается от обычного collect/shelter тем, что встроен шаг обеспечения prerequisites.

Простой до: 82 мин за сутки (event #899, events.log #899 — «простой 82 мин», день перед final death sequence); построено за сутки: 0 (перед смертью сбор выдавал 0 блоков, hut_west smena tactics дала 0 постройлено).

Как проверить: запуск collect с block="dirt" при пустой сумке и рядом брёвен → ok:true, в ответе crafted есть wooden_pickaxe (или crafting_table), collected.dirt > 0; при отсутствии брёвен рядом — отказ с причиной про брёвна (не «нужен инструмент»); запуск shelter с nearby материалом → ok:true, placed > 0; при отсутствии материала — отказ с причиной про материал (не «нечем закрыть яму»); в brain/runner.log нет ошибок «нужен инструмент для ...» и «нечем закрыть яму» после заявки.

Случай: 20261023-120409-63.