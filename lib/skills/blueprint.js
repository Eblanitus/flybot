// Постройки по чертежам: build_blueprint (dry=1 — только смета), blueprint_list, blueprint_check.
// Чертёж — текстовый файл brain/blueprints/<имя>.txt (формат — в brain/blueprints/README.md):
//   легенда `C = cobblestone`, слои снизу вверх (`layer 0`…), строки слоя — с севера на юг, символы — с запада на восток,
//   `.` = воздух (вырезать), пробел = не трогать.
// Мир видим только через bot.blockAt (в пределах загруженного). Прерывание — через t.check()/A.goto, как у других навыков.
'use strict';
const fs = require('fs');
const path = require('path');
const { goals } = require('mineflayer-pathfinder');
const { Vec3, SkillError } = require('../util');
const A = require('../actions');

const BLUEPRINT_DIR = path.join(__dirname, '..', '..', 'brain', 'blueprints');
const MAX_SIDE = 64, MAX_CELLS = 8000;

// ---------- справочники ----------
const HDIRS = ['north', 'east', 'south', 'west']; // по часовой стрелке сверху
const DIRV = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' };
const ALL6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]; // порядок: снизу, с боков, сверху
const DOWN = [0, -1, 0], UP = [0, 1, 0];
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
// как в build.js: трава/снег/цветы — не препятствие (сначала ломаем, потом ставим)
const PLANTS = /^(short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|hanging_roots|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z]+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|torchflower|pink_petals|leaf_litter|wildflowers|firefly_bush|bush|brown_mushroom|red_mushroom|fire)$/;
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'light', 'test_block', 'test_instance_block']);
// чужое добро: сами не ломаем
const PROTECTED = /(^|_)(chest|barrel|furnace|smoker|crafting_table|bed|shulker_box|spawner|beacon|enchanting_table|anvil|lectern|jukebox|brewing_stand|cauldron|bell)$/;
// свойства, которые при сравнении не учитываем (считаются сервером или меняются игрой)
const IGNORE_PROPS = new Set(['open', 'powered', 'waterlogged', 'hinge', 'shape', 'north', 'south', 'east', 'west', 'up', 'down', 'lit', 'distance', 'persistent', 'snowy', 'instrument', 'note', 'triggered', 'locked', 'attached', 'in_wall', 'bottom', 'age']);
const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'netherrack', 'coarse_dirt', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate'];
const ITEM_OF = { wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch' };

const FLOOR_ONLY = /^(torch|soul_torch|redstone_torch|[a-z_]+_carpet|[a-z_]+_pressure_plate|[a-z_]+_candle|[a-z_]+_sapling|rail|powered_rail|detector_rail|activator_rail|flower_pot|redstone_wire|repeater|comparator|[a-z_]+_banner|[a-z_]+_sign|[a-z_]+_door)$/;
const FACE_NORMAL = /wall_(torch|sign|hanging_sign|banner|head|skull|fan)$|^ladder$|_button$|^tripwire_hook$/;
const OPPOSITE_FACING = /^(furnace|blast_furnace|smoker|chest|trapped_chest|ender_chest|barrel|dispenser|dropper|lectern|loom|stonecutter|grindstone|carved_pumpkin|jack_o_lantern|bell|repeater|comparator|[a-z_]+_glazed_terracotta)$/;

const k3 = (x, y, z) => x + ',' + y + ',' + z;
const vec = c => new Vec3(c.x, c.y, c.z);
const isDry = p => p && (p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true');
const yawOf = dir => Math.atan2(-DIRV[dir][0], -DIRV[dir][2]); // mineflayer: yaw 0 = север, π/2 = запад

function itemNameFor(block) {
  if (ITEM_OF[block]) return ITEM_OF[block];
  const m = /^(.*)_wall_(sign|hanging_sign|banner|head|skull)$/.exec(block);
  if (m) return m[1] + '_' + m[2];
  return block;
}

// ---------- разбор формата ----------
function parseBlueprint(text, { name = '?', registry = null } = {}) {
  const errors = [];
  const err = (ln, msg) => errors.push(`строка ${ln}: ${msg}`);
  const meta = {};
  const legend = { '.': { kind: 'air' } };
  const layers = new Map(); // индекс слоя -> [{text, ln}]
  let inLayers = false, cur = null;
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const ln = i + 1, trimmed = raw.trim();
    if (trimmed.startsWith('#')) { // комментарий или мета «# ключ: значение»
      const m = /^#\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(trimmed);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      return;
    }
    const lm = /^layer\s+(\d+)(?:\s*-\s*(\d+))?\s*:?$/i.exec(trimmed);
    if (lm) {
      inLayers = true;
      const a = Number(lm[1]), b = lm[2] != null ? Number(lm[2]) : a;
      if (b < a) { err(ln, `диапазон слоёв ${a}-${b} задом наперёд`); cur = []; return; }
      if (b - a > MAX_SIDE) { err(ln, 'слишком много слоёв'); cur = []; return; }
      const arr = [];
      for (let k = a; k <= b; k++) {
        if (layers.has(k)) err(ln, `слой ${k} уже описан`);
        const rows = []; layers.set(k, rows); arr.push(rows);
      }
      cur = arr;
      return;
    }
    if (!inLayers) { // легенда
      if (!trimmed) return;
      const m = /^(\S)\s*=\s*(\S.*)$/.exec(trimmed);
      if (!m) { err(ln, `ожидалась легенда «X = блок свойство=значение», «layer N» или комментарий: «${trimmed.slice(0, 40)}»`); return; }
      const ch = m[1];
      if (ch === '#' || ch === '|') { err(ln, `символ «${ch}» нельзя использовать в легенде`); return; }
      if (legend[ch] && ch !== '.') { err(ln, `символ «${ch}» уже описан`); return; }
      const tok = m[2].replace(/\s+#.*$/, '').split(/\s+/);
      const block = tok[0].replace(/^minecraft:/, '').toLowerCase();
      if (ch === '.' && block !== 'air') { err(ln, '«.» всегда воздух'); return; }
      const props = {};
      let bad = false;
      for (const t of tok.slice(1)) {
        const pm = /^([a-z_]+)=([A-Za-z0-9_]+)$/.exec(t);
        if (!pm) { err(ln, `свойство «${t}» — нужен вид ключ=значение`); bad = true; break; }
        props[pm[1]] = pm[2].toLowerCase();
      }
      if (bad) return;
      if (block === 'air' || block === 'cave_air') legend[ch] = { kind: 'air' };
      else legend[ch] = { kind: 'block', block, props: Object.keys(props).length ? props : null, item: itemNameFor(block) };
      return;
    }
    if (!trimmed) return;
    if (!cur) { err(ln, 'строка слоя вне слоя'); return; }
    if (/\t/.test(raw)) { err(ln, 'табуляция в строке слоя — используй пробелы'); return; }
    let content;
    const pm = /^\s*\|(.*)\|\s*$/.exec(raw);
    content = pm ? pm[1] : raw.replace(/\s+$/, '');
    for (const rows of cur) rows.push({ text: content, ln });
  });
  if (!layers.size) errors.push('нет ни одного слоя (layer 0 …)');

  // проверка легенды по реестру
  if (registry) {
    for (const [ch, def] of Object.entries(legend)) {
      if (def.kind !== 'block') continue;
      const bd = registry.blocksByName[def.block];
      if (!bd) { errors.push(`легенда «${ch}»: неизвестный блок ${def.block}`); continue; }
      if (!registry.itemsByName[def.item]) errors.push(`легенда «${ch}»: ${def.block} нельзя поставить из рук (нет предмета ${def.item})`);
      for (const [k, v] of Object.entries(def.props || {})) {
        const st = (bd.states || []).find(s => s.name === k);
        if (!st) { errors.push(`легенда «${ch}»: у ${def.block} нет свойства ${k} (есть: ${(bd.states || []).map(s => s.name).join(', ') || '—'})`); continue; }
        if (st.type === 'enum' && st.values && !st.values.includes(v)) errors.push(`легенда «${ch}»: ${k}=${v} не бывает, допустимо: ${st.values.join('|')}`);
        if (st.type === 'bool' && v !== 'true' && v !== 'false') errors.push(`легенда «${ch}»: ${k} — true|false`);
      }
      if (def.props && def.props.type === 'double') errors.push(`легенда «${ch}»: type=double не поддерживается — рисуй два слоя`);
    }
  }

  // клетки
  let W = 0, D = 0, H = 0;
  for (const [idx, rows] of layers) { H = Math.max(H, idx + 1); D = Math.max(D, rows.length); for (const r of rows) W = Math.max(W, r.text.length); }
  if (W > MAX_SIDE || D > MAX_SIDE || H > MAX_SIDE) errors.push(`чертёж больше ${MAX_SIDE} блоков по стороне (${W}x${H}x${D})`);
  const cells = [];
  const grid = new Map();
  if (W <= MAX_SIDE && D <= MAX_SIDE && H <= MAX_SIDE) {
    for (const [ly, rows] of [...layers].sort((a, b) => a[0] - b[0])) {
      rows.forEach((row, lz) => {
        for (let lx = 0; lx < row.text.length; lx++) {
          const ch = row.text[lx];
          if (ch === ' ') continue;
          const def = legend[ch];
          if (!def) { err(row.ln, `символ «${ch}» (колонка ${lx + 1}, слой ${ly}) не описан в легенде`); continue; }
          const cell = def.kind === 'air'
            ? { lx, ly, lz, kind: 'air', block: 'air', props: null, item: null, implied: false }
            : { lx, ly, lz, kind: 'block', block: def.block, props: def.props ? { ...def.props } : null, item: def.item, implied: false };
          cells.push(cell); grid.set(k3(lx, ly, lz), cell);
        }
      });
    }
  }
  // двери: рисуется нижняя половина, верхняя достраивается сама
  for (const c of [...cells]) {
    if (c.kind !== 'block' || !/_door$/.test(c.block)) continue;
    const half = c.props && c.props.half;
    if (half === 'upper') { c.implied = true; continue; }
    c.props = { ...(c.props || {}), half: 'lower' };
    const up = grid.get(k3(c.lx, c.ly + 1, c.lz));
    if (up) {
      if (up.block === c.block && up.props && up.props.half === 'upper') { up.implied = true; c.pairLocal = up; }
      else errors.push(`дверь в (${c.lx},${c.ly},${c.lz}): клетка над ней занята (${up.block}) — оставь там пробел`);
    } else {
      const u = { lx: c.lx, ly: c.ly + 1, lz: c.lz, kind: 'block', block: c.block, props: { ...c.props, half: 'upper' }, item: c.item, implied: true };
      cells.push(u); grid.set(k3(u.lx, u.ly, u.lz), u); c.pairLocal = u;
      H = Math.max(H, u.ly + 1);
    }
  }
  if (cells.length > MAX_CELLS) errors.push(`слишком много клеток: ${cells.length} (максимум ${MAX_CELLS})`);
  if (meta.origin && !/nw|северо|north.?west/i.test(meta.origin)) errors.push(`# origin: поддерживается только северо-западный нижний угол (получено «${meta.origin}»)`);
  if (!cells.length && !errors.length) errors.push('в чертеже нет ни одной клетки');
  if (errors.length) throw new SkillError(`чертёж ${name}: ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? ` …и ещё ${errors.length - 8}` : ''}`, { errors });

  const materials = {};
  for (const c of cells) if (c.kind === 'block' && !c.implied) materials[c.item] = (materials[c.item] || 0) + 1;
  return { name, meta, W, D, H, layers: layers.size, cells, materials };
}

function normRot(r) {
  if (r === undefined || r === null || r === '') return 0;
  const n = Number(r);
  if (!Number.isFinite(n) || n % 90 !== 0) throw new SkillError('rot: 0|90|180|270');
  return ((n % 360) + 360) % 360;
}

function rotateProps(props, steps) {
  if (!props) return null;
  const out = { ...props };
  if (HDIRS.includes(out.facing)) out.facing = HDIRS[(HDIRS.indexOf(out.facing) + steps) % 4];
  if (out.axis && steps % 2) out.axis = out.axis === 'x' ? 'z' : out.axis === 'z' ? 'x' : out.axis;
  if (out.rotation != null && /^\d+$/.test(out.rotation)) out.rotation = String((Number(out.rotation) + 4 * steps) % 16);
  return out;
}

// Чертёж -> клетки в мире. (x,y,z) — северо-западный нижний угол ПОВЁРНУТОГО чертежа (минимальные x, y, z).
// Поворот rot — по часовой стрелке при взгляде сверху (север сверху).
function instantiate(bp, x, y, z, rot) {
  const steps = normRot(rot) / 90, W = bp.W, D = bp.D;
  const size = { x: steps % 2 ? D : W, y: bp.H, z: steps % 2 ? W : D };
  const byLocal = new Map();
  const cells = bp.cells.map(c => {
    let rx, rz;
    if (steps === 0) { rx = c.lx; rz = c.lz; } else if (steps === 1) { rx = D - 1 - c.lz; rz = c.lx; } else if (steps === 2) { rx = W - 1 - c.lx; rz = D - 1 - c.lz; } else { rx = c.lz; rz = W - 1 - c.lx; }
    const wc = { ...c, x: x + rx, y: y + c.ly, z: z + rz, props: rotateProps(c.props, steps), upper: null, state: null };
    wc.key = k3(wc.x, wc.y, wc.z);
    byLocal.set(c, wc);
    return wc;
  });
  for (const wc of cells) if (wc.pairLocal) { wc.upper = byLocal.get(wc.pairLocal) || null; delete wc.pairLocal; }
  return { cells, size, bounds: { x1: x, y1: y, z1: z, x2: x + size.x - 1, y2: y + size.y - 1, z2: z + size.z - 1 } };
}

// ---------- сравнение с миром ----------
function propDiff(cell, b) {
  if (!cell.props || !b || typeof b.getProperties !== 'function') return [];
  let have; try { have = b.getProperties(); } catch (e) { return []; }
  if (!have) return [];
  const out = [];
  for (const [k, v] of Object.entries(cell.props)) {
    if (IGNORE_PROPS.has(k) || !(k in have)) continue;
    if (String(have[k]) !== String(v)) out.push(`${k}: получилось ${have[k]}, нужно ${v}`);
  }
  return out;
}

// свой верстак (поставила муха, вещей в нём нет) в клетке чертежа — не «чужое»: снять и поставить блок чертежа
// (хижина hut_west стояла на 243/245: автопилот сам поставил crafting_table в клетку стены). Сундук/печь — с вещами, их не трогаем.
const FREE_OWN = new Set(['crafting_table']);
function ownFree(ctx, b) {
  if (!ctx || !ctx.ownBlocks || !b || !b.position || !FREE_OWN.has(b.name)) return false;
  try { return !!ctx.ownBlocks.get(b.position); } catch (e) { return false; }
}

// состояния: ok | place | replace | badprops | cut | fluid | protected | unloaded
function classify(cell, b, ctx) {
  if (!b) return 'unloaded';
  const n = b.name;
  const prot = UNBREAKABLE.has(n) || (PROTECTED.test(n) && !ownFree(ctx, b));
  if (cell.kind === 'air') {
    if (AIR_NAMES.has(n) || PLANTS.test(n)) return 'ok';
    if (n === 'water' || n === 'lava') return 'fluid';
    if (prot) return 'protected';
    return 'cut';
  }
  if (n === cell.block) return propDiff(cell, b).length ? 'badprops' : 'ok';
  if (AIR_NAMES.has(n) || n === 'water' || n === 'lava') return 'place';
  if (prot) return 'protected';
  return 'replace';
}
const NEED_STATES = new Set(['place', 'replace', 'badprops', 'unloaded']);

function analyze(bot, cells, ctx) {
  const counts = { ok: 0, place: 0, replace: 0, badprops: 0, cut: 0, fluid: 0, protected: 0, unloaded: 0 };
  for (const c of cells) { c.state = classify(c, bot.blockAt(vec(c)), ctx); }
  for (const c of cells) { // верхняя половина двери не на месте -> перестраиваем дверь целиком
    if (c.implied) continue;
    if (c.upper && c.state === 'ok' && c.upper.state !== 'ok' && c.upper.state !== 'unloaded') c.state = 'badprops';
  }
  const need = {};
  for (const c of cells) {
    counts[c.state]++;
    if (c.kind === 'block' && !c.implied && NEED_STATES.has(c.state)) need[c.item] = (need[c.item] || 0) + 1;
  }
  return { counts, need };
}

// ---------- как ставить блок ----------
function facingMode(block) {
  if (FACE_NORMAL.test(block)) return 'face';
  if (/_trapdoor$/.test(block)) return 'trapdoor';
  if (OPPOSITE_FACING.test(block)) return 'opposite';
  return 'look';
}

// Варианты установки: [{off:[dx,dy,dz] — где опорный блок относительно клетки, yaw — направление взгляда или null, half}]
function buildCandidates(c) {
  if (c._cands) return c._cands;
  const p = c.props || {}, n = c.block;
  const f = HDIRS.includes(p.facing) ? p.facing : null;
  const half = (p.half === 'top' || p.half === 'bottom') ? p.half : (p.type === 'top' || p.type === 'bottom') ? p.type : null;
  const out = [];
  const add = (off, yaw) => out.push({ off, yaw: yaw || null, half });
  const mode = f ? facingMode(n) : null;
  const behind = () => { const v = DIRV[f]; return [-v[0], 0, -v[2]]; };
  if (mode === 'face' && (!p.face || p.face === 'wall')) add(behind(), null);
  else if (p.face === 'floor') add(DOWN, f);
  else if (p.face === 'ceiling') add(UP, f);
  else if (mode === 'trapdoor') { add(behind(), null); add(half === 'top' ? UP : DOWN, OPP[f]); }
  else {
    const yaw = mode === 'look' ? f : mode === 'opposite' ? OPP[f] : null;
    let offs = ALL6.slice();
    if (n === 'lantern' || n === 'soul_lantern') offs = p.hanging === 'true' ? [UP] : [DOWN];
    else if (FLOOR_ONLY.test(n)) offs = [DOWN];
    // бревно/столб (axis): ось берётся из грани, по которой кликнули, — опора только по оси (боковая грань повернёт бревно)
    if (p.axis) { const ai = { x: 0, y: 1, z: 2 }[p.axis]; offs = offs.filter(o => o[ai] !== 0); }
    if (half === 'top') offs = offs.filter(o => o[1] === 1).concat(offs.filter(o => o[1] === 0), offs.filter(o => o[1] === -1));
    for (const o of offs) add(o, yaw);
  }
  c._cands = out;
  return out;
}
const refOffsets = c => buildCandidates(c).map(x => x.off);
const isConstrained = c => buildCandidates(c).length < 6;

// ---------- мир: опора, подпорки ----------
function makeWorld(bot) {
  const overlay = new Map();
  const reg = bot.registry;
  const solidBlockName = n => { const b = reg.blocksByName[n]; return !!b && b.boundingBox === 'block'; };
  const solid = (x, y, z) => {
    const k = k3(x, y, z);
    if (overlay.has(k)) return overlay.get(k);
    return A.isSolid(bot.blockAt(new Vec3(x, y, z)));
  };
  const airReal = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && A.isAirLike(b) && b.name !== 'water' && b.name !== 'lava'; };
  return { overlay, solid, solidBlockName, airReal };
}

