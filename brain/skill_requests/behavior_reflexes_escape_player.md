# behavior_reflexes_escape_player — от учителя

Что не так: Reflex 5 раз подрядtriggered escape за 60 сек перед смертью, но варианты utechei (sprint_away, zigzag) ne soderzhali strategii izbeganiya igroka — muha ne ustupala ot igraka Eblanitus228, kotoryy bil na HP 2 v 7 min pered smerti. Reflex teku uchih, no ne teku utechei, kotorye mogu privesti v bezopasnoe mesto.

Доказательства:
- events.log #1833 (16:24:31) task_done escape reflex — variant zigzag, why "лучший 6/7 (creeper|high)"
- events.log #1835 (16:24:35) task_started escape reflex — smert blizka
- events.log #1837 (16:24:44) task_done escape reflex — variant sprint_away, why "лучший 11/17 (*)"
- events.log #1841 (16:24:46) task_started escape reflex — "смерть"
- events.log #1857 (16:25:09) task_aborted escape reflex — reason "смерть"
- events.log #1791 (16:18:18) danger attacked by Eblanitus228 — hp 2, d:3.6, hits:1
- day_report #1763 (16:15:37) — prosto 20 min, built 0 blokov, idleMaxMin 196 min
- signals death: by "reflex"; text "smerть: eblanitus228; zadacha escape (otadel reflex); huwseg tutto mobs 0 s"

Кто решал: reflex — vse rableniya po utecheyu ne preduprezhili smert ot igroka.

Версия: — (povedenie, ne naвыk).

Что нужно (ne kod): Reflex dolzhen vyborku variant utechei, kotorye prioritetyzuyut bezopasnost' protiv igroka. SLEDUYUSHCHEY:
1. Novyy variant utechei: "sprint_away_away_from_player" ili "zigzag_away_from_player" — avatar ustupayet ot opredelenennogo igraka, a ne sluychainyy sprint_away
2. Reflex dolzhen davat' vozmozhnost' vybraniyu varianta na osnove 'by: player' v signals, a ne tol'ko na osnove typu moba (zombie/creeper)
3. Esli igrok blizko (d < 10 m) i HP nizkoy (<= 5) — reflex dolzhen vybirat variant s maksimal'nym dostypom k ukrytiu ili k base, a ne sluchaynyy sprint_away/zigzag

Varianta: "ispravlenie reflex" — odin variant s prioritetom utechei ot igroka. "noviy variant: escape s izbeganiem igroka" — kogda igrok blizko, reflex vybira variant s utechey ot igroka s uchetom puti k ukrytiu/basе.

Prosto do: 0 min za sudnoy (dnevno prosto 0 min, samyj dlinnyy 196 min dnya 12); built za sudnoy: 0 blokov. Prezhdayushchaya prosto po resumu: behavior_reflexes_mob_near — NE pomoglo (tam problema s ukrytiem protiv zomiba, a ne igroka); behavior_reflex_goto_priority — NE pomoglo (tam problema s interrupsi goto, a ne s utechey igroka).

Kak proverit': posle zayavki variant utechei s prioritetom igroka dolzhny appear' v events.log stroki 'reflex: utechei ot igroka (sprint_away/zigzag k ukrytiu/basе)' vmesto sluchaynogo sprint_away/zigzag bez uchetа igroka. V data/blackbox/ death-20261023-022509.json v poslednikh kadrah ne dolzhno byt' 'reason: smert' ot utechei, kotoryy ne izbegal ot igroka.

Sluchay: 20261023-022509-29.