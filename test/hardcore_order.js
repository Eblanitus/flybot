// Офлайн-проверка этапа 1б (hardcore/order.js, hardcore/body.js): порядок дел, ступени, «застрял», выход из укрытия (8.1),
// и что дела запускают навыки FlyBot (на поддельном боте — еда и ожидание; прерывание и срок дела).
'use strict';
const assert = require('assert');
const O = require('../hardcore/order');
const B = require('../hardcore/body');

const base = { hp: 20, food: 20, foodItems: 0, tod: 1000, inv: {}, enemy: null, sheltered: false };
const S = x => Object.assign({}, base, x);
const D = x => O.decide(S(x), null, 0).do;

// --- снаружи, днём: ступени по порядку ---
assert.strictEqual(D({}), 'logs');                                                       // голые руки — к дереву
assert.strictEqual(O.decide(S({}), null, 0).count >= 4, true);                           // хватает на 1-ю ступень
assert.strictEqual(D({ inv: { oak_log: 3 } }), 'table');                                 // 12 досок ≥ 4+5+2
assert.strictEqual(D({ inv: { oak_log: 1 } }), 'logs');
assert.strictEqual(D({ inv: { oak_planks: 7, crafting_table: 1 } }), 'pickaxe');
assert.strictEqual(D({ inv: { oak_planks: 7 }, tableNear: true }), 'pickaxe');           // верстак стоит рядом — новый не нужен
assert.strictEqual(D({ inv: { oak_planks: 2, wooden_pickaxe: 1 }, tableNear: true }), 'stone');
assert.strictEqual(D({ inv: { oak_planks: 2, wooden_pickaxe: 1, cobblestone: 5 }, tableNear: true }), 'stone_tools');
assert.deepStrictEqual(O.decide(S({ inv: { oak_planks: 2, stone_pickaxe: 1, cobblestone: 2 }, tableNear: true }), null, 0).items, ['stone_sword']);
const tools = { oak_planks: 2, stone_pickaxe: 1, stone_sword: 1, crafting_table: 1 };
assert.strictEqual(D({ inv: tools }), 'hunt');                                           // ступень 5: запас еды
assert.strictEqual(D({ inv: tools, foodItems: 6 }), 'hunt');                             // утром добирает до 10
assert.strictEqual(D({ inv: tools, foodItems: 6, tod: 10000 }), 'explore');              // к вечеру — не охота впрок
assert.strictEqual(D({ inv: tools, foodItems: 12 }), 'explore');

// --- опасность и еда ---
assert.strictEqual(D({ enemy: { name: 'zombie', d: 5 } }), 'flee');
assert.strictEqual(D({ enemy: { name: 'zombie', d: 5 }, inv: tools }), 'fight');         // каменный меч и HP высокий
assert.strictEqual(D({ enemy: { name: 'creeper', d: 5 }, inv: tools }), 'flee');         // с крипером не дерёмся
assert.strictEqual(D({ enemy: { name: 'zombie', d: 5 }, inv: tools, hp: 8 }), 'flee');
assert.strictEqual(D({ enemy: { name: 'zombie', d: 15 } }), 'logs');                    // далеко — делами
assert.strictEqual(D({ food: 12, foodItems: 3 }), 'eat');
assert.strictEqual(D({ food: 16, hp: 15, foodItems: 3 }), 'eat');                        // ранен — доедать ради лечения
assert.strictEqual(D({ food: 12 }), 'hunt');                                             // голоден, еды нет — за едой раньше ступеней

// --- вечер и ночь: еда до укрытия ---
assert.strictEqual(D({ tod: 11200, inv: tools }), 'hunt');                              // закат, еды < 5 — успеть поохотиться
assert.strictEqual(D({ tod: 11200, inv: tools, foodItems: 5 }), 'shelter');
assert.strictEqual(D({ tod: 12100, inv: tools }), 'shelter');                           // поздно охотиться — в укрытие
assert.strictEqual(D({ tod: 15000 }), 'shelter');
assert.strictEqual(D({ tod: 15000, enemy: { name: 'zombie', d: 4 } }), 'flee');

