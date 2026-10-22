// "Глаза": компактное описание окружения для LLM + совместимый со старым форматом snapshot.
'use strict';
const { r1, dirName, entName, isHostile, isAnimal } = require('./util');
const { isSolid } = require('./actions');
const vision = require('./vision');

const NIGHT_START = 12542; // с этого тика начинают появляться монстры
const NIGHT_END = 23460;

function timeInfo(bot) {
  const tod = bot.time ? bot.time.timeOfDay : 0;
  let phase;
  if (tod < 12000) phase = 'день';
  else if (tod < NIGHT_START) phase = 'закат';
  else if (tod < NIGHT_END) phase = 'ночь';
  else phase = 'рассвет';
  const isNight = tod >= NIGHT_START && tod < NIGHT_END;
  const nightIn = tod < NIGHT_START ? Math.round((NIGHT_START - tod) / 20) : 0;
  const dayIn = isNight ? Math.round((NIGHT_END - tod) / 20) : 0;
  return { tod, phase, isNight, nightIn, dayIn, day: bot.time ? Number(bot.time.day) : null };
}

function biomeName(bot) {
  try {
    const b = bot.blockAt(bot.entity.position);
    if (b && b.biome) {
      if (b.biome.name) return b.biome.name;
      const byId = bot.registry.biomes && bot.registry.biomes[b.biome.id];
      if (byId && byId.name) return byId.name;
    }
  } catch (e) {}
  return 'unknown';
}

// Полезные блоки, которые бот ВИДИТ или помнит (линия видимости + память, см. vision.js) — не рентген
function scanUseful(ctx, radius = 24) {
  const bot = ctx.bot;
  const p = bot.entity.position;
  let list = [];
  try {
    vision.refresh(ctx);
    list = vision.nearbyKnown(ctx, radius).concat(vision.visibleLiquids(ctx, radius));
  } catch (e) {}
  const out = {};
  for (const { name, pos } of list) {
    const k = vision.usefulKey(name); if (!k) continue;
    const d = pos.offset(0.5, 0.5, 0.5).distanceTo(p);
    const cur = out[k];
    if (!cur) out[k] = { d: r1(d), n: 1, dir: dirName(p, pos), at: [pos.x, pos.y, pos.z] };
    else { cur.n++; if (d < cur.d) { cur.d = r1(d); cur.dir = dirName(p, pos); cur.at = [pos.x, pos.y, pos.z]; } }
  }
  return out;
}

function hazards(bot, useful) {
  const out = [];
  const p = bot.entity.position;
  if (useful.lava && useful.lava.d <= 5) out.push(`лава ${useful.lava.d}м ${useful.lava.dir}`);
  // обрыв: соседняя колонна без опоры на 4 блока вниз
  const base = p.floored();
  const cliffs = new Set();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    let solid = false;
    for (let dy = -1; dy >= -5; dy--) { const b = bot.blockAt(base.offset(dx, dy, dz)); if (!b) { solid = true; break; } if (isSolid(b) || b.name === 'water') { solid = true; break; } }
    const at = bot.blockAt(base.offset(dx, 0, dz));
    if (!solid && at && !isSolid(at)) cliffs.add(dirName(p, base.offset(dx, 0, dz)).replace(/[↑↓]/g, ''));
  }
  if (cliffs.size) out.push('обрыв ' + [...cliffs].join(','));
  try {
    const head = bot.blockAt(p.offset(0, 1.6, 0));
    if (head && head.name === 'water') out.push('под водой');
  } catch (e) {}
  if (bot.entity.metadata && typeof bot.entity.metadata[0] === 'number' && (bot.entity.metadata[0] & 1)) out.push('горю');
  return out;
}

function entitiesNear(bot, radius = 24) {
  const p = bot.entity.position;
  const enemies = [], players = [], animals = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue;
    const d = p.distanceTo(e.position); if (d > radius) continue;
    const rec = { name: entName(e), d: r1(d), dir: dirName(p, e.position) };
    if (e.type === 'player') players.push(rec);
    else if (isHostile(e)) enemies.push(rec);
    else if (isAnimal(e)) animals.push(rec);
  }
  const s = (a, b) => a.d - b.d;
  return { enemies: enemies.sort(s).slice(0, 6), players: players.sort(s).slice(0, 5), animals: animals.sort(s).slice(0, 5) };
}

