# Этап 2 — план реализации по шагам (для Haiku)

Это план к коду, не код. Что делаем, решено с хозяином 04.11 в чате проекта (схемы «План Мухи в схемах»).
Как делаем, расписано ниже: шаг за шагом, у каждого шага файлы, что менять, образец кода и проверка.

Образцы кода А1, Б1, Б4 и Б10 при написании плана прогнаны на своих же проверках. Крючки Б3, Б5 и Б7 проверены на временной копии автопилота. Ночные версии навыка — на поддельном ночном мире (Б2).

## 0. Что делаем

**Цель этапа 2.** Мухи сами учатся выбирать дела по опыту, накопленному всеми мухами во всех мирах.

**Признак «готово».** 3 мира подряд средние очки жизни учащихся мух не меньше 2× от базы.
База — средние очки на нынешней версии. Её мерим в шаге А6, до любых правок поведения.

**Что входит (согласовано 04.11):**

1. **Один решатель всегда.** Навыки, охота, побег и пережидание стоят в одном списке.
   - Выбор идёт по опыту в похожей обстановке: день или ночь, биом, инструменты, враг.
   - Решатель выбирает заново, когда дело кончилось или упало, или когда резко сменилась обстановка: ночь, упало HP, враг рядом.
   - Дело, которое идёт нормально, не бросаем.
   - Пауза после побега запрещает только повторный побег, а не всю работу.
2. **Две починки.**
   - Ночной навык, который работает (сейчас `night_mine` падает с ошибкой кода).
   - Блоки для ямы и стен выбираются по свойствам. Это баг пустыни и мезы: мухи бесконечно копали вниз.
3. **Очки жизни.**

   | За что | Очки |
   |---|---|
   | Ступени 1–5 (по сумке, каждая раз за жизнь) | +1 |
   | Каждая пережитая ночь | +1 |
   | Убийство мухи кулаком, деревом или золотом | +1 |
   | Убийство камнем и лучше, луком, арбалетом, трезубцем или булавой | +2 |
   | Простой днём: 2 мин в радиусе 3 блоков и ни одной новой вещи | −1 за каждые 2 мин |
   | Круг: одно и то же дело провалилось 3 раза | −1 |
   | Смерть | 0 |

   Ночь в укрытии — не простой. **Штраф за простой оставляем** (хозяин 14:33).
4. **Температура.**
   - 30% выборов — проба, 70% — лучшее по опыту.
   - Новички (меньше 5 запусков в такой обстановке) пробуются первыми.
   - Доля проб падает до 10% по мере опыта.
   - Пробы не запрещены нигде: ночью, при враге рядом, при низком HP (хозяин 05.11: «муху никак не ограничиваем»).
   - Оценка дела в похожей обстановке — только итог матча: средние очки жизней, в которых его выбирали (хозяин 05.11). Никаких окон и подсказок за муху.
5. **Общая память.** Опыт решателя и способов (`variants`, `experience`) сливается после каждого мира и даётся мухам следующего.
6. **Пул PR #5** (87 навыков Voyager/Odyssey) не выбирает отдельно 70/30, а стоит в общем списке решателя.
7. **Контроль.** 2 мухи из 10 без общей памяти и без проб. Группа каждой мухи видна в ленте, карточке и логе стенда (хозяин 05.11).
8. **Учитель.**
   - Запускается по кнопке хозяина и делает не больше 2 правок.
   - Сначала ищет готовое на GitHub, потом тест.
   - Правку получают 5 мух, сравниваем с учащимися мухами без неё. Если с правкой хуже, откат сам.
   - В В2 это 5 против 3, двое — постоянный контроль (хозяин 05.11: ок). В ленте у мух видно, кто с правкой, кто без.
9. **Режим мира зафиксирован:** баттл-рояль, 10 мух, старт вечером, спавн 300–900.

**Не в этом плане:**

- Сервер убивает всех после 7 игровых дней — это этап 3 (хозяин 14:33).
- Дрозофила — это этап 2м. Решатель сделан так, чтобы его таблицу потом можно было подменить.
- Свои пороги у каждой мухи — этап 3.

## 1. Правила для Haiku

1. **Шаги строго по порядку.** Один шаг — один коммит. Следующий шаг начинать только после того, как проверка текущего прошла.
2. **Проверка шага.**
   - После каждого шага `npm test` целиком зелёный.
   - Перед первым запуском нужен `npm install`: в чистой копии `node_modules` пустой.
   - На c7eec1b уже падает `test/eyes_client.js`: нет файлов датапака, папка `data/` в `.gitignore`. Это старое, его не трогать. «Зелёный» значит: всё, кроме него.
   - Плюс проверка, написанная у шага.
   - Тесты не выключать, не пропускать и не ослаблять.
3. **Где код.**
   - Новый код — в `hardcore/`, новые навыки — в `brain/learned/`, тесты — в `test/`.
   - В старых файлах FlyBot (`behavior/`, `lib/`, `bot.js`) — только маленькие крючки под переменной окружения.
   - Без переменной старый код работает байт в байт как раньше. Это проверяют старые тесты.
4. **Ничего сверх шага.** Никаких «заодно поправил». Баг в пустыне появился как раз из-за правок вне плана.
5. **Стенд не трогать.**
   - Ничего не ставить на стенд и не запускать бота.
   - Ставят только по слову хозяина и только между мирами: текущий мир не прерывать.
   - Шаги «Установка» в этом плане — для хозяина или для Claude по его «да».
6. **Если застрял.** Проверка не прошла и за 2 попытки не чинится — стоп. Напиши в тред, что сломалось (вывод теста), и не обходи.
7. **Если план не сходится с кодом** (имя функции, строка, поле) — сначала найди настоящее место через `grep`. Сделай по смыслу шага и напиши в коммите, что отличалось.
   - Номера строк в плане — на момент коммита c7eec1b. Ищи по тексту, не по номеру.

**Переменные окружения этапа 2.** Их ставит `hardcore/fly.js` телу и исполнителю, вне стенда их нет.

| Переменная | Кому | Что включает | Шаг |
|---|---|---|---|
| `HC_STAND=1` | всем мухам стенда | событие `deed` (итог дела) для очков | А2 |
| `HC_STAGE2=1` | всем мухам, когда в конфиге `stage2: true` | починки, решатель, охота как дело | Б1+ |
| `HC_DECIDER_MEM=<файл>` | только учащимся | общая память решателя (`decider.json`) | Б10 |
| `HC_EXPLORE=0` | только контролю | решатель без проб | Б11 |
| `HC_POOL=1` | всем, когда `stage2` и `pool` | навыки пула в списке решателя | Б8 |

**Ветка.** Код этапа 2 делается от ветки PR #5 (`claude/project-thread-dw5bn5`): там уже есть `hardcore/pool`.
Пул в конфиге стенда выключен (`pool: false`) до шага Б8. С выключенным пулом `day_routine_v7` и `night_mine_v7` зовут родные v6, как раньше.

---

## Фаза А — только счёт очков (поведение мух не меняется)

Зачем: мерило до правок. Без базы «2× от базы» не проверить.

### А1. Счётчик очков `hardcore/points.js`

**Файлы:** новый `hardcore/points.js`, новый `test/hardcore_points.js`.

**Что сделать:** чистый модуль без mineflayer. На вход — события жизни, на выход — сумма, разбивка по видам и список.

**Образец:**

```js
// Очки жизни мухи (этап 2, хозяин 04.11): развитие, ночи, убийства; минус за дневной простой и круг провалов. Смерть — 0.
// Чистый счётчик: события подаёт hardcore/fly.js, карточка берёт toJSON(). Проверка офлайн — test/hardcore_points.js.
'use strict';
const IDLE_SEC = 120, IDLE_R = 3, CYCLE_FAILS = 3;
// убийство: кулак, дерево, золото — 1; камень, медь и лучше, лук, арбалет, трезубец, булава — 2
const KILL2 = /^(stone|copper|iron|diamond|netherite)_|^(bow|crossbow|trident|mace)$/;
const killPoints = w => (KILL2.test(String(w || '')) ? 2 : 1);

function makePoints() {
  const list = [], byKind = {}, steps = new Set(), fails = {};
  let total = 0, nights = 0, anchor = null, lastInv = null;
  const add = (t, kind, d, note) => { total += d; byKind[kind] = (byKind[kind] || 0) + d; list.push({ t, kind, d, note }); };
  return {
    get total() { return total; },
    byKind, list,
    step(n, t) { if (n >= 1 && n <= 5 && !steps.has(n)) { steps.add(n); add(t, 'step', 1, `ступень ${n}`); } }, // 6-я — это ночь, её считает night()
    night(t) { nights++; add(t, 'night', 1, `ночь ${nights}`); },
    kill(weapon, t, victim) { add(t, 'kill', killPoints(weapon), `${victim || '?'} (${weapon || 'fist'})`); },
    // кадр раз в секунду: { t, day, pos: [x, y, z], inv: { имя: штук } }
    // днём 2 мин в радиусе 3 блоков без новой вещи — −1, и снова через 2 мин; ночью простоя нет
    frame(f) {
      if (!f || !f.pos) return;
      const inv = f.inv || {};
      const gained = !!lastInv && Object.entries(inv).some(([n, c]) => c > (lastInv[n] || 0));
      lastInv = inv;
      const moved = !!anchor && Math.hypot(f.pos[0] - anchor.pos[0], f.pos[1] - anchor.pos[1], f.pos[2] - anchor.pos[2]) > IDLE_R;
      if (!anchor || moved || gained || !f.day) { anchor = { t: f.t, pos: f.pos }; return; }
      if (f.t - anchor.t >= IDLE_SEC) { add(f.t, 'idle', -1, 'простой 2 мин'); anchor = { t: f.t, pos: anchor.pos }; }
    },
    // итог дела автопилота: один и тот же ключ провалился 3 раза (успех этого ключа обнуляет счёт) — −1
    deed(key, ok, t) {
      if (ok) { fails[key] = 0; return; }
      fails[key] = (fails[key] || 0) + 1;
      if (fails[key] >= CYCLE_FAILS) { fails[key] = 0; add(t, 'cycle', -1, `${key}: ${CYCLE_FAILS} провала`); }
    },
    toJSON() { return { total, byKind, nights, list: list.slice(-300) }; }
  };
}
module.exports = { makePoints, killPoints, IDLE_SEC, IDLE_R, CYCLE_FAILS };
```