// --- в укрытии: выход только здоровым (8.1) ---
const sh = x => D(Object.assign({ sheltered: true }, x));
assert.strictEqual(sh({ tod: 15000 }), 'wait');                                         // ночь — сидеть
assert.strictEqual(sh({ tod: 15000, food: 10, foodItems: 2 }), 'eat');
assert.strictEqual(sh({ tod: 23600 }), 'leave');                                        // рассвет, здоров
assert.strictEqual(sh({ tod: 1000, hp: 8, food: 19 }), 'wait');                         // лечится — ждать
assert.strictEqual(sh({ tod: 1000, hp: 8, food: 19, foodItems: 2 }), 'eat');            // есть еда — доедает до 20
assert.strictEqual(sh({ tod: 1000, hp: 8, food: 15 }), 'leave');                        // не лечится и еды нет — днём за едой
assert.strictEqual(O.decide(S({ sheltered: true, tod: 1000, hp: 8, food: 15 }), null, 0).then, 'hunt');
assert.strictEqual(sh({ tod: 1000, enemy: { name: 'skeleton', d: 12 } }), 'wait');      // стрелок рядом — не выходить
assert.strictEqual(sh({ tod: 1000, enemy: { name: 'skeleton', d: 20 } }), 'leave');
assert.strictEqual(sh({ tod: 1000, enemy: { name: 'zombie', d: 3 } }), 'leave');        // зомби днём горит; выход в сторону — навыком

// --- застрял: 3 неудачи подряд → 5 минут не берём, бот идёт дальше по списку ---
{
  const st = O.makeStuck();
  assert.strictEqual(st.fail('logs', 0), false); assert.strictEqual(st.fail('logs', 0), false);
  st.ok('logs'); assert.strictEqual(st.fail('logs', 0), false);                         // успех обнуляет счёт
  assert.strictEqual(st.fail('logs', 0), false); assert.strictEqual(st.fail('logs', 0), true);
  assert.strictEqual(O.decide(S({}), st, 1000).do, 'hunt');                              // нет дерева — пусть хоть еда
  assert.strictEqual(O.decide(S({}), st, O.T.STUCK_MS + 1).do, 'logs');                 // через 5 минут — снова
  const all = O.makeStuck(); for (const a of ['shelter', 'shelter', 'shelter']) all.fail(a, 0);
  assert.strictEqual(O.decide(S({ tod: 15000 }), all, 1).do, 'wait');
}

// камень «застрял» и булыжника нет — не крафтить каменное впустую (на ПК 04.11 крутилось stone → stone_tools)
{
  const st = O.makeStuck(); for (let i = 0; i < 3; i++) st.fail('stone', 0);
  const d = O.decide(S({ inv: { oak_planks: 4, wooden_pickaxe: 1 }, tableNear: true }), st, 1).do;
  assert.notStrictEqual(d, 'stone_tools'); assert.strictEqual(d, 'hunt');
}

// --- ступени ---
{
  assert.deepStrictEqual(O.stepsNow({ inv: { oak_log: 4 } }), [1]);
  assert.deepStrictEqual(O.stepsNow({ inv: { birch_log: 2, crafting_table: 1, wooden_pickaxe: 1 }, food: 5 }), [2, 3, 5]);
  assert.deepStrictEqual(O.stepsNow({ inv: { stone_pickaxe: 1, stone_sword: 1 }, tablePlaced: true, nightSurvived: true }), [2, 3, 4, 6]);
  const l = O.makeLadder();
  assert.deepStrictEqual(l.update({ inv: { oak_log: 5 } }, 30, 1500), [1]);
  assert.deepStrictEqual(l.update({ inv: {} }, 40, 1600), []);                           // брёвна ушли на доски — ступень остаётся
  assert.deepStrictEqual(l.update({ inv: { wooden_pickaxe: 1 }, tablePlaced: true }, 90, 2900), [2, 3]);
  assert.deepStrictEqual(l.reached[1], { lifeSec: 30, wt: 1500 });
  assert.strictEqual(l.top(), 3);
}
assert(O.isDay(0) && O.isDay(23600) && !O.isDay(11500) && O.isNight(14000) && !O.isNight(11500));

