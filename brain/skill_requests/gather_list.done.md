# gather_list: готово

Запуск: `curl.exe -s "http://127.0.0.1:3200/go?name=gather_list&items=cobblestone:24,spruce_planks:24"` (смета без сбора: `&dry=1`)

Params: `items` — список `"имя:кол-во,…"` или объект `{имя:n}`; `max_sec` — потолок времени, 600; `dry=1` — только план (ничего не собирает).

Что делает: понимает синонимы имён и пишет настоящие имена инвентаря. Синонимы: `stone`→`cobblestone`, `log`/`logs`/`wood`→брёвна (spruce/oak/birch, считаются вместе), `planks`→`spruce_planks` (если spruce досок нет, а oak/birch есть — берёт их), `coal_ore`/`ore`→`coal`, `iron_ore`/`iron`→`raw_iron`, `copper_ore`/`copper`→`raw_copper`, `gold_ore`/`gold`→`raw_gold`, `diamond_ore`→`diamond`, `cobble`→`cobblestone`. НЕДОСТИЖИМОЕ ИМЯ ПРОВЕРЯЕТСЯ ДО СБОРА: если предмета нет ни в рецептах, ни в сырье (и его нет в инвентаре) — мгновенный отказ (<1 с, ни одного collect) с `{ok:false, error:"не знаю, как получить X xN (похоже на …)", missing, unknown:[{item,count,have,suggest}], known, hint}`. В `missing`/`collected`/`plan` пишутся настоящие имена инвентаря (у брёвен — конкретный вид), плюс `renamed` ("stone→cobblestone"), чтобы повторный вызов был рабочим.
Успех: `{ok:true, have, missing:{}, collected:{cobblestone:24,…}, crafted:{spruce_planks:24}, have_items, renamed, sec}`. Провал: `{ok:false, error:"не добрал: <предмет> xN (причина)", missing, collected, crafted, errors[]}`. `dry=1`: `{ok:true, dry:true, need, have, missing, raw, crafts, plan}`.

Ограничения: не плавит (железо/медь/стекло — только `raw_*`; `iron_ingot`/`glass`/`charcoal` → отказ с подсказкой про `smelt_all`), не крафтит кровати/шерсть/деревянные инструменты (только список рецептов ниже), руды и брёвна собирает только по видимости (`collect`), дерево само делает топор, камень — сам. Группы: `log` — любые брёвна; если spruce не нашлись, берёт oak/birch и пишет их настоящие имена в `collected`. Проверено: `POST /check` ok, `node test/offline.js` → all OK (в т.ч. `gather_list: OK`).
