# gather_list_v6 — от учителя

Что не так: gather_list собирает ресурсы, но build_blueprint снова падает по той же причине «не хватает: cobblestone ×XX, spruce_fence ×2». Последние runs 20-25 skill 'успех', но цикл gather→build_fail→gather не ломается. Навык собирает, но ресурсы не переходят в контекст постройки или build_blueprint считает запасы иначе.

Доказательства:
- brain/runner.log #3463-3517 (13:33:46-15:10:55): runs 12-26 gather_list; v5 #3472 ReferenceError: unknown is not defined; runs 16-19 collect skill tool issues (no pickaxe, wooden_pickaxe craft fail); runs 20-25 ok но build_blueprint tasks 176-201 постоянно падают по ресурсам
- signals #426, #455 (13:37-13:38): build_blueprint провалился дважды подряд ne хватает cobblestone, spruce_fence — спустя часы и 20+ попыток цикл не прерван
- task_failed build_blueprint #184, #195, #201 (15:04-15:10): reason «не хватает: cobblestone ×17-25, spruce_fence ×2» даже после gather_list ok
- have cobblestone 73-84, needTotal 101 — gap сохраняется после gather_list successes
- существующий gather_list.md (stone→cobblestone fix) помог по именам, но не solved perennial resource shortfall

Кто решал: skill:gather_list (код) — провалы runner.log; autopilot (инициатор задач)

Версия: runners #3463-3517, последняя успешная версия — runId 26 (runner.log #3517), но build все еще fails

Что нужно (новая версия навыка): gather_list должна гарантировать, что нужные блоки (cobblestone, spruce_fence) находятся в инвентаре build_blueprint'а ПЕРЕД тем, как начинать постройку. То есть: (1) собрать точный недостающий объем, (2) проверить availability перед стартом build_blueprint, (3) если не хватает — повторять сбор до ok, а не переходить к build.

Вариант: «исправление сборы перед build» — когда у автопилота стоит задача build_blueprint, gather_list должна блокировать следующий шаг до тех пор, пока все needItems have количества sufficient. Когда недостаточно — повторять collect items нужного объема, а не один раз.

Как проверить: после запуска gather_list_v6 с items="cobblestone:28,spruce_fence:2" проверить, что следующая task build_blueprint проходит без ошибки «не хватает»; запуск без проверки — build падает как раньше; runner.log не должен содержать пар «gather_list ok + build_blueprint fail» подряд.

Случай: 20261022-233711-10.