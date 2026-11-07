// Офлайн-проверка стенда этапа 2 (шаг Б11): аргументы мух и группы, метки групп в ленте, таблице мира и логах.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../hardcore/stand');
const L = require('../hardcore/lib');
const T = require('../hardcore/timeline');

const val = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const has = (args, flag) => args.includes(flag);
const cfg = { ...S.DEFAULTS, bots: 10, controlBots: 2, stage2: true, pool: true, battleRoyale: true, botMode: '1b', botPrefix: 'HC_', dataDir: path.join(__dirname, '..', 'hardcore', 'data') };
const off = { ...cfg, stage2: false };
const w = { id: 'w1', seed: 5 };
const card = path.join(__dirname, 'HC_x.json');   // только как аргумент: файл не пишется

// 0) значения по умолчанию и пример конфига: этап 2 выключен, пул выключен (включает хозяин в конфиге)
{
  assert.strictEqual(S.DEFAULTS.stage2, false);
  assert.strictEqual(S.DEFAULTS.controlBots, 3);
  assert.strictEqual(S.DEFAULTS.pool, false);
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hardcore', 'config.example.json'), 'utf8'));
  assert.strictEqual(ex.stage2, false);
  assert.strictEqual(ex.controlBots, 3);
  assert.strictEqual(ex.pool, false);
  console.log('значения по умолчанию и config.example.json: этап 2 выключен, пул выключен: OK');
}

// 1) botArgs: учащиеся — этап 2, группа learn и общая память; контроль — группа control и без общей памяти
{
  const a1 = S.botArgs(cfg, w, 'HC_1', card);
  assert.strictEqual(val(a1, '--stage2'), '1');
  assert.strictEqual(val(a1, '--group'), 'learn');
  assert.strictEqual(val(a1, '--shared'), path.join(cfg.dataDir, 'shared'));
  const a10 = S.botArgs(cfg, w, 'HC_10', card);
  assert.strictEqual(val(a10, '--group'), 'control');
  assert.strictEqual(val(a10, '--stage2'), '1');
  assert(!has(a10, '--shared'), 'контроль без общей памяти: ' + a10.join(' '));
  assert.strictEqual(val(a10, '--name'), 'HC_10');
  console.log('botArgs: учащиеся — learn и общая память, контроль — control без неё: OK');
}

// 2) без этапа 2 — ни групп, ни общей памяти; пул как раньше
{
  const a = S.botArgs(off, w, 'HC_1', card);
  assert(!has(a, '--stage2') && !has(a, '--group') && !has(a, '--shared'), a.join(' '));
  assert.strictEqual(val(a, '--pool'), path.join(cfg.dataDir, 'pool_runs.jsonl'));
  console.log('без stage2 — как раньше: без групп, с --pool: OK');
}

// 3) groupOf и состав групп для лога мира
{
  assert.strictEqual(S.groupOf(cfg, 'HC_1'), 'learn');
  assert.strictEqual(S.groupOf(cfg, 'HC_8'), 'learn');
  assert.strictEqual(S.groupOf(cfg, 'HC_9'), 'control');
  assert.strictEqual(S.groupOf(cfg, 'HC_10'), 'control');
  assert.strictEqual(S.groupOf(off, 'HC_9'), null);
  assert.strictEqual(S.groupsText(cfg), 'учатся Uch_Krot–Uch_Pixel, контроль Kon_Viper, Kon_Tormoz');
  assert.strictEqual(S.groupsText({ ...cfg, groupNicks: false }), 'учатся HC_1–HC_8, контроль HC_9, HC_10');
  console.log('groupOf: HC_9–10 контроль, остальные учатся; состав групп для лога: OK');
}

