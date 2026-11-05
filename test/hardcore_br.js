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
  assert.strictEqual(BR.pairError([{ x: 0, z: 0 }, { x: 400, z: 0 }], 100, 300), 200, 'соседка дальше 300');
  // 10 мух (хозяин 04.11): все пары ≥ 100, у каждой ближайшая соседка ≤ 300
  const r10 = BR.spawnPoints(10, { min: 100, max: 300, rand });
  assert(r10.ok && r10.points.length === 10, JSON.stringify(r10));
  for (const a of r10.points) {
    const ds = r10.points.filter(b => b !== a).map(b => Math.hypot(a.x - b.x, a.z - b.z));
    assert(Math.min(...ds) >= 100 && Math.min(...ds) <= 300, JSON.stringify(ds));
  }
}
// перенос на точку: команда по номеру попытки и ответ сервера (05.11 — «Could not spread» у воды)
{
  assert.strictEqual(BR.spreadCmd({ x: -227, z: -32 }, 'HC_1'), 'spreadplayers -227 -32 0 1 false HC_1');
  assert.strictEqual(BR.spreadCmd({ x: -227, z: -32 }, 'HC_1', 1), 'spreadplayers -227 -32 0 24 false HC_1');
  assert.strictEqual(BR.spreadCmd({ x: 5, z: 6 }, 'HC_1', 99), `spreadplayers 5 6 0 ${BR.SPREAD_RADII[BR.SPREAD_RADII.length - 1]} false HC_1`);
  assert.deepStrictEqual(BR.parseSpread('[21:00:48] [Server thread/INFO]: Could not spread 1 entity/entities around -226.5, -31.5 (too many entities for space - try using spread of at most 0.00)'), { ok: false, x: -227, z: -32 });
  assert.deepStrictEqual(BR.parseSpread('[21:01:26] [Server thread/INFO]: Spread 1 entity/entities around -535.5, 160.5 with an average distance of 0.00 block(s) apart'), { ok: true, x: -536, z: 160 });
  assert.deepStrictEqual(BR.parseSpread('[..]: Spread 1 entity/entities around 65.5, -136.5 with an average distance of 0.00 block(s) apart'), { ok: true, x: 65, z: -137 });
  assert.strictEqual(BR.parseSpread('[..]: got: spreadplayers 1 2 0 1 false HC_1'), null);
  assert.strictEqual(BR.parseSpread('HC_1 joined the game'), null);
  // 05.11: вода у точки — новая точка на том же расстоянии от центра, не ближе min к другим мухам
  {
    const orig = { x: 300, z: -400 }, others = [{ x: -500, z: 0 }, { x: 0, z: 600 }];
    for (let k = 0; k < 50; k++) {
      const q = BR.repickPoint(orig, others, { min: 300 });
      assert(Math.abs(Math.hypot(q.x, q.z) - 500) < 1.5, 'то же расстояние: ' + JSON.stringify(q));
      assert(others.every(o => Math.hypot(o.x - q.x, o.z - q.z) >= 300), 'не ближе 300 к другим: ' + JSON.stringify(q));
    }
    // 05.11 лог хозяина: 465 -131 → 461 -144 → 474 -94 (рядом с водной точкой, потому что только там нет мух ближе 300). Теперь бросок не короче 300
    const dense = [{ x: -309, z: 362 }, { x: -160, z: -145 }, { x: 186, z: -258 }, { x: -442, z: 75 }, { x: 112, z: 458 }, { x: -36, z: -476 }, { x: -16, z: 177 }, { x: 347, z: 230 }, { x: -423, z: -486 }];
    for (let k = 0; k < 200; k++) {
      const w = { x: 465, z: -131 }, q = BR.repickPoint(w, dense, { min: 300, from: w });
      assert(Math.hypot(q.x - w.x, q.z - w.z) >= 300, 'бросок не короче 300 от водной точки: ' + JSON.stringify(q));
      assert(Math.abs(Math.hypot(q.x, q.z) - Math.hypot(w.x, w.z)) < 1.5, 'то же расстояние от центра');
    }
    const c = BR.repickPoint({ x: 10, z: 0 }, [], { minR: 150 });
    assert(Math.abs(Math.hypot(c.x, c.z) - 150) < 1.5, 'у самого центра — не ближе minR');
    assert(BR.REPICK_MAX >= 5 && BR.REPICK_MAX <= 50);
  }
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

// 04.11 разбор миров 1в: чат кладёт своё поле id в событие — номер журнала не затирается (иначе /events?since= терял «slain»)
{
  const { EventHub } = require('../lib/events');
  const h = new EventHub(50);
  for (let i = 0; i < 30; i++) h.push('info', { msg: 'x' + i });
  const ev = h.push('chat', { kind: 'system', from: null, text: 'HC_2 was slain by HC_4', id: 3 });
  assert.strictEqual(ev.id, 31); assert.strictEqual(ev.ref, 3);
  assert(h.since(30).some(e => e.text === 'HC_2 was slain by HC_4'), 'slain доходит до /events?since=');
}

// 04.11: расстановка ×3 — 10 мух, не ближе 300, ближайшая соседка не дальше 900 (по умолчанию)
{
  let seed = 11; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const r = BR.spawnPoints(10, { rand });
  assert(r.ok, 'расстановка 300–900 для 10 мух');
  for (let i = 0; i < 10; i++) {
    let near = Infinity;
    for (let j = 0; j < 10; j++) if (i !== j) { const d = Math.hypot(r.points[i].x - r.points[j].x, r.points[i].z - r.points[j].z); assert(d >= 300, `пара ${i}-${j}: ${d}`); near = Math.min(near, d); }
    assert(near <= 900, `у ${i} соседка в ${near}`);
  }
}

// 04.11: дальняя муха — метка сервера tracked_waypoint (позиции сущности нет). Блок, чанк, азимут (yaw: 0 — юг +Z, π/2 — запад −X)
{
  const LOC = require('../lib/locator');
  const { EventEmitter } = require('events');
  const client = new EventEmitter();
  const bot = { _client: client, username: 'HC_1', entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    players: { HC_2: { username: 'HC_2', uuid: 'aaaa-bb', gamemode: 0 }, HC_3: { username: 'HC_3', uuid: 'cccc-dd', gamemode: 0 }, HC_4: { username: 'HC_4', uuid: 'eeee-ff', gamemode: 0 } } };
  LOC.attachWaypoints(bot);
  client.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid: 'AAAA-BB', type: 'azimuth', data: 0 } });
  client.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid: 'cccc-dd', type: 'chunk', data: { chunkX: 0, chunkZ: 20 } } });
  client.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid: 'eeee-ff', type: 'vec3i', data: { x: 0, y: 64, z: -400 } } });
  let bar = LOC.playersOnBar({ bot });
  const by = n => bar.find(x => x.name === n);
  assert(by('HC_2') && by('HC_2').d === null && by('HC_2').far && by('HC_2').onBar && by('HC_2').heading[1] === 1, JSON.stringify(by('HC_2')));
  assert(by('HC_3') && Math.round(by('HC_3').d) === 328 && by('HC_3').onBar, JSON.stringify(by('HC_3')));
  assert(by('HC_4') && Math.round(by('HC_4').d) === 400 && !by('HC_4').onBar, 'сзади — не на панели');
  assert.deepStrictEqual(bar.map(x => x.name), ['HC_3', 'HC_4', 'HC_2'], 'без расстояния — последней');
  client.emit('tracked_waypoint', { operation: 'untrack', waypoint: { hasUUID: true, uuid: 'aaaa-bb', type: 'empty' } });
  bar = LOC.playersOnBar({ bot });
  assert(!bar.some(x => x.name === 'HC_2'), 'untrack — метки нет');
  const w = LOC.waypointGeo({ azimuth: Math.PI / 2 }, { x: 0, y: 0, z: 0 });
  assert(Math.abs(w.dx + 1) < 1e-9 && Math.abs(w.dz) < 1e-9, 'азимут π/2 — запад');
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
  // тело получает адрес своего исполнителя навыков (04.11: комментарий съел RUNNER_URL — выученные навыки шли на :3200)
  assert.strictEqual(c.autopilot.runnerUrl, `http://127.0.0.1:${ctlBase + 1000 + 7}`);
  assert.strictEqual(c.autopilot.mcVersion, '26.1');
  const cmds = c.autopilot.cmds;
  const fight = cmds.find(x => x.action === 'fight');
  assert(fight && fight.params.target === 'HC_9' && fight.ua === 'hc-hunter', JSON.stringify(cmds));
  assert(!cmds.some(x => x.params && (x.params.target === 'HC_5' || x.params.name === 'HC_5')), 'HC_5 вне конуса локатора — не цель');
  assert(c.hunt.fights >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('hardcore_br: ok');
})().catch(e => { console.error(e); process.exit(1); });
