// Офлайн-проверки разделения «ядро / поведение»: загрузка behavior/, сломанная версия не включается,
// бросающая или зависшая — откатывается на рабочую; события ядра доходят до поведения; запретные зоны;
// законы игры (блок danger: время до смерти); руки для воды (swim_to, dive, блок под водой).
'use strict';
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const EventEmitter = require('events');
const { Vec3 } = require('../lib/util');
const { BehaviorHost, check } = require('../lib/behavior_host');
const zones = require('../lib/zones');
const D = require('../lib/danger');
const water = require('../lib/skills/water');
const A = require('../lib/actions');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000, what = 'условие') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(10); }
  throw new Error('не дождались: ' + what);
}

// Версия поведения в каталоге: body — код attach (тело функции, есть api), extra — добавка к экспорту
function writeVersion(dir, { attach = '', selfTest = 'async () => true', extra = '', raw = null } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), raw != null ? raw :
    `'use strict';\nmodule.exports = { API: 1, name: 'тест', attach(api) { ${attach} }, selfTest: ${selfTest}${extra ? ', ' + extra : ''} };\n`);
}

function fakeCtx() {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'overworld' };
  const ev = [];
  return { bot, ready: true, ev, events: { push: (type, data) => ev.push({ type, ...data }) } };
}

