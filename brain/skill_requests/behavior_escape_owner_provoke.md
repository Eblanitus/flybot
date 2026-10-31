# behavior_escape_owner_provoke — от учителя (наказание хозяина)

Что не так: под угрозой (мобы в 3–10 м, владелец бьёт) муха стоит без дела (task=null ~70 с), потом убегает, но не оторвалась (fled=false), и ломает свои блоки (own_block_broken, placedBy reflex/autopilot) — владелец уже убил её 5 р. («убивал меня 5 р.»). Побег не работает: cover_escape не ставит укрытие («не удалось поставить», «нечем закрыть яму»), cave_escape не оторвал (away=false).

Доказательства:
- [blackbox near-20261023-223108] 12:30:57–12:31:08: pos [-417.1,36,26.7], task=null, мобы creeper/skeleton/witch, ttd до 3 с — почти-смерть, выжила.
- [events.log #102-#108] владелец убил 5 р., escape от autopilot: fled=false, moved 2.1 м, shelterErr «нечем закрыть яму».
- [events.log #105] own_block_broken diorite [-417,38,26] placedBy reflex; [#123] own_block_broken cobblestone [-417,33,28] by autopilot, placedBy reflex.
- [events.log #116-#120] attacked by Eblanitus228 d=2.4 м, hp 20; reflex escape cover_escape 0/3, укрытие не поставилось (-417 34 27: не удалось поставить).
- [events.log #121-#128] escape cave_escape moved 14.5 м, away=false (враг 10.3 → 12.2 м).
- [events.log #86] день 68: построено 0, простой 20 мин, макс 48; [snapshot] день 69: построено 0, макс 53.

Кто решал: autopilot (задачи escape #103, #122; own_block_broken #123), reflex (escape #119, свои блоки #105).

Версия: — (поведение reflexes/autopilot, не навык). Предыдущая заявка behavior_escape_owner_priority.done.md не дала эффекта: простой не сократился (было до 180 мин дня 12, сейчас день 68: 20/48, день 69: 53; built 0).

Что нужно:
1. Не стоять без дела при мобах ближе 10 м — начинать укрытие/бегство сразу, а не ждать.
2. Не ломать свои блоки (own_block_broken) под угрозой и при бегстве — это провоцирует наказание хозяина.
3. Бегство от игрока/хозяина должно оторвать: вариант к базе/укрытию с учётом позиции игрока, а не случайный sprint_away/zigzag.
4. Если укрытие не поставить — не повторять cover_escape, а другой вариант (драться тем, что в руке, или отход к базе).

Вариант: «исправление поведения (reflexes/autopilot)» — приоритет бегства от владельца и запрет ломки своих блоков под угрозой; «новый вариант: escape_player к базе/укрытию с учётом игрока» — когда укрытие не ставится.

Простой до: день 68 — 20 мин (макс 48), построено 0; день 69 — макс 53, построено 0 (snapshot).

Как проверить: после правки при мобах <10 м — task_started escape/shelter, а не стоянка; own_block_broken с placedBy reflex/autopilot под угрозой — 0; escape от Eblanitus228 — fled=true / away=true; простой меньше, построено больше.

Случай: 20261023-223108-102.
