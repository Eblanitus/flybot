# build_blueprint_occupancy — от учителя

Что не так: 1) build_blueprint пытается поставить cobblestone, но crafting_table уже occupies слот, causing placement failure и idle 260+ min. 2) Shelter variant "smart" не закрывается полностью, оставляя открытия, из-за чего escape reflex ломается ("не на чем стоять"). 3) Bot остается Exposes outdoors из-за цепочкиfailures.

Доказательства: events.log #377 (build_blueprint failed: "141 из 245 клеток; занято чужим/неломаемым: crafting_table"), #388 (same), #410, #426, #450. Shelter failures #380-394, #408-410, #430-432, #453-459. Death blackbox #475. days.log: простой 260 мин.

Кто решал: autopilot.

Версия: — (первый раз анализируется).

Что нужно: autopilot/build_blueprint должен проверять, свободна ли целевая клетка перед placement — если блок занят (crafting_table, другой блок), пропускать или выбирать другую позицию. В shelter variant "smart" добавить проверку валидности опоры перед закрытием — если вокруг пустота, не начинать закрытие или выбрать другой variant.

Вариант: "исправление: автопилот проверяет занятость блоков перед placement" — когда build_blueprint встречает "занято чужим/неломаемым", пропускает клетку и ищет альтернативу.

Простой до: 260 мин (дни 2026-10-22, сбор cobblestone); построено за сутки: 0 (build стаял).

Как проверить: после fix — build_blueprint должен ставить блоки без блокировки crafting_table; shelter variant "smart" должен закрываться полностью или выбирать другой variant при пустоте вокруг; idle_min должен упасть с 260 до <30 мин; built за сутки должен вырасти.

Случай: 20261023-032828-35.