**Проверка** (`test/hardcore_points.js`, стиль как в `test/hardcore.js`: `assert` и `console.log('...: OK')`):

- `step(1)`…`step(6)` дают +5: шестая не считается. Повторный `step(1)` ничего не меняет.
- `night()` ×2 — +2.
- `kill`:
  - `fist`, `wooden_sword`, `golden_axe` — по +1;
  - `stone_sword`, `iron_axe`, `bow` — по +2.
- Простой днём:
  - стоит на месте с той же сумкой t = 0…240 — −2 (на 120 и 240);
  - на t = 100 сдвинулся на 4 блока — первый −1 только на t = 220;
  - на t = 110 бревно 1→2 — первый −1 только на t = 230.
- Ночь (`day: false`) 300 с на месте — 0.
- `deed`:
  - провал ×3 одного ключа — −1;
  - провал, провал, успех, провал — 0;
  - провал ×6 — −2;
  - провалы разных ключей вперемешку (a, b, a, b, a) — −1 за `a`.
- `npm test` зелёный.

### А2. Событие «дело кончилось» из автопилота

**Файлы:** `behavior/autopilot.js` (крючок под `HC_STAND`), `hardcore/fly.js` (env), новый `test/hardcore_deed_event.js`.

**Что сделать:**

1. В `finish(run, res)` автопилота, сразу после строк с `ap.history.push(...)` и `ap.history.shift()`, добавь одну строку:

   ```js
       // хардкор-стенд (этап 2): итог дела — для очков жизни (круг провалов) в hardcore/fly.js; вне стенда (без HC_STAND) — ничего
       if (process.env.HC_STAND) ctx.events.push('deed', { key: run.key, name: run.name, verdict, sec: Math.round(sec), ...(err ? { error: err.split('\n')[0].slice(0, 120) } : {}) });
   ```

2. В `hardcore/fly.js`, в объект `env`, добавь `HC_STAND: '1',` рядом с `FLYBOT_NO_BRAIN: '1'`.
3. Перед правкой проверь `grep -rn "'deed'" behavior lib bot.js` — должно быть пусто: имя события свободно.

**Проверка** (`test/hardcore_deed_event.js`, образец — `test/build_goal.js` стр. ~136: поддельный `ctx`, `AP.create(ctx)`, `ap._start(act)`, `await ap.running.promise`):

- `process.env.HC_STAND = '1'`. Дело `{ key: 'collect_log', kind: 'body', name: 'collect', params: {}, why: 'тест' }`.
  - `ctx.runSkill` вернул `{ ok: false, error: 'нет брёвен' }` — в событиях есть `deed` с `verdict: 'провал'` и `error`.
  - `ctx.runSkill` вернул `{ ok: true }` — событие `deed` с `verdict: 'ok'`.
- `delete process.env.HC_STAND` — событий `deed` нет.
- `npm test` зелёный, старые тесты автопилота не тронуты.

### А3. Очки в `hardcore/fly.js` и в карточке

**Файлы:** `hardcore/lib.js` (летопись отдаёт число ночей), `hardcore/fly.js`, `test/hardcore_fly.js` (дополнить), `test/hardcore_fakes/fly_body.js` (дополнить).

**Что сделать:**

1. В `makeChronicle()` (`hardcore/lib.js`) добавь в возвращаемый объект `nights: () => nights,`.
   Список `events` обрезается на 300, поэтому считать ночи по нему нельзя.
2. В `fly.js`:
   - `const P = require('./points');` и рядом с `const ladder = L.makeLadder();` строку `const pts = P.makePoints();`.
   - Рядом с `let spawned = false, …` заведи `let ptsNights = 0;`.
   - В `tick()` после `chron.observe(f);`:

     ```js
         while (ptsNights < chron.nights()) { ptsNights++; pts.night(f.t); } // пережил ночь → +1
         const tod = f.tod == null ? null : ((f.tod % 24000) + 24000) % 24000;
         pts.frame({ t: f.t, day: tod != null && !(tod >= 13000 && tod < 23000), pos: f.pos, inv: invOf(s) });
     ```
   - В цикле `for (const n of ladder.update(...))` добавь `if (n <= 5) pts.step(n, f.t);`.
   - В `readEvents()`:

     ```js
         if (e.type === 'deed' && (d.verdict === 'ok' || d.verdict === 'провал')) pts.deed(d.key, d.verdict === 'ok', Math.round((Date.now() - t0) / 1000));
     ```

     Считаются только `'ok'` (обнуляет счёт) и `'провал'` (+1 к счёту). «Прерван мозгом», «навык выключен» и «тело/исполнитель заняты» не меняют ничего.
   - В `noteKill()`, где `kills.push(...)`: `pts.kill(weapon, Math.round((Date.now() - t0) / 1000), k.victim);`.
   - В `writeCard()` в объект `card`: `points: pts.toJSON(), pointsTotal: pts.total,`.
   - В лог конца жизни (строка `console.log(\`[fly] ${A.name}: ${result}…\`)`) допиши `, очков ${pts.total}`.
3. Поддельное тело `test/hardcore_fakes/fly_body.js`:
   - в снимке сумка с 4 брёвнами `oak_log` (ступень 1);
   - в `/events` одно событие `{ type: 'deed', data: { key: 'x', verdict: 'провал' } }`.
   - Посмотри, как там уже отдаются события, и сделай так же.

**Проверка:**

- В `test/hardcore_fly.js` карточка содержит `pointsTotal >= 1` (ступень 1) и `points.byKind.step === 1`.
- `npm test` зелёный.

### А4. Очки в итоге мира и в ленте

**Файлы:** `hardcore/lib.js` (`summarizeWorld`), `hardcore/timeline.js`, `test/hardcore.js` (дополнить).

**Что сделать:**

1. В `summarizeWorld(cards)`, в возвращаемый объект:

   ```js
       // этап 2: очки жизни — среднее по всем мухам и по группам (group: learn / control; до Б11 группы нет — 'all')
       ...(cards.some(c => c.pointsTotal != null) ? (() => {
         const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null;
         const pts = c => Number(c.pointsTotal) || 0;
         const groups = {};
         for (const c of cards) (groups[c.group || 'all'] = groups[c.group || 'all'] || []).push(pts(c));
         return { pointsAvg: avg(cards.map(pts)), pointsByNick: Object.fromEntries(cards.map(c => [c.nick, pts(c)])),
           pointsByGroup: Object.fromEntries(Object.entries(groups).map(([g, a]) => [g, avg(a)])) };
       })() : {})
   ```

2. В `timeline.js`, в строку-шапку мира `worldHtml` (где «умерло … пережили первую ночь …»), допиши `· очки в среднем ${w.pointsAvg}`, если поле есть.
   В подписи мухи на полосе рядом с ником — ` · ${c.pointsTotal} оч.`, если поле есть.
   Найди место подписи ника в `svgFor` по `c.nick`.
3. В лог стенда о конце мира (`stand.js`, строка `мир ${r.id} готов за …`) допиши `, очки в среднем ${r.pointsAvg}`, если есть.

**Проверка:**

- В `test/hardcore.js` `summarizeWorld` от трёх карточек с `pointsTotal` 1, 2 и 6 даёт `pointsAvg === 3`. Если у двух `group: 'learn'`, а у одной `'control'`, то `pointsByGroup` верный.
- Карточки без `pointsTotal` — полей нет (старые миры не ломаются).
- `npm test` зелёный.

### А5. Скрипт базы `hardcore/baseline.js`

**Файлы:** новый `hardcore/baseline.js`, новый `test/hardcore_baseline.js`.

**Что сделать:** скрипт читает `hardcore/data/worlds.jsonl` и считает средние очки на муху.

- **По умолчанию** — по последним N мирам с полем `pointsAvg`, где N из `--worlds 3`.
- **Режим `--write`** — пишет `hardcore/data/baseline.json` вида `{ at, worlds: [id…], pointsAvg }`.
- **Режим `--check`** (для Б12):
  - берёт последние 3 мира с `pointsByGroup.learn` и сравнивает каждый с `2 × baseline.pointsAvg`;
  - печатает по строке на мир и итог «готово / ещё нет»;
  - код выхода 0 — готово, 1 — нет.

Чистые функции (`baselineOf(worlds, n)`, `checkDone(worlds, base, n)`) вынеси и экспортируй для теста.

**Проверка:**

- Тест на подделанных строках `worlds.jsonl`:
  - 3 мира с `pointsAvg` 1, 2, 3 — база 2;
  - `checkDone`: учащиеся 4, 5, 4 при базе 2 — готово; 4, 3, 5 — нет.
- `npm test` зелёный.

### А6. Установка и замер базы (хозяин; Claude — только по его «да»)

1. Дождаться, когда текущий мир кончится сам. Мир не прерывать.
2. Поставить ветку с шагами А1–А5. В `hardcore/config.json` на ПК: `"pool": false`, `"bots": 10`. Остальное как сейчас.
3. Прогнать 3 мира.
4. `node hardcore/baseline.js --worlds 3 --write` — появится `hardcore/data/baseline.json`.

Сейчас на муху около 2 очков (оценка по прошлым карточкам), значит цель — около 4. Точная цифра — из этого замера.

---

## Фаза Б — починки, решатель, общая память, контроль

Всё новое поведение — под `HC_STAGE2=1`. Его ставит `fly.js`, когда в конфиге `stage2: true` (шаг Б11). До Б11 включать нечем, поэтому шаги Б1–Б10 проверяются только тестами.

### Б1. Блоки для ямы и стен по свойствам (баг пустыни и мезы)

**Причина бага** (`lib/util.js` и `lib/skills/survival.js`):

- Песка и красного песка нет в `BUILD_BLOCKS`. Муха в пустыне копает яму (`digIn`) и выкапывает песок, но закрыть голову ей «нечем».
- Навык падает, автопилот зовёт укрытие снова, и `digIn` копает ещё 2 блока вниз. Так без конца.

Если песок просто разрешить, он упадёт с крыши на голову и муха задохнётся. Поэтому на крышу сыпучие блоки не ставим.

**Файлы:**

