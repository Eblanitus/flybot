// Офлайн-проверка ночного навыка хардкор-стенда (этап 2, шаг Б2): hc_night_mine проходит те же сценарии, что night_mine
// в test/core_fixes.js; v4 и v6 на яме в камне падают (это и доказывает, что взята рабочая версия); decide() ночью
// выбирает hc_night_mine только при HC_STAGE2.
'use strict';
const assert = require('assert');
const { decide } = require('../behavior/autopilot');

// фальшивый API навыка — как nightApi в test/core_fixes.js (копия: тот файл не экспортирует его)
function nightApi(world, { phase = 'ночь', pos = { x: 0.5, y: 64, z: 0.5 }, inv = null } = {}) {
  const set = new Map(), key = (x, y, z) => x + ',' + y + ',' + z;
  const g = (x, y, z) => (set.has(key(x, y, z)) ? set.get(key(x, y, z)) : world(x, y, z));
  const st = { pos: { ...pos }, yaw: 0, calls: [], logs: [] };
  const CH = { air: '.', stone: 's', snow: '*', dripstone_block: 'd', obsidian: 'o', water: 'w' };
  const api = {
    log: m => st.logs.push(m), sleep: async () => {},
    snapshot: async () => ({ position: st.pos, health: 20, inventory: inv || [{ name: 'stone_pickaxe', count: 1, slot: 36 }, { name: 'cobblestone', count: 8, slot: 37 }], eyes: { time: { phase } } }),
    cmd: async (name, p) => {
      st.calls.push({ name, p });
      if (name === 'survey') {
        const layers = {}; const legend = { '.': 'air', s: 'stone', '*': 'snow', d: 'dripstone_block', o: 'obsidian', w: 'water' };
        for (let y = p.y1; y <= p.y2; y++) { const rows = []; for (let z = p.z1; z <= p.z2; z++) { let r = ''; for (let x = p.x1; x <= p.x2; x++) r += CH[g(x, y, z)] || 's'; rows.push(r); } layers['y=' + y] = rows; }
        return { origin: { x: p.x1, y: p.y1, z: p.z1 }, layers, legend };
      }
      if (name === 'dig_at') { set.set(key(p.x, p.y, p.z), 'air'); if (Math.floor(st.pos.x) === p.x && Math.floor(st.pos.z) === p.z && p.y === Math.floor(st.pos.y) - 1) st.pos.y -= 1; return {}; }
      if (name === 'look') { st.yaw = p.yaw; return {}; }
      if (name === 'move') { const nx = st.pos.x - Math.sin(st.yaw), nz = st.pos.z - Math.cos(st.yaw); if (g(Math.floor(nx), Math.floor(st.pos.y), Math.floor(nz)) === 'air') { st.pos.x = nx; st.pos.z = nz; } return {}; }
      if (name === 'place_at') { set.set(key(p.x, p.y, p.z), 'stone'); return {}; }
      return {};
    }
  };
  return { api, st, set };
}

