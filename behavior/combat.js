// Выбор способа действия (поведение): какой вариант семейства взять — бой (melee: lib/variants/melee/*) и остальные
// семейства (escape, shelter, climb, descend, home, dig, place: lib/variants/<семейство>/*).
// Сейчас — бандит по опыту (data/variants.json: счёт каждого варианта по обстановке), у боя запасной — kite.
// Ядро зовёт chooseMelee / chooseVariant через хост; если поведения нет или оно упало — тот же выбор делает само.
'use strict';
const L = require('./core');

function chooseMelee(ctx, sit, { style, exclude } = {}) {
  const V = L('variants');
  exclude = exclude || new Set();
  return V.choose(ctx, 'melee', sit, { style, exclude }) ||
    (exclude.has('kite') ? null : { variant: V.family('melee').variants.get('kite'), name: 'kite', keys: V.keysFor(V.family('melee'), sit), why: 'запасной' });
}

// Д: остальные семейства — тот же выбор (style от мозга, иначе лучший по счёту в этой обстановке)
function chooseVariant(ctx, family, sit, opts = {}) {
  const V = L('variants');
  if (family === 'escape' && (sit.target === 'skeleton' || sit.ranged) && (sit.dist == null || sit.dist < 10)) {
    const fam = V.family('escape');
    return {
      variant: {
        name: 'escape_to_base',
        family: 'escape',
        desc: 'бегство к базе от скелета (<10м)',
        applies: () => true,
        async run(ctx, t, p, sit) {
          const C = require('../lib/variants/escape/_core');
          const A = require('../lib/actions');
          const { goals } = require('mineflayer-pathfinder');
          const fs = require('fs');
          const path = require('path');
          const { parseBase } = require('../lib/basegoal');
          const done = C.measure(ctx);
          t.progress('убегаю к базе от скелета');
          let base = ctx.base;
          if (!base) {
            try {
              const notes = fs.readFileSync(path.join(__dirname, '../brain/notes.md'), 'utf8');
              base = parseBase(notes);
            } catch (e) {}
          }
          if (base) {
            try {
              await A.goto(ctx, t, new goals.GoalNear(base.x, base.y, base.z, 2), { timeout: 15000, sprint: true });
              return done();
            } catch (e) {
              if (e.aborted) throw e;
            }
          }
          const u = C.unit(p.vector);
          const me = ctx.bot.entity.position, dist = p.distance || 16;
          if (u) {
            try { await A.goto(ctx, t, new goals.GoalNearXZ(me.x + u.x * dist, me.z + u.z * dist, 2), { timeout: 10000, sprint: true }); } catch (e) { if (e.aborted) throw e; }
          }
          return done();
        }
      },
      name: 'escape_to_base',
      why: 'приоритет отхода к базе от скелета (<10м)',
      keys: V.keysFor(fam, sit)
    };
  }
  return V.choose(ctx, family, sit, opts);
}

module.exports = { chooseMelee, chooseVariant };
