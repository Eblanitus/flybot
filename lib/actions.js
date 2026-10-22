// Базовые действия тела для навыков: путь, инвентарь, экипировка, установка блоков, подбор дропа.
'use strict';
const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3, sleep, SkillError, isBuildBlock } = require('./util');

// Настройки ходьбы: без спринта, без паркура, копать — только если иначе никак.
function makeMovements(bot, { sprint = false, ctx = null } = {}) {
  const m = new Movements(bot);
  m.allowSprinting = sprint;
  m.allowParkour = false;
  m.canDig = true;
  m.digCost = 4;
  m.placeCost = 6; // дороже копки: лучше лесенка/выход пешком, чем столбить и тратить блоки
  m.maxDropDown = 3;
  m.allow1by1towers = true;
  m.allowFreeMotion = false;
  const avoid = ['fire', 'soul_fire', 'magma_block', 'sweet_berry_bush', 'powder_snow', 'cactus', 'campfire', 'soul_campfire', 'wither_rose', 'lava'];
  for (const n of avoid) { const b = bot.registry.blocksByName[n]; if (b) m.blocksToAvoid.add(b.id); }
  // Не ломать полезное по пути
  for (const n of ['chest', 'crafting_table', 'furnace', 'bed', 'barrel', 'trapped_chest']) {
    const b = bot.registry.blocksByName[n]; if (b) m.blocksCantBreak.add(b.id);
  }
  for (const b of bot.registry.blocksArray) if (b.name.endsWith('_bed') || b.name.endsWith('_door')) m.blocksCantBreak.add(b.id);
  // Строительный мусор для столбов/мостов
  m.scafoldingBlocks = scaffoldIds(bot, DEFAULT_RESERVE);
  return m;
}

// Подпорки: сперва мусор; булыжник — только сверх запаса reserve. Доски/брёвна — никогда.
const JUNK_SCAFFOLD = ['dirt', 'coarse_dirt', 'netherrack', 'diorite', 'andesite', 'granite', 'tuff', 'calcite'];
const RESERVE_SCAFFOLD = ['cobblestone', 'cobbled_deepslate'];
const DEFAULT_RESERVE = 32;
function scaffoldNames(bot, reserve = DEFAULT_RESERVE) {
  const have = n => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0);
  return [...JUNK_SCAFFOLD, ...RESERVE_SCAFFOLD.filter(n => have(n) > reserve)];
}
function scaffoldIds(bot, reserve) { return scaffoldNames(bot, reserve).map(n => bot.registry.itemsByName[n]?.id).filter(id => id != null); }
// Пересчитать подпорки у всех Movements по текущему инвентарю (перед каждым goto)
function applyScaffold(ctx, reserve) {
  const bot = ctx.bot; const ids = scaffoldIds(bot, reserve != null ? reserve : (ctx.blockReserve != null ? ctx.blockReserve : DEFAULT_RESERVE));
  for (const m of [ctx.movements, ctx.sprintMovements, bot.pathfinder && bot.pathfinder.movements]) if (m) m.scafoldingBlocks = ids;
}

function translatePathError(e) {
  const n = e && (e.name || '');
  if (n === 'NoPath') return 'нет пути';
  if (n === 'Timeout') return 'путь не найден за отведённое время';
  return String(e && e.message ? e.message : e);
}

// Идти к цели с поддержкой прерывания и общим таймаутом. Возвращает true, если цель достигнута.
async function goto(ctx, t, goal, { timeout = 60000, sprint = false, reserve } = {}) {
  const bot = ctx.bot;
  t.check();
  applyScaffold(ctx, reserve);
  if (goal.isEnd && goal.isEnd(bot.entity.position.floored())) return true;
  if (sprint) { const sm = ctx.sprintMovements || makeMovements(bot, { sprint: true, ctx }); bot.pathfinder.setMovements(sm); applyScaffold(ctx, reserve); }
  let timer;
  const off = t.onAbort(() => { try { bot.pathfinder.setGoal(null); } catch (e) {} });
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => { timer = setTimeout(() => { try { bot.pathfinder.setGoal(null); } catch (e) {} rej(new Error('слишком долго идти')); }, timeout); })
    ]);
  } catch (e) {
    t.check();
    throw new SkillError(translatePathError(e));
  } finally {
    clearTimeout(timer); off();
    if (sprint && ctx.movements) bot.pathfinder.setMovements(ctx.movements);
  }
  t.check();
  return goal.isEnd ? goal.isEnd(bot.entity.position.floored()) : true;
}

function invCount(bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0);
}
function invMap(bot) {
  const m = new Map();
  for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) || 0) + i.count);
  return m;
}
function findItem(bot, pred) {
  return bot.inventory.items().find(typeof pred === 'string' ? (i => i.name === pred) : pred);
}