- новый `hardcore/blocks.js`;
- крючки в `lib/util.js` (`isBuildBlock`) и `lib/skills/survival.js` (`buildItem`, `putBlock`, `digIn`);
- новый `test/hardcore_blocks.js`.

**Образец — `hardcore/blocks.js`:**

```js
// Блоки для стен и крыши укрытия по свойствам (этап 2, баг пустыни и мезы 04.11: песок не считался блоком — муха копала вниз без конца).
// Годится: полный твёрдый непрозрачный блок, который можно поставить, и не ценный (не бревно, не руда, не верстак…).
// Крыша — без сыпучих: песок и гравий падают на голову.
'use strict';
let MD = null; try { MD = require('minecraft-data')(process.env.MC_VERSION || '26.1'); } catch (e) {}
const DENY = /(_log|_wood|_stem|_hyphae|_ore|_wool|_leaves|glass|ice|_slab|_stairs|_wall|fence|door|_pane|_bed|sign|banner|carpet|chest|barrel|shulker|table|furnace|smoker|anvil|tnt|piston|observer|dispenser|dropper|hopper|beacon|spawner|cake|pot|_head|skull|button|lever|plate|rail|torch|lantern|campfire|ladder|scaffold|honey|slime|sponge|magma|soul_sand|farmland|dirt_path|powder_snow|cactus|pumpkin|melon|hay_block|bookshelf|lectern|composter|bell|jukebox|note_block|target|lodestone|portal|_block$|suspicious_|infested_|bedrock|obsidian)/;
const GRAVITY = /^(sand|red_sand|gravel)$|_concrete_powder$/;
const cache = new Map();
function isShelterBlock(name) {
  if (cache.has(name)) return cache.get(name);
  const b = MD && MD.blocksByName[name];
  const ok = !!(b && MD.itemsByName[name] && !DENY.test(name) && b.boundingBox === 'block' && !b.transparent && b.diggable !== false);
  cache.set(name, ok);
  return ok;
}
const isGravity = name => GRAVITY.test(String(name || ''));
module.exports = { isShelterBlock, isGravity, DENY, GRAVITY };
```

Свойства проверены по `minecraft-data` 26.1. У полублоков и сундуков `boundingBox` тоже `'block'`, поэтому без `DENY` нельзя.

**Крючки:**

1. `lib/util.js`:

   ```js
   function isBuildBlock(n) {
     if (BUILD_BLOCKS.includes(n) || n.endsWith('_planks')) return true;
     // хардкор-стенд, этап 2: любой полный твёрдый не ценный блок (песок, терракота…) — hardcore/blocks.js
     return !!process.env.HC_STAGE2 && require('../hardcore/blocks').isShelterBlock(n);
   }
   ```

2. `lib/skills/survival.js`, `buildItem`:

   ```js
   function buildItem(bot, roof) {
     let items = bot.inventory.items().filter(i => isBuildBlock(i.name));
     // этап 2: крыша (roof) — без песка и гравия, иначе блок упадёт на голову
     if (roof && process.env.HC_STAGE2) items = items.filter(i => !require('../../hardcore/blocks').isGravity(i.name));
     // …дальше как было: сортировка и return items[0] || null
   }
   ```

3. В `putBlock(bot, p, noUnder)` все вызовы `buildItem(bot)` замени на `buildItem(bot, noUnder)`.
   `noUnder` там и есть «уровень крыши»: обе вызывающие строки передают `p.y > base.y + 1`. Без `HC_STAGE2` второй аргумент ничего не меняет.
4. В `digIn`, перед циклом «копаю вниз», вставь проверку:

   ```js
     // этап 2: уже стою в яме (стены у ног и у головы есть) — глубже не копаю, только закрываю (баг пустыни: каждый повтор копал ещё 2 блока)
     const inPit = !!process.env.HC_STAGE2 && shellPositions(db).slice(0, 8).every(p => !needsFill(bot, p));
     // этап 2: крыть нечем (в сумке только сыпучие) и под ногами сыпучее — не копаю вовсе
     if (process.env.HC_STAGE2 && !buildItem(bot, true)) {
       const HB = require('../../hardcore/blocks');
       const below = [1, 2].map(i => bot.blockAt(db.offset(0, -i, 0)));
       if (inPit || below.every(b => !b || HB.isGravity(b.name)))
         throw new SkillError('нет блока на крышу ямы: песок и гравий на крышу не годятся — не копаю', { placed: placedSoFar });
     }
   ```

   Цикл копания: `for (let i = 1; i <= 2 && !inPit; i++)`.

**Проверка** (`test/hardcore_blocks.js`; поддельный мир — как `world(...)` в `test/shelter.js`, стр. 9–36):

- `isShelterBlock` — да:
  `sand`, `red_sand`, `gravel`, `dirt`, `cobblestone`, `sandstone`, `terracotta`, `red_terracotta`, `netherrack`, `stone`, `mud`, `clay`.
- `isShelterBlock` — нет:
  `oak_log`, `crafting_table`, `oak_leaves`, `glass`, `tnt`, `oak_slab`, `chest`, `iron_ore`, `torch`, `iron_block`, `bedrock`.
- `isGravity` — да: `sand`, `gravel`, `white_concrete_powder`. Нет: `sandstone`.
- `isBuildBlock('sand')`: без `HC_STAGE2` — `false`, с `HC_STAGE2=1` — `true`.
- С `HC_STAGE2=1`, мир — песок до y = 65, муха на y = 66, в сумке только `sand` ×20:
  - `digIn` бросает «нет блока на крышу ямы»;
  - ни одного `dig` не было.
- С `HC_STAGE2=1`, муха в яме (у ног и головы со всех 4 сторон твёрдое), в сумке `sand` ×10 и `dirt` ×2:
  - `dig` не было;
  - на крыше (y + 2) стоит `dirt`, не `sand`.
- `test/shelter.js` без изменений зелёный: старое поведение то же.

### Б2. Рабочий ночной навык `hc_night_mine`

**Причина** (проверено на поддельном ночном мире из `test/core_fixes.js`):

- В стенде у каждой жизни пустая память версий. Поэтому `pickVersions` при равных счётах берёт самую новую — `night_mine_v7`, а она зовёт v6.
- v5 и v6 падают `score is not defined` в любом ночном мире.
- v4 падает `sunk is not defined`, когда муха в яме или на поверхности.
- Все 4 ночных сценария проходит только базовый `night_mine.js` (его и проверяет `test/core_fixes.js`):
  - в яме в камне — копает;
  - в dripstone — копает;
  - в сплошном камне — копает;
  - на открытой поверхности — честный отказ с причиной.
- Ночь уходила в `wait_night` (40–50% жизни).
- Старые файлы навыков не трогаем. Делаем новое имя, которое `pickVersions` не путает с `night_mine`.

**Файлы:** новый `brain/learned/hc_night_mine.js`, крючок в `behavior/autopilot.js`, новый `test/hardcore_night_mine.js`.

**Что сделать:**

1. Скопируй **`brain/learned/night_mine.js`** (базовый, не v4!) в `brain/learned/hc_night_mine.js`. Поменяй только:
   - первую строку на `// версия: этап 2 — копия базового night_mine.js (единственная версия без ReferenceError в ночных сценариях) под своим именем для хардкор-стенда`;
   - `name: 'night_mine'` на `name: 'hc_night_mine'`.

   Если в тексте ошибок навыка стоит `night_mine:`, оставь: так проще искать в журналах.
2. В `decide()` (`behavior/autopilot.js`), строка `add(50, learned('night_mine', 'night_mine', {}, 'копаю туннель ночью'))`, замени второй аргумент:

   ```js
       if (!nightQuiet && (s.phase === 'ночь' || s.phase === 'закат')) add(50, learned('night_mine', process.env.HC_STAGE2 ? 'hc_night_mine' : 'night_mine', {}, 'копаю туннель ночью'));
   ```

   Ключ остаётся `night_mine`: паузы и счёт провалов те же.

**Проверка** (`test/hardcore_night_mine.js`; скопируй `nightApi(...)` из `test/core_fixes.js`, стр. 217–240):

- `hc_night_mine` проходит те же 4 сценария, что `testNightMine()` в `test/core_fixes.js` (день, поверхность, dripstone, тонкий потолок), с теми же ожиданиями.
- В сценарии «яма в камне» (воздух в (0,64,0) и (0,65,0), камень до y = 65) `hc_night_mine` даёт `ok: true, mined >= 1`.
- В том же сценарии `night_mine_v6` бросает `score is not defined`, а `night_mine_v4` — `sunk is not defined`. Тест доказывает, что взята рабочая версия.
- `decide()` ночью без угроз (базовое состояние из `test/autopilot.js` с `phase: 'ночь'`, `isNight: true`):
  - с `HC_STAGE2=1` в кандидатах `hc_night_mine`;
  - без переменной — `night_mine`.
- `npm test` зелёный.

### Б3. Пауза после побега — только для побега; короткие ворота простоя

**Причины** (разбор стояний 04.11):

- **Побег.** После неудачного побега от мухи `workBan` запрещает всю работу на всё время паузы (1–8% жизни). Повторный побег и так держит `blocked.escape_player`.
- **Ворота простоя.** Автопилот берёт дело, только если 30 с не было команды мозга и рефлекса (`IDLE_MS`). На стенде мозга нет, а после каждого рефлекса (еда, побег) муха 30 с стоит.

**Файлы:** `behavior/autopilot.js` (2 крючка), новый `test/hardcore_stage2_autopilot.js`.

**Что сделать:**

1. Строка `const workBan = !!en || escapePlayerFailed;` становится:

   ```js
     // этап 2: пауза после неудачного побега запрещает только повторный побег (его держит blocked.escape_player), работу — нет
     const workBan = !!en || (escapePlayerFailed && !process.env.HC_STAGE2);
   ```

2. Ворота простоя. Рядом с `const IDLE_MS = T.idleMs;`:

   ```js
   const HC_IDLE_MS = 3000; // этап 2: на стенде мозга нет — после рефлекса (еда, побег) следующее дело через 3 с, а не через 30
   const idleMsNow = () => (process.env.HC_STAGE2 ? HC_IDLE_MS : IDLE_MS);
   ```

   В `gather`, в поле `idle:`, замени `>= IDLE_MS` на `>= idleMsNow()`. Добавь `idleMsNow` в `module.exports`.

**Проверка:**

