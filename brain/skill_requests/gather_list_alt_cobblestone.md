# gather_list_alt_cobblestone — от учителя

Что не так: autopilot запускает build_blueprint hut_west, не обеспечив устойчивый сбор cobblestone — gather_list и collect падают, когда нет инструмента (кирки), а ресурсы заканчиваются mid-build. Бот циклирует: build провалится → попытается собрать → collect упадет без кирки → gather_list провалится → build попытается снова. idle растет, прогресс stall.

Доказательства:
- events.log #1196: build_blueprint провалился — 2 из 245 клеток, cobblestone ×2 missing (02:33:36 UTC)
- events.log #1170, #1211: build_blueprint провалился ранее по той же причине cobblestone shortage (02:24:09, 02:22:13 UTC)
- runner.log runs 2–21: все gather_list провалились с ошибкой «не добрал: cobblestone/spruce_log — нужен инструмент для cobblestone: wooden_pickaxe / golden_pickaxe / stone_pickaxe; скрафтить не вышло»; 20 consecutive failures runId 2–21
- day_report день 43: idleMin 20, idleMaxMin 99, простой: 20 мин (самый длинный 99 мин), построено 67 блоков; partial false
- signals: build_blueprint провалился дважды подряд (signals entry от 02:33:36)

Кто решал: skill:gather_list (код) и autopilot (поведение — решение о старте build_blueprint)

Версия: — (ошибки повторяются через все runId runner.log 2–21, конкретной версии no-версии — проблема в collect body skill и отсутствии проверки инструмента вgather_list)

Что нужно: gather_list должен обеспечивать инструмент (крафт wooden_pickaxe из spruce_log/планок/палок) ПЕРЕД началом сбора каменья/гLOB-блоков, иначе собирать не должен — возвращать `{ok:false, error:"нужно обеспечить инструмент: wooden_pickaxe сначала (spruce_log → planks → stick → crafting_table)"}`; autopilot должен проверять минимальный уровень cobblestone (минимум 25–30 за один прогон gather_list) ПЕРЕД стартом build_blueprint hut_west и откладывать постройку с ошибкой «сначала собери cobblestone:25», а не падать mid-build; если инструмент есть, но ресурсов мало — писать plan с явным недогather, а не пытаться построить частично.

Вариант: «исправление: gather_list с обеспечением инструмента перед сбором» — новая версия gather_list, которая гарантирует: если в списке есть cobblestone/stone/coal и нет подходящей кирки, сначала крафт wooden_pickaxe (spruce_log → planks → stick → crafting_table → wooden_pickaxe), и только потом collect; или «новый вариант: gather_list_resources_guaranteed» — отдельный вариант навыка, который всегда гарантирует минимум N предметов дляKnown проектов (hut_west: cobblestone:25, spruce_log:9) или отказывается с четкой причиной («нужно N cobblestone для hut_west, собери сначала»); autopilot: проверка ресурсов перед build_blueprint.

Как проверить: запуск gather_list items="cobblestone:24" при пустой сумке и spruce_log рядом → ok:true, в ответе crafted есть spruce_planks и wooden_pickaxe, collected.cobblestone ≥ 20; при отсутствии брёвен рядом → отказ с причиной «нет брёвен — не можно сделать кирку», а не «нужен инструмент для cobblestone»; в runner.log нет повторяющихсяFail'ов с «нужен инструмент для cobblestone»; build_blueprint hut_west не должен падать mid-build, если gather_list ранее гарантировал достаточные ресурсы или вернул ошибку с рекомендацией собрать сначала; день 43: idle должен сократиться с 99 мин до <30 мин при правильной проверке ресурсов.

Случай: 20261023-123336-66.