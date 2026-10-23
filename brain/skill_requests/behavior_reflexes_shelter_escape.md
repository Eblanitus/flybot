# behavior_reflexes_shelter_escape — от учителя

Что не так: Reflex начинает копать укрытие (shelter), но shelter завершается с ошибкой shelterErr: "не удалось поставить" финальный блок. После этого reflex немедленно переключается на escape, но варианты sprint_away/zigzag не уводят муху в безопасное место от скелетов, стреляющих в упор — гибнет от repeated hits по 2.5 dmg каждый тик, пока escape бежит.

Доказательства:
- blackbox death-20261023-023840.json: кадры 104-112 — shelter(reflex) task id=4, progress "копаю вниз 1/2 → 2/2", но shelterErr: "укрытие не до конца closed (не удалось поставить) позиции -258 115 -1"; кадры 115-122 — escape(reflex) task id=5 бежит sec=3,HP падает от zombie 2.5 каждый тік, última śmierť sec=3 pos [-257.9 108 30.9]
- events.log #1817-#1901: autopilot goto к hut_west (285 м) constantly прерянут reflex'ом — «моб сближается — рефлекс прерывает», « goto: прерван автопилотом», «вытеснен рефлексом». Итог: 0 блоков построено, простой 216 мин.
- events.log #1896 day_report: "построено 0 блоков, простой 20 мин (самый длинный 216 мин)", deaths 2.
- signals death: by "reflex", text "смерть: skeleton; задача escape (отдал reflex); хуже всего mobs 0 с".

Кто решал: reflex — все решения (shelter start/exit, escape start, goto abort) принимал reflex, нарушая стройку и не обеспечивая безопасность.

Версия: — (поведение, не навык).

Что нужно: Reflex должен по- иному вести себя при ситуации: shelter с ошибкой не считаться «завершенным», и escape должен выбирать варианты, уводящие в безопасное место от конкретной угрозы, а не случайный sprint_away/zigzag.

Вариант: "исправление reflex: sheltered-check before escape" — после shelter (даже с 2/2) проверять env.sheltered / isSheltered перед переключением на escape; если укрытие не закрыто (shelterErr), продолжать защиту или уходить к base с приоритетом, а не бежать в открытую. "новый вариант: escape с приоритетом utechei ot skeleta" — добавить новые варианты utechei, которые priorititet' ot typu moba: d < 10 m и skeleton → бежать к base/укрытию, а не zigzag/sprint_away в открытую.

Простой до: 20 мин за сутки (самый длинный 216 мин, день 13), построено 0 блоков; смертей за день 2.

Как проверить: в events.log после зayavki появляться строки "reflex: shelter — block placed N/M, error: ...", potom "reflex: [čekaj / utechei k base]" vmesto imeyatelnogo escape; v data/blackbox/ death-20261023-023840.json v poslednikh kadrah ne dolzhen byt' escape(reflex) Sec≥3 s HP, c nizkijём, pozhry vsekhod po skeleton dmg 2.5 každim tickom.

Случай: 20261023-023840-30.