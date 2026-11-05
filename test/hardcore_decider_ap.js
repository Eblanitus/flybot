// Офлайн-проверка решателя в автопилоте (этап 2, шаг Б5): decide(s, out) отдаёт всех кандидатов, choose() выбирает по опыту,
// deed_start пишется только на этапе 2.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AP = require('../behavior/autopilot');
const D = require('../hardcore/decider');

// дневное базовое состояние — как в test/autopilot.js
const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
  blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
  freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
const fakeCtx = { bot: { entity: { position: {} }, blockAt: () => ({ biome: { name: 'plains' } }) } };

delete process.env.HC_STAGE2;
delete process.env.HC_DECIDER_MEM;
process.env.HC_EXPLORE = '0';

// 1) decide(s, out): все кандидаты в out.cands; ответ — кандидат с наибольшим счётом
{
  const out = {};
  const act = AP.decide({ ...base }, out);
  assert(out.cands && out.cands.length >= 2, 'кандидатов не меньше 2: ' + (out.cands && out.cands.length));
  const top = out.cands.reduce((a, b) => (b.score > a.score ? b : a));
  assert.strictEqual(act.key, top.act.key);
  assert(out.cands.some(c => c.act.key === 'explore'), 'в списке есть explore');
  console.log('decide отдаёт кандидатов: OK');
}

// 2) choose без памяти и без проб — тот же ключ, что дал decide
{
  D._reset();
  const out = {};
  const act = AP.decide({ ...base }, out);
  const ch = D.choose(fakeCtx, { ...base }, act, out);
  assert.strictEqual(ch.key, act.key);
  console.log('choose без памяти — как decide: OK');
}

// 3) с памятью: у второго кандидата (explore) 10 запусков со средним 3 очка в этой обстановке — выбирает его
{
  const out = {};
  const act = AP.decide({ ...base }, out);
  const second = out.cands.find(c => c.act.key === 'explore');
  const sit = D.sitOf({ ...base }, 'plains');
  assert.strictEqual(sit.key, 'day|open|high|none|none|plain');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcdec-'));
  const mem = path.join(dir, 'decider.json');
  fs.writeFileSync(mem, JSON.stringify({ exact: { [sit.key]: { explore: { n: 10, sum: 30 } } }, coarse: {} }));
  process.env.HC_DECIDER_MEM = mem;
  D._reset();
  const ch = D.choose(fakeCtx, { ...base }, act, out);
  assert.strictEqual(ch.key, 'explore', 'по опыту выбран explore: ' + ch.key + ' (кандидат ' + second.score + ')');
  assert(/решатель/.test(ch.why), ch.why);
  assert.strictEqual(ch.sit, sit.key);
  delete process.env.HC_DECIDER_MEM;
  D._reset();
  console.log('choose по памяти: OK');
}

// 4) deed_start: только на этапе 2, с обстановкой дела
async function startOnce(withStage2, act) {
  const events = [];
  const ctx = { events: { push: (type, data) => events.push({ type, ...data }) }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0 };
  const ap = AP.create(ctx);
  ctx.runSkill = async () => ({ ok: true });
  if (withStage2) process.env.HC_STAGE2 = '1'; else delete process.env.HC_STAGE2;
  ap._start(act);
  await ap.running.promise;
  delete process.env.HC_STAGE2;
  return events;
}
(async () => {
  const act = { key: 'collect_log', kind: 'body', name: 'collect', params: {}, why: 'тест', sit: 'day|open|high|none|none|plain' };
  let ev = await startOnce(true, act);
  const ds = ev.filter(e => e.type === 'deed_start');
  assert.strictEqual(ds.length, 1, 'на этапе 2 — deed_start');
  assert.strictEqual(ds[0].sit, 'day|open|high|none|none|plain');
  assert.strictEqual(ds[0].key, 'collect_log');
  console.log('deed_start на этапе 2: OK');

  ev = await startOnce(false, act);
  assert.strictEqual(ev.filter(e => e.type === 'deed_start').length, 0, 'без этапа 2 — нет deed_start');
  console.log('без этапа 2 — нет deed_start: OK');

  console.log('hardcore_decider_ap: OK');
})().catch(e => { console.error(e); process.exit(1); });
