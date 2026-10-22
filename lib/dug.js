// «Муха выкопала блок»: одно событие бота 'fly_dug' (block — КАКИМ блок был до слома: имя и позиция).
// Почему не mineflayer 'diggingCompleted': он отдаёт уже воздух (имени выкопанного нет), а при смерти mineflayer снимает ВСЕ
// его слушатели (plugins/digging.js: removeAllListeners) — после первой смерти учёт, итог дня и критик глохли.
// bot.dig появляется только после загрузки плагинов (inject_allowed), поэтому обёртку ставим при первой возможности:
// сразу, на login и на spawn. Ставится один раз на экземпляр бота.
'use strict';

function install(bot) {
  const wrap = () => {
    if (bot.__flyDug || typeof bot.dig !== 'function') return !!bot.__flyDug;
    bot.__flyDug = true;
    const orig = bot.dig;
    bot.dig = function (block, ...rest) {
      const was = block ? { name: block.name, position: block.position, type: block.type } : null;
      bot.__flyDigging = was; // кто ломает этот блок: сама муха (lib/ownblocks.js)
      return Promise.resolve(orig.call(this, block, ...rest)).then(r => {
        try { if (was && was.name) bot.emit('fly_dug', was); } catch (e) {}
        return r;
      }).finally(() => { if (bot.__flyDigging === was) bot.__flyDigging = null; });
    };
    return true;
  };
  if (!wrap() && !bot.__flyDugWaiting && typeof bot.once === 'function') {
    bot.__flyDugWaiting = true;
    for (const ev of ['inject_allowed', 'login', 'spawn']) bot.once(ev, () => setImmediate(wrap));
  }
}

// Слушать выкопанное мухой: fn(block) — { name, position }
function onDug(bot, fn) {
  install(bot);
  bot.on('fly_dug', b => { try { fn(b); } catch (e) {} });
}

module.exports = { install, onDug };
