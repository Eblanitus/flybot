// Офлайн-проверки семейств вариантов действий тела (Д): escape, shelter, climb, descend, home, dig, place.
// На каждое семейство: варианты загружены, applies отсекает неподходящее, выбор/запуск/оценка/запись, счёт виден в итоге,
// style от мозга работает, неизвестный style — ошибка; выбор идёт через поведение (chooseVariant), если оно есть.
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const V = require('../lib/variants');
const A = require('../lib/actions');

const solid = n => !['air', 'water', 'lava'].includes(n);
const flat = (x, y) => (y <= 65 ? 'dirt' : 'air');
function fakeBot(gen = flat, { inv = [] } = {}) {
  const calls = [];
  const bot = {
    username: 'FlyTest', health: 20, food: 20, heldItem: null,
    entity: { id: 1, position: new Vec3(0.5, 66, 0.5), height: 1.8, velocity: new Vec3(0, 0, 0), onGround: true }, entities: {}, players: {},
    inventory: { items: () => inv, slots: {} },
    blockAt(p) { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), n = gen(x, y, z); return n == null ? null : { name: n, boundingBox: solid(n) ? 'block' : 'empty', position: new Vec3(x, y, z) }; },
    pathfinder: { setMovements() {}, setGoal() {} },
    setControlState() {}, clearControlStates() {}, lookAt: async () => {}, equip: async () => {}
  };
  bot.entities[1] = bot.entity;
  return { bot, calls, ctx: { bot, stats: { blocksPlaced: 0, blocksMined: 0 }, variantRand: () => 0.99 } };
}
let nextMobId = 10;
const mob = (bot, name, x, z = 0.5, extra = {}) => { const id = nextMobId++; const e = { id, name, type: 'hostile', position: new Vec3(x, 66, z), height: 1.95, width: 0.6, ...extra }; bot.entities[id] = e; return e; };
const task = () => new Task(1, 'test', {}, 'test');
// подменённый путь: цель-точка — встать в неё; GoalY — подняться/опуститься; журнал целей
function fakeGoto(bot, log) {
  return async (ctx, t, g) => {
    log.push(g.constructor.name);
    if (g.constructor.name === 'GoalY') bot.entity.position = new Vec3(bot.entity.position.x, g.y, bot.entity.position.z);
    else if (g.x != null && g.z != null) bot.entity.position = new Vec3(g.x + 0.5, g.y != null ? g.y : bot.entity.position.y, g.z + 0.5);
    else if (g.pos) bot.entity.position = new Vec3(g.pos.x + 0.5, g.pos.y - 1, g.pos.z + 1.5);
    return true;
  };
}

