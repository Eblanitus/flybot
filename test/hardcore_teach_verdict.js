// Офлайн-проверка вердикта правки учителя (этап 2, шаг В3): средние групп А и Б по мирам, вердикт после n миров, после вердикта правку никому не даём.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TEACH = require('../hardcore/teach');
const S = require('../hardcore/stand');

// 1) verdictOf: рано — null; три мира — «оставить» или «откат» по средним
assert.strictEqual(TEACH.verdictOf({ worlds: [{ A: 3, B: 2 }, { A: 3, B: 3 }] }, 3), null, 'два мира — рано');
assert.strictEqual(TEACH.verdictOf({ worlds: [{ A: 3, B: 2 }, { A: 3, B: 3 }, { A: 4, B: 3 }] }, 3), 'оставить', 'А 3/3/4 против Б 2/3/3');
assert.strictEqual(TEACH.verdictOf({ worlds: [{ A: 2, B: 3 }, { A: 2, B: 3 }, { A: 3, B: 3 }] }, 3), 'откат', 'А 2/2/3 против Б 3/3/3');
assert.strictEqual(TEACH.verdictOf({ worlds: [{ A: 3, B: null }, { A: 3, B: 3 }, { A: 3, B: 3 }] }, 3), null, 'мир без группы Б не считаем — ждём ещё');
console.log('verdictOf: рано — null; оставить и откат по средним: OK');

// 2) teachAfterWorld: по мирам — в result.json, после третьего — вердикт; потом правку не даём и ничего не пишем
const dirOf = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const cardsOf = (a, b) => [
  { nick: 'HC_1', teachGroup: 'A', pointsTotal: a }, { nick: 'HC_2', teachGroup: 'A', pointsTotal: a },
  { nick: 'HC_6', teachGroup: 'B', pointsTotal: b }, { nick: 'HC_7', teachGroup: 'B', pointsTotal: b },
  { nick: 'HC_9', group: 'control', pointsTotal: 9 }
];
function run(scores, label) {
  const dir = dirOf('hcverdict-');
  try {
    const cfg = { ...S.DEFAULTS, stage2: true, dataDir: dir, teach: { id: 't1', worlds: 3 } };
    const logs = [];
    const log = m => logs.push(m);
    const file = path.join(dir, 'teach', 't1', 'result.json');
    const verdicts = scores.map((s, i) => S.teachAfterWorld(cfg, `w${i + 1}`, cardsOf(s.A, s.B), log));
    const res = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(verdicts, [null, null, res.verdict], label + ': вердикт только после третьего мира');
    assert.strictEqual(res.worlds.length, 3, 'по миру на каждый мир проверки');
    assert.deepStrictEqual(res.worlds[0], { world: 'w1', A: scores[0].A, B: scores[0].B }, 'средние групп за мир');
    assert(S.teachDone(cfg), 'после вердикта проверка готова');
    assert.strictEqual(S.teachGroupOf(cfg, 'HC_1'), null, 'после вердикта правку никому не даём');
    // четвёртый мир после вердикта — ничего не пишем и ничего не возвращаем
    const before = fs.readFileSync(file, 'utf8');
    assert.strictEqual(S.teachAfterWorld(cfg, 'w4', cardsOf(9, 9), log), null);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'после вердикта файл не меняется');
    assert(logs.some(m => m.includes(`мир w3 — А ${scores[2].A.toFixed(1)}, Б ${scores[2].B.toFixed(1)} (миров 3 из 3) — ${res.verdict}`)), logs.join(' | '));
    return res.verdict;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
assert.strictEqual(run([{ A: 3, B: 2 }, { A: 3, B: 3 }, { A: 4, B: 3 }], 'оставить'), 'оставить');
assert.strictEqual(run([{ A: 2, B: 3 }, { A: 2, B: 3 }, { A: 3, B: 3 }], 'откат'), 'откат');
console.log('teachAfterWorld: по мирам в result.json, вердикт на третьем, после него — тишина: OK');

console.log('hardcore_teach_verdict: OK');
