// survey: компактный снимок объёма мира для мозга (только чтение, тело не двигает).
// Честное зрение: блок попадает в снимок, только если виден (линия видимости) или запомнен; остальное — '?'.
'use strict';
const { Vec3, num, SkillError } = require('./util');
const vision = require('./vision');

const MAX_VOLUME = 4096;
const MAX_EDGES = 200;
const AIR = new Set(['air', 'cave_air', 'void_air']);

// Предпочтительные коды, остальные блоки получают свободные символы по очереди
const PREFERRED = {
  stone: '#', cobblestone: 'c', dirt: 'd', grass_block: 'g', short_grass: ',', tall_grass: ';', snow: '*', snow_block: 'S',
  water: '~', lava: '!', sand: 's', gravel: 'r', bedrock: 'B', deepslate: 'D', cobbled_deepslate: 'C', netherrack: 'n',
  oak_log: 'L', oak_leaves: 'l', oak_planks: 'p', coal_ore: 'o', iron_ore: 'i', copper_ore: 'u', gold_ore: 'G',
  diamond_ore: 'Y', redstone_ore: 'R', andesite: 'a', diorite: 'e', granite: 't', tuff: 'T', clay: 'k', torch: 'f',
  ice: 'I', obsidian: 'O', mud: 'm', podzol: 'z', mycelium: 'y'
};
const POOL = 'abcdefhijklmnopqrstuvwxyzABCDEFGHJKLMNOPQRTUVWXYZ0123456789%&@$+=^';

const DIR_OF = [[1, 0, 'В'], [-1, 0, 'З'], [0, 1, 'Ю'], [0, -1, 'С']]; // x+ восток, z+ юг

function parseVolume(bot, p) {
  const has = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].some(k => p[k] != null);
  let a, b;
  if (has) {
    const v = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].map(k => Number(p[k]));
    if (!v.every(Number.isFinite)) throw new SkillError('для survey по координатам нужны все числа x1,y1,z1,x2,y2,z2');
    a = new Vec3(v[0], v[1], v[2]).floored(); b = new Vec3(v[3], v[4], v[5]).floored();
  } else {
    const r = Math.floor(num(p.radius, 6, 0, 64)), dy = Math.floor(num(p.dy, 3, 0, 64));
    const c = bot.entity.position.floored();
    a = new Vec3(c.x - r, c.y - dy, c.z - r); b = new Vec3(c.x + r, c.y + dy, c.z + r);
  }
  const min = new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  const max = new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  const vol = size.x * size.y * size.z;
  if (vol > MAX_VOLUME) throw new SkillError(`объём слишком большой: ${size.x}×${size.y}×${size.z} = ${vol} блоков, максимум ${MAX_VOLUME}. Уменьши область или radius/dy`);
  return { min, max, size };
}

function survey(ctx, p = {}) {
  const bot = ctx.bot;
  const { min, max, size } = parseVolume(bot, p);
  const known = vision.makeProbe(ctx); // известно ли содержимое клетки: видно / помнится / вплотную к боту
  let hidden = 0;
  const legend = { '.': 'air' }; const codeOf = {};
  const used = new Set(['.', '?']);
  let poolI = 0;
  const code = name => {
    if (codeOf[name]) return codeOf[name];
    let c = PREFERRED[name];
    if (!c || used.has(c)) { while (poolI < POOL.length && used.has(POOL[poolI])) poolI++; c = POOL[poolI++] || '_'; }
    used.add(c); codeOf[name] = c; legend[c] = name;
    return c;
  };

  // grid[y][z][x] = имя блока | '?' (не загружен или не виден); solid — твёрдый ли
  const layers = {};
  const topSolid = []; // [dz][dx] = y | null
  const hasUnknown = [];
  for (let dz = 0; dz < size.z; dz++) { topSolid.push(new Array(size.x).fill(null)); hasUnknown.push(new Array(size.x).fill(false)); }
  let unloaded = 0;
  for (let y = max.y; y >= min.y; y--) {
    const rows = [];
    for (let dz = 0; dz < size.z; dz++) {
      let row = '';
      for (let dx = 0; dx < size.x; dx++) {
        const blk = bot.blockAt(new Vec3(min.x + dx, y, min.z + dz));
        if (!blk) { row += '?'; unloaded++; hasUnknown[dz][dx] = true; continue; }
        // не видно (за стеной, внутри породы) — неизвестно, не выдаём содержимое
        if (!known(min.x + dx, y, min.z + dz, blk)) { row += '?'; hidden++; if (topSolid[dz][dx] == null) hasUnknown[dz][dx] = true; continue; }
        if (AIR.has(blk.name)) { row += '.'; continue; }
        row += code(blk.name);
        if (blk.boundingBox === 'block' && topSolid[dz][dx] == null) topSolid[dz][dx] = y;
      }
      rows.push(row);
    }
    layers['y=' + y] = rows;
  }

  // Обрыв: у клетки с твёрдым верхом сосед (по 4 сторонам, внутри объёма) ниже на 3+ блока
  const edges = []; let edgesTotal = 0;
  const floorY = min.y - 1; // колонка без твёрдого в объёме считается уходящей ниже объёма
  for (let dz = 0; dz < size.z; dz++) for (let dx = 0; dx < size.x; dx++) {
    const top = topSolid[dz][dx];
    if (top == null) continue;
    const dirs = []; let drop = 0;
    for (const [ox, oz, name] of DIR_OF) {
      const nx = dx + ox, nz = dz + oz;
      if (nx < 0 || nz < 0 || nx >= size.x || nz >= size.z) continue;
      let nt = topSolid[nz][nx];
      if (nt == null) { if (hasUnknown[nz][nx]) continue; nt = floorY; }
      const d = top - nt;
      if (d >= 3) { dirs.push(name); drop = Math.max(drop, d); }
    }
    if (dirs.length) { edgesTotal++; if (edges.length < MAX_EDGES) edges.push({ x: min.x + dx, y: top, z: min.z + dz, drop, dirs: dirs.join('') }); }
  }

  const res = {
    ok: true,
    origin: { x: min.x, y: min.y, z: min.z },
    size,
    axes: 'в layers: ключ y=…, строки идут по z (сверху вниз z растёт, т.е. на юг), символ в строке — x (слева направо растёт на восток). heightmap[z-origin.z][x-origin.x] = y верхнего твёрдого блока, null = нет твёрдого в объёме',
    legend,
    layers,
    heightmap: topSolid,
    edges,
    edgesNote: 'edge: x,y,z — верхний твёрдый блок у края; drop — перепад вниз (≥3); dirs — куда обрыв (С/Ю/З/В; Ю = +z, В = +x). Колонка без твёрдого в объёме считается обрывом до низа объёма (drop≥)'
  };
  if (edgesTotal > edges.length) res.edgesTruncated = edgesTotal;
  if (unloaded || hidden) {
    res.legend['?'] = 'неизвестно: не видно (закрыто породой/стеной) или чанк не загружен';
    if (unloaded) res.unloaded = unloaded;
    if (hidden) res.hidden = hidden;
  }
  return res;
}

module.exports = { survey, MAX_VOLUME };
