// Офлайн-проверки каркаса вариантов (lib/variants.js): загрузка каталога, битый файл, бандит (детерминированный RNG),
// откат ключа, хранение; плюс по 1–2 проверки на каждый вариант melee на фальшивом боте.
'use strict';
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const V = require('../lib/variants');
const AG = require('../lib/aggressors');
const combat = require('../lib/skills/combat');
const basic = require('../lib/skills/basic');

const tmp = (n) => path.join(os.tmpdir(), 'flytest-var-' + process.pid + '-' + Math.random().toString(36).slice(2) + (n || ''));
const seq = (...xs) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]; };

// ---------- каталог-заглушка ----------
function makeDemoDir() {
  const dir = tmp(), f = path.join(dir, 'demo');
  fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(path.join(f, '_family.js'), `module.exports = { label: 'демо', prior: ['a', 'b', 'c'], sitKeys: s => [s.t + '|' + s.k, s.t, '*'],
    score: ({ result, error }) => ({ ok: !error && result.win, score: !error && result.win ? 1 : 0 }) };`);
  const v = (n, applies) => `module.exports = { name: '${n}', family: 'demo', desc: '${n}', applies: ${applies}, run: async (ctx, t, p) => ({ win: p.win === '${n}', by: '${n}' }) };`;
  fs.writeFileSync(path.join(f, 'a.js'), v('a', '() => true'));
  fs.writeFileSync(path.join(f, 'b.js'), v('b', '() => true'));
  fs.writeFileSync(path.join(f, 'c.js'), v('c', '(ctx, s) => !!s.x'));
  fs.writeFileSync(path.join(f, 'broken.js'), 'module.exports = { name: "broken", run: async () => {} ;'); // синтаксис
  fs.writeFileSync(path.join(f, 'norun.js'), 'module.exports = { name: "norun" };');
  fs.writeFileSync(path.join(f, 'throws.js'), 'throw new Error("падаю при загрузке");');
  return dir;
}

async function testRegistry() {
  const logs = [];
  const reg = V.load(makeDemoDir(), { log: m => logs.push(m) });
  const fam = reg.families.get('demo');
  assert(fam, 'семейство найдено');
  assert.deepStrictEqual([...fam.variants.keys()].sort(), ['a', 'b', 'c'], 'битые пропущены');
  assert.strictEqual(reg.errors.length, 3, JSON.stringify(reg.errors));
  assert(logs.length === 3 && logs.every(l => /пропущен/.test(l)), 'предупреждения в лог');
  assert.strictEqual(fam.def.label, 'демо');
  // реальный каталог: melee со всеми вариантами, без ошибок
  const real = V.load(V.DIR, { log: () => {} });
  assert.deepStrictEqual([...real.families.get('melee').variants.keys()].sort(),
    ['crit_jump', 'hit_and_run', 'kite', 'pillar_fight', 'shield_counter', 'strafe', 'wtap_combo']);
  assert.strictEqual(real.errors.length, 0, JSON.stringify(real.errors));
  return reg;
}