// ---- Инструменты, оружие, броня ----
const MAT = { wooden: 1, golden: 1.5, stone: 2, copper: 2.5, iron: 3, diamond: 4, netherite: 5 };
function matRank(name) { const m = name.split('_')[0]; return MAT[m] || 0; }

function weaponScore(name) {
  if (name.endsWith('_sword')) return 4 + matRank(name) * 1.2;
  if (name.endsWith('_axe')) return 3 + matRank(name);
  if (name === 'trident') return 8;
  if (name === 'mace') return 7;
  return 0;
}
async function equipBestWeapon(bot) {
  const best = bot.inventory.items().filter(i => weaponScore(i.name) > 0).sort((a, b) => weaponScore(b.name) - weaponScore(a.name))[0];
  if (best && (!bot.heldItem || weaponScore(bot.heldItem.name) < weaponScore(best.name))) await bot.equip(best, 'hand');
  return bot.heldItem ? bot.heldItem.name : null;
}

// Лучший инструмент для блока: минимальный block.digTime среди предметов инвентаря; рука — база сравнения
// (чужой предмет, не ускоряющий копание, не берём; pathfinder.bestHarvestTool берёт первый попавшийся предмет)
function bestToolFor(bot, block) {
  const eff = bot.entity && bot.entity.effects;
  const time = it => { try { return block.digTime(it ? it.type : null, false, false, false, [], eff); } catch (e) { return Infinity; } };
  let best = null, fastest = time(null) - 1; // нужен выигрыш хотя бы 1 мс
  for (const it of bot.inventory.items()) { const d = time(it); if (d < fastest) { fastest = d; best = it; } }
  return best;
}
async function equipToolFor(bot, block) {
  let tool = null;
  try { tool = bestToolFor(bot, block); } catch (e) {}
  if (tool) { if (!bot.heldItem || bot.heldItem.type !== tool.type) await bot.equip(tool, 'hand'); }
  else if (bot.heldItem && /_(sword|pickaxe|axe|shovel|hoe)$/.test(bot.heldItem.name) === false) { /* держим что есть */ }
  return bot.heldItem ? bot.heldItem.name : 'рука';
}

// Можно ли добыть блок тем, что есть (иначе дропа не будет)
function canHarvest(bot, block) {
  if (!block.harvestTools) return true;
  return bot.inventory.items().some(i => block.harvestTools[i.type]);
}
function neededTools(bot, block) {
  if (!block.harvestTools) return [];
  return Object.keys(block.harvestTools).map(id => bot.registry.items[id]?.name).filter(Boolean)
    .sort((a, b) => matRank(a) - matRank(b));
}

const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 };
const ARMOR_MAT = { leather: 1, golden: 2, chainmail: 3, copper: 3.2, iron: 4, turtle: 3.5, diamond: 5, netherite: 6 };
function armorSlotOf(name) {
  if (/_helmet$/.test(name) || name === 'turtle_helmet') return 'head';
  if (/_chestplate$/.test(name)) return 'torso';
  if (/_leggings$/.test(name)) return 'legs';
  if (/_boots$/.test(name)) return 'feet';
  return null;
}
function armorRank(name) { return ARMOR_MAT[name.split('_')[0]] || 0; }
async function equipBestArmor(bot) {
  const put = [];
  for (const [slot, idx] of Object.entries(ARMOR_SLOTS)) {
    const cur = bot.inventory.slots[idx];
    const best = bot.inventory.items().filter(i => armorSlotOf(i.name) === slot).sort((a, b) => armorRank(b.name) - armorRank(a.name))[0];
    if (best && (!cur || armorRank(best.name) > armorRank(cur.name))) {
      try { await bot.equip(best, slot); put.push(best.name); } catch (e) {}
    }
  }
  return put;
}

// ---- Блоки ----
function isAirLike(b) {
  return !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.boundingBox === 'empty' && !['water', 'lava'].includes(b.name);
}
function isSolid(b) { return !!b && b.boundingBox === 'block'; }

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

// Пересекает ли блок pos тело бота (хитбокс 0.6 x 1.8)
function blockHitsBot(bot, pos) {
  const p = bot.entity.position;
  const minX = p.x - 0.3, maxX = p.x + 0.3, minZ = p.z - 0.3, maxZ = p.z + 0.3, minY = p.y, maxY = p.y + 1.8;
  return pos.x < maxX && pos.x + 1 > minX && pos.z < maxZ && pos.z + 1 > minZ && pos.y < maxY && pos.y + 1 > minY;
}

