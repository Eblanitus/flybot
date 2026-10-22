// версия: первая: лестница 1x2 в одном направлении (пол булыжником, копает 2 блока вверх); стоп на лаве/воде
// climb_stairs — выбраться из пещеры/ямы вверх лестницей 1x2.
// Идёт в одном направлении (по умолчанию на восток), на каждом шаге поднимается на 1 блок:
// пол следующей ступени (x+dx, y) при необходимости ставит из булыжника, вынимает
// (x+dx, y+1) и (x+dx, y+2), затем goto на ступень. При лаве/воде в колонке — стоп.
// params: steps (по умолчанию 40), dir (east|west|north|south), target_y (остановиться на этом y).
const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };

async function col(api, x, y, z) {
  const sv = await api.cmd('survey', { x1: x, y1: y, z1: z, x2: x, y2: y + 3, z2: z });
  const out = {};
  for (let yy = y; yy <= y + 3; yy++) {
    const rows = sv.layers && sv.layers['y=' + yy];
    const ch = rows && rows[0] && rows[0][0];
    out[yy] = sv.legend ? sv.legend[ch] : undefined;
  }
  return out;
}
const solid = b => b && b !== 'air' && b !== 'cave_air' && b !== 'void_air' && !/water|lava/.test(b);

module.exports = {
  name: 'climb_stairs',
  description: 'Подняться из пещеры лестницей 1x2 в выбранном направлении: пол ставит булыжником, копает 2 блока вверх, goto на ступень. Стоп при лаве/воде.',
  params: {
    steps: 'сколько ступеней максимум (по умолчанию 40)',
    dir: 'направление: east|west|north|south (по умолчанию east)',
    target_y: 'остановиться, когда feet >= target_y (по умолчанию 66)'
  },
  async run(api, params) {
    const maxSteps = Math.max(1, Number(params.steps) || 40);
    const targetY = Number.isFinite(Number(params.target_y)) ? Number(params.target_y) : 66;
    const order = params.dir && DIRS[params.dir] ? [params.dir] : ['east', 'south', 'west', 'north'];
    let dirIdx = 0;
    let stuck = 0;
    const log = [];

    let snap = await api.snapshot();
    let y = Math.floor(snap.position.y);
    for (let i = 0; i < maxSteps && y < targetY; i++) {
      const [dx, dz] = DIRS[order[dirIdx % order.length]];
      const px = Math.floor(snap.position.x), pz = Math.floor(snap.position.z);
      const tx = px + dx, tz = pz + dz;
      try {
        const c = await col(api, tx, y, tz);
        if (/lava|water/.test(String(c[y]) + String(c[y + 1]) + String(c[y + 2]))) {
          return { ok: false, error: `лава/вода на ${tx},${y},${tz}`, y, log };
        }
        // пол следующей ступени
        if (!solid(c[y])) {
          try { await api.cmd('place_at', { x: tx, y, z: tz, item: 'cobblestone' }); }
          catch (e) { log.push(`пол не поставить ${tx},${y},${tz}: ${e.message}`); }
        }
        for (let yy = y + 1; yy <= y + 2; yy++) {
          if (solid(c[yy])) {
            try { await api.cmd('dig_at', { x: tx, y: yy, z: tz }); }
            catch (e) { log.push(`dig ${tx},${yy},${tz}: ${e.message}`); }
          }
        }
        await api.cmd('goto', { x: tx, y: y + 1, z: tz });
        await api.sleep(300);
        snap = await api.snapshot();
        const ny = Math.floor(snap.position.y);
        if (ny <= y) {
          stuck++;
          log.push(`ступень ${i}: не поднялся (y=${ny})`);
          if (stuck >= 2) {
            stuck = 0;
            dirIdx++;
            log.push(`меняю направление на ${order[dirIdx % order.length]}`);
          }
        } else {
          stuck = 0;
          y = ny;
        }
      } catch (e) {
        log.push(`шаг ${i} (${tx},${y},${tz}): ${e.message}`);
        await api.sleep(300);
      }
      if (i % 5 === 0) api.log(`высота: ${y}/${targetY}`);
    }
    return { ok: y >= targetY, y, targetY, log: log.slice(-25) };
  }
};