const hasSupport = (c, solid) => refOffsets(c).some(o => solid(c.x + o[0], c.y + o[1], c.z + o[2]));
const d2 = (c, from) => (c.x + 0.5 - from.x) ** 2 + (c.y + 0.5 - from.y) ** 2 + (c.z + 0.5 - from.z) ** 2;
function nearest(list, from) {
  let best = null, bd = Infinity;
  for (const c of list) {
    const d = d2(c, from) + c.y * 1e-6 + c.x * 1e-9 + c.z * 1e-12; // ничья — детерминированно
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// Цепочка подпорок (≤3) от ближайшего твёрдого блока к клетке c. Порядок — как ставить. null, если не выйдет.
function findChain(c, env) {
  const seen = new Set([c.key]);
  const hasSolidNb = p => ALL6.some(o => { const x = p.x + o[0], y = p.y + o[1], z = p.z + o[2]; return k3(x, y, z) !== c.key && env.solid(x, y, z); });
  let frontier = [];
  for (const o of refOffsets(c)) {
    const p = { x: c.x + o[0], y: c.y + o[1], z: c.z + o[2] }, k = k3(p.x, p.y, p.z);
    if (seen.has(k) || !env.free(p.x, p.y, p.z)) continue;
    seen.add(k); frontier.push({ p, path: [p] });
  }
  for (let depth = 1; depth <= 3 && frontier.length; depth++) {
    for (const node of frontier) if (hasSolidNb(node.p)) return node.path.slice().reverse();
    if (depth === 3) break;
    const next = [];
    for (const node of frontier) for (const o of ALL6) {
      const q = { x: node.p.x + o[0], y: node.p.y + o[1], z: node.p.z + o[2] }, k = k3(q.x, q.y, q.z);
      if (seen.has(k) || !env.free(q.x, q.y, q.z)) continue;
      seen.add(k); next.push({ p: q, path: [...node.path, q] });
    }
    frontier = next;
  }
  return null;
}

// Общий планировщик (и для настоящей стройки, и для dry): слой за слоем снизу вверх, ставит клетки с опорой,
// ближайшие к боту первыми; без опоры -> откладывает на конец, потом подпорка из дешёвого блока (и убирает её).
async function runSchedule(cells, env) {
  const byLayer = new Map();
  for (const c of cells) { if (!byLayer.has(c.ly)) byLayer.set(c.ly, []); byLayer.get(c.ly).push(c); }
  const deferred = [];
  for (const ly of [...byLayer.keys()].sort((a, b) => a - b)) {
    const pend = byLayer.get(ly);
    env.layer(ly);
    while (pend.length) {
      env.tick();
      const sup = pend.filter(c => hasSupport(c, env.solid));
      if (!sup.length) { deferred.push(...pend); break; }
      const c = nearest(sup, env.from());
      pend.splice(pend.indexOf(c), 1);
      await env.place(c);
    }
  }
  env.layer(null);
  while (deferred.length) {
    env.tick();
    const sup = deferred.filter(c => hasSupport(c, env.solid));
    if (sup.length) {
      const c = nearest(sup, env.from());
      deferred.splice(deferred.indexOf(c), 1);
      await env.place(c);
      continue;
    }
    const c = nearest(deferred, env.from());
    deferred.splice(deferred.indexOf(c), 1);
    const chain = findChain(c, env);
    if (!chain) { env.fail(c, 'нет опоры: рядом нет твёрдого блока, подпорку до 3 блоков не построить'); continue; }
    const done = [];
    let okc = true;
    for (const p of chain) { if (await env.scaffoldPlace(p, c)) done.push(p); else { okc = false; break; } }
    if (okc) await env.place(c); else env.fail(c, 'не удалось поставить временную подпорку');
    if (isConstrained(c) && okc) env.warn(c, 'подпорка осталась на месте: блок крепится к ней (' + done.length + ' шт.)');
    else for (const p of done.reverse()) await env.scaffoldRemove(p);
  }
}

// ---------- тело: подойти, сломать, поставить ----------
const pause = (ctx, t, ms) => (ctx.bpFast ? Promise.resolve(t.check()) : t.sleep(ms));

async function approach(ctx, t, pos, { digging = false } = {}) {
  const bot = ctx.bot, p = bot.entity.position;
  const d = p.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
  const under = digging && Math.abs(p.x - (pos.x + 0.5)) < 0.9 && Math.abs(p.z - (pos.z + 0.5)) < 0.9 && pos.y < Math.floor(p.y);
  if (d <= 4.2 && !A.blockHitsBot(bot, pos) && !under) return;
  const goal = new goals.GoalCompositeAll([new goals.GoalNear(pos.x, pos.y, pos.z, 3.5), new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5))]);
  await A.goto(ctx, t, goal, { timeout: 40000 });
  await pause(ctx, t, 100);
}

