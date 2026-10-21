// Офлайн-проверка текста инвентаря для мозга (invSummary): слияние стеков, порядок, инструменты не режутся
'use strict';
const assert = require('assert');
const { invSummary } = require('../lib/perception');

module.exports = async () => {
  // живой случай: кирка и булыжник не должны теряться; стеки сливаются
  const live = [['dirt', 17], ['cobblestone', 60], ['diorite', 4], ['stone_pickaxe', 1], ['cobblestone', 36], ['torch', 4], ['torch', 4], ['granite', 1], ['brown_mushroom', 1]]
    .map(([name, count]) => ({ name, count }));
  const t = invSummary(live, 'stone_pickaxe', {});
  assert(t.startsWith('stone_pickaxex1 cobblestonex96 torchx8'), t);
  assert(!/…и ещё/.test(t) && /dirtx17/.test(t), t);
  assert.strictEqual(invSummary([], null, {}), 'пусто');

  // 40 видов мусора: режется только мусор, снаряжение/еда/руда/слитки всегда на месте
  const junk = Array.from({ length: 40 }, (_, i) => ({ name: 'junk_' + i, count: 1 + i }));
  const must = [{ name: 'copper_pickaxe', count: 1 }, { name: 'iron_chestplate', count: 1 }, { name: 'bread', count: 3 }, { name: 'raw_copper', count: 7 }, { name: 'iron_ingot', count: 2 }, { name: 'diamond', count: 1 }, { name: 'coal_ore', count: 2 }];
  const s = invSummary(junk.concat(must), null, { bread: {} });
  for (const m of must) assert(s.includes(m.name + 'x' + m.count), m.name + ' пропал: ' + s);
  assert(/…и ещё \d+ видов$/.test(s), s);
  assert(s.indexOf('bread') < s.indexOf('raw_copper') && s.indexOf('copper_pickaxe') < s.indexOf('bread'), 'порядок: ' + s);
  assert(s.split(' ').length <= 30, 'длина');
  console.log('perception: OK');
};