// 3б) ники этапа 2 (хозяин 05.11): у каждой мухи свой ник, группа видна по приставке; слот = бывшая HC_N
{
  const c73 = { ...cfg, controlBots: 3 };
  const nicks = S.nicksOf(c73);
  assert.deepStrictEqual(nicks, ['Uch_Krot', 'Uch_Shmel', 'Uch_Kaktus', 'Uch_Turbo', 'Uch_Zubilo', 'Uch_Glitch', 'Uch_Bagor', 'Kon_Pixel', 'Kon_Viper', 'Kon_Tormoz']);
  assert.strictEqual(new Set(nicks).size, nicks.length, 'ники разные');
  for (const n of nicks) assert(/^[A-Za-z0-9_]{3,16}$/.test(n), 'ник Minecraft: ' + n);
  nicks.forEach((n, i) => { assert.strictEqual(S.slotOf(c73, n), i + 1); assert.strictEqual(S.groupOf(c73, n), i < 7 ? 'learn' : 'control'); });
  assert.strictEqual(S.slotOf(c73, 'HC_4'), 4, 'старый ник — по цифре');
  assert.strictEqual(S.nickOf(off, 3), 'HC_3', 'без этапа 2 — старые ники');
  assert.strictEqual(S.nickOf({ ...c73, bots: 12 }, 12), 'Kon_12', 'мух больше, чем ников в списке — номер');
  const a = S.botArgs(c73, w, 'Kon_Pixel', card);
  assert.strictEqual(val(a, '--slot'), '8', 'слот — порты тела и навыков');
  assert.strictEqual(val(a, '--group'), 'control');
  assert.strictEqual(val(a, '--br'), 'Uch_,Kon_', 'цели охоты — обе группы');
  assert.strictEqual(val(S.botArgs(off, w, 'HC_2', card), '--br'), 'HC_');
  const BR = require('../hardcore/br');
  assert.deepStrictEqual(BR.parseKill('[Server thread/INFO]: Kon_Pixel was slain by Uch_Krot', 'Uch_,Kon_'), { victim: 'Kon_Pixel', killer: 'Uch_Krot' });
  assert.strictEqual(BR.parseKill('Kon_Pixel was slain by Zombie', 'Uch_,Kon_'), null);
  assert(BR.isFly('Uch_Shmel', 'Uch_,Kon_') && !BR.isFly('Steve', 'Uch_,Kon_') && BR.isFly('HC_1', 'HC_'));
  console.log('ники этапа 2: Uch_/Kon_ + свой ник, слот и охота по приставкам: OK');
}

// 4) подписи групп: учится / контроль; правка учителя — с пометкой А/Б; без группы — пусто
{
  assert.strictEqual(L.groupLabel({ group: 'control' }), 'контроль');
  assert.strictEqual(L.groupLabel({ group: 'learn' }), 'учится');
  assert.strictEqual(L.groupLabel({ group: 'learn', teach: 't1', teachGroup: 'A' }), 'учится, правка t1 (А)');
  assert.strictEqual(L.groupLabel({}), '');
  console.log('groupLabel: учится / контроль, пусто без группы: OK');
}

// 5) лента и таблица мира: подпись группы под ником, колонки «Группа» и «Очки», состав групп и очки по группам в шапке
{
  const cards = [
    { nick: 'HC_1', group: 'learn', result: 'death', pointsTotal: 7, lifeSec: 600, events: [{ wt: 13000, kind: 'night', text: 'ночь' }] },
    { nick: 'HC_9', group: 'control', result: 'death', pointsTotal: 3, lifeSec: 300, events: [{ wt: 13000, kind: 'night', text: 'ночь' }] }
  ];
  const svg = T.svgFor(cards);
  assert(/контроль/.test(svg), 'подпись контроля в ленте');
  const html = T.worldHtml({ id: 'w1', seed: 5, durSec: 600, pointsAvg: 5, pointsByGroup: { learn: 7, control: 3 } }, cards);
  assert(/<th>Группа<\/th><th>Очки<\/th>/.test(html), 'колонки Группа и Очки');
  assert(/учатся HC_1 · контроль HC_9/.test(html), 'состав групп в шапке');
  assert(/учится 7, контроль 3/.test(html), 'очки по группам в шапке');
  console.log('лента и таблица мира: группы и очки: OK');
}

