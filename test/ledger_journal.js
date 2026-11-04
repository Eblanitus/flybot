// Журнал ресурсов по времени (lib/ledger.js, FLYBOT_LEDGER_LOG / opts.journal) — для хардкор-стенда (разбор 04.11):
// строка на каждое изменение сумки (что, сколько, причина, вся сумка, в руке), свой удар (по кому, чем, сумка), удар по мне, смерть.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Vec3 } = require('../lib/util');
const { Ledger } = require('../lib/ledger');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledj-'));
const journal = path.join(dir, 'inventory.jsonl');
const bot = new EventEmitter();
const inv = {};
let attacked = null;
Object.assign(bot, {
  health: 20, food: 18, foodSaturation: 2, entity: { id: 1, position: new Vec3(0, 64, 0) }, time: { day: 1, timeOfDay: 13000 },
  heldItem: null, attack: t => { attacked = t; },
  inventory: { items: () => Object.entries(inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })), slots: [] },
  registry: { blocksByName: {}, items: {}, foodsByName: { bread: {} } }
});
const clock = { t: Date.parse('2026-11-04T10:00:00Z') };
const ctx = { bot, ready: true, dataDir: dir, events: { push() {} }, tasks: { current: null, legacy: null } };
const led = new Ledger(ctx, { file: path.join(dir, 'ledger.json'), now: () => clock.t, journal });
const session = { timers: [] };
led.attach(session); session.timers.forEach(clearInterval);
const step = () => { clock.t += 500; led.tick(); };
inv.dirt = 3;
for (let i = 0; i < 8; i++) step();                       // стартовая сумка — не изменение
ctx.tasks.current = { name: 'craft', by: 'autopilot' };
inv.oak_planks = 4; inv.wooden_sword = 1; step();
ctx.tasks.current = null;
bot.heldItem = { name: 'wooden_sword' };
bot.attack({ username: 'HC_2', position: new Vec3(3, 64, 0) });
bot.emit('entityHurt', bot.entity);
inv.dirt = 1; step();
bot.emit('death');
const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(l => JSON.parse(l));
assert.strictEqual(attacked && attacked.username, 'HC_2', 'настоящий attack вызван');
const inv1 = rows.find(r => r.ev === 'inv' && r.task === 'craft');
assert(inv1 && inv1.changes.some(c => c.item === 'wooden_sword' && c.n === 1 && c.reason === 'crafted'), JSON.stringify(rows));
assert.deepStrictEqual(inv1.inv, { dirt: 3, oak_planks: 4, wooden_sword: 1 });
const hit = rows.find(r => r.ev === 'hit');
assert(hit && hit.target === 'HC_2' && hit.hand === 'wooden_sword' && hit.d === 3 && hit.inv.wooden_sword === 1 && hit.hp === 20, JSON.stringify(hit));
assert(rows.some(r => r.ev === 'hurt' && r.hand === 'wooden_sword'));
const lost = rows.find(r => r.ev === 'inv' && r.changes.some(c => c.item === 'dirt' && c.n === -2));
assert(lost && lost.inv.dirt === 1, 'ушло 2 земли — видно');
const death = rows.find(r => r.ev === 'death');
assert(death && death.inv.wooden_sword === 1 && death.inv.dirt === 1 && death.hand === 'wooden_sword', JSON.stringify(death));
assert.strictEqual(rows.length, 5, 'без лишних строк: ' + rows.map(r => r.ev).join(','));
fs.rmSync(dir, { recursive: true, force: true });
console.log('ledger_journal: ok');