- `decide()` с базовым состоянием из `test/autopilot.js` плюс:

  ```js
  failInfo: { escape_player: { reason: 'побег не оторвал от врага', count: 2 } }, blocked: { escape_player: true }
  ```

  - без `HC_STAGE2` дела работы нет;
  - с `HC_STAGE2=1` есть дело работы (на c7eec1b — `day_routine`), и это не `escape_player`.
- `idleMsNow()`: `3000` с переменной, `30000` без неё.
- `npm test` зелёный.

### Б4. Решатель — ядро `hardcore/decider.js` (чистые функции)

**Что это.** Одно место, где выбирается дело. Его кандидаты:

- список автопилота (`cands` в `decide()`) с его счётом как подсказкой;
- охота (Б6);
- навыки пула (Б8).

Решатель выбирает по опыту всех мух в похожей обстановке, с пробами (температура).

Выбор — одна функция `pickOption`. Дрозофила (этап 2м) потом подменит только её, остальное не меняется.

**Файлы:** новый `hardcore/decider.js`, новый `test/hardcore_decider.js`.

**Образец** (чистая часть, без mineflayer):

```js
// Решатель дел (этап 2, хозяин 04.11 «один решатель всегда»): навыки, охота, побег, пережидание — один список,
// выбор по опыту всех мух в похожей обстановке (общая память hardcore/data/shared/decider.json), с пробами.
'use strict';
const K = 3;                 // подсказка автопилота весит как 3 запуска
const PROBE_RUNS = 5;        // меньше 5 запусков в этой обстановке — новичок, пробуется первым
const EXPLORE_HI = 0.30, EXPLORE_LO = 0.10, EXPLORE_RUNS = 200;   // доля проб: 30% → 10% к 200 делам в обстановке
const MIN_EXACT = 3;         // в точной обстановке меньше 3 запусков дела — берём грубую (фаза|инструменты|враг)

const BIOMES = [[/desert|badlands/, 'dry'], [/snow|frozen|ice|grove|jagged/, 'snow'], [/ocean|river|beach|swamp/, 'water'],
  [/jungle|forest|taiga|bamboo|cherry/, 'forest'], [/peak|slope|hill|mountain|windswept|stony/, 'mount'], [/plain|savanna|meadow|field/, 'plain']];
const biomeGroup = name => { const n = String(name || ''); for (const [re, g] of BIOMES) if (re.test(n)) return g; return 'other'; };
const TOOLS = ['none', 'wood', 'stone', 'iron'];

// s — состояние gather() автопилота; biome — имя биома под ногами
function sitOf(s, biome) {
  const t = s.tools || {};
  const o = {
    phase: s.isNight ? 'night' : 'day',
    place: s.sheltered ? 'shelter' : s.underground ? 'under' : 'open',
    hp: s.hp < 8 ? 'low' : s.hp < 14 ? 'mid' : 'high',
    tools: TOOLS[Math.min(3, Math.max(0, t.pickaxe || 0))],
    enemy: (s.enemies && s.enemies.length) ? 'fly' : s.hostilesNear > 0 ? 'mob' : 'none',
    biome: biomeGroup(biome)
  };
  return { ...o, key: [o.phase, o.place, o.hp, o.tools, o.enemy, o.biome].join('|'), coarse: [o.phase, o.tools, o.enemy].join('|') };
}
// статистика дел для обстановки: точная, а где в точной мало — грубая
function statsFor(mem, sit) {
  const ex = (mem.exact || {})[sit.key] || {}, co = (mem.coarse || {})[sit.coarse] || {};
  const out = {};
  for (const k of new Set([...Object.keys(ex), ...Object.keys(co)])) out[k] = ex[k] && ex[k].n >= MIN_EXACT ? ex[k] : (co[k] || ex[k]);
  return out;
}
const runsIn = st => Object.values(st).reduce((a, x) => a + (x.n || 0), 0);
const exploreRate = runs => Math.max(EXPLORE_LO, EXPLORE_HI - (EXPLORE_HI - EXPLORE_LO) * Math.min(1, runs / EXPLORE_RUNS));
// оценка: подсказка автопилота (счёт/100) как K запусков + средние очки дела
const value = (o, st) => { const x = st[o.key] || { n: 0, sum: 0 }; return (o.prior * K + x.sum) / (K + x.n); };
// opts: [{ key, prior, act }]; calm — можно ли пробовать (решатель стенда пробует везде, хозяин 05.11; false — для тестов и этапа 2м); rate — доля проб
function pickOption(opts, st, { calm = true, rate = EXPLORE_HI, rnd = Math.random } = {}) {
  if (!opts.length) return null;
  const runs = o => (st[o.key] ? st[o.key].n : 0);
  if (calm && rate > 0 && rnd() < rate) {
    const fresh = opts.filter(o => runs(o) < PROBE_RUNS);
    const from = fresh.length ? fresh : opts;
    const o = from[Math.floor(rnd() * from.length) % from.length];
    return { ...o, explore: true, why: fresh.length ? `пробую новичка (${runs(o)} раз здесь)` : 'пробую наугад' };
  }
  let best = opts[0];
  for (const o of opts) if (value(o, st) > value(best, st)) best = o;
  return { ...best, explore: false, why: `лучшее по опыту: ${value(best, st).toFixed(2)} очка (${runs(best)} раз здесь)` };
}
// награда дела = итог матча: очки жизни мухи за весь мир (хозяин 05.11: «та муха, которая лучше выжила, используя
// из сотни навыков конкретные, та и круче»). Каждое дело жизни получает итог этой жизни; оценка дела в обстановке —
// средние очки жизней по его запускам. Смерть — конец счёта: у рано погибшей мухи мало очков, и все её дела получают мало.
function rewards(deeds, total) {
  return deeds.map(d => ({ ...d, r: total }));
}
module.exports = { sitOf, biomeGroup, statsFor, exploreRate, runsIn, value, pickOption, rewards, K, PROBE_RUNS, EXPLORE_HI, EXPLORE_LO };
```

**Проверка** (`test/hardcore_decider.js`):

- `sitOf`:
  - `{ isNight: true, sheltered: true, hp: 20, tools: { pickaxe: 2 }, enemies: [], hostilesNear: 0 }` с биомом `desert` даёт ключ `night|shelter|high|stone|none|dry`;
  - `biomeGroup('badlands') === 'dry'`.
- `pickOption` без памяти и `rate: 0` берёт опцию с наибольшим `prior`. Холодный старт — как сейчас.
- Память `{ b: { n: 10, sum: 30 } }`, у `a` prior 0.5, у `b` prior 0.3 — берёт `b`.
- `rate: 1`, `rnd = () => 0`, у `a` 10 запусков, `b` новичок — берёт `b` с `explore: true`.
- `calm: false` при `rate: 1` — проб нет.
- `exploreRate(0)` — 0.30, `exploreRate(200)` — 0.10, `exploreRate(100)` — 0.20. Дробные числа сравнивай с допуском: `Math.abs(a - b) < 1e-9`.
- `statsFor`: в точной у дела 1 запуск, в грубой 10 — берёт грубую.
- `rewards([{ key: 'a' }, { key: 'b' }], 5)` — у обоих `r: 5`.
- `npm test` зелёный.

### Б5. Решатель в автопилоте: один выбор вместо `pick()`

**Файлы:** `behavior/autopilot.js` (3 крючка), `hardcore/decider.js` (дописать `choose`), новый `test/hardcore_decider_ap.js`.

**Что сделать:**

1. Сигнатура `function decide(s, out)`. В `pick()` первой строкой:

   ```js
     if (out) out.cands = cands.slice(); // этап 2: весь список кандидатов — решателю (hardcore/decider.js)
   ```

   Без `out` (все старые вызовы и тесты) ничего не меняется.
2. В `ap.tick`, строка `const act = decide(st);`, станет:

   ```js
         const out = process.env.HC_STAGE2 ? {} : null;
         let act = decide(st, out);
         if (out) act = require('../hardcore/decider').choose(ctx, st, act, out); // этап 2: один решатель
   ```

3. В `start(act)`, после `note(act.why, true);`:

   ```js
       if (process.env.HC_STAGE2) ctx.events.push('deed_start', { key: act.key, name: act.name, sit: act.sit || null, coarse: act.coarse || null, explore: !!act.explore });
   ```

4. В `hardcore/decider.js` допиши часть с живой мухой:

   ```js
   let MEM = null;
   function memory() { // общая память решателя: читается раз за жизнь (пишет её стенд между мирами, Б10); нет файла — пусто
     if (MEM) return MEM;
     MEM = { exact: {}, coarse: {} };
     if (process.env.HC_DECIDER_MEM) try { MEM = JSON.parse(require('fs').readFileSync(process.env.HC_DECIDER_MEM, 'utf8')); } catch (e) {}
     return MEM;
   }
   function biomeOf(bot) { // как biomeName в lib/perception.js (там не экспортирован — старый файл не трогаем)
     try {
       const b = bot.blockAt(bot.entity.position);
       if (b && b.biome) { if (b.biome.name) return b.biome.name; const r = bot.registry && bot.registry.biomes && bot.registry.biomes[b.biome.id]; if (r && r.name) return r.name; }
     } catch (e) {}
     return 'unknown';
   }
   function choose(ctx, s, act, out) {
     const sit = sitOf(s, biomeOf(ctx.bot));
     const tag = a => (a ? { ...a, sit: sit.key, coarse: sit.coarse } : a);
     // Б7: срочное (out.urgent) — сюда, первой строкой
     if (!out || !out.cands) return tag(act);        // ранний выход decide (безопасность, рефлекс, «ждём») — как было
     const opts = out.cands.map(c => ({ key: c.act.key, prior: c.score / 100, act: c.act }));
     // Б6: охота, Б8: пул — добавляются сюда
     if (!opts.length) return tag(act);              // список пуст — что дал decide (idle_move или null)
     const st = statsFor(memory(), sit);
     const rate = process.env.HC_EXPLORE === '0' ? 0 : exploreRate(runsIn(st)); // пробы везде: муху никак не ограничиваем (хозяин 05.11)
     const ch = pickOption(opts, st, { rate });
     return tag({ ...ch.act, score: Math.round(ch.prior * 100), explore: ch.explore, why: `${ch.act.why} — решатель: ${ch.why}` });
   }
   const _reset = () => { MEM = null; }; // для тестов
   ```

   Добавь `choose, memory, biomeOf, _reset` в `module.exports`.