// Сломать блок в pos. true — сломал, false — там и так пусто.
async function removeBlock(ctx, t, pos) {
  const bot = ctx.bot;
  let b = bot.blockAt(pos);
  if (!b) throw new SkillError('чанк не загружен');
  if (AIR_NAMES.has(b.name)) return false;
  if (b.name === 'water' || b.name === 'lava') throw new SkillError('жидкость не вырезать: ' + b.name);
  if (UNBREAKABLE.has(b.name)) throw new SkillError('нельзя ломать: ' + b.name);
  if (PROTECTED.test(b.name) && !ownFree(ctx, b)) throw new SkillError('не ломаю чужое: ' + b.name);
  for (const f of A.FACES) { const nb = bot.blockAt(pos.plus(f)); if (nb && nb.name === 'lava') throw new SkillError('рядом лава — не ломаю'); }
  await approach(ctx, t, pos, { digging: true });
  b = bot.blockAt(pos);
  if (!b || AIR_NAMES.has(b.name)) return false;
  await A.equipToolFor(bot, b);
  const off = t.onAbort(() => { try { bot.stopDigging(); } catch (e) {} });
  try { await bot.dig(b, true); } catch (e) { t.check(); throw new SkillError('не удалось сломать ' + b.name + ': ' + (e && e.message ? e.message : e)); } finally { off(); }
  t.check();
  if (ctx.stats) { ctx.stats.blocksMined = (ctx.stats.blocksMined || 0) + 1; ctx.statsDirty = true; }
  await pause(ctx, t, 80);
  const now = bot.blockAt(pos);
  if (now && now.name === b.name) throw new SkillError(b.name + ' не сломался');
  return true;
}

