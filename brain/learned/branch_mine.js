// branch_mine — ветвистая шахта: (спуск лестницей до y) → главный туннель 1×2 → боковые ветки с обеих сторон; руда в стенах берётся по ходу.
// Спуск — через выученный mine_stairs (api.skill). Перед каждой клеткой survey: лава/вода/пещера/сыплющийся потолок → стоп этой линии.
// Стоп всей шахты: мало HP, враг рядом, полный инвентарь, max_sec. Сама ничего не ставит, кроме факелов (и пробки в дыру с жидкостью).
// Возвращает ores ({iron_ore: n,…} — сколько блоков руды выкопано), cells, main, branches, gained, notes.
const DIRS = {
  north: { dx: 0, dz: -1 }, south: { dx: 0, dz: 1 }, east: { dx: 1, dz: 0 }, west: { dx: -1, dz: 0 }
};
const FLUID = /^(water|lava|bubble_column|flowing_water|flowing_lava)$/;
const AIRS = /^(air|cave_air|void_air)$/;
const FALLING = /^(sand|red_sand|gravel)$/;
const PICK = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, copper_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 3 };
const SEAL = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack'];
const clean = e => String(e && e.message || e).replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 140);
const key = (x, y, z) => x + ',' + y + ',' + z;
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };

