# behavior_reflexes_escape_skeleton — от учителя

Что не так: Reflex escape behavior triggered during skeleton attack but escape variants (sprint_away, zigzag) не создавали достаточно отдышки, чтобы избежать урона; муха продолжала активные задачи при HP < 10 и активном escape.

Доказательства:
- events.log #1316 (02:38:07): смерть — FlyBot_01 was shot by Skeleton; lastActions: ["escape(reflex) 58s ago","escape(reflex) 9s ago"]
- events.log #1306-1308 (02:37:58): reflex escape started, variant sprint_away, enemy 7.4m, HP 8, task_aborted gone
- events.log #1314 (02:38:07): escape task aborted due to death
- events.log #1294-1297 (02:37:09): zombie attack, escape succeeded initially (sprint_away 24.6m) but later escapes failed
- events.log #1290 (02:37:01): skeleton attack at d=8.3, HP 20

Кто решен: reflex — escape task given to reflex behavior

Версия: — (поведение)

Что нужно:
1. Reflex escape при атаке скелета должен предпочтительно применять variantes, создающие больший откид (sprint_away с ускорением, zigzag) и sooner transition к укрытию (pillar/dig), особенно когда HP < 10
2. Autopilot должен приостанавливать или reconsider задачи когда reflex escape активен и HP низкий, чтобы неExpose муху дополнительному урону

Вариант: "исправление escape: skeleton emergency" — при атаке скелета и HP < 10 приоритет использовать экстренные варианты укрытия (pillar/dig) вместо слабого прямого бега sprint_away

Простой до: 20 мин за сутки (самый длинный 99 мин) сутки 43, построено 67 блоков (day_report день 43); смертей 0 за день до смерти

Как проверить: в events.log при HP < 10 и атаке скелета рефлекс использует экстренное укрытие (pillar/dig) вместо sprint_away; смертей от стрел скелета при HP < 10 уменьшится

Случай: 20261023-123723-67.