**Почему так:**

- **Без памяти и без проб** решатель берёт кандидата с наибольшим счётом автопилота — ровно то, что берёт сейчас `pick()`. Холодный старт = нынешнее поведение.
- **Пробы везде** — ночью, при враге рядом, при низком HP (хозяин 05.11: «муху никак не ограничиваем»). Смерть сама снижает оценку: у рано погибшей мухи мало очков за матч, и все её дела получают мало.
- **Срочное** (враг рядом) решатель не трогает до Б7.

**Проверка** (`test/hardcore_decider_ap.js`):

- `decide(s, out)` на дневном базовом состоянии из `test/autopilot.js`:
  - в `out.cands` не меньше 2 кандидатов;
  - ключ ответа — кандидат с наибольшим `score` в `out.cands` (список не отсортирован). На c7eec1b это `day_routine` (25) и `explore` (10).
- `choose(fakeCtx, s, act, out)`:
  - `fakeCtx = { bot: { entity: { position: {} }, blockAt: () => ({ biome: { name: 'plains' } }) } }`;
  - с `HC_EXPLORE=0` без `HC_DECIDER_MEM` — тот же ключ, что дал `decide`;
  - с `HC_DECIDER_MEM` на временный файл, где у второго кандидата `{ n: 10, sum: 30 }` в нужной обстановке, — второй. Перед этим `_reset()`.
- `ap._start({ ...act, sit: 'day|open|high|none|none|plain' })` с `HC_STAGE2=1` (поддельный `ctx` как в А2) пишет событие `deed_start` с этим `sit`.
- Без `HC_STAGE2` событий `deed_start` нет.
- `npm test` зелёный.

### Б6. Охота как дело в теле (охотник `fly.js` только смотрит)

**Причины** (разбор стояний):

- `follow` охотника не кончается сам (`waitAbort`) — 5–24% жизни впустую.
- Команды охотника идут как «мозг» (User-Agent `hc-hunter`). После каждой автопилот 30 с не берёт дел — 3–5%.

Теперь охота — дело `hunt_go` в общем списке решателя: короткий переход к мухе, 60 с, потом выбор заново. Бой с мухой рядом (16 м) — это ветка «враг-игрок» автопилота (Б7).

**Файлы:** `hardcore/br.js`, `hardcore/fly.js`, `hardcore/decider.js`, новый `test/hardcore_hunt_deed.js`.

**Что сделать:**

1. Перенеси `farLeg` и константы `FAR_D, LEG, LEG_SEC, NEAR_FOLLOW` из `fly.js` в `br.js` и экспортируй. В `fly.js` бери их из `BR`. Поведение `fly.js` без `--stage2` то же.
2. В `hardcore/decider.js`:

   ```js
   const SEEN = new Map(); // мухи на локаторе: имя → { name, d, at, heading, far, t }; помним HUNT.memorySec (120 с)
   function huntOption(ctx, s, bar) { // bar — панель локатора; в тесте подаётся готовой
     const prefix = process.env.HC_BR_PREFIX; if (!prefix) return null;
     const BR = require('./br'), now = Date.now();
     if (!bar) { bar = []; try { bar = require('../lib/locator').playersOnBar(ctx, { limit: 12 }); } catch (e) {} }
     for (const m of bar) {
       if (!m || !m.name || !m.name.startsWith(prefix) || m.name === ctx.bot.username) continue;
       if (m.gamemode === 3 || m.gamemode === 'spectator') { SEEN.delete(m.name); continue; }
       if (!m.onBar || m.hidden) continue; // как у игрока: метка видна в конусе 120° и если муха не прячется
       SEEN.set(m.name, { name: m.name, d: m.d == null ? BR.FAR_D : m.d, at: m.at, heading: m.heading || null, far: !!m.far, t: now });
     }
     for (const [n, m] of SEEN) if (now - m.t > BR.HUNT.memorySec * 1000) SEEN.delete(n);
     const tgt = [...SEEN.values()].sort((a, b) => a.d - b.d)[0];
     if (!tgt) return null;
     const far = s.isNight && tgt.d > 32; // ночью далеко: раньше запрет (huntDecision), теперь только низкая подсказка — муху не ограничиваем (хозяин 05.11)
     const leg = BR.farLeg(ctx.bot.entity.position, tgt);
     if (!leg) return null;
     const ready = s.hp >= BR.HUNT.hp && s.food >= BR.HUNT.food && (s.hasWeapon || process.uptime() >= BR.HUNT.prepSec);
     return { key: 'hunt_go', prior: ready && !far ? 0.40 : 0.05, act: { key: 'hunt_go', kind: 'body', name: 'goto',
       params: { x: leg.x, z: leg.z, r: 4, timeout: 60, label: `к мухе ${tgt.name}`, fail: `не дошла до ${tgt.name}` },
       why: `иду к ${tgt.name} (${tgt.d === BR.FAR_D ? 'далеко' : tgt.d + ' м'})` } };
   }
   ```

   - В `choose` на месте «Б6»: `const h = huntOption(ctx, s); if (h && !(s.blocked && s.blocked.hunt_go)) opts.push(h);`.
   - Дополни `_reset`, чтобы он чистил и `SEEN` (`SEEN.clear()`). В тестах зови `_reset()` перед каждым сценарием: муха помнится 120 с. Экспортируй `huntOption`.
   - Подсказка 0.40 — между `day_routine` (35) и `job` (50). Дальше решатель учится сам: охоту оценивают очки жизней, в которых муха охотилась.
   - `timeout` в секундах, как у `go_base` (`T.baseTimeoutSec`). `name: 'goto'` идёт через `baseTravel`, как `go_base`.
3. В `fly.js`, в `huntTick`, сразу после цикла, который заполняет `seenFlies`:

   ```js
     if (A.stage2) { hunt.why = 'этап 2: охота — дело решателя в теле (hunt_go), охотник только смотрит'; return; }
   ```

   `A.stage2` появится в Б11. До него заведи `stage2: arg('stage2', '') === '1'` в `A` уже сейчас.

**Проверка** (`test/hardcore_hunt_deed.js`):

- `huntOption` с поддельным `ctx`:
  - `bot.username: 'HC_1'`, `entity.position: { x: 0, y: 64, z: 0 }`;
  - панель локатора подаётся третьим аргументом `bar` — строки вида `{ name, d, at, onBar: true, hidden: null, gamemode: null }`;
  - муха `HC_2` в 40 м на панели — есть `hunt_go` с `params.x/z` в её сторону;
  - ночью и 40 м — `hunt_go` есть, но с `prior: 0.05` (запрета нет, только низкая подсказка);
  - `hidden: 'sneak'` — `null`;
  - чужой ник (`Steve`) — `null`.
- `fly.js` с `--stage2 1` и поддельным телом (как в `test/hardcore_fly.js`) не шлёт `/cmd` (`follow`, `fight`, `goto`), хотя на локаторе есть муха.
- `npm test` зелёный (`test/hardcore_br.js` — тоже).

### Б7. Враг рядом: бой или побег — тот же решатель, с пробами

**Что:** две ветки автопилота сейчас берут первое подходящее правило. Под `HC_STAGE2` они отдают решателю короткий срочный список, а прежний порядок становится порядком по умолчанию:

- «враг-игрок рядом» (`fight_player` / `escape_player`);
- «моб подошёл, пока идёт работа» (`safety_fight` / `safety_shelter` / `safety_escape`).

Решатель выбирает так же, как все дела: по средним очкам жизней, в которых мухи в похожей обстановке так поступали. Прежний порядок правил — только подсказка для холодного старта.
Пробы — как везде (хозяин 05.11: «муху никак не ограничиваем»): так опыт узнаёт, когда бой лучше побега. `lib/experience.js` тут не нужен, им по-прежнему пользуются рефлексы тела.

Ночная защита (`nightDefense`) и рефлексы тела (лава, удушье, застрял, еда при низком HP) остаются как были. Это тело, а не выбор дела.

**Файлы:** `behavior/autopilot.js` (2 ветки), `hardcore/decider.js` (`urgentPick`), новый `test/hardcore_urgent.js`.

**Что сделать:**

1. В ветке `if (en) { … }`, после строки с `critHere`, перед старым кодом:

   ```js
       if (process.env.HC_STAGE2 && out) { // этап 2: бой или побег от мухи — выбирает решатель (общая таблица, итоги матчей); прежний порядок — подсказка
         const fightA = body('fight_player', 'fight', { target: en.name, radius: T.apFightRadius, flee_hp: T.apFleeHp, timeout: T.apFightTimeout }, `дерусь с ${en.name}`, true);
         const escA = critHere && s.sheltered ? null : body('escape_player', 'escape', { distance: T.apEscapeDist, shelter: true }, `убегаю от ${en.name} (${en.why})`, true);
         const oldFight = en.aggressor && s.hasWeapon && s.hp >= T.apFightHp && s.alone; // прежнее правило — порядок по умолчанию
         out.urgent = (oldFight ? [fightA, escA] : [escA, fightA]).filter(a => a && ok(a.key));
         if (out.urgent.length) return out.urgent[0];
         delete out.urgent;
       }
   ```

2. В ветке «безопасность: моб рядом, пока идёт работа» (`if (mob.d <= lim) { … }`) так же, в начале. Условия каждого варианта — те же, что в старом коде:

   ```js
       if (process.env.HC_STAGE2 && out) {
         const list = [];
         if (mob.name !== 'creeper' && s.hasWeapon && fightWins) list.push(/* тот же body('safety_fight', …) что ниже */);
         if (escFailed(mob) && mob.name !== 'creeper' && !s.sheltered && s.blocks >= 2) list.push(/* тот же body('safety_shelter', …) */);
         list.push(/* тот же body('safety_escape', …) */);
         out.urgent = list.filter(a => ok(a.key));
         if (out.urgent.length) return out.urgent[0];
         delete out.urgent;
       }
   ```

   Тела `body(...)` скопируй из трёх строк старого кода ниже, без изменений.
