// Навыки: place_at (поставить блок в точку), dig_at (сломать блок в точке), chest_store / chest_take (сундук).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, num, SkillError } = require('../util');
const A = require('../actions');
const vision = require('../vision');

// Заменяемые/мешающие блоки: перед установкой блока в их клетку ломаем (трава, снег, цветы...)
const REPLACEABLE = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|hanging_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z]+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pink_petals|leaf_litter|wildflowers|firefly_bush|bush|brown_mushroom|red_mushroom|fire)$/;
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'light', 'test_block', 'test_instance_block']);

// Сломать блок, стоя рядом (инструмент выбирается сам). Прерывается через t.
async function digBlock(ctx, t, block) {
  const bot = ctx.bot;
  await A.equipToolFor(bot, block);
  const off = t.onAbort(() => { try { bot.stopDigging(); } catch (e) {} });
  try {
    await bot.dig(block, true);
  } catch (e) {
    t.check();
    throw new SkillError('не удалось сломать ' + block.name + ': ' + (e && e.message ? e.message : e));
  } finally { off(); }
  t.check();
  ctx.stats.blocksMined++; ctx.statsDirty = true;
}

async function placeAt(ctx, t, params) {
  const bot = ctx.bot;
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  if (![x, y, z].every(Number.isFinite)) throw new SkillError('нужны x, y, z');
  const item = String(params.item || params.name || '');
  if (!A.invCount(bot, item)) throw new SkillError('нет в инвентаре: ' + item);
  const pos = new Vec3(x, y, z).floored();
  // подойти, но не встать в саму точку
  const goal = new goals.GoalCompositeAll([new goals.GoalNear(pos.x, pos.y, pos.z, 3.5), new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5))]);
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4 || A.blockHitsBot(bot, pos)) await A.goto(ctx, t, goal, { timeout: 60000 });
  const cur = bot.blockAt(pos);
  if (cur && REPLACEABLE.test(cur.name)) { // трава/снег/цветы: сначала сломать
    t.progress('ломаю ' + cur.name);
    await digBlock(ctx, t, cur);
  }
  t.check();
  ctx.buildingAt = `${pos.x},${pos.y},${pos.z}`; // итог дня: блок в этой клетке — «построено» (lib/daylog.js)
  try { await A.placeBlockAt(bot, pos, item); } finally { ctx.buildingAt = null; }
  ctx.stats.blocksPlaced++; ctx.statsDirty = true;
  return { placed: item, at: [pos.x, pos.y, pos.z] };
}

const isLava = b => !!b && b.name === 'lava';
const floorBelow = (bot, x, y, z) => { // первый не-воздушный блок под (x,y,z) в пределах 24 блоков
  for (let k = 0; k < 24; k++) { const b = bot.blockAt(new Vec3(x, y - k, z)); if (b && !A.isAirLike(b)) return b; }
  return null;
};

// Причина отказа ломать блок (строка) или null
function digDanger(bot, block) {
  const pos = block.position;
  if (UNBREAKABLE.has(block.name)) return `нельзя ломать: ${block.name}`;
  for (const f of A.FACES) if (isLava(bot.blockAt(pos.plus(f)))) return `рядом с блоком лава (${pos.plus(f)}): после слома она хлынет сюда`;
  // блок под ногами: после слома бот упадёт — не в лаву ли
  const p = bot.entity.position, fy = Math.floor(p.y) - 1;
  if (pos.y === fy) {
    for (const ox of [-0.3, 0.3]) for (const oz of [-0.3, 0.3]) {
      if (Math.floor(p.x + ox) === pos.x && Math.floor(p.z + oz) === pos.z) {
        const under = floorBelow(bot, pos.x, pos.y - 1, pos.z);
        if (isLava(under)) return 'бот стоит на этом блоке, под ним лава: упадёт в лаву';
        if (!under) return 'бот стоит на этом блоке, под ним пропасть (нет опоры на 24 блока)';
        return null;
      }
    }
  }
  return null;
}

// Ночью в укрытии: вскроет ли слом блока pos укрытие наружу (за блоком воздух). Только информация — решает мозг.
function breachWarning(ctx, pos) {
  const bot = ctx.bot;
  try {
    if (!require('../perception').timeInfo(bot).isNight) return null;
    const base = bot.entity.position.floored();
    const inShelter = require('./survival').isSheltered(bot) || (ctx.sheltered && ctx.sheltered.pos.equals(base));
    if (!inShelter) return null;
    const d = pos.minus(base);
    const side = (d.y === 0 || d.y === 1) && Math.abs(d.x) + Math.abs(d.z) === 1, up = d.x === 0 && d.z === 0 && d.y === 2;
    if (!side && !up) return null;
    const behind = bot.blockAt(up ? pos.offset(0, 1, 0) : pos.offset(d.x, 0, d.z));
    if (behind && !A.isAirLike(behind) && behind.name !== 'water' && behind.name !== 'lava') return null; // за блоком камень — это туннель
    const F = require('../felt'), { entName, isHostile } = require('../util');
    const en = Object.values(bot.entities).filter(e => e && e !== bot.entity && isHostile(e) && F.distTo(bot, e) <= 16).sort((a, b) => F.distTo(bot, a) - F.distTo(bot, b));
    return 'ночь, укрытие будет вскрыто наружу' + (en.length ? ', рядом ' + en.slice(0, 3).map(e => `${entName(e)} ${Math.round(F.distTo(bot, e))}м`).join(', ') : '');
  } catch (e) { return null; }
}

