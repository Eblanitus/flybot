// near: подойти вплотную (до 2 блоков) — когда «видно» не находится (блок за углом, в листве, в стене туннеля).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const A = require('../../actions');
module.exports = {
  name: 'near', family: 'dig',
  desc: 'подойти вплотную (2 блока) — блок за углом, в листве, в стене',
  applies: () => true,
  run: (ctx, t, p) => A.goto(ctx, t, new goals.GoalNear(p.pos.x, p.pos.y, p.pos.z, 2), { timeout: p.timeout || 45000 })
};
