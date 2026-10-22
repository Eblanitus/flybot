// stairs: выкопать лесенку вниз (шаг вперёд и вниз; 3 блока на ступень). Лава/вода рядом, пустота под ступенью,
// сыпучее над головой — другое направление; некуда — стоп. Не в воде, не на лестнице.
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, SkillError } = require('../../util');
const A = require('../../actions');

const FLUID = new Set(['lava', 'water', 'flowing_lava', 'flowing_water', 'bubble_column']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'pointed_dripstone']);
const isFalling = n => FALLING.has(n) || n.endsWith('concrete_powder');
const NO_DIG = new Set(['bedrock', 'barrier', 'end_portal_frame', 'reinforced_deepslate']);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Почему ступень в (cur + d) вниз нельзя (строка) или null
function stepBad(bot, cur, dx, dz) {
  const nx = cur.x + dx, nz = cur.z + dz;
  const cells = [cur.y + 1, cur.y, cur.y - 1, cur.y - 2].map(y => new Vec3(nx, y, nz));
  for (const c of cells) {
    const b = bot.blockAt(c); if (!b) return 'чанк не загружен';
    if (FLUID.has(b.name)) return b.name;
    if (NO_DIG.has(b.name) && c.y > cur.y - 2) return 'нельзя копать: ' + b.name;
    for (const f of A.FACES) { const nb = bot.blockAt(c.plus(f)); if (nb && FLUID.has(nb.name)) return nb.name + ' рядом'; }
  }
  if (!A.isSolid(bot.blockAt(cells[3]))) return 'пустота под ступенью';
  const roof = bot.blockAt(new Vec3(nx, cur.y + 2, nz));
  if (roof && isFalling(roof.name)) return 'сыпучий блок над головой';
  return null;
}

module.exports = {
  name: 'stairs', family: 'descend',
  desc: 'выкопать лесенку вниз (3 блока на ступень), обходя лаву/воду/пустоту',
  applies: (ctx, sit) => !sit.water && !sit.ladder,
  async run(ctx, t, p) {
    const bot = ctx.bot, M = require('../../skills/move');
    let dir = null; const why = [];
    for (let step = 0; step < 64; step++) {
      t.check();
      const cur = bot.entity.position.floored();
      if (cur.y <= p.ty) break;
      const order = dir ? [dir, ...DIRS.filter(d => d !== dir)] : DIRS;
      const d = order.find(([dx, dz]) => { const w = stepBad(bot, cur, dx, dz); if (w) why.push(w); return !w; });
      if (!d) break;
      dir = d;
      t.progress(`лесенка вниз: y=${cur.y} → ${p.ty}`);
      for (const y of [cur.y + 1, cur.y, cur.y - 1]) {
        t.check();
        const b = bot.blockAt(new Vec3(cur.x + d[0], y, cur.z + d[1]));
        if (!A.isSolid(b)) continue;
        await A.equipToolFor(bot, b);
        const off = t.onAbort(() => { try { bot.stopDigging(); } catch (e) {} });
        try { await bot.dig(b, true); } finally { off(); }
        if (ctx.stats) { ctx.stats.blocksMined = (ctx.stats.blocksMined || 0) + 1; ctx.statsDirty = true; }
      }
      try { await A.goto(ctx, t, new goals.GoalBlock(cur.x + d[0], cur.y - 1, cur.z + d[1]), { timeout: 6000 }); } catch (e) { if (e.aborted) throw e; }
      if (bot.entity.position.floored().y >= cur.y) break; // не шагнула вниз — дальше не копаем
    }
    const r = M.heightResult(bot, p.y0, p.ty);
    const stop = [...new Set(why)].slice(0, 3).join(', ');
    if (!r.went) throw new SkillError('лесенка вниз не вышла: ' + (stop || 'не спустилась'), r);
    return r.reached ? r : { ...r, stopped: stop || 'не спустилась дальше' };
  },
  stepBad
};
