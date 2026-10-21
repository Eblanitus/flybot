// Офлайн-проверка критика: каждое правило и лимиты advice на фальшивом ctx
'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { create, toolKindOf, normErr } = require('../lib/critic');
const { EventHub, QUIET } = require('../lib/events');

module.exports = async () => {
  // советы мозгу больше не шлются (решение хозяина 21.10) — проверяем отчётные записи критика
  assert.strictEqual(toolKindOf('oak_log'), 'axe'); assert.strictEqual(toolKindOf('iron_ore'), 'pickaxe'); assert.strictEqual(toolKindOf('stone'), 'pickaxe');
  assert.strictEqual(toolKindOf('sand'), 'shovel'); assert.strictEqual(toolKindOf('wheat'), null);
  assert.strictEqual(normErr('не хватает 3 stick'), normErr('не хватает 2 stick'));

  const mk = () => {
    let t = 1e9; const items = []; const evs = [];
    const hub = new EventHub(100); const orig = hub.push.bind(hub); hub.push = (ty, d) => { evs.push({ type: ty, ...d }); return orig(ty, d); };
    const ctx = { ready: true, events: hub, tasks: { current: null, queue: [] }, bot: { inventory: { items: () => items } } };
    const c = create(ctx, { now: () => t, persist: false });
    const adv = () => c.state.advices;
    const push = (type, d) => { hub.push(type, d); c.onEvent(type, d); };
    return { c, ctx, items, evs, adv, push, time: ms => { t += ms; }, add: (name, count = 1) => items.push({ name, count, type: items.length + 1 }) };
  };
  const dig = (h, name, n) => { for (let i = 0; i < n; i++) { h.c.onDig({ name }); h.time(1000); } };

  // 1. hand_tool: 5 рубок без топора -> совет с материалами; с топором — нет
  let h = mk(); h.c.tick(); h.add('cobblestone', 4); h.add('stick', 2);
  dig(h, 'oak_log', 4); assert.strictEqual(h.c.tick(), null, '4 < 5');
  dig(h, 'oak_log', 1); h.time(61000); let a = h.c.tick();
  assert(a && a.rule === 'hand_tool' && /stone_axe/.test(a.msg) && /cobble 4/.test(a.msg) && /материалов хватает/.test(a.msg), a && a.msg);
  assert.strictEqual(h.adv().length, 1);
  const h2 = mk(); h2.add('stone_axe'); dig(h2, 'oak_log', 8); assert.strictEqual(h2.c.tick(), null, 'с топором — нет');
  const h3 = mk(); dig(h3, 'stone', 6); h3.time(61000); a = h3.c.tick();
  assert(a && /wooden_pickaxe/.test(a.msg) && /не хватает/.test(a.msg), a && a.msg);
  h3.time(4 * 60000); assert.strictEqual(h3.c.tick(), null, 'старые копания после совета не считаются');
  dig(h3, 'stone', 5); h3.time(61000); assert(h3.c.tick(), 'новые 5 -> снова');
  assert.strictEqual(h3.adv().length, 2);

  // 2. micro_cmds: 6 dig_at/place_at от brain за 3 мин (autopilot и collect не в счёт)
  h = mk(); for (let i = 0; i < 5; i++) h.push('task_started', { name: 'dig_at', source: 'brain' });
  h.push('task_started', { name: 'dig_at', source: 'autopilot' }); h.push('task_started', { name: 'collect', source: 'brain' });
  h.time(61000); assert.strictEqual(h.c.tick(), null, '5 brain + autopilot/collect не в счёт');
  h.push('task_started', { name: 'place_at', source: 'brain' }); h.time(61000); a = h.c.tick();
  assert(a && a.rule === 'micro_cmds' && /collect block=stone/.test(a.msg), a && a.msg);
  h = mk(); for (let i = 0; i < 6; i++) { h.push('task_started', { name: 'dig_at', source: 'brain' }); h.time(40000); }
  assert.strictEqual(h.c.tick(), null, 'окно 3 мин');

  // 3. repeat_fail: одна ошибка x3 (числа нормализуются), разные — нет
  h = mk(); h.push('task_failed', { name: 'collect', reason: 'не вижу coal_ore' }); h.push('task_failed', { name: 'collect', reason: 'не вижу iron_ore' }); h.push('task_failed', { name: 'collect', reason: 'не вижу coal_ore' });
  h.time(61000); assert.strictEqual(h.c.tick(), null, 'разные ошибки');
  h.push('task_failed', { name: 'collect', reason: 'не вижу coal_ore' }); h.time(61000); a = h.c.tick();
  assert(a && a.rule === 'repeat_fail' && /не вижу coal_ore/.test(a.msg) && /explore/.test(a.msg), a && a.msg);
  h = mk(); for (let i = 0; i < 3; i++) h.push('task_failed', { name: 'craft', reason: `не хватает ${i + 1} stick` }); h.time(61000); a = h.c.tick();
  assert(a && /recipes/.test(a.msg), a && a.msg);

  // 4. idle: >25% простоя — только в отчёте, мозг не будит
  h = mk(); for (let i = 0; i < 100; i++) { h.ctx.tasks.current = i % 2 ? { name: 'x' } : null; h.c.sample(); h.time(5000); }
  h.c.tick(); assert(h.c.state.idle10 >= 40 && h.c.state.idle10 <= 60, 'idle10=' + h.c.state.idle10);
  assert.strictEqual(h.adv().length, 0, 'idle не будит'); assert(/тело без дела: \d+%/.test(h.c.reportText()));

  // 5. stall: 30 мин без нового -> совет с тиром; новый предмет сбрасывает таймер
  h = mk(); h.add('oak_log', 4); h.c.pollProgress(); h.time(29 * 60000); assert.strictEqual(h.c.tick(), null, '29 мин рано');
  h.time(2 * 60000); a = h.c.tick(); assert(a && a.rule === 'stall' && /wooden_pickaxe/.test(a.msg), a && a.msg);
  h = mk(); h.add('oak_log', 4); h.c.pollProgress(); h.time(25 * 60000); h.add('stick', 2); h.c.pollProgress(); h.time(10 * 60000);
  assert.strictEqual(h.c.tick(), null, 'новый предмет сбросил таймер');
  h = mk(); h.add('stone_pickaxe'); h.c.pollProgress(); h.time(31 * 60000); a = h.c.tick(); assert(a && /iron_pickaxe/.test(a.msg) && /еды нет/.test(a.msg), a && a.msg);

  // 6. deaths: 2 по одной причине за час
  h = mk(); h.push('death', { cause: 'лава' }); h.push('death', { cause: 'падение' }); h.time(61000); assert.strictEqual(h.c.tick(), null);
  h.push('death', { cause: 'лава' }); h.time(61000); a = h.c.tick(); assert(a && a.rule === 'deaths' && /лава/.test(a.msg), a && a.msg);
  h.time(4 * 60000); assert.strictEqual(h.c.tick(), null, 'без новых смертей не повторять');

  // лимиты: 1 advice/мин всего и раз в 3 мин на правило; приоритет deaths > hand_tool
  h = mk(); h.push('death', { cause: 'zombie' }); h.push('death', { cause: 'zombie' }); dig(h, 'oak_log', 6); h.time(61000);
  a = h.c.tick(); assert.strictEqual(a.rule, 'deaths');
  assert.strictEqual(h.c.tick(), null, 'глобально не чаще раза в минуту');
  h.time(30000); assert.strictEqual(h.c.tick(), null, '30 с < 60 с');
  h.time(31000); a = h.c.tick(); assert(a && a.rule === 'hand_tool', 'через минуту — следующее правило');
  h.time(1); dig(h, 'oak_log', 5); h.time(61000); assert.strictEqual(h.c.tick(), null, 'правило раз в 3 мин');
  h.time(120000); assert(h.c.tick(), 'через 3 мин можно');
  assert(h.adv().every(e => e.msg && e.rule && e.count), 'формат записи совета');

  // «что чинить в теле»: >=3 советов по правилу за час
  h = mk(); for (let i = 0; i < 3; i++) { dig(h, 'oak_log', 5); h.time(4 * 60000); h.c.tick(); }
  const s = h.c.summary(); assert(s.fixBody.some(f => f.rule === 'hand_tool'), JSON.stringify(s.fixBody));
  assert(/Что чинить в теле/.test(h.c.reportText()) && /hand_tool/.test(h.c.reportText()));

  // персистентность: critic.json и critic_report.md
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'critic-'));
  const t = Date.now(); const ctx = { ready: true, events: { push() {} }, tasks: {}, bot: { inventory: { items: () => [] } } };
  const c = create(ctx, { now: () => t, dir }); c.onDig({ name: 'oak_log' }); c.tick();
  assert(fs.existsSync(path.join(dir, 'critic.json')) && /Отчёт критика/.test(fs.readFileSync(path.join(dir, 'critic_report.md'), 'utf8')));
  assert.strictEqual(create(ctx, { now: () => t, dir }).state.digs.length, 1, 'загрузка состояния');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('critic: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