3. В `hardcore/decider.js`:

   ```js
   // срочное (враг рядом): тот же выбор, что для всех дел — средние очки жизней в похожей обстановке, с пробами (хозяин 05.11);
   // подсказка для холодного старта — прежний порядок правил: первый 0.9, второй 0.8, …
   function urgentPick(list, st, { rate = 0, rnd = Math.random } = {}) {
     if (list.length < 2) return list[0];
     const ch = pickOption(list.map((a, i) => ({ key: a.key, prior: 0.9 - 0.1 * i, act: a })), st, { rate, rnd });
     return ch.act === list[0] && !ch.explore ? list[0] : { ...ch.act, explore: ch.explore, why: `${ch.act.why} — решатель: ${ch.why}` };
   }
   ```

   В `choose`, первой строкой после `tag`:

   ```js
     if (out && out.urgent && out.urgent.length) { // срочное — тот же выбор по общей таблице
       const st = statsFor(memory(), sit);
       return tag(urgentPick(out.urgent, st, { rate: process.env.HC_EXPLORE === '0' ? 0 : exploreRate(runsIn(st)) }));
     }
   ```

   Экспортируй `urgentPick`.

**Проверка** (`test/hardcore_urgent.js`):

- `decide(s, out)`, `HC_STAGE2=1`, `enemies: [{ name: 'HC_2', d: 8, aggressor: true, why: 'рядом' }]`, `hasWeapon: true`, `hp: 20`, `alone: true`:
  - `out.urgent` — `[fight_player, escape_player]`;
  - ответ — `fight_player`.
- Без оружия — порядок `[escape_player, fight_player]`.
- `urgentPick(list, st, { rate: 0 })`, `list` — `[fight_player, escape_player]`:
  - без памяти (`st = {}`) — `fight_player`: прежнее правило;
  - память `{ escape_player: { n: 10, sum: 50 }, fight_player: { n: 10, sum: 10 } }` — `escape_player`.
- `urgentPick(list, { fight_player: { n: 10, sum: 30 } }, { rate: 1, rnd: () => 0 })` — проба новичка: `escape_player` с `explore: true`.
- Без `HC_STAGE2` — старое поведение, `out.urgent` нет. Старые тесты `test/autopilot.js` и `test/defense.js` зелёные.
- `npm test` зелёный.

### Б8. Пул PR #5 — в общем списке решателя

**Что:**

- Навыки пула (Voyager/Odyssey) — кандидаты решателя с подсказкой 0. Их выбирает проба (новички первыми), а дальше — их средние очки.
- Отдельный выбор пула 70/30 (`hardcore/pool/pick.js` через `day_routine_v7` и `night_mine_v7`) под `HC_STAGE2` не работает: `fly.js` не даёт `HC_POOL_RUNS`, поэтому v7 зовут родные v6.

**Файлы:** новый `brain/learned/pool_run.js`, `hardcore/decider.js` (`poolOptions`), `hardcore/fly.js` (env), новый `test/hardcore_pool_run.js`.

**Что сделать:**

1. `brain/learned/pool_run.js`. Форма модуля — как у `day_routine_v7.js`: `name`, `description`, `params`, `run`.

   ```js
   // версия: этап 2 — один навык пула (hardcore/pool, Voyager/Odyssey, MIT) по id; выбирает его решатель (hardcore/decider.js), а не пул 70/30
   'use strict';
   const path = require('path');
   const HCP = path.join(__dirname, '..', '..', 'hardcore', 'pool');
   module.exports = {
     name: 'pool_run',
     description: 'Этап 2 хардкор-стенда: один навык из пула по id ({ id, delo, max_sec })',
     params: { id: 'string', delo: 'string', max_sec: 'number' },
     async run(api, params = {}) {
       const entry = (require(path.join(HCP, 'catalog.json'))[params.delo] || []).find(e => e.id === params.id);
       if (!entry) return { ok: false, error: `pool_run: в пуле нет ${params.id} для дела ${params.delo}` };
       const r = await require(path.join(HCP, 'shim.js')).runForeign(api, entry, { maxSec: Math.min(Number(params.max_sec) || 300, 300) });
       api.log(`пул: ${entry.id} ${r.ok ? 'удался' : 'не удался'} за ${r.sec} с${r.err ? ' — ' + r.err : ''}`);
       return r.ok ? { ok: true, gained: r.gained } : { ok: false, error: `pool_run ${entry.id}: ${r.err}`, gained: r.gained };
     }
   };
   ```

   Посмотри, как описаны `params` в `day_routine_v7.js`, и сделай так же, если там другая форма.
2. `hardcore/decider.js`:

   ```js
   function poolOptions(ctx, s) {
     if (!process.env.HC_POOL) return [];
     const POOL = require('./pool/run.js'), bot = ctx.bot;
     const snap = { inventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })), food: bot.food,
       armor: [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(i => i.name), eyes: { blocks: {} } };
     const delo = POOL.deloOf(snap, s.isNight ? 'night' : 'day');
     return POOL.candidates(delo, null).filter(c => !c.native && !(s.blocked && s.blocked['pool:' + c.id]))
       .map(c => ({ key: 'pool:' + c.id, prior: 0, act: { key: 'pool:' + c.id, kind: 'learned', name: 'pool_run',
         params: { id: c.id, delo, max_sec: 300 }, why: `пул: ${c.id} (дело ${delo})` } }));
   }
   ```

   В `choose` на месте «Б8»: `opts.push(...poolOptions(ctx, s));` — всегда, без условий (хозяин 05.11).
3. `fly.js`, строка с пулом в `env`:

   ```js
     ...(A.pool ? (A.stage2 ? { HC_POOL: '1' } : { HC_POOL_RUNS: path.resolve(A.pool) }) : {})
   ```

**Проверка** (`test/hardcore_pool_run.js`; поддельный мир и тело — как `world()` и `fakeBody()` в `test/hardcore_pool.js`):

- `pool_run` с `{ id: 'v1.mineWoodLog', delo: 'wood' }` проходит через `runForeign` (тот же итог, что в `test/hardcore_pool.js` для этого навыка).
- С `{ id: 'нет_такого', delo: 'wood' }` — `ok:false`, «в пуле нет».
- `poolOptions`:
  - с `HC_POOL=1` и поддельным `ctx` (сумка пустая) — список дела `wood`, у всех `prior: 0`;
  - с `blocked['pool:v1.mineWoodLog']` этого навыка нет;
  - без `HC_POOL` — `[]`.
- `npm test` зелёный (`test/hardcore_pool.js` — тоже).

### Б9. Награда дела и строки опыта жизни

**Что:**

- Награда каждого дела жизни — итог этой жизни: очки мухи за весь матч (`rewards` из Б4). Хозяин 05.11: какая муха лучше выжила и развилась, её выбор навыков и круче.
- Смерть — конец счёта: у рано погибшей мухи мало очков, и все её дела получают мало. В очках жизни смерть по-прежнему 0.

**Файлы:** `hardcore/fly.js`, `test/hardcore_fly.js` и `test/hardcore_fakes/fly_body.js` (дополнить).

**Что сделать:**

1. В `fly.js` заведи `const deeds = [];`.
   В `readEvents()`:

   ```js
       if (e.type === 'deed_start') deeds.push({ t: Math.round((Date.now() - t0) / 1000), key: d.key, name: d.name, sit: d.sit || null, coarse: d.coarse || null, explore: !!d.explore });
   ```

2. В `writeCard()`, до записи карточки:

   ```js
     const rated = require('./decider').rewards(deeds, pts.total); // каждое дело жизни — итог этой жизни
     try { fs.writeFileSync(path.join(life, 'deeds.jsonl'), rated.map(x => JSON.stringify(x)).join('\n') + (rated.length ? '\n' : '')); } catch (e) { console.error('дела не записаны:', e.message); }
   ```

   В `card`:

   ```js
   deeds: { n: rated.length, explore: rated.filter(x => x.explore).length },
   ```

3. Поддельное тело: в `/events` событие `deed_start` в начале жизни.

**Проверка:**

- После конца жизни в `test/hardcore_fly.js` есть `<ник>.fly/deeds.jsonl`: одна строка, её `r` равен `pointsTotal` карточки.
- В карточке `deeds.n === 1`.
- `npm test` зелёный.

### Б10. Общая память: слить после мира, дать в следующем

**Что:**

- Учащаяся муха начинает жизнь с копией общей памяти способов (`variants.json`) и выживания (`experience.json`) и с общей таблицей решателя.
- После мира стенд прибавляет к общей памяти то, что жизнь добавила к своей копии, и дописывает дела жизни в таблицу решателя.
- Мухи одного мира друг у друга не учатся, только у прошлых миров. Так проще: никто не пишет в общий файл во время мира.

**Файлы:** новый `hardcore/memory.js`, `hardcore/fly.js` (аргумент `--shared`), `hardcore/stand.js` (слияние после мира), новый `test/hardcore_memory.js`.

**Образец — `hardcore/memory.js`:**

