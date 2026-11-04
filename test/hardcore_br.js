// Офлайн-проверка этапа 1в — баттл-рояль мух (hardcore/br.js, hardcore/fly.js --br, правило «мухи — законные цели» в lib/aggressors.js).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BR = require('../hardcore/br');
const L = require('../hardcore/lib');

// расстановка: 5 мух, каждая пара в 100–300 блоках
{
  let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const r = BR.spawnPoints(5, { min: 100, max: 300, rand });
  assert(r.ok && r.points.length === 5, JSON.stringify(r));
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    const d = Math.hypot(r.points[i].x - r.points[j].x, r.points[i].z - r.points[j].z);
    assert(d >= 100 && d <= 300, `пара ${i}-${j}: ${d}`);
  }
  assert.strictEqual(BR.pairError([{ x: 0, z: 0 }, { x: 50, z: 0 }], 100, 300), 50);
}
// кто кого убил
assert.deepStrictEqual(BR.parseKill('HC_2 was slain by HC_4 using Stone Sword'), { victim: 'HC_2', killer: 'HC_4' });
assert.deepStrictEqual(BR.parseKill('[12:00] [Server thread/INFO]: HC_1 was shot by HC_3'), { victim: 'HC_1', killer: 'HC_3' });
assert.deepStrictEqual(BR.parseKill('HC_1 drowned whilst trying to escape HC_2'), { victim: 'HC_1', killer: 'HC_2' });
assert.strictEqual(BR.parseKill('HC_2 was slain by Zombie'), null);
assert.strictEqual(BR.parseKill('HC_1 joined the game'), null);
assert.strictEqual(BR.weaponOf({ name: 'stone_sword' }), 'stone_sword');
assert.strictEqual(BR.weaponOf({ name: 'oak_log' }), 'fist');
assert.strictEqual(BR.weaponOf(null), 'fist');
// решения охотника
{
  const base = { hp: 20, food: 20, lifeSec: 30, armed: true, isNight: false, busy: false, seen: [], ours: null };
  assert.strictEqual(BR.huntDecision(base).act, 'none');
  assert.strictEqual(BR.huntDecision({ ...base, seen: [{ name: 'HC_2', d: 150, ago: 5 }] }).act, 'follow');
  assert.deepStrictEqual(BR.huntDecision({ ...base, seen: [{ name: 'HC_2', d: 6, ago: 0 }] }).act, 'fight');
  assert.strictEqual(BR.huntDecision({ ...base, armed: false, seen: [{ name: 'HC_2', d: 150, ago: 5 }] }).act, 'none', 'без оружия — готовится');
  assert.strictEqual(BR.huntDecision({ ...base, armed: false, lifeSec: 700, seen: [{ name: 'HC_2', d: 150, ago: 5 }] }).act, 'follow', 'срок подготовки вышел');
  assert.strictEqual(BR.huntDecision({ ...base, hp: 8, seen: [{ name: 'HC_2', d: 6, ago: 0 }], ours: { kind: 'follow', target: 'HC_2', sec: 10 } }).act, 'stop', 'мало HP — бросить');
  assert.strictEqual(BR.huntDecision({ ...base, busy: true, seen: [{ name: 'HC_2', d: 6, ago: 0 }] }).act, 'none', 'рефлекс не перебиваем');
  assert.strictEqual(BR.huntDecision({ ...base, isNight: true, seen: [{ name: 'HC_2', d: 150, ago: 5 }] }).act, 'none', 'ночью далеко не ходим');
  assert.strictEqual(BR.huntDecision({ ...base, seen: [{ name: 'HC_2', d: 150, ago: 500 }] }).act, 'none', 'старая метка забыта');
  assert.strictEqual(BR.huntDecision({ ...base, seen: [{ name: 'HC_2', d: 150, ago: 5 }], ours: { kind: 'follow', target: 'HC_2', sec: 999 } }).act, 'stop');
}
// сводка мира
{
  const w = L.summarizeWorld([{ nick: 'HC_1', br: true, killCount: 2, killsArmed: 1, result: 'death' }, { nick: 'HC_2', br: true, killCount: 0, result: 'death' }]);
  assert.strictEqual(w.kills, 2); assert.strictEqual(w.killsArmed, 1); assert.strictEqual(w.topKiller, 'HC_1');
  assert.deepStrictEqual(w.killsByNick, { HC_1: 2, HC_2: 0 });
  assert.strictEqual(L.summarizeWorld([{ nick: 'HC_1', result: 'death' }]).kills, undefined, 'без баттл-рояля полей нет');
  assert(L.worldProperties({ levelName: 'w', port: 1, bots: 5, battleRoyale: true, botMode: '1b', brViewDistance: 20 }, '1')['view-distance'] === 20);
  assert(L.worldProperties({ levelName: 'w', port: 1, bots: 5, battleRoyale: true, botMode: '1a' }, '1')['view-distance'] === undefined);
}
// мухи — законные цели только с HC_BR_PREFIX и только чужие
{
  const AG = path.join(__dirname, '..', 'lib', 'aggressors.js');
  const load = env => { delete require.cache[require.resolve(AG)]; const old = process.env.HC_BR_PREFIX; if (env) process.env.HC_BR_PREFIX = env; else delete process.env.HC_BR_PREFIX; const m = require(AG); if (old != null) process.env.HC_BR_PREFIX = old; else delete process.env.HC_BR_PREFIX; return m; };
  const ctx = { bot: { username: 'HC_1' } };
  const on = load('HC_');
  assert(on.isAggressor(ctx, 'HC_2') && !on.isAggressor(ctx, 'HC_1') && !on.isAggressor(ctx, 'Steve'));
  const off = load(null);
  assert(!off.isAggressor(ctx, 'HC_2'), 'у FlyBot без переменной — как было');
  delete require.cache[require.resolve(AG)];
}

