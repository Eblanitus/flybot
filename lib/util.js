// Общие помощники: паузы, числа, направления, классификация существ, имена блоков.
'use strict';
const { Vec3 } = require('vec3');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Безопасное число: NaN/undefined -> значение по умолчанию, плюс ограничение диапазона.
function num(v, def, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function r1(x) { return Math.round(x * 10) / 10; }

// Ошибка прерывания навыка (stop, смерть, опасность)
class Aborted extends Error {
  constructor(reason) { super(reason || 'прервано'); this.name = 'Aborted'; this.aborted = true; }
}

// Ошибка "провал навыка" с человекочитаемой причиной
class SkillError extends Error {
  constructor(msg, extra) { super(msg); this.name = 'SkillError'; this.extra = extra || null; }
}

// Направление по сторонам света (в Minecraft север = -Z, восток = +X)
const DIRS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
function dirName(from, to) {
  const dx = to.x - from.x; const dz = to.z - from.z; const dy = to.y - from.y;
  let s;
  if (Math.abs(dx) < 0.8 && Math.abs(dz) < 0.8) s = 'тут';
  else {
    const ang = Math.atan2(dx, -dz); // 0 = север, по часовой
    const i = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
    s = DIRS[i];
  }
  if (dy > 2.5) s += '↑'; else if (dy < -2.5) s += '↓';
  return s;
}

function entName(e) {
  if (!e) return 'unknown';
  return String(e.username || e.name || e.mobType || 'unknown').toLowerCase();
}

// В 26.1: враждебные мобы имеют type 'hostile'; 'mob' — только ~10 существ (голем, гаст, слизень...)
// Нейтральные/опасные для драки — не трогать автоматически.
const NEVER_AUTO = new Set([
  'enderman', 'piglin', 'zombified_piglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon',
  'creaking', 'giant', 'elder_guardian', 'iron_golem', 'snow_golem', 'copper_golem', 'allay',
  'villager', 'wandering_trader', 'happy_ghast'
]);
const EXTRA_HOSTILE = new Set(['slime', 'magma_cube', 'ghast', 'phantom', 'shulker', 'hoglin']);

function isHostile(e) {
  if (!e || e.type === 'player') return false;
  const n = entName(e);
  return e.type === 'hostile' || EXTRA_HOSTILE.has(n);
}
// Цель для автоматической атаки (рефлекс/fight без имени)
function isAutoTarget(e) {
  if (!isHostile(e)) return false;
  return !NEVER_AUTO.has(entName(e));
}
function isAnimal(e) {
  return !!e && (e.type === 'animal' || e.type === 'water_creature' || e.type === 'ambient');
}

// Псевдонимы блоков для collect/find
const ORE_KEYS = ['coal', 'iron', 'copper', 'gold', 'diamond', 'redstone', 'lapis', 'emerald'];
function resolveBlockNames(registry, name) {
  const n = String(name || '').toLowerCase().trim().replace(/^minecraft:/, '');
  const all = Object.keys(registry.blocksByName);
  const logs = all.filter(b => /_(log|stem)$/.test(b) && !b.startsWith('stripped_') && !b.includes('crimson') && !b.includes('warped'));
  if (['log', 'logs', 'wood', 'tree', 'бревно', 'бревна', 'дерево', 'any_log'].includes(n)) return logs;
  if (['stone', 'cobblestone', 'камень', 'булыжник'].includes(n)) return ['stone', 'cobblestone'];
  if (n === 'deepslate' || n === 'cobbled_deepslate') return ['deepslate', 'cobbled_deepslate'];
  if (n === 'dirt' || n === 'земля') return ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'];
  if (n === 'sand' || n === 'песок') return ['sand'];
  const oreKey = ORE_KEYS.find(k => n === k || n === k + '_ore' || n === 'deepslate_' + k + '_ore' || n === 'raw_' + k);
  if (oreKey) return [oreKey + '_ore', 'deepslate_' + oreKey + '_ore'].filter(b => registry.blocksByName[b]);
  if (n.endsWith('_log')) return [n];
  if (registry.blocksByName[n]) return [n];
  return [];
}

function isLogName(n) { return /_(log|stem)$/.test(n) && !n.startsWith('stripped_'); }

// Блоки, годные для стройки укрытия/столбов
const BUILD_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'coarse_dirt', 'mud_bricks', 'sandstone', 'end_stone'];
function isBuildBlock(n) { return BUILD_BLOCKS.includes(n) || n.endsWith('_planks'); }

function v3(x, y, z) { return new Vec3(x, y, z); }
function posObj(p) { return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; }

module.exports = {
  Vec3, v3, sleep, num, r1, Aborted, SkillError, dirName, entName,
  isHostile, isAutoTarget, isAnimal, resolveBlockNames, isLogName, isBuildBlock, BUILD_BLOCKS, posObj
};
