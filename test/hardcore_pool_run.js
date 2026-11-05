// Офлайн-проверка навыка пула как дела решателя (этап 2, шаг Б8): pool_run запускает один навык по id; poolOptions — кандидаты решателя.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shim = require('../hardcore/pool/shim');
const CATALOG = require('../hardcore/pool/catalog.json');
const D = require('../hardcore/decider');
const G = require('../hardcore/pool/gate');
const SURVEY = require('../lib/survey');   // подменяем на время проверки: бревно рядом (вид мухи для решателя)
const { fakeBody, RICH } = require('./hardcore_pool.js');
const POOL_RUN = require('../brain/learned/pool_run.js');
const LOG_IDS = ['v1.mineWoodLog', 'v3.mineWoodLog', 'v2.chopSpruceLogs', 'v3.craftWoodenPickaxe'];   // навыки дела wood с нуждой в бревне: без бревна рядом и в сумке не предлагаем (05.11)

delete process.env.HC_BR_PREFIX; // охоты в этом тесте нет
const fakeCtx = (inv = []) => ({ bot: { food: 20, entity: { position: {} }, blockAt: () => ({ biome: { name: 'plains' } }),
  inventory: { items: () => inv, slots: [] } } });
const calm = { isNight: false, sheltered: false, underground: false, hp: 20, hostilesNear: 0, enemies: [], blocked: {} };

(async () => {
  // 1) pool_run с известным id: тот же итог, что у runForeign на таком же поддельном теле
  assert.strictEqual(POOL_RUN.name, 'pool_run');
  const entry = CATALOG.wood.find(e => e.id === 'v1.mineWoodLog');
  assert(entry, 'в каталоге дела wood есть v1.mineWoodLog');
  const r1 = await POOL_RUN.run(fakeBody(RICH).api, { id: 'v1.mineWoodLog', delo: 'wood', max_sec: 3 });
  const r2 = await shim.runForeign(fakeBody(RICH).api, entry, { maxSec: 3 });
  assert.strictEqual(r1.ok, r2.ok, JSON.stringify(r1));
  assert.deepStrictEqual(r1.gained || {}, r2.gained || {});
  assert.strictEqual(r1.ok, true, 'на поддельном теле навык дерева даёт бревно: ' + (r1.error || ''));
  console.log(`pool_run ${entry.id}: как runForeign, ok: OK`);

  // 2) нет такого id в деле — ok:false и понятная причина
  const bad = await POOL_RUN.run(fakeBody(RICH).api, { id: 'нет_такого', delo: 'wood' });
  assert.strictEqual(bad.ok, false);
  assert(/в пуле нет/.test(bad.error), bad.error);
  console.log('pool_run: нет такого id — ok:false: OK');

  // 3) poolOptions: с HC_POOL и пустой сумкой — дело wood: все чужие навыки дела, подсказка 0, act — pool_run
  process.env.HC_POOL = '1';
  D._reset();
  const opts = D.poolOptions(fakeCtx(), calm);
  // без брёвна рядом навыки, которым нужно бревно, не предлагаем; остальные навыки дела — как были
  assert(LOG_IDS.every(id => G.NEED[id]), 'навыки с брёвнами в таблице цели');
  // крафт из дерева тоже ждёт материала (разбор 2-го мира этапа 2): в пустой сумке — только навыки без цели в таблице
  const WOOD_CRAFT = ['v3.craftWoodenSword', 'v2.craftWoodenPickaxe', 'o.equipPickaxeOrCraftOne', 'o.equipSwordOrCraftOne', 'o.equipAxeOrCraftOne'];
  assert.deepStrictEqual(opts.map(o => o.act.params.id).sort(), CATALOG.wood.map(e => e.id).filter(id => !LOG_IDS.includes(id) && !WOOD_CRAFT.includes(id)).sort(), 'навыки дела wood без брёвна рядом и без дерева в сумке');
  assert(opts.some(o => o.act.params.id === 'v1.craftOakPlanksAndSticks'));
  assert(!opts.some(o => LOG_IDS.includes(o.act.params.id)));
  assert(opts.every(o => o.prior === 0 && o.key.startsWith('pool:') && o.act.kind === 'learned' && o.act.name === 'pool_run' && o.act.params.delo === 'wood'));

  // 4) заблокированный навык не предлагаем
  const blk = D.poolOptions(fakeCtx(), { ...calm, blocked: { 'pool:v1.craftOakPlanksAndSticks': true } });
  assert.strictEqual(blk.length, opts.length - 1);
  assert(!blk.some(o => o.key === 'pool:v1.craftOakPlanksAndSticks'));
  console.log('poolOptions: дело wood, подсказка 0, заблокированный — не предлагаем: OK');

  // 5) без HC_POOL пула в списке нет вовсе
  delete process.env.HC_POOL;
  assert.deepStrictEqual(D.poolOptions(fakeCtx(), calm), []);
  console.log('без HC_POOL — пула нет: OK');

  // 6) choose: опыт выбирает навык пула, если в этой обстановке он лучше дел автопилота (пробы выключены — HC_EXPLORE=0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpool-'));
  const mem = path.join(dir, 'decider.json');
  // обстановка: день, открытое место, HP высокий, без кирки, врагов нет, равнина — грубый ключ day|none|none
  fs.writeFileSync(mem, JSON.stringify({ exact: {}, coarse: { 'day|none|none': { 'pool:v1.mineWoodLog': { n: 10, sum: 500 } } } }));
  process.env.HC_DECIDER_MEM = mem; process.env.HC_EXPLORE = '0'; process.env.HC_POOL = '1';
  D._reset();
  const cand = { key: 'day_routine', kind: 'learned', name: 'day_routine', params: {}, why: 'днём без мозга' };
  const out = { cands: [{ score: 25, act: cand }] };
  const s = { ...calm, tools: {}, hasWeapon: false };
  const realSurvey = SURVEY.survey;
  SURVEY.survey = () => ({ origin: { x: 0, y: 64, z: 0 }, legend: { '.': 'air', L: 'oak_log' }, layers: { 'y=64': ['L'] } });   // бревно рядом
  const ch = D.choose(fakeCtx(), s, cand, out);
  SURVEY.survey = realSurvey;
  assert.strictEqual(ch.key, 'pool:v1.mineWoodLog', ch.key);
  assert.strictEqual(ch.name, 'pool_run');
  assert.strictEqual(ch.params.id, 'v1.mineWoodLog');
  console.log('choose: опыт выбирает навык пула, если он лучше дел автопилота: OK');

  // 7) без HC_POOL тот же опыт не даёт пула: выбор — дело автопилота, как было
  delete process.env.HC_POOL; D._reset();
  const ch2 = D.choose(fakeCtx(), s, cand, out);
  assert.strictEqual(ch2.key, 'day_routine', ch2.key);
  console.log('без HC_POOL — выбор автопилота, как было: OK');

  delete process.env.HC_DECIDER_MEM; delete process.env.HC_EXPLORE; D._reset();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('hardcore_pool_run: OK');
})().catch(e => { console.error(e); process.exit(1); });