module.exports = async () => {
  V.setRegistry(null);
  const reg = V.registry();
  assert.strictEqual(reg.errors.length, 0, JSON.stringify(reg.errors));
  const want = { escape: ['cave_escape', 'cover_escape', 'escape_to_base', 'pillar', 'sprint_away', 'wall_escape', 'zigzag'], shelter: ['dig', 'smart', 'walls'], climb: ['path', 'pillar'], descend: ['path', 'stairs'], home: ['direct', 'hops', 'short_hops'], dig: ['look', 'near', 'safe'], place: ['close', 'near', 'pillar'] };
  for (const [f, vs] of Object.entries(want)) assert.deepStrictEqual([...V.family(f).variants.keys()].sort(), vs, f);
  const ap = (f, n, sit) => V.family(f).variants.get(n).applies({}, { ceiling: 5, blocks: 0, ...sit });
  const oldGoto = A.goto;
  try {
    // ---- escape ----
    assert(ap('escape', 'pillar', { blocks: 5 }) && !ap('escape', 'pillar', { blocks: 5, rangedNearby: true }) && !ap('escape', 'pillar', { blocks: 5, creeper: true }) && !ap('escape', 'pillar', { blocks: 1 }) && !ap('escape', 'pillar', { blocks: 5, ceiling: 3 }), 'столб: не от стрелков/крипера, нужны блоки и потолок');
    assert(!ap('escape', 'pillar', { blocks: 5, rangedNearby: true }), 'столб: не применяется, когда стрелок рядом (rangedNearby)');
    assert(ap('escape', 'cover_escape', { rangedNearby: true }) && !ap('escape', 'cover_escape', { rangedNearby: false }), 'cover_escape: применяется только когда стрелок рядом');
    assert(!ap('escape', 'zigzag', { water: true }) && ap('escape', 'zigzag', {}));
    // escape_to_base: от стрелка (скелет/любой ranged) ближе 10 м; от ближнего бойца — не он
    assert(ap('escape', 'escape_to_base', { target: 'skeleton', dist: 9 }) && !ap('escape', 'escape_to_base', { target: 'skeleton', dist: 12 }), 'к базе бежим от стрелка <10м');
    assert(!ap('escape', 'escape_to_base', { target: 'zombie', dist: 5 }) && ap('escape', 'escape_to_base', { ranged: true, dist: 8 }), 'от ближнего бойца — прочь по вектору (вариант не применим)');
    const legs = V.family('escape').variants.get('zigzag').legs({ x: 1, z: 0 }, 15);
    assert(legs.length === 3 && legs[0].z > 0 && legs[1].z < 0 && legs.every(l => l.x > 0), 'зигзаг: отрезки в разные стороны, все прочь');
    {
      const { bot, ctx } = fakeBot(); mob(bot, 'zombie', 5); // 5м -> после бегства 16м = 21м > 20м, away=true
      const log = []; A.goto = fakeGoto(bot, log);
      const combat = require('../lib/skills/combat');
      const r = await combat.escape(ctx, task(), { shelter: false });
      assert(r.fled && r.variant === 'sprint_away' && r.away === true && /sprint_away 1\/1/.test(r.variants), 'бегство по прямой, оторвалась, счёт в итоге: ' + JSON.stringify(r));
      bot.entity.position = new Vec3(0.5, 66, 0.5); log.length = 0;
      const z = await combat.escape(ctx, task(), { shelter: false, style: 'zigzag' });
      assert(z.variant === 'zigzag' && log.length === 3, 'style=zigzag — три отрезка: ' + JSON.stringify({ z, log }));
      await assert.rejects(combat.escape(ctx, task(), { style: 'teleport' }), /такого варианта нет/);
      const st = V.stats(ctx, 'escape').stats.escape;
      assert(st.zombie.sprint_away.n === 1 && st.zombie.zigzag.n === 1, 'исход записан по обстановке (цель zombie): ' + JSON.stringify(st));
    }
    // --- escape_to_base: настоящий вариант (29181f0b08) — от скелета <10м бежит (к базе или прочь), исход записан по ключу skeleton
    {
      const { bot, ctx } = fakeBot(); mob(bot, 'skeleton', 5);
      const log = []; A.goto = fakeGoto(bot, log);
      const combat = require('../lib/skills/combat');
      const r = await combat.escape(ctx, task(), { shelter: false, style: 'escape_to_base' });
      assert(r.variant === 'escape_to_base' && r.away === true, 'от скелета <10м — отход к базе/прочь: ' + JSON.stringify(r));
      const st = V.stats(ctx, 'escape').stats.escape;
      assert(Object.entries(st).some(([, vs]) => vs.escape_to_base && vs.escape_to_base.ok === 1), 'счёт escape_to_base записан по ключу стрелка: ' + JSON.stringify(st));
    }
    // --- rangedNearby: скелет рядом -> pillar не выбирается, cover_escape или zigzag ---
    {
      const { bot, ctx } = fakeBot(); 
      mob(bot, 'spider', 11); // цель - паук 11м
      const skel = mob(bot, 'skeleton', 14); // скелет 14м - rangedNearby=true
      const log = []; A.goto = fakeGoto(bot, log);
      const combat = require('../lib/skills/combat');
      const r = await combat.escape(ctx, task(), { shelter: false });
      assert(r.variant !== 'pillar', 'pillar НЕ выбран при скелете рядом: ' + r.variant);
      assert(['cover_escape', 'zigzag', 'sprint_away', 'wall_escape', 'cave_escape'].includes(r.variant), 'выбран подходящий вариант: ' + r.variant);
      assert(r.why && r.why.length > 0, 'есть причина выбора: ' + r.why);
    }
// --- away считается по всем враждебным: если все ушли за 20м — away=true ---
    {
      const { bot, ctx } = fakeBot(); 
      mob(bot, 'zombie', 5); // зомби 5м -> после бегства 16м = 21м > 20м
      nextMobId = 10; // reset
      const skel = mob(bot, 'skeleton', 18); // скелет 18м -> после бегства 34м
      const log = []; A.goto = fakeGoto(bot, log);
      const combat = require('../lib/skills/combat');
      // используем sprint_away, чтобы убежать на полную дистанцию
      const r = await combat.escape(ctx, task(), { shelter: false, style: 'sprint_away' });
      // оба ушли за 20м -> away=true
      assert.strictEqual(r.away, true, 'away=true, когда все враги за 20м: ' + JSON.stringify(r));
    }
    // --- away=false, если хотя бы один враг остался в зоне выстрела ---
    {
      const { bot, ctx } = fakeBot(); 
      mob(bot, 'zombie', 3); // зомби близко
      const skel = mob(bot, 'skeleton', 50); // скелет ДАЛЕКО (не в fleeVector), но в выстреле
      // fakeGoto не двигает бота достаточно далеко
      const originalGoto = A.goto;
      A.goto = async (ctx, t, g) => { 
        // двигаем только на 5 блоков вместо цели
        const me = ctx.bot.entity.position;
        if (g.constructor.name === 'GoalNearXZ' && g.x != null) {
          const dx = g.x - me.x, dz = g.z - me.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 5) {
            ctx.bot.entity.position = new (me.constructor)(me.x + dx/dist*5, me.y, me.z + dz/dist*5);
          } else {
            ctx.bot.entity.position = new (me.constructor)(g.x, me.y, g.z);
          }
        }
        return true;
      };
      try {
        const combat = require('../lib/skills/combat');
        const r = await combat.escape(ctx, task(), { shelter: false });
        // скелет в 50м, бот сдвинулся на 5м -> скелет в 45м > 20м, но зомби в 3м -> сдвинулся на 5м -> зомби в 8м < 20м
        // away должен быть false, так как зомби остался в зоне
        assert.strictEqual(r.away, false, 'away=false, когда зомби остался в зоне: ' + JSON.stringify(r));
      } finally {
        A.goto = originalGoto;
      }
    }
    // ---- shelter ----
    {
      const S = require('../lib/skills/survival'), real = S.shelterImpl, modes = [];
      S.shelterImpl = async (ctx, t, p) => { modes.push(p.mode); return { mode: p.mode || 'dig', placed: 3 }; };
      try {
        const { ctx } = fakeBot(flat, { inv: [{ name: 'dirt', count: 9 }] });
        let r = await S.shelter(ctx, task(), {});
        assert(r.variant === 'smart' && modes[0] === null, 'без опыта — smart (как было): ' + JSON.stringify(r));
        r = await S.shelter(ctx, task(), { style: 'walls' });
        assert(r.variant === 'walls' && modes[1] === 'walls', 'style=walls');
        r = await S.shelter(ctx, task(), { style: 'dig' });
        assert(r.variant === 'dig' && modes[2] === 'dig');
        assert(ctx.sheltered, 'укрытие запомнено');
        assert(!ap('shelter', 'walls', { blocks: 2 }) && ap('shelter', 'walls', { blocks: 9 }), 'стены — только с блоками');
      } finally { S.shelterImpl = real; }
    }
    // ---- climb / descend ----
    {
      const M = require('../lib/skills/move');
      const { bot, ctx } = fakeBot();
      assert.deepStrictEqual(M.targetY(bot, { height: 5 }, true), { y0: 66, ty: 71 });
      assert.deepStrictEqual(M.targetY(bot, { y: 40 }, false), { y0: 66, ty: 40 });
      const log = []; A.goto = fakeGoto(bot, log);
      let r = await M.climb(ctx, task(), { height: 4 });
      assert(r.variant === 'path' && r.reached && r.y1 === 70 && log[0] === 'GoalY', 'подъём обходом: ' + JSON.stringify(r));
      assert(!ap('climb', 'pillar', { blocks: 2, rise: 4 }) && ap('climb', 'pillar', { blocks: 4, rise: 4 }), 'столб — блоков не меньше подъёма');
      r = await M.descend(ctx, task(), { depth: 3 });
      assert(r.variant === 'path' && r.reached && r.y1 === 67, 'спуск обходом: ' + JSON.stringify(r));
      await assert.rejects(M.climb(ctx, task(), { y: 10 }), /уже на высоте/);
      // неудача обходом — провал записан, следующая попытка с опытом берёт другой вариант
      A.goto = async () => { throw new Error('нет пути'); };
      await assert.rejects(M.descend(ctx, task(), { depth: 3, style: 'path' }), /спуск обходом не вышел: нет пути/);
      const sc = V.scores(ctx, 'descend', V.situation(ctx, null, { drop: 3 }));
      assert(sc.path.n === 2 && sc.path.ok === 1 && sc.stairs.n === 0, 'счёт вариантов в этой обстановке: ' + JSON.stringify(sc));
      // лесенка: лава под ступенью/рядом — туда не копать
      const stairs = V.family('descend').variants.get('stairs');
      const lavaE = (x, y, z) => (x === 1 && y === 64 && z === 0 ? 'lava' : flat(x, y));
      const fb = fakeBot(lavaE).bot, cur = new Vec3(0, 66, 0);
      assert(/lava/.test(stairs.stepBad(fb, cur, 1, 0)), 'лава у ступени');
      assert.strictEqual(stairs.stepBad(fb, cur, 0, 1), null, 'с другой стороны — можно');
      assert(/пустота/.test(stairs.stepBad(fakeBot((x, y) => (x === -1 ? 'air' : flat(x, y))).bot, cur, -1, 0)), 'обрыв под ступенью');
    }
    // ---- home ----
    {
      const { baseTravel } = require('../lib/basegoal');
      const { bot, ctx } = fakeBot(); bot.entity.position = new Vec3(0, 64, 120);
      const log = []; A.goto = fakeGoto(bot, log);
      let r = await baseTravel(ctx, task(), { x: 0, y: 64, z: 0, r: 8, timeout: 60, style: 'direct' });
      assert(r.arrived && r.variant === 'direct' && log.length === 1 && log[0] === 'GoalNear', 'direct — один путь: ' + JSON.stringify({ r, log }));
      bot.entity.position = new Vec3(0, 64, 120); log.length = 0;
      r = await baseTravel(ctx, task(), { x: 0, y: 64, z: 0, r: 8, timeout: 60, style: 'short_hops' });
      assert(r.variant === 'short_hops' && log.length >= 5, 'короткие скачки: ' + log.length);
      assert(!ap('home', 'direct', { trip: 400 }), 'далеко — direct неприменим');
      assert(/direct 1\/1/.test(r.variants) && /hops —/.test(r.variants), 'счёт всех вариантов в итоге: ' + r.variants);
    }
    // ---- dig (подход к блоку) ----
    {
      const D = require('../lib/variants/dig/_core');
      const { bot, ctx } = fakeBot((x, y, z) => (x === 5 && y === 66 && z === 0 ? 'oak_log' : flat(x, y)));
      const log = []; A.goto = fakeGoto(bot, log);
      const r = await D.approach(ctx, task(), new Vec3(5, 66, 0));
      assert(r.reached && r.variant === 'look' && log[0] === 'GoalLookAtBlock', JSON.stringify(r));
      const n = await D.approach(ctx, task(), new Vec3(5, 66, 0), { style: 'near' });
      assert(n.variant === 'near' && log[1] === 'GoalNear');
      assert.strictEqual(D.kindOf('oak_log'), 'log'); assert.strictEqual(D.kindOf('iron_ore'), 'ore');
      const st = V.stats(ctx, 'dig').stats.dig;
      assert(st.log.look.ok === 1 && st.log.near.ok === 1, 'подход записан по виду блока: ' + JSON.stringify(st));
    }
    // ---- dig safe variant ----
    {
      const D = require('../lib/variants/dig/_core');
      // 1. цель под ногами — отказ
      {
        const { bot, ctx } = fakeBot((x, y, z) => (x === 0 && y === 66 && z === 0 ? 'stone' : flat(x, y)));
        bot.entity.position = new Vec3(0.5, 66, 0.5);
        const ownBlocks = new Map();
        ownBlocks.set('0,66,0', { name: 'stone', t: Date.now(), by: 'autopilot' });
        const dangerState = { mobs: { mobs: [] } };
        try {
          await D.approach(ctx, task(), new Vec3(0, 66, 0), { style: 'safe', ownBlocks, danger: dangerState });
          throw new Error('should have thrown');
        } catch (e) {
          assert(/цель под ногами/.test(e.message), 'safe отказывает под ногами: ' + e.message);
        }
      }
      // 2. цель — свой блок — отказ
      {
        const { bot, ctx } = fakeBot((x, y, z) => (x === 2 && y === 66 && z === 0 ? 'stone' : flat(x, y)));
        bot.entity.position = new Vec3(0.5, 66, 0.5);
        const ownBlocks = new Map();
        ownBlocks.set('2,66,0', { name: 'stone', t: Date.now(), by: 'autopilot' });
        const dangerState = { mobs: { mobs: [] } };
        try {
          await D.approach(ctx, task(), new Vec3(2, 66, 0), { style: 'safe', ownBlocks, danger: dangerState });
          throw new Error('should have thrown');
        } catch (e) {
          assert(/свой блок/.test(e.message), 'safe отказывает свой блок: ' + e.message);
        }
      }
      // 3. перепад под целью — отказ
      {
        const gen = (x, y, z) => (x === 5 && y === 66 && z === 0 ? 'stone' : (y < 63 ? 'stone' : 'air'));
        const { bot, ctx } = fakeBot(gen);
        bot.entity.position = new Vec3(0.5, 66, 0.5);
        const ownBlocks = new Map();
        const dangerState = { mobs: { mobs: [] } };
        try {
          await D.approach(ctx, task(), new Vec3(5, 66, 0), { style: 'safe', ownBlocks, danger: dangerState });
          throw new Error('should have thrown');
        } catch (e) {
          assert(/пропасть/.test(e.message), 'safe отказывает пропасть: ' + e.message);
        }
      }
      // 4. моб очень близко — отказ
      {
        const { bot, ctx } = fakeBot((x, y, z) => (x === 5 && y === 66 && z === 0 ? 'stone' : flat(x, y)));
        bot.entity.position = new Vec3(0.5, 66, 0.5);
        const ownBlocks = new Map();
        const dangerState = { mobs: { mobs: [{ name: 'creeper', d: 2 }] } };
        try {
          await D.approach(ctx, task(), new Vec3(5, 66, 0), { style: 'safe', ownBlocks, danger: dangerState });
          throw new Error('should have thrown');
        } catch (e) {
          assert(/моб.*рядом: safe отказывает/.test(e.message), 'safe отказывает моб рядом: ' + e.message);
        }
      }
      // 5. успешно: цель рядом, безопасная позиция найдена
      {
        const { bot, ctx } = fakeBot((x, y, z) => (x === 5 && y === 66 && z === 0 ? 'stone' : flat(x, y)));
        bot.entity.position = new Vec3(0.5, 66, 0.5);
        const ownBlocks = new Map();
        const dangerState = { mobs: { mobs: [] } };
        const log = []; A.goto = fakeGoto(bot, log);
        const r = await D.approach(ctx, task(), new Vec3(5, 66, 0), { style: 'safe', ownBlocks, danger: dangerState });
        assert(r.reached && r.variant === 'safe', 'safe успешно подошёл: ' + JSON.stringify(r));
        const st = V.stats(ctx, 'dig').stats.dig;
        assert(st.stone.safe.ok === 1, 'safe записан в статистику: ' + JSON.stringify(st));
      }
    }
    // ---- place ----
    {
      assert(ap('place', 'pillar', { dy: 6, blocks: 8 }) && !ap('place', 'pillar', { dy: 2, blocks: 8 }) && !ap('place', 'pillar', { dy: 6, blocks: 1 }), 'столб — только к высокой точке и с блоками');
      const build = require('../lib/skills/build');
      const { bot, ctx } = fakeBot(flat, { inv: [{ name: 'dirt', count: 4 }] });
      const oldPlace = A.placeBlockAt; const placed = [];
      A.placeBlockAt = async (b, pos, item) => { placed.push([pos.x, pos.y, pos.z, item]); };
      const log = []; A.goto = fakeGoto(bot, log);
      try {
        const r = await build.placeAt(ctx, task(), { x: 8, y: 66, z: 0, item: 'dirt' });
        assert(r.variant === 'near' && placed.length === 1, JSON.stringify(r));
        const st = V.stats(ctx, 'place').stats.place;
        assert(st['*'].near.ok === 1, 'установка записана: ' + JSON.stringify(st));
        A.placeBlockAt = async () => { throw new Error('не к чему прислонить'); };
        await assert.rejects(build.placeAt(ctx, task(), { x: 9, y: 66, z: 0, item: 'dirt', style: 'close' }), /прислонить/);
        assert(V.stats(ctx, 'place').stats.place['*'].close.n === 1 && V.stats(ctx, 'place').stats.place['*'].close.ok === 0, 'провал записан');
      } finally { A.placeBlockAt = oldPlace; }
    }
    // ---- выбор через поведение ----
    {
      const { bot, ctx } = fakeBot(); bot.entity.position = new Vec3(0, 64, 30);
      const asked = []; ctx.behaviorHost = { call(name, args, fb) { asked.push(name); return require('../behavior/combat')[name](...args); } };
      A.goto = fakeGoto(bot, []);
      const r = await require('../lib/basegoal').baseTravel(ctx, task(), { x: 0, y: 64, z: 0, r: 8, timeout: 60 });
      assert(r.arrived && asked.includes('chooseVariant'), 'выбор варианта спрошен у поведения: ' + asked);
    }
  } finally { A.goto = oldGoto; V.setRegistry(null); }
  console.log('variants actions: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
