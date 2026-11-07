// Офлайн-проверка рефлексов этапа 2 (hardcore/reflexes.js): срабатывание, выбор ответа и порога по очкам, правила автопилота — дела списка.
'use strict';
const assert = require('assert');
const RX = require('../hardcore/reflexes');
const D = require('../hardcore/decider');
const AP = require('../behavior/autopilot');

const f0 = { hp: 20, food: 20, isNight: false, pos: { x: 0, y: 64, z: 0 }, hostilesNear: 0, nearest: null, creeper: null, ranged: null, flyNear: false,
  blocks: 0, hasFood: false, hasWeapon: false, pickaxe: 0, inWater: false, inLava: false, onFire: false, suffocating: false, sheltered: false,
  underground: false, hitRecent: false, water: null, biome: 'plains' };
const th = id => RX.THRESHOLDS[id][0];
const zombie = { id: 7, name: 'zombie', d: 3 };

// 1) срабатывание: спокойно — ничего; по срочности — лава раньше мало здоровья, мало здоровья раньше моба
assert.strictEqual(RX.firstTrigger(f0, th), null);
assert.strictEqual(RX.firstTrigger({ ...f0, hp: 5, inLava: true, nearest: zombie }, th).R.id, 'lava');
assert.strictEqual(RX.firstTrigger({ ...f0, hp: 5, nearest: zombie }, th).R.id, 'low_hp');
assert.strictEqual(RX.firstTrigger({ ...f0, nearest: zombie }, th).R.id, 'mob_close');
assert.strictEqual(RX.firstTrigger({ ...f0, nearest: { ...zombie, d: 9 } }, th), null, 'моб дальше порога 6 — не рефлекс');
assert.strictEqual(RX.firstTrigger({ ...f0, nearest: { ...zombie, d: 9 } }, () => 10).R.id, 'mob_close', 'порог 10 — уже рефлекс');
assert.strictEqual(RX.firstTrigger({ ...f0, creeper: { id: 3, name: 'creeper', d: 7 }, nearest: { id: 3, name: 'creeper', d: 7 } }, th).R.id, 'creeper');
assert.strictEqual(RX.firstTrigger({ ...f0, ranged: { id: 4, name: 'skeleton', d: 12 } }, th), null, 'скелет не стреляет по мухе — не рефлекс');
assert.strictEqual(RX.firstTrigger({ ...f0, ranged: { id: 4, name: 'skeleton', d: 12 }, hitRecent: true }, th).R.id, 'ranged');
assert.strictEqual(RX.firstTrigger({ ...f0, hp: 5 }, th, R => R.id === 'low_hp'), null, 'рефлекс на паузе пропускается');
console.log('срабатывание по срочности: OK');

