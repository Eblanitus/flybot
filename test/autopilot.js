// Офлайн-проверка цели мозга в автопилоте: parseGoal и ветка goal в decide
'use strict';
const assert = require('assert');
const { decide } = require('../behavior/autopilot');
const { parseGoal, parseBase, baseTravel } = require('../lib/basegoal');
const { Vec3 } = require('../lib/util');
const A = require('../lib/actions');

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
  // v0.2: ночью цель — только у базы (без «База:» или вне радиуса — нет)
  assert.notStrictEqual(decide({ ...base, goal, isNight: true, phase: 'ночь' }).key, 'goal', 'ночью без базы цель не трогаем');
  const nbs = { x: 0, y: 64, z: 0, r: 96 };
  assert.notStrictEqual(decide({ ...base, goal, isNight: true, phase: 'ночь', base: nbs, baseDist: 200, idleBuildMin: 30 }).key, 'goal', 'ночью вне базы цель не трогаем');
  assert.strictEqual(decide({ ...base, goal, isNight: true, phase: 'ночь', base: nbs, baseDist: 20, idleBuildMin: 30 }).key, 'goal', 'ночью у базы при простое — цель');
  assert.notStrictEqual((decide({ ...base, goal, hp: 5, hostilesNear: 2 }) || {}).key, 'goal', 'безопасность важнее');
  assert.strictEqual(decide({ ...base, goal, idle: false }), null, 'мозг активен');
  assert.strictEqual(decide({ ...base, goal, recoverable: true }).key, 'recover', 'recover раньше цели');
  console.log('autopilot goal: OK');

  // ---- база проекта ----
  assert.deepStrictEqual(parseBase('# x\nБаза: -393 67 36\n'), { x: -393, y: 67, z: 36, r: 96 });
  assert.deepStrictEqual(parseBase('текст\n- **База:** `-393 67 36 радиус=40`\n## Цель\nАвтопилот: explore\n'), { x: -393, y: 67, z: 36, r: 40 });
  assert.deepStrictEqual(parseBase('> База: 10, 64, -20 радиус=150'), { x: 10, y: 64, z: -20, r: 150 });
  assert.deepStrictEqual(parseBase('База: у реки\nБаза: 1 2 3\nБаза: 4 5 6'), { x: 1, y: 2, z: 3, r: 96 }, 'первая со словами пропущена, первая с числами');
  assert.strictEqual(parseBase('Автопилот: collect\nнет базы'), null);
  assert.strictEqual(parseBase(''), null);
  const bs = { x: -393, y: 67, z: 36, r: 96 };
  a = decide({ ...base, base: bs, baseDist: 180 });
  assert(a && a.key === 'go_base' && a.name === 'goto' && a.kind === 'body' && a.why === 'иду на базу' && a.params.x === -393 && a.params.y === 67 && a.params.z === 36 && a.params.timeout >= 300, 'далеко -> goto базы');
  a = decide({ ...base, base: bs, baseDist: 180, goal }); assert.strictEqual(a.key, 'go_base', 'база раньше цели мозга');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: 50 }).name, 'day_routine', 'близко -> как раньше');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: 50, goal }).key, 'goal', 'близко -> цель');
  assert.strictEqual(decide({ ...base }).name, 'day_routine', 'без базы -> как раньше');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: null }).name, 'day_routine', 'другое измерение -> как раньше');
  a = decide({ ...base, base: bs, baseDist: 180, isNight: true, phase: 'ночь' }); assert(a && a.key !== 'go_base' && a.name !== 'goto', 'ночью к базе не идём');
  assert.notStrictEqual((decide({ ...base, base: bs, baseDist: 180, hp: 5, hostilesNear: 2 }) || {}).key, 'go_base', 'безопасность важнее');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: 180, recoverable: true }).key, 'recover', 'recover раньше базы');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: 180, idle: false }), null, 'мозг активен');
  assert.strictEqual(decide({ ...base, base: bs, baseDist: 180, blocked: { go_base: true } }), null, 'пауза после провала -> не долбим и не уходим дальше');
  // baseTravel: скачки к базе (A.goto подменён)
  const bot = { entity: { position: new Vec3(0, 64, 400) } };
  const task = { check() {}, progress() {} };
  const oldGoto = A.goto; const hops = [];
  A.goto = async (ctx, t, goal) => { hops.push(goal.constructor.name); const dx = goal.x - bot.entity.position.x, dz = goal.z - bot.entity.position.z; bot.entity.position = new Vec3(goal.x, 64, goal.z); return true; };
  try {
    const r = await baseTravel({ bot }, task, { x: 0, y: 64, z: 0, r: 96, timeout: 420 });
    assert(r.arrived && hops.length >= 6 && hops[hops.length - 1] === 'GoalNear' && hops[0] === 'GoalNearXZ', JSON.stringify({ r, hops }));
    A.goto = async () => { throw new Error('нет пути'); };
    bot.entity.position = new Vec3(0, 64, 300);
    await assert.rejects(baseTravel({ bot }, task, { x: 0, y: 64, z: 0, r: 96, timeout: 420 }), /на базу не дошла: нет пути/);
  } finally { A.goto = oldGoto; }
  console.log('autopilot base: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
