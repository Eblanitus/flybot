# Варианты действий (lib/variants)

Много способов сделать одно базовое действие. Муха пробует их в разных обстановках, запоминает исход
(`data/variants.json`) и сама выбирает, что где работает: бандит UCB1, ещё не пробованные варианты иногда получают шанс,
мало попыток на точном ключе обстановки — откат к более общему. Код выбора — `lib/variants.js`, его не трогать.

## Новый вариант = один файл

`lib/variants/<семейство>/<имя>.js` (имя файла = `name`, snake_case). Каталоги сканируются при старте тела: правки
в других файлах не нужны. Файл, который не грузится, пропускается с предупреждением в лог (тело не падает),
но тест `node test/offline.js` его поймает (`real.errors.length === 0`).

```js
'use strict';
module.exports = {
  name: 'crit_jump', family: 'melee',
  desc: 'одна строка для мозга: что делает и против чего',
  applies: (ctx, sit) => !sit.water && sit.ceiling >= 3,   // быстро, без побочных эффектов; бросок = неприменим
  async run(ctx, t, params, sit) { /* ... */ return { /* итог, который поймёт score() семейства */ }; }
};
```

- `applies` — только проверка по `sit` (и, если очень надо, по `ctx.bot`). Ничего не двигать.
- `run` — сделать попытку и вернуть итог. Провал — `throw new SkillError('почему', {...})` (из `lib/util`).
- Файлы с `_` в начале (`_family.js`, `_core.js`) — не варианты: общее семейства.

## sit — обстановка

`V.situation(ctx, target?, extra?)`:
- из `experience.js` (ключ опыта переиспользуется): `phase` day/night, `place` outdoors/underground/sheltered,
  `armor` none…netherite, `weapon` weapon/nowpn, `hp` low/mid/high, `enemy`, `count` 0/1/2-3/4+, `key`=`expKey`;
- наше: `hpNum`, `food`, `held` (в руке), `shield` (есть щит), `blocks` (земля/булыжник для столба/моста);
- местность: `water`, `ladder`, `ceiling` (свободных блоков от ног вверх, до 5), `cliff` (обрыв ≥3 в 2 блоках);
- цель (если дана): `target` (имя моба / ник), `targetId`, `targetType` mob/player, `pvp`, `ranged`, `creeper`,
  `targetWeapon`, `targetShield`, `dist`;
- `extra` от вызывающего (например `defend: true` — охрана поста, без погони).

## Семейство

`lib/variants/<семейство>/_family.js` (необязателен, но нужен почти всегда):

```js
module.exports = {
  label: 'бегство',                       // как семейство называется в строке снимка мозга
  prior: ['sprint_away', 'pillar'],       // порядок, пока опыта нет (первый — самый надёжный)
  sitKeys: sit => [`${sit.enemy}|${sit.expKey}`, `${sit.enemy}|${sit.hp}`, sit.enemy, '*'], // от точного к общему
  score: ({ result, error, ms, hp0, hp1, sit }) => ({ ok: !error && result.away, score: /* 0..1 */ 1 })
};
```

Без него: ключи `[sit.key, sit.target, '*']`, оценка «не упал = 1».

Запуск из навыка: `await V.perform(ctx, t, 'escape', params, V.situation(ctx, enemy), { style: params.style })` —
выбор, запуск, оценка `score()`, запись. Если попытка — часть цикла (как бой: схватка на каждую цель), то
`V.choose(...)` + `variant.run(...)` + `V.judge(ctx, family, name, ch.keys, { result, error, sit })`.
`style=auto|<имя>` мозг передаёт в параметрах навыка; `V.checkStyle(family, style)` — ошибка на неизвестное имя.

Семейства (каталог = семейство; кто зовёт; style=auto|<имя> в параметрах навыка):
- `melee` — схватка (fight/defend): kite, wtap_combo, crit_jump, strafe, shield_counter, hit_and_run, pillar_fight;
- `escape` — оторваться от врага (escape, до укрытия): sprint_away, zigzag, pillar;
- `shelter` — укрыться (shelter без mode): smart, dig, walls;
- `climb` / `descend` — подъём/спуск (climb, descend): path, pillar / path, stairs;
- `home` — дорога далеко (goto базы автопилота и хозяина, go_home): hops, short_hops, direct;
- `dig` — подход к блоку (collect на каждый блок, dig_at): look, near;
- `place` — как встать для установки (place_at): near, close, pillar.

В итоге навыка — `variant`, `why` и `variants` (счёт всех вариантов в этой обстановке: «ok/n», «—» не пробован,
«неприменим»). Полная статистика — GET /variants (?family=<семейство>), выбор — `V.pick` (через поведение:
behavior/combat.js chooseVariant), счёт в обстановке — `V.scores(ctx, family, sit)`.
Пустые каталоги не создавать — каталог появляется с первым вариантом.

## Прерываемость (обязательно)

- Ждать только `await t.sleep(ms)` (бросает при stop/смерти), в циклах — `t.check()`; `t.progress('...')` — что делаю.
- Всё, что включил, — выключить в `finally`: `bot.clearControlStates()` (или `M.stopMove(bot)`),
  `bot.pathfinder.setGoal(null)`, `bot.deactivateItem()` для щита/лука, вернуть `ctx.movements`.
- Исключение прерывания (`e.aborted`) не глотать — пробрасывать.

## Помощники

- `lib/actions.js`: `goto(ctx,t,goal,{timeout,sprint})`, `equipBestWeapon`, `equipBestArmor`, `findItem`, `invCount`,
  `placeBlockAt`, `isSolid`, `pickupDrops`, `findPlaceSpot`.
- `lib/melee.js`: `reachDist`, `HIT_REACH`, `cooldownMs(item)`, `decide`, `shouldLunge`, `backIsSafe`, `setMove`, `stopMove`.
- `lib/skills/basic.js`: `pillarUp`, `bridge`, `eat`, `shield`, `shoot`, `lookAt` (звать как `require(...).pillarUp(ctx, t, {...})`
  в момент вызова — тесты подменяют).
- `lib/variants/melee/_core.js`: `engage(ctx,t,p,sit,hooks)` — схватка с гарантиями (удар с предела, кулдаун, безопасный
  отход, крипер-отскок, стрелки — сближаться, мало HP — отступ); хуки `setup/strike/cooldown/approach/cleanup`; `retreat`.
- `lib/felt.js` (`posOf`, `distTo`, `RANGED`), `lib/util.js` (`entName`, `isHostile`, `SkillError`, `num`).

Правила тела не ослаблять: игроков бить только агрессоров (`lib/aggressors.js`), големов/жителей/эндерменов/вардена — никогда.

## Тест

Файл `test/variants_<семейство>.js`, экспорт `module.exports = async () => {...}` — `node test/offline.js` запустит его сам.
На каждый вариант 1–2 проверки на фальшивом боте (образец — `test/variants.js`: `fakeBot`, `mob`, журнал `calls`):
`applies` отсекает неподходящие обстановки; `run` делает своё (порядок управляющих вызовов) и в конце всё сброшено;
для выбора — `ctx.variantRand = () => 0.99` (без исследования) и свой `ctx.variantsFile` во временной папке
(без файла статистика только в памяти).
