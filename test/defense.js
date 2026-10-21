// Офлайн-проверки защиты: кто реально ударил (невидимый/всадник), бегство от почувствованного обидчика,
// опыт выживания (выбор действия по статистике), предупреждения dig_at/recover ночью, проверка ямы shelter dig.
'use strict';
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const F = require('../lib/felt');
const E = require('../lib/experience');
const R = require('../behavior/reflexes');
const combat = require('../lib/skills/combat');
const survival = require('../lib/skills/survival');
const build = require('../lib/skills/build');
const { recover } = require('../lib/skills/recover');

const NIGHT = 18000, DAY = 6000;
// Фальшивый бот: мир по функции gen(x,y,z) -> имя блока (или null — чанк не загружен)
function fake({ gen, pos = new Vec3(0.5, 66, 0.5), tod = NIGHT, inv = [], armor = false } = {}) {
  const solid = n => !['air', 'snow', 'short_grass', 'water', 'lava', 'powder_snow'].includes(n);
  const set = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  const bot = {
    username: 'FlyTest', health: 20, food: 20, registry: require('minecraft-data')('26.1'),
    entity: { id: 1, position: pos, velocity: new Vec3(0, 0, 0), height: 1.8 }, entities: {},
    time: { timeOfDay: tod, day: 3 },
    inventory: { items: () => inv.filter(i => i.count > 0), slots: armor ? { 6: { name: 'iron_chestplate' } } : {} },
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), k = key(x, y, z);
      const name = set.has(k) ? set.get(k) : gen(x, y, z);
      if (name == null) return null;
      return { name, boundingBox: solid(name) ? 'block' : 'empty', position: new Vec3(x, y, z), diggable: true, skyLight: 15 };
    },
    pathfinder: { setMovements() {}, setGoal() {}, goto: async g => { if (g.x != null) { bot.entity.position = new Vec3(g.x + 0.5, bot.entity.position.y, g.z + 0.5); } } },
    clearControlStates() {}, setControlState() {}, look: async () => {}, lookAt: async () => {}
  };
  bot.entities[1] = bot.entity;
  return { bot, set: (x, y, z, n) => set.set(key(x, y, z), n) };
}
const flat = (x, y) => (y <= 65 ? 'dirt' : 'air');
function mob(bot, id, name, x, z, extra = {}) { const e = { id, name, type: 'hostile', position: new Vec3(x, 66, z), height: 1.95, ...extra }; bot.entities[id] = e; return e; }
function mkCtx(bot) {
  const events = [], runs = [];
  return { bot, events: { push: (type, d) => events.push({ type, ...d }) }, tasks: { current: null }, stats: { blocksPlaced: 0, blocksMined: 0 },
    runSkill: (n, p, o) => runs.push({ n, p, o }), _events: events, _runs: runs, expFile: path.join(os.tmpdir(), 'flytest-exp-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json'), expRand: () => 0.99 };
}

async function testAttacker() {
  const { bot } = fake({ gen: flat });
  // сервер назвал далёкого зомби (24.8 м), а рядом, невидимый в темноте, стоит другой — бил он
  const far = mob(bot, 186155, 'zombie', 25, 0), near = mob(bot, 7, 'zombie', 3.5, 0.5);
  let r = F.resolveAttacker(bot, far);
  assert.strictEqual(r.entity, near, 'ближний вместо далёкого');
  // всадник: своя позиция устарела, транспорт рядом — значит источник верный
  const horse = { id: 8, name: 'zombie_horse', type: 'animal', position: new Vec3(2.5, 66, 0.5) };
  bot.entities[8] = horse; delete bot.entities[7];
  const rider = mob(bot, 9, 'zombie', 40, 40, { vehicle: horse });
  r = F.resolveAttacker(bot, rider); assert(r.entity === rider && r.sure, 'всадник по позиции лошади');
  // escape: обидчик почувствован -> бежим от него (на -x), «врагов рядом нет» не бывает
  const ctx = mkCtx(bot); F.feel(ctx, rider);
  const v = combat.fleeVector(ctx); assert(v && v.x < 0, 'бежать от всадника');
  delete bot.entities[9]; delete bot.entities[8]; delete bot.entities[186155]; // все пропали из виду
  const A = require('../lib/actions'), goto0 = A.goto; // другие тесты подменяют A.goto — здесь свой
  A.goto = async (c, t, g) => { if (g.x != null) c.bot.entity.position = new Vec3(g.x, 66, g.z); return true; };
  let res; try { res = await combat.escape(ctx, new Task(1, 'escape', {}, 'test'), { shelter: false }); } finally { A.goto = goto0; }
  assert(res.fled && !res.note, 'после удара escape бежит: ' + JSON.stringify(res));
  assert(bot.entity.position.x < 0, 'убежал по направлению удара ' + bot.entity.position.x);
  // fight по чужому targetId: бьём того, кто реально ударил
  console.log('attacker: OK');
}

