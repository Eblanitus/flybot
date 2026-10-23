# behavior_reflex_goto_priority_alt: готово

Версия: поведение (не навык), новая версия behavior рядом со старыми. За основу взята текущая версия behavior/.

Запуск: это правка поведения, включается без перезапуска тела:
`curl.exe -s -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3199/behavior/reload`
(состояние: `curl.exe -s http://127.0.0.1:3199/behavior`).

Проверено: `node test/behavior.js` — ОК.

Что изменено (только `behavior/autopilot.js`, `behavior/reflexes.js`, `behavior/test.js`):
1. В `behavior/autopilot.js` для задач `go_base` (goto / go_safe) и `build_go` добавлен явный флаг приоритета `{ priority: true }` в параметры задач goto при движении к базе или постройке (Known destination).
2. В `behavior/reflexes.js` в проактивной защите (проверка сближающихся мобов каждые 2 с) добавлена проверка: если текущая задача имеет `cur0.params && cur0.params.priority`, рефлекс её не прерывает (`return;`), позволяя мухе успешно дойти до базы или постройки несмотря на приближающихся мобов.
3. В `behavior/test.js` добавлены тесты на проверку флага `priority: true` в автопилоте для `go_base` и `build_go`.

Что делает: задачи goto к Known destination (база / постройка) теперь имеют приоритет над проактивным бегством рефлекса от одиночных сближающихся мобов, предотвращая циклические прерывания (`task_aborted goto by reflex`) и зависания в пути.