(async () => {
  const hc = require('../brain/learned/hc_night_mine.js');
  assert.strictEqual(hc.name, 'hc_night_mine');

  // днём: отказ с error
  let w = nightApi((x, y, z) => (y <= 63 ? 'stone' : 'air'), { phase: 'день' });
  let r = await hc.run(w.api, {});
  assert(r.ok === false && /night_mine: .*не ночь/.test(r.error), JSON.stringify(r));

  // ночью на открытой поверхности с киркой (разбор 1-го мира этапа 2): сама уходит на 3 блока вниз, закрывает шахту над головой и копает
  w = nightApi((x, y, z) => (y <= 63 ? 'stone' : 'air'));
  r = await hc.run(w.api, { max_blocks: 3 });
  const digs = w.st.calls.filter(c => c.name === 'dig_at').slice(0, 3).map(c => c.p.y);
  assert.deepStrictEqual(digs, [63, 62, 61], 'с поверхности — три шага вниз: ' + JSON.stringify(digs));
  assert(w.set.get('0,64,0') === 'stone' && w.set.get('0,63,0') === 'stone', 'шахта над головой закрыта: ' + JSON.stringify([...w.set]));
  assert(r.ok === true && r.mined >= 1, JSON.stringify(r));

  // на поверхности без кирки, вокруг камень: вниз не уйти — отказ с error и подсказкой, как раньше
  w = nightApi((x, y, z) => (y <= 63 ? 'stone' : 'air'), { inv: [{ name: 'cobblestone', count: 8, slot: 37 }] });
  r = await hc.run(w.api, {});
  assert(r.ok === false && /^night_mine: нет безопасного направления/.test(r.error) && /mine_stairs/.test(r.error), JSON.stringify(r));

  // на поверхности у воды: вниз не уходит (вода затечёт), отказ как раньше
  w = nightApi((x, y, z) => (x === 1 && y === 64 ? 'water' : y <= 63 ? 'stone' : 'air'));
  r = await hc.run(w.api, {});
  assert(r.ok === false && !w.st.calls.some(c => c.name === 'dig_at'), JSON.stringify(r));

  // dripstone_block — не «не копаем»: направление выбирается
  w = nightApi((x, y, z) => ((x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : y <= 70 ? 'dripstone_block' : 'air'));
  r = await hc.run(w.api, { max_blocks: 3 });
  assert(r.ok === true && r.mined >= 1 && !r.error, JSON.stringify(r));

  // яма в камне (воздух в (0,64,0) и (0,65,0), камень до y = 65): углубляется на 1 и копает
  const pit = (x, y, z) => ((x === 0 && z === 0 && (y === 64 || y === 65)) ? 'air' : y <= 65 ? 'stone' : 'air');
  w = nightApi(pit);
  r = await hc.run(w.api, { max_blocks: 3 });
  const firstDig = w.st.calls.find(c => c.name === 'dig_at');
  assert(firstDig && firstDig.p.x === 0 && firstDig.p.y === 63 && firstDig.p.z === 0, 'углубился: ' + JSON.stringify(firstDig));
  assert(r.ok === true && r.mined >= 1, JSON.stringify(r));
  console.log('hc_night_mine: шесть сценариев OK');

  // v4 и v6 падают на той же яме: доказываем, что взята рабочая версия
  const v6 = require('../brain/learned/night_mine_v6.js');
  const v4 = require('../brain/learned/night_mine_v4.js');
  const w6 = nightApi(pit);
  const e6 = await v6.run(w6.api, { max_blocks: 3 }).then(x => ({ x }), e => ({ e }));
  assert(e6.e ? /score is not defined/.test(e6.e.message) : /score is not defined/.test(JSON.stringify(e6.x)), 'v6: ' + JSON.stringify(e6));
  const w4 = nightApi(pit);
  const e4 = await v4.run(w4.api, { max_blocks: 3 }).then(x => ({ x }), e => ({ e }));
  assert(e4.e ? /sunk is not defined/.test(e4.e.message) : /sunk is not defined/.test(JSON.stringify(e4.x)), 'v4: ' + JSON.stringify(e4));
  console.log('v4 и v6 на яме падают: OK');

  // decide() ночью без угроз: с HC_STAGE2 — hc_night_mine, без переменной — night_mine
  const base = { on: true, idle: true, task: null, running: null, runnerOther: false, hp: 20, food: 20, hasFood: true, hasWeapon: true, hasPickaxe: true,
    blocks: 20, logs: 8, cobble: 30, phase: 'ночь', isNight: true, nightIn: 500, sheltered: false, hostilesNear: 0, enemies: [], alone: true,
    freeBed: false, animals: 0, recoverable: false, blocked: {}, goal: null, goalDone: false };
  process.env.HC_STAGE2 = '1';
  assert.strictEqual(decide(base).name, 'hc_night_mine', 'с HC_STAGE2 ночью — hc_night_mine');
  delete process.env.HC_STAGE2;
  assert.strictEqual(decide(base).name, 'night_mine', 'без HC_STAGE2 — night_mine');
  console.log('decide ночью: OK');

  console.log('hardcore_night_mine: OK');
})().catch(e => { console.error(e); process.exit(1); });
