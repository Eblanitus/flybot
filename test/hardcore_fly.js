// Офлайн-проверка бота этапа 1б (hardcore/fly.js): запускает тело и исполнитель FlyBot (здесь — поддельные),
// смотрит снимок как наблюдатель и пишет карточку: ступени 1–3 и 5, выход из укрытия, смерть с причиной, свои папки памяти.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../hardcore/lib');

assert.deepStrictEqual(L.stepsNow({ inv: { oak_log: 4 } }), [1]);
assert.deepStrictEqual(L.stepsNow({ inv: { birch_log: 2, crafting_table: 1, wooden_pickaxe: 1 }, food: 5 }), [2, 3, 5]);
assert.deepStrictEqual(L.stepsNow({ inv: { stone_pickaxe: 1, stone_sword: 1 }, tablePlaced: true, nightSurvived: true }), [2, 3, 4, 6]);
{
  const l = L.makeLadder();
  assert.deepStrictEqual(l.update({ inv: { oak_log: 5 } }, 30, 1500), [1]);
  assert.deepStrictEqual(l.update({ inv: {} }, 40, 1600), []);   // брёвна ушли на доски — ступень остаётся
  assert.deepStrictEqual(l.update({ inv: { wooden_pickaxe: 1 }, tablePlaced: true }, 90, 2900), [2, 3]);
  assert.strictEqual(l.top(), 3);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcfly-'));
  const out = path.join(dir, 'HC_7.json');
  const fakes = path.join(__dirname, 'hardcore_fakes');
  const ctlBase = 39000 + Math.floor(Math.random() * 1000);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'hardcore', 'fly.js'), '--name', 'HC_7', '--world', 'w1', '--seed', '5', '--out', out,
    '--ctlBase', String(ctlBase), '--runnerBase', String(ctlBase + 1000), '--joinSec', '15'],
  { env: Object.assign({}, process.env, { HC_FLY_BODY: path.join(fakes, 'fly_body.js'), HC_FLY_RUNNER: path.join(fakes, 'fly_runner.js') }), stdio: ['pipe', 'pipe', 'inherit'] });
  let log = ''; p.stdout.on('data', d => log += d);
  const code = await new Promise(r => p.on('exit', r));
  assert.strictEqual(code, 0, log);
  const c = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(c.result, 'death', JSON.stringify(c));
  assert.strictEqual(c.cause, 'Zombie');
  assert.strictEqual(c.mode, 'stage1b-flybot');
  assert.deepStrictEqual(Object.keys(c.ladder).map(Number).sort(), [1, 2, 3, 5], JSON.stringify(c.ladder));
  assert.strictEqual(c.topStep, 5);
  assert.strictEqual(c.exits.length, 1);
  assert(c.events.some(e => e.kind === 'stage' && /ступень 3/.test(e.text)) && c.events.some(e => e.kind === 'eat') && c.events.some(e => e.kind === 'leave'));
  assert(c.autopilot && c.autopilot.observerOnly === true, 'стенд спрашивает тело только как наблюдатель — автопилот не думает, что пришёл мозг');
  const life = path.join(dir, 'HC_7.fly');
  assert(fs.existsSync(path.join(life, 'notes.md')) && fs.existsSync(path.join(life, 'data')) && fs.existsSync(path.join(life, 'runner')));
  assert(/ступень 1/.test(log), log);
  // очки жизни (этап 2, А3): каждая ступень из лестницы (1–5) — +1; одно провалившееся дело круга не даёт
  assert(c.pointsTotal >= 1, JSON.stringify(c.points));
  assert.strictEqual(c.pointsTotal, c.points.total);
  const stepsInLadder = Object.keys(c.ladder).map(Number).filter(n => n <= 5).length;
  assert.strictEqual(c.points.byKind.step, stepsInLadder, JSON.stringify(c.points));
  assert.strictEqual(c.points.byKind.cycle, undefined, 'один провал — круга нет');
  assert(/очков \d+/.test(log), log);
  // Б9: дела жизни — deeds.jsonl, одна строка на дело; награда каждого дела = итог жизни (pointsTotal карточки)
  const deedLines = fs.readFileSync(path.join(life, 'deeds.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.strictEqual(deedLines.length, 1, JSON.stringify(deedLines));
  assert.strictEqual(deedLines[0].key, 'day_routine');
  assert.strictEqual(deedLines[0].r, c.pointsTotal, 'награда дела = итог жизни');
  assert.deepStrictEqual(c.deeds, { n: 1, explore: 0 });
  // В1: итог дела дописан в его строку — вердикт и время из события deed
  assert.strictEqual(deedLines[0].verdict, 'провал', JSON.stringify(deedLines[0]));
  assert.strictEqual(deedLines[0].sec, 3);
  console.log('дела жизни: deeds.jsonl, награда = итог жизни: OK');
  console.log('hardcore_fly: ok');
})().catch(e => { console.error(e); process.exit(1); });
