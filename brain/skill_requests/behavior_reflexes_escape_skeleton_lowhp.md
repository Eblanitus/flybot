# behavior_reflexes_escape_skeleton_lowhp — от учителя

Что не так: при атаке скелета на низком HP рефлекс выбрал вариант escape_to_base, который не оторвался (fled=false, away=false), муха стояла на месте ~14 с под стрелами и умерла. escape_to_base для skeleton|low имеет 0/3 успехов (avg 0.07) — худший вариант; sprint_away для skeleton даёт 0.56.

Доказательства:
- events.log #496 (09:12:21): task_started escape(reflex); #498 (09:12:40): escape done {fled:false, moved:15.1, variant:"escape_to_base", away:false, sheltered:false, hp:2}; #499 (09:12:54): attacked hp=2 d=11.3; #505 (09:12:55): death «shot by Skeleton», deaths 21.
- blackbox death-20261023-191254.json: кадры t≈…741944–…757522 (escape sec 0–15) — позиция почти не меняется (-471.7,-1.6,-2.3), HP 10→1.5 подряд; после task_done кадры …760862–…774650 — муха стоит на (-461.5,-2,-13.5) 14 с, скелет сокращает 20→11.3 м, fight(reflex) стартует уже на смерть (#501).
- GET :3199/variants?family=escape: escape_to_base skeleton n=5 ok=1 avg=0.18; skeleton|low n=3 ok=0 avg=0.07; sprint_away skeleton n=5 ok=3 avg=0.56.
- behavior_reflexes_shelter_escape.done.md ввёл escape_to_base для скелета <10 м в combat.js chooseVariant — именно он и выбрался.

Кто решал: reflex (chooseVariant в behavior/combat.js) — выбор escape_to_base при skeleton и HP 10.

Версия: — (поведение).

Что нужно:
1. Не выбирать escape_to_base для скелета/стрелка, когда HP < 10 или муха underground: предпочтение cover_escape / sprint_away (лучший счёт по каталогу).
2. Если escape завершился fled=false/away=false и враг ещё в радиусе — немедленно повторить escape другим вариантом или shelter, а не стоять без дела.

Вариант: «исправление reflex: skeleton low HP — не escape_to_base» — смена приоритета вариантов + повторный побег после неудачи.

Простой до: день 60 — простой 20 мин (самый длинный 54), построено 0; день 61 (частичный) — простой 12 мин (самый длинный 65), построено 0.

Как проверить: в events.log при атаке скелета с HP<10 variant не escape_to_base; после escape с fled=false следом идёт второй escape/shelter, а не пауза; смертей от стрел при HP<10 меньше.

Случай: 20261023-191254-90.