async function hostTests() {
  // настоящая behavior/ проходит проверку (загрузка + selfTest)
  const real = await check(path.join(__dirname, '..', 'behavior'));
  assert.ok(real.ok, 'behavior/ не прошла проверку: ' + real.error);
  assert.ok(typeof real.mod.chooseMelee === 'function' && Array.isArray(real.mod.zones));
  console.log('  behavior/ selfTest: OK (' + real.ms + ' мс)');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flybeh-'));
  const dir = path.join(tmp, 'behavior'), versionsDir = path.join(tmp, 'versions');
  const ctx = fakeCtx();
  const host = new BehaviorHost(ctx, { dir, versionsDir, limits: { CHECK_MS: 300, HANG_MS: 150, FAULT_N: 3, FAULT_WINDOW_MS: 5000, GOOD_MS: 80, WATCH_MS: 30, RESTART_GAP_MS: 0 } });
  const session = { bot: ctx.bot };
  try {
    // рабочая версия: таймер считает, событие mob_hurt доходит, зона из поведения
    writeVersion(dir, {
      attach: `api.ctx.ticks = 0; api.every(10, () => { api.ctx.ticks++; }, 'счёт'); api.handle('mob_hurt', p => { api.ctx.hurtBy = p.att; });
               api.on(api.bot, 'death', () => { api.ctx.died = (api.ctx.died || 0) + 1; }); return { detach() { api.ctx.detached = (api.ctx.detached || 0) + 1; } };`,
      extra: `zones: [{ name: 'дом', min: [10, 60, 10], max: [12, 70, 12] }]`
    });
    const r0 = await host.init();
    assert.ok(r0.ok, r0.error);
    host.attachSession(session);
    await until(() => ctx.ticks > 2, 2000, 'таймер поведения');
    host.emit('mob_hurt', { att: 'зомби' });
    assert.strictEqual(ctx.hurtBy, 'зомби');
    ctx.bot.emit('death');
    assert.strictEqual(ctx.died, 1);
    assert.ok(zones.forbidden(ctx, new Vec3(11, 65, 11)), 'зона из поведения не работает');
    assert.strictEqual(zones.forbidden(ctx, new Vec3(13, 65, 11)), null);
    assert.strictEqual(zones.forbidden(ctx, [11, 65, 11], 'the_nether') && true, true, 'зона без dim — во всех измерениях');
    assert.strictEqual(zones.breakExclusion(ctx)({ position: new Vec3(10, 60, 10) }), 100);
    await until(() => host.lastGood(null), 2000, 'версия стала рабочей');
    const good = host.active;
    assert.ok(fs.existsSync(path.join(versionsDir, good.id, 'index.js')), 'копия версии не сохранена');
    console.log('  загрузка, события, зоны, рабочая версия: OK');

    // сломанные версии не включаются, активной остаётся рабочая
    const broken = [
      ['синтаксис', { raw: 'module.exports = { API: 1, attach( {' }],
      ['нет selfTest', { raw: `module.exports = { API: 1, attach() {} };` }],
      ['не тот API', { raw: `module.exports = { API: 2, attach() {}, selfTest: async () => 1 };` }],
      ['selfTest падает', { selfTest: `async () => { throw new Error('порог не число'); }` }],
      ['selfTest висит', { selfTest: `() => new Promise(() => {})` }],
      ['зоны неверные', { extra: `zones: [{ name: 'x', min: [1, 2] }]` }]
    ];
    for (const [what, v] of broken) {
      writeVersion(dir, v);
      const r = await host.reload('тест: ' + what);
      assert.strictEqual(r.ok, false, what + ': сломанная версия включилась');
      assert.strictEqual(host.active.hash, good.hash, what + ': активная сменилась');
    }
    const refused = ctx.ev.filter(e => e.type === 'behavior' && e.what === 'не включена').length;
    assert.strictEqual(refused, broken.length);
    console.log('  сломанные версии не включаются (' + broken.length + ' видов): OK');

    // версия, которая бросает исключения в таймере -> откат на рабочую
    writeVersion(dir, { attach: `api.every(10, () => { throw new Error('бум'); }, 'бомба');` });
    const r1 = await host.reload('тест: бросает');
    assert.ok(r1.ok, r1.error);
    assert.notStrictEqual(host.active.hash, good.hash);
    await until(() => host.active.hash === good.hash && !host.busy, 3000, 'откат после исключений');
    assert.ok(ctx.ev.some(e => e.type === 'behavior' && e.what === 'откат' && e.to === good.id), 'нет события отката');
    const n = ctx.ticks; await until(() => ctx.ticks > n + 2, 2000, 'рабочая версия снова тикает');
    console.log('  исключения -> откат на рабочую: OK');

    // версия, которая зависает (promise не отвечает) -> откат
    writeVersion(dir, { attach: `api.every(1000, () => new Promise(() => {}), 'вечное ожидание'); api.after(5, () => new Promise(() => {}), 'зависание');` });
    const r2 = await host.reload('тест: висит');
    assert.ok(r2.ok, r2.error);
    await until(() => host.active.hash === good.hash && !host.busy, 3000, 'откат после зависания');
    assert.ok(ctx.ev.some(e => e.type === 'behavior' && e.what === 'откат' && /завис/.test(e.why)), 'нет отката по зависанию');
    console.log('  зависание -> откат на рабочую: OK');

    // attach падает -> откат
    writeVersion(dir, { attach: `throw new Error('attach сломан');` });
    const r3 = await host.reload('тест: attach падает');
    assert.ok(r3.ok);
    await until(() => host.active.hash === good.hash && !host.busy, 3000, 'откат после падения attach');
    console.log('  падение attach -> откат: OK');

    // call: поведение даёт решение, упало — решение ядра
    writeVersion(dir, { extra: `chooseMelee: (a) => { if (a === 'бум') throw new Error('x'); return 'поведение'; }` });
    assert.ok((await host.reload('тест: call')).ok);
    assert.strictEqual(host.call('chooseMelee', ['a'], () => 'ядро'), 'поведение');
    assert.strictEqual(host.call('chooseMelee', ['бум'], () => 'ядро'), 'ядро');

    // статус для аудита
    const st = host.status();
    assert.ok(st.active && st.lastGood && st.rollbacks.length >= 3, 'статус без истории откатов');
    assert.ok(st.rollbacks.every(x => /^(откат|перезапуск)/.test(x.what)));
    console.log('  GET /behavior (статус и история откатов): OK');

    // при запуске тела сломанная behavior/ -> берётся последняя рабочая
    writeVersion(dir, { raw: 'ошибка синтаксиса (' });
    const ctx2 = fakeCtx();
    const host2 = new BehaviorHost(ctx2, { dir, versionsDir, limits: { CHECK_MS: 300 } });
    const r4 = await host2.init();
    host2.stop();
    assert.ok(r4.ok && r4.active.id === good.id, 'при запуске не взялась рабочая версия');
    console.log('  запуск со сломанной behavior/ -> рабочая версия: OK');
  } finally {
    host.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function dangerTests() {
  const base = { hp: 20, food: 20, saturation: 5, difficulty: 'normal', y: 64, minY: -64, head: 'air', feet: 'air', onGround: true, hurt: [], now: 100000 };
  const C = s => D.compute({ ...base, ...s });

  // всё спокойно — угроз нет
  const calm = C({});
  assert.strictEqual(calm.worst, null);
  assert.strictEqual(calm.air.underWater, false);

  // под водой 10 с, HP 20: воздуха 5 с, потом 10 с утопления -> 15 с
  const dr = C({ head: 'water', feet: 'water', headUnderSec: 10, air: null });
  assert.strictEqual(dr.air.airSec, 5);
  assert.strictEqual(dr.air.ttdSec, 15);
  assert.deepStrictEqual(dr.worst, { kind: 'air', ttdSec: 15 });
  // сервер говорит, что воздуха меньше (60 тиков = 3 с) -> берём меньшее
  assert.strictEqual(C({ head: 'water', headUnderSec: 1, air: 60 }).air.airSec, 3);

  // лава: 8 урона/с -> HP 20 живёт 2.5 с; огнестойкость — 0
  assert.strictEqual(C({ feet: 'lava' }).lava.ttdSec, 2.5);
  assert.strictEqual(C({ feet: 'lava', fireResistance: true }).lava.ttdSec, null);
  // огонь 2/с, горение 1/с
  assert.strictEqual(C({ hp: 10, feet: 'fire' }).fire.ttdSec, 5);
  assert.strictEqual(C({ hp: 10, onFire: true }).fire.ttdSec, 10);

  // голод: на сложной HP 10 при сытости 0 -> 40 с; на нормальной до 1 HP (не смерть); бег при сытости 6 нельзя
  const hs = C({ hp: 10, food: 0, difficulty: 'hard' });
  assert.strictEqual(hs.hunger.ttdSec, 40);
  const hn = C({ hp: 10, food: 0 });
  assert.strictEqual(hn.hunger.ttdSec, null);
  assert.strictEqual(hn.hunger.stopsAtHp, 1);
  assert.strictEqual(C({ food: 6 }).hunger.canSprint, false);
  assert.strictEqual(C({ food: 7 }).hunger.canSprint, true);

  // падение 10 блоков на камень: 7 урона; в воду — 0; на кровать — половина; HP 5 -> смертельно
  assert.strictEqual(C({ onGround: false, fall: { height: 10, landing: 'stone' } }).fall.damage, 7);
  assert.strictEqual(C({ onGround: false, fall: { height: 10, landing: 'water' } }).fall.damage, 0);
  assert.strictEqual(C({ onGround: false, fall: { height: 10, landing: 'red_bed' } }).fall.damage, 4);
  const lf = C({ hp: 5, onGround: false, velY: -0.5, fall: { height: 10, landing: 'stone' } });
  assert.ok(lf.fall.lethal && lf.fall.ttdSec > 0 && lf.fall.ttdSec < 2, 'смертельное падение без времени');
  assert.strictEqual(lf.worst.kind, 'fall');

  // пустота: ниже дна мира 8 урона/с
  const vd = C({ y: -70, onGround: false, fall: null });
  assert.strictEqual(vd.void.below, true);
  assert.strictEqual(vd.void.ttdSec, 2.5);
  assert.strictEqual(C({ onGround: false, fall: null }).void.voidUnder, true);

  // входящий урон: 6 за 5 с при HP 12 -> 1.2/с -> 10 с; старые удары не в счёт
  const dm = C({ hp: 12, hurt: [{ t: 99000, amount: 4 }, { t: 97000, amount: 2 }, { t: 90000, amount: 9 }] });
  assert.strictEqual(dm.damage.dps, 1.2);
  assert.strictEqual(dm.damage.ttdSec, 10);
  assert.strictEqual(dm.damage.hits, 2);

  // самое срочное из нескольких: в лаве и тонет
  assert.strictEqual(C({ head: 'water', headUnderSec: 14, feet: 'lava' }).worst.kind, 'lava');
  assert.ok(/броня/.test(calm.note), 'нет пометки, что броня не учтена');
  console.log('  danger: воздух, огонь, лава, голод, падение, пустота, урон: OK');
  console.log('  пример: ' + JSON.stringify({ air: dr.air, worst: dr.worst }));
}

// Фальшивый бот в воде: плывёт к точке взгляда, если нажато «вперёд»; «присесть» — вниз, «прыжок» — вверх
function waterBot({ gen, pos }) {
  const ctrl = {};
  const bot = {
    entity: { position: pos, yaw: 0, onGround: false, velocity: new Vec3(0, 0, 0) },
    oxygenLevel: 20, look: null,
    blockAt(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      const name = (bot.placed && bot.placed[x + ',' + y + ',' + z]) || gen(x, y, z);
      return { name, boundingBox: ['water', 'air'].includes(name) ? 'empty' : 'block', position: new Vec3(x, y, z) };
    },
    setControlState(k, v) { ctrl[k] = v; }, getControlState: k => !!ctrl[k],
    clearControlStates() { for (const k of Object.keys(ctrl)) ctrl[k] = false; },
    async lookAt(p) { bot.look = p; }, async look() {},
    step() {
      const p = bot.entity.position;
      if (ctrl.forward && bot.look) { const d = bot.look.minus(p); const h = Math.hypot(d.x, d.z) || 1; const s = ctrl.sprint ? 0.6 : 0.3; p.x += d.x / h * Math.min(s, h); p.z += d.z / h * Math.min(s, h); }
      if (ctrl.jump) p.y += 0.3;
      if (ctrl.sneak) { const below = bot.blockAt(p.offset(0, -0.3, 0)); if (below.boundingBox === 'block') bot.entity.onGround = true; else p.y -= 0.3; }
    },
    ctrl
  };
  return bot;
}
function fakeTask(bot) {
  return { check() {}, progress() {}, async sleep() { bot.step(); } };
}

async function waterTests() {
  const sea = (x, y, z) => y <= 50 ? 'stone' : y <= 62 ? 'water' : 'air';
  // swim_to под водой: доплывает, «прыжок» отпущен, всплывать сама не стала
  {
    const bot = waterBot({ gen: sea, pos: new Vec3(0.5, 58, 0.5) });
    const ctx = { bot };
    const r = await water.swimTo(ctx, fakeTask(bot), { x: 6, y: 55, z: 0, sprint: 1 });
    assert.ok(r.arrived, 'не доплыла');
    assert.strictEqual(r.inWater, true);
    assert.ok(bot.entity.position.y < 57, 'всплыла сама');
    assert.strictEqual(ctx.manualControl, false);
    assert.ok(!Object.values(bot.ctrl).some(Boolean), 'кнопки не отпущены');
  }
  // dive: вниз на 4 блока; до дна — останавливается на дне
  {
    const bot = waterBot({ gen: sea, pos: new Vec3(0.5, 61, 0.5) });
    const r = await water.dive({ bot }, fakeTask(bot), { depth: 4 });
    assert.ok(r.reached && r.dived >= 3.7, 'не нырнула на 4');
    const bot2 = waterBot({ gen: sea, pos: new Vec3(0.5, 54, 0.5) });
    const r2 = await water.dive({ bot: bot2 }, fakeTask(bot2), { depth: 20 });
    assert.ok(r2.bottom && !r2.reached, 'дно не распознано');
    const land = waterBot({ gen: (x, y) => y < 64 ? 'stone' : 'air', pos: new Vec3(0.5, 64, 0.5) });
    await assert.rejects(water.dive({ bot: land }, fakeTask(land), {}), /не в воде/);
  }
  // блок под водой: клетка с водой — не помеха для place_at
  {
    const bot = waterBot({ gen: sea, pos: new Vec3(5.5, 55, 5.5) });
    let placed = null;
    bot.inventory = { items: () => [{ name: 'cobblestone', count: 8 }] };
    bot.heldItem = null;
    bot.equip = async it => { bot.heldItem = it; };
    bot.placeBlock = async (ref, face) => { placed = ref.position.plus(face); };
    const ok = await A.placeBlockAt(bot, new Vec3(0, 51, 0), 'cobblestone');
    assert.ok(ok);
    assert.deepStrictEqual([placed.x, placed.y, placed.z], [0, 51, 0]);
  }
  console.log('  вода: swim_to, dive, блок под водой: OK');
}

module.exports = async function () {
  dangerTests();
  await waterTests();
  await hostTests();
  console.log('behavior: OK');
};
if (require.main === module) module.exports().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
