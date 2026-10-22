// версия: первая: лестница вниз 1x2, survey перед каждой ступенью, факелы
// mine_stairs — безопасная лестница вниз на 1 блок за ступень (туннель 1x2).
// params: dir (north|south|east|west, по умолчанию south), steps (сколько ступеней, по умолчанию 8),
//         torch_every (ставить факел каждые N ступеней, 0 = не ставить, по умолчанию 6).
// Перед каждой ступенью survey: лава/вода в нужных клетках или пустой пол -> стоп.
// Возвращает {ok, steps, start, end, stopped}.

const DIRS = {
  north: { dx: 0, dz: -1 },
  south: { dx: 0, dz: 1 },
  east: { dx: 1, dz: 0 },
  west: { dx: -1, dz: 0 }
};
const FLUID = /water|lava|bubble_column/;

function gridOf(sv) {
  const o = sv.origin;
  return (x, y, z) => {
    const layer = sv.layers && sv.layers['y=' + y];
    if (!layer) return '?';
    const row = layer[z - o.z];
    if (!row) return '?';
    const ch = row[x - o.x];
    if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}

module.exports = {
  name: 'mine_stairs',
  description: 'Лестница вниз 1x2 в породе: по 1 блоку за ступень, survey перед каждой, стоп на лаве/воде/пустом полу. Ставит факелы на ступени.',
  params: {
    dir: 'north|south|east|west (по умолчанию south)',
    steps: 'сколько ступеней (по умолчанию 8)',
    torch_every: 'факел каждые N ступеней, 0 = без факелов (по умолчанию 6)'
  },
  async run(api, params) {
    const d = DIRS[params.dir] || DIRS.south;
    const steps = Math.max(1, Math.floor(Number(params.steps)) || 8);
    const torchEvery = params.torch_every === undefined ? 6 : Math.max(0, Math.floor(Number(params.torch_every)) || 0);

    const snap0 = await api.snapshot();
    const p0 = snap0.position;
    const start = { x: Math.floor(p0.x), y: Math.floor(p0.y + 0.001), z: Math.floor(p0.z) };
    let cx = start.x, cy = start.y, cz = start.z;
    let done = 0;

    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + e.message); }

    for (let k = 0; k < steps; k++) {
      const nx = cx + d.dx, nz = cz + d.dz, ny = cy - 1;
      const sv = await api.cmd('survey', {
        x1: Math.min(nx, cx) - 1, y1: ny - 3, z1: Math.min(nz, cz) - 1,
        x2: Math.max(nx, cx) + 1, y2: cy + 1, z2: Math.max(nz, cz) + 1
      });
      const g = gridOf(sv);
      const head = g(nx, cy, nz);
      const feet = g(nx, ny, nz);
      const floor = g(nx, ny - 1, nz);

      if (FLUID.test(head) || FLUID.test(feet) || FLUID.test(floor)) {
        return { ok: done > 0, steps: done, start, end: { x: cx, y: cy, z: cz }, stopped: 'жидкость впереди (' + [head, feet, floor].join('/') + ')' };
      }
      if (floor === 'air' || floor === '?') {
        return { ok: done > 0, steps: done, start, end: { x: cx, y: cy, z: cz }, stopped: 'под следующей ступенью пусто (' + floor + ')' };
      }
      if (feet === 'air') {
        api.log(`ступень ${k + 1}: пол уже пустой (${nx} ${ny} ${nz})`);
      }

      for (const y of [ny, cy]) {
        const n = g(nx, y, nz);
        if (n === 'air') continue;
        if (n === '?' || /bedrock/i.test(n)) {
          return { ok: done > 0, steps: done, start, end: { x: cx, y: cy, z: cz }, stopped: `не вижу блок ${nx} ${y} ${nz} (${n})` };
        }
        try {
          await api.cmd('dig_at', { x: nx, y, z: nz });
        } catch (e) {
          return { ok: done > 0, steps: done, start, end: { x: cx, y: cy, z: cz }, stopped: `dig ${nx} ${y} ${nz}: ${e.message}` };
        }
      }

      try {
        await api.cmd('goto', { x: nx, y: ny, z: nz, timeout: 20 });
      } catch (e) {
        return { ok: done > 0, steps: done, start, end: { x: cx, y: cy, z: cz }, stopped: `goto ${nx} ${ny} ${nz}: ${e.message}` };
      }

      // факел на предыдущую ступень (там пол — наша ступень)
      if (torchEvery > 0 && (done + 1) % torchEvery === 0) {
        const have = await api.count('torch');
        if (have > 0) {
          try { await api.cmd('place_at', { x: cx, y: cy, z: cz, item: 'torch' }); } catch (e) { api.log('факел: ' + e.message); }
        }
      }

      cx = nx; cy = ny; cz = nz;
      done++;
      if (done % 4 === 0) api.log(`ступеней: ${done}, ноги y=${cy}`);
    }

    return { ok: true, steps: done, start, end: { x: cx, y: cy, z: cz } };
  }
};
