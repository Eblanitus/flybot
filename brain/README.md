# Пространство обучения мухи — справочник навыков

Муха (тело) умеет крупные навыки (`SKILLS.md`). Код выученных навыков пишет **инженер** (отдельная модель, `brain/ENGINEER_PROMPT.md`) по заявке мозга `brain/skill_requests/<имя>.md`. Мозг код не пишет: он заявляет, запускает и записывает правила. Этот файл — шаблон и `api` для инженера и справка для мозга.

## Где что лежит
Корень: `C:\Users\user\flybot\`
| путь | что это |
|---|---|
| `SKILLS.md`, `bot.js`, `lib/`, `data/`, `package.json` | **ядро — не трогать** |
| `brain/learned/<имя>.js` | выученные навыки (пишет инженер по заявке) |
| `brain/skill_requests/<имя>.md` | заявки мозга инженеру; ответ — `<имя>.done.md` |
| `brain/blueprints/<имя>.txt` | чертежи построек для `build_blueprint` (мозг может рисовать) |
| `brain/learned/.history/` | версии навыков, кладёт исполнитель (не трогать) |
| `brain/notes.md` | твой блокнот: цель, правила, инвентарь, смерти (писать) |
| `brain/core_bugs.md` | заявки «сломано тело» (писать) |
| `brain/runner.js`, `worker.js`, `bodyapi.js`, `skills_stats.json`, `runner.log` | исполнитель и его данные (не трогать) |

Два сервера: тело `http://127.0.0.1:3199` (FlyTest; FlyBot — 3099) и исполнитель выученных навыков `http://127.0.0.1:3200`.

## Правила
1. Писать **только** в `brain/learned/`, `brain/notes.md`, `brain/core_bugs.md`. Всё остальное — не менять и не удалять.
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
Обычная работа: `snapshot` → навык (тела или выученный) → `wait` → снова. Когда **затуп** (навык провалился, муха застряла, умерла, ходит кругами):
1. Разобрать причину: `reason` из `task_failed`, `summary`, `/events`, `GET /log`, как умерла.
2. Выбрать **одно** из трёх:
   - **Правило в `notes.md`** («выученные правила») — дёшево и чаще всего достаточно. Пример: «не копать вниз, если лава рядом — сперва `find lava`»; «перед ночью иметь 9 блоков».
   - **Заявка инженеру** `brain/skill_requests/<имя>.md` — если затуп повторился ≥ 2 раз и лечится новым или исправленным навыком. Сначала `GET /skills`: возможно, подходящий уже есть — тогда заявка на его исправление (то же имя), а не копию.
   - **Заявка в `core_bugs.md`** — если сломано само тело (навык тела падает без причины, зависает, `unknown action`, муха не умеет то, что описано в `SKILLS.md`). Ядро сам не правь.
3. Записать вывод в `notes.md` (даже если решил ничего не менять — одной строкой в «последние смерти/затупы»).
4. Продолжить цикл.

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
