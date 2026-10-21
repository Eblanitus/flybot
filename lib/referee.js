// Судья против спавн-килла (по просьбе хозяина мира). Не навык и не API: мозг его не вызывает.
// Если муху убил бот FlyBot*, судья отправляет убийцу на ~1000 блоков от мухи
// в случайную сторону и ставит ему там точку возрождения.
const KILLER_RE = /\bby (FlyBot\w*)/i;
const DIST = 1000;
let lastAt = 0;

function onDeath(ctx, d) {
  const m = KILLER_RE.exec(d.message || '');
  if (!m) return;
  const killer = m[1];
  if (Date.now() - lastAt < 15000) return; // одна отправка на серию смертей
  lastAt = Date.now();
  let tries = 0;
  const run = () => {
    const bot = ctx.bot;
    // ждём возрождения мухи: считаем от точки, где она теперь появляется
    if (!bot || !ctx.ready || !bot.entity || bot.health <= 0) { if (++tries < 20) setTimeout(run, 1000); return; }
    const a = Math.random() * Math.PI * 2;
    const x = Math.round(bot.entity.position.x + Math.cos(a) * DIST);
    const z = Math.round(bot.entity.position.z + Math.sin(a) * DIST);
    try {
      bot.chat(`/spreadplayers ${x} ${z} 0 1 false ${killer}`);
      setTimeout(() => { try { bot.chat(`/execute as ${killer} at @s run spawnpoint @s ~ ~ ~`); } catch (e) {} }, 2000);
    } catch (e) { return; }
    ctx.events.push('info', { msg: `судья: ${killer} убил муху — отправлен к ${x} ${z}, там же его точка возрождения` });
  };
  setTimeout(run, 2000);
}

module.exports = { onDeath };
