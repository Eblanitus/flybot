# Долговременные соглашения проекта flybot

## Работа с Claude Desktop Projects

- **Нового координатора можно делать только новым проектом.** Не новый чат в старом проекте, не дочерний чат-координатор. Один проект = один координатор. Озвучено хозяином 06.11.2026.
- **Хозяин не будет создавать новый проект** (02:11). Значит остаётся тот же чат и тот же координатор: лечить сжатием контекста в том же чате и заменой project knowledge, без новых сущностей. Вариант «новый проект» более не предлагать.
- В project knowledge — только короткая карточка фактов (до 4 КБ), без истории чатов, больших планов (`docs/goal_path.md`, `docs/stage2_plan.md`) и проектной памяти тредов.
- Карточка: `docs/coordinator_state.md`; генератор — `tools/coordinator_state.js` (`node tools/coordinator_state.js`). Обновлять после каждого мира, смены ветки и серии коммитов.

## Порядок источников истины

Код и конфиги → карточка состояния → тесты → docs → проектная память → пересказы тредов. `docs/goal_path.md` и `docs/stage2_plan.md` — планы, не состояние; как текущее состояние не цитировать. Перед выводом сверяться с `git status` / `git log -1`.

## Локальная хроника `hardcore/data/timeline/`

- **Только ПК-версия.** Мобильная адаптация не нужна, не предлагать и не тратить на неё работу. Озвучено хозяином 06.11.2026.
- Генератор — `hardcore/timeline.js`; страницы пересобираются `T.rebuild(dataDir)` или `node hardcore/timeline.js hardcore/data`. Фиксированная минимальная ширина 1000px, `viewport width=1000`, без брейкпоинтов по ширине. Сохранены темы, печать и `prefers-reduced-motion`.
- Офлайн-регрессии: `test/hardcore_stage2_stand.js` (в т.ч. проверка отсутствия адаптивов). Стенд, исходные JSONL, очки и `hardcore/config.json` не трогать.
- Архив включает карьерную аналитику: `bots.html` + по странице на бота из `lives.jsonl`, генерация через `writeBots()` / `rebuild()`; `write()` тоже обновляет её после каждого мира. Данные только из карточек, отсутствующие поля показываются прочерком, не нулём.
- **Ловушка со стендом:** `hardcore/stand.js` делает `require('./timeline')` один раз при старте и дальше вызывает `timeline.write()` из кеша модуля. Запущенный стенд не видит правок `hardcore/timeline.js` и после каждого мира переписывает `index.html` и страницу этого мира старым HTML. Признак: индекс без `data-icon`, светло-зелёный, со строкой «Лента рисуется стендом сама после каждого мира». Лечится только перезапуском стенда (запрещён без явного «да»); `T.rebuild(dataDir)` восстанавливает страницы лишь до следующего завершения мира. `worldsTarget: 0` — цикл бесконечный, мир длится до 120 мин.

## Тело мухи и сервер 26.1 (проверено по node_modules, 06.11.2026)

