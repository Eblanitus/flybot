// stairs_down — спуск-лестница вниз в стене каньона к воде/дну: ступень = 1 вниз + 1 вперёд,
// проход высотой 3, стенка-перила (булыжник) по бокам на уровне ног, где пусто; факелы каждые torch_every ступеней.
// Перед каждой ступенью survey: лава рядом — стоп; пустота под ступенью (глубже 1) — стоп; вода — цель (to=water) или стоп.
// params: x,z — верхняя ступень (где стоять в начале; y — по heightmap или params.y), dir: north|south|east|west,
//         to: "water" (по умолчанию) или число y; max_steps (64), torch_every (8), max_sec (900), dry=1.
// Возвращает {ok, steps, start, end, reached, torches, walls, stopped?}.
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], 'С': [0, -1], 'Ю': [0, 1], 'В': [1, 0], 'З': [-1, 0] };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|glow_lichen|vine|hanging_roots|torch|wall_torch)$/;
const FLUID = /water|lava|bubble_column/;

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
function heightOf(sv, x, z) { const r = sv.heightmap && sv.heightmap[z - sv.origin.z]; const v = r ? r[x - sv.origin.x] : null; return v === undefined ? null : v; }
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';
const solid = b => b !== '?' && !AIRLIKE.test(b) && !FLUID.test(b);