// 6) автономный интерфейс: честное отсутствие данных, безопасные ссылки и доступные фильтры.
{
  const missing = T.worldHtml({ id: 'empty', seed: '<seed>', durSec: 3302 }, [
    { nick: '<bot>', result: 'crash', note: 'бот не написал карточку', exitCode: 3221225786 }
  ]);
  assert(missing.includes('Хроника не записана') && missing.includes('Нет событий у 1 из 1 ботов'));
  assert(!missing.includes('aria-label="лента мира"'), 'декоративные SVG не создают вымышленную ось времени');
  assert(missing.includes('&lt;bot&gt;') && missing.includes('&lt;seed&gt;'), 'входные данные экранированы');
  assert(missing.includes('exit 3221225786'), 'код сбоя виден в карточке');
  assert(missing.includes('<td>—</td>'), 'неизвестный исход первой ночи не превращается в «нет»');
  assert(T.svgFor([]).includes('Нет событий') && !T.svgFor([]).includes('день 1'));
  const index = T.indexHtml([
    { id: 'old', bots: 2, deaths: 1, firstNight: 1, pointsAvg: -3, cheats: 0 },
    { id: 'broken', bots: 2, crashes: 2, cheats: 0 },
    { id: 'failed', serverOk: false }
  ]);
  assert(index.includes('Сбои: 2/2') && index.includes('Сервер не запущен'));
  assert(!index.includes('href="failed.html"'), 'нет ссылки на несуществующую ленту отказавшего сервера');
  assert(index.includes('data-points="-3"') && index.includes('data-filter="issues"'));
  assert(index.includes('aria-live="polite"') && index.includes('data-toolbar hidden'));
  assert(index.includes('<thead>') && index.includes('<tbody data-rows>') && index.includes('<th class="num">Медиана жизни</th>'));
  assert(index.includes('data-theme-toggle') && index.includes('prefers-reduced-motion'));
  // Только ПК: узкоэкранных брейкпоинтов и карточной вёрстки таблицы больше нет.
  assert(!index.includes('@media(max-width:') && !index.includes('@media(min-width:'), 'адаптивов под ширину экрана нет');
  assert(index.includes('body{min-width:1000px') && index.includes('content="width=1000"'), 'фиксированная десктопная ширина');
  assert(!index.includes('data-label=') && !index.includes('clamp('), 'нет мобильной разметки и размеров от вьюпорта');
  assert(index.includes('@media print') && index.includes('body{min-width:0;background:white'), 'печать не ломается минимальной шириной');
  const hostile = T.indexHtml([{ id: '<script>alert(1)</script>', seed: '\" onmouseover=\"alert(1)' }]);
  assert(!hostile.includes('<script>alert(1)</script>') && hostile.includes('&lt;script&gt;'));
  // Проверка синтаксиса встроенного JS без его выполнения и без зависимостей браузера.
  const script = index.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
  const mixed = T.svgFor([
    { nick: 'HC_1', pointsTotal: 4, events: [{ wt: 0, kind: 'start', text: 'старт' }, { wt: 30000, kind: 'death', text: 'смерть: Zombie' }] },
    { nick: 'HC_2', result: 'crash' }
  ]);
  assert(mixed.includes('HC_1 · 4 оч.') && mixed.includes('✕ смерть: Zombie, день 2'));
  assert(mixed.includes('нет событий: crash') && mixed.includes('день 1') && mixed.includes('день 2'));
  assert(!mixed.includes('NaN'), 'координаты ленты конечны');
  const capped = T.svgFor([{ nick: 'HC_1', wtStart: 0, wtEnd: 96000, events: [{ wt: 0, kind: 'start' }, { wt: 29900, kind: 'eat' }] }]);
  assert(capped.includes('день 4'), 'ось учитывает конец жизни после последнего события');
  const overlap = T.indexHtml([{ id: 'overlap', bots: 2, crashes: 1, cheats: 1 }]);
  assert(overlap.includes('data-filter="issues assisted"'), 'сбой и вмешательство не взаимоисключающие');
  console.log('автономный UI: empty state, статусы, фильтры, экранирование и SVG: OK');
}