// dig_at: подойти и сломать блок ровно в точке x,y,z, подобрать дроп
async function digAt(ctx, t, params) {
  const bot = ctx.bot;
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  if (![x, y, z].every(Number.isFinite)) throw new SkillError('нужны x, y, z');
  const pos = new Vec3(x, y, z).floored();
  const at = [pos.x, pos.y, pos.z];
  const check = () => {
    const b = bot.blockAt(pos);
    if (!b) throw new SkillError(`недоступно: чанк с точкой ${at} не загружен`);
    // пустую клетку отвечаем сразу, без хождения: блок уже выкопан/сломан — повторять dig_at по этим координатам бессмысленно
    if (b.name === 'water' || b.name === 'lava') throw new SkillError(`в ${at.join(' ')} ${b.name === 'water' ? 'вода' : 'лава'} (${b.name}) — копать нечего, сломать нельзя`, { at, block: b.name, empty: true });
    if (A.isAirLike(b) && !REPLACEABLE.test(b.name)) throw new SkillError(`нет такого блока: в ${at.join(' ')} уже пусто (${b.name}) — там нечего копать`, { at, block: b.name, empty: true });
    if (!b.diggable && !UNBREAKABLE.has(b.name)) throw new SkillError(`блок ${b.name} в ${at} сломать нельзя`, { at });
    const why = digDanger(bot, b);
    if (why) throw new SkillError('отказ: ' + why, { at, block: b.name });
    return b;
  };
  let block = check();
  const breach = breachWarning(ctx, pos);
  if (breach) t.progress(breach);
  const reach = b => bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5));
  if (reach(block) > 4.2) {
    t.progress('подхожу к ' + block.name);
    try {
      await A.goto(ctx, t, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeout: 60000 });
    } catch (e) {
      if (e.aborted) throw e;
      throw new SkillError(`недоступно: не могу подойти к ${at} (${e.message})`, { at });
    }
    await t.sleep(250); // дать телу остановиться
    block = check(); // после подхода мир и положение могли измениться
    if (reach(block) > 4.8) throw new SkillError(`недоступно: до блока ${at} не дотянуться`, { at });
  }
  const before = A.invMap(bot);
  const needTool = !A.canHarvest(bot, block);
  t.progress('ломаю ' + block.name);
  await digBlock(ctx, t, block);
  await t.sleep(150);
  const now = bot.blockAt(pos);
  if (now && now.name === block.name) throw new SkillError(`блок ${block.name} в ${at} не сломался`, { at });
  await A.pickupDrops(ctx, t, pos.offset(0.5, 0.5, 0.5), 3, 5000);
  const got = {};
  for (const [n, c] of A.invMap(bot)) { const d = c - (before.get(n) || 0); if (d > 0) got[n] = d; }
  const res = { dug: block.name, at, got };
  if (needTool) res.warning = 'подходящего инструмента не было — дроп мог не выпасть';
  if (breach) { res.warning = res.warning ? res.warning + '; ' + breach : breach; ctx.sheltered = null; }
  return res;
}

// Что мешает открыть сундук (строка) или null. Сундук не открывается, если над ним непрозрачный блок или на нём сидит кошка
// (так в игре); бочке это не мешает.
function chestBlocked(bot, block) {
  if (!/chest/.test(block.name)) return null;
  const up = bot.blockAt(block.position.offset(0, 1, 0));
  if (up && up.boundingBox === 'block' && !up.transparent) return `над сундуком твёрдый блок ${up.name} в ${block.position.offset(0, 1, 0)} — крышка не поднимется`;
  const cat = Object.values(bot.entities || {}).find(e => e && e.name === 'cat' && e.position && e.position.distanceTo(block.position.offset(0.5, 1, 0.5)) < 0.8);
  if (cat) return 'на сундуке сидит кошка';
  return null;
}

const OPEN_MS = 5000; // окно сундука приходит за доли секунды; ждать 20 с (как mineflayer) — стоять под ударом

