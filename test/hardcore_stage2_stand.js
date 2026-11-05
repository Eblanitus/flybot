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

console.log('hardcore_stage2_stand: OK');