async function testBandit(reg) {
  V.setRegistry(reg);
  try {
    const ctx = { bot: { health: 20 } };
    const sit = { t: 'zombie', k: 'k1', x: false };
    // style форсирует; неприменимый style -> авто с пометкой; неизвестный -> ошибка
    assert.strictEqual(V.choose(ctx, 'demo', sit, { style: 'b' }).name, 'b');
    const cc = V.choose(ctx, 'demo', sit, { style: 'c', rng: () => 0.99 });
    assert(cc.name !== 'c' && /неприменим/.test(cc.why), cc.why);
    assert.throws(() => V.choose(ctx, 'demo', sit, { style: 'zzz' }), /такого варианта нет/);
    assert.throws(() => V.checkStyle('demo', 'zzz'));
    assert.strictEqual(V.checkStyle('demo', 'AUTO'), 'auto');
    // без опыта — по prior
    assert.strictEqual(V.choose(ctx, 'demo', sit, { rng: () => 0.99 }).name, 'a');
    // неприменимые не выбираются никогда
    let r = 0.0;
    for (let i = 0; i < 60; i++) { r = (r + 0.137) % 1; assert.notStrictEqual(V.choose(ctx, 'demo', sit, { rng: () => r }).name, 'c'); }
    // статистика: a проигрывает, b выигрывает -> b
    for (let i = 0; i < 5; i++) { V.record(ctx, 'demo', 'a', sit, { ok: false, score: 0 }); V.record(ctx, 'demo', 'b', sit, { ok: true, score: 1 }); }
    let ch = V.choose(ctx, 'demo', sit, { rng: () => 0.99 });
    assert.strictEqual(ch.name, 'b'); assert(/лучший 5\/5/.test(ch.why), ch.why);
    // исследование: c стал применим и не пробован — шанс дан (rng мал), при большом rng — лучший
    const sx = { ...sit, x: true };
    assert.strictEqual(V.choose(ctx, 'demo', sx, { rng: () => 0.1 }).name, 'c');
    assert.strictEqual(V.choose(ctx, 'demo', sx, { rng: () => 0.99 }).name, 'b');
    // эпсилон: случайный применимый
    assert.strictEqual(V.choose(ctx, 'demo', sit, { rng: seq(0.05, 0.01) }).name, 'a');
    // откат ключа: на новом точном ключе данных нет — берётся общий 'zombie'
    ch = V.choose(ctx, 'demo', { t: 'zombie', k: 'k2' }, { rng: () => 0.99 });
    assert.strictEqual(ch.name, 'b'); assert(/\(zombie\)/.test(ch.why), ch.why);
    // точный ключ с достаточной статистикой важнее общего
    for (let i = 0; i < 3; i++) { V.record(ctx, 'demo', 'a', ['zombie|k3'], { ok: true, score: 1 }); V.record(ctx, 'demo', 'b', ['zombie|k3'], { ok: false, score: 0 }); }
    assert.strictEqual(V.choose(ctx, 'demo', { t: 'zombie', k: 'k3' }, { rng: () => 0.99 }).name, 'a');
    // совсем другая цель: откат до '*'
    assert.strictEqual(V.choose(ctx, 'demo', { t: 'spider', k: 'k1' }, { rng: () => 0.99 }).name, 'b');
    // exclude
    assert.strictEqual(V.choose(ctx, 'demo', sit, { rng: () => 0.99, exclude: new Set(['b']) }).name, 'a');
    // perform: выбор + запуск + оценка семейства + запись
    const ctx2 = { bot: { health: 20 }, variantsFile: tmp('.json') };
    const res = await V.perform(ctx2, new Task(1, 'x', {}, 'test'), 'demo', { win: 'a' }, sit, { rng: () => 0.99 });
    assert.strictEqual(res.variant, 'a'); assert.strictEqual(res.by, 'a');
    // хранение: атомарно, без .tmp, читается новым ctx
    assert(fs.existsSync(ctx2.variantsFile) && !fs.existsSync(ctx2.variantsFile + '.tmp'));
    const ctx3 = { bot: {}, variantsFile: ctx2.variantsFile };
    assert.strictEqual(V.stats(ctx3, 'demo').stats.demo['zombie|k1'].a.n, 1);
    assert.strictEqual(V.stats(ctx3).stats.demo['*'].a.ok, 1);
    // без файла (тест) — только в памяти, ничего не пишет
    assert.strictEqual(ctx.variantsFile, undefined);
    // ----- dangerous situation tests -----
    // isDangerous: HP < 10, foe nearby (dist <= 10), night or underground
    // Demo family sitKeys uses s.t and s.k
    const dangerSit = { t: 'zombie', k: 'k1', hpNum: 6, dist: 7, targetType: 'mob', phase: 'night', place: 'outdoors' };
    const safeSit = { t: 'zombie', k: 'k1', hpNum: 15, dist: 7, targetType: 'mob', phase: 'day', place: 'outdoors' };
    // Setup: variant 'a' (bad, ok=0), 'b' (good, ok=5/5), 'c' (fresh, applies when x=true)
    const ctxD = { bot: { health: 6 }, variantRand: () => 0.1 };
    for (let i = 0; i < 5; i++) { V.record(ctxD, 'demo', 'a', dangerSit, { ok: false, score: 0 }); V.record(ctxD, 'demo', 'b', dangerSit, { ok: true, score: 1 }); }
    // Fresh variant 'c' becomes applicable in dangerSit (x: true)
    const dangerSitX = { ...dangerSit, x: true };
    // In dangerous situation: should NOT pick fresh 'c' even with low rng, should pick 'b' (good)
    const chDanger = V.choose(ctxD, 'demo', dangerSitX, { rng: () => 0.01 });
    assert.strictEqual(chDanger.name, 'b', 'опасная обстановка: не выбирает fresh, а лучший b');
    assert(/опасная обстановка.*исследование выкл/.test(chDanger.why), 'why упоминает опасную обстановку: ' + chDanger.why);
    // In dangerous situation: should NOT pick 'a' (ok=0) when 'b' exists
    const chDanger2 = V.choose(ctxD, 'demo', dangerSit, { rng: () => 0.99 });
    assert.strictEqual(chDanger2.name, 'b', 'опасная обстановка: не выбирает a (ok=0)');
    // In safe situation: fresh 'c' CAN be picked with low rng
    const ctxS = { bot: { health: 15 }, variantRand: () => 0.1 };
    for (let i = 0; i < 5; i++) { V.record(ctxS, 'demo', 'a', safeSit, { ok: false, score: 0 }); V.record(ctxS, 'demo', 'b', safeSit, { ok: true, score: 1 }); }
    const chSafe = V.choose(ctxS, 'demo', { ...safeSit, x: true }, { rng: () => 0.01 });
    assert.strictEqual(chSafe.name, 'c', 'спокойная обстановка: fresh выбирается при низком rng');
    // Verify NEW_P is effectively 0 in danger: fresh not picked even at rng=0
    assert.strictEqual(V.choose(ctxD, 'demo', { ...dangerSit, x: true }, { rng: () => 0 }).name, 'b', 'при rng=0 в опасности fresh не выбирается');
    // Verify reason logging includes why not best
    const whyTest = V.choose(ctxD, 'demo', dangerSit, { rng: () => 0.99 });
    assert(/лучший 5\/5/.test(whyTest.why), 'why содержит счёт лучшего: ' + whyTest.why);
  } finally { V.setRegistry(null); }
  console.log('variants bandit: OK');
}