// Поставить клетку c. Возвращает {warn:[…]|null}; бросает SkillError, если не вышло.
async function putBlock(ctx, t, c) {
  const bot = ctx.bot, pos = vec(c);
  let item = A.findItem(bot, c.item);
  if (!item) throw new SkillError('нет в инвентаре: ' + c.item);
  await approach(ctx, t, pos);
  if (A.blockHitsBot(bot, pos)) throw new SkillError('бот стоит на месте установки');
  const cands = buildCandidates(c);
  let flip = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let why = 'не к чему прислонить блок', diff = null, yawUsed = false;
    for (const cd of cands) {
      const refPos = pos.offset(cd.off[0], cd.off[1], cd.off[2]);
      const refB = bot.blockAt(refPos);
      if (!A.isSolid(refB)) continue;
      t.check();
      item = A.findItem(bot, c.item);
      if (!item) throw new SkillError('нет в инвентаре: ' + c.item);
      await bot.equip(item, 'hand');
      const face = new Vec3(-cd.off[0], -cd.off[1], -cd.off[2]);
      const yawDir = cd.yaw ? (flip ? OPP[cd.yaw] : cd.yaw) : null;
      if (yawDir) { await bot.look(yawOf(yawDir), 0, true); await pause(ctx, t, 120); yawUsed = true; }
      else await bot.lookAt(refPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
      ctx.buildingAt = c.scaffold ? null : `${pos.x},${pos.y},${pos.z}`; // итог дня: блок чертежа — «построено» (lib/daylog.js), подпорка — нет
      try {
        if (bot._placeBlockWithOptions) await bot._placeBlockWithOptions(refB, face, { swingArm: 'right', forceLook: 'ignore', half: cd.half || undefined });
        else await bot.placeBlock(refB, face);
      } catch (e) { why = String(e && e.message ? e.message : e); await pause(ctx, t, 150); }
      finally { ctx.buildingAt = null; } // blockPlaced mineflayer шлёт до возврата placeBlock — как в place_at
      await pause(ctx, t, 60);
      const nb = bot.blockAt(pos);
      if (!nb || AIR_NAMES.has(nb.name) || nb.name === 'water' || nb.name === 'lava' || PLANTS.test(nb.name)) continue; // не встал — пробуем другую грань
      if (nb.name !== c.block) throw new SkillError(`вместо ${c.block} встал ${nb.name}`);
      if (ctx.stats) { ctx.stats.blocksPlaced = (ctx.stats.blocksPlaced || 0) + 1; ctx.statsDirty = true; }
      diff = propDiff(c, nb);
      if (diff.some(s => s.startsWith('facing')) && attempt === 0 && yawUsed) { // направление не то: ломаем и ставим наоборот
        await removeBlock(ctx, t, pos);
        flip = true;
        diff = null;
        break;
      }
      return { warn: diff.length ? diff : null };
    }
    if (diff === null && flip && attempt === 0) continue;
    throw new SkillError(why);
  }
  throw new SkillError('не получилось выставить направление');
}

