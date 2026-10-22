// Офлайн-проверка текста инвентаря для мозга (invSummary): слияние стеков, порядок, инструменты не режутся
'use strict';
const assert = require('assert');
const { invSummary, shelterInfo } = require('../lib/perception');
const { Vec3 } = require('../lib/util');

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
  // «в укрытии»: крыша + 8 клеток стен; открытые стороны названы
  const box = new Set(['0,66,0']); for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const h of [64, 65]) box.add(`${dx},${h},${dz}`);
  const mk = set => ({ bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: p => ({ name: set.has(`${p.x},${p.y},${p.z}`) || p.y < 64 ? 'stone' : 'air', boundingBox: set.has(`${p.x},${p.y},${p.z}`) || p.y < 64 ? 'block' : 'empty' }) } });
  let sh = shelterInfo(mk(box)); assert(sh.closed && sh.roof && sh.walls === 8 && !sh.open.length && sh.skill === false, JSON.stringify(sh));
  box.delete('0,66,0'); box.delete('0,65,-1');
  sh = shelterInfo(mk(box)); assert(!sh.closed && !sh.roof && sh.walls === 7 && sh.open[0] === 'север (голова)', JSON.stringify(sh));
  console.log('perception: OK');
};
