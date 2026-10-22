// Разбор POST /cmd: новые навыки (в фоне) + старые простые команды (совместимость с Hermes).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3, sleep, num, entName, isAutoTarget, isHostile, r1 } = require('./util');
const A = require('./actions');
const vision = require('./vision');
const gather = require('./skills/gather');
const crafting = require('./skills/craft');
const combat = require('./skills/combat');
const survival = require('./skills/survival');
const build = require('./skills/build');
const blueprint = require('./skills/blueprint');
const basic = require('./skills/basic');
const farm = require('./skills/farm');
const { recover } = require('./skills/recover');
const water = require('./skills/water'); // руки для воды: swim_to, dive
const move = require('./skills/move');   // подъём/спуск: climb, descend
const perception = require('./perception');
const snapshot = ctx => require('./experience').decorate(ctx, perception.snapshot(ctx)); // + строка «опыт»
const { survey } = require('./survey');
const worldmem = require('./worldmem'); // постоянная память мира (goto_known, where)

const norm = s => String(s || '').toLowerCase().replace(/[\s_\-]/g, '');

// Крупные навыки: имя -> функция(ctx, task, params)
const SKILLS = {
  collect: gather.collect,
  find: gather.find,
  explore: gather.explore,
  craft: crafting.craft,
  smelt: crafting.smelt,
  equip_best: combat.equipBest,
  fight: combat.fight,
  defend: combat.defend,
  escape: combat.escape,
  hunt: combat.hunt,
  shelter: survival.shelter,
  sleep: survival.sleep,
  wait_night: survival.waitNight,
  place_at: build.placeAt,
  dig_at: build.digAt,
  build_blueprint: blueprint.buildBlueprint, // постройка по чертежу brain/blueprints/<имя>.txt (dry=1 — только смета)
  blueprint_list: blueprint.blueprintListSkill,
  blueprint_check: blueprint.blueprintCheckSkill,
  chest_store: build.chestStore,
  chest_take: build.chestTake,
  recover,
  swim_to: water.swimTo, // плыть к точке (под водой тоже; sprint=1 — быстро); не всплывает сама
  dive: water.dive,       // нырнуть вниз (depth / y)
  goto_known: worldmem.gotoKnown, // идти к ближайшему известному месту (руда, лес, вода, сундук...) из data/world.json
  // универсальные базовые умения (lib/skills/basic.js, farm.js); 'equip' занято старой простой командой — поэтому equip_item
  eat: basic.eat,
  equip_item: basic.equip,
  toss: basic.toss,
  drop_junk: basic.dropJunk,
  look_at: basic.lookAt,
  use_item: basic.useItem,
  activate: basic.activate,
  pillar_up: basic.pillarUp,
  climb: move.climb,     // подняться на height блоков / до y (варианты lib/variants/climb: path, pillar; style=auto|<имя>)
  descend: move.descend, // спуститься на depth блоков / до y (варианты lib/variants/descend: path, stairs; style=auto|<имя>)
  bridge: basic.bridge,
  pickup: basic.pickup,
  light: basic.light,
  mark: basic.mark,
  go_home: basic.goHome,
  waypoints: basic.waypoints,
  shoot: basic.shoot,
  shield: basic.shield,
  fish: basic.fish,
  bucket: basic.bucket,
  till: farm.till,
  plant: farm.plant,
  harvest: farm.harvest,
  breed: farm.breed,
  shear: farm.shear,
  villagers: farm.villagers,
  trade: farm.trade,
  follow: async (ctx, t, p) => {
    const bot = ctx.bot;
    const others = Object.values(bot.players).filter(pl => pl.username !== bot.username && pl.entity);
    const pl = p.name ? others.find(o => o.username.toLowerCase() === String(p.name).toLowerCase()) : others.sort((a, b) => a.entity.position.distanceTo(bot.entity.position) - b.entity.position.distanceTo(bot.entity.position))[0];
    if (!pl) throw new Error('игрок не найден рядом');
    t.progress('следую за ' + pl.username);
    bot.pathfinder.setGoal(new goals.GoalFollow(pl.entity, num(p.range, 2, 1, 10)), true);
    await t.waitAbort();
    return { followed: pl.username };
  }
};
const SKILL_NAMES = Object.keys(SKILLS);
const SKILL_BY_NORM = Object.fromEntries(Object.keys(SKILLS).map(k => [norm(k), k]));
// старые "навыки" -> новые
const LEGACY_SKILL = {
  gatherwood: ['collect', p => ({ block: 'log', count: num(p.count, 4, 1, 64) }), true],
  mineore: ['collect', p => ({ block: p.type || p.ore || 'iron_ore', count: num(p.count, 1, 1, 64) }), true],
  buildshelter: ['shelter', p => p, true],
  survivenight: ['wait_night', p => p, false],
  stopfollow: null
};

