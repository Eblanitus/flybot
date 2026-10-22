// Офлайн-проверка чертежей (lib/skills/blueprint.js): разбор формата, повороты, смета против фейкового мира,
// стройка с подпорками/направлениями/возобновлением, сверка. Без сервера Minecraft. Запуск: node test/blueprint.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('../lib/util');
const { Task, TaskManager } = require('../lib/tasks');
const A = require('../lib/actions');
const BP = require('../lib/skills/blueprint');
const reg = require('minecraft-data')('1.21.4');
const Block = require('prismarine-block')(reg);

const HD = ['north', 'east', 'south', 'west'];
const DV = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
const dirOfYaw = yaw => { const dx = -Math.sin(yaw), dz = -Math.cos(yaw); return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'); };

// Фальшивый мир: камень до y=63 включительно, выше воздух. Правила установки — как у ванили (в объёме, нужном навыку).
function mkWorld({ inv = {}, blocks = {}, unloadedFromX = null, invertStairs = false } = {}) {
  const map = new Map();
  const K = (x, y, z) => x + ',' + y + ',' + z;
  for (const [k, v] of Object.entries(blocks)) map.set(k, v);
  const mk = (name, props, x, y, z) => { const b = Block.fromProperties(name, props || {}, 0); b.position = new Vec3(x, y, z); return b; };
  const get = (x, y, z) => {
    const k = K(x, y, z);
    if (map.has(k)) { const m = map.get(k); return mk(m.name, m.props, x, y, z); }
    return mk(y <= 63 ? 'stone' : 'air', {}, x, y, z);
  };
  const set = (x, y, z, name, props) => map.set(K(x, y, z), { name, props: props || {} });
  const stock = { ...inv };
  const stats = { blocksPlaced: 0, blocksMined: 0 };
  const log = { placed: 0, dug: 0, goto: 0, looks: [] };
  const bot = {
    registry: reg, username: 'T', heldItem: null,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0 },
    blockAt: pos => (unloadedFromX !== null && Math.floor(pos.x) >= unloadedFromX) ? null : get(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)),
    inventory: { items: () => Object.entries(stock).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })), slots: [] },
    equip: async it => { bot.heldItem = it; },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; log.looks.push(dirOfYaw(yaw)); },
    lookAt: async p => { const dx = p.x - bot.entity.position.x, dz = p.z - bot.entity.position.z; bot.entity.yaw = Math.atan2(-dx, -dz); },
    stopDigging() {},
    dig: async b => {
      log.dug++;
      const nm = b.name;
      set(b.position.x, b.position.y, b.position.z, 'air');
      if (/_door$/.test(nm)) { const half = b.getProperties().half; const o = half === 'lower' ? 1 : -1; const ob = get(b.position.x, b.position.y + o, b.position.z); if (ob.name === nm) set(b.position.x, b.position.y + o, b.position.z, 'air'); }
      const drop = nm === 'stone' ? 'cobblestone' : nm;
      if (reg.itemsByName[drop]) stock[drop] = (stock[drop] || 0) + 1;
    },
    _placeBlockWithOptions: async (ref, face, opts) => {
      const dest = ref.position.plus(face);
      const cur = get(dest.x, dest.y, dest.z);
      if (cur.name !== 'air' && cur.name !== 'water' && cur.name !== 'short_grass') throw new Error('refused: ' + cur.name);
      const eye = bot.entity.position.offset(0, 1.62, 0);
      if (eye.distanceTo(dest.offset(0.5, 0.5, 0.5)) > 5.2) throw new Error('too far: ' + eye.distanceTo(dest.offset(0.5, 0.5, 0.5)).toFixed(1));
      const it = bot.heldItem; if (!it || !stock[it.name]) throw new Error('no item');
      stock[it.name]--; log.placed++;
      const horiz = face.y === 0;
      let name = it.name, props = {};
      const fdir = dirOfYaw(bot.entity.yaw);
      if (it.name === 'torch') { if (face.y < 0) throw new Error('torch down'); if (horiz) { name = 'wall_torch'; props = { facing: HD.find(d => DV[d][0] === face.x && DV[d][2] === face.z) }; } }
      else if (/_stairs$/.test(name)) props = { facing: invertStairs ? { north: 'south', south: 'north', east: 'west', west: 'east' }[fdir] : fdir, half: face.y < 0 ? 'top' : face.y > 0 ? 'bottom' : (opts && opts.half === 'top' ? 'top' : 'bottom'), shape: 'straight', waterlogged: false };
      else if (/_slab$/.test(name)) props = { type: face.y < 0 ? 'top' : face.y > 0 ? 'bottom' : (opts && opts.half === 'top' ? 'top' : 'bottom'), waterlogged: false };
      else if (/_log$/.test(name)) props = { axis: face.x ? 'x' : face.y ? 'y' : 'z' };
      else if (/_door$/.test(name)) {
        if (get(dest.x, dest.y + 1, dest.z).name !== 'air') throw new Error('door: no room');
        props = { facing: fdir, half: 'lower', hinge: 'left', open: false, powered: false };
        set(dest.x, dest.y + 1, dest.z, name, { ...props, half: 'upper' });
      }
      set(dest.x, dest.y, dest.z, name, props);
    }
  };
  bot.placeBlock = bot._placeBlockWithOptions;
  const ctx = { bot, stats, statsDirty: false, bpFast: true };
  return { bot, ctx, set, get, stock, log, map };
}
// goto подменён: «телепорт» на 2 блока восточнее цели
A.goto = async (ctx, t, goal) => {
  t.check();
  const g = goal.goals ? goal.goals[0] : goal;
  const bot = ctx.bot; bot.entity.position = new Vec3(g.x + 2.5, g.y, g.z + 0.5);
  if (ctx.__gotoCount) ctx.__gotoCount.n++;
};
A.pickupDrops = async () => {};
const task = () => new Task(1, 'build_blueprint', {}, 'brain');
const tmpBp = (files) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-bp-')); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n + '.txt'), t); return dir; };
const rejects = async (p, re, msg) => { let err = null; try { await p; } catch (e) { err = e; } assert(err, 'ожидалась ошибка: ' + msg); assert(re.test(err.message), `${msg}: ${err.message}`); return err; };