- Стоят `mineflayer 4.39.0`, `mineflayer-pathfinder 2.4.5`, `prismarine-physics 1.11.1` — это последние версии в npm. В `HISTORY.md` физики под 26.1 только «Add 26.1 to feature sets»: версию вписали в `lib/features.json`, логику не меняли.
- **Отдача:** в 1.21.x `entity_velocity.velocity` = `vec3i16` (1/8000 блока/тик), в 26.1 = `lpVec3` (уже вещественные значения, `minecraft-protocol/src/datatypes/lpVec3.js`). `mineflayer/lib/plugins/entities.js` всё равно применяет `conv.fromNotchVelocity` (×1/8000), толчок выходит ~0.00005. От этого же страдают `lib/felt.js` (направление удара по velocity, порог 0.05) и `lib/variants/melee/crit_jump.js` (velocity.y).
- **Плавание:** водная ветка `prismarine-physics/index.js` не читает `control.sprint`, `isSwimming` нет нигде; спринт применяется только на суше. `lib/skills/water.js` уже жмёт sprint и jump при цели выше. Выход на берег — только `outOfLiquidImpulse` при `isCollidedHorizontally`. В `mineflayer-pathfinder/lib/movements.js` прямые `dont go underwater` / `cant jump from water`.
- **Спринт на сервер:** `setControlState('sprint')` шлёт `entity_action` с actionId 3/4 (`entityActionUsesStringMapper` для 26.1 = false), а в протоколе 26.1 это `start_riding_jump`/`stop_riding_jump`; `start_sprinting` = 1. `player_input` с флагом sprint mineflayer не пишет. Перед починкой быстрого плавания нужен замер.
- `packet_position` в 26.1 и 1.21.8 одинаков (teleportId, x/y/z, dx/dy/dz, yaw/pitch, PositionUpdateRelatives) — реакция на телепорт, скорее всего, не сломана.
- **Переделка вместо заплатки** (06.11, «делай форк»): `vendor/prismarine-physics/` — форк 1.11.1 (187 КБ), в водной ветке `index.js` прямо в коде реализовано спринт-плавание (`liquidSprintAcceleration: 0.032`, гейт `sprintSwimming = supportFeature('proportionalLiquidGravity')`, т.е. 1.13+/26.1). `package.json` содержит прямую `"prismarine-physics": "file:vendor/prismarine-physics"`, она дедуплицируется с `^1.11.1` от mineflayer (`node_modules/prismarine-physics` → link на vendor). mineflayer остаётся `^4.39.0` из npm, не изменён.
- `lib/body26/plugin.js` — штатный внешний плагин mineflayer, подключается `createBot({ plugins: { body26: body26Plugin } })`. Подписывается на `entity_velocity` (lpVec3 без деления на 8000), пишет свои `entity_action` 1/2 при смене спринта, опционально шлёт полный `player_input` (`BODY26_PLAYER_INPUT=1`, по умолчанию выкл — нужен живой замер). Никаких подмен `require.cache` и перехватов `client.write`.
- Старый monkey-patch `lib/body26.js` **не удалён**, перенесён в `hardcore/archive/code/body26.<stamp>.js` (папка в `.gitignore`, физическая копия цела). Новый навык `shore_exit` в `lib/skills/water.js`, зарегистрирован в `lib/commands.js` и `BUSY_SKILLS`. Тесты `test/body26.js`.
- **Где живут правки:** `vendor/`, `lib/`, `bot.js`, `hardcore/fly.js`, `test/`, `package.json`/`package-lock.json` — всё в git, не в `node_modules/`. Стенд пишет только `hardcore/data` и HTML-ленты. Каждое тело — отдельный процесс `bot.js`, спавнится `hardcore/fly.js` на каждый мир, поэтому новая физика и плагин подхватываются со следующего мира **без перезапуска стенда**.
- `npm install` с `file:` зависимостью тянет dev-зависимости из `vendor/**/package.json`, если их не вычистить, и удаляет пакеты из `node_modules`. После запрета хозяина на удаления npm больше не запускать: lock правится точечной правкой одного файла. Лишние ~357 пакетов, доставленные первым install, остались в `node_modules` (не удалялись).

## Устаревший код: архив, не удаление

- **Файлы не удаляем, переносим в архив.** Озвучено хозяином 06.11.2026 (caps: «ФАЙЛЫ НЕ удаляем а кидаем в архив»). Относится и к заменяемым модулям при переделке: старый `lib/body26.js` и подобные уезжают в архив, а не `rm`/`unlink`.
- Архив проекта — `hardcore/archive/` (там already `leftover-*` от стенда) и `brain/learned/.history/` (история навыков). Обе папки в `.gitignore`, то есть файл сохраняется физически, но в git не попадёт. Если нужна история в git — класть в отслеживаемую `archive/` в корне. Перед переносом проговаривать, какой из двух вариантов.
- Имя при переносе: `<исходное-имя>.<YYYYMMDD-HHMMSS>.bak` или папка `code/<дата>/`, чтобы не затереть предыдущий архив.

## Запрещено без явного «да» хозяина

Запуск/остановка стенда, смена формулы очков, слияние PR, удаление файлов, правка `hardcore/config.json`. Обсуждать можно, трогать нет.
