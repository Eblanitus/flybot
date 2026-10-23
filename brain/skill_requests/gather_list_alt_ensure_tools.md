# gather_list_alt_ensure_tools — от учителя
Что не так: gather_list пытается собрать cobblestone, но collect проваливается, когда нет инструмента. Бот не проверяет наличие инструмента перед сбором и не делает его автоматически. Из-за этого бот застревает в цикле explore→collect→fail→explore, не может добыть ресурсы для постройки hut_west, и простой накапливается. Текущая ошибка: wooden_pickaxe: не хватает: wo (нет дерева для крафта кирки).
Доказательства:
- signals #1, #14, #40: gather_list провалился: "не добрал: cobblestone x2 (cobblestone: навык тела 'collect' не удался: нужен инструмент для stone: wooden_pickaxe / golden_pickaxe / stone_pickaxe; скрафтить не вышло — wooden_pickaxe: не хватает: wo)"
- events.log #1755: autopilot: "добираю для постройки hut_west: cobblestone:2 (простой 63 мин)"
- events.log #1759: autopilot: "постройка hut_west: добор ничего не дал (cobblestone ×0, нужно cobblestone ×2) — смена тактики — повтор через 180 с"
- runnerTail: runId 23-30 подряд gather_list провалились с ошибкой отсутствия инструментов (все с error "не хватает: wo")
- eventsTail: multiple explore task_failed с reason "путь заблокирован" (направления запоминаются на 10 мин), создавая тупик
Кто решен: skill:gather_list, autopilot (collect), skill:collect
Версия: — (текущая версия gather_list провалилась многократно,см. runnerTail runId 4-30)
Что нужно: gather_list должен проверять наличие пригодного инструмента (деревянная/каменная кирка) в инвентаре ПЕРЕД началом сбора. Если инструмента нет — сначала выполнять автоматический крафт wooden_pickaxe (сначала добор wood, затем крафт), а потом уже собирать запрашиваемый ресурс. Если wooden_pickaxe craft fails из-за нехватки wood — делать priority-dobor wood first, then craft, then collect.
Вариант: 'исправление: gather_list с предварительной проверкой инструмента и автоматическим цепочком wood→craft_pickaxe→collect' — когда в инвентаре нет кирки, gather_list инициирует сбор древесины, затем крафт wooden_pickaxe, затем proceeds with requested collection (cobblestone/stone). Альтернативно: новая версия collect, которая гарантированно делает кирку перед запросом ресурсов.
Простой до: 70+ мин за сутки (progress_idle #1861, 03:43:23), самый длинный idleMin видится в day.today; построено за сутки: мало (gather_list блокирует прогресс hut_west)
Как проверить: после заявки при запуске gather_list для cobblestone/stone без кирки в инвентаре бот автоматически: 1) добору wood, 2) крафт wooden_pickaxe, 3) успешно добывает cobblestone без падений в runner.log — простой сокращается, built для hut_west растет.
Случай: 20261023-133622-71.