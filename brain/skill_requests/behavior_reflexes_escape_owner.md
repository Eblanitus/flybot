# behavior_reflexes_escape_owner — от учителя

Что не так:
1. Reflex escape behavior doesn't protect against owner eblanitus228 — 3+ prior deaths, each time escape variants (sprint_away, zigzag) fail to flee
2. Owner closed to 1.1 m at 06:20:01 killed fly while she was in shelter with 0 HP, standing still
3. Multiple escape attempts (events #212-279) all fled: false, moved < 25 m; variants don't prioritize owner avoidance

Доказательства:
- events.log #344 (06:20:01): danger enemy_player Eblanitus228 d:1.1 dir:"тут" why:"убивал меня 3 р."
- events.log #346 (06:20:02): reflex: "в укрытии, стою" hold: true, HP 0
- events.log #349 (06:20:02): death cause:eblanitus228; events.log #3: "FlyBot_01 was slain by Eblanitus228"
- events.log #267 (05:45:40): enemy_player Eblanitus228 d:4.9 approaching:false, autopilot "убегаю от Eblanitus228"
- events.log #212-279: 6 escape attempts, all fled: false, moved 2.4-22.3 m, variants: cave_escape, sprint_away, zigzag — none effective against owner
- day_report #327 (06:13:23): prosto 20 min, built 0, deaths 0, idleMaxMin 218

Кто решал: reflex — vse vyborki utechei ne preduprezhili smert ot igroka

Версия: — (povedenie, ne naвыk)

Что нужно:
Reflex dolzhen vyborku variant utechei, kotorye prioritetyzuyut bezopasnost' protiv igroka. SLEDUYUSHCHEY:
1. Novyy variant utechei: "sprint_away_away_from_player" ili "zigzag_away_from_player" — avatar ustupayet ot opredelenennogo igraka Eblanitus228, a ne sluuchainyy sprint_away
2. Reflex dolzhen davat' vozmozhnost' vybraniyu varianta na osnove 'by: player' v signals, a ne tol'ko na osnove typu moba (zombie/creeper)
3. Esli igrok blizko (d < 10 m) i HP nizkoy (<= 5) — reflex dolzhen vybirat variant s maksimal'nym dostypom k ukrytiu ili k base, a ne sluchaynyy sprint_away/zigzag

Variant: "ispravlenie reflex — dobavlenie owner-aware utechei" — odin variant s prioritetom utechey ot igroka s uchetom puti k ukrytiu/basе. "noviy variant: escape s izbeganiem igroka" — kogda igrok blizko, reflex vybira variant s utechey ot igroka s uchetom puti k ukrytiu/basе.

Простой до: 20 min za sudnoy (dnevno prosto 0 min, samyj dlinnyy 218 min dnya 54); built za sudnoy: 0 blokov. Prezhdayushchaya prosto po resumu: behavior_reflexes_escape_player — NE pomoglo (tam problema s generic mobom, a ne s owner-om).

Kak proverit': posle zayavki variant utechei s prioritetom igroka dolzhny appear' v events.log stroki 'reflex: utechei ot igroka (sprint_away/zigzag k ukrytiu/basе)' vmesto sluchaynogo sprint_away/zigzag bez uchetа igroka. V sluchae smerti ot igroka ne dolzhen byt' 'reason: smert' s takoy blizkoy razmeshchennostyu igroka'.

Sluchay: 20261023-162002-78.