// ---------- фальшивый бот для melee ----------
const solid = n => !['air', 'water', 'lava'].includes(n);
const flat = (x, y) => (y <= 65 ? 'dirt' : 'air');
function fakeBot(gen = flat, { inv = [], off = null } = {}) {
  const calls = [];
  const bot = {
    username: 'FlyTest', health: 20, food: 20, heldItem: { name: 'wooden_sword' },
    entity: { id: 1, position: new Vec3(0.5, 66, 0.5), height: 1.8, velocity: new Vec3(0, 0, 0), onGround: true }, entities: {}, players: {},
    inventory: { items: () => inv, slots: off ? { 45: off } : {} },
    blockAt(p) { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), n = gen(x, y, z); return n == null ? null : { name: n, boundingBox: solid(n) ? 'block' : 'empty', position: new Vec3(x, y, z) }; },
    pathfinder: { setMovements() {}, setGoal(g) { calls.push(['goal', g ? g.constructor.name : null]); } },
    setControlState(k, v) { calls.push(['ctl', k, v]); if (bot.onCtl) bot.onCtl(k, v); }, clearControlStates() { calls.push(['clear']); },
    lookAt: async () => {}, attack(e) { calls.push(['attack', Date.now()]); if (bot.onAttack) bot.onAttack(e); },
    activateItem() { calls.push(['shield', true]); }, deactivateItem() { calls.push(['shield', false]); },
    equip: async (it, where) => { calls.push(['equip', it.name, where]); }
  };
  bot.entities[1] = bot.entity;
  return { bot, calls, ctx: { bot, stats: { blocksPlaced: 0 } } };
}
const mob = (bot, name, x, z = 0.5, extra = {}) => { const e = { id: 10, name, type: 'hostile', position: new Vec3(x, 66, z), height: 1.95, width: 0.6, ...extra }; bot.entities[e.id] = e; return e; };
const dieAfter = (bot, k) => { let n = 0; bot.onAttack = e => { if (++n >= k) delete bot.entities[e.id]; }; };
const task = () => new Task(1, 'fight', {}, 'test');
const idx = (calls, pred) => calls.findIndex(pred);
const ctl = (k, v) => c => c[0] === 'ctl' && c[1] === k && c[2] === v;
const isAtk = c => c[0] === 'attack';

