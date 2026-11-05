// Офлайн-проверка правки учителя (этап 2, шаг В2): группы А и Б, папка навыков с правкой, подписи в ленте, варианты решателя.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../hardcore/stand');
const TEACH = require('../hardcore/teach');
const T = require('../hardcore/timeline');
const D = require('../hardcore/decider');

const val = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const has = (args, flag) => args.includes(flag);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcteach-'));

try {
  // 1) botArgs: группа А (HC_1–HC_5) — папка с правкой и --teach t1:A; группа Б (HC_6–HC_8) — --teach t1:B без папки; контроль — ничего
  const cfg = { ...S.DEFAULTS, bots: 10, controlBots: 2, stage2: true, pool: true, battleRoyale: true, botMode: '1b', botPrefix: 'HC_',
    dataDir: dir, teach: { id: 't1', offer: ['new_skill'], worlds: 3 } };
  const w = { id: 'w1', seed: 5 };
  const card = path.join(dir, 'HC_x.json');
  const a1 = S.botArgs(cfg, w, 'HC_1', card);
  assert.strictEqual(val(a1, '--learned'), path.join(dir, 'teach', 't1', 'learned'));
  assert.strictEqual(val(a1, '--teach'), 't1:A');
  assert.strictEqual(val(a1, '--offer'), 'new_skill');
  assert.strictEqual(val(a1, '--group'), 'learn');
  assert(has(a1, '--shared'), 'группа А учится с общей памятью: ' + a1.join(' '));
  assert.strictEqual(val(S.botArgs(cfg, w, 'HC_5', card), '--teach'), 't1:A', 'HC_5 — последняя из группы А');
  const a6 = S.botArgs(cfg, w, 'HC_6', card);
  assert.strictEqual(val(a6, '--teach'), 't1:B');
  assert(!has(a6, '--learned') && !has(a6, '--offer'), 'группа Б без правки: ' + a6.join(' '));
  assert(has(a6, '--shared'));
  const a10 = S.botArgs(cfg, w, 'HC_10', card);
  assert(!has(a10, '--teach') && !has(a10, '--learned') && !has(a10, '--offer'), 'контроль без правки: ' + a10.join(' '));
  console.log('botArgs: А — папка с правкой и t1:A, Б — t1:B без папки, контроль — ничего: OK');

  // 2) после вердикта (result.json) аргументов правки нет; учащиеся идут как обычно
  fs.mkdirSync(path.join(dir, 'teach', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teach', 't1', 'result.json'), JSON.stringify({ verdict: 'оставить' }));
  const done = S.botArgs(cfg, w, 'HC_1', card);
  assert(!has(done, '--teach') && !has(done, '--learned'), 'с готовым вердиктом правки нет: ' + done.join(' '));
  assert(has(done, '--shared') && val(done, '--group') === 'learn');
  assert.strictEqual(S.teachGroupOf(cfg, 'HC_1'), null);
  fs.rmSync(path.join(dir, 'teach', 't1', 'result.json'));
  console.log('с готовым result.json аргументов правки нет: OK');

  // 3) папка навыков группы А: копия brain/learned и файл правки поверх (одноимённый заменяет базовый, новый добавляется)
  const base = path.join(dir, 'base'), over = path.join(dir, 'overlay'), out = path.join(dir, 'out');
  fs.mkdirSync(base); fs.mkdirSync(over);
  fs.writeFileSync(path.join(base, 'a.js'), 'base a'); fs.writeFileSync(path.join(base, 'b.js'), 'base b');
  fs.writeFileSync(path.join(over, 'a.js'), 'правка a'); fs.writeFileSync(path.join(over, 'new_skill.js'), 'новый');
  const names = TEACH.buildLearned(base, over, out).sort();
  assert.deepStrictEqual(names, ['a.js', 'new_skill.js'], 'файлы правки');
  assert.strictEqual(fs.readFileSync(path.join(out, 'a.js'), 'utf8'), 'правка a', 'правка поверх базового');
  assert.strictEqual(fs.readFileSync(path.join(out, 'b.js'), 'utf8'), 'base b', 'остальные — из базы');
  assert.strictEqual(fs.readFileSync(path.join(out, 'new_skill.js'), 'utf8'), 'новый', 'новый навык добавлен');
  const none = TEACH.buildLearned(base, path.join(dir, 'нет_правки'), path.join(dir, 'out2'));
  assert.deepStrictEqual(none, [], 'без правки — только копия базы');
  assert(fs.existsSync(path.join(dir, 'out2', 'b.js')));
  console.log('папка навыков группы А: правка поверх копии, без правки — только база: OK');

  // 4) подписи в ленте: у А — «учится, правка t1 (А)», у Б — «учится, без правки t1 (Б)»
  const cards = [
    { nick: 'HC_1', group: 'learn', teach: 't1', teachGroup: 'A', result: 'death', pointsTotal: 7, lifeSec: 600, events: [{ wt: 13000, kind: 'night', text: 'ночь' }] },
    { nick: 'HC_7', group: 'learn', teach: 't1', teachGroup: 'B', result: 'death', pointsTotal: 4, lifeSec: 500, events: [{ wt: 13000, kind: 'night', text: 'ночь' }] }
  ];
  const svg = T.svgFor(cards);
  assert(svg.includes('учится, правка t1 (А)'), 'подпись группы А');
  assert(svg.includes('учится, без правки t1 (Б)'), 'подпись группы Б');
  console.log('лента: подписи группы А и Б: OK');

  // 5) решатель: новые навыки правки — кандидаты с подсказкой 0 (только с HC_TEACH_OFFER), заблокированный не предлагаем
  process.env.HC_TEACH_OFFER = 'new_skill,other';
  const opts = D.teachOptions({ blocked: {} });
  assert.deepStrictEqual(opts.map(o => o.key), ['teach:new_skill', 'teach:other']);
  assert(opts.every(o => o.prior === 0 && o.act.kind === 'learned' && o.act.name === o.key.slice('teach:'.length)));
  assert.strictEqual(D.teachOptions({ blocked: { 'teach:other': true } }).length, 1, 'заблокированный не предлагаем');
  delete process.env.HC_TEACH_OFFER;
  assert.deepStrictEqual(D.teachOptions({ blocked: {} }), [], 'без HC_TEACH_OFFER — ничего');
  console.log('решатель: навыки правки только с HC_TEACH_OFFER: OK');

  console.log('hardcore_teach: OK');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