// ---------- аргументы, чтение чертежей ----------
function bpDir(ctx) { return ctx.blueprintDir || BLUEPRINT_DIR; }
function listNames(ctx) {
  try { return fs.readdirSync(bpDir(ctx)).filter(f => /\.txt$/i.test(f)).map(f => f.replace(/\.txt$/i, '')).sort(); } catch (e) { return []; }
}
function loadBlueprint(ctx, name) {
  name = String(name || '');
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(name)) throw new SkillError('имя чертежа: латиница, цифры, _ и - (получено «' + name + '»)');
  const file = path.join(bpDir(ctx), name + '.txt');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new SkillError(`нет чертежа ${name}; есть: ${listNames(ctx).join(', ') || 'ни одного'}`, { blueprints: listNames(ctx) }); }
  return parseBlueprint(text, { name, registry: ctx.bot ? ctx.bot.registry : null });
}
function argsOf(p) {
  const x = Number(p.x), y = Number(p.y), z = Number(p.z);
  if (![x, y, z].every(Number.isFinite)) throw new SkillError('нужны x, y, z (северо-западный нижний угол постройки)');
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), rot: normRot(p.rot) };
}
const posOf = c => [c.x, c.y, c.z];
function wantStr(c) {
  if (c.kind === 'air') return 'air';
  const pr = Object.entries(c.props || {}).filter(([k]) => !IGNORE_PROPS.has(k)).map(([k, v]) => k + '=' + v).join(',');
  return c.block + (pr ? '[' + pr + ']' : '');
}
function haveStr(c, b) {
  if (!b) return 'не загружено';
  const d = c.state === 'badprops' ? propDiff(c, b) : [];
  return b.name + (d.length ? ' (' + d.join('; ') + ')' : '');
}