async function testMelee() {
  V.setRegistry(null);
  const fam = V.family('melee');
  const ap = (name, sit) => fam.variants.get(name).applies({}, { ceiling: 5, hp: 'high', count: '1', food: 20, blocks: 0, ...sit });

  // situation: признаки цели и местности
  {
    const { bot, ctx } = fakeBot((x, y) => (y >= 69 ? 'stone' : flat(x, y)), { inv: [{ name: 'shield', count: 1 }, { name: 'dirt', count: 5 }] });
    const z = mob(bot, 'skeleton', 3, 0.5, { equipment: [{ name: 'bow' }] });
    const s = V.situation(ctx, z);
    assert.strictEqual(s.target, 'skeleton'); assert(s.ranged && !s.pvp && s.shield && s.blocks === 5 && s.ceiling === 3 && !s.water, JSON.stringify(s));
    assert.strictEqual(s.targetWeapon, 'bow'); assert(s.expKey && s.key === s.expKey);
    assert.strictEqual(fam.def.sitKeys(s)[2], 'skeleton');
  }

  // auto без опыта: kite, итог записан
  {
    const { bot, ctx } = fakeBot(); mob(bot, 'zombie', 3.5); dieAfter(bot, 1);
    const r = await combat.fight(ctx, task(), { timeout: 5, sprint: false });
    assert.strictEqual(r.variant, 'kite'); assert.strictEqual(r.kills, 1);
    const st = V.stats(ctx, 'melee').stats.melee;
    assert(st.zombie.kite.n === 1 && st.zombie.kite.ok === 1, JSON.stringify(st));
    await assert.rejects(combat.fight(ctx, task(), { style: 'nope' }), /такого варианта нет/);
  }

  // crit_jump: удар только после прыжка и начала падения; не в воде / низкий потолок
  {
    assert(ap('crit_jump', {}) && !ap('crit_jump', { water: true }) && !ap('crit_jump', { ceiling: 2 }) && !ap('crit_jump', { ladder: true }));
    const { bot, calls, ctx } = fakeBot(); mob(bot, 'zombie', 3.5); dieAfter(bot, 1);
    let fallT = 0;
    bot.onCtl = (k, v) => { if (k === 'jump' && v) { bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, 0.4, 0); setTimeout(() => { bot.entity.velocity = new Vec3(0, -0.3, 0); fallT = Date.now(); }, 200); } if (k === 'jump' && !v) setTimeout(() => { bot.entity.onGround = true; }, 300); };
    const r = await combat.fight(ctx, task(), { timeout: 5, style: 'crit_jump' });
    assert.strictEqual(r.variant, 'crit_jump');
    const j = idx(calls, ctl('jump', true)), a = idx(calls, isAtk);
    assert(j >= 0 && j < a, 'прыжок до удара');
    assert(fallT && calls[a][1] >= fallT, 'удар на падении');
    assert(!calls.slice(j, a).some(ctl('sprint', true)), 'без спринта');
  }

  // wtap_combo: каждый удар — со свежим спринтом, после удара спринт сброшен; на перезарядке не пятится
  {
    assert(!ap('wtap_combo', { creeper: true }) && !ap('wtap_combo', { food: 4 }) && !ap('wtap_combo', { defend: true }));
    const { bot, calls, ctx } = fakeBot(); mob(bot, 'zombie', 3.1); dieAfter(bot, 2);
    await combat.fight(ctx, task(), { timeout: 6, style: 'wtap_combo' });
    const atks = calls.map((c, i) => (isAtk(c) ? i : -1)).filter(i => i >= 0);
    assert.strictEqual(atks.length, 2);
    let from = 0;
    for (const a of atks) { const s = calls.slice(from, a).map((c, i) => (ctl('sprint', true)(c) ? i : -1)).filter(i => i >= 0); assert(s.length, 'спринт перед каждым ударом'); assert(calls.slice(a - 1, a + 1).some(c => c[0] === 'clear') || calls[a - 1][0] === 'clear', 'сброс'); from = a + 1; }
    assert(!calls.some(ctl('back', true)), 'не отходит');
  }

  // strafe: на перезарядке шаг вбок; у стены с одной стороны — в другую
  {
    assert(ap('strafe', { pvp: true }) && !ap('strafe', { creeper: true }));
    const { bot, calls, ctx } = fakeBot((x, y, z) => (z >= 2 && y >= 66 && y <= 67 ? 'stone' : flat(x, y))); mob(bot, 'zombie', 2.5); dieAfter(bot, 2);
    await combat.fight(ctx, task(), { timeout: 6, style: 'strafe', sprint: false });
    const sides = calls.filter(c => c[0] === 'ctl' && (c[1] === 'left' || c[1] === 'right') && c[2] === true).map(c => c[1]);
    assert(sides.length, 'кружит');
    // стена на +z: смотрим на +x, значит налево (+z... ) запрещено — только одна сторона
    assert.strictEqual(new Set(sides).size, 1, 'у стены — только в свободную сторону: ' + [...new Set(sides)]);
  }

  // shield_counter: щит поднят на перезарядке, опущен перед ударом; без щита неприменим
  {
    assert(!ap('shield_counter', { shield: false }) && ap('shield_counter', { shield: true }));
    const { bot, calls, ctx } = fakeBot(flat, { off: { name: 'shield' } }); mob(bot, 'skeleton', 2.0); dieAfter(bot, 2);
    const r = await combat.fight(ctx, task(), { timeout: 6, style: 'shield_counter' });
    assert.strictEqual(r.variant, 'shield_counter');
    const atks = calls.map((c, i) => (isAtk(c) ? i : -1)).filter(i => i >= 0);
    const up = idx(calls, c => c[0] === 'shield' && c[1] === true);
    assert(up > atks[0] && up < atks[1], 'щит поднят между ударами');
    const lastShield = calls.slice(0, atks[1]).filter(c => c[0] === 'shield').pop();
    assert.deepStrictEqual(lastShield, ['shield', false], 'перед контрударом опущен');
    assert.deepStrictEqual(calls.filter(c => c[0] === 'shield').pop(), ['shield', false], 'после боя опущен');
  }

  // hit_and_run: после удара — отбег (GoalInvert); не против стрелков и не в охране
  {
    assert(ap('hit_and_run', { target: 'spider' }) && !ap('hit_and_run', { target: 'skeleton', ranged: true }) && !ap('hit_and_run', { target: 'spider', defend: true }) && !ap('hit_and_run', { target: 'zombie' }));
    assert(ap('hit_and_run', { target: 'zombie', count: '2-3' }), 'группа');
    const { bot, calls, ctx } = fakeBot(); mob(bot, 'spider', 3.5, 0.5, { width: 1.4, height: 0.9 }); dieAfter(bot, 2);
    await combat.fight(ctx, task(), { timeout: 8, style: 'hit_and_run', sprint: false });
    const a = idx(calls, isAtk);
    assert(calls.slice(a).some(c => c[0] === 'goal' && c[1] === 'GoalInvert'), 'отбегает после удара');
  }

  // pillar_fight: столб 2 и удары сверху без шагов; неудачный столб — бой продолжает другой вариант
  {
    assert(ap('pillar_fight', { target: 'zombie', blocks: 4 }) && !ap('pillar_fight', { target: 'skeleton', blocks: 4 }) && !ap('pillar_fight', { target: 'zombie', blocks: 1 }) && !ap('pillar_fight', { target: 'zombie', blocks: 4, pvp: true }));
    const orig = basic.pillarUp;
    try {
      let asked = null;
      basic.pillarUp = async (c, t, p) => { asked = p.height; return { raised: 2 }; };
      const dirt = { inv: [{ name: 'dirt', count: 4 }] };
      let { bot, calls, ctx } = fakeBot(flat, dirt); mob(bot, 'zombie', 2.0); dieAfter(bot, 2);
      let r = await combat.fight(ctx, task(), { timeout: 6, style: 'pillar_fight' });
      assert.strictEqual(asked, 2); assert.strictEqual(r.variant, 'pillar_fight'); assert.strictEqual(r.hits, 2);
      assert(!calls.some(c => c[0] === 'ctl' && c[2] === true), 'на столбе не двигается');
      basic.pillarUp = async () => { throw new Error('нечем ставить'); };
      ({ bot, calls, ctx } = fakeBot(flat, dirt)); mob(bot, 'zombie', 3.5); dieAfter(bot, 1);
      r = await combat.fight(ctx, task(), { timeout: 6, style: 'pillar_fight' });
      assert(r.kills === 1 && r.variant !== 'pillar_fight' && r.variants.pillar_fight === 1, JSON.stringify(r));
      assert.strictEqual(V.stats(ctx, 'melee').stats.melee.zombie.pillar_fight.ok, 0, 'неудача записана');
    } finally { basic.pillarUp = orig; }
  }

  // pvp: FlyBot-агрессор — бой с вариантом, sit.pvp; не агрессор — не бьём
  {
    const { bot, calls, ctx } = fakeBot();
    const fb = { id: 20, type: 'player', username: 'FlyBot', name: 'player', position: new Vec3(3.3, 66, 0.5), height: 1.8, width: 0.6, heldItem: { name: 'stone_sword' } };
    bot.entities[20] = fb; bot.players.FlyBot = { username: 'FlyBot', entity: fb };
    await assert.rejects(combat.fight(ctx, task(), { target: 'FlyBot' }), /не нападал/);
    AG.record(ctx, 'FlyBot'); dieAfter(bot, 2);
    const s = V.situation(ctx, fb);
    assert(s.pvp && s.targetType === 'player' && s.targetWeapon === 'stone_sword');
    assert.strictEqual(fam.def.sitKeys(s)[2], 'player');
    const r = await combat.fight(ctx, task(), { target: 'FlyBot', style: 'strafe', sprint: false, timeout: 6 });
    assert.strictEqual(r.variant, 'strafe'); assert.strictEqual(r.hits, 2);
    assert(calls.some(c => c[0] === 'ctl' && (c[1] === 'left' || c[1] === 'right') && c[2] === true));
    assert(V.stats(ctx, 'melee').stats.melee.player.strafe.n === 1);
  }

  // defend: вариант на схватку, без погони; hit_and_run/pillar в охране не выбираются
  {
    const { bot, calls, ctx } = fakeBot(); mob(bot, 'zombie', 3.5);
    ctx.variantRand = () => 0.1; // исследование вовсю — но неприменимые не попадут
    const r = await combat.defend(ctx, new Task(1, 'defend', {}, 'test'), { duration: 3 });
    assert(r.hits >= 3, 'defend бьёт');
    assert(!r.variants.hit_and_run && !r.variants.pillar_fight && !r.variants.wtap_combo, JSON.stringify(r.variants));
    assert(!calls.some(c => c[0] === 'goal' && c[1] && c[1] !== 'GoalInvert'), 'не гонится');
  }

  // snapshot-строка появляется при данных
  {
    const ctx = { bot: fakeBot().bot };
    assert.strictEqual(V.line(ctx), null);
    for (let i = 0; i < 3; i++) V.record(ctx, 'melee', 'crit_jump', ['zombie', '*'], { ok: true, score: 0.9 });
    V.record(ctx, 'melee', 'kite', ['zombie', '*'], { ok: false, score: 0.1 });
    mob(ctx.bot, 'zombie', 5);
    assert.strictEqual(V.line(ctx), 'бой: лучший crit_jump 3/3 (zombie)');
    const snap = V.decorate(ctx, { ready: true, summary: 'x.', eyes: {} });
    assert(/crit_jump/.test(snap.summary) && snap.eyes.variants);
  }
  console.log('variants melee: OK');
}

module.exports = async () => { const reg = await testRegistry(); await testBandit(reg); await testMelee(); };
if (require.main === module) module.exports().then(() => console.log('variants OK'), e => { console.error(e); process.exit(1); });