// 2) ответ: без опыта и без проб — прежнее правило первым; «нечем» отсекает (столб без блоков, бой без цели)
const noRnd = { rate: 0, rnd: () => 0.99 };
{
  const ch = RX.pickVariant(RX.BY_ID.low_hp, { ...f0, hp: 5 }, { mob: null }, {}, noRnd);
  assert.strictEqual(ch.key, 'rx:low_hp:escape_sprint_away');
  const R = RX.BY_ID.low_hp;
  const can = R.variants.filter(v => !v.can || v.can({ ...f0, hp: 5 }, { mob: null })).map(v => v.id);
  assert(!can.includes('pillar') && !can.includes('fight') && !can.includes('eat') && !can.includes('walls'), can.join(','));
  const can2 = R.variants.filter(v => !v.can || v.can({ ...f0, hp: 5, blocks: 10, hasFood: true, food: 10 }, { mob: zombie })).map(v => v.id);
  for (const k of ['pillar', 'fight', 'eat', 'walls']) assert(can2.includes(k), k);
}
// опыт перебивает подсказку: в таблице «драться» при мало здоровья дало много очков, «бежать» — мало
{
  const st = { 'rx:low_hp:escape_sprint_away': { n: 10, sum: -20 }, 'rx:low_hp:fight': { n: 10, sum: 80 } };
  const ch = RX.pickVariant(RX.BY_ID.low_hp, { ...f0, hp: 5 }, { mob: zombie }, st, noRnd);
  assert.strictEqual(ch.key, 'rx:low_hp:fight');
}
// пробы: с долей проб 1 новичок берётся первым
{
  const st = { 'rx:hit_mob:escape_sprint_away': { n: 50, sum: 100 } };
  const ch = RX.pickVariant(RX.BY_ID.hit_mob, f0, { mob: zombie }, st, { rate: 1, rnd: () => 0 });
  assert.strictEqual(RX.pickVariant(RX.BY_ID.hit_mob, f0, { mob: zombie }, {}, noRnd).key, 'rx:hit_mob:escape_sprint_away', 'без оружия — бежать первым');
  assert.strictEqual(RX.pickVariant(RX.BY_ID.hit_mob, { ...f0, hasWeapon: true }, { mob: zombie }, {}, noRnd).key, 'rx:hit_mob:fight', 'с мечом — драться первым');
  assert(ch.explore && ch.key !== 'rx:hit_mob:escape_sprint_away', ch.key);
}
// ответы делают то, что названо
{
  const R = RX.BY_ID.hit_mob;
  const v = id => R.variants.find(x => x.id === id);
  assert.deepStrictEqual(v('fight').do(f0, { mob: zombie }), { skill: 'fight', params: { targetId: 7, radius: 12 } });
  assert.deepStrictEqual(v('swat').do(f0, { mob: zombie }), { inline: 'swat' });
  assert.strictEqual(v('keep_going').do(f0, {}), null);
  assert.strictEqual(v('escape_zigzag').do(f0, {}).params.style, 'zigzag');
  const fly = RX.BY_ID.hit_fly.variants.find(x => x.id === 'fight').do(f0, { player: 'Uch_Mila' });
  assert.strictEqual(fly.params.target, 'uch_mila');
}
console.log('ответ по очкам, подсказка, пробы: OK');

// 3) порог на жизнь: без опыта — прежнее значение; опыт с другим порогом — другой
{
  assert.strictEqual(RX.pickThreshold('low_hp', { exact: {}, coarse: {} }, { rnd: () => 0.99 }).value, 10);
  process.env.HC_EXPLORE = '0';
  const mem = { exact: { life: { 'rxth:low_hp:10': { n: 8, sum: -16 }, 'rxth:low_hp:14': { n: 8, sum: 40 } } }, coarse: {} };
  assert.strictEqual(RX.pickThreshold('low_hp', mem).value, 14);
  delete process.env.HC_EXPLORE;
}
console.log('порог на жизнь по очкам: OK');

// 4) правила автопилота — дела общего списка: мало HP ночью (правило раньше списка) больше не одно и не прерывает
process.env.HC_STAGE2 = '1';
{
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  const st = { ...base, hp: 5, inLava: true };
  const out = {};
  const first = AP.decide(st, out);
  assert(first && !out.cands, 'правило сработало раньше списка: ' + (first && first.key));
  const act = RX.collectRules(AP.decide, st, first, out);
  assert(out.cands.length >= 2, 'правил в списке: ' + out.cands.length);
  assert.strictEqual(act.key, first.key);
  assert(out.cands.every(c => !c.act.preempt), 'ни одно правило не прерывает идущее дело');
  assert(out.cands[0].score > out.cands[1].score, 'подсказка — прежний порядок');
  const keys = out.cands.map(c => c.act.key);
  assert.strictEqual(new Set(keys.filter((k, i) => out.cands[i].act.rule)).size, keys.filter((k, i) => out.cands[i].act.rule).length, 'правило в списке один раз');
  // выбор решателем: по очкам может взять и не первое правило
  const opts = out.cands.map(c => ({ key: c.act.key, prior: c.score / 100, act: c.act }));
  const stats = { [keys[1]]: { n: 20, sum: 200 } };
  assert.strictEqual(D.pickOption(opts, stats, { rate: 0 }).key, keys[1]);
  // список уже есть (обычные дела) — ничего не трогаем
  const out2 = { cands: [{ score: 10, act: { key: 'x' } }] };
  assert.strictEqual(RX.collectRules(AP.decide, base, { key: 'x' }, out2).key, 'x');
  assert.strictEqual(out2.cands.length, 1);
  console.log(`правила автопилота в общем списке (${keys.join(', ')}): OK`);
}
delete process.env.HC_STAGE2;