```js
// Общая память мух (этап 2): таблица решателя (decider.json), способы (variants.json), выживание (experience.json).
// Мир идёт — общие файлы только читаются; мир кончился — стенд сливает в них то, что добавила каждая учащаяся жизнь.
'use strict';
const fs = require('fs'), path = require('path');
const FILES = ['variants.json', 'experience.json'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, f); };
// к общей (shared) прибавить то, что жизнь добавила к стартовой копии: числа — end − start, объекты — вглубь; массивы (recent) не сливаем
function addDelta(shared, start, end) {
  for (const [k, v] of Object.entries(end || {})) {
    if (typeof v === 'number') shared[k] = (shared[k] || 0) + v - (start && typeof start[k] === 'number' ? start[k] : 0);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!shared[k] || typeof shared[k] !== 'object') shared[k] = {};
      addDelta(shared[k], start && start[k], v);
    }
  }
  return shared;
}
// строки deeds.jsonl → { exact: { обстановка: { дело: { n, sum } } }, coarse: { … } }; sum — сумма итогов матчей (очков жизней)
function foldDeeds(mem, rows) {
  mem.exact = mem.exact || {}; mem.coarse = mem.coarse || {};
  for (const r of rows) {
    if (!r || !r.key || !r.sit || typeof r.r !== 'number') continue;
    for (const [tab, k] of [['exact', r.sit], ['coarse', r.coarse]]) {
      if (!k) continue;
      const row = mem[tab][k] = mem[tab][k] || {};
      const a = row[r.key] = row[r.key] || { n: 0, sum: 0 };
      a.n++; a.sum = Math.round((a.sum + r.r) * 100) / 100;
    }
  }
  return mem;
}
// перед жизнью учащейся мухи: общие файлы — в данные жизни, и снимок «как было на старте»
function prepareLife(sharedDir, lifeDir) {
  fs.mkdirSync(path.join(lifeDir, 'data'), { recursive: true });
  for (const f of FILES) {
    const src = path.join(sharedDir, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(lifeDir, 'data', f));
    fs.copyFileSync(src, path.join(lifeDir, 'start_' + f));
  }
}
// после мира: разница жизни — в общие файлы; дела жизни — в таблицу решателя. Возвращает число строк дел.
function mergeLife(sharedDir, lifeDir) {
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const f of FILES) {
    const end = readJson(path.join(lifeDir, 'data', f), null);
    if (!end || !end.stats) continue;
    const start = readJson(path.join(lifeDir, 'start_' + f), { stats: {} });
    const shared = readJson(path.join(sharedDir, f), { stats: {}, recent: [] });
    if (!Array.isArray(shared.recent)) shared.recent = [];
    shared.stats = addDelta(shared.stats || {}, start.stats, end.stats);
    writeJson(path.join(sharedDir, f), shared);
  }
  let rows = [];
  try { rows = fs.readFileSync(path.join(lifeDir, 'deeds.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) {}
  const memF = path.join(sharedDir, 'decider.json');
  writeJson(memF, foldDeeds(readJson(memF, { exact: {}, coarse: {} }), rows));
  return rows.length;
}
module.exports = { addDelta, foldDeeds, prepareLife, mergeLife, FILES };
```

**Что ещё сделать:**

1. **Формат файлов.** Прежде чем писать, открой `lib/variants.js` (`load`/`store`) и `lib/experience.js` (`load`/`save`). Проверь, что в `stats` только числа в листьях и что файл с `{ stats, recent: [] }` они читают без ошибки.
   - Если там есть ещё поля (версия формата и т. п.), перенеси их в общий файл как есть.
   - Если есть затухание счётчиков, разница end − start с ним всё равно сходится, но напиши об этом в коммите.
2. **`fly.js`.**
   - В `A` добавь `shared: arg('shared', '')`.
   - Сразу после создания папок жизни: `if (A.shared) require('./memory').prepareLife(path.resolve(A.shared), life);`.
   - В `env`: `...(A.shared ? { HC_DECIDER_MEM: path.join(path.resolve(A.shared), 'decider.json') } : {})`.
3. **`stand.js`.** После `for (const c of cards) appendJsonl(... 'lives.jsonl' ...)`:

   ```js
     // этап 2: общая память — только учащиеся мухи (group learn), только законченные жизни (смерть или срок)
     if (cfg.stage2) for (const b of bots) {
       const c = cards.find(x => x.nick === b.nick);
       if (!c || c.group !== 'learn' || !(c.result === 'death' || c.result === 'timeout')) continue;
       try { const n = require('./memory').mergeLife(path.join(cfg.dataDir, 'shared'), path.join(path.dirname(b.cardFile), b.nick + '.fly')); log(`общая память: ${b.nick} +${n} дел`); }
       catch (e) { log(`общая память: ${b.nick} не слита — ${e.message}`); }
     }
   ```

**Проверка** (`test/hardcore_memory.js`, во временной папке `os.tmpdir()`):

- `addDelta`:
  - общая `n: 2`, старт `n: 2`, конец `n: 5` — общая `n: 5`;
  - две жизни по +3 от одного старта — `n: 8`;
  - новые ключи появляются.
- `foldDeeds`:
  - две строки одного дела в одной обстановке — `n: 2`, `sum` — сумма.
- `prepareLife` и `mergeLife` на поддельных файлах:
  - копия легла в `data/`;
  - после изменения копии `mergeLife` увеличил общие счётчики ровно на разницу;
  - `decider.json` получил строки из `deeds.jsonl`.
- `npm test` зелёный.

### Б11. Конфиг этапа 2 и контрольные мухи

**Что:**

- `stage2: true` в конфиге включает этап 2 у всех мух.
- Последние `controlBots` мух (по умолчанию 2: `HC_9`, `HC_10`) — контроль: без общей памяти (своя пустая, как в базе) и без проб решателя. Способы внутри навыков (`variants`) выбираются как в базе.
- Остальные — учащиеся.

**Файлы:** `hardcore/stand.js`, `hardcore/fly.js`, `hardcore/config.example.json`, новый `test/hardcore_stage2_stand.js`.

**Что сделать:**

1. `DEFAULTS` в `stand.js`:
   - добавь `stage2: false, controlBots: 2,`;
   - поменяй `pool: true` на `pool: false`.

   Пул включает хозяин в конфиге. Без `stage2` он работал бы по-старому (70/30), а это не то, что решили.
2. Вынеси сборку аргументов из `startBot` в чистую `botArgs(cfg, w, nick, cardFile)` и экспортируй. Группу мухи считай в отдельной чистой `groupOf(cfg, nick)` (`'learn'` / `'control'` / `null` без `stage2`): она же нужна для меток в п. 5. Номер мухи — из ника: `Number((/(\d+)$/.exec(nick) || [0, 0])[1])`. Допиши в конец `botArgs`:

   ```js
     ...(fly && cfg.stage2 ? ['--stage2', '1', '--group', num > cfg.bots - cfg.controlBots ? 'control' : 'learn'] : []),
     ...(fly && cfg.stage2 && num <= cfg.bots - cfg.controlBots ? ['--shared', path.join(cfg.dataDir, 'shared')] : []),
   ```

3. `fly.js`:
   - в `A` добавь `group: arg('group', '')` (`stage2` и `shared` уже есть);
   - в `env` добавь:

     ```js
       ...(A.stage2 ? { HC_STAGE2: '1' } : {}),
       ...(A.group === 'control' ? { HC_EXPLORE: '0' } : {}),
     ```

   - в карточку `group: A.group || null`, а `mode: A.stage2 ? 'stage2' : (A.br ? 'stage1v-br' : 'stage1b-flybot')`. То же значение по умолчанию — в `stand.js`, где карточке ставится `mode`.
4. В `config.example.json` добавь `"stage2": false, "controlBots": 2` и поменяй `"pool": true` на `"pool": false`.
5. **Метки групп** (хозяин 05.11: «как-то помечать, где какие мухи»). Группа мухи видна везде, где виден её ник.
   - `hardcore/lib.js`:

     ```js
     // подпись группы мухи для ленты и логов (этап 2): учится / контроль; при проверке правки учителя (В2) — с правкой (А) / без правки (Б)
     const GROUP_TEXT = { learn: 'учится', control: 'контроль' };
     function groupLabel(c) {
       const g = c && GROUP_TEXT[c.group];
       const t = c && c.teachGroup ? (c.teachGroup === 'A' ? `правка ${c.teach} (А)` : `без правки ${c.teach} (Б)`) : null;
       return [g, t].filter(Boolean).join(', ');
     }
     ```

     Экспортируй `GROUP_TEXT` и `groupLabel`.
   - `timeline.js`, `svgFor`: под ником второй строкой мелко (`class="s"`) — `groupLabel(c)`. Например «контроль». Подпись пустая (старые миры) — второй строки нет.
   - `timeline.js`, `worldHtml`:
     - в таблицу — колонки «Группа» (`groupLabel(c)`) и «Очки» (`c.pointsTotal`);
     - в шапку — кто в какой группе («учатся HC_1–HC_8 · контроль HC_9, HC_10») и средние очки по группам из `w.pointsByGroup`.
   - `stand.js`: в лог старта мира — строка с группами (`мир …: учатся HC_1…HC_8, контроль HC_9, HC_10`), в лог конца мира — очки по группам.
   - `fly.js`: в первый лог мухи (`[fly] HC_9 в мире …`) — `, группа: контроль`.

**Проверка** (`test/hardcore_stage2_stand.js`):

- `botArgs` при `{ bots: 10, controlBots: 2, stage2: true, pool: true, battleRoyale: true, botMode: '1b', … }`:
  - у `HC_1` есть `--stage2 1 --group learn --shared …`;
  - у `HC_10` — `--group control` и нет `--shared`;
  - при `stage2: false` ничего из этого нет, а `--pool` есть, как раньше.
- `groupOf`: `HC_8` — `'learn'`, `HC_9` — `'control'`; без `stage2` — `null`.
- `groupLabel({ group: 'control' })` — «контроль»; `groupLabel({ group: 'learn', teach: 't1', teachGroup: 'A' })` — «учится, правка t1 (А)»; `groupLabel({})` — пустая строка.
- `svgFor([{ nick: 'HC_9', group: 'control', events: [{ wt: 13000, kind: 'night', text: 'ночь' }] }])` содержит «контроль»; `worldHtml` — колонку «Группа».
- `npm test` зелёный (`test/hardcore.js` со `startBot` — тоже).

### Б12. Установка и проверка «готово» (хозяин; Claude — только по его «да»)

1. Дождаться, когда текущий мир кончится сам. Поставить ветку с Б1–Б11.
2. В `hardcore/config.json` на ПК: `"stage2": true`, `"pool": true`, `"controlBots": 2`, `"bots": 10`. Режим мира тот же: баттл-рояль, вечер, 300–900.
3. Общая память в первом мире пустая: учащиеся мухи сначала почти как контроль, только с пробами.
4. После каждого мира: `node hardcore/baseline.js --check`.
   - **Готово** — 3 мира подряд среднее учащихся ≥ 2× базы из `baseline.json`.
   - **Стоп-сигнал** — учащиеся 5 миров подряд ниже контроля. Тогда решатель учится не тому: стоп и разбор, правок наугад не делать.

---

## Фаза В — учитель

Учитель — это Claude по кнопке хозяина. Он делает не больше 2 правок навыков, сначала ищет готовое на GitHub, проверяет правку тестом и сравнивает 5 мух с правкой и без неё. Если с правкой хуже — откат сам.

Здесь — инструменты для этого. Сам учитель — тред с процедурой из В4.

### В1. Сводка по делам за последние миры

**Файлы:** `hardcore/fly.js` (итог дела в строке), `hardcore/stand.js` (общий журнал дел), новый `hardcore/skills_report.js`, новый `test/hardcore_skills_report.js`.

**Что сделать:**

