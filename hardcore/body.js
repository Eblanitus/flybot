// Руки бота этапа 1б: дела из hardcore/order.js исполняют готовые навыки FlyBot (lib/skills/), а не новый код.
// FlyBot не меняется: навыкам нужен «ctx» — здесь его самый маленький вариант. Своя папка памяти на жизнь (variants.json),
// чтобы ни прошлые жизни, ни архив FlyBot не подсказывали боту — на 1б это контроль «без памяти».
'use strict';
const fs = require('fs');
const { Task } = require('../lib/tasks');

// Навыки грузятся лениво: test/hardcore_order.js проверяет makeCtx и таблицу дел без mineflayer и без игры.
const S = () => ({
  gather: require('../lib/skills/gather'), craft: require('../lib/skills/craft'), survival: require('../lib/skills/survival'),
  combat: require('../lib/skills/combat'), basic: require('../lib/skills/basic'), A: require('../lib/actions'), vision: require('../lib/vision')
});

function makeCtx(bot, dataDir) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
  const ctx = {
    bot, ready: false, dataDir, events: { log: [], push(type, data) { this.log.push({ type, ...(data || {}) }); if (this.log.length > 100) this.log.shift(); } },
    stats: { deaths: 0, damageTaken: 0, blocksMined: 0, blocksPlaced: 0, distanceTraveled: 0 }, statsDirty: false,
    visited: new Set(), movements: null, sprintMovements: null, killers: {}, aggressors: {}, tasks: {}
  };
  ctx.markVisited = p => ctx.visited.add(Math.floor(p.x / 16) + ',' + Math.floor(p.z / 16));
  ctx.haltBody = () => {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    try { if (bot.targetDigBlock) bot.stopDigging(); } catch (e) {}
    try { bot.clearControlStates(); } catch (e) {}
    try { if (ctx.movements) bot.pathfinder.setMovements(ctx.movements); } catch (e) {}
  };
  return ctx;
}

// После появления в мире: ходьба (можно копать и ставить подпорки — как у FlyBot) и зрение.
function attach(ctx, session) {
  const { A, vision } = S();
  const bot = ctx.bot;
  ctx.movements = A.makeMovements(bot, { ctx });
  ctx.sprintMovements = A.makeMovements(bot, { sprint: true, ctx });
  bot.pathfinder.setMovements(ctx.movements);
  bot.pathfinder.thinkTimeout = 8000;
  vision.attach(ctx, bot, session);
  ctx.ready = true;
}

// Сколько секунд даём делу. Вышло — дело прерывается и считается неудачей.
const LIMIT_SEC = { flee: 20, fight: 15, eat: 15, wait: 2, leave: 20, shelter: 60, hunt: 200, logs: 300, table: 60, pickaxe: 60, stone: 300, stone_tools: 60, explore: 90 };

// Дело → вызов навыка FlyBot. Возвращает то, что вернул навык; неудача — исключение.
const RUN = {
  flee: (ctx, t) => S().combat.escape(ctx, t, { distance: 16 }),
  fight: (ctx, t) => S().combat.defend(ctx, t, { duration: 10 }),
  eat: (ctx, t) => S().basic.eat(ctx, t, {}),
  wait: (ctx, t) => t.sleep(1000).then(() => ({ waited: 1 })),
  async leave(ctx, t) { if (!(await S().survival.leaveShelter(ctx, t))) throw new Error('выйти некуда: вокруг лава или вода'); return { left: true }; },
  shelter: (ctx, t) => S().survival.shelter(ctx, t, {}),
  hunt: (ctx, t, d) => orExplore(ctx, t, () => S().combat.hunt(ctx, t, { count: d.count || 1 })),
  logs: (ctx, t, d) => orExplore(ctx, t, () => S().gather.collect(ctx, t, { block: 'log', count: d.count || 4 })),
  table: (ctx, t) => S().craft.ensureStation(ctx, t, 'crafting_table').then(b => ({ table: b && b.position ? [b.position.x, b.position.y, b.position.z] : true })),
  pickaxe: (ctx, t) => S().craft.craftItem(ctx, t, 'wooden_pickaxe', 1).then(() => ({ item: 'wooden_pickaxe' })),
  // камень с поверхности обычно не виден: не нашёл — спуск лесенкой на 6 блоков (навык descend) и снова
  async stone(ctx, t, d) {
    const get = () => S().gather.collect(ctx, t, { block: 'stone', count: d.count || 8 });
    try { return await get(); }
    catch (e) {
      if (e.aborted || !NOT_FOUND.test(String(e.message))) throw e;
      t.progress('камня не видно — спускаюсь');
      await require('../lib/skills/move').descend(ctx, t, { depth: 6 });
      return get();
    }
  },
  async stone_tools(ctx, t, d) { for (const it of d.items || []) await S().craft.craftItem(ctx, t, it, 1); return { items: d.items }; },
  explore: (ctx, t) => S().gather.explore(ctx, t, { distance: 48 })
};

// Не нашёл рядом (нет деревьев, нет животных) — разведка в новую сторону и ещё одна попытка, а не стоять на месте.
const NOT_FOUND = /не вижу|не нашёл|рядом нет|нет рядом|никого/i;
async function orExplore(ctx, t, fn) {
  try { return await fn(); }
  catch (e) {
    if (e.aborted || !NOT_FOUND.test(String(e.message))) throw e;
    t.progress('рядом нет — разведка');
    await S().gather.explore(ctx, t, { distance: 64 });
    return fn();
  }
}

let seq = 0;
// Начать дело. Возвращает { task, done: Promise<{ok, result?, error?, ms}> }. task.abort(причина) — прервать (враг, закат).
function start(ctx, d) {
  const fn = RUN[d.do];
  const task = new Task(++seq, d.do, d, 'autopilot', 'stage1b');
  task.onAbort(() => ctx.haltBody());
  const t0 = Date.now();
  const timer = setTimeout(() => task.abort('срок дела вышел'), (LIMIT_SEC[d.do] || 60) * 1000);
  const done = (async () => {
    if (!fn) throw new Error('нет такого дела: ' + d.do);
    return fn(ctx, task, d);
  })().then(result => ({ ok: true, result, ms: Date.now() - t0 }),
    e => ({ ok: false, error: String((e && e.message) || e).slice(0, 200), aborted: !!task.aborted, reason: task.reason, ms: Date.now() - t0 }))
    .finally(() => clearTimeout(timer));
  return { task, done, d };
}

// Что можно прервать ради более срочного: укрытие и бегство не прерываем — доделать важнее.
const URGENT = new Set(['flee', 'fight', 'shelter']);
function shouldPreempt(cur, next) {
  if (!cur || !next || cur.do === next.do) return false;
  if (cur.do === 'shelter' || cur.do === 'flee' || cur.do === 'leave') return false;
  return URGENT.has(next.do);
}

module.exports = { makeCtx, attach, start, shouldPreempt, RUN, LIMIT_SEC };
