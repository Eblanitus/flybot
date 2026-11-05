// Офлайн-проверка охоты как дела (этап 2, шаг Б6): hunt_go в списке решателя; fly.js на этапе 2 не шлёт команд охотника.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const D = require('../hardcore/decider');
const BR = require('../hardcore/br');

process.env.HC_BR_PREFIX = 'HC_';
const ctxAt = (x, z) => ({ bot: { username: 'HC_1', entity: { position: { x, y: 64, z } } } });
const sReady = { hp: 20, food: 20, hasWeapon: true, isNight: false };
const row = (over = {}) => ({ name: 'HC_2', d: 40, at: [40, 64, 0], onBar: true, hidden: null, gamemode: null, ...over });

// муха HC_2 в 40 м по оси x: hunt_go с goto в её сторону, подсказка 0.40
D._reset();
let h = D.huntOption(ctxAt(0, 0), sReady, [row()]);
assert(h && h.key === 'hunt_go' && h.act.kind === 'body' && h.act.name === 'goto', JSON.stringify(h));
assert.strictEqual(h.act.params.x, 40); assert.strictEqual(h.act.params.z, 0);
assert.strictEqual(h.prior, 0.40);
console.log('охота днём: hunt_go к мухе: OK');

// goto идёт до расстояния боя (дошла = 8 м), а не вплотную: раньше r 4 → «дошла» только с 2 м, у другой мухи падало «нет продвижения, осталось 3 м»
assert(h.act.params.r >= 16, 'goto до расстояния боя: ' + JSON.stringify(h.act.params));

// муха рядом и видна телу (12 м) — дело погони сразу бой: fight тела с этой мухой (разбор 1-го мира этапа 2: удара не было ни разу)
D._reset();
{
  const vec = (x, y, z) => ({ x, y, z, distanceTo: q => Math.hypot(q.x - x, q.y - y, q.z - z) });
  const ctx = { bot: { username: 'HC_1', entity: { position: vec(0, 64, 0) }, players: { HC_2: { entity: { position: vec(12, 64, 0) } } } } };
  h = D.huntOption(ctx, sReady, [row({ d: 12, at: [12, 64, 0] })]);
  assert(h && h.key === 'hunt_go' && h.act.kind === 'body' && h.act.name === 'fight' && h.act.params.target === 'HC_2', JSON.stringify(h));
  assert.strictEqual(h.prior, 0.40);
  // та же муха в 40 м (видна, но дальше погони боя) — снова goto
  D._reset();
  ctx.bot.players.HC_2.entity.position = vec(40, 64, 0);
  h = D.huntOption(ctx, sReady, [row()]);
  assert(h && h.act.name === 'goto', JSON.stringify(h));
}
console.log('муха рядом — бой, дальше — подход: OK');

// ночью и 40 м — hunt_go есть, но подсказка низкая (запрета нет, муху не ограничиваем)
D._reset();
h = D.huntOption(ctxAt(0, 0), { ...sReady, isNight: true }, [row()]);
assert(h && h.prior === 0.05, JSON.stringify(h));
console.log('ночью далеко — низкая подсказка, не запрет: OK');

// муха прячется (hidden: 'sneak') — цели нет
D._reset();
assert.strictEqual(D.huntOption(ctxAt(0, 0), sReady, [row({ hidden: 'sneak' })]), null);
console.log('прячущаяся муха — не цель: OK');

// чужой ник (не префикс HC_) — не цель
D._reset();
assert.strictEqual(D.huntOption(ctxAt(0, 0), sReady, [row({ name: 'Steve' })]), null);
console.log('чужой ник — не цель: OK');

// без готовности (нет оружия, HP 10) подсказка низкая
D._reset();
h = D.huntOption(ctxAt(0, 0), { ...sReady, hp: 10, hasWeapon: false }, [row()]);
assert(h && h.prior === 0.05, JSON.stringify(h));
console.log('не готова — низкая подсказка: OK');

// без HC_BR_PREFIX охоты как дела нет вовсе
{
  const pref = process.env.HC_BR_PREFIX; delete process.env.HC_BR_PREFIX;
  D._reset();
  assert.strictEqual(D.huntOption(ctxAt(0, 0), sReady, [row()]), null);
  process.env.HC_BR_PREFIX = pref;
  console.log('без баттл-рояля — охоты нет: OK');
}

// fly.js на этапе 2 с поддельным телом (муха HC_9 на локаторе в 8 м): команд охотника нет, причина — этап 2
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchunt-'));
  const out = path.join(dir, 'HC_7.json');
  const fakes = path.join(__dirname, 'hardcore_fakes');
  const ctlBase = 43000 + Math.floor(Math.random() * 1000);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'hardcore', 'fly.js'), '--name', 'HC_7', '--world', 'w1', '--seed', '5', '--out', out,
    '--ctlBase', String(ctlBase), '--runnerBase', String(ctlBase + 1000), '--joinSec', '15', '--br', 'HC_', '--stage2', '1'],
  { env: Object.assign({}, process.env, { HC_FLY_BODY: path.join(fakes, 'fly_body.js'), HC_FLY_RUNNER: path.join(fakes, 'fly_runner.js') }), stdio: ['pipe', 'pipe', 'inherit'] });
  let log = ''; p.stdout.on('data', d => log += d);
  const code = await new Promise(r => p.on('exit', r));
  assert.strictEqual(code, 0, log);
  const c = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert(c.autopilot && Array.isArray(c.autopilot.cmds), 'в снимке тела есть журнал команд');
  assert.strictEqual(c.autopilot.cmds.length, 0, 'на этапе 2 охотник не шлёт команд: ' + JSON.stringify(c.autopilot.cmds));
  assert(c.hunt && /этап 2/.test(c.hunt.lastWhy || ''), JSON.stringify(c.hunt));
  console.log('fly на этапе 2: команд охотника нет: OK');
  console.log('hardcore_hunt_deed: OK');
})().catch(e => { console.error(e); process.exit(1); });
