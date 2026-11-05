// Офлайн-проверка срочного выбора (этап 2, шаг Б7): враг-игрок рядом и моб рядом во время работы — бой или побег выбирает решатель.
'use strict';
const assert = require('assert');
const AP = require('../behavior/autopilot');
const D = require('../hardcore/decider');

const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
  blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
  freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
const enemy = { name: 'HC_2', d: 8, aggressor: true, why: 'рядом' };

// 1) игрок рядом, оружие, HP в норме, один — решатель получает [бой, побег]; прежнее правило — бой
process.env.HC_STAGE2 = '1';
{
  const out = {};
  const act = AP.decide({ ...base, enemies: [enemy] }, out);
  assert(out.urgent && out.urgent.length === 2, JSON.stringify(out.urgent && out.urgent.map(a => a.key)));
  assert.deepStrictEqual(out.urgent.map(a => a.key), ['fight_player', 'escape_player']);
  assert.strictEqual(act.key, 'fight_player');
  console.log('игрок рядом с оружием: [бой, побег], по умолчанию бой: OK');
}

// 2) без оружия — порядок [побег, бой]
{
  const out = {};
  const act = AP.decide({ ...base, hasWeapon: false, enemies: [enemy] }, out);
  assert.deepStrictEqual(out.urgent.map(a => a.key), ['escape_player', 'fight_player']);
  assert.strictEqual(act.key, 'escape_player');
  console.log('без оружия: [побег, бой]: OK');
}

// 3) urgentPick: без памяти — прежнее правило (первый в списке)
{
  const list = [{ key: 'fight_player', why: 'бой' }, { key: 'escape_player', why: 'побег' }];
  assert.strictEqual(D.urgentPick(list, {}, { rate: 0 }).key, 'fight_player');
  // по опыту побег лучше боя — выбирает побег
  const st = { escape_player: { n: 10, sum: 50 }, fight_player: { n: 10, sum: 10 } };
  assert.strictEqual(D.urgentPick(list, st, { rate: 0 }).key, 'escape_player');
  // проба новичка: побег ещё не пробовали, бой — 10 раз — rnd 0, rate 1 — пробуем побег, explore true
  const ch = D.urgentPick(list, { fight_player: { n: 10, sum: 30 } }, { rate: 1, rnd: () => 0 });
  assert.strictEqual(ch.key, 'escape_player'); assert.strictEqual(ch.explore, true);
  console.log('urgentPick: прежнее правило, опыт, проба: OK');
}

// 4) через choose: срочное выбирается с общей таблицей (память из HC_DECIDER_MEM не нужна — пустая)
{
  D._reset();
  delete process.env.HC_DECIDER_MEM;
  process.env.HC_EXPLORE = '0';
  const out = {};
  const act = AP.decide({ ...base, enemies: [enemy] }, out);
  const fakeCtx = { bot: { entity: { position: {} }, blockAt: () => ({ biome: { name: 'plains' } }) } };
  const ch = D.choose(fakeCtx, { ...base, enemies: [enemy] }, act, out);
  assert.strictEqual(ch.key, 'fight_player');
  console.log('choose срочного: OK');
}

// 5) моб рядом во время работы: бой (с оружием и HP) или отход; укрытие — если побег от такого уже не удался
{
  const mob = { name: 'zombie', d: 4 };
  // идёт сбор брёвен (work-ключ), зомби в 4 м: срочный список — бой (с оружием), укрытие при неудавшемся побеге, отход
  const work = { ...base, hostile: mob, hostilesNear: 1, running: { key: 'collect_log', kind: 'body', name: 'collect', started: 0 } };
  const out = {};
  const act = AP.decide(work, out);
  assert(out.urgent && out.urgent.length >= 1, 'моб рядом во время работы: срочный список (ответ: ' + (act && act.key) + ')');
  assert(out.urgent.every(a => /^safety_/.test(a.key)), JSON.stringify(out.urgent.map(a => a.key)));
  assert.strictEqual(out.urgent[0].key, 'safety_fight', 'с оружием и HP — бой первым: ' + JSON.stringify(out.urgent.map(a => a.key)));
  assert.strictEqual(act.key, out.urgent[0].key);
  console.log('моб рядом во время работы: срочный список safety_*, бой первым: OK');
}

