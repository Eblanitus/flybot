// Блоки для стен и крыши укрытия по свойствам (этап 2, баг пустыни и мезы 04.11: песок не считался блоком — муха копала вниз без конца).
// Годится: полный твёрдый непрозрачный блок, который можно поставить, и не ценный (не бревно, не руда, не верстак…).
// Крыша — без сыпучих: песок и гравий падают на голову.
'use strict';
let MD = null; try { MD = require('minecraft-data')(process.env.MC_VERSION || '26.1'); } catch (e) {}
const DENY = /(_log|_wood|_stem|_hyphae|_ore|_wool|_leaves|glass|ice|_slab|_stairs|_wall|fence|door|_pane|_bed|sign|banner|carpet|chest|barrel|shulker|table|furnace|smoker|anvil|tnt|piston|observer|dispenser|dropper|hopper|beacon|spawner|cake|pot|_head|skull|button|lever|plate|rail|torch|lantern|campfire|ladder|scaffold|honey|slime|sponge|magma|soul_sand|farmland|dirt_path|powder_snow|cactus|pumpkin|melon|hay_block|bookshelf|lectern|composter|bell|jukebox|note_block|target|lodestone|portal|_block$|suspicious_|infested_|bedrock|obsidian)/;
const GRAVITY = /^(sand|red_sand|gravel)$|_concrete_powder$/;
const cache = new Map();
function isShelterBlock(name) {
  if (cache.has(name)) return cache.get(name);
  const b = MD && MD.blocksByName[name];
  const ok = !!(b && MD.itemsByName[name] && !DENY.test(name) && b.boundingBox === 'block' && !b.transparent && b.diggable !== false);
  cache.set(name, ok);
  return ok;
}
const isGravity = name => GRAVITY.test(String(name || ''));
module.exports = { isShelterBlock, isGravity, DENY, GRAVITY };