// --- body: каждое дело из decide() есть в таблице навыков; что прерывается ---
for (const a of ['flee', 'fight', 'eat', 'wait', 'leave', 'shelter', 'hunt', 'logs', 'table', 'pickaxe', 'stone', 'stone_tools', 'explore'])
  assert(typeof B.RUN[a] === 'function' && B.LIMIT_SEC[a] > 0, a);
assert.strictEqual(B.shouldPreempt({ do: 'logs' }, { do: 'flee' }), true);
assert.strictEqual(B.shouldPreempt({ do: 'hunt' }, { do: 'shelter' }), true);              // закат застал на охоте
assert.strictEqual(B.shouldPreempt({ do: 'shelter' }, { do: 'flee' }), false);             // укрытие доделать
assert.strictEqual(B.shouldPreempt({ do: 'logs' }, { do: 'eat' }), false);
assert.strictEqual(B.shouldPreempt({ do: 'logs' }, { do: 'logs' }), false);

// все навыки FlyBot грузятся (без игры)
for (const m of ['gather', 'craft', 'survival', 'combat', 'basic']) require('../lib/skills/' + m);

(async () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1b-'));
  const inv = [{ name: 'bread', count: 2 }];
  let halted = 0;
  const bot = {
    food: 12, foodSaturation: 0, health: 20, registry: { foodsByName: { bread: { foodPoints: 5 } } },
    inventory: { items: () => inv.filter(i => i.count > 0) },
    equip: async () => {}, consume: async () => { inv[0].count--; bot.food += 5; },
    pathfinder: { setGoal() { halted++; }, setMovements() {} }, clearControlStates() {}
  };
  const ctx = B.makeCtx(bot, path.join(dir, 'HC_1.mem'));
  assert(fs.existsSync(path.join(dir, 'HC_1.mem')) && ctx.killers && ctx.events.push);
  let r = await B.start(ctx, { do: 'eat' }).done;
  assert(r.ok && bot.food === 17 && inv[0].count === 1, JSON.stringify(r));
  r = await B.start(ctx, { do: 'wait' }).done;
  assert(r.ok && r.ms >= 900);
  const job = B.start(ctx, { do: 'wait' });
  setTimeout(() => job.task.abort('срочнее: flee'), 100);
  r = await job.done;
  assert(!r.ok && r.aborted && halted > 0, JSON.stringify(r));
  r = await B.start(ctx, { do: 'fly' }).done;
  assert(!r.ok && /нет такого дела/.test(r.error));
  // не нашёл рядом — разведка и вторая попытка (через orExplore), чужие ошибки — сразу неудача
  {
    const gather = require('../lib/skills/gather'), combat = require('../lib/skills/combat');
    const real = { explore: gather.explore, hunt: combat.hunt };
    let explored = 0, tries = 0;
    gather.explore = async () => { explored++; return {}; };
    combat.hunt = async () => { if (++tries === 1) throw new Error('животных рядом нет'); return { kills: 1 }; };
    r = await B.start(ctx, { do: 'hunt', count: 1 }).done;
    assert(r.ok && explored === 1 && tries === 2, JSON.stringify(r));
    combat.hunt = async () => { throw new Error('отступил: мало HP'); };
    r = await B.start(ctx, { do: 'hunt' }).done;
    assert(!r.ok && explored === 1);
    // разведка FlyBot отказала у обрыва — идём pathfinder-ом в случайную сторону
    const A = require('../lib/actions'), realGoto = A.goto;
    const { Vec3 } = require('../lib/util');
    bot.entity = { position: new Vec3(0, 64, 0) };
    gather.explore = async () => { throw new Error('не удалось уйти исследовать: внизу обрыв'); };
    let gotos = 0;
    A.goto = async (c, tk, goal) => { gotos++; if (gotos === 1) throw new Error('нет пути'); bot.entity.position = new Vec3(goal.x, 64, goal.z); return true; };
    r = await B.start(ctx, { do: 'explore' }).done;
    assert(r.ok && gotos === 2 && r.result.roamed >= 16, JSON.stringify(r));
    A.goto = realGoto;
    Object.assign(gather, { explore: real.explore }); combat.hunt = real.hunt;
  }
  console.log('hardcore_order: ok');
})().catch(e => { console.error(e); process.exit(1); });
