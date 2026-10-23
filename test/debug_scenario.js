'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('../lib/util');
const { Task } = require('../lib/tasks');
const A = require('../lib/actions');
const BP = require('../lib/skills/blueprint');
const reg = require('minecraft-data')('1.21.4');
const Block = require('prismarine-block')(reg);

function mkWorld({ inv = {}, blocks = {}, unloadedFromX = null } = {}) {
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
      else if (/_stairs$/.test(name)) props = { facing: fdir, half: face.y < 0 ? 'top' : face.y > 0 ? 'bottom' : (opts && opts.half === 'top' ? 'top' : 'bottom'), shape: 'straight', waterlogged: false };
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
  const ctx = { bot, stats, statsDirty: false, bpFast: true, blueprintDir: BP_DIR };
  return { bot, ctx, set, get, stock, log, map };
}
const HD = ['north', 'east', 'south', 'west'];
const DV = { north: [0, 0, -1], east: [1, 0, 0], south: [0, 0, 1], west: [-1, 0, 0] };
const dirOfYaw = yaw => { const dx = -Math.sin(yaw), dz = -Math.cos(yaw); return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'); };

A.goto = async (ctx, t, goal) => {
  t.check();
  const g = goal.goals ? goal.goals[0] : goal;
  const bot = ctx.bot; bot.entity.position = new Vec3(g.x + 2.5, g.y, g.z + 0.5);
};
A.pickupDrops = async () => {};
const task = () => new Task(1, 'build_blueprint', {}, 'brain');
const tmpBp = (files) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-bp-')); for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n + '.txt'), t); return dir; };
const srcDir = require('../lib/skills/blueprint').BLUEPRINT_DIR;
const files = {};
for (const n of fs.readdirSync(srcDir)) if (n.endsWith('.txt')) files[n.slice(0, -4)] = fs.readFileSync(path.join(srcDir, n), 'utf8');
const BP_DIR = tmpBp(files);

async function main() {
  // Load hut_west blueprint
  const hut = BP.loadBlueprint({ bot: { registry: reg }, blueprintDir: BP_DIR }, 'hut_west');
  console.log('Blueprint materials:', hut.materials);
  console.log('Total cells:', hut.cells.length);
  
  // Instantiate at 0,64,0
  const inst = BP.instantiate(hut, 0, 64, 0, 0);
  console.log('Instance size:', inst.size);
  console.log('Instance cells:', inst.cells.length);
  
  // Create world with floor (layer 0) and layer 1 walls already built
  const w = mkWorld({ 
    inv: { cobblestone: 55, spruce_log: 13, spruce_planks: 51, spruce_door: 3, spruce_fence: 4, torch: 4 } 
  });
  
  // Place floor (layer 0) - 49 cobblestone
  for (const c of inst.cells) {
    if (c.ly === 0 && c.kind === 'block') {
      w.set(c.x, c.y, c.z, c.block, c.props);
    }
  }
  
  // Place layer 1 walls (ly === 1)
  for (const c of inst.cells) {
    if (c.ly === 1 && c.kind === 'block') {
      w.set(c.x, c.y, c.z, c.block, c.props);
    }
  }
  
  // Count placed
  let placedCount = 0;
  for (const c of inst.cells) {
    if (c.kind === 'block' && !c.implied) {
      const b = w.bot.blockAt(new Vec3(c.x, c.y, c.z));
      if (b && b.name === c.block) placedCount++;
    }
  }
  console.log('Pre-placed cells:', placedCount);
  
  // Now analyze
  const an = BP.analyze(w.bot, inst.cells, w.ctx);
  console.log('Analyze counts:', an.counts);
  console.log('Analyze need:', an.need);
  
  // Check have
  const have = {};
  for (const k of Object.keys(an.need)) have[k] = A.invCount(w.bot, k);
  console.log('Have:', have);
  
  // Check missing
  const missing = {};
  for (const [k, n] of Object.entries(an.need)) { const lack = n - A.invCount(w.bot, k); if (lack > 0) missing[k] = lack; }
  console.log('Missing:', missing);
  
  // Check any
  const any = Object.entries(an.need).some(([k, n]) => n > 0 && (have[k] || 0) > 0);
  console.log('Any have:', any);
  
  // Check onlyScaffold
  const onlyScaffold = Object.keys(missing).every(k => !an.need[k]);
  console.log('Only scaffold:', onlyScaffold);
  
  // Now run buildBlueprint
  console.log('\n--- Running buildBlueprint ---');
  try {
    const res = await BP.buildBlueprint(w.ctx, task(), { name: 'hut_west', x: 0, y: 64, z: 0 });
    console.log('Result:', JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('Error:', e.message);
    if (e.extra) {
      console.log('Extra:', JSON.stringify(e.extra, null, 2).slice(0, 2000));
    }
  }
  
  console.log('\nLog placed:', w.log.placed);
  console.log('Log dug:', w.log.dug);
  
  fs.rmSync(BP_DIR, { recursive: true, force: true });
}

main().catch(e => { console.error(e); process.exit(1); });