// Опора, по которой клик ОТКРЫВАЕТ/ПЕРЕКЛЮЧАЕТ, а не ставит блок (сундук, верстак, печь, дверь...).
// К ней прислоняем только с зажатым sneak (так делает и игрок) и только если другой опоры нет.
const INTERACTIVE = /^(chest|trapped_chest|ender_chest|barrel|crafting_table|crafter|furnace|blast_furnace|smoker|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|hopper|dispenser|dropper|lever|repeater|comparator|daylight_detector|note_block|jukebox|beacon|bell|cake|lectern|loom|stonecutter|grindstone|smithing_table|cartography_table|fletching_table|respawn_anchor|composter|cauldron|water_cauldron|lava_cauldron|decorated_pot|chiseled_bookshelf|command_block|structure_block|.*_shulker_box|shulker_box|.*_door|.*_trapdoor|.*_fence_gate|.*_bed|.*_button|.*_sign|.*_hanging_sign|flower_pot|potted_.*|.*_candle|candle|.*_copper_bulb|copper_bulb|vault|trial_spawner)$/;
const isInteractive = b => !!b && INTERACTIVE.test(b.name);
// Что ставится только на пол (твёрдый блок снизу): двери, кровати, ковры, плиты, рельсы, саженцы, цветы, свечи...
const FLOOR_ONLY = /(_door|_bed|_carpet|_pressure_plate|rail|_sapling|_candle|^candle|^redstone$|^repeater$|^comparator$|^cake$|^flower_pot$|^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|[a-z]+_tulip|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|carrot|potato|sugar_cane|bamboo|sweet_berries|brown_mushroom|red_mushroom|snow)$)/;
// Куда смотрит бот по горизонтали (кровать кладётся изголовьем от бота, дверь — по взгляду)
function facingDir(bot) {
  const yaw = bot.entity.yaw || 0, x = -Math.sin(yaw), z = -Math.cos(yaw);
  return Math.abs(x) > Math.abs(z) ? new Vec3(Math.sign(x), 0, 0) : new Vec3(0, 0, Math.sign(z));
}
const free = b => isAirLike(b) || (b && b.name === 'water');
const errText = e => String(e && e.message ? e.message : e).slice(0, 160);

// Поставить блок itemName в позицию pos (рядом должен быть твёрдый сосед). Бот уже должен быть в досягаемости.
// Отказ — честная причина: что именно не так (опоры нет, опора — сундук, дверь не влезает, сервер не поставил: ...).
async function placeBlockAt(bot, pos, itemName) {
  pos = new Vec3(pos.x, pos.y, pos.z).floored();
  const at = bot.blockAt(pos);
  if (!at) throw new SkillError(`место ${pos} не видно: чанк не загружен`);
  if (!free(at)) throw new SkillError(`место ${pos} занято: ${at.name}`);
  const item = typeof itemName === 'string' ? findItem(bot, itemName) : itemName;
  if (!item) throw new SkillError(`нет в инвентаре: ${itemName}`);
  const name = item.name;
  if (blockHitsBot(bot, pos)) throw new SkillError('бот стоит на месте установки');
  const below = bot.blockAt(pos.offset(0, -1, 0));
  const floor = FLOOR_ONLY.test(name);
  if (floor && !isSolid(below)) throw new SkillError(`${name} ставится только на твёрдый пол, а под ${pos} — ${below ? below.name : '?'}`);
  if (/_door$/.test(name)) { // дверь — 2 блока в высоту
    const up = bot.blockAt(pos.offset(0, 1, 0));
    if (!free(up)) throw new SkillError(`дверь не влезет: над ${pos} занято (${up ? up.name : '?'}), нужно 2 блока высоты`);
    if (blockHitsBot(bot, pos.offset(0, 1, 0))) throw new SkillError('бот стоит на месте верхней половины двери');
  }
  if (/_bed$/.test(name)) { // кровать — 2 клетки: изголовье дальше от бота, по взгляду
    const d = facingDir(bot), head = pos.plus(d), hb = bot.blockAt(head), hbelow = bot.blockAt(head.offset(0, -1, 0));
    if (!free(hb)) throw new SkillError(`кровать не влезет: вторая клетка ${head} занята (${hb ? hb.name : '?'}); кровать кладётся по взгляду бота`);
    if (!isSolid(hbelow)) throw new SkillError(`кровать не влезет: под второй клеткой ${head} нет пола (${hbelow ? hbelow.name : '?'})`);
    if (blockHitsBot(bot, head)) throw new SkillError('бот стоит на месте второй клетки кровати');
  }
  // досягаемость как у сервера: от глаз до ближайшей точки блока не дальше ~5.5 (4.5 + запас)
  const eye = bot.entity.position.offset(0, 1.62, 0), cl = (v, lo) => Math.max(lo, Math.min(lo + 1, v));
  const reach = eye.distanceTo(new Vec3(cl(eye.x, pos.x), cl(eye.y, pos.y), cl(eye.z, pos.z)));
  if (reach > 5.5) throw new SkillError(`до ${pos} не дотянуться (${reach.toFixed(1)} блока) — подойди ближе`);
  // опоры: напольное — только блок снизу; остальное — любой твёрдый сосед, интерактивные (сундук, верстак...) — в конце
  const refs = [];
  for (const f of (floor ? [FACES[0]] : FACES)) {
    const ref = bot.blockAt(pos.plus(f));
    if (isSolid(ref)) refs.push({ ref, f, inter: isInteractive(ref) });
  }
  if (!refs.length) {
    const near = FACES.map(f => bot.blockAt(pos.plus(f))).filter(Boolean).map(b => b.name);
    throw new SkillError(`не к чему прислонить блок в ${pos}: рядом нет твёрдого блока (вокруг: ${[...new Set(near)].join(', ') || '?'})`);
  }
  refs.sort((a, b) => a.inter - b.inter);
  await bot.equip(item, 'hand');
  const tried = [];
  for (const { ref, f, inter } of refs) {
    const face = f.scaled(-1);
    let err = null;
    if (inter) { try { bot.setControlState('sneak', true); } catch (e) {} await sleep(100); } // с sneak клик по сундуку ставит блок, а не открывает
    try {
      await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
      await bot.placeBlock(ref, face);
    } catch (e) { err = e; } finally { if (inter) { try { bot.setControlState('sneak', false); } catch (e) {} } }
    // placeBlock иногда ругается на отсутствие подтверждения, хотя блок встал — смотрим на мир, а не на ошибку
    if (err) await sleep(150);
    const now = bot.blockAt(pos);
    if (now && !free(now)) return true;
    if (!err) return true; // ошибки нет — сервер принял (в тестах и при задержке обновления мира)
    tried.push(`${ref.name}${inter ? ' (с sneak)' : ''}: ${errText(err)}`);
  }
  throw new SkillError(`сервер не поставил ${name} в ${pos}; пробовала опоры — ${tried.join('; ')}`);
}

