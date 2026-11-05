// Офлайн-проверка решателя дел (этап 2, шаг Б4): чистые функции hardcore/decider.js, без mineflayer.
'use strict';
const assert = require('assert');
const D = require('../hardcore/decider');

const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

// обстановка: ночь, в укрытии, HP 20, каменная кирка, врагов нет, пустыня
const sit = D.sitOf({ isNight: true, sheltered: true, hp: 20, tools: { pickaxe: 2 }, enemies: [], hostilesNear: 0 }, 'desert');
assert.strictEqual(sit.key, 'night|shelter|high|stone|none|dry');
assert.strictEqual(D.biomeGroup('badlands'), 'dry');
assert.strictEqual(D.biomeGroup('something_new'), 'other');
console.log('sitOf и биомы: OK');

// без памяти и без проб берём кандидата с наибольшим prior — как pick() сейчас
{
  const opts = [{ key: 'a', prior: 0.2 }, { key: 'b', prior: 0.6 }, { key: 'c', prior: 0.4 }];
  assert.strictEqual(D.pickOption(opts, {}, { rate: 0 }).key, 'b');
}
console.log('холодный старт: OK');

// память: у b десять запусков со средним 3 очка, у a подсказка 0.5 без опыта — берём b
{
  const opts = [{ key: 'a', prior: 0.5 }, { key: 'b', prior: 0.3 }];
  const st = { b: { n: 10, sum: 30 } };
  assert.strictEqual(D.pickOption(opts, st, { rate: 0 }).key, 'b');
}
console.log('опыт перевешивает подсказку: OK');

// пробы: rate 1 и rnd 0 — берём новичка (b, запусков меньше 5), explore true
{
  const opts = [{ key: 'a', prior: 0.5 }, { key: 'b', prior: 0.3 }];
  const st = { a: { n: 10, sum: 10 } };
  const ch = D.pickOption(opts, st, { rate: 1, rnd: () => 0 });
  assert.strictEqual(ch.key, 'b'); assert.strictEqual(ch.explore, true);
}
// calm: false — проб нет даже при rate 1
{
  const opts = [{ key: 'a', prior: 0.5 }, { key: 'b', prior: 0.3 }];
  const ch = D.pickOption(opts, { a: { n: 10, sum: 10 } }, { rate: 1, calm: false, rnd: () => 0 });
  assert.strictEqual(ch.explore, false);
  assert.strictEqual(ch.key, 'a');
}
console.log('пробы и calm: OK');

// доля проб: 30% без опыта, 10% к 200 делам, 20% на 100
near(D.exploreRate(0), 0.30);
near(D.exploreRate(200), 0.10);
near(D.exploreRate(100), 0.20);
console.log('доля проб: OK');

// статистика: в точной обстановке у дела 1 запуск (мало), в грубой 10 — берём грубую
{
  const mem = { exact: { K: { a: { n: 1, sum: 1 } } }, coarse: { C: { a: { n: 10, sum: 50 } } } };
  const st = D.statsFor(mem, { key: 'K', coarse: 'C' });
  assert.deepStrictEqual(st.a, { n: 10, sum: 50 });
}
console.log('точная или грубая обстановка: OK');

// награда дела — итог жизни, всем делам одинаково
{
  const rw = D.rewards([{ key: 'a' }, { key: 'b' }], 5);
  assert.strictEqual(rw[0].r, 5); assert.strictEqual(rw[1].r, 5);
  assert.strictEqual(rw[0].key, 'a');
}
console.log('награда: OK');

console.log('hardcore_decider: OK');
