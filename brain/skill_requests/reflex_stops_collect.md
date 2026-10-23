# reflex_stops_collect — от учителя
Что не так: reflex (escape) behavior intercepts the collect skill during gather_list, preventing cobblestone collection and causing prolonged idle.
Доказательства: signal near #1381 (by:reflex, задача escape); fail gather_list runner.log #3534 (by:skill:gather_list, error: collect заменён навыком escape); events.log #1325-1412 show collect repeatedly aborted by reflex; day_report idle 156 min, built 0.
Кто решил: reflex — escape behavior overrode collect skill.
Версия: — (first encounter of this specific interrupt pattern).
Что нужно: муха должна продолжать collect до завершения, не давая reflex перехватывать задачу при добыче ресурсов; приоритет collect над escape при скрафте/сборе.
Вариант: исправление comportamiento reflex collect-совместимости или новый вариант: gather_list с защитой от reflex-interrupt.
Простой до: 20 мин (текущий день), самый длинный 156 мин (days.log); построено 0 блоков за сутки.
Как проверить: если collect завершается без прерывания reflex — cobblestone добывается; если reflex прерывает — collect падает с ошибкой "заменён навыком escape".
Случай: 20261023-013843-24.