// 5б) критическое HP без еды из укрытия: ни побег, ни бой (как было) — списка нет, из укрытия не выходим
{
  process.env.HC_STAGE2 = '1';
  const crit = { ...base, hp: 3, food: 0, hasFood: false, sheltered: true, enemies: [enemy] };
  const out = {};
  const act = AP.decide(crit, out);
  assert(out.urgent === undefined, 'из укрытия при критическом HP срочного списка нет: ' + JSON.stringify(out.urgent && out.urgent.map(a => a.key)));
  assert(!act || !/^(fight_player|escape_player)$/.test(act.key), 'из укрытия при критическом HP не выходим: ' + (act && act.key));
  delete process.env.HC_STAGE2;
  const old = AP.decide(crit, {});
  assert.strictEqual(act ? act.key : null, old ? old.key : null, 'как было без этапа 2: ' + (old && old.key));
  console.log('критическое HP из укрытия: не выходим, как было: OK');
}
// 5в) тот же случай, но старое правило даёт бой (HP 14, оценка «победим») — бой остаётся, побега из укрытия нет
{
  process.env.HC_STAGE2 = '1';
  const st = { ...base, hp: 14, food: 0, hasFood: false, sheltered: true, outlook: { hitsToDie: 1, win: true }, enemies: [enemy] };
  const out = {};
  const act = AP.decide(st, out);
  assert.deepStrictEqual(out.urgent && out.urgent.map(a => a.key), ['fight_player']);
  assert.strictEqual(act.key, 'fight_player');
  delete process.env.HC_STAGE2;
  console.log('из укрытия при критическом HP, бой по старому правилу: только бой: OK');
}
// 5г) крипер рядом во время работы: бой и укрытие не предлагаем (крипер не преследует по правилам боя), только отход
{
  process.env.HC_STAGE2 = '1';
  const creep = { name: 'creeper', d: 4 };
  const st = { ...base, hostile: creep, hostilesNear: 1, running: { key: 'collect_log', kind: 'body', name: 'collect', started: 0 } };
  const out = {};
  AP.decide(st, out);
  assert.deepStrictEqual(out.urgent && out.urgent.map(a => a.key), ['safety_escape'], JSON.stringify(out.urgent && out.urgent.map(a => a.key)));
  delete process.env.HC_STAGE2;
  console.log('крипер во время работы: только отход: OK');
}
// 5д) без оружия, побег от этого моба уже не оторвал (escapeFailed), не в укрытии: сразу укрытие, потом отход
{
  process.env.HC_STAGE2 = '1';
  const mob = { name: 'zombie', d: 4 };
  const st = { ...base, hasWeapon: false, hostile: mob, hostilesNear: 1, escapeFailed: { zombie: true }, running: { key: 'collect_log', kind: 'body', name: 'collect', started: 0 } };
  const out = {};
  const act = AP.decide(st, out);
  assert.deepStrictEqual(out.urgent && out.urgent.map(a => a.key), ['safety_shelter', 'safety_escape'], JSON.stringify(out.urgent && out.urgent.map(a => a.key)));
  assert.strictEqual(act.key, 'safety_shelter');
  delete process.env.HC_STAGE2;
  console.log('без оружия, побег не удался: укрытие, потом отход: OK');
}

// 6) без этапа 2 — ничего срочного: out.urgent не появляется
delete process.env.HC_STAGE2;
{
  const out = {};
  AP.decide({ ...base, enemies: [enemy] }, out);
  assert(out.urgent === undefined, 'без HC_STAGE2 срочного нет');
  console.log('без HC_STAGE2 — как было: OK');
}

console.log('hardcore_urgent: OK');