async function testExperience() {
  const { bot } = fake({ gen: flat });
  const ctx = mkCtx(bot); mob(bot, 5, 'zombie', 2.5, 0.5);
  bot.health = 6;
  const key = E.situation(ctx).key;
  assert(/^night\|outdoors\|none\|nowpn\|low\|zombie\|1$/.test(key), key);
  // prior (мало HP): escape первым, без опыта выбирается он
  assert.deepStrictEqual(R.defensePrior(ctx, bot.entities[5]), ['escape', 'shelter', 'fight']);
  let plan = R.mobHurtPlan(ctx, bot.entities[5]); assert.strictEqual(plan.skill, 'escape', 'без опыта — prior');
  // опыт: escape умирал 4 раза, shelter выживал 3 — теперь выбирается shelter
  for (let i = 0; i < 4; i++) { E.start(ctx, 'escape', 'reflex'); ctx.exp.pending[ctx.exp.pending.length - 1].t0 -= 6000; E.onDeath(ctx); }
  for (let i = 0; i < 3; i++) { E.start(ctx, 'shelter', 'reflex'); const p = ctx.exp.pending[ctx.exp.pending.length - 1]; p.t0 -= 31000; E.tick(ctx); }
  plan = R.mobHurtPlan(ctx, bot.entities[5]); assert.strictEqual(plan.skill, 'shelter', 'опыт победил prior: ' + JSON.stringify(plan));
  const l = E.line(ctx); assert(/escape выжил 0\/4/.test(l) && /shelter выжил 3\/3/.test(l), l);
  // похожая обстановка (HP mid) — тоже shelter, по соседнему опыту
  bot.health = 10; assert.strictEqual(E.choose(ctx, ['escape', 'shelter']).action, 'shelter');
  // сохранилось в файл; death отдаёт ключ и последние действия
  assert(JSON.parse(fs.readFileSync(ctx.expFile, 'utf8')).stats[key].escape.died === 4);
  E.start(ctx, 'escape', 'brain'); const d = E.onDeath(ctx); assert(d.situation && d.lastActions.length >= 1 && /escape\(brain\)/.test(d.lastActions.join()), JSON.stringify(d));
  // идёт защитный навык — рефлекс его не дёргает
  ctx.tasks.current = { name: 'shelter' }; assert.strictEqual(R.mobHurtPlan(ctx, bot.entities[5]), null);
  // снимок: строка опыта в eyes и summary
  const snap = E.decorate(ctx, { ready: true, summary: 'x', eyes: {} }); assert(/опыт сейчас/.test(snap.eyes.experience) && /опыт/.test(snap.summary));
  try { fs.unlinkSync(ctx.expFile); } catch (e) {}
  console.log('experience: OK');
}

async function testDigCheck() {
  // снег-слой на земле — копать можно
  let w = fake({ gen: (x, y) => (y <= 65 ? 'dirt' : y === 66 ? 'snow' : 'air') });
  assert.strictEqual(survival.digCheck(w.bot, new Vec3(0, 66, 0)), null, 'снег');
  // стоит на листве ели, под ней 1 воздух, ниже бревно/земля — можно
  w = fake({ gen: (x, y) => (y === 85 || y === 84 ? 'spruce_leaves' : y === 83 ? 'air' : y <= 82 ? 'dirt' : 'air') });
  assert.strictEqual(survival.digCheck(w.bot, new Vec3(0, 86, 0)), null, 'листва');
  // пещера под ямой (2+ воздуха) — нельзя; лава — нельзя; чанк не загружен — wait
  w = fake({ gen: (x, y) => (y >= 62 && y <= 63 ? 'air' : y <= 65 ? 'stone' : 'air') });
  assert(/пустота/.test(survival.digCheck(w.bot, new Vec3(0, 66, 0))));
  w = fake({ gen: (x, y) => (y === 63 ? 'lava' : y <= 65 ? 'stone' : 'air') });
  assert(/lava|лава/.test(survival.digCheck(w.bot, new Vec3(0, 66, 0))));
  w = fake({ gen: (x, y) => (y <= 64 ? null : y === 65 ? 'dirt' : 'air') });
  assert.strictEqual(survival.digCheck(w.bot, new Vec3(0, 66, 0)), 'wait');
  console.log('digCheck: OK');
}