// 5) поесть — дело списка, не рефлекс
assert.deepStrictEqual(RX.skillCands({ hasFood: true, food: 20, hp: 20 }), []);
assert.deepStrictEqual(RX.skillCands({ hasFood: false, food: 5, hp: 20 }), []);
{
  const c = RX.skillCands({ hasFood: true, food: 12, hp: 20 });
  assert.deepStrictEqual(c.map(x => x.act.key), ['eat_best', 'eat_any']);
  assert(c[0].score > c[1].score && !c[0].act.preempt);
}
console.log('поесть — дело общего списка: OK');

// 6) тону: ответы — флаги начала спасения
assert.deepStrictEqual(RX.BY_ID.drown.variants.map(v => v.id), ['swim_air', 'dig_up', 'place_under']);
assert.deepStrictEqual(RX.BY_ID.drown.variants[2].start, { skipSwim: true, stuck: true });
console.log('тону: варианты: OK');

// 7) обстановка из ощущений — тот же ключ, что у дел
{
  const s = RX.sitOfFeel({ ...f0, hp: 5, isNight: true, pickaxe: 2, hostilesNear: 2 });
  assert.strictEqual(s.key, 'night|open|low|stone|mob|plain');
}
console.log('все проверки рефлексов: OK');

// 8) живая часть на поддельном теле: опрос видит зомби вплотную, выбирает ответ, пишет дело и запускает навык поверх дела
(async () => {
  const { Vec3 } = require('vec3');
  RX._reset(); D._reset();
  const air = { name: 'air', boundingBox: 'empty' };
  const me = { position: new Vec3(0.5, 64, 0.5), metadata: [] };
  const z = { id: 9, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0.5), height: 1.95 };
  const bot = { entity: me, health: 20, food: 20, entities: { 1: me, 9: z }, players: {}, time: { timeOfDay: 1000 },
    inventory: { items: () => [{ name: 'iron_sword', count: 1 }] }, registry: { foodsByName: {}, blocksByName: {} },
    blockAt: () => air, findBlock: () => null };
  const evs = [], runs = [];
  const ctx = { bot, ready: true, events: { push: (type, data) => evs.push({ type, data }) }, tasks: { current: { name: 'collect', source: 'autopilot' } },
    runSkill: async (name, params, opts) => { runs.push({ name, params, opts }); ctx.tasks.current = { name, source: 'reflex' }; return { ok: true }; } };
  let tick = null;
  RX.attach({ ctx, every: (ms, fn) => { tick = fn; } }, null);
  process.env.HC_EXPLORE = '0';
  await tick();
  assert.strictEqual(runs.length, 1, 'ответ запущен');
  assert.deepStrictEqual([runs[0].name, runs[0].params.targetId, runs[0].opts.force, runs[0].opts.source], ['fight', 9, true, 'reflex']);
  const ds = evs.filter(e => e.type === 'deed_start').map(e => e.data.key);
  assert(ds.includes('rx:mob_close:fight'), ds.join(','));
  assert(ds.includes('rxth:mob_close:6') && ds.includes('rxth:low_hp:10'), 'пороги выбраны раз за жизнь: ' + ds.join(','));
  // идёт ответ этого рефлекса — второй раз не дёргаем; удар моба (главнее) — дёргает
  await tick();
  assert.strictEqual(runs.length, 1, 'свой ответ идёт — не повторяем');
  await RX.onHit(ctx, 'mob', { att: z });
  assert.strictEqual(runs.length, 2, 'удар главнее «вплотную» — новый ответ');
  assert.strictEqual(runs[1].name, 'fight', 'удар моба с мечом: прежнее правило — драться');
  delete process.env.HC_EXPLORE;
  console.log('живая часть на поддельном теле: OK');
})().catch(e => { console.error(e); process.exit(1); });
