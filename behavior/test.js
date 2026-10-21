// Офлайн-проверка поведения (без бота и сервера): ядро зовёт её перед включением новой версии (selfTest).
// Должна быть быстрой (< 15 с) и бросать исключение, если что-то не так.
'use strict';
const assert = require('assert');
const { decide } = require('./autopilot');
const R = require('./reflexes');
const T = require('./thresholds');
const zones = require('./zones');

module.exports = async function selfTest() {
  // пороги — числа
  for (const [k, v] of Object.entries(T)) assert(typeof v === 'number' && Number.isFinite(v), 'порог ' + k + ' не число');
  // запретные зоны — список коробок/шаров
  assert(Array.isArray(zones), 'zones — не список');
  // автопилот: день без забот -> дневная работа; враг-агрессор -> драка; мало HP -> укрытие; мозг занял тело -> ничего
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  assert.strictEqual(decide(base).name, 'day_routine');
  assert.strictEqual(decide({ ...base, enemies: [{ name: 'Bob', d: 5, why: 'бил', aggressor: true }] }).key, 'fight_player');
  assert.strictEqual(decide({ ...base, hp: 5 }).key, 'lowhp_shelter');
  assert.strictEqual(decide({ ...base, task: { name: 'collect', source: 'brain' } }), null);
  assert.strictEqual(decide({ ...base, on: false }), null);
  // еда: лучшая по качеству, гнилое мясо — только с голоду
  const bot = { registry: { foodsByName: { bread: { effectiveQuality: 11 }, rotten_flesh: { effectiveQuality: 4 }, cooked_beef: { effectiveQuality: 20 } } },
    inventory: { items: () => [{ name: 'rotten_flesh', count: 3 }, { name: 'bread', count: 1 }, { name: 'cooked_beef', count: 1 }] } };
  assert.strictEqual(R.pickFood(bot).name, 'cooked_beef');
  const bot2 = { ...bot, inventory: { items: () => [{ name: 'rotten_flesh', count: 3 }] } };
  assert.strictEqual(R.pickFood(bot2), null);
  assert.strictEqual(R.pickFood(bot2, { desperate: true }).name, 'rotten_flesh');
  return { ok: true };
};
