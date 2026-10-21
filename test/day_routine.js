// Офлайн-проверка медной ветки day_routine на фальшивом api: плавка меди -> медные кирка и броня; железо заменяет медь
'use strict';
const assert = require('assert');
const skill = require('../brain/learned/day_routine');
const COST = { copper_pickaxe: 3, copper_boots: 4, copper_helmet: 5, copper_leggings: 7, copper_chestplate: 8 };

function mk(inv, blocks, armor = []) {
  const items = { ...inv }; const calls = [];
  const api = {
    log() {},
    async snapshot() { return { inventory: Object.entries(items).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })), armor, health: 20, food: 20, eyes: { time: { phase: 'день', nightIn: 900 }, blocks, animals: [] } }; },
    async cmd(action, p) {
      calls.push(action + ':' + (p.item || p.block || ''));
      if (action === 'collect' && p.block === 'copper') items.raw_copper = (items.raw_copper || 0) + 12;
      else if (action === 'smelt') { items.copper_ingot = (items.copper_ingot || 0) + p.count; items.raw_copper -= p.count; }
      else if (action === 'craft') { if (!(p.item in COST) || (items.copper_ingot || 0) < COST[p.item]) throw new Error('нет'); items.copper_ingot -= COST[p.item]; items[p.item] = 1; }
      else if (action === 'explore') { /* ок */ }
    }
  };
  return { api, items, calls };
}

module.exports = async () => {
  const base = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, furnace: 1, cobblestone: 30, coal: 8, iron_pickaxe: 0 };
  // медь видна, железа нет: сбор -> плавка -> кирка и броня дёшево вперёд
  let h = mk({ ...base }, { copper_ore: { d: 5 } });
  let r = await skill.run(h.api, { max_sec: 60 });
  assert(h.calls.includes('collect:copper') && h.calls.includes('smelt:copper_ingot') && h.calls.includes('craft:copper_pickaxe'), h.calls.join());
  assert(h.items.copper_pickaxe === 1 && h.items.copper_boots === 1, JSON.stringify(h.items));
  // слитки уже есть, руда не нужна: кирка, потом ботинки (дешевле шлема); ничего не собираем
  h = mk({ ...base, copper_ingot: 7 }, {});
  await skill.run(h.api, { max_sec: 60 });
  assert(!h.calls.includes('collect:copper') && h.items.copper_pickaxe === 1 && h.items.copper_boots === 1 && !h.items.copper_helmet, JSON.stringify(h.items));
  // железная кирка уже есть — медь пропускаем
  h = mk({ ...base, iron_pickaxe: 1, copper_ingot: 20 }, { copper_ore: { d: 5 } });
  await skill.run(h.api, { max_sec: 60 });
  assert(!h.calls.some(c => /copper/.test(c)), h.calls.join());
  // железный шлем надет, медная кирка есть: медный шлем не крафтим
  h = mk({ ...base, copper_pickaxe: 1, copper_ingot: 5 }, {}, ['iron_helmet']);
  await skill.run(h.api, { max_sec: 60 });
  assert(!h.calls.includes('craft:copper_helmet'), h.calls.join());
  console.log('day_routine: OK');
};
