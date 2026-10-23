# reflex_mob_interrupt: готово
Версия: behavior (reflexes.js, thresholds.js)
Запуск: curl.exe -s -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3199/behavior/reload
Params: reflexInterruptDist=6, creeperInterruptDist=8, buildInterruptDist=3
Что делает: Добавлен порог близости для проактивных рефлексов защиты (6м для мобов, 8м для криперов) и защищенные задачи (collect, gather_list, craft, build_blueprint, goto к постройке), предотвращая избыточное прерывание автопилота и стройки на безопасном расстоянии. При успехе возвращает ok:true после перезагрузки поведения.
Ограничения: Мобы ближе порога или нападающие напрямую продолжают вызывать защитные рефлексы.
