# Пространство обучения мухи — справочник навыков

Муха (тело) умеет крупные навыки (`SKILLS.md`). Код выученных навыков пишет **инженер** (отдельная модель, `brain/ENGINEER_PROMPT.md`) по заявке мозга или учителя `brain/skill_requests/<имя>.md`. Мозг код не пишет: он ведёт проект, заявляет и запускает навыки. Ошибки разбирает **учитель** (`brain/TEACHER_PROMPT.md`). Этот файл — шаблон и `api` для инженера и справка для мозга.

## Где что лежит
Корень: `C:\Users\user\flybot\`
| путь | что это |
|---|---|
| `SKILLS.md`, `bot.js`, `lib/`, `data/`, `package.json` | **ядро — не трогать** |
| `brain/learned/<имя>.js` | выученные навыки (пишет инженер по заявке) |
| `brain/skill_requests/<имя>.md` | заявки инженеру от мозга (новые навыки для проекта) и от учителя (исправления, «от учителя»); ответ — `<имя>.done.md` |
| `brain/blueprints/<имя>.txt` | чертежи построек для `build_blueprint` (мозг может рисовать) |
| `brain/learned/.history/` | версии навыков, кладёт исполнитель (не трогать) |
| `brain/notes.md` | блокнот мозга: цель, проект, инвентарь и база (пишет мозг) |
| `brain/lessons.md` | учебник мозга: способы думать (пишет только учитель, мозг читает) |
| `brain/lessons.json` | журнал уроков учителя: подпись случая, что изменено, статус |
| `brain/core_requests.md` | заявки учителя на датчики — правка ядра, делает только хозяин |
| `data/teacher/*.md` | отчёты учителя по случаям; очередь — `data/teacher_queue.json` |
| `brain/core_bugs.md` | заявки «сломано тело» (писать) |
| `brain/runner.js`, `worker.js`, `bodyapi.js`, `skills_stats.json`, `runner.log` | исполнитель и его данные (не трогать) |

Два сервера: тело `http://127.0.0.1:3199` (FlyBot_01; FlyBot — 3099) и исполнитель выученных навыков `http://127.0.0.1:3200`.

## Правила
1. Каждая роль пишет только свои файлы (мозг — `BRAIN_PROMPT.md`; инженер — `ENGINEER_PROMPT.md`; учитель — `TEACHER_PROMPT.md`). Всё остальное — не менять и не удалять.
2. В чат Minecraft не слать команды, начинающиеся с `/`.
3. Все POST — с заголовком `Content-Type: application/json`.
4. Навыку нужен только API ниже. Прямого доступа к mineflayer нет — это намеренно.
5. Один навык за раз (и у тела, и у исполнителя).

## Выученные навыки: API исполнителя (порт 3200)
| запрос | что делает |
|---|---|
| `GET /skills` | список: имя, описание, params, `enabled`, `valid`, статистика (runs/ok/fail/consecutiveFails/lastError) |
| `POST /check {"name"}` | проверить файл без запуска (синтаксис, экспорты, имя = имя файла). Успешный check сохраняет версию в историю |
| `POST /run {"name","params","timeout_sec"}` | запустить и дождаться результата. Тайм-аут 300 с по умолчанию, максимум 1800. По тайм-ауту процесс убивается, телу уходит `stop` |
| `POST /rollback {"name"}` | вернуть предыдущую рабочую версию (повторный вызов — ещё на шаг назад); навык включается заново |
| `POST /enable`, `/disable {"name"}` | включить / выключить |
| `POST /abort` | убить текущий запуск (и `stop` телу) |
| `GET /log?since=N` | журнал запусков и строк `api.log` — можно смотреть, пока `/run` идёт |
| `GET /health` | жив ли исполнитель и тело |

Долгие навыки (`night_routine` ждёт всю ночь ≈ 6–12 мин) запускай с большим `timeout_sec` (например, 900), иначе их убьёт тайм-аут по умолчанию.

Ответ `/run`: `{ok, result | error, sec, logs, stats, ...}`. Ошибка приходит текстом со стеком (до 15 строк). **3 провала подряд — навык выключается сам** (`autoDisabled`, причина в журнале); после правки: `/check` → `/enable` (или `/rollback`).

## Шаблон навыка `brain/learned/<имя>.js`
Имя файла = `name` (латиница, `snake_case`, 2–40 символов). Файл читается заново при каждом запуске — перезапуск не нужен. На верхнем уровне модуля ничего не делать (только `module.exports`).
```js
module.exports = {
  name: 'my_skill',                       // = имя файла без .js
  description: 'Коротко: что делает и когда применять',
  params: { count: 'сколько, по умолчанию 3' },
  async run(api, params) {
    const n = Number(params.count) || 3;
    await api.cmd('collect', { block: 'log', count: n });   // бросает Error с причиной, если тело не справилось
    return { ok: true, collected: n };                      // ok:false или throw = провал
  }
};
```
### `api` (всё через HTTP тела)
| вызов | что |
|---|---|
| `await api.snapshot()` | снимок: `summary`, `eyes` (`time.phase`, `time.nightIn`, `enemies`, `blocks`…), `inventory` `[{slot,name,count}]`, `health`, `food`, `position` |
| `await api.cmd(action, params, {force?})` | навык тела синхронно (`wait:true`); возвращает `result`, при неудаче бросает `Error("навык тела … не удался: <причина>")`, у ошибки есть `e.result` |
| `await api.start(action, params)` | навык тела в фоне → `{taskId}`; итог через `wait`/`events` |
| `await api.wait(timeout, since?)` | события тела (long-poll): `{timedOut, events, cursor, task, summary}` |
| `await api.events(since, limit?)` | журнал событий тела |
| `await api.stop()` | прервать навык тела |
| `await api.skill(name, params)` | вызвать другой выученный навык (вложенность ≤ 3) |
| `await api.sleep(ms)`, `api.log(msg)` | пауза; строка в журнал (видна в `/log` и в ответе `/run`) |
| `await api.count(имя \| [имена] \| /regex/)` | сколько предметов в инвентаре |

Действия тела (`collect`, `craft`, `smelt`, `fight`, `hunt`, `escape`, `shelter`, `wait_night`, `explore`, …) и их params — в `SKILLS.md`. Типовая причина провала у тела — текст ошибки: «не хватает X», «не нашёл …», «нужен инструмент …» — обрабатывай их в навыке (`try/catch` вокруг `api.cmd`).

Хорошие привычки: проверять инвентарь перед шагом и пропускать лишнее; при «не нашёл» делать `explore` и повторять 2–3 раза; не крутить бесконечных циклов (всегда выход по счётчику или времени); возвращать понятный `{ok:false, error:'…'}` вместо молчаливого `ok:true`.

## Как проверить
1. Записать файл в `brain/learned/`.
2. `POST /check` → пока `ok:false`, читать `errors` и править.
3. `POST /run` с небольшими params (например, `count:1`) → смотреть `result`/`error`/`logs`.
4. Запустил, сломалось → `POST /rollback`. Потом разобрать причину.

## Цикл обучения
Обычная работа мозга: `snapshot` → навык (тела или выученный) → `wait` → снова. Застрял или провалился — мозг пробует другой способ или навык и идёт дальше; **разбирает не он**.
Учитель (отдельная модель, запускает сторож `brain_guard.ps1` на один случай) включается сам: смерть или почти-смерть (`data/blackbox/`), навык провалился дважды подряд с одной ошибкой, муха застряла (за 10 мин ≥ 6 провалов и ни одного успеха), итог игрового дня, сообщение хозяина. Он строит цепочку причин по записям, находит, кто решал (`by`), и:
- решал мозг → урок в `brain/lessons.md` (тело шлёт событие `lessons_updated`, мозг перечитывает);
- решал код (навык, автопилот, поведение) → заявка инженеру `brain/skill_requests/<имя>.md`;
- телу не хватало факта → заявка на датчик в `brain/core_requests.md` (делает хозяин);
- не повезло → только запись в `brain/lessons.json`.

## Примеры (Windows)
В PowerShell `curl` — алиас Invoke-WebRequest, поэтому **`curl.exe`**. JSON удобнее класть в файл и передавать `-d @file.json` (без возни с кавычками). Заголовок обязателен.
```powershell
cd C:\Users\user\flybot\brain
curl.exe -s http://127.0.0.1:3200/skills
curl.exe -s http://127.0.0.1:3199/snapshot

# run.json:  {"name":"starter_kit","params":{"until":"wooden_pickaxe"},"timeout_sec":600}
curl.exe -s -H "Content-Type: application/json" -d @run.json http://127.0.0.1:3200/run

# check.json: {"name":"my_skill"}
curl.exe -s -H "Content-Type: application/json" -d @check.json http://127.0.0.1:3200/check
curl.exe -s -H "Content-Type: application/json" -d @check.json http://127.0.0.1:3200/rollback

# навык тела напрямую
# cmd.json: {"action":"collect","params":{"block":"log","count":4},"wait":true}
curl.exe -s -H "Content-Type: application/json" -d @cmd.json http://127.0.0.1:3199/cmd

curl.exe -s "http://127.0.0.1:3200/log?since=0"
curl.exe -s "http://127.0.0.1:3199/wait?timeout=120"
```
Временные `*.json` для запросов клади в `brain/learned/.tmp/` (папка создаётся исполнителем; навыками она не считается).
