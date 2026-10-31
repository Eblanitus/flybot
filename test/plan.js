// Офлайн-проверка v0.3 шага 3: очередь «## План» в brain/notes.md (behavior/plan.js) и её встраивание в автопилот
// (refreshGoal: «Постройка:» из «Текущей цели» → очередь → «Автопилот:»; итоги пунктов; статус в snapshot). Бот не нужен.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AP = require('../behavior/autopilot');
const PL = require('../behavior/plan');
const T = require('../behavior/thresholds');
const { decide, buildState, buildStatus, goalState } = AP;
const { parsePlan, planPick, planStatus, planList, loadPlan, savePlan, emptyPlan, mark } = PL;

const H = 3600000, MIN = 60000;

module.exports = async () => {
  // ---------- parsePlan ----------
  const notes = [
    '# x', '## Текущая цель', 'Постройка: stair_down_1 -427 42 25 rot=0', 'Автопилот: collect block=stone count=60', '',
    '## План',
    'это пояснение — не пункт',
    '- [ ] stair_down_2 -415 50 21 rot=0 | пролёт 2',
    '- [ ] Автопилот: farm_plot x=-388 y=67 z=40 size=5',
    '- [x] base_pad -393 67 36 rot=0',
    '* [-] hut_west -400 67 30 rot=90 | пропуск',
    '- [X] **Постройка:** `fence_line x=1 y=2 z=3`',
    '- [ ] hut_west 1 2',
    '- [ ] Автопилот: 12 бред',
    '- [ ]',
    '- [ ] column_down 5 6 7 rot=45',
    '## Проект', '- [ ] 1.4 Шахта: stair_down_9 0 0 0', ''
  ].join('\n');
  const p = parsePlan(notes);
  assert.strictEqual(p.found, true);
  assert.strictEqual(p.items.length, 9, 'только пункты раздела «## План», до следующего «## »: ' + p.items.map(i => i.raw).join(' / '));
  const [a, b, c, d, f, bad1, bad2, bad3, bad4] = p.items;
  assert(a.kind === 'build' && a.mark === ' ' && a.build.name === 'stair_down_2' && a.build.x === -415 && a.build.y === 50 && a.build.z === 21 && a.build.rot === 0, JSON.stringify(a));
  assert.strictEqual(a.comment, 'пролёт 2', 'комментарий после « | »');
  assert.strictEqual(a.sig, 'stair_down_2 -415 50 21 0');
  assert(b.kind === 'goal' && b.goal.name === 'farm_plot' && b.goal.params.x === -388 && b.goal.params.size === 5 && b.mark === ' ', JSON.stringify(b));
  assert(c.mark === 'x' && c.kind === 'build' && c.build.name === 'base_pad', '[x]');
  assert(d.mark === '-' && d.build.rot === 90 && d.comment === 'пропуск', '[-] + «*» как маркер');
  assert(f.mark === 'x' && f.build.name === 'fence_line' && f.build.x === 1, '[X], **Постройка:** и `код`');
  assert(bad1.bad && /чертёж/.test(bad1.reason) && bad1.sig.startsWith('bad:'), 'не хватает числа: ' + JSON.stringify(bad1));
  assert(bad2.bad && /Автопилот/.test(bad2.reason), 'навык не имя');
  assert(bad3.bad && /пустая/.test(bad3.reason), 'пустая строка');
  assert(bad4.bad, 'rot=45 нельзя');
  assert.deepStrictEqual(parsePlan('## План\n'), { found: true, items: [] }, 'пустая секция = пустая очередь');
  assert.deepStrictEqual(parsePlan('## Проект\n- [ ] hut_west 1 2 3\n'), { found: false, items: [] }, 'раздела нет');
  assert.strictEqual(parsePlan('## Планы\n- [ ] hut_west 1 2 3\n').found, false, '«## Планы» — не «## План»');
  assert.strictEqual(parsePlan('## Планирование\n- [ ] hut_west 1 2 3\n').found, false);
  assert.strictEqual(parsePlan('## План (очередь)\r\n- [ ] hut_west 1 2 3 | с CRLF\r\n').items[0].comment, 'с CRLF', 'CRLF и подпись в заголовке');
  assert.strictEqual(parsePlan('## План\n- [ ] hut_west 1 2 3 |без пробела\n').items[0].comment, '', 'без пробелов «|» — не комментарий');
  assert.strictEqual(parsePlan('').found, false);
  console.log('parsePlan: OK');

  // ---------- planPick: порядок ----------
  const items = parsePlan('## План\n- [ ] one 1 2 3\n- [ ] Автопилот: collect block=stone count=4\n- [x] two 4 5 6\n- [-] three 7 8 9\n- [ ] four 10 11 12\n').items;
  const [it1, it2, , , it4] = items;
  const own = { name: 'own', x: 0, y: 64, z: 0, rot: 0, sig: 'own 0 64 0 0' };
  const goal = { name: 'explore', params: {}, sig: 'explore {}' };
  const now = 1e12;
  let st = emptyPlan();
  const pick = o => planPick({ own: null, goal: null, items, state: st, now, brainOn: false, ...o });
  let r = pick({ own });
  assert(r.via === 'build' && r.build === own, '1) своя «Постройка:» главнее очереди');
  r = pick({});
  assert(r.via === 'plan' && r.item === it1 && r.build.name === 'one', '2) первый `[ ]`: ' + JSON.stringify(r.via));
  mark(st, it1.sig, 'done', '', now - 1000, 0);
  r = pick({ goal });
  assert(r.via === 'plan' && r.item === it2 && r.goal.name === 'collect', 'one готов (память) — следующий, «Автопилот:» очереди главнее «Автопилот:» цели');
  mark(st, it2.sig, 'done', '', now, 0);
  r = pick({});
  assert(r.item === it4, '[x] и [-] пропущены, готовые по памяти — тоже');
  mark(st, it4.sig, 'done', '', now, 0);
  r = pick({ goal });
  assert(r.via === 'goal' && r.goal === goal && !r.item, '3) очередь пуста — «Автопилот:» как раньше');
  assert.strictEqual(pick({}).via, null, 'ничего нет');
  r = pick({ own, goal });
  assert.strictEqual(r.via, 'build', 'своя «Постройка:» ещё не готова');
  mark(st, own.sig, 'done', '', now, 0);
  assert.strictEqual(pick({ own, goal }).via, 'goal', 'своя готова (память) — очередь пуста — цель');
  console.log('planPick порядок: OK');

  // ---------- planPick: провал, повтор, пропуск ----------
  st = emptyPlan();
  mark(st, it1.sig, 'failed', 'не дошла', now - 2 * H, 3);
  r = pick({});
  assert.strictEqual(r.item, it2, 'проваленный (<6 ч) — следующий');
  mark(st, it1.sig, 'failed', 'x', now - 10 * MIN, 3); mark(st, it2.sig, 'failed', 'x', now - 10 * MIN, 3); mark(st, it4.sig, 'failed', 'x', now - 10 * MIN, 3);
  r = pick({ goal });
  assert.strictEqual(r.via, 'goal', 'открытых нет, но провалились только что (<planRetryIdleMs) — не долбим: цель');
  mark(st, it4.sig, 'failed', 'x', now - T.planRetryIdleMs - 1, 3);
  r = pick({ goal });
  assert(r.via === 'plan' && r.item === it4 && r.retry === true, 'открытых нет — повтор проваленного старше planRetryIdleMs: ' + r.via);
  mark(st, it2.sig, 'failed', 'x', now - T.planRetryMs - 1, 3);
  r = pick({});
  assert(r.item === it2 && r.retry === true, 'через 6 ч повтор в свой черёд (раньше it4)');
  // своя «Постройка:»: провалена — очередь; открытых нет и давно — повтор
  st = emptyPlan(); mark(st, own.sig, 'failed', 'пауза', now - MIN, 3);
  assert.strictEqual(pick({ own }).item, it1, 'своя провалена — берём из очереди');
  for (const i of items) mark(st, i.sig, 'done', '', now, 0);
  assert.strictEqual(pick({ own, goal }).via, 'goal', 'провал свежий — цель');
  mark(st, own.sig, 'failed', 'пауза', now - T.planRetryIdleMs - 1, 3);
  r = pick({ own, goal });
  assert(r.via === 'build' && r.retry === true, 'открытых нет — повтор своей проваленной');
  // пропуск: битые строки и veto
  st = emptyPlan();
  const mixed = parsePlan('## План\n- [ ] hut_west 1 2\n- [ ] nobp 1 2 3\n- [ ] Автопилот: nosuch a=1\n- [ ] okay 4 5 6\n').items;
  r = planPick({ own: null, goal: null, items: mixed, state: st, now, brainOn: false,
    veto: i => i.kind === 'build' && i.build.name === 'nobp' ? { reason: 'нет чертежа' } : i.kind === 'goal' ? { reason: 'неизвестный навык' } : null });
  assert(r.item.build.name === 'okay', 'битая/без чертежа/без навыка пропущены');
  assert.deepStrictEqual(r.skipped.map(s => s.reason), ['не разобрать «чертёж x y z [rot=…]»', 'нет чертежа', 'неизвестный навык']);
  console.log('planPick провал/пропуск: OK');

  // ---------- planPick: мозг ----------
  st = emptyPlan(); st.doneAt = now - MIN / 2;
  r = pick({ brainOn: true, goal });
  assert(r.via === 'goal' && r.waitMs > T.planBrainWaitMs - MIN && r.waitMs <= T.planBrainWaitMs, 'мозг включён: после build_done ждём его «Постройку»: ' + r.waitMs);
  r = pick({ brainOn: true, goal, own });
  assert.strictEqual(r.via, 'build', 'новая «Постройка:» мозга — главнее');
  r = pick({ brainOn: false, goal });
  assert.strictEqual(r.item, it1, 'мозг выключен — берём сразу');
  st.doneAt = now - T.planBrainWaitMs - 1;
  r = pick({ brainOn: true, goal });
  assert.strictEqual(r.item, it1, 'ожидание planBrainWaitMs прошло — из очереди');
  st.doneAt = 0;
  assert.strictEqual(pick({ brainOn: true }).item, it1, 'не было build_done — не ждём');
  console.log('planPick мозг: OK');

  // ---------- planList: пропавшая секция ----------
  st = emptyPlan();
  let pl = planList(notes, st);
  assert(!pl.copy && pl.changed && pl.items.length === 9 && pl.list.length === 9);
  st.list = pl.list;
  pl = planList(notes, st);
  assert(!pl.changed, 'копия совпала — писать не надо');
  pl = planList('## Текущая цель\nПостройка: x 1 2 3\n## Проект\n', st);
  assert(pl.copy && pl.items.length === 9 && pl.items[0].build.name === 'stair_down_2', 'секции нет — последняя копия');
  pl = planList('## План\n## Проект\n', st);
  assert(!pl.copy && pl.items.length === 0 && pl.changed, 'секция пуста — очередь пуста (копия обновится)');
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyplan-'));
  try {
    const sfile = path.join(sdir, 'sub', 'autopilot_plan.json');
    mark(st, 'sig1', 'failed', 'причина', 5, 3); st.doneAt = 77;
    assert(savePlan(sfile, st));
    const back = loadPlan(sfile);
    assert.deepStrictEqual(back.items.sig1, { status: 'failed', at: 5, reason: 'причина', pauses: 3 });
    assert.strictEqual(back.doneAt, 77); assert.deepStrictEqual(back.list, st.list);
    fs.writeFileSync(sfile, '{мусор');
    assert.deepStrictEqual(loadPlan(sfile), emptyPlan(), 'мусор в файле — пустая память');
    assert.deepStrictEqual(loadPlan(path.join(sdir, 'нет.json')), emptyPlan());
  } finally { fs.rmSync(sdir, { recursive: true, force: true }); }
  console.log('planList / память: OK');

  // ---------- planStatus ----------
  st = emptyPlan(); mark(st, it4.sig, 'failed', 'не дошла', now, 3);
  const s1 = planStatus({ items, state: st, now, pick: planPick({ own: null, goal: null, items, state: st, now, brainOn: false }), copy: true });
  assert.strictEqual(s1.total, 5); assert.strictEqual(s1.done, 1); assert.strictEqual(s1.skipped, 1); assert.strictEqual(s1.failed, 1); assert.strictEqual(s1.open, 2);
  assert(/one/.test(s1.now) && /копия/.test(s1.source) && /four.*не дошла/.test(s1.failedItems[0]), JSON.stringify(s1));
  console.log('planStatus: OK');

  // ---------- встраивание: refreshGoal / decide / итоги ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyplan-ap-'));
  try {
    const bp = path.join(dir, 'bp'); fs.mkdirSync(bp);
    for (const n of ['stair_down_1', 'stair_down_2', 'base_pad', 'hut_west', 'fence_line']) fs.writeFileSync(path.join(bp, n + '.txt'), '# x\n');
    const notesFile = path.join(dir, 'notes.md'), planFile = path.join(dir, 'autopilot_plan.json');
    const events = [];
    const ctx = { events: { push: (type, data) => events.push({ type, ...data }) }, tasks: { current: null, history: [], queue: [] }, lastProgressAt: 0, skillNames: ['collect', 'goto'] };
    const mk = () => {
      const ap = AP.create(ctx);
      Object.assign(ap, { notesFile, bpDir: bp, planFile, switchesDir: dir, skillKnown: ['farm_plot'] });
      ap.goSafeT = ap.goalSkills.t = Date.now() + 1e9; // исполнитель (:3200) в тесте не опрашиваем
      return ap;
    };
    const setBrain = (ap, on) => { fs.writeFileSync(path.join(dir, 'switches.json'), JSON.stringify({ brain: on })); ap.brainT = 0; };
    const setNotes = (ap, txt) => { fs.writeFileSync(notesFile, txt); ap.goalMtime = -1; };
    const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
      blocks: 20, logs: 8, cobble: 30, phase: 'день', isNight: false, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
      freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
    const act = (ap, extra) => decide({ ...base, ...goalState(ap, Date.now()), ...buildState(ap, Date.now()), buildDist: 3, ...extra });
    const run = async (ap, a, res) => { ctx.runSkill = async () => res; ap._start({ ...a }); await ap.running.promise; };
    const OKB = { ok: true, result: { ok: true, matched: 40, total: 40 } };
    const FAILB = { ok: false, error: 'не достроено: 2 из 40 клеток; например (1 2 3) stone: бот стоит на месте установки', result: { missing: {} } };
    const notesTxt = extra => [
      '## Текущая цель', 'Шаг: x', ...(extra.own ? ['Постройка: ' + extra.own] : []), ...(extra.goal ? ['Автопилот: ' + extra.goal] : []), 'База: -393 67 36',
      ...(extra.plan === false ? [] : ['## План', ...extra.plan]), '## Проект', '- [ ] 1.4 Шахта: stair_down_9 0 0 0', ''
    ].join('\n');
    const PLAN = ['- [ ] stair_down_2 -415 50 21 rot=0 | пролёт 2', '- [ ] Автопилот: collect block=stone count=8', '- [ ] nobp 1 2 3', '- [ ] Автопилот: nosuch a=1',
      '- [ ] hut_west 1 2', '- [x] base_pad -393 67 36 rot=0', '- [ ] fence_line 9 9 9'];

    // 1) своя «Постройка:» главнее очереди; мозг выключен
    let ap = mk(); setBrain(ap, false);
    setNotes(ap, notesTxt({ own: 'stair_down_1 -427 42 25 rot=0', goal: 'collect block=dirt count=1', plan: PLAN }));
    await ap.refreshGoal();
    assert(ap.build && ap.build.name === 'stair_down_1' && !ap.buildHold, 'своя «Постройка:» в работе');
    assert.strictEqual(act(ap).key, 'build');
    assert.strictEqual(ap.status().plan.open, 5, 'в очереди 5 открытых: ' + JSON.stringify(ap.status().plan));
    // своя достроена -> build_done (без plan_item_done: её нет в очереди) -> берём первый пункт очереди
    await run(ap, act(ap), OKB);
    assert.strictEqual(events.filter(e => e.type === 'build_done').length, 1);
    assert(!events.some(e => e.type === 'plan_item_done'), 'своя «Постройка:» — не пункт очереди');
    assert.strictEqual(ap.planState.items['stair_down_1 -427 42 25 0'].status, 'done');
    assert(ap.planState.doneAt > 0 && ap.goalMtime === -1, 'время build_done и сброс кэша notes.md');
    await ap.refreshGoal();
    assert(ap.build.name === 'stair_down_2' && ap.buildSt.sig === ap.build.sig && !ap.buildHold, 'очередь: stair_down_2');
    assert.strictEqual(act(ap).key, 'build', 'decide строит пункт очереди');
    assert.strictEqual(ap.status().plan.now, 'stair_down_2 -415 50 21');
    assert.strictEqual(buildStatus(ap, Date.now()).status, 'строю (сейчас другое дело)');
    console.log('встраивание: своя «Постройка:» и очередь OK');

    // 2) пункт очереди провален 3 паузами подряд -> failed, следующий пункт «Автопилот: collect»
    for (let i = 1; i < T.planFailPauses; i++) {
      await run(ap, act(ap), FAILB);
      assert(ap.buildSt.pauses === i && !ap.planState.items[ap.build.sig], `пауза ${i}: ещё не провал`);
      ap.buildSt.pauseUntil = 0;
    }
    await run(ap, act(ap), FAILB);
    const fsig = 'stair_down_2 -415 50 21 0';
    assert(ap.planState.items[fsig].status === 'failed' && /бот стоит|провал/.test(ap.planState.items[fsig].reason), JSON.stringify(ap.planState.items[fsig]));
    assert(!events.some(e => e.type === 'plan_item_done' && /stair_down_2/.test(e.item)), 'провал — не done');
    await ap.refreshGoal();
    assert(ap.buildHold, 'следующий пункт — не стройка (своя «Постройка:» осталась только для показа)');
    assert(ap.goal && ap.goal.name === 'collect' && ap.goal.params.count === 8 && ap.goal.kind === 'body', 'очередь: «Автопилот: collect»: ' + JSON.stringify(ap.goal));
    assert.strictEqual(act(ap).key, 'goal');
    const infoMsgs = events.filter(e => e.type === 'info').map(e => e.msg).join('\n');
    assert(/не вышло 3 раза/.test(infoMsgs), 'причина провала — в журнале: ' + infoMsgs);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')).items[fsig].status, 'failed', 'память записана в файл');
    console.log('встраивание: провал пункта OK');

    // 3) «Автопилот:» из очереди: ok -> done + plan_item_done; пропуски нет чертежа / неизвестный навык / битая — с причиной
    await run(ap, act(ap), { ok: true, result: { ok: true } });
    const done = events.filter(e => e.type === 'plan_item_done');
    assert(done.length === 1 && /collect/.test(done[0].item) && done[0].kind === 'goal', JSON.stringify(done));
    assert.strictEqual(ap.planState.items[ap.goal.sig].status, 'done');
    assert.strictEqual(ap.goalMtime, -1, 'кэш notes.md сброшен');
    await ap.refreshGoal();
    assert(ap.build && ap.build.name === 'fence_line', 'пропущены nobp (нет чертежа), nosuch (нет навыка), hut_west 1 2 (битая), [x]: ' + (ap.build && ap.build.name));
    const msgs = events.filter(e => e.type === 'info').map(e => e.msg).join('\n');
    assert(/пропускаю «nobp 1 2 3» — нет чертежа nobp/.test(msgs), msgs);
    assert(/пропускаю «Автопилот: nosuch» — неизвестный навык nosuch/.test(msgs), msgs);
    assert(/пропускаю «hut_west 1 2» — не разобрать/.test(msgs), msgs);
    await ap.refreshGoal(); await ap.refreshGoal();
    assert.strictEqual(events.filter(e => e.type === 'info' && /пропускаю/.test(e.msg)).length, 3, 'причина пропуска пишется один раз');
    // пункт-постройка готов -> plan_item_done + build_done
    await run(ap, act(ap), OKB);
    assert(events.some(e => e.type === 'plan_item_done' && /fence_line/.test(e.item) && e.kind === 'build'), 'plan_item_done для постройки');
    assert.strictEqual(events.filter(e => e.type === 'build_done').length, 2);
    await ap.refreshGoal();
    assert(!ap.build || ap.buildHold, 'очередь кончилась');
    assert(ap.goal && ap.goal.name === 'collect' && ap.goal.params.count === 1, 'открытых нет — «Автопилот:» из «Текущей цели»: ' + JSON.stringify(ap.goal));
    const stt = ap.status().plan;
    assert(stt.open === 0 && stt.failed === 1 && stt.done === 3, JSON.stringify(stt));
    assert.strictEqual(ap.status().build.status, 'готово', 'закрытая «Постройка:» из notes — в статусе «готово», в выбор не идёт');
    assert.notStrictEqual(act(ap).key, 'build');
    console.log('встраивание: «Автопилот:», пропуски, конец очереди OK');

    // 4) рестарт тела: память пунктов из файла; секция «## План» пропала (мозг переписал файл) — копия
    const ap2 = mk(); setBrain(ap2, false);
    ap2.planState = loadPlan(planFile);
    assert.strictEqual(ap2.planState.items[fsig].status, 'failed');
    setNotes(ap2, notesTxt({ own: 'stair_down_1 -427 42 25 rot=0', plan: false }));
    await ap2.refreshGoal();
    assert(ap2.planCopy && ap2.planItems.length === PLAN.length, 'секции нет — работаем по копии из файла');
    assert(ap2.build === null || ap2.buildHold, 'своя готова (память), в очереди всё закрыто');
    assert(/копия/.test(ap2.status().plan.source));
    // пустая секция — пустая очередь, копия не используется
    setNotes(ap2, notesTxt({ plan: [] }));
    await ap2.refreshGoal();
    assert(!ap2.planCopy && ap2.planItems.length === 0 && ap2.status().plan.total === 0);
    // секция вернулась с новым пунктом — берём его, а state не мешает
    setNotes(ap2, notesTxt({ plan: ['- [ ] base_pad -393 67 36 rot=0', '- [ ] hut_west -400 67 30 rot=90 | новая'] }));
    await ap2.refreshGoal();
    assert.strictEqual(ap2.build.name, 'base_pad', 'base_pad: в старой копии он был [x], а память о нём не стоит — открыт');
    console.log('встраивание: рестарт и пропавшая секция OK');

    // 5) мозг включён: после build_done ждёт planBrainWaitMs (2 мин); выключен — берёт сразу; повтор проваленного через 6 ч
    const ap3 = mk(); setBrain(ap3, true);
    setNotes(ap3, notesTxt({ goal: 'collect block=dirt count=1', plan: ['- [ ] hut_west -400 67 30 rot=90', '- [ ] fence_line 9 9 9'] }));
    ap3.planState = emptyPlan();
    ap3.planState.doneAt = Date.now() - MIN / 2;
    await ap3.refreshGoal();
    assert(!ap3.build && ap3.goal && ap3.goal.name === 'collect', 'мозг включён, build_done только что — ждём, пока работает «Автопилот:» цели');
    assert(ap3.status().plan.brainWaitSec > 0, 'в статусе: ждём мозг');
    ap3.planState.doneAt = Date.now() - T.planBrainWaitMs - 1000;
    await ap3.refreshGoal();
    assert.strictEqual(ap3.build.name, 'hut_west', 'ожидание мозга прошло — очередь');
    setBrain(ap3, false); ap3.planState.doneAt = Date.now(); ap3.build = null;
    await ap3.refreshGoal();
    assert.strictEqual(ap3.build.name, 'hut_west', 'мозг выключен — без ожидания');
    // повтор через 6 ч: чистый лист (buildSt заново, память о провале стёрта)
    const sg = ap3.build.sig;
    ap3.buildSt.pauses = 3; ap3.buildSt.pauseUntil = Date.now() + 1e6;
    PL.mark(ap3.planState, sg, 'failed', 'x', Date.now() - T.planRetryMs - 1000, 3);
    await ap3.refreshGoal();
    assert(ap3.build.name === 'hut_west' && ap3.buildSt.pauses === 0 && ap3.buildSt.pauseUntil === 0 && !ap3.planState.items[sg], 'повтор через 6 ч с чистого листа');
    console.log('встраивание: мозг вкл/выкл, повтор OK');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
if (require.main === module) module.exports().then(() => console.log('plan: OK')).catch(e => { console.error(e); process.exit(1); });