// Подпорки: какой предмет и сколько нужно (спрос по симуляции)
function pickScaffold(bot, need, peak) {
  for (const n of SCAFFOLD_ITEMS) if (A.invCount(bot, n) - (need[n] || 0) >= peak) return n;
  return null;
}

// Симуляция порядка: сколько клеток потребуют подпорки и сколько блоков подпорки нужно одновременно
async function simulate(bot, cells, from) {
  const W = makeWorld(bot);
  for (const c of cells) if (c.kind === 'air' && c.state === 'cut') W.overlay.set(c.key, false);
  const targets = new Set(cells.filter(c => c.kind === 'block').map(c => c.key));
  const todo = cells.filter(c => c.kind === 'block' && !c.implied && NEED_STATES.has(c.state));
  const out = { cells: 0, peak: 0, unplaceable: 0 };
  const env = {
    solid: W.solid,
    free: (x, y, z) => { const k = k3(x, y, z); if (targets.has(k)) return false; if (W.overlay.has(k)) return !W.overlay.get(k); return W.airReal(x, y, z); },
    from: () => from, layer() {}, tick() {},
    place: async c => { W.overlay.set(c.key, W.solidBlockName(c.block)); if (c.upper) W.overlay.set(c.upper.key, true); },
    fail: () => { out.unplaceable++; }, warn() {},
    scaffoldPlace: async p => { W.overlay.set(k3(p.x, p.y, p.z), true); out.cells++; return true; },
    scaffoldRemove: async p => { W.overlay.set(k3(p.x, p.y, p.z), false); }
  };
  // пик подпорок: считаем длину самой длинной цепочки
  const origPlace = env.scaffoldPlace; let cur = 0;
  env.scaffoldPlace = async p => { cur++; out.peak = Math.max(out.peak, cur); return origPlace(p); };
  env.scaffoldRemove = async p => { cur = Math.max(0, cur - 1); W.overlay.set(k3(p.x, p.y, p.z), false); };
  await runSchedule(todo, env);
  return out;
}

function haveOf(bot, need) {
  const have = {};
  for (const k of Object.keys(need)) have[k] = A.invCount(bot, k);
  return have;
}

// ---------- навыки ----------
async function prepare(ctx, t, p, { walk } = {}) {
  const bot = ctx.bot;
  const { x, y, z, rot } = argsOf(p);
  const bp = loadBlueprint(ctx, p.name);
  const inst = instantiate(bp, x, y, z, rot);
  let an = analyze(bot, inst.cells, ctx);
  if (walk && an.counts.unloaded) { // часть клеток не загружена — подойти к постройке и посмотреть заново
    const b = inst.bounds;
    const cx = Math.floor((b.x1 + b.x2) / 2), cz = Math.floor((b.z1 + b.z2) / 2);
    try { await A.goto(ctx, t, new goals.GoalNear(cx, b.y1, cz, 8), { timeout: 60000 }); } catch (e) { if (e.aborted) throw e; }
    await pause(ctx, t, 400);
    an = analyze(bot, inst.cells, ctx);
  }
  return { bp, inst, an, x, y, z, rot };
}

function planOf(inst, an, scaffold) {
  const c = an.counts;
  return {
    size: inst.size, layers: inst.size.y, cells: inst.cells.length,
    todo: { place: c.place, replace: c.replace, badprops: c.badprops, cut: c.cut },
    done: c.ok, unloaded: c.unloaded, protected: c.protected, fluid: c.fluid,
    scaffold: scaffold ? { cells: scaffold.cells, peak: scaffold.peak, unplaceable: scaffold.unplaceable } : undefined
  };
}

function missingOf(bot, need, scaf, scaffoldItem) {
  const missing = {};
  for (const [k, n] of Object.entries(need)) { const lack = n - A.invCount(bot, k); if (lack > 0) missing[k] = lack; }
  if (scaf && scaf.peak > 0 && !scaffoldItem) {
    const spare = Math.max(0, A.invCount(bot, 'dirt') - (need.dirt || 0));
    missing.dirt = (missing.dirt || 0) + scaf.peak - spare; // временные подпорки (потом убираются и возвращаются)
  }
  return missing;
}