1. **`fly.js`.** На событие `deed` (из А2) найди последнее дело в `deeds` с тем же `key` и без `verdict` и запиши в него `verdict` и `sec`. Так в `deeds.jsonl` видно, чем кончилось дело.
2. **`stand.js`.** После мира допиши строки `deeds.jsonl` всех мух в `<dataDir>/deeds_all.jsonl`, к каждой — `world`, `nick`, `group`.
   - Это рядом со слиянием памяти из Б10, но для всех мух, не только учащихся.
   - Архив хранит только 10 миров, а журнал — все.
3. **`node hardcore/skills_report.js --worlds 5`.** Чистые функции вынеси и экспортируй для теста. Скрипт пишет `hardcore/data/skills_report.md` — таблицу по делам, сортировка по числу запусков:

   | дело | запусков | очки в среднем | провалов, % | лучшая обстановка | худшая обстановка |
   |---|---|---|---|---|---|

   - Обстановка — `coarse`, с не меньше 5 запусками.
   - Навыки пула (`pool:…`) — отдельной таблицей.
   - Внизу — 5 дел с самыми низкими средними очками (не меньше 20 запусков): жизни, в которых их выбирали, кончались хуже всех.

**Проверка:**

- Тест на подделанных строках: 3 дела, 2 обстановки.
- Средние, проценты провалов и «худшие 5» посчитаны верно.
- Обстановки с меньше чем 5 запусками в «лучшей/худшей» не участвуют.
- `npm test` зелёный.

### В2. Группы для правки: 5 мух с правкой, 3 без

**Что:**

- Правка учителя никогда не кладётся сразу в `brain/learned`. Она лежит в `hardcore/teach/<id>/learned/` и включается конфигом только у группы А.
- Группы:
  - А — `HC_1`–`HC_5`, учащиеся с правкой;
  - Б — `HC_6`–`HC_8`, учащиеся без правки;
  - контроль — `HC_9`, `HC_10`, как в Б11.
- Сравниваем А с Б: обе учатся одинаково, разница только в правке.

**Файлы:** `hardcore/stand.js`, `hardcore/fly.js`, `hardcore/decider.js`, новый `test/hardcore_teach.js`.

**Что сделать:**

1. **Конфиг:** `"teach": { "id": "t1", "offer": ["имя_навыка"], "worlds": 3 }`. `offer` — новые навыки, которых нет в списке автопилота. Можно не указывать.
2. **`stand.js`, перед стартом мух** (если в `teach` есть `id` и нет `<dataDir>/teach/<id>/result.json` с вердиктом):
   - собери `<dataDir>/teach/<id>/learned/` = копия `brain/learned` + поверх файлы `hardcore/teach/<id>/learned/*`;
   - мухам 1–5 добавь `--learned <эта папка> --teach <id>:A`, мухам 6–8 — `--teach <id>:B`;
   - всё это — в `botArgs` из Б11.
3. **`fly.js`:**
   - `--learned` → `RUNNER_LEARNED` (по умолчанию как сейчас, `brain/learned`);
   - `--teach id:A|B` → в карточку `teach: id, teachGroup: 'A'|'B'`;
   - у группы А и `offer` → env `HC_TEACH_OFFER=имя1,имя2`.
4. **`decider.js`, в `choose`, рядом с пулом:**

   ```js
     if (process.env.HC_TEACH_OFFER) for (const n of process.env.HC_TEACH_OFFER.split(',').filter(Boolean))
       if (!(s.blocked && s.blocked['teach:' + n])) opts.push({ key: 'teach:' + n, prior: 0, act: { key: 'teach:' + n, kind: 'learned', name: n, params: {}, why: `правка учителя: ${n}` } });
   ```

5. **Слияние памяти (Б10):** пока идёт проверка, дела группы А в общую память не сливать (`c.teachGroup !== 'A'`). Иначе правка смешается с опытом без неё.

**Проверка:**

- `botArgs` при `teach`: у `HC_1` есть `--learned` и `--teach t1:A`, у `HC_7` — `--teach t1:B` без `--learned`, у `HC_10` — ничего из этого.
- Папка `learned` собрана: файл правки поверх копии.
- При готовом `result.json` аргументов нет.
- В ленте (`svgFor`) у `HC_1` подпись «учится, правка t1 (А)», у `HC_7` — «учится, без правки t1 (Б)» (`groupLabel` из Б11).
- `npm test` зелёный.

### В3. Итог правки и откат сам

**Файлы:** `hardcore/stand.js`, новый `hardcore/teach.js` (чистые функции), новый `test/hardcore_teach_verdict.js`.

**Что сделать:**

1. **После каждого мира с `teach`:**
   - средние очки группы А и группы Б за этот мир — дописать в `<dataDir>/teach/<id>/result.json` (`{ id, worlds: [{ world, A, B }], verdict: null }`);
   - группа — по `c.teachGroup` в карточках.
2. **Когда миров набралось `teach.worlds` (3):**
   - `verdict = средн(A) >= средн(B) ? 'оставить' : 'откат'`;
   - строка в лог стенда: `учитель t1: А 3.4, Б 2.9 — оставить`.
3. **Дальше стенд не включает эту правку никому** (В2 видит вердикт). Это и есть откат сам: в `brain/learned` правка не попадала.
   - При «оставить» учитель (В4) делает PR, который переносит файлы в `brain/learned`. Сливает хозяин.
4. **Чистая функция** `verdictOf(result, n)` в `hardcore/teach.js`.

**Проверка:**

- `verdictOf`:
  - 2 мира — `null` (рано);
  - 3 мира, А 3/3/4, Б 2/3/3 — «оставить»;
  - А 2/2/3, Б 3/3/3 — «откат».
- `npm test` зелёный.

Мух мало (5 и 3), поэтому итог шумный. Правило простое, как решили: хуже — откат. Порог «на сколько лучше» не вводим.

### В4. Процедура учителя `docs/teacher_stage2.md`

**Что:** документ, по которому работает тред-учитель. Без кода.

**Кнопка.** Хозяин пишет в чате проекта «учитель». Координатор открывает тред и даёт ему этот документ.

**Процедура:**

1. Прочитать `hardcore/data/skills_report.md`, ленты последних 3 миров (`hardcore/data/timeline/`) и причины смертей (`lives.jsonl`, поле `cause`).
2. Выбрать не больше 2 дел с самыми низкими средними очками (низ сводки В1). Одна правка — одно дело.
3. **Сначала готовое.** Искать на GitHub, как это дело решают другие боты на mineflayer:
   - Voyager, Odyssey, mc-fleet-bot (`docs`, разбор от 03.11), примеры mineflayer;
   - лицензия MIT или Apache;
   - в шапке файла правки — откуда взято.
   Свой код — только если готового нет. Это решение хозяина: чужой код брать можно и нужно.
4. **Где правка.**
   - Правка — файлы в `hardcore/teach/<id>/learned/`: новая версия навыка `<база>_vN.js` или новый навык, тогда его имя — в `offer`.
   - Офлайн-тест на правку в `test/`. `npm test` зелёный.
5. **PR** с правкой и строкой конфига `teach`. Ставит хозяин или Claude по его «да», только между мирами.
6. **Итог.** Через 3 мира прочитать `result.json`.
   - «Оставить» — PR: файлы переезжают в `brain/learned`.
   - «Откат» — ничего не делать: правка уже выключена.
   - Хозяину — 3 строки: что правил, откуда взял, А против Б.

**Учителю нельзя:**

- трогать стенд, очки, решатель, конфиг (кроме `teach`) и тесты чужих шагов. Учитель не чинит мерило вместо бота (`docs/goal_path.md`, этап 2, риски);
- больше 2 правок за раз;
- новую правку, пока не вынесен вердикт по прошлой.

**Проверка:** документ есть, ссылка на него — в `hardcore/README.md`.

### В5. Обновить `docs/goal_path.md`

**Что:**

1. **Раздел 5, «Этап 2. Учитель между жизнями».** Строки «Новое» и «Проверка» — по этому плану:
   - **Новое:** очки жизни, один решатель с температурой, две починки, общая память, контроль, учитель с группами А/Б.
   - **Проверка:** 3 мира подряд средние очки учащихся ≥ 2× базы.
   - Добавь ссылку на `docs/stage2_plan.md`.
   - Строку про экзаменационные сиды и «медиану жизни ≥ 2×» пометь «заменено решением хозяина 04.11 (очки жизни)».
   - Не удаляй её, чтобы было видно, что было.
2. **Раздел 8.7.** В начало допиши строку: «Решено 04–05.11: температура — случайный выбор дел у решателя: 30% проб, к опыту 10%, новички первыми; проб не запрещаем нигде — муху никак не ограничиваем; дело оценивается только итогом матча (очки жизни); опыт общий для всех мух и миров».

**Проверка:** ссылки в документе живые (`docs/stage2_plan.md` существует), `npm test` зелёный.

---

## Порядок и кто что делает

| Шаги | Кто | Что получится |
|---|---|---|
| А1–А5 | Haiku | очки считаются, поведение то же |
| А6 | хозяин (или Claude по «да») | 3 мира, `baseline.json` |
| Б1–Б11 | Haiku | починки, решатель, общая память, контроль; всё под `stage2` |
| Б12 | хозяин (или Claude по «да») | миры с `stage2: true` до «готово» |
| В1–В5 | Haiku | инструменты учителя и процедура |
| учитель | тред по кнопке хозяина | ≤ 2 правки, А/Б, откат сам |

Фазу В можно делать параллельно с прогоном Б12: код учителя поведение мух не меняет, пока нет `teach` в конфиге.

## Решения хозяина по отходам от схемы (05.11)

1. **Муху никак не ограничиваем.** Пробы везде: ночью, при враге рядом, при низком HP. Ночная охота тоже без запрета, только с низкой подсказкой. Без проб — только контроль (`HC_9`, `HC_10`).
2. **Учитель: 5 мух с правкой против 3 без, двое — постоянный контроль.** Хозяин: ок, но мух помечать. Группа каждой мухи видна в ленте, карточке и логах (Б11, п. 5).
3. **Дело оценивается только итогом матча** — очками жизни мухи за весь мир. Окна в 10 минут нет («ты опять хочешь обучать муху за неё»): какая муха лучше выжила и развилась, её выбор и круче.
