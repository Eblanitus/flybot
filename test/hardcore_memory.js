// Офлайн-проверка общей памяти мух (этап 2, шаг Б10): разница жизни — в общие файлы, дела — в таблицу решателя, копия жизни при запуске fly.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const M = require('../hardcore/memory');

// 1) addDelta: разница жизни (end − start) прибавляется к общей; новые ключи появляются; без хвостов float
{
  const shared = { n: 2 };
  M.addDelta(shared, { n: 2 }, { n: 5 });
  assert.strictEqual(shared.n, 5);
  M.addDelta(shared, { n: 2 }, { n: 5 });           // вторая жизнь с тем же стартом — ещё +3
  assert.strictEqual(shared.n, 8);
  const s2 = {};
  M.addDelta(s2, {}, { fam: { key: { v: { n: 1, ok: 1, sum: 0.5 } } } });
  assert.deepStrictEqual(s2, { fam: { key: { v: { n: 1, ok: 1, sum: 0.5 } } } });
  const s3 = { sum: 0.1 };
  M.addDelta(s3, { sum: 0 }, { sum: 0.2 });
  assert.strictEqual(s3.sum, 0.3);
  console.log('addDelta: разница жизни прибавляется, новые ключи, без хвостов float: OK');
}

// 2) foldDeeds: строки дел — в точную и грубую таблицу решателя: n и сумма итогов; строки без обстановки пропускаем
{
  const SIT = 'day|open|high|none|none|plain', CO = 'day|none|none';
  const mem = M.foldDeeds({ exact: {}, coarse: {} }, [
    { key: 'day_routine', sit: SIT, coarse: CO, r: 6 },
    { key: 'day_routine', sit: SIT, coarse: CO, r: 4 },
    { key: 'explore', sit: SIT, coarse: CO, r: 1 },
    { key: 'bad' }
  ]);
  assert.deepStrictEqual(mem.exact[SIT].day_routine, { n: 2, sum: 10 });
  assert.deepStrictEqual(mem.coarse[CO].day_routine, { n: 2, sum: 10 });
  assert.deepStrictEqual(mem.exact[SIT].explore, { n: 1, sum: 1 });
  assert.strictEqual(Object.keys(mem.exact).length, 1);
  console.log('foldDeeds: дела — в точную и грубую таблицу, n и сумма: OK');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcmem-'));
  try {
    // 3) жизнь: копия при старте (и снимок «как было»), изменения жизни — разницей в общие файлы, дела — в decider.json
    const shared = path.join(dir, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'variants.json'), JSON.stringify({ stats: { fam: { k: { v: { n: 2, ok: 1, sum: 1.5 } } } }, recent: [] }));
    fs.writeFileSync(path.join(shared, 'experience.json'), JSON.stringify({ stats: { 'k|x': { walk: { n: 3, survived: 3, died: 0, hp: 9 } } }, recent: [] }));
    const life = path.join(dir, 'HC_1.fly');
    M.prepareLife(shared, life);
    const lifeV = JSON.parse(fs.readFileSync(path.join(life, 'data', 'variants.json'), 'utf8'));
    assert.strictEqual(lifeV.stats.fam.k.v.n, 2, 'копия легла в data/');
    assert(fs.existsSync(path.join(life, 'start_variants.json')) && fs.existsSync(path.join(life, 'start_experience.json')), 'снимок старта на месте');

    // жизнь «поработала»: +3 к варианту, +1 к опыту (hp +3), два дела в таблице решателя
    lifeV.stats.fam.k.v = { n: 5, ok: 4, sum: 3.5 };
    fs.writeFileSync(path.join(life, 'data', 'variants.json'), JSON.stringify(lifeV));
    const lifeE = JSON.parse(fs.readFileSync(path.join(life, 'data', 'experience.json'), 'utf8'));
    lifeE.stats['k|x'].walk = { n: 4, survived: 4, died: 0, hp: 12 };
    fs.writeFileSync(path.join(life, 'data', 'experience.json'), JSON.stringify(lifeE));
    const SIT = 'day|open|high|none|none|plain', CO = 'day|none|none';
    fs.writeFileSync(path.join(life, 'deeds.jsonl'), [
      { key: 'day_routine', sit: SIT, coarse: CO, r: 7 },
      { key: 'day_routine', sit: SIT, coarse: CO, r: 7 }
    ].map(x => JSON.stringify(x)).join('\n') + '\n');

    const rows = M.mergeLife(shared, life);
    assert.strictEqual(rows, 2);
    const sv = JSON.parse(fs.readFileSync(path.join(shared, 'variants.json'), 'utf8'));
    assert.deepStrictEqual(sv.stats.fam.k.v, { n: 5, ok: 4, sum: 3.5 }, 'общие счётчики выросли ровно на разницу жизни');
    assert.deepStrictEqual(sv.recent, [], 'recent не сливаем');
    const se = JSON.parse(fs.readFileSync(path.join(shared, 'experience.json'), 'utf8'));
    assert.deepStrictEqual(se.stats['k|x'].walk, { n: 4, survived: 4, died: 0, hp: 12 });
    const dec = JSON.parse(fs.readFileSync(path.join(shared, 'decider.json'), 'utf8'));
    assert.deepStrictEqual(dec.exact[SIT].day_routine, { n: 2, sum: 14 });
    assert.deepStrictEqual(dec.coarse[CO].day_routine, { n: 2, sum: 14 });
    console.log('prepareLife + mergeLife: разница жизни в общие файлы, дела — в decider.json: OK');

    // 4) fly с --shared: жизнь получает копию общей памяти до старта тела (проверяем после конца жизни)
    const before = fs.readFileSync(path.join(shared, 'variants.json'), 'utf8');
    const out = path.join(dir, 'HC_8.json');
    const fakes = path.join(__dirname, 'hardcore_fakes');
    const ctlBase = 44000 + Math.floor(Math.random() * 1000);
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'hardcore', 'fly.js'), '--name', 'HC_8', '--world', 'w1', '--seed', '5', '--out', out,
      '--ctlBase', String(ctlBase), '--runnerBase', String(ctlBase + 1000), '--joinSec', '15', '--shared', shared],
    { env: Object.assign({}, process.env, { HC_FLY_BODY: path.join(fakes, 'fly_body.js'), HC_FLY_RUNNER: path.join(fakes, 'fly_runner.js') }), stdio: ['pipe', 'pipe', 'inherit'] });
    let log = ''; p.stdout.on('data', d => log += d);
    const code = await new Promise(r => p.on('exit', r));
    assert.strictEqual(code, 0, log);
    const flyLife = path.join(dir, 'HC_8.fly');
    assert.deepStrictEqual(fs.readFileSync(path.join(flyLife, 'data', 'variants.json'), 'utf8'), before, 'жизнь получила копию общей памяти');
    assert.deepStrictEqual(fs.readFileSync(path.join(flyLife, 'start_variants.json'), 'utf8'), before, 'и снимок старта');
    assert(fs.existsSync(path.join(flyLife, 'start_experience.json')), 'снимок опыта тоже');
    console.log('fly с --shared: жизнь получила копию общей памяти: OK');
    console.log('hardcore_memory: OK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