function makeDispatcher(ctx) {
  const runSkill = (name, params, opts = {}) => {
    const fn = SKILLS[name];
    return ctx.tasks.start(name, params, t => fn(ctx, t, params), opts);
  };
  ctx.runSkill = runSkill; ctx.skillNames = SKILL_NAMES;

  // internal — запрос исполнителя/навыка (без User-Agent): ему нужен честный итог, без потолка wait и без автоочереди
  // by — кто отдал действие подробно (brain, autopilot, reflex, skill:<имя>, owner); попадает в события задач и в чёрный ящик
  async function dispatch(cmd, { inSequence = false, source = 'brain', internal = false, by = null } = {}) {
    by = by || source;
    if (!ctx.ready || !ctx.bot || !ctx.bot.entity) return { ok: false, error: 'not ready: ' + (ctx.lastError || 'connecting'), ...(ctx.link ? { link: ctx.link.info() } : {}) };
    const raw = cmd.action || cmd.cmd || '';
    const a = norm(raw);
    const p = cmd.params || cmd.args || {};
    const wait = inSequence || cmd.wait === true || p.wait === true;
    const force = cmd.force === true || p.force === true;
    const queue = !inSequence && !!(cmd.queue || p.queue);
    const bot = ctx.bot;
    try {
      if (a === 'stop') {
        const had = ctx.tasks.current ? ctx.tasks.current.name : null;
        await ctx.tasks.stop('stop');
        return { ok: true, stopped: had, snapshot: snapshot(ctx) };
      }
      if (blueprint.isReadOnly(a, p)) return await blueprint.runReadOnly(ctx, a, p); // список/сверка/dry — только чтение, тело не занимают
      if (SKILL_BY_NORM[a] && a !== 'craft') {
        const r = await runSkill(SKILL_BY_NORM[a], p, { wait, force, queue, source, by, noQueue: inSequence || internal });
        return wait ? { ...r, summary: snapshot(ctx).summary } : r;
      }
      if (a === 'craft') { // craft всегда был синхронным — по умолчанию ждём, wait:false — в фоне
        const r = await runSkill('craft', p, { wait: !queue && cmd.wait !== false && p.wait !== false, force, queue, source, by, noQueue: inSequence || internal });
        return r;
      }
      if (LEGACY_SKILL[a]) {
        const [name, conv, w] = LEGACY_SKILL[a];
        const r = await runSkill(name, conv(p), { wait: w || wait, force, source, by, noQueue: inSequence || internal });
        return { ...r, snapshot: snapshot(ctx) };
      }
      if (a === 'stopfollow') {
        if (ctx.tasks.current && ctx.tasks.current.name === 'follow') await ctx.tasks.stop('stopFollow');
        try { bot.pathfinder.setGoal(null); } catch (e) {}
        return { ok: true, snapshot: snapshot(ctx) };
      }
      if (a === 'task') return { ok: true, task: ctx.tasks.info(), history: ctx.tasks.history.slice(-5) };
      return await legacy(a, p, raw, inSequence, source, by, internal);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), snapshot: snapshot(ctx) };
    }
  }

  // Простая команда, двигающая тело: через блокировку, с ручным управлением (рефлекс плавания не мешает)
  const body = (fn, source, by, name) => ctx.tasks.body(async () => {
    ctx.manualControl = true;
    try { return await fn(); } finally { ctx.manualControl = false; }
  }, { source, by, name });

  async function legacy(a, p, raw, inSequence, source, by, internal = false) {
    const bot = ctx.bot;
    const B = fn => body(fn, source, by, a); // старые команды тела: мозг вытесняет автопилот
    const snap = () => snapshot(ctx);
    switch (a) {
      case 'sequence': case 'macro': {
        const steps = Array.isArray(p.steps) ? p.steps.slice(0, 50) : [];
        const results = [];
        for (const s of steps) {
          // шаг пачки — внутренний запрос: честный итог, без потолка wait и без автоочереди (как у исполнителя)
          const r = await dispatch({ action: s.action || s.cmd, params: s.params || s.args || {} }, { inSequence: true, source, internal: true, by });
          results.push({ action: s.action || s.cmd, ok: r.ok, error: r.error });
          if (!r.ok) break;
        }
        return { ok: results.every(r => r.ok), results, snapshot: snap() };
      }
      case 'survey': return survey(ctx, p); // только чтение, не занимает тело и очередь навыков
      case 'where': return worldmem.where(ctx, p); // где лежит предмет (сундуки, дроп со смерти) — только чтение
      case 'snapshot': case 'status': return { ok: true, snapshot: snap() };
      case 'chat': {
        const text = String(p.text || '').slice(0, 250);
        // команды сервера (/setblock, /give, /tp…) — это читы: мозгу запрещены
        if (text.trimStart().startsWith('/')) return { ok: false, error: 'команды со / запрещены: играй без читов' };
        bot.chat(text); ctx.events.push('info', { msg: 'мозг сказал в чат', say: text }); // для программы «Аудит»: своих реплик бот в чате не слышит
        await sleep(200); return { ok: true, snapshot: snap() };
      }
      case 'move': return B(async () => {
        const dir = p.dir || p.direction || 'forward';
        const ms = num(p.ms ?? p.duration, 500, 50, 5000);
        const ctl = { forward: 'forward', back: 'back', left: 'left', right: 'right', up: 'jump' }[dir];
        if (!ctl) return { ok: false, error: 'dir: forward|back|left|right|up' };
        bot.setControlState(ctl, true);
        await sleep(ms);
        bot.clearControlStates();
        return { ok: true, snapshot: snap() };
      });
      case 'jump': return B(async () => { bot.setControlState('jump', true); await sleep(150); bot.clearControlStates(); return { ok: true, snapshot: snap() }; });
      case 'look': return B(async () => {
        let yaw = bot.entity.yaw, pitch = bot.entity.pitch;
        yaw = num(p.yaw, yaw); pitch = num(p.pitch, pitch);
        yaw += num(p.dyaw, 0); pitch += num(p.dpitch, 0);
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
        await bot.look(yaw, pitch, true);
        return { ok: true, snapshot: snap() };
      });
      case 'sneak': bot.setControlState('sneak', !!p.on); return { ok: true, snapshot: snap() };
      case 'sprint': bot.setControlState('sprint', !!p.on); return { ok: true, snapshot: snap() };
      case 'equip': return B(async () => {
        let item = null;
        if (p.slot != null) item = bot.inventory.slots[num(p.slot, -1)];
        else if (p.name) item = A.findItem(bot, String(p.name));
        else return { ok: false, error: 'need slot or name' };
        if (!item) return { ok: false, error: 'нет предмета ' + (p.name || 'в слоте ' + p.slot) };
        await bot.equip(item, p.dest || 'hand');
        return { ok: true, snapshot: snap() };
      });
      case 'place': return B(async () => {
        let target = null; let face = new Vec3(0, 1, 0);
        try { const c = bot.blockAtCursor(5); if (c && c.name !== 'air') { target = c; if (c.face != null) face = faceVec(c.face); } } catch (e) {}
        if (!target) { const below = bot.blockAt(bot.entity.position.offset(0, -1, 0)); if (below && below.name !== 'air') { target = below; face = new Vec3(1, 0, 0); } }
        if (!target) return { ok: false, error: 'no target block in range' };
        if (p.name || p.item) { const it = A.findItem(bot, String(p.name || p.item)); if (!it) return { ok: false, error: 'нет ' + (p.name || p.item) }; await bot.equip(it, 'hand'); }
        if (!bot.heldItem) return { ok: false, error: 'в руке пусто' };
        try { await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
        const dest = target.position.plus(face); ctx.buildingAt = `${dest.x},${dest.y},${dest.z}`; // итог дня: «построено»
        try { await bot.placeBlock(target, face); } finally { ctx.buildingAt = null; }
        ctx.stats.blocksPlaced++; ctx.statsDirty = true;
        return { ok: true, snapshot: snap() };
      });
      case 'dig': return B(async () => {
        let target = null;
        try { target = bot.blockAtCursor(5); } catch (e) {}
        if (!target || target.name === 'air') return { ok: false, error: 'no block to dig' };
        await A.equipToolFor(bot, target);
        await bot.dig(target);
        ctx.stats.blocksMined++; ctx.statsDirty = true;
        await sleep(100);
        return { ok: true, dug: target.name, snapshot: snap() };
      });
      case 'use': bot.activateItem(); await sleep(200); return { ok: true, snapshot: snap() };
      case 'wait': await sleep(num(p.ms, 500, 0, 5000)); return { ok: true, snapshot: snap() };
      case 'goto': case 'go': return B(async () => {
        const x = Number(p.x), y = Number(p.y), z = Number(p.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, error: 'need x,z (y optional)' };
        const goal = Number.isFinite(y) ? new goals.GoalNear(x, y, z, 1) : new goals.GoalNearXZ(x, z, 1);
        let timer;
        try {
          await Promise.race([bot.pathfinder.goto(goal), new Promise((_, rej) => { timer = setTimeout(() => { bot.pathfinder.setGoal(null); rej(new Error('timeout')); }, num(p.timeout, 60, 5, 300) * 1000); })]);
        } finally { clearTimeout(timer); }
        return { ok: true, snapshot: snap() };
      });
      case 'buildplatform': case 'platform': return B(async () => {
        const size = num(p.size ?? p.n, 3, 1, 7);
        const s = bot.entity.position.floored(); const y = s.y - 1;
        let placed = 0;
        for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) {
          const pos = new Vec3(s.x + dx, y, s.z + dz);
          const ex = bot.blockAt(pos);
          if (ex && !A.isAirLike(ex)) { if (ex.name === 'cobblestone') placed++; continue; }
          const it = A.findItem(bot, 'cobblestone') || A.findItem(bot, i => A.isBuildBlock(i.name));
          if (!it) break;
          ctx.buildingAt = `${pos.x},${pos.y},${pos.z}`; // итог дня: «построено»
          try { await A.placeBlockAt(bot, pos, it.name); placed++; ctx.stats.blocksPlaced++; } catch (e) {} finally { ctx.buildingAt = null; }
          await sleep(80);
        }
        ctx.statsDirty = true;
        return { ok: true, placed, snapshot: snap() };
      });
      case 'mine': case 'dignearest': return B(async () => {
        const type = p.type || p.block || 'stone';
        const id = bot.registry.blocksByName[type]?.id;
        const best = id == null ? null : vision.nearest(ctx, id, 8); // только видимое/запомненное
        if (!best) return { ok: false, error: 'не вижу ' + type + ' рядом' };
        await A.equipToolFor(bot, best);
        await bot.dig(best);
        ctx.stats.blocksMined++; ctx.statsDirty = true;
        await sleep(100);
        return { ok: true, dug: best.name, position: { x: best.position.x, y: best.position.y, z: best.position.z }, snapshot: snap() };
      });
      case 'swim': return B(async () => {
        bot.setControlState('jump', true);
        await bot.look(bot.entity.yaw, -1.2, true).catch(() => {});
        await sleep(num(p.ms, 1000, 50, 5000));
        bot.clearControlStates();
        return { ok: true, snapshot: snap() };
      });
      case 'flee': return B(async () => {
        const fx = bot.entity.position.x + (num(p.dx, 0) || (Math.random() - 0.5) * 10);
        const fz = bot.entity.position.z + (num(p.dz, 0) || (Math.random() - 0.5) * 10);
        bot.pathfinder.setMovements(ctx.sprintMovements);
        bot.pathfinder.setGoal(new goals.GoalNearXZ(fx, fz, 2));
        setTimeout(() => { try { bot.pathfinder.setMovements(ctx.movements); } catch (e) {} }, 8000);
        return { ok: true, snapshot: snap() };
      });
      case 'attack': return B(async () => {
        const name = p.name ? String(p.name).toLowerCase() : null;
        if (name && Object.values(bot.players).some(pl => pl.username.toLowerCase() === name)) return { ok: false, error: 'игроков не атакую' };
        let best = null, bd = 6;
        for (const e of Object.values(bot.entities)) {
          if (!e || e === bot.entity || e.type === 'player') continue;
          if (name ? !(entName(e) === name && isHostile(e)) : !isAutoTarget(e)) continue;
          const d = bot.entity.position.distanceTo(e.position);
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) return { ok: false, error: 'no target in range' };
        await A.equipBestWeapon(bot);
        await bot.lookAt(best.position.offset(0, best.height * 0.8, 0), true);
        bot.attack(best);
        ctx.combatUntil = Date.now() + 3000;
        return { ok: true, attacked: entName(best), snapshot: snap() };
      });
      case 'scan': {
        const entities = [];
        for (const e of Object.values(bot.entities)) {
          if (!e || e === bot.entity) continue;
          const d = bot.entity.position.distanceTo(e.position);
          if (d < 32) entities.push({ type: e.type, name: entName(e), distance: r1(d), position: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } });
        }
        const VB = ['bell', 'composter', 'lectern', 'brewing_stand', 'cauldron', 'fletching_table', 'cartography_table', 'smithing_table', 'stonecutter', 'loom', 'hay_block'];
        const ids = VB.map(n => bot.registry.blocksByName[n]?.id).filter(x => x != null);
        const found = vision.find(ctx, ids, { radius: 32, count: 200 }); // только видимое/запомненное
        const names = [...new Set(found.map(pos => bot.blockAt(pos)?.name).filter(Boolean))];
        return { ok: true, entities: entities.sort((x, y) => x.distance - y.distance).slice(0, 30), villageBlocks: names, villageBlockCount: found.length, snapshot: snap() };
      }
      case 'recipes': {
        const item = bot.registry.itemsByName[p.item || p.name];
        if (!item) return { ok: false, error: 'unknown item: ' + (p.item || p.name) };
        const all = bot.recipesAll(item.id, null, true);
        const canNow = bot.recipesFor(item.id, null, 1, true);
        return { ok: true, item: item.name, recipeCount: all.length, craftableNow: canNow.length > 0, snapshot: snap() };
      }
      default:
        return { ok: false, error: 'unknown action: ' + raw, skills: Object.keys(SKILLS) };
    }
  }

  return dispatch;
}

function faceVec(face) {
  // 0 низ,1 верх,2 север(-z),3 юг(+z),4 запад(-x),5 восток(+x)
  return [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)][face] || new Vec3(0, 1, 0);
}

module.exports = { makeDispatcher, SKILLS };