async function openNearestChest(ctx, t, params) {
  const bot = ctx.bot;
  const me = () => { const p = bot.entity.position; return [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]; };
  let block;
  if (params.x != null && params.z != null) {
    const pos = new Vec3(Number(params.x), Number(params.y), Number(params.z)).floored();
    block = bot.blockAt(pos);
    if (!block) throw new SkillError(`сундук в ${pos} не виден: чанк не загружен`, { chest: [pos.x, pos.y, pos.z], me: me() });
    if (!/chest|barrel/.test(block.name)) throw new SkillError(`в ${pos} не сундук, а ${block.name}`, { chest: [pos.x, pos.y, pos.z], block: block.name, me: me() });
  } else {
    const ids = ['chest', 'barrel', 'trapped_chest'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean);
    block = vision.nearest(ctx, ids, 32); // только увиденные/запомненные сундуки
    if (!block || !/chest|barrel/.test(block.name)) throw new SkillError('не вижу сундука рядом (в 32 блоках; или он за стеной)', { me: me() });
  }
  const at = [block.position.x, block.position.y, block.position.z];
  const why = chestBlocked(bot, block);
  if (why) throw new SkillError('сундук не откроется: ' + why, { chest: at, me: me() });
  try {
    await A.goto(ctx, t, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), { timeout: 60000 });
  } catch (e) {
    if (e.aborted) throw e;
    throw new SkillError(`не могу подойти к сундуку ${at.join(' ')}: ${e.message}`, { chest: at, me: me() });
  }
  const eye = bot.entity.position.offset(0, 1.62, 0), d = eye.distanceTo(block.position.offset(0.5, 0.5, 0.5));
  if (d > 4.5) throw new SkillError(`до сундука ${at.join(' ')} не дотянуться: ${d.toFixed(1)} блока`, { chest: at, me: me() });
  const now = bot.blockAt(block.position);
  if (!now || !/chest|barrel/.test(now.name)) throw new SkillError(`сундука в ${at.join(' ')} уже нет (${now ? now.name : 'не виден'})`, { chest: at, me: me() });
  const why2 = chestBlocked(bot, now);
  if (why2) throw new SkillError('сундук не откроется: ' + why2, { chest: at, me: me() });
  let timer;
  const opening = bot.openContainer(now);
  let win;
  try {
    win = await Promise.race([opening, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), OPEN_MS); })]);
  } catch (e) {
    opening.then(w => { try { w.close(); } catch (er) {} }, () => {}); // окно пришло позже — закрыть
    const msg = e && e.message === 'timeout' ? `сервер не открыл окно за ${OPEN_MS / 1000} с` : 'не открылся: ' + (e && e.message ? e.message : e);
    throw new SkillError(`сундук ${at.join(' ')} ${msg} (муха в ${me().join(' ')}, до сундука ${d.toFixed(1)} бл.)`, { chest: at, me: me() });
  } finally { clearTimeout(timer); }
  t.onAbort(() => { try { win.close(); } catch (e) {} });
  return { win, at };
}

// Положить в сундук. items: ['cobblestone','dirt'] или 'all' (всё, кроме инструментов, оружия, брони и еды)
async function chestStore(ctx, t, params) {
  const bot = ctx.bot;
  const { win, at } = await openNearestChest(ctx, t, params);
  const stored = {};
  try {
    const list = params.items === 'all' || !params.items
      ? bot.inventory.items().filter(i => !/_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(i.name) && !bot.registry.foodsByName[i.name] && !['torch', 'crafting_table'].includes(i.name)).map(i => i.name)
      : (Array.isArray(params.items) ? params.items : [params.items]).map(String);
    for (const name of [...new Set(list)]) {
      t.check();
      const have = A.invCount(bot, name); if (!have) continue;
      const n = params.count ? Math.min(num(params.count, have, 1, 9999), have) : have;
      try { await win.deposit(bot.registry.itemsByName[name].id, null, n); stored[name] = n; } catch (e) { stored[name] = 'ошибка: ' + e.message; }
    }
  } finally { try { win.close(); } catch (e) {} }
  return { chest: at, stored };
}

async function chestTake(ctx, t, params) {
  const bot = ctx.bot;
  const name = String(params.item || params.name || '');
  const { win, at } = await openNearestChest(ctx, t, params);
  let took = 0; let content;
  try {
    content = win.containerItems().reduce((m, i) => { m[i.name] = (m[i.name] || 0) + i.count; return m; }, {});
    if (name) {
      const avail = content[name] || 0;
      if (!avail) throw new SkillError(`в сундуке нет ${name}`, { content });
      const n = Math.min(num(params.count, avail, 1, 9999), avail);
      await win.withdraw(bot.registry.itemsByName[name].id, null, n);
      took = n;
    }
  } finally { try { win.close(); } catch (e) {} }
  return { chest: at, took, item: name || null, content };
}

module.exports = { placeAt, digAt, breachWarning, chestStore, chestTake, chestBlocked, openNearestChest };