async function buildBlueprint(ctx, t, p) {
  const bot = ctx.bot;
  const dry = isDry(p);
  const forcePartial = p && (p.partial === true || p.partial === 1 || p.partial === '1');
  if (!dry && !t) throw new SkillError('внутренняя ошибка: нет задачи');
  const { bp, inst, an, x, y, z, rot } = await prepare(ctx, t, p, { walk: !dry });
  const from = bot.entity.position;
  const scaf = an.counts.place + an.counts.replace + an.counts.badprops + an.counts.unloaded ? await simulate(bot, inst.cells, from) : { cells: 0, peak: 0, unplaceable: 0 };
  const scaffoldItem = scaf.peak > 0 ? pickScaffold(bot, an.need, scaf.peak) : null;
  const missing = missingOf(bot, an.need, scaf, scaffoldItem);
  const warnings = [];
  if (an.counts.fluid) warnings.push(`${an.counts.fluid} клеток «воздуха» залиты водой/лавой — не вырезаю`);
  if (an.counts.protected) warnings.push(`${an.counts.protected} клеток заняты чужим/неломаемым — трогать не буду`);
  if (an.counts.unloaded) warnings.push(`${an.counts.unloaded} клеток не загружены — подойди ближе`);
  const base = {
    name: bp.name, at: [x, y, z], rot, need: an.need, needTotal: bp.materials,
    have: haveOf(bot, an.need), missing,
    plan: planOf(inst, an, scaf)
  };
  if (scaffoldItem) base.scaffoldItem = scaffoldItem;
  if (warnings.length) base.warnings = warnings;
  if (dry) return { ok: true, dry: true, ...base };
  if (Object.keys(missing).length && !forcePartial) {
    // нехватка — не повод стоять: строим то, на что материал есть (клетка без предмета в инвентаре уходит в lack, итог — «не достроено … не хватило»);
    // отказ — только когда в сумке нет ни одного нужного предмета (хижина 73/245 два дня стояла из-за ×46 булыжника при 55 в сумке)
    const msg = 'не хватает: ' + Object.entries(missing).map(([k, n]) => `${k} ×${n}`).join(', ');
    const haveAnyNeeded = Object.entries(an.need).some(([k, n]) => n > 0 && A.invCount(bot, k) > 0);
    const onlyScaffold = Object.keys(missing).every(k => !an.need[k]);
    if (!haveAnyNeeded || onlyScaffold) throw new SkillError(msg, { ok: false, error: msg, ...base });
    warnings.push(msg + ' — строю частью');
  } else if (forcePartial && Object.keys(missing).length) {
    warnings.push('не хватает: ' + Object.entries(missing).map(([k, n]) => `${k} ×${n}`).join(', ') + ' — строю частью (partial=1)');
  }

  // ----- стройка -----
  const res = { placed: 0, removed: 0, skipped: an.counts.ok, failed: [], warnings: [...warnings], lack: {} };
  const scafStat = { placed: 0, removed: 0, left: 0 };
  const W = makeWorld(bot);
  const fail = (c, why) => { res.failed.push({ x: c.x, y: c.y, z: c.z, block: c.kind === 'air' ? 'air' : c.block, why }); };
  const targets = new Set(inst.cells.filter(c => c.kind === 'block').map(c => c.key));
  let consecutiveWalkFails = 0;
  const walkGuard = e => { // подряд несколько провалов пути: дальше нет смысла
    if (e && e.aborted) throw e;
    if (/нет пути|слишком долго|путь не найден/.test(String(e && e.message))) { if (++consecutiveWalkFails >= 5) throw new SkillError('не могу подойти к постройке (5 раз подряд нет пути): ' + e.message, { ok: false, partial: res }); } else consecutiveWalkFails = 0;
  };
  const toPlace = inst.cells.filter(c => c.kind === 'block' && !c.implied && NEED_STATES.has(c.state));
  let doneCount = 0;

  // 1) вырезать «.»
  const cuts = inst.cells.filter(c => c.kind === 'air' && c.state === 'cut');
  // занятые чужим (сундук и т.п.) — и «воздух», и клетки блоков: в стройку они не идут, но в итоге названы честно
  const protectedAir = inst.cells.filter(c => !c.implied && c.state === 'protected');
  for (const c of protectedAir) fail(c, 'занято чужим/неломаемым: ' + (bot.blockAt(vec(c)) || {}).name);
  let cutLeft = cuts.slice();
  let cutDone = 0;
  while (cutLeft.length) {
    t.check();
    const topY = Math.max(...cutLeft.map(c => c.y));
    const c = nearest(cutLeft.filter(q => q.y === topY), bot.entity.position);
    cutLeft.splice(cutLeft.indexOf(c), 1);
    t.progress(`вырезаю ${++cutDone}/${cuts.length}`);
    try { if (await removeBlock(ctx, t, vec(c))) res.removed++; W.overlay.set(c.key, false); consecutiveWalkFails = 0; } catch (e) { walkGuard(e); fail(c, e.message || String(e)); }
  }
  if (cuts.length && !ctx.bpFast) { try { await A.pickupDrops(ctx, t, vec(inst.cells[0]).offset(inst.size.x / 2, 0, inst.size.z / 2), Math.max(inst.size.x, inst.size.z) + 3, 5000); } catch (e) { if (e.aborted) throw e; } }

  // 2) ставить слой за слоем
  const env = {
    solid: W.solid,
    free: (xx, yy, zz) => { const k = k3(xx, yy, zz); if (targets.has(k)) return false; if (W.overlay.has(k)) return !W.overlay.get(k); return W.airReal(xx, yy, zz); },
    from: () => bot.entity.position,
    layer: ly => { t.progress(ly == null ? 'достраиваю клетки без опоры' : `слой ${ly}/${inst.size.y - 1}`); },
    tick: () => { t.check(); },
    fail, warn: (c, msg) => res.warnings.push(`(${c.x} ${c.y} ${c.z}) ${msg}`),
    place: async c => {
      t.check();
      t.progress(`слой ${c.ly}: ${doneCount}/${toPlace.length}`);
      try {
        let b = bot.blockAt(vec(c));
        let st = classify(c, b, ctx);
        if (c.upper && st === 'ok' && classify(c.upper, bot.blockAt(vec(c.upper)), ctx) !== 'ok') st = 'badprops';
        if (st === 'ok') { res.skipped++; W.overlay.set(c.key, W.solidBlockName(c.block)); doneCount++; return; }
        if (st === 'unloaded') { fail(c, 'чанк не загружен'); return; }
        if (st === 'protected') { fail(c, 'занято чужим/неломаемым: ' + b.name); return; }
        if (!A.invCount(bot, c.item)) { res.lack[c.item] = (res.lack[c.item] || 0) + 1; fail(c, 'нет в инвентаре: ' + c.item); return; }
        if (st === 'replace' || st === 'badprops') {
          if (await removeBlock(ctx, t, vec(c))) res.removed++;
          W.overlay.set(c.key, false);
        }
        if (c.upper) { // над дверью должно быть свободно
          const ub = bot.blockAt(vec(c.upper));
          if (ub && !AIR_NAMES.has(ub.name) && ub.name !== 'water') { if (await removeBlock(ctx, t, vec(c.upper))) res.removed++; }
        }
        const r = await putBlock(ctx, t, c);
        res.placed++; doneCount++; consecutiveWalkFails = 0;
        W.overlay.set(c.key, W.solidBlockName(c.block));
        if (c.upper) {
          const ub = bot.blockAt(vec(c.upper));
          if (ub && ub.name === c.upper.block) W.overlay.set(c.upper.key, true);
          else res.warnings.push(`(${c.x} ${c.y} ${c.z}) вторая половина двери не появилась`);
        }
        if (r.warn) res.warnings.push(`(${c.x} ${c.y} ${c.z}) ${c.block}: ${r.warn.join('; ')}`);
      } catch (e) { walkGuard(e); fail(c, e.message || String(e)); }
    },
    scaffoldPlace: async (pp, forCell) => {
      if (!scaffoldItem || !A.invCount(bot, scaffoldItem)) return false;
      try {
        await putBlock(ctx, t, { x: pp.x, y: pp.y, z: pp.z, kind: 'block', block: scaffoldItem, props: null, item: scaffoldItem, scaffold: true }); // подпорка — не стройка (итог дня: служебный)
        W.overlay.set(k3(pp.x, pp.y, pp.z), true); scafStat.placed++; return true;
      } catch (e) { if (e.aborted) throw e; return false; }
    },
    scaffoldRemove: async pp => {
      try { if (await removeBlock(ctx, t, new Vec3(pp.x, pp.y, pp.z))) scafStat.removed++; W.overlay.set(k3(pp.x, pp.y, pp.z), false); } catch (e) { if (e.aborted) throw e; scafStat.left++; res.warnings.push(`подпорка (${pp.x} ${pp.y} ${pp.z}) не убрана: ${e.message}`); }
    }
  };
  const blockCells = inst.cells.filter(c => c.kind === 'block' && !c.implied && NEED_STATES.has(c.state));
  await runSchedule(blockCells, env);
  if (!ctx.bpFast) { try { await A.pickupDrops(ctx, t, vec(inst.cells[0]).offset(inst.size.x / 2, 0, inst.size.z / 2), Math.max(inst.size.x, inst.size.z) + 3, 5000); } catch (e) { if (e.aborted) throw e; } }

  // 3) итоговая сверка
  const fin = analyze(bot, inst.cells, ctx);
  const bad = fin.counts.place + fin.counts.replace + fin.counts.badprops + fin.counts.cut + fin.counts.protected + fin.counts.unloaded;
  const missingNow = {};
  for (const [k, n] of Object.entries(res.lack)) missingNow[k] = n;
  const result = {
    ok: res.failed.length === 0 && bad === 0,
    name: bp.name, at: [x, y, z], rot,
    placed: res.placed, removed: res.removed, skipped: res.skipped,
    failed: res.failed.slice(0, 40), ...(res.failed.length > 40 ? { failedCount: res.failed.length } : {}),
    missing: missingNow, matched: fin.counts.ok, total: inst.cells.length
  };
  if (scafStat.placed) result.scaffold = scafStat;
  if (res.warnings.length) result.warnings = res.warnings.slice(0, 30);
  if (!result.ok) {
    const f0 = res.failed[0];
    const msg = `не достроено: ${inst.cells.length - fin.counts.ok} из ${inst.cells.length} клеток${f0 ? `; например (${f0.x} ${f0.y} ${f0.z}) ${f0.block}: ${f0.why}` : ''}${Object.keys(missingNow).length ? '; не хватило: ' + Object.entries(missingNow).map(([k, n]) => `${k} ×${n}`).join(', ') : ''}`;
    result.error = msg;
    throw new SkillError(msg, result);
  }
  return result;
}