// 7) собственные пиктограммы и портреты — inline, стабильны и не подменяют хронику.
{
  const cards = ['Krot', 'Shmel', 'Kaktus', 'Turbo', 'Zubilo', 'Glitch', 'Bagor', 'Pixel', 'Viper', 'Tormoz'].map(n => ({ nick: 'Uch_' + n, result: 'crash' }));
  const page = T.worldHtml({ id: 'portraits', seed: 42 }, cards);
  const avatars = [...page.matchAll(/<svg class="bot-avatar [\s\S]*?<\/svg>/g)].map(m => m[0]);
  assert.strictEqual(avatars.length, 20, 'портреты в панели участников и таблице');
  assert.strictEqual(new Set(avatars).size, 10, 'у каждой мухи свой портрет, в панели и таблице одинаковый');
  assert.strictEqual(page, T.worldHtml({ id: 'portraits', seed: 42 }, cards), 'оформление воспроизводимо');
  assert(page.includes('data-bot-focus="Uch_Krot"') && page.includes('aria-pressed="false" disabled'));
  assert(page.includes('data-icon="fly"') && page.includes('data-icon="moon"') && page.includes('data-icon="signal"'));
  assert(page.includes('data-theme-label') && page.includes('theme-moon') && page.includes('theme-sun'));
  assert(page.includes('rel="icon"') && page.includes('data:image/svg+xml,'), 'локальный SVG favicon');
  const archive = T.indexHtml([{ id: 'w1', seed: 42, bots: 10 }]);
  assert(archive.includes('class="habitat-art"') && archive.includes('aria-hidden="true"'));
  assert(!/<(?:script|img)[^>]+(?:src)=/i.test(archive), 'никаких внешних JS или картинок');
  const unknown = T.worldHtml({ id: 'unknown' }, [{ nick: 'X_\"<script>', result: 'crash' }]);
  assert(unknown.includes('data-avatar="X_&quot;&lt;script&gt;"') && !unknown.includes('<script>\"'));
  assert.doesNotThrow(() => new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]));
  console.log('авторская графика: 10 портретов, inline SVG, favicon и стабильность: OK');
}

