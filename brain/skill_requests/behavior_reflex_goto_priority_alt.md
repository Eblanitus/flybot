# behavior_reflex_goto_priority_alt — от учителя (альтернатива поведению goto + reflex)

Что не так: reflex всё ещё прерывает задачи goto когда поблизости мобы, даже когда муха идет к Known destination (постройка/база). Бот Wanders far from base, ночь падает, муха погибает. В текущем кейсе reflex прерывал goto к hut_west (195 мин простой), бот не достроил 0 блоков и погиб от игрока, пытаясь убежать от мобов.

Доказательства:
- events.log #1755 (16:14:43) task_aborted goto by reflex — "моб zombie сближается"
- events.log #1790-1794 (16:18:14-16:18:18) own_block_broken by autopilot, reflex escape cycle before death
- day_report #1763 (16:15:37): 0 блоков построено, idle 20 мин, самый длинный 196 мин, skills ok 3/провал 0
- death events.log #1801: lastActions "shelter(autopilot) 3s ago, escape(reflex) 1s ago"
- behavior_reflex_goto_priority.md (случай 20261023-021305-27) — проблема не устранена, reflex всё ещё прерывает goto

Кто решал: reflex — задачи source:"autopilot" goto прерывал source:"reflex" escape

Версия: — (рефлекс встроенное поведение, не навык)

Что нужно (не код): рефлекс не должен прерывать задачи goto, когда муха движется к Known destination (постройка или база). Задача goto должна иметь приоритет над reflex/escape при движении к Known destination, особенно когда бот далек от базы и ночь близка. Рефлекс должен позволять движению продолжаться, если цель достижима, а не прерывать её ради одиночного сближающегося моба.

Вариант: «новый вариант: приоритет goto над reflex при пути к базе» — когда муха идет к known destination (постройка/база), reflex/escape не прерывает задачу, если моб находится ближе 12 м, но бот движется к safety/базе. Отличие от behavior_reflex_goto_priority: здесь прописывается явный флаг приоритета для goto задач, а не общая защита.

Простой до: 195 мин (самый длинный) за сутки, idleBuildMin не зафиксирован; построено за сутки: 0 блоков; сверка прошлых заявок: behavior_reflex_goto_priority.md — НЕ помогло (проблема persists), behavior_reflex_goto_priority_alt.md — новая заявка.

Как проверить: после заявки GET :3199/behavior → активна версия с правкой; в events.log отсутствуют подряд идущие task_aborted goto source:"reflex" при движении к known destination (hut_west/base); в data/blackbox/near-*.json нет 20+ кадров подряд без смены задачи при движении к базе/постройке; муха успешно доходит до hut_west без прерывания от reflex при сближающихся мобах; простой снижается ниже 60 мин при том же графе{mobs}.

Случай: 20261023-021819-28.