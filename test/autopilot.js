// Офлайн-проверка цели мозга в автопилоте: parseGoal и ветка goal в decide
'use strict';
const assert = require('assert');
const { decide, parseGoal } = require('../lib/autopilot');

module.exports = async () => {
  const notes = '# x\n## Текущая цель\nЦель: камень\nАвтопилот: collect block=stone count=60\nШаги: 1\n\n## Указание\nАвтопилот: explore\n';
  assert.deepStrictEqual(parseGoal(notes), { name: 'collect', params: { block: 'stone', count: 60 }, sig: 'collect {"block":"stone","count":60}' });
  const g2 = parseGoal('## Текущая цель\n**Автопилот:** `build_hut x=-390 y=67 z=40 flag=true cells=[[1,2]]`\n');
  assert.deepStrictEqual(g2.params, { x: -390, y: 67, z: 40, flag: true, cells: [[1, 2]] }); assert.strictEqual(g2.name, 'build_hut');
  assert.strictEqual(parseGoal('## Другое\nАвтопилот: collect\n'), null);
  assert.strictEqual(parseGoal('## Текущая цель\nЦель: без строки\n## Дальше\nАвтопилот: collect\n'), null);

  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  assert.strictEqual(decide(base).name, 'day_routine');
  const goal = { name: 'collect', params: { block: 'stone', count: 60 }, kind: 'body', sig: 'x' };
  let a = decide({ ...base, goal }); assert(a.key === 'goal' && a.kind === 'body' && a.name === 'collect' && a.params.count === 60, 'goal body');
  a = decide({ ...base, goal: { ...goal, name: 'build_hut', kind: 'learned' } }); assert(a.key === 'goal' && a.kind === 'learned');
  assert.strictEqual(decide({ ...base, goal, goalDone: true }).name, 'day_routine', 'выполнена -> не повторять');
  assert.strictEqual(decide({ ...base, goal, blocked: { goal: true } }).name, 'day_routine', 'бэкофф -> day_routine');
  assert.notStrictEqual(decide({ ...base, goal, isNight: true, phase: 'ночь' }).key, 'goal', 'ночью цель не трогаем');
  assert.notStrictEqual((decide({ ...base, goal, hp: 5, hostilesNear: 2 }) || {}).key, 'goal', 'безопасность важнее');
  assert.strictEqual(decide({ ...base, goal, idle: false }), null, 'мозг активен');
  assert.strictEqual(decide({ ...base, goal, recoverable: true }).key, 'recover', 'recover раньше цели');
  console.log('autopilot goal: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