// Текст инвентаря для мозга: стеки сливаются по имени; снаряжение/еда/руды/слитки/ключевое никогда не режутся.
// Порядок: в руке, снаряжение, еда, ключевое, остальное по количеству; режется только мусор в хвосте («…и ещё N видов»).
const GEAR_RE = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|fishing_rod|flint_and_steel|shears|elytra|totem_of_undying|mace|spyglass)$/;
const KEY_RE = /^(coal|charcoal|diamond|emerald|redstone|lapis_lazuli|quartz|netherite_scrap|amethyst_shard|stick|torch|furnace|blast_furnace|crafting_table|chest|ender_pearl|ender_eye|blaze_rod|arrow|obsidian|string|leather|glass|gunpowder|cobblestone|cobbled_deepslate)$|^raw_|_ingot$|_ore$|_bed$|_log$|_planks$|_bucket$|_nugget$/;
const INV_LIMIT = 24;
function invSummary(items, heldName, foods) {
  const m = new Map();
  for (const i of items || []) m.set(i.name, (m.get(i.name) || 0) + i.count);
  if (!m.size) return 'пусто';
  const rank = ([n]) => n === heldName ? 0 : GEAR_RE.test(n) ? 1 : (foods && foods[n]) ? 2 : KEY_RE.test(n) ? 3 : 4;
  const list = [...m.entries()].sort((a, b) => rank(a) - rank(b) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const keep = list.filter(e => rank(e) < 4), junk = list.filter(e => rank(e) === 4);
  const cut = Math.max(0, junk.length - Math.max(0, INV_LIMIT - keep.length));
  return keep.concat(junk.slice(0, junk.length - cut)).map(([n, c]) => n + 'x' + c).join(' ') + (cut ? ` …и ещё ${cut} видов` : '');
}

function eyes(ctx) {
  const bot = ctx.bot;
  let aggressors = []; try { aggressors = require('./aggressors').list(ctx); } catch (e) {}
  let threats = []; try { threats = require('./threats').list(ctx); } catch (e) {}
  const time = timeInfo(bot);
  const weather = bot.thunderState > 0 ? 'гроза' : (bot.isRaining ? 'дождь' : 'ясно');
  const biome = biomeName(bot);
  // oxygenLevel в 26.1 бывает неверным на суше — показываем только когда голова под водой
  let headWet = false; try { const hb = bot.blockAt(bot.entity.position.offset(0, 1.6, 0)); headWet = !!hb && hb.name === 'water'; } catch (e) {}
  const vit = { hp: Math.round(bot.health), food: bot.food, air: headWet && bot.oxygenLevel != null ? bot.oxygenLevel : 20 };
  const ents = entitiesNear(bot);
  const blocks = scanUseful(ctx);
  const hz = hazards(bot, blocks);
  const task = ctx.tasks.info();
  const p = bot.entity.position;

  // строка-резюме на русском
  const parts = [];
  parts.push(time.phase === 'ночь' ? `Ночь (день через ${time.dayIn}с)` : `${time.phase[0].toUpperCase() + time.phase.slice(1)}, ночь через ${time.nightIn}с`);
  parts.push(`${weather}, биом ${biome}`);
  parts.push(`HP ${vit.hp}/20, еда ${vit.food}/20` + (vit.air < 20 ? `, воздух ${vit.air}/20` : ''));
  parts.push(`позиция ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
  if (ents.enemies.length) parts.push('ВРАГИ: ' + ents.enemies.slice(0, 3).map(e => `${e.name} ${e.d}м ${e.dir}`).join(', '));
  if (threats.length) parts.push(threats.slice(0, 3).map(t => `ВРАГ-ИГРОК ${t.name} ${t.d}м ${t.dir}${t.approaching ? ', приближается' : ''} (${t.why})`).join('; '));
  if (aggressors.length) parts.push('АГРЕССОРЫ (игроки, бившие меня): ' + aggressors.map(a => `${a.name} ${a.agoSec}с назад${a.d != null ? ', ' + a.d + 'м' : ', не вижу'}`).join('; '));
  if (ents.players.length) parts.push('игроки: ' + ents.players.map(e => `${e.name} ${e.d}м`).join(', '));
  const bl = Object.entries(blocks).sort((a, b) => a[1].d - b[1].d).slice(0, 6).map(([k, v]) => `${k} ${v.d}м ${v.dir}`);
  if (bl.length) parts.push('рядом: ' + bl.join(', '));
  if (hz.length) parts.push('ОПАСНО: ' + hz.join('; '));
  const ap = ctx.autopilot && ctx.autopilot.status ? ctx.autopilot.status() : null;
  parts.push(task ? `навык ${task.name}${task.source && task.source !== 'brain' ? ' [' + task.source + ']' : ''}${task.progress ? ' ' + task.progress : ''}` : (ap && ap.active ? 'навык: нет' : 'навык: нет (жду команды)'));
  if (ap && ap.active && ap.doing) parts.push('автопилот: ' + ap.doing + ' (любая твоя команда его вытеснит)');
  const adv = null; // советы критика мозгу не показываем (только отчёт для людей)
  if (adv) parts.push('СОВЕТ: ' + adv.msg);
  parts.push('инвентарь: ' + invSummary(bot.inventory.items(), bot.heldItem && bot.heldItem.name, bot.registry && bot.registry.foodsByName));

  return {
    summary: parts.join('. ') + '.',
    time: { phase: time.phase, tod: time.tod, nightIn: time.nightIn, dayIn: time.dayIn, day: time.day },
    weather, biome, vitals: vit,
    enemies: ents.enemies, players: ents.players, animals: ents.animals, aggressors, threats,
    blocks, hazards: hz, task
  };
}

// Совместимый со старым форматом снимок + eyes
// «В укрытии» по блокам вокруг (только соседние клетки — их муха видит/касается): крыша над головой, 8 клеток стен
// (4 стороны × ноги/голова). closed — закрыто всё; skill — навык shelter сам считает муху в укрытии (ctx.sheltered).
const SIDES = [[1, 0, 'восток'], [-1, 0, 'запад'], [0, 1, 'юг'], [0, -1, 'север']];
function shelterInfo(ctx) {
  const bot = ctx.bot;
  const base = bot.entity.position.floored();
  const solid = p => { try { return isSolid(bot.blockAt(p)); } catch (e) { return false; } };
  const roof = solid(base.offset(0, 2, 0));
  const open = [];
  let walls = 0;
  for (const [dx, dz, name] of SIDES) for (const [h, lvl] of [[0, 'ноги'], [1, 'голова']]) {
    if (solid(base.offset(dx, h, dz))) walls++; else open.push(name + ' (' + lvl + ')');
  }
  return { closed: roof && walls === 8, roof, walls, open, skill: !!ctx.sheltered };
}

function snapshot(ctx) {
  const bot = ctx.bot;
  if (!bot || !ctx.ready || !bot.entity) { // не в мире: честно — связи нет (раньше connected=true, если объект бота просто существовал)
    const link = ctx.link && typeof ctx.link.info === 'function' ? ctx.link.info() : null;
    return { ready: false, error: ctx.lastError, connected: !!(link && link.online), ...(link ? { link } : {}) };
  }
  const p = bot.entity.position;
  const items = bot.inventory.items().map(i => ({ slot: i.slot, name: i.name, count: i.count }));
  const held = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.heldItem.slot } : null;
  let targetBlock = null;
  try { const b = bot.blockAtCursor(5); if (b) targetBlock = { name: b.name, position: { x: b.position.x, y: b.position.y, z: b.position.z } }; } catch (e) {}
  const e = eyes(ctx);
  const armor = [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(i => i.name);
  let light = null; try { light = bot.blockAt(p).light; } catch (err) {}
  return {
    ready: true,
    username: bot.username,
    summary: e.summary,
    health: bot.health, food: bot.food,
    position: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    yaw: +bot.entity.yaw.toFixed(3), pitch: +bot.entity.pitch.toFixed(3),
    onGround: bot.entity.onGround,
    heldItem: held, armor, inventory: items, targetBlock,
    time: e.time.tod, timeOfDay: e.time.phase === 'день' || e.time.phase === 'закат' ? 'day' : 'night',
    gameMode: bot.game ? bot.game.gameMode : null,
    biome: e.biome, lightLevel: light,
    eyes: { time: e.time, weather: e.weather, vitals: e.vitals, enemies: e.enemies, players: e.players, aggressors: e.aggressors, threats: e.threats, animals: e.animals, blocks: e.blocks, hazards: e.hazards, task: e.task },
    sheltered: (() => { try { return shelterInfo(ctx); } catch (err) { return null; } })(), // в укрытии: крыша и стены вокруг
    autopilot: ctx.autopilot && ctx.autopilot.status ? ctx.autopilot.status() : null,
    stats: ctx.statsBrief()
  };
}

module.exports = { invSummary, snapshot, shelterInfo, eyes, timeInfo, NIGHT_START, NIGHT_END, scanUseful, entitiesNear };
