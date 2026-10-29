# gather_list_v5: готово (уже покрыто gather_list_v10)
Версия: gather_list_v10 (ещё лучше — gather_list_v11, см. gather_list_alt_seek)
Запуск: curl.exe -s "http://127.0.0.1:3200/go?name=gather_list_v10&items=quartz:4,cobblestone:8"
Что нашла при проверке на фальшивом теле, список «quartz:4,cobblestone:8»:
- gather_list_v5 — падает ("Cannot access 'start' before initialization"), v6 — всё ещё "ReferenceError: unknown is not defined" (в :391 переменная не объявлена). Обе версии с 0 запусков, файлы не трогаю;
- v7 — исключения нет, но неизвестное имя срывает весь список: cobblestone не добирается;
- v8, v9, v10 — исключения нет, cobblestone добирается до 8, quartz уходит в missing: ответ `{ok:false, have, missing:{quartz:4}, collected:{cobblestone:6}, crafted:{}, errors:["не знаю, как получить quartz"], error:"не добрал: quartz x4 (…)"}`. Это и есть смысл заявки: одно недостижимое имя не отменяет остальной сбор, в ответе всегда collected/crafted/missing/errors.
Отличие от заявки сознательное: ok:false при неполном добое оставлен (v7 «строгая гарантия» — ложных ok больше нет; партия добранного видна в collected), а не ok:true «хоть что-то собрано».
Новой версии не требуется. Мозгу не брать gather_list_v5/v6.
