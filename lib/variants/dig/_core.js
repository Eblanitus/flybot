// Общее семейства dig: подойти к блоку выбранным вариантом и записать исход (дотянулась ли и за сколько).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
const danger = require('../../danger');

const kindOf = n => (/_(log|wood|stem|hyphae)$/.test(n) ? 'log' : /_ore$|ancient_debris/.test(n) ? 'ore'
  : /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|netherrack|blackstone|sandstone)$/.test(n) ? 'stone'
  : /^(dirt|grass_block|coarse_dirt|podzol|mud|sand|red_sand|gravel|clay|snow_block|rooted_dirt)$/.test(n) ? 'soil' : 'other');

const eyeDist = (bot, pos) => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));

// Подойти к блоку pos (Vec3) вариантом семейства dig. opts: { style, limit (дотянуться, м), timeout (мс), name (блок), ownBlocks, danger }.
async function approach(ctx, t, pos, { style = 'auto', limit = 5.2, timeout = 45000, name = null, ownBlocks = null, danger: dangerCtx = null } = {}) {
  const V = require('../../variants'), bot = ctx.bot;
  const b = name ? null : bot.blockAt(pos);
  const sit = V.situation(ctx, null, { blockKind: kindOf(name || (b && b.name) || ''), dy: pos.y - Math.floor(bot.entity.position.y) });
  const ch = V.pick(ctx, 'dig', sit, { style });
  if (!ch) { await A.goto(ctx, t, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { timeout }); return { reach: eyeDist(bot, pos), variant: null }; }
  const t0 = Date.now();
  let result = null, error = null;
  // Передаём ownBlocks и danger в вариант
  const params = { pos, timeout, name, ownBlocks, danger: dangerCtx || danger.state(ctx) };
  try { await ch.variant.run(ctx, t, params, sit); } catch (e) { if (e.aborted) throw e; error = e; }
  const reach = eyeDist(bot, pos);
  result = { reach, reached: reach <= limit };
  V.judge(ctx, 'dig', ch.name, ch.keys, { result, error, ms: Date.now() - t0, sit, ctx });
  if (error) throw error;
  return { ...result, variant: ch.name };
}

module.exports = { approach, kindOf, eyeDist };
