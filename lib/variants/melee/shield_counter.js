// shield_counter: щит поднят, пока оружие заряжается (блок замаха/стрелы), по заряду — опустить и контрудар.
// Против скелетов (подход под щитом) и игроков. Нужен щит в инвентаре/левой руке.
'use strict';
const M = require('../../melee');
const C = require('./_core');

function raise(env) { const { bot, st } = env; if (!st.data.up) { try { bot.activateItem(true); st.data.up = true; } catch (e) {} } }
function lower(env) { const { bot, st } = env; if (st.data.up) { try { bot.deactivateItem(); } catch (e) {} st.data.up = false; } }

module.exports = {
  name: 'shield_counter', family: 'melee',
  desc: 'держит щит на перезарядке и подходе, по заряду опускает и бьёт (против скелетов и игроков)',
  applies: (ctx, sit) => !!sit.shield && !sit.creeper && !sit.water,
  run: (ctx, t, p, sit) => C.engage(ctx, t, { ...p, variant: 'shield_counter' }, sit, {
    async setup(env) {
      const bot = env.bot, off = bot.inventory.slots && bot.inventory.slots[45];
      if (off && off.name === 'shield') return true;
      const sh = bot.inventory.items().find(i => i.name === 'shield');
      if (!sh) return false;
      try { await bot.equip(sh, 'off-hand'); return true; } catch (e) { return false; }
    },
    async strike(env) { lower(env); await env.t.sleep(50); return C.hitNow(env); },
    async cooldown(env, mode) {
      M.setMove(env.bot, mode === 'back' && env.hbd() < 1.6 && C.canBack(env) ? 'back' : null);
      if (env.hbd() < 5) raise(env); else lower(env);
    },
    async approach(env, d) { if (d < 12) raise(env); return C.follow(env, d); },
    cleanup: lower
  })
};
