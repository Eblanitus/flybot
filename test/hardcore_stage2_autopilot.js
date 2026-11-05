// Офлайн-проверка правок автопилота под этап 2 (шаг Б3): пауза после побега не запрещает работу, ворота простоя 3 с.
'use strict';
const assert = require('assert');
const AP = require('../behavior/autopilot');

// базовое дневное состояние — как в test/autopilot.js
const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
  blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
  freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
// после неудачного побега от игрока: пауза побега (blocked + failInfo), как в разборе стояний 04.11
const afterEscape = { ...base, failInfo: { escape_player: { reason: 'побег не оторвал от врага', count: 2 } }, blocked: { escape_player: true } };

// без этапа 2 — пауза побега запрещает всю работу
delete process.env.HC_STAGE2;
const a0 = AP.decide(afterEscape);
assert(!a0 || a0.name !== 'day_routine', 'без HC_STAGE2 работы нет: ' + (a0 && a0.name));
console.log('без HC_STAGE2 — работы нет: OK');

// с этапом 2 — работа есть (день: day_routine), и это не побег
process.env.HC_STAGE2 = '1';
const a1 = AP.decide(afterEscape);
assert(a1 && a1.name === 'day_routine', 'с HC_STAGE2 работа: ' + (a1 && a1.name));
assert(!/escape/.test(a1.key || '') && a1.name !== 'escape', 'это не побег');
console.log('с HC_STAGE2 — работа не побег: OK');

// ворота простоя: 3 с с переменной, 30 с без неё
assert.strictEqual(AP.idleMsNow(), 3000);
delete process.env.HC_STAGE2;
assert.strictEqual(AP.idleMsNow(), AP.IDLE_MS);
assert.strictEqual(AP.IDLE_MS, 30000);
console.log('ворота простоя: OK');

console.log('hardcore_stage2_autopilot: OK');