module.exports = {
  name: 'stairs_down',
  description: 'Спуск-лестница вниз со стены каньона к воде (to=water) или до y: ступени 1 вниз/1 вперёд по dir, проход высотой 3, стенка из булыжника по бокам там, где пусто, факелы каждые 8. Стоп на лаве/пустоте. dry=1 — оценка булыжника/факелов по survey.',
  params: {
    x: 'x верхней ступени (по умолчанию где стою)', z: 'z верхней ступени', y: 'y ног на верхней ступени (по умолчанию по heightmap)',
    dir: 'куда спускаться: north|south|east|west (или С/Ю/В/З), по умолчанию south',
    to: '"water" (по умолчанию) — до воды; число — до этой высоты ног',
    max_steps: 'не больше ступеней, по умолчанию 64',
    torch_every: 'факел каждые N ступеней (8), 0 — без факелов',
    max_sec: 'ограничение времени (900)',
    dry: '1 — ничего не копать, вернуть need/have/missing и план'
  },
  async run(api, params) {
    const d = DIRS[params.dir] || DIRS.south;
    const side = [[d[1], d[0]], [-d[1], -d[0]]]; // перпендикуляры
    const toY = params.to !== undefined && params.to !== 'water' && Number.isFinite(Number(params.to)) ? Math.floor(Number(params.to)) : null;
    const maxSteps = Math.min(Math.max(Math.floor(Number(params.max_steps)) || 64, 1), 200);
    const torchEvery = params.torch_every === undefined ? 8 : Math.max(0, Math.floor(Number(params.torch_every)) || 0);
    const maxSec = Math.min(Math.max(Number(params.max_sec) || 900, 30), 1800);
    const t0 = Date.now();

    const snap = await api.snapshot();
    const pos = snap.position || {};
    const inv = {}; for (const it of (snap.inventory || [])) inv[it.name] = (inv[it.name] || 0) + it.count;
    const sx = Math.floor(params.x !== undefined ? Number(params.x) : pos.x), sz = Math.floor(params.z !== undefined ? Number(params.z) : pos.z);
    if (![sx, sz].every(Number.isFinite)) return { ok: false, error: 'нужны x, z' };
    let sy = params.y !== undefined ? Math.floor(Number(params.y)) : null;
    if (sy === null) {
      const sv0 = await api.cmd('survey', { x1: sx, y1: Math.floor(pos.y || 64) - 12, z1: sz, x2: sx, y2: Math.floor(pos.y || 64) + 12, z2: sz });
      const h = heightOf(sv0, sx, sz);
      if (h === null) return { ok: false, error: `не вижу земли в ${sx} ${sz}` };
      sy = h + 1;
    }
    if (toY !== null && toY >= sy) return { ok: false, error: `to=${toY} не ниже старта y=${sy}` };

    // dry: survey коридора, оценка ступеней/булыжника/факелов
    if (isDry(params)) {
      const plannedSteps = Math.min(maxSteps, toY !== null ? sy - toY : maxSteps);
      let len = Math.max(1, plannedSteps);
      while (len > 1 && 3 * (len + 1) * (len + 5) > 4096) len--; // survey не больше 4096 блоков
      const ex = sx + d[0] * len, ez = sz + d[1] * len;
      const sv = await api.cmd('survey', {
        x1: Math.min(sx, ex) - Math.abs(d[1]), x2: Math.max(sx, ex) + Math.abs(d[1]),
        z1: Math.min(sz, ez) - Math.abs(d[0]), z2: Math.max(sz, ez) + Math.abs(d[0]),
        y1: sy - len - 2, y2: sy + 2
      });
      const g = grid(sv);
      let walls = 0, floors = 0, steps = 0, stop = null;
      for (let k = 1; k <= len; k++) {
        const x = sx + d[0] * k, z = sz + d[1] * k, y = sy - k;
        const col = [g(x, y, z), g(x, y + 1, z), g(x, y + 2, z), g(x, y - 1, z)];
        if (col.some(b => /lava/.test(b))) { stop = `лава на ступени ${k} (${x} ${y} ${z})`; break; }
        if (col.slice(0, 3).some(b => /water/.test(b)) || /water/.test(col[3])) { stop = `вода на ступени ${k} (${x} ${y} ${z})`; steps = k; break; }
        if (AIRLIKE.test(col[3])) floors++;
        for (const [ox, oz] of side) if (AIRLIKE.test(g(x + ox, y, z + oz))) walls++;
        steps = k;
      }
      const torches = torchEvery ? Math.floor(steps / torchEvery) : 0;
      const need = { cobblestone: walls + floors, torch: torches };
      const have = { cobblestone: inv.cobblestone || 0, torch: inv.torch || 0 };
      const missing = {};
      for (const k of Object.keys(need)) if (have[k] < need[k]) missing[k] = need[k] - have[k];
      return {
        ok: true, dry: true, need, have, missing, start: [sx, sy, sz],
        plan: `лестница от ${sx} ${sy} ${sz} на ${params.dir || 'south'}, видно ${len} ступеней: стенок ${walls}, дыр в полу ${floors}, факелов ${torches}` + (stop ? `; ${stop}` : '') + (len < plannedSteps ? `; дальше не видно — оценка на ${len} из ${plannedSteps}` : '')
      };
    }

    if (Math.abs((pos.x || 0) - sx) > 1 || Math.abs((pos.z || 0) - sz) > 1 || Math.abs((pos.y || 0) - sy) > 1) {
      try { await api.cmd('goto', { x: sx, y: sy, z: sz, timeout: 90 }); }
      catch (e) { return { ok: false, error: `не дошла до верхней ступени ${sx} ${sy} ${sz}: ${e.message.slice(0, 120)}` }; }
    }
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + e.message); }

    let cx = sx, cy = sy, cz = sz, done = 0, torches = 0, walls = 0, reached = null;
    const start = [sx, sy, sz];
    // итог: ok — дошли до цели (вода / y) или прошли хоть одну ступень без лавы; иначе error с причиной
    const out = (why, okForce) => {
      const ok = okForce !== undefined ? okForce : (done > 0 && !/лава/.test(why || ''));
      const r = { ok, steps: done, start, end: [cx, cy, cz], reached, torches, cobble_used: walls };
      if (why) r.stopped = why;
      if (!ok) r.error = why || 'не прошла ни одной ступени';
      return r;
    };
    for (let k = 0; k < maxSteps; k++) {
      if ((Date.now() - t0) / 1000 > maxSec) return out('время вышло');
      if (toY !== null && cy <= toY) { reached = 'y'; break; }
      const nx = cx + d[0], nz = cz + d[1], ny = cy - 1;
      const box = { x1: Math.min(cx, nx) - 1, x2: Math.max(cx, nx) + 1, z1: Math.min(cz, nz) - 1, z2: Math.max(cz, nz) + 1, y1: ny - 3, y2: cy + 2 };
      const scan = async () => grid(await api.cmd('survey', box));
      const lavaNear = g => {
        for (let y = ny - 1; y <= ny + 3; y++) for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
          if (Math.abs(ox) + Math.abs(oz) > 1) continue;
          if (/lava/.test(g(nx + ox, y, nz + oz))) return [nx + ox, y, nz + oz];
        }
        return null;
      };
      let g = await scan();
      // копаем сверху вниз: ny+2, ny+1, ny
      for (const y of [ny + 2, ny + 1, ny]) {
        const lv = lavaNear(g); if (lv) return out(`лава у ${lv.join(' ')}`);
        const b = g(nx, y, nz);
        if (/water/.test(b)) { if (toY === null) { reached = 'water'; return out(null, true); } return out(`вода в ${nx} ${y} ${nz}`); }
        if (b !== '?' && AIRLIKE.test(b)) continue;
        try { await api.cmd('dig_at', { x: nx, y, z: nz }); }
        catch (e) { if (!/нет такого блока/.test(e.message)) return out(`dig ${nx} ${y} ${nz}: ${e.message.slice(0, 120)}`); }
        g = await scan();
      }
      const lv = lavaNear(g); if (lv) return out(`лава у ${lv.join(' ')}`);
      // пол ступени
      const floor = g(nx, ny - 1, nz);
      if (/water/.test(floor)) { if (toY === null) { reached = 'water'; return out(null, true); } return out('вода под ступенью'); }
      if (floor === '?' || AIRLIKE.test(floor)) {
        const deeper = g(nx, ny - 2, nz);
        if (!solid(deeper)) return out(`пустота под ступенью ${nx} ${ny - 1} ${nz}`);
        try { await api.cmd('place_at', { x: nx, y: ny - 1, z: nz, item: 'cobblestone' }); walls++; }
        catch (e) { return out(`не закрыла пол ${nx} ${ny - 1} ${nz}: ${e.message.slice(0, 100)}`); }
      }
      // перила: боковые клетки на уровне ног — если пусто, булыжник
      for (const [ox, oz] of side) {
        const b = g(nx + ox, ny, nz + oz);
        if (/lava/.test(b)) return out('лава сбоку');
        if (b === '?' || !(AIRLIKE.test(b) || /water/.test(b))) continue;
        try { await api.cmd('place_at', { x: nx + ox, y: ny, z: nz + oz, item: 'cobblestone' }); walls++; }
        catch (e) { api.log(`перила ${nx + ox} ${ny} ${nz + oz}: ${e.message.slice(0, 80)}`); }
      }
      try { await api.cmd('goto', { x: nx, y: ny, z: nz, timeout: 20 }); }
      catch (e) { return out(`goto ${nx} ${ny} ${nz}: ${e.message.slice(0, 100)}`); }
      // факел на предыдущую ступень
      if (torchEvery > 0 && (done + 1) % torchEvery === 0) {
        if ((await api.count('torch')) > 0) {
          try { await api.cmd('place_at', { x: cx, y: cy, z: cz, item: 'torch' }); torches++; } catch (e) { api.log('факел: ' + e.message); }
        }
      }
      cx = nx; cy = ny; cz = nz; done++;
      if (done % 4 === 0) api.log(`ступеней ${done}, ноги y=${cy}`);
    }
    if (toY !== null && cy <= toY) reached = 'y';
    return reached ? out(null, true) : out('лимит ступеней (до цели не дошла)', done > 0);
  }
};