// fly.js --br с поддельным телом: охотник видит HC_9 в 8 м на локаторе → fight; убийство засчитано один раз, с мечом
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcbr-'));
  const out = path.join(dir, 'HC_7.json');
  const fakes = path.join(__dirname, 'hardcore_fakes');
  const ctlBase = 41000 + Math.floor(Math.random() * 1000);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'hardcore', 'fly.js'), '--name', 'HC_7', '--world', 'w1', '--seed', '5', '--out', out,
    '--ctlBase', String(ctlBase), '--runnerBase', String(ctlBase + 1000), '--joinSec', '15', '--br', 'HC_'],
  { env: Object.assign({}, process.env, { HC_FLY_BODY: path.join(fakes, 'fly_body.js'), HC_FLY_RUNNER: path.join(fakes, 'fly_runner.js') }), stdio: ['pipe', 'pipe', 'inherit'] });
  let log = ''; p.stdout.on('data', d => log += d);
  await new Promise((resolve, reject) => { const t = setTimeout(() => { p.kill(); reject(new Error('fly.js не вышел: ' + log)); }, 30000); p.on('exit', () => { clearTimeout(t); resolve(); }); });
  const c = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(c.mode, 'stage1v-br');
  assert.strictEqual(c.killCount, 1, JSON.stringify(c.kills));
  assert.strictEqual(c.kills[0].victim, 'HC_9'); assert.strictEqual(c.kills[0].weapon, 'stone_sword'); assert.strictEqual(c.killsArmed, 1);
  assert.strictEqual(c.killedBy, 'HC_8');
  assert.strictEqual(c.cause, 'HC_8');
  assert(c.events.some(e => e.kind === 'kill' && /HC_9/.test(e.text)), 'убийство в ленте');
  const cmds = c.autopilot.cmds;
  const fight = cmds.find(x => x.action === 'fight');
  assert(fight && fight.params.target === 'HC_9' && fight.ua === 'hc-hunter', JSON.stringify(cmds));
  assert(!cmds.some(x => x.params && (x.params.target === 'HC_5' || x.params.name === 'HC_5')), 'HC_5 вне конуса локатора — не цель');
  assert(c.hunt.fights >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('hardcore_br: ok');
})().catch(e => { console.error(e); process.exit(1); });