// Найти свободное место рядом с ботом (воздух, под ним твёрдо, над ним воздух) — для верстака/печи/кровати
function findPlaceSpot(bot, { needHead = true } = {}) {
  const base = bot.entity.position.floored();
  const cands = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
    const p = base.offset(dx, dy, dz);
    if (blockHitsBot(bot, p)) continue;
    const here = bot.blockAt(p), below = bot.blockAt(p.offset(0, -1, 0)), above = bot.blockAt(p.offset(0, 1, 0));
    if (!isAirLike(here) || !isSolid(below)) continue;
    if (needHead && !isAirLike(above)) continue;
    const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2;
    if (d < 1) continue;
    cands.push({ p, d });
  }
  cands.sort((a, b) => a.d - b.d);
  return cands.length ? cands[0].p : null;
}

// Выкопать нишу рядом (на уровне ног), чтобы поставить блок. Возвращает позицию или null.
async function digPlaceSpot(bot) {
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const p = base.offset(dx, 0, dz);
    const b = bot.blockAt(p), below = bot.blockAt(p.offset(0, -1, 0));
    if (!b || !isSolid(below) || !b.diggable || ['bedrock', 'obsidian', 'chest', 'furnace', 'crafting_table'].includes(b.name)) continue;
    let lava = false; for (const f of FACES) { const n = bot.blockAt(p.plus(f)); if (n && (n.name === 'lava' || n.name === 'water')) lava = true; }
    if (lava) continue;
    if (!isAirLike(b)) { await equipToolFor(bot, b); await bot.dig(b, true); }
    return p;
  }
  return null;
}

// Подобрать выпавшие предметы рядом с точкой
async function pickupDrops(ctx, t, near, radius = 6, maxMs = 8000) {
  const bot = ctx.bot;
  const end = Date.now() + maxMs;
  await t.sleep(300);
  for (let k = 0; k < 6 && Date.now() < end; k++) {
    t.check();
    const items = Object.values(bot.entities).filter(e => e.name === 'item' && e.position &&
      e.position.distanceTo(near) <= radius && e.position.distanceTo(bot.entity.position) <= 16);
    if (!items.length) return;
    items.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    const it = items[0];
    if (it.position.distanceTo(bot.entity.position) < 1.2) { await t.sleep(250); continue; }
    try {
      await goto(ctx, t, new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.5), { timeout: Math.max(1000, end - Date.now()) });
    } catch (e) { if (e.aborted) throw e; }
    await t.sleep(250);
  }
}

module.exports = {
  makeMovements, scaffoldNames, applyScaffold, DEFAULT_RESERVE, goto, invCount, invMap, findItem, equipBestWeapon, equipToolFor, bestToolFor, canHarvest, neededTools,
  equipBestArmor, armorSlotOf, weaponScore, matRank, isAirLike, isSolid, placeBlockAt, findPlaceSpot, isInteractive, FLOOR_ONLY,
  pickupDrops, blockHitsBot, isBuildBlock, FACES, digPlaceSpot
};