module.exports = async () => {
  // ---- регистрация ----
  const { SKILLS } = require('../lib/commands');
  for (const n of ['build_blueprint', 'blueprint_list', 'blueprint_check']) assert.strictEqual(typeof SKILLS[n], 'function', 'не зарегистрирован ' + n);

  // ---- разбор формата ----
  const src = [
    '﻿# name: t', '# desc: проба', '# origin: NW-bottom', 'A = oak_stairs facing=west half=bottom   # ступень', 'B = oak_log axis=x', 'C = stone', '. = air', '',
    'layer 0', '|ABC|', 'C..', '', 'layer 1-2', ' B', ''
  ].join('\r\n');
  const bp = BP.parseBlueprint(src, { name: 't', registry: reg });
  assert.deepStrictEqual([bp.W, bp.H, bp.D, bp.layers], [3, 3, 2, 3]);
  assert.strictEqual(bp.meta.desc, 'проба');
  assert.strictEqual(bp.cells.length, 3 + 3 + 1 + 1, 'клетки: 6 в слое 0 + по одной в слоях 1 и 2');
  const lay1 = bp.cells.filter(c => c.ly === 1); assert.deepStrictEqual(lay1.map(c => [c.lx, c.lz, c.block]), [[1, 0, 'oak_log']], 'ведущий пробел = пропуск');
  assert.deepStrictEqual(bp.materials, { oak_stairs: 1, oak_log: 3, stone: 2 });
  assert.deepStrictEqual(bp.cells[0].props, { facing: 'west', half: 'bottom' });
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('C = stone\nlayer 0\nCX', { name: 'x' })), /не описан/, 'символ без легенды');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('Q = foo_bar\nlayer 0\nQ', { name: 'x', registry: reg })), /неизвестный блок/, 'неизвестный блок');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('S = oak_stairs facing=up\nlayer 0\nS', { name: 'x', registry: reg })), /не бывает/, 'плохое значение свойства');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('S = oak_stairs colour=red\nlayer 0\nS', { name: 'x', registry: reg })), /нет свойства/, 'плохое свойство');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('S = oak_slab type=double\nlayer 0\nS', { name: 'x', registry: reg })), /double/, 'double');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('C = stone', { name: 'x' })), /ни одного слоя/, 'нет слоёв');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('C = stone\nlayer 0\nC\nlayer 0\nC', { name: 'x' })), /уже описан/, 'повтор слоя');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('C = stone\nlayer 0\nC\tC', { name: 'x' })), /табуляц/, 'табуляция');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('# origin: SE\nC = stone\nlayer 0\nC', { name: 'x' })), /origin/, 'origin');
  // дверь: верхняя половина достраивается, смета — одна дверь
  const door = BP.parseBlueprint('D = oak_door facing=east\nlayer 0\nD', { name: 'd', registry: reg });
  assert.strictEqual(door.cells.length, 2); assert.strictEqual(door.H, 2);
  assert.deepStrictEqual(door.materials, { oak_door: 1 });
  assert.strictEqual(door.cells[1].implied, true); assert.strictEqual(door.cells[1].props.half, 'upper');
  await rejects(Promise.resolve().then(() => BP.parseBlueprint('D = oak_door\nC = stone\nlayer 0\nD\nlayer 1\nC', { name: 'x' })), /клетка над ней занята/, 'дверь под камнем');
  assert.strictEqual(BP.itemNameFor('wall_torch'), 'torch'); assert.strictEqual(BP.itemNameFor('spruce_wall_sign'), 'spruce_sign');
  assert.strictEqual(BP.normRot(-90), 270); assert.strictEqual(BP.normRot(360), 0);
  assert.throws(() => BP.normRot(45), /rot/);

  // ---- повороты ----
  const cellAt = (cells, x, y, z) => cells.find(c => c.x === x && c.y === y && c.z === z);
  const r0 = BP.instantiate(bp, 10, 64, 20, 0);
  assert.deepStrictEqual(r0.size, { x: 3, y: 3, z: 2 });
  let c = cellAt(r0.cells, 10, 64, 20); assert(c.block === 'oak_stairs' && c.props.facing === 'west');
  assert.strictEqual(cellAt(r0.cells, 11, 64, 20).props.axis, 'x');
  assert.strictEqual(cellAt(r0.cells, 11, 64, 21).kind, 'air');
  const r90 = BP.instantiate(bp, 10, 64, 20, 90);
  assert.deepStrictEqual(r90.size, { x: 2, y: 3, z: 3 });
  c = cellAt(r90.cells, 11, 64, 20); assert(c.block === 'oak_stairs' && c.props.facing === 'north', 'ступень СЗ-угла уходит в СВ и смотрит на север');
  c = cellAt(r90.cells, 11, 64, 21); assert(c.block === 'oak_log' && c.props.axis === 'z', 'ось x -> z');
  assert.strictEqual(cellAt(r90.cells, 10, 64, 20).block, 'stone');
  const r180 = BP.instantiate(bp, 10, 64, 20, 180);
  c = cellAt(r180.cells, 12, 64, 21); assert(c.block === 'oak_stairs' && c.props.facing === 'east');
  const r270 = BP.instantiate(bp, 10, 64, 20, 270);
  assert.deepStrictEqual(r270.size, { x: 2, y: 3, z: 3 });
  c = cellAt(r270.cells, 10, 64, 22); assert(c.block === 'oak_stairs' && c.props.facing === 'south');
  for (const r of [r0, r90, r180, r270]) { // повёрнутая постройка остаётся в своём прямоугольнике от (x,y,z)
    for (const q of r.cells) assert(q.x >= 10 && q.x < 10 + r.size.x && q.z >= 20 && q.z < 20 + r.size.z && q.y >= 64 && q.y < 67);
    assert.strictEqual(new Set(r.cells.map(q => q.key)).size, r.cells.length, 'клетки не должны совпадать');
  }
  // дверь вращается вместе с верхней половиной
  const rd = BP.instantiate(door, 0, 64, 0, 90); assert.strictEqual(rd.cells[0].props.facing, 'south'); assert.strictEqual(rd.cells[0].upper, rd.cells[1]);

  // ---- примеры чертежей лежат в brain/blueprints и разбираются ----
  const dir0 = BP.BLUEPRINT_DIR;
  for (const f of ['hut_west', 'fence_post_lamp', 'bridge_segment']) assert(fs.existsSync(path.join(dir0, f + '.txt')), 'нет примера ' + f);
  assert(fs.existsSync(path.join(dir0, 'README.md')));
  const hut = BP.loadBlueprint({ bot: { registry: reg } }, 'hut_west');
  assert.deepStrictEqual([hut.W, hut.D, hut.H], [7, 7, 5]);
  assert.deepStrictEqual(hut.materials, { cobblestone: 102, spruce_log: 12, spruce_door: 1, glass_pane: 5, torch: 2, spruce_planks: 49 });
  const bridge = BP.loadBlueprint({ bot: { registry: reg } }, 'bridge_segment');
  assert.deepStrictEqual([bridge.W, bridge.D], [5, 8]);
  const lamp = BP.loadBlueprint({ bot: { registry: reg } }, 'fence_post_lamp');
  assert.deepStrictEqual(lamp.materials, { cobblestone: 1, spruce_fence: 3, torch: 1 });
  const list = BP.blueprintList({ bot: { registry: reg } });
  assert.deepStrictEqual(list.blueprints.map(b => b.name).filter(n => ['bridge_segment', 'fence_post_lamp', 'hut_west'].includes(n)), ['bridge_segment', 'fence_post_lamp', 'hut_west']);
  assert(list.blueprints.every(b => !b.error), 'ошибка в чертеже: ' + JSON.stringify(list.blueprints.filter(b => b.error)));
  await rejects(Promise.resolve().then(() => BP.loadBlueprint({ bot: { registry: reg } }, '../etc/passwd')), /имя чертежа/, 'путь вне каталога');
  await rejects(Promise.resolve().then(() => BP.loadBlueprint({ bot: { registry: reg } }, 'нет_такого')), /имя чертежа/, 'кириллица');
  await rejects(Promise.resolve().then(() => BP.loadBlueprint({ bot: { registry: reg } }, 'no_such')), /нет чертежа no_such; есть: (.+, )?bridge_segment/, 'нет файла');

  // ---- dry: смета против мира, уже стоящие блоки учтены ----
  {
    const w = mkWorld({ inv: { cobblestone: 1, spruce_fence: 1 } });
    w.set(5, 64, 5, 'cobblestone'); w.set(5, 65, 5, 'spruce_fence', {});
    const r = await BP.buildBlueprint(w.ctx, null, { name: 'fence_post_lamp', x: 5, y: 64, z: 5, dry: 1 });
    assert(r.ok && r.dry);
    assert.deepStrictEqual(r.need, { spruce_fence: 2, torch: 1 });
    assert.deepStrictEqual(r.needTotal, { cobblestone: 1, spruce_fence: 3, torch: 1 });
    assert.deepStrictEqual(r.have, { spruce_fence: 1, torch: 0 });
    assert.deepStrictEqual(r.missing, { spruce_fence: 1, torch: 1 });
    assert.deepStrictEqual(r.plan.size, { x: 1, y: 5, z: 1 }); assert.strictEqual(r.plan.cells, 5); assert.strictEqual(r.plan.done, 2); assert.strictEqual(r.plan.layers, 5);
    assert.strictEqual(w.log.placed, 0, 'dry ничего не ставит'); assert.strictEqual(w.log.dug, 0);
    // сверка
    const ck = BP.blueprintCheck(w.ctx, { name: 'fence_post_lamp', x: 5, y: 64, z: 5 });
    assert.strictEqual(ck.matched, 2); assert.strictEqual(ck.total, 5); assert.strictEqual(ck.percent, 40); assert.strictEqual(ck.complete, false);
    assert.deepStrictEqual(ck.mismatches.map(m => [m.y, m.want, m.have, m.why]), [[66, 'spruce_fence', 'air', 'place'], [67, 'spruce_fence', 'air', 'place'], [68, 'torch', 'air', 'place']]);
    // чужой блок на месте: «replace»; лишнее в воздушной клетке: «cut»
    w.set(5, 66, 5, 'dirt');
    assert.strictEqual(BP.blueprintCheck(w.ctx, { name: 'fence_post_lamp', x: 5, y: 64, z: 5 }).mismatches[0].why, 'replace');
  }
  // ---- сверка: не больше 20 несовпадений, считает «воздух» ----
  {
    const w = mkWorld({});
    const ck = BP.blueprintCheck(w.ctx, { name: 'hut_west', x: 0, y: 64, z: 0, rot: 90 });
    assert.strictEqual(ck.total, 245); assert.strictEqual(ck.mismatches.length, 20); assert(ck.mismatchCount > 20);
    assert.deepStrictEqual(ck.size, { x: 7, y: 5, z: 7 });
    assert(ck.matched > 0 && ck.matched < ck.total, 'воздух совпадает с «.»: ' + ck.matched);
  }
  // ---- нехватка материалов: ошибка с точным списком, мир нетронут ----
  {
    const w = mkWorld({ inv: { cobblestone: 100, spruce_log: 12, spruce_planks: 49, spruce_door: 1, glass_pane: 2, torch: 2 } });
    const dry = await BP.buildBlueprint(w.ctx, null, { name: 'hut_west', x: 0, y: 64, z: 0, dry: 1 });
    assert.deepStrictEqual(dry.missing, { cobblestone: 2, glass_pane: 3 });
    const e = await rejects(BP.buildBlueprint(w.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0 }), /не хватает: cobblestone ×2, glass_pane ×3/, 'нехватка');
    assert.strictEqual(e.extra.ok, false); assert.deepStrictEqual(e.extra.missing, { cobblestone: 2, glass_pane: 3 }); assert(e.extra.error);
    assert.strictEqual(w.log.placed, 0); assert.strictEqual(w.log.dug, 0);
  }

  // ---- полная стройка хижины с препятствиями, повтор, поворот ----
  const FULL = { cobblestone: 110, spruce_log: 12, spruce_planks: 49, spruce_door: 1, glass_pane: 5, torch: 2, dirt: 6 };
  for (const rot of [0, 90]) {
    const w = mkWorld({ inv: FULL });
    w.ctx.__gotoCount = { n: 0 };
    // в интерьере камень (вырезать), на полу земля (заменить), одна клетка стены уже стоит правильно, на уровне крыши — трава
    const at = (rx, ry, rz) => { const q = BP.instantiate(hut, 0, 64, 0, rot).cells.find(k => k.lx === rx && k.ly === ry && k.lz === rz); return q; };
    const q1 = at(3, 1, 3), q2 = at(2, 0, 2), q3 = at(0, 1, 1), q4 = at(3, 4, 3);
    w.set(q1.x, q1.y, q1.z, 'stone'); w.set(q2.x, q2.y, q2.z, 'dirt'); w.set(q3.x, q3.y, q3.z, 'cobblestone'); w.set(q4.x, q4.y, q4.z, 'short_grass');
    const t = task();
    const res = await BP.buildBlueprint(w.ctx, t, { name: 'hut_west', x: 0, y: 64, z: 0, rot });
    assert(res.ok, JSON.stringify(res)); assert.deepStrictEqual(res.failed, []);
    assert.strictEqual(res.matched, 245); assert.strictEqual(res.total, 245);
    assert(res.removed >= 2, 'вырезано/заменено: ' + res.removed);
    // готовые: воздух чертежа (кроме вырезанного камня q1) + стоявшая стена q3; число воздуха — из самого чертежа (brain/blueprints меняет мозг)
    const airN = BP.instantiate(hut, 0, 64, 0, rot).cells.filter(k => k.kind === 'air').length;
    assert(res.skipped >= airN - 1, `пропущено готовых (в т.ч. воздух): ${res.skipped}, воздуха в чертеже ${airN}`);
    assert.strictEqual(w.ctx.stats.blocksPlaced, res.placed);
    // состав: ровно то, что нужно (+ вернули подпорки, если были)
    const chk = BP.blueprintCheck(w.ctx, { name: 'hut_west', x: 0, y: 64, z: 0, rot });
    assert(chk.complete && chk.percent === 100, JSON.stringify(chk.mismatches));
    // дверь с двумя половинами, ступени/брёвна/факелы с нужными свойствами
    const dr = BP.instantiate(hut, 0, 64, 0, rot).cells.find(k => k.block === 'spruce_door' && !k.implied);
    const dl = w.get(dr.x, dr.y, dr.z), du = w.get(dr.x, dr.y + 1, dr.z);
    assert(dl.name === 'spruce_door' && dl.getProperties().half === 'lower' && du.name === 'spruce_door' && du.getProperties().half === 'upper');
    assert.strictEqual(String(dl.getProperties().facing), dr.props.facing);
    assert.strictEqual(dr.props.facing, { 0: 'east', 90: 'south' }[rot]);
    const torch = BP.instantiate(hut, 0, 64, 0, rot).cells.find(k => k.block === 'wall_torch' && k.lx === 1);
    const tb = w.get(torch.x, torch.y, torch.z); assert(tb.name === 'wall_torch' && String(tb.getProperties().facing) === torch.props.facing, 'факел на стене смотрит куда надо');
    assert.strictEqual(w.get(BP.instantiate(hut, 0, 64, 0, rot).cells.find(k => k.block === 'spruce_log').x, 65, BP.instantiate(hut, 0, 64, 0, rot).cells.find(k => k.block === 'spruce_log').z).getProperties().axis, 'y');
    assert(w.ctx.__gotoCount.n > 0, 'к дальним клеткам ходил');
    // слои идут снизу вверх: пол раньше крыши (проверяем по счётчику — крыша не стоит без стен: все 245 на месте и без подпорок)
    assert.strictEqual(res.scaffold, undefined, 'хижине подпорки не нужны');
    // повторный запуск: ничего не делает
    const again = await BP.buildBlueprint(w.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0, rot });
    assert(again.ok && again.placed === 0 && again.removed === 0 && again.skipped === 245, JSON.stringify(again));
    assert.strictEqual(again.placed, 0);
    // dry на готовой постройке: нужды нет
    const d2 = await BP.buildBlueprint(w.ctx, null, { name: 'hut_west', x: 0, y: 64, z: 0, rot, dry: true });
    assert.deepStrictEqual(d2.need, {}); assert.deepStrictEqual(d2.missing, {}); assert.strictEqual(d2.plan.done, 245);
  }

  // ---- прерывание и продолжение ----
  {
    const w = mkWorld({ inv: FULL });
    const t1 = task(); let n = 0;
    const orig = w.bot._placeBlockWithOptions;
    w.bot._placeBlockWithOptions = async (...a) => { const r = await orig(...a); if (++n === 60) t1.abort('stop'); return r; };
    await rejects(BP.buildBlueprint(w.ctx, t1, { name: 'hut_west', x: 0, y: 64, z: 0 }), /stop/, 'прерывание');
    assert(w.log.placed >= 60 && w.log.placed < 120, 'часть построена: ' + w.log.placed);
    const part = BP.blueprintCheck(w.ctx, { name: 'hut_west', x: 0, y: 64, z: 0 });
    assert(!part.complete);
    const placedBefore = w.log.placed;
    w.bot._placeBlockWithOptions = orig;
    const res = await BP.buildBlueprint(w.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0 });
    assert(res.ok, JSON.stringify(res));
    assert(res.skipped >= placedBefore, 'готовое не перестраивается: skipped ' + res.skipped + ' / было ' + placedBefore);
    assert.strictEqual(w.log.placed, placedBefore + res.placed);
    assert(BP.blueprintCheck(w.ctx, { name: 'hut_west', x: 0, y: 64, z: 0 }).complete);
  }

  // ---- нехватка посреди стройки (например, часть блоков ушла) не роняет остальное, а попадает в failed/missing ----
  {
    const w = mkWorld({ inv: { ...FULL } });
    const t = task(); let n = 0;
    const orig = w.bot._placeBlockWithOptions;
    w.bot._placeBlockWithOptions = async (...a) => { const r = await orig(...a); if (++n === 40) { w.stock.spruce_planks = 0; } return r; };
    const e = await rejects(BP.buildBlueprint(w.ctx, t, { name: 'hut_west', x: 0, y: 64, z: 0 }), /не достроено/, 'кончились доски');
    assert.strictEqual(e.extra.ok, false); assert(e.extra.failed.length > 0 && e.extra.failed.every(f => f.block === 'spruce_planks'), JSON.stringify(e.extra.failed.slice(0, 2)));
    assert(e.extra.missing.spruce_planks > 0);
    assert(e.extra.matched > 150, 'остальное построено: ' + e.extra.matched);
  }

  // ---- подпорка: блок в воздухе, цепочка вниз, потом убирается ----
  {
    const dirp = tmpBp({ float: 'S = stone\nlayer 0\nS\n', float2: 'S = stone\nlayer 0\nS\nlayer 2\nS\n' });
    const w = mkWorld({ inv: { stone: 2, dirt: 3 } });
    w.ctx.blueprintDir = dirp;
    const dry = await BP.buildBlueprint(w.ctx, null, { name: 'float', x: 0, y: 66, z: 0, dry: 1 });
    assert.deepStrictEqual(dry.plan.scaffold, { cells: 2, peak: 2, unplaceable: 0 }); assert.strictEqual(dry.scaffoldItem, 'dirt'); assert.deepStrictEqual(dry.missing, {});
    const res = await BP.buildBlueprint(w.ctx, task(), { name: 'float', x: 0, y: 66, z: 0 });
    assert(res.ok && res.placed === 1, JSON.stringify(res)); assert.deepStrictEqual(res.scaffold, { placed: 2, removed: 2, left: 0 });
    assert.strictEqual(w.get(0, 66, 0).name, 'stone'); assert.strictEqual(w.get(0, 65, 0).name, 'air'); assert.strictEqual(w.get(0, 64, 0).name, 'air');
    assert.strictEqual(w.stock.dirt, 3, 'подпорки вернулись в инвентарь');
    // нет дешёвого блока: dry просит dirt, стройка отказывает
    const w2 = mkWorld({ inv: { stone: 1 } }); w2.ctx.blueprintDir = dirp;
    const d2 = await BP.buildBlueprint(w2.ctx, null, { name: 'float', x: 0, y: 66, z: 0, dry: 1 });
    assert.deepStrictEqual(d2.missing, { dirt: 2 });
    await rejects(BP.buildBlueprint(w2.ctx, task(), { name: 'float', x: 0, y: 66, z: 0 }), /не хватает: dirt ×2/, 'нет подпорок');
    // слой 2 стоит над слоем 0 без опоры: ставится после подпорки/блока ниже, порядок снизу вверх
    const w3 = mkWorld({ inv: { stone: 2, dirt: 3 } }); w3.ctx.blueprintDir = dirp;
    const r3 = await BP.buildBlueprint(w3.ctx, task(), { name: 'float2', x: 0, y: 66, z: 0 });
    assert(r3.ok && r3.placed === 2, JSON.stringify(r3)); assert.strictEqual(w3.get(0, 68, 0).name, 'stone'); assert.strictEqual(w3.get(0, 66, 0).name, 'stone');
    fs.rmSync(dirp, { recursive: true, force: true });
  }

  // ---- направленные блоки: ступени, полублоки сверху, поправка направления ----
  {
    const dirp = tmpBp({ dir: 'A = oak_stairs facing=west half=bottom\nB = oak_stairs facing=south half=top\nD = oak_slab type=top\nE = oak_stairs facing=north half=bottom\nlayer 0\nAE\nBD\n' });
    const mk = (extra) => { const w = mkWorld({ inv: { oak_stairs: 3, oak_slab: 1 }, ...extra }); w.ctx.blueprintDir = dirp; return w; };
    const w = mk();
    const res = await BP.buildBlueprint(w.ctx, task(), { name: 'dir', x: 0, y: 64, z: 0 });
    assert(res.ok, JSON.stringify(res));
    const P = (x, z) => w.get(x, 64, z).getProperties();
    assert.strictEqual(String(P(0, 0).facing), 'west'); assert.strictEqual(P(0, 0).half, 'bottom');
    assert.strictEqual(String(P(1, 0).facing), 'north');
    assert.strictEqual(String(P(0, 1).facing), 'south'); assert.strictEqual(P(0, 1).half, 'top', 'half=top через боковую грань');
    assert.strictEqual(P(1, 1).type, 'top');
    // сервер «в зеркале»: навык ломает и ставит с обратным взглядом
    const wi = mk({ invertStairs: true });
    wi.set(0, 64, 0, 'air');
    const ri = await BP.buildBlueprint(wi.ctx, task(), { name: 'dir', x: 0, y: 64, z: 0 });
    assert(ri.ok || ri.warnings, JSON.stringify(ri));
    assert.strictEqual(String(wi.get(0, 64, 0).getProperties().facing), 'west', 'поправил направление');
    // сверка видит неверное направление
    const wb = mk(); wb.set(0, 64, 0, 'oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false });
    const ck = BP.blueprintCheck(wb.ctx, { name: 'dir', x: 0, y: 64, z: 0 });
    assert.strictEqual(ck.mismatches[0].why, 'badprops'); assert(/facing/.test(ck.mismatches[0].have), ck.mismatches[0].have);
    const rb = await BP.buildBlueprint(wb.ctx, task(), { name: 'dir', x: 0, y: 64, z: 0 });
    assert(rb.ok && rb.removed === 1, JSON.stringify(rb));
    fs.rmSync(dirp, { recursive: true, force: true });
  }

  // ---- чужое добро и незагруженное ----
  {
    const w = mkWorld({ inv: FULL });
    const q = BP.instantiate(hut, 0, 64, 0, 0).cells.find(k => k.lx === 3 && k.ly === 1 && k.lz === 3); // интерьер («воздух»)
    w.set(q.x, q.y, q.z, 'chest', { facing: 'north', type: 'single', waterlogged: false });
    const w2 = mkWorld({ inv: FULL }); const q2 = BP.instantiate(hut, 0, 64, 0, 0).cells.find(k => k.lx === 2 && k.ly === 0 && k.lz === 2); // пол
    w2.set(q2.x, q2.y, q2.z, 'chest', { facing: 'north', type: 'single', waterlogged: false });
    const e = await rejects(BP.buildBlueprint(w.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0 }), /не достроено/, 'сундук в интерьере');
    assert.strictEqual(e.extra.failed.length, 1); assert(/чужим/.test(e.extra.failed[0].why)); assert.strictEqual(w.get(q.x, q.y, q.z).name, 'chest', 'сундук цел');
    assert.strictEqual(e.extra.matched, 244);
    const e2 = await rejects(BP.buildBlueprint(w2.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0 }), /не достроено/, 'сундук на месте пола');
    assert.strictEqual(w2.get(q2.x, q2.y, q2.z).name, 'chest'); assert(e2.extra.failed.length === 1, JSON.stringify(e2.extra.failed));
    const w3 = mkWorld({ inv: FULL, unloadedFromX: 3 });
    const d3 = await BP.buildBlueprint(w3.ctx, null, { name: 'hut_west', x: 0, y: 64, z: 0, dry: 1 });
    assert(d3.plan.unloaded > 0 && d3.warnings.some(s => /не загружены/.test(s)), JSON.stringify(d3.plan));
  }

  // ---- бревно: опора только по оси (боковая грань повернёт бревно) ----
  for (const ax of ['x', 'y', 'z']) {
    const ai = { x: 0, y: 1, z: 2 }[ax];
    const cands = BP.buildCandidates({ block: 'oak_log', props: { axis: ax } });
    assert.strictEqual(cands.length, 2, 'две грани по оси ' + ax); assert(cands.every(c => c.off[ai] !== 0), JSON.stringify(cands));
  }

  // ---- прерывание через TaskManager и dispatch (только чтение не занимает тело) ----
  {
    const w = mkWorld({ inv: FULL });
    const ctxd = Object.assign(w.ctx, { ready: true, events: { push() {} }, haltBody() {} });
    ctxd.tasks = new TaskManager(ctxd);
    const { makeDispatcher } = require('../lib/commands');
    const dispatch = makeDispatcher(ctxd);
    const l = await dispatch({ action: 'blueprint_list' });
    assert(l.ok && l.blueprints.some(b => b.name === 'hut_west' && b.materials.cobblestone === 102 && b.size.x === 7));
    const ck = await dispatch({ action: 'blueprint_check', params: { name: 'fence_post_lamp', x: 0, y: 64, z: 0 } });
    assert(ck.ok && ck.total === 5);
    const d = await dispatch({ action: 'build_blueprint', params: { name: 'fence_post_lamp', x: 0, y: 64, z: 0, dry: 1 } });
    assert(d.ok && d.dry && d.missing.spruce_fence === 3 && !d.missing.torch, JSON.stringify(d)); // в FULL есть факелы, заборов нет
    assert.strictEqual(ctxd.tasks.current, null, 'dry не занимает тело');
    let started = await dispatch({ action: 'build_blueprint', params: { name: 'hut_west', x: 0, y: 64, z: 0 } });
    assert(started.ok && started.started === 'build_blueprint', JSON.stringify(started));
    await ctxd.tasks.stop('stop');
    assert.strictEqual(ctxd.tasks.current, null);
    assert(w.log.placed < 100, 'после stop стройка остановилась: ' + w.log.placed);
  }
  console.log('blueprint: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