function blueprintList(ctx) {
  const out = [];
  for (const name of listNames(ctx)) {
    try {
      const bp = loadBlueprint(ctx, name);
      out.push({ name, size: { x: bp.W, y: bp.H, z: bp.D }, layers: bp.layers, cells: bp.cells.length, ...(bp.meta.desc ? { desc: bp.meta.desc } : {}), materials: bp.materials });
    } catch (e) { out.push({ name, error: e.message }); }
  }
  return { blueprints: out, dir: 'brain/blueprints' };
}

function blueprintCheck(ctx, p) {
  const bot = ctx.bot;
  const { x, y, z, rot } = argsOf(p);
  const bp = loadBlueprint(ctx, p.name);
  const inst = instantiate(bp, x, y, z, rot);
  const an = analyze(bot, inst.cells, ctx);
  const bad = inst.cells.filter(c => c.state !== 'ok')
    .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const matched = an.counts.ok;
  return {
    name: bp.name, at: [x, y, z], rot, size: inst.size, total: inst.cells.length, matched,
    percent: Math.round(matched * 1000 / inst.cells.length) / 10, complete: bad.length === 0,
    mismatchCount: bad.length,
    mismatches: bad.slice(0, 20).map(c => ({ x: c.x, y: c.y, z: c.z, want: wantStr(c), have: haveStr(c, bot.blockAt(vec(c))), why: c.state })),
    ...(an.counts.unloaded ? { unloaded: an.counts.unloaded } : {})
  };
}

// только чтение: тело не занимает (как survey)
const RO = { blueprintlist: 'blueprint_list', blueprintcheck: 'blueprint_check' };
function isReadOnly(actionNorm, p) { return !!RO[actionNorm] || (actionNorm === 'buildblueprint' && isDry(p || {})); }
async function runReadOnly(ctx, actionNorm, p) {
  if (actionNorm === 'blueprintlist') return { ok: true, ...blueprintList(ctx) };
  if (actionNorm === 'blueprintcheck') return { ok: true, ...blueprintCheck(ctx, p) };
  return buildBlueprint(ctx, null, p);
}

// сигнатура навыка тела: (ctx, task, params)
const blueprintListSkill = async ctx => blueprintList(ctx);
const blueprintCheckSkill = async (ctx, t, p) => blueprintCheck(ctx, p);

module.exports = {
  buildBlueprint, blueprintListSkill, blueprintCheckSkill,
  blueprintList, blueprintCheck, isReadOnly, runReadOnly,
  parseBlueprint, instantiate, classify, analyze, loadBlueprint, propDiff, normRot, buildCandidates, facingMode, itemNameFor, BLUEPRINT_DIR,
  ownFree
};