// 8) карьера ботов: агрегаты по всем матчам, страницы, графика и интерактив без внешних зависимостей.
{
  const worlds = [
    { id: 'w1', serverOk: true }, { id: 'w2', serverOk: true }, { id: 'w3', serverOk: false }
  ];
  const lives = [
    { world: 'w1', nick: 'Uch_Krot', group: 'learn', mode: 'stage2', result: 'death', pointsTotal: 4, lifeSec: 120, gameDays: 1, firstNightSurvived: true, killCount: 1, events: [{ kind: 'start' }, { kind: 'death', wt: 1 }] },
    { world: 'w2', nick: 'Uch_Krot', group: 'control', mode: 'stage2', result: 'crash', lifeSec: 60, gameDays: 0, firstNightSurvived: false, events: [] },
    { world: 'w3', nick: 'Uch_Krot', group: 'learn', mode: 'stage1a', result: 'timeout', events: [{ kind: 'start', wt: 0 }] },
    { world: 'w1', nick: 'Kon_Viper', group: 'control', mode: 'stage2', result: 'death', pointsTotal: -6, lifeSec: 300, firstNightSurvived: true, events: [{ kind: 'shelter', wt: 0 }] },
    { world: 'w2', nick: 'Kon_Viper', group: 'control', mode: 'stage2', result: 'death', pointsTotal: 2, lifeSec: 180, firstNightSurvived: false, events: [{ kind: 'death', wt: 1 }] }
  ];
  const stats = T.botStats(lives, worlds);
  assert.strictEqual(stats.length, 2, 'по боту, а не по матчу');
  const krot = stats.find(s => s.nick === 'Uch_Krot'), viper = stats.find(s => s.nick === 'Kon_Viper');
  assert.strictEqual(krot.n, 3, 'все матчи бота');
  assert.strictEqual(krot.pointsN, 1, 'очки только там, где записаны');
  assert.strictEqual(krot.pointsAvg, 4, 'отсутствующие очки не превращаются в нули');
  assert.strictEqual(krot.nightYes, 1, 'подтверждённые ночи');
  assert.strictEqual(krot.nightN, 2, 'неизвестный исход не считается ночью');
  assert.strictEqual(krot.crashes, 1, 'сбой не равен смерти');
  assert.strictEqual(krot.deaths, 1, 'смерти посчитаны');
  assert.strictEqual(krot.group, 'смешанная', 'бот менял группу');
  assert.strictEqual(krot.streakBest, 1, 'сбой разрывает серию');
  assert.strictEqual(viper.pointsAvg, -2, 'среднее по отрицательным очкам');
  assert.strictEqual(viper.pointsBest, 2, 'лучший матч');
  assert.strictEqual(T.botFile('Uch_Krot'), T.botFile('Uch_Krot'), 'имя файла воспроизводимо');
  assert(/^bot-[a-z0-9_-]+-\w+\.html$/.test(T.botFile('<script>/../../evil')), 'имя файла безопасно');
  const hub = T.botsHtml(stats, worlds);
  assert(hub.includes('data-bot-rows') && (hub.match(/data-bot-row /g) || []).length === 2, 'таблица карьер');
  assert(hub.includes('data-hm-cell') && (hub.match(/data-hm-cell /g) || []).length === 6, 'теплокарта 2 бота × 3 мира');
  assert((hub.match(/data-bin /g) || []).length === 8, 'гистограмма с кликабельными корзинами');
  assert(hub.includes('data-compare-panel') && hub.includes('data-heat-mode') && hub.includes('data-bot-csv'), 'сравнение, раскраска и CSV');
  assert(hub.includes('data-bots-data') && hub.indexOf('data-bots-data') < hub.indexOf('data-bot-search'), 'данные идут до сценария');
  assert(!/<(?:script|img)[^>]+src=/i.test(hub), 'никаких внешних JS и картинок');
  assert(!hub.includes('@media(max-width:') && hub.includes('body{min-width:1000px'), 'только ПК');
  const page = T.botPageHtml(krot, stats, worlds);
  assert((page.match(/data-match-row /g) || []).length === 3, 'все матчи в таблице бота');
  assert(page.includes('data-career-data') && page.indexOf('data-career-data') < page.indexOf('data-metric'), 'данные графика до сценария');
  assert(page.includes('data-chart-box') && page.includes('data-chart-tip') && page.includes('data-match-csv'), 'график, подсказки и CSV');
  assert(page.includes('Достижения') && page.includes('Форма · последние'), 'достижения и форма');
  assert(page.includes('w1.html') && !page.includes('w3.html'), 'ссылка только на существующую ленту мира');
  assert(page.includes('bots.html?compare='), 'переход к сравнению с этим ботом');
  const hostile = T.botsHtml(T.botStats([{ world: 'w1', nick: '<img src=x onerror=1>', result: 'crash' }], worlds), worlds);
  assert(!hostile.includes('<img src=x') && hostile.includes('&lt;img'), 'враждебный ник экранирован');
  for (const [name, html] of [['хаб', hub], ['карточка', page]]) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(script), 'синтаксис встроенного JS: ' + name);
  }
  assert(T.indexHtml(worlds).includes('href="bots.html"') && T.worldHtml(worlds[0], lives.slice(0, 1)).includes('Карьера'), 'навигация между разделами');
  console.log('карьера ботов: агрегаты, страницы, экранирование и интерактив: OK');
}

console.log('hardcore_stage2_stand: OK');
