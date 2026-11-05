// Офлайн-проверка базы очков и признака «готово» (этап 2, шаг А5): hardcore/baseline.js на подделанных строках worlds.jsonl.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../hardcore/baseline');

// база: среднее по 3 последним мирам с pointsAvg (1, 2, 3 → 2); миры без очков пропускаются
const worlds = [{ id: 'a', pointsAvg: 1 }, { id: 'b', pointsAvg: 2 }, { id: 'c', pointsAvg: 3 }];
const base = B.baselineOf(worlds, 3);
assert.strictEqual(base.pointsAvg, 2);
assert.deepStrictEqual(base.worlds, ['a', 'b', 'c']);
assert.strictEqual(B.baselineOf([{ id: 'old' }], 3), null, 'мир без очков — базы нет');
assert.strictEqual(B.baselineOf([{ id: 'old' }, { id: 'x', pointsAvg: 4 }], 3).pointsAvg, 4, 'старый мир без очков пропущен');
console.log('база: OK');

// признак «готово»: учащиеся 4, 5, 4 при базе 2 — готово; 4, 3, 5 — нет (2 × 2 = 4)
const mk = (id, learn) => ({ id, pointsAvg: 2, pointsByGroup: { learn, control: 2 } });
const b2 = { pointsAvg: 2 };
assert.strictEqual(B.checkDone([mk('1', 4), mk('2', 5), mk('3', 4)], b2).done, true);
assert.strictEqual(B.checkDone([mk('1', 4), mk('2', 3), mk('3', 5)], b2).done, false);
assert.strictEqual(B.checkDone([mk('1', 9), mk('2', 9)], b2).done, false, 'два мира — мало, нужно 3');
assert.strictEqual(B.checkDone([mk('1', 9), mk('2', 9), mk('3', 9)], null).done, false, 'без базы — не готово');
assert.strictEqual(B.checkDone([{ id: 'x', pointsAvg: 9 }, mk('1', 4), mk('2', 5), mk('3', 4)], b2).rows.length, 3, 'миры без учащихся не считаем');
console.log('готово: OK');

// строки worlds.jsonl: одна JSON-строка на мир; пустые и битые строки пропускаются, остальные миры читаются
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcbase-'));
  const f = path.join(dir, 'worlds.jsonl');
  fs.writeFileSync(f, JSON.stringify({ id: 'w1', pointsAvg: 2 }) + '\n\n{битая строка\n' + JSON.stringify({ id: 'w2', pointsAvg: 4 }) + '\n');
  const ws = B.readWorlds(f);
  assert.deepStrictEqual(ws.map(w => w.id), ['w1', 'w2']);
  assert.deepStrictEqual(B.readWorlds(path.join(dir, 'нет.jsonl')), []);
  console.log('worlds.jsonl: OK');
}

console.log('hardcore_baseline: OK');