function gridOf(sv) {
  const o = sv.origin;
  return (x, y, z) => {
    const layer = sv.layers && sv.layers['y=' + y];
    if (!layer) return '?';
    const row = layer[z - o.z];
    if (!row) return '?';
    const ch = row[x - o.x];
    if (ch === undefined || ch === '?') return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const oreTier = n => { const s = n.replace(/^deepslate_/, ''); return /^coal_ore$/.test(s) ? 0 : /^(copper|iron|lapis)_ore$/.test(s) ? 1 : 2; };
const oreKey = n => n.replace(/^deepslate_/, '');

const survey = async (api, x1, y1, z1, x2, y2, z2) => gridOf(await api.cmd('survey', { x1, y1, z1, x2, y2, z2 }));

// проверки безопасности/состояния перед очередной клеткой; true — надо остановить всё
async function vitals(S) {
  if (S.halt) return true;
  if (Date.now() > S.deadline) { S.halt = 'вышло время max_sec'; return true; }
  const snap = await S.api.snapshot();
  S.snap = snap;
  if (typeof snap.health === 'number' && snap.health < 8) { S.halt = 'мало HP'; return true; }
  const en = ((snap.eyes && snap.eyes.enemies) || []).find(e => typeof e.d === 'number' && e.d <= 6);
  if (en) { S.halt = `враг рядом: ${en.name} ${en.d}м`; return true; }
  if ((snap.inventory || []).filter(i => i.slot >= 9 && i.slot <= 44).length >= 36) { S.halt = 'инвентарь полон'; return true; }
  return false;
}

async function sealCell(S, x, y, z) {
  const m = invMap(S.snap && S.snap.inventory);
  const item = SEAL.find(n => m[n] > 0);
  if (!item) { S.notes.push(`дыра с жидкостью ${x} ${y} ${z}, нечем заделать`); return false; }
  try { await S.api.cmd('place_at', { x, y, z, item }); S.notes.push(`заделала ${x} ${y} ${z} (рядом жидкость)`); return true; }
  catch (e) { S.notes.push(`заделать ${x} ${y} ${z}: ${clean(e)}`); return false; }
}

// руда, касающаяся клетки туннеля (и жила от неё по диагонали); до 12 блоков за клетку
async function mineNear(S, cx, cy, cz) {
  if (!S.mineOres) return 0;
  const tun = [[cx, cy, cz], [cx, cy + 1, cz]];
  const dug = [], failed = new Set();
  let last = { x: cx, y: cy, z: cz }, digs = 0, fails = 0;
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (digs < 12 && !S.halt && fails < 3) {
    let g;
    try { g = await survey(S.api, last.x - 3, last.y - 2, last.z - 3, last.x + 3, last.y + 3, last.z + 3); }
    catch (e) { S.notes.push('survey руды: ' + clean(e)); return digs; }
    // жидкость рядом с уже выкопанной рудой — пробка
    for (const d of dug) if (N6.some(v => FLUID.test(g(d.x + v[0], d.y + v[1], d.z + v[2])))) { await sealCell(S, d.x, d.y, d.z); S.hazards++; }
    const isOre = (x, y, z) => { const n = g(x, y, z); return /_ore$/.test(n) && oreTier(n) <= S.tier; };
    const cands = [];
    for (let x = last.x - 3; x <= last.x + 3; x++) for (let y = last.y - 2; y <= last.y + 3; y++) for (let z = last.z - 3; z <= last.z + 3; z++) {
      if (!isOre(x, y, z) || failed.has(key(x, y, z))) continue;
      const touchTunnel = tun.some(t => Math.abs(t[0] - x) + Math.abs(t[1] - y) + Math.abs(t[2] - z) === 1);
      const touchDug = dug.some(d => Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1 && Math.abs(d.z - z) <= 1);
      if (!touchTunnel && !touchDug) continue;
      let lava = false;
      for (let dx = -1; dx <= 1 && !lava; dx++) for (let dy = -1; dy <= 1 && !lava; dy++) for (let dz = -1; dz <= 1; dz++) if (g(x + dx, y + dy, z + dz) === 'lava') { lava = true; break; }
      if (lava) { failed.add(key(x, y, z)); S.hazards++; continue; }
      cands.push({ x, y, z, d: Math.hypot(x - cx, y - cy - 1, z - cz) });
    }
    if (!cands.length) break;
    cands.sort((a, b) => a.d - b.d);
    const t = cands[0];
    const name = g(t.x, t.y, t.z);
    try {
      await S.api.cmd('dig_at', { x: t.x, y: t.y, z: t.z });
      digs++; dug.push(t); last = t; S.own.add(key(t.x, t.y, t.z));
      S.ores[oreKey(name)] = (S.ores[oreKey(name)] || 0) + 1;
    } catch (e) { failed.add(key(t.x, t.y, t.z)); fails++; S.notes.push(`руда ${name} ${t.x} ${t.y} ${t.z}: ${clean(e)}`); }
  }
  return digs;
}

// прокопать n клеток от (from) в направлении d; бот стоит в from. {done, stopped}
async function digLine(S, from, d, n, label) {
  let cx = from.x, cy = from.y, cz = from.z, done = 0, stopped = null;
  const px = -d.dz, pz = d.dx; // перпендикуляр
  for (let k = 0; k < n; k++) {
    if (await vitals(S)) { stopped = S.halt; break; }
    const nx = cx + d.dx, nz = cz + d.dz;
    let g;
    try { g = await survey(S.api, Math.min(nx, cx) - 1, cy - 2, Math.min(nz, cz) - 1, Math.max(nx, cx) + 1, cy + 3, Math.max(nz, cz) + 1); }
    catch (e) { stopped = 'survey: ' + clean(e); break; }
    // что вокруг будущей клетки
    const around = [
      [nx, cy, nz, 'ноги'], [nx, cy + 1, nz, 'голова'], [nx, cy - 1, nz, 'пол'], [nx, cy + 2, nz, 'потолок'],
      [nx + d.dx, cy, nz + d.dz, 'впереди'], [nx + d.dx, cy + 1, nz + d.dz, 'впереди'],
      [nx + px, cy, nz + pz, 'стена'], [nx - px, cy, nz - pz, 'стена'], [nx + px, cy + 1, nz + pz, 'стена'], [nx - px, cy + 1, nz - pz, 'стена']
    ];
    let bad = null;
    for (const [x, y, z, what] of around) {
      const name = g(x, y, z);
      if (FLUID.test(name)) { bad = `${name === 'lava' ? 'лава' : 'вода'} (${what}) на ${x} ${y} ${z}`; S.hazards++; break; }
      if (what === 'пол' && AIRS.test(name)) { bad = 'пустота под полом'; break; }
      if ((what === 'ноги' || what === 'голова') && AIRS.test(name) && !S.own.has(key(x, y, z))) { bad = 'пещера впереди (воздух)'; break; }
      if ((what === 'потолок' || what === 'голова') && FALLING.test(name)) { bad = `над туннелем ${name} — обвалится`; break; }
      if (/^bedrock$/.test(name) && (what === 'ноги' || what === 'голова')) { bad = 'бедрок'; break; }
    }
    if (bad) { stopped = bad; break; }
    // копаем голову и ноги
    let dugOk = true;
    for (const y of [cy + 1, cy]) {
      if (AIRS.test(g(nx, y, nz))) continue;
      try { await S.api.cmd('dig_at', { x: nx, y, z: nz }); S.digs++; }
      catch (e) { stopped = `dig_at ${nx} ${y} ${nz}: ${clean(e)}`; dugOk = false; break; }
    }
    if (!dugOk) break;
    try { await S.api.cmd('goto', { x: nx, y: cy, z: nz, timeout: 20 }); }
    catch (e) { stopped = `goto ${nx} ${cy} ${nz}: ${clean(e)}`; break; }
    const prev = { x: cx, z: cz };
    cx = nx; cz = nz; done++; S.cells++;
    // жидкость вскрылась рядом с новой клеткой?
    try {
      const g2 = await survey(S.api, cx - 1, cy - 1, cz - 1, cx + 1, cy + 2, cz + 1);
      let fl = null;
      for (let x = cx - 1; x <= cx + 1 && !fl; x++) for (let y = cy - 1; y <= cy + 2 && !fl; y++) for (let z = cz - 1; z <= cz + 1; z++) if (FLUID.test(g2(x, y, z))) { fl = [x, y, z, g2(x, y, z)]; break; }
      if (fl) {
        S.hazards++;
        stopped = `вскрылась ${fl[3] === 'lava' ? 'лава' : 'вода'} на ${fl[0]} ${fl[1]} ${fl[2]} — отхожу`;
        try { await S.api.cmd('goto', { x: prev.x, y: cy, z: prev.z, timeout: 15 }); } catch (e) { /* уже отошла сколько смогла */ }
        break;
      }
    } catch (e) { /* не страшно */ }
    // факел
    if (S.torchEvery > 0 && S.cells % S.torchEvery === 0 && S.torches > 0) {
      try { await S.api.cmd('place_at', { x: prev.x, y: cy, z: prev.z, item: 'torch' }); S.torches--; S.placedTorches++; }
      catch (e) { S.notes.push('факел: ' + clean(e)); S.torches = 0; }
    }
    await mineNear(S, cx, cy, cz);
  }
  return { label, done, ...(stopped ? { stopped } : {}), end: { x: cx, y: cy, z: cz } };
}

module.exports = {
  name: 'branch_mine',
  description: 'Ветвистая шахта: спуск лестницей до y (mine_stairs), главный туннель length клеток и branches боковых веток по branch_len, факелы, руда в стенах берётся по ходу. Стоп при лаве/воде/пещере/мало HP/враге. Возвращает ores, cells, gained. Нужна кирка. Долго — давай большой timeout_sec.',
  params: {
    y: 'уровень ног, куда спуститься (железо ≈ 16, алмазы ≈ -50…16); не задан — копать с текущего уровня',
    dir: 'north|south|east|west — направление спуска и главного туннеля, по умолчанию south',
    length: 'длина главного туннеля, клеток; по умолчанию 24',
    branches: 'сколько боковых веток (поровну влево/вправо), по умолчанию 4',
    branch_len: 'длина ветки, по умолчанию 8',
    torch_every: 'факел каждые N клеток, 0 = без факелов; по умолчанию 8',
    max_sec: 'потолок по времени, по умолчанию 600'
  },
  async run(api, params) {
    params = params || {};
    const dirName = DIRS[params.dir] ? params.dir : (params.dir ? null : 'south');
    if (!dirName) return { ok: false, error: `dir "${params.dir}": north|south|east|west` };
    const d = DIRS[dirName];
    const num = (v, def, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(hi, Math.max(lo, n)) : def; };
    const length = num(params.length, 24, 1, 80);
    const branches = num(params.branches, 4, 0, 16);
    const branchLen = num(params.branch_len, 8, 1, 30);
    const torchEvery = num(params.torch_every, 8, 0, 50);
    const wantY = params.y === undefined || params.y === null || params.y === '' ? null : Math.floor(Number(params.y));
    if (wantY !== null && !Number.isFinite(wantY)) return { ok: false, error: 'y: число' };
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 600) * 1000;

    let snap = await api.snapshot();
    const inv0 = invMap(snap.inventory);
    let tier = -1;
    for (const n of Object.keys(inv0)) if (n in PICK && inv0[n] > 0) tier = Math.max(tier, PICK[n]);
    if (tier < 0) return { ok: false, error: 'нет кирки (нужна хотя бы деревянная) — craft_gear или starter_kit', missing: { pickaxe: 'любая' } };
    const S = {
      api, deadline, tier, snap, halt: null, own: new Set(), notes: [], ores: {}, hazards: 0, cells: 0, digs: 0, torchEvery,
      torches: inv0.torch || 0, placedTorches: 0, mineOres: true
    };

    // 0. факелы: докрафтить, если есть чем
    if (torchEvery > 0) {
      const need = Math.ceil((length + branches * branchLen) / torchEvery) + (wantY !== null ? 4 : 0);
      if (S.torches < need && ((inv0.coal || 0) + (inv0.charcoal || 0)) > 0) {
        try { await api.cmd('craft', { item: 'torch', count: Math.min(32, Math.ceil((need - S.torches) / 4) * 4) }); S.torches = invMap((await api.snapshot()).inventory).torch || S.torches; }
        catch (e) { S.notes.push('факелы не скрафтила: ' + clean(e)); }
      }
      if (S.torches < 1) S.notes.push('без факелов');
    }
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + clean(e)); }

    // 1. спуск
    snap = await api.snapshot();
    let curY = Math.floor(snap.position.y + 0.001);
    const startY0 = curY;
    let descent = null;
    if (wantY !== null && wantY < curY - 1) {
      const steps = curY - wantY;
      api.log(`branch_mine: спуск ${steps} ступеней на ${dirName}`);
      try {
        descent = await api.skill('mine_stairs', { dir: dirName, steps, torch_every: torchEvery > 0 ? 6 : 0 });
      } catch (e) {
        return { ok: false, error: 'спуск не удался (mine_stairs): ' + clean(e), startY: startY0, cells: 0, ores: {} };
      }
      snap = await api.snapshot();
      curY = Math.floor(snap.position.y + 0.001);
      if (curY > wantY + 1) {
        return { ok: false, error: `спуск остановился на y=${curY}, нужно ${wantY}: ${descent && (descent.stopped || descent.error) || 'без причины'}`, startY: startY0, y: curY, descent, cells: 0, ores: {} };
      }
    } else if (wantY !== null && wantY > curY + 1) {
      return { ok: false, error: `y=${wantY} выше текущего (${curY}): подняться надо отдельно (climb_stairs), потом снова`, startY: startY0, cells: 0, ores: {} };
    }
    S.torches = invMap(snap.inventory).torch || S.torches;
    const start = { x: Math.floor(snap.position.x), y: curY, z: Math.floor(snap.position.z) };

    // 2. главный туннель
    const main = await digLine(S, start, d, length, 'main');
    // 3. ветки с дальнего конца к началу
    const positions = Math.ceil(branches / 2);
    const spacing = Math.max(3, Math.floor(length / Math.max(1, positions)));
    const plan = [];
    for (let i = 1; i <= branches; i++) {
      const j = spacing * Math.ceil(i / 2);
      plan.push({ j: Math.min(j, length), side: i % 2 ? 1 : -1 });
    }
    const results = [], skipped = [];
    plan.sort((a, b) => b.j - a.j || b.side - a.side);
    for (const b of plan) {
      if (S.halt) { skipped.push(`${b.j}${b.side > 0 ? 'П' : 'Л'}`); continue; }
      if (b.j > main.done) { skipped.push(`${b.j}${b.side > 0 ? 'П' : 'Л'}`); continue; }
      const cell = { x: start.x + d.dx * b.j, y: curY, z: start.z + d.dz * b.j };
      try { await api.cmd('goto', { x: cell.x, y: cell.y, z: cell.z, timeout: 40 }); }
      catch (e) { results.push({ at: b.j, side: b.side > 0 ? 'право' : 'лево', done: 0, stopped: 'не дошла до места ветки: ' + clean(e) }); continue; }
      const bd = { dx: -d.dz * b.side, dz: d.dx * b.side }; // side=1: вправо по ходу (x на восток, z на юг), -1: влево
      const r = await digLine(S, cell, bd, branchLen, 'branch');
      results.push({ at: b.j, side: b.side > 0 ? 'право' : 'лево', done: r.done, ...(r.stopped ? { stopped: r.stopped } : {}) });
      // назад на главную линию
      try { await api.cmd('goto', { x: cell.x, y: cell.y, z: cell.z, timeout: 40 }); } catch (e) { S.notes.push('возврат на главную: ' + clean(e)); }
    }
    // 4. вернуться к началу туннеля
    let returned = false;
    if (S.cells > 0) { try { await api.cmd('goto', { x: start.x, y: curY, z: start.z, timeout: 60 }); returned = true; } catch (e) { S.notes.push('возврат к началу: ' + clean(e)); } }

    let gained = {};
    try { const now = invMap((await api.snapshot()).inventory); for (const n of Object.keys(now)) { const dd = now[n] - (inv0[n] || 0); if (dd > 0) gained[n] = dd; } } catch (e) { /* не страшно */ }
    const out = {
      y: curY, startY: startY0, start, dir: dirName, cells: S.cells, ores: S.ores, gained,
      main: { done: main.done, ...(main.stopped ? { stopped: main.stopped } : {}) },
      branches: results, ...(skipped.length ? { branchesSkipped: skipped } : {}),
      torchesPlaced: S.placedTorches, hazards: S.hazards, returned, ...(descent ? { descent: { steps: descent.steps, stopped: descent.stopped } } : {}),
      ...(S.halt ? { reason: S.halt } : {}), notes: S.notes
    };
    api.log(`branch_mine: клеток ${S.cells}, руда ${JSON.stringify(S.ores)}${S.halt ? ', стоп: ' + S.halt : ''}`);
    if (S.cells === 0) return { ok: false, error: 'не прокопала ни клетки: ' + (main.stopped || S.halt || 'без причины'), ...out };
    return { ok: true, ...out };
  }
};
