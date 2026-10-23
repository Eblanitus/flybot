# behavior_escape_owner_priority — от учителя

Что не так: Reflex escape constantly triggered by owner Eblanitus228 (3+ rounds), но варианты utechei (sprint_away, zigzag) ne soderzhali strategii izbeganiya igroka s uchetom puti k ukrytiu/basе. Reflex teku uchih, no ne utechei, kotorye mogut privesti v bezopasnoe mesto. Autopilot перебивал reflex escape kommandami bezopasnosti "убегаю от Eblanitus228", delayayuci utekh i vydavaя muhu na exposed pozitsiyakh, gde umevala umeret' ot fallingu stalaktita.

Доказательства:
- [events.log #213] Escape task_started autopilot 05:38:13, immediately interrupted by safety: "безопасность: убегаю от Eblanitus228 (убивал меня 3 р.) — в поле"
- [events.log #211] gather_list skill aborted by autopilot safety at 05:38:13 — "gather_list: прерван автопилотом"
- [events.log #135] Reflex escape triggered at 05:35:41, but autopilot constantly overriding with safety checks
- [events.log #119] Collect spruce_log failed at 05:35:04: "не вижу spruce_log (добыто 0/11)" — autopilot
- [blackbox death-20261023-153817.json] First death: "падение; задача escape (отдал autopilot)" at 05:35:32
- [events.log #109] Danger: enemy_player Eblanitus228 at 8.4m, approaching, at 05:34:49 — owner began attacking
- [events.log #150] Escape reflex task_done with variant "cave_escape", result: "fled: true, moved: 0, why: пробую новый" — but then immediately aborted
- [events.log #183] Escape autopilot task_done with variant "cover_escape", shelter: true, but hp: 12, shelter not fully closed

Кто решал: reflex — varianty utechei ne privodyali k bezopasnosti protiv igroka; autopilot interferil s kommandami bezopasnosti.

Версия: — (povedenie, ne naвыk).

Что нужно: Reflex dolzhen vybirat varianty utechei s priorititetom utechey ot igroka i vyborki puti k ukrytiu ili k base. SLEDUYUSHCHEY:

1. Novyy variant utechei: "sprint_away_away_from_player" — avatar ustupayet ot opredelenennogo igraka Eblanitus228 po direkture, a ne sluychainyy sprint_away
2. Novyy variant utechei: "zigzag_away_from_player" — avatar ustupayet ot igroka po zigzag-puti k ukrytiu/basе, dostoinyiy igroka
3. Esli igrok blizko (d < 10 m) i HP nizkoy (<= 5) — reflex dolzhen vybirat variant s maksimal'nym dostypom k ukrytii ili k base (-393 67 36), a ne sluchaynyy sprint_away/zigzag
4. Reflex dolzhen uchetivat' pozitsiyu igroka iz signals, a ne tol'ko tipa danger (moba)

Varianta: "ispravlenie reflex s uchetom igroka" — odin novyy variant utechei s prioritetom utechei ot igroka. "noviy variant: escape s izbeganiem igroka i uchetyem puti k ukrytiu" — kogda igrok blizko, reflex vybira variant s utechey ot igroka s uchetom puti k ukrytiu/basе.

Prosto do: 0 min za sudnoy (dnevno prosto 0 min, samyj dlinnyy 180 min dnya 12); built za sudnoy: 0 blokov.

Kak proverit': posle zayavki varianty utechei s prioritetom igroka dolzhny appear' v events.log stroki 'reflex: utechei ot igroka (sprint_away/zigzag k ukrytiu/basе)' vmesto sluchaynogo sprint_away/zigzag bez uchetа igroka. V poslednikh kadrah death ne dolzhno byt' s reason 'smert' ot utechei, kotoryy ne izbegal ot igroka.

Sluchay: 20261023-153532-77.

## ПОВТОР от хозяина (2026-10-23 19:43)
Прошлый ответ (behavior_escape_owner_priority.done.md): behavior_escape_owner_priority: не готово. Хозяин отдаёт заявку ещё раз.
