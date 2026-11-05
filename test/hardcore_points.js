// Офлайн-проверка счётчика очков жизни (этап 2, hardcore/points.js). Без mineflayer и без сервера.
'use strict';
const assert = require('assert');
const P = require('../hardcore/points');

// ступени: 1–5 по разу, 6-я не считается, повтор ничего не меняет
{
  const p = P.makePoints();
  for (let n = 1; n <= 6; n++) p.step(n, 0);
  assert.strictEqual(p.total, 5);
  p.step(1, 1);
  assert.strictEqual(p.total, 5);
  console.log('ступени: OK');
}

// ночи
{
  const p = P.makePoints();
  p.night(0); p.night(1);
  assert.strictEqual(p.total, 2);
  assert.strictEqual(p.toJSON().nights, 2);
  console.log('ночи: OK');
}

// убийства по оружию
{
  const p = P.makePoints();
  for (const w of ['fist', 'wooden_sword', 'golden_axe']) p.kill(w, 0, 'HC_2');
  assert.strictEqual(p.total, 3);
  const q = P.makePoints();
  for (const w of ['stone_sword', 'iron_axe', 'bow']) q.kill(w, 0, 'HC_2');
  assert.strictEqual(q.total, 6);
  assert.strictEqual(P.killPoints('crossbow'), 2); assert.strictEqual(P.killPoints('trident'), 2);
  assert.strictEqual(P.killPoints('mace'), 2); assert.strictEqual(P.killPoints(undefined), 1);
  console.log('убийства: OK');
}

// простой днём
{
  // стоит на месте с той же сумкой 0…240 с — −2 (на 120 и 240)
  const p = P.makePoints();
  for (let t = 0; t <= 240; t++) p.frame({ t, day: true, pos: [0, 64, 0], inv: { oak_log: 1 } });
  assert.strictEqual(p.total, -2);
  assert.deepStrictEqual(p.list.filter(x => x.kind === 'idle').map(x => x.t), [120, 240]);

  // сдвинулся на 4 блока на t=100 — первый −1 только на 220
  const m = P.makePoints();
  for (let t = 0; t <= 240; t++) m.frame({ t, day: true, pos: t < 100 ? [0, 64, 0] : [4, 64, 0], inv: { oak_log: 1 } });
  assert.deepStrictEqual(m.list.filter(x => x.kind === 'idle').map(x => x.t), [220]);

  // на t=110 бревно 1→2 — первый −1 только на 230
  const g = P.makePoints();
  for (let t = 0; t <= 240; t++) g.frame({ t, day: true, pos: [0, 64, 0], inv: { oak_log: t >= 110 ? 2 : 1 } });
  assert.deepStrictEqual(g.list.filter(x => x.kind === 'idle').map(x => x.t), [230]);

  // ночью простоя нет: 300 с на месте — 0
  const n = P.makePoints();
  for (let t = 0; t <= 300; t++) n.frame({ t, day: false, pos: [0, 64, 0], inv: { oak_log: 1 } });
  assert.strictEqual(n.total, 0);
  console.log('простой: OK');
}

// круг провалов: одно и то же дело три раза подряд — −1
{
  const a = P.makePoints();
  for (let i = 0; i < 3; i++) a.deed('collect_log', false, i);
  assert.strictEqual(a.total, -1);

  const b = P.makePoints();
  b.deed('k', false, 0); b.deed('k', false, 1); b.deed('k', true, 2); b.deed('k', false, 3);
  assert.strictEqual(b.total, 0);

  const c = P.makePoints();
  for (let i = 0; i < 6; i++) c.deed('k', false, i);
  assert.strictEqual(c.total, -2);

  const d = P.makePoints();
  ['a', 'b', 'a', 'b', 'a'].forEach((k, i) => d.deed(k, false, i));
  assert.strictEqual(d.total, -1);
  assert.strictEqual(d.list[0].note, 'a: 3 провала');
  console.log('круг провалов: OK');
}

console.log('hardcore_points: OK');