async function testWarnings() {
  // бот в яме-укрытии ночью: стены из земли, снаружи у одной стены воздух
  const w = fake({ gen: (x, y, z) => (y <= 65 ? 'dirt' : 'air'), pos: new Vec3(0.5, 64, 0.5) });
  w.set(0, 64, 0, 'air'); w.set(0, 65, 0, 'air'); w.set(0, 66, 0, 'dirt'); // крышка
  w.set(2, 64, 0, 'air'); // за восточной стеной (1,64,0) — пустота
  mob(w.bot, 5, 'zombie', 3, 0.5);
  const ctx = mkCtx(w.bot);
  assert(survival.isSheltered(w.bot));
  const warn = build.breachWarning(ctx, new Vec3(1, 64, 0));
  assert(/укрытие будет вскрыто/.test(warn) && /zombie 3м/.test(warn), warn);
  assert.strictEqual(build.breachWarning(ctx, new Vec3(-1, 64, 0)), null, 'за стеной земля — туннель, без предупреждения');
  w.bot.time.timeOfDay = DAY; assert.strictEqual(build.breachWarning(ctx, new Vec3(1, 64, 0)), null, 'днём молчим');
  // recover ночью без брони: не отказ, а warning
  const r = fake({ gen: flat }); const rc = mkCtx(r.bot);
  rc.lastDeath = { at: [10, 66, 0], ts: Date.now() }; mob(r.bot, 6, 'zombie', 11, 0.5); mob(r.bot, 7, 'zombie', 12, 1);
  const res = await recover(rc, new Task(2, 'recover', {}, 'test'), {});
  assert(/ночь, нет брони, у места смерти 2 zombie/.test(res.warning), JSON.stringify(res));
  console.log('warnings: OK');
}

async function testShelterDig() {
  // снежная равнина ночью, зомби в 3 м, блоков нет: shelter сам выбирает dig, копает 2 вниз (земля в инвентарь) и закрывает крышку
  const inv = [{ name: 'dirt', count: 0 }];
  const w = fake({ gen: (x, y) => (y <= 65 ? 'dirt' : y === 66 ? 'snow' : 'air'), pos: new Vec3(0.5, 66, 0.5), inv });
  const bot = w.bot; mob(bot, 5, 'zombie', 3.5, 0.5);
  const A = require('../lib/actions');
  bot.dig = async b => {
    w.set(b.position.x, b.position.y, b.position.z, 'air'); inv[0].count++;
    const p = bot.entity.position; while (A.isAirLike(bot.blockAt(p.offset(0, -1, 0)))) p.y -= 1; // падение в яму
    if (p.y < 66) w.set(0, 66, 0, 'air'); // снег без опоры осыпался
  };
  bot.equip = async it => { bot.held = it; };
  bot.placeBlock = async (ref, face) => { const t = ref.position.plus(face); w.set(t.x, t.y, t.z, bot.held.name); bot.held.count--; };
  const ctx = mkCtx(bot);
  const r = await survival.shelter(ctx, new Task(3, 'shelter', {}, 'test'), {});
  assert(r.mode === 'dig' && survival.isSheltered(bot) && ctx.sheltered, JSON.stringify(r));
  assert.strictEqual(bot.entity.position.y, 64);
  console.log('shelter dig: OK', JSON.stringify(r));
}

module.exports = async () => { await testShelterDig(); await testAttacker(); await testExperience(); await testDigCheck(); await testWarnings(); };
if (require.main === module) module.exports().then(() => console.log('defense OK'), e => { console.error(e); process.exit(1); });
