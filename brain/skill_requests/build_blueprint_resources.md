# build_blueprint_resources — от учителя

Что не так: autopilot пытается построить hut_west, но build_blueprint проваливается с ошибкой «не хватило: cobblestone ×41». Навык collect не может добыть cobblestone, потому что для этого нужен инструмент (wooden_pickaxe / golden_pickaxe / stone_pickaxe), которого у мухи нет.Цикл повторяется: goto → рефлекс прерывает моб → escape → wait → build_blueprint → не хватает ресурсов → collect (провал из-за отсутствия инструмента) → repeat. В итоговом дне: 0 блоков построено, простой 20+ мин.

Доказательства:
- events.log #670: progress_idle min=30 — простой начался в 17:57:25
- events.log #679-703: build_blueprint task_started и task_failed с reason «не дострото: 52 из 245 клеток; ... не хватило: cobblestone ×41»
- events.log #706: task_started collect params{block:dirt, count:7} — collect стартует
- runner.log repeated errors: «не добрал: cobblestone x100 (cobblestone: навык тела "collect" не удался: нужен инструмент для cobblestone: wooden_pickaxe / golden_pickaxe / stone_pickaxe)»
- day_report (id 631): built=0, idleMin=20, idleMaxMin=28, warn «стройка за день не сдвинулась: 0 блоков построено»
- events.log #633-634: own_block_broken by autopilot/reflex — тело ломает свои блоки в панике

Кто решал: autopilot (все решения: goto, build_blueprint, collect, shelter — by: autopilot)

Версия: — (проблема в логике автопилота, не в версии навыка)

Что нужно (не код):
- autopilot должен проверять наличие требуемых ресурсов (cobblestone × N) ПРЯМО ПЕРЕД стартом build_blueprint
- Если ресурсов не хватает — autopilot должен инициать сбор: task collect с обязательным проверкой наличия инструмента (pickaxe) до запуска
- Или: build_blueprint должен сам добирать нужные блоки (cobblestone) через collect перед началом кладки, а не ждать, чтоcollect сделает это автономно
- Новый подход: «сначала собери ресурсы, потом строй» — autopilot отслеживает текущий инвентарь и гарантирует достаточный склад перед задачами по стройке

Вариант: «исправление: autopilot проверяет инвентарь и собирает ресурсы перед build_blueprint» — при любой обстановке, когда у мухи меньше требуемого количества блоков; новый вариант по сравнению с текущим поведением «пытаться построить и падать при нехватке».

Простой до: 20 мин (сейчас) / 28 мин (максимум за день 17); построено 0 блоков за сутки (days.log, День 17).

Как проверить: после заявки — build_blueprint не будет падать с ошибкой «не хватило: cobblestone ×...»; collect сможет добыть cobblestone, если есть инструмент; idleMin снизится; built в day_report вырастет > 0.

Случай: 20261023-035725-39.