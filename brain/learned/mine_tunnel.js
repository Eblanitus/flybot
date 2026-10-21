// mine_tunnel — горизонтальный туннель 1x2 в стене каньона: факелы, список найденных руд,
// заделка прорывов воды (булыжником), стоп при лаве. Каждый шаг: survey -> голова -> ноги -> проверка пола/стен -> шаг.
// params: x,y,z — откуда начинать (клетка ног у входа; по умолчанию где стою), dir: north|south|east|west,
//         length (32), torch_every (8), max_sec (900), dry=1.
// Возвращает {ok, dug, start, end, ores:[{name,x,y,z}], sealed, torches, stopped?}.
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], 'С': [0, -1], 'Ю': [0, 1], 'В': [1, 0], 'З': [-1, 0] };
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow|glow_lichen|vine|hanging_roots|torch|wall_torch)$/;
const ORE = /_ore$|^ancient_debris$|^raw_[a-z]+_block$/;

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

module.exports = {
  name: 'mine_tunnel',
  description: 'Туннель 1x2 в стене каньона от x,y,z по dir на length (32): факел каждые torch_every (8), находит руды в стенах (ores:[{name,x,y,z}]), заделывает прорывы воды булыжником, стоп у лавы. dry=1 — оценка факелов/булыжника по survey.',
  params: {
    x: 'x клетки ног у входа (по умолчанию где стою)', y: 'y ног', z: 'z',
    dir: 'north|south|east|west (или С/Ю/В/З), по умолчанию west',
    length: 'длина туннеля, по умолчанию 32 (максимум 128)',
    torch_every: 'факел каждые N блоков, 0 — без факелов (8)',
    max_sec: 'ограничение времени (900)',
    dry: '1 — ничего не копать, вернуть need/have/missing'
  },
  async run(api, params) {
    const d = DIRS[params.dir] || DIRS.west;
    const side = [[d[1], d[0]], [-d[1], -d[0]]];
    const length = Math.min(Math.max(Math.floor(Number(params.length)) || 32, 1), 128);
    const torchEvery = params.torch_every === undefined ? 8 : Math.max(0, Math.floor(Number(params.torch_every)) || 0);
    const maxSec = Math.min(Math.max(Number(params.max_sec) || 900, 30), 1800);
    const t0 = Date.now();
    const snap = await api.snapshot();
    const pos = snap.position || {};
    const inv = {}; for (const it of (snap.inventory || [])) inv[it.name] = (inv[it.name] || 0) + it.count;
    const sx = Math.floor(params.x !== undefined ? Number(params.x) : pos.x);
    const sy = Math.floor(params.y !== undefined ? Number(params.y) : (pos.y || 0) + 0.001);
    const sz = Math.floor(params.z !== undefined ? Number(params.z) : pos.z);
    if (![sx, sy, sz].every(Number.isFinite)) return { ok: false, error: 'нужны x, y, z' };
    const hasPick = Object.keys(inv).some(n => /_pickaxe$/.test(n));

    const ores = new Map();
    const noteOres = (g, x, y, z) => {
      for (let yy = y - 1; yy <= y + 2; yy++) for (const [ox, oz] of [[0, 0], ...side, d]) {
        const b = g(x + ox, yy, z + oz);
        if (ORE.test(b)) ores.set(`${x + ox},${yy},${z + oz}`, { name: b, x: x + ox, y: yy, z: z + oz });
      }
    };

    if (isDry(params)) {
      const len = Math.min(length, Math.floor(4096 / 12) - 1);
      const ex = sx + d[0] * len, ez = sz + d[1] * len;
      const sv = await api.cmd('survey', {
        x1: Math.min(sx, ex) - Math.abs(d[1]), x2: Math.max(sx, ex) + Math.abs(d[1]),
        z1: Math.min(sz, ez) - Math.abs(d[0]), z2: Math.max(sz, ez) + Math.abs(d[0]), y1: sy - 1, y2: sy + 2
      });
      const g = grid(sv);
      let air = 0, known = 0, lava = null, water = 0;
      for (let k = 1; k <= len; k++) {
        const x = sx + d[0] * k, z = sz + d[1] * k;
        for (const y of [sy, sy + 1]) { const b = g(x, y, z); if (b !== '?') known++; if (AIRLIKE.test(b)) air++; if (/lava/.test(b) && !lava) lava = [x, y, z]; if (/water/.test(b)) water++; }
        noteOres(g, x, sy, z);
      }
      const torches = torchEvery ? Math.floor(length / torchEvery) : 0;
      const need = { torch: torches, cobblestone: 8 };
      const have = { torch: inv.torch || 0, cobblestone: inv.cobblestone || 0, pickaxe: hasPick ? 1 : 0 };
      const missing = {};
      if ((inv.torch || 0) < torches) missing.torch = torches - (inv.torch || 0);
      if ((inv.cobblestone || 0) < 8) missing.cobblestone = 8 - (inv.cobblestone || 0);
      if (!hasPick) missing.pickaxe = 1;
      return {
        ok: true, dry: true, need, have, missing, ores: [...ores.values()],
        plan: `туннель 1x2 от ${sx} ${sy} ${sz} на ${params.dir || 'west'} длиной ${length}: клеток ${length * 2}, известно ${known}, уже пусто ${air}, копать ~${length * 2 - air}; факелов ${torches}; булыжник 8 — запас на заделку воды` +
          (lava ? `; ЛАВА в ${lava.join(' ')} — туннель остановится там` : '') + (water ? `; воды в коридоре ${water}` : '')
      };
    }
    if (!hasPick) return { ok: false, error: 'нет кирки', missing: { pickaxe: 1 } };

    if (Math.abs((pos.x || 0) - (sx + 0.5)) > 1.5 || Math.abs((pos.z || 0) - (sz + 0.5)) > 1.5 || Math.abs((pos.y || 0) - sy) > 1) {
      try { await api.cmd('goto', { x: sx, y: sy, z: sz, timeout: 90 }); }
      catch (e) { return { ok: false, error: `не дошла до входа ${sx} ${sy} ${sz}: ${e.message.slice(0, 120)}` }; }
    }
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + e.message); }

    let cx = sx, cz = sz, dug = 0, torches = 0;
    const cy = sy; const sealed = [];
    const start = [sx, sy, sz];
    const out = (why, okForce) => {
      const ok = okForce !== undefined ? okForce : dug > 0;
      const r = { ok, dug, start, end: [cx, cy, cz], ores: [...ores.values()], sealed, torches };
      if (why) r.stopped = why;
      if (!ok) r.error = why || 'не прокопала ни блока';
      return r;
    };
    // заделать жидкость в клетке (вода — булыжником; лава — стоп)
    const seal = async (x, y, z, b) => {
      if (/lava/.test(b)) return `лава в ${x} ${y} ${z}`;
      if ((await api.count('cobblestone')) < 1) return `вода в ${x} ${y} ${z}, а булыжника нет`;
      try { await api.cmd('place_at', { x, y, z, item: 'cobblestone' }); sealed.push([x, y, z]); return null; }
      catch (e) { return `не заделала воду ${x} ${y} ${z}: ${e.message.slice(0, 80)}`; }
    };

    for (let k = 0; k < length; k++) {
      if ((Date.now() - t0) / 1000 > maxSec) return out('время вышло');
      const nx = cx + d[0], nz = cz + d[1];
      const box = { x1: Math.min(cx, nx) - 1, x2: Math.max(cx, nx) + 1 + Math.abs(d[0]), z1: Math.min(cz, nz) - 1, z2: Math.max(cz, nz) + 1 + Math.abs(d[1]), y1: cy - 1, y2: cy + 2 };
      if (d[0] < 0) box.x1 -= 1; if (d[1] < 0) box.z1 -= 1;
      const scan = async () => grid(await api.cmd('survey', box));
      // соседи клеток (nx, y) со всех сторон, кроме нашей
      const around = y => [[nx, y + 1, nz], [nx, y - 1, nz], [nx + d[0], y, nz + d[1]], ...side.map(([ox, oz]) => [nx + ox, y, nz + oz])];
      let g = await scan();
      for (const y of [cy + 1, cy]) {
        const b = g(nx, y, nz);
        if (/lava/.test(b)) return out(`лава впереди ${nx} ${y} ${nz}`);
        if (/water/.test(b)) { const err = await seal(nx, y, nz, b); if (err) return out(err); g = await scan(); }
        const nb = g(nx, y, nz);
        if (nb !== '?' && AIRLIKE.test(nb)) continue;
        try { await api.cmd('dig_at', { x: nx, y, z: nz }); }
        catch (e) {
          if (/нет такого блока/.test(e.message)) continue;
          return out(`dig ${nx} ${y} ${nz}: ${e.message.slice(0, 120)}`);
        }
        g = await scan();
        for (const [ax, ay, az] of around(y)) {
          if (ay === cy && ax === nx && az === nz) continue;
          if (ay === cy + 1 && ax === nx && az === nz) continue;
          const ab = g(ax, ay, az);
          if (/lava/.test(ab)) return out(`лава открылась в ${ax} ${ay} ${az}`);
          if (/water/.test(ab)) { const err = await seal(ax, ay, az, ab); if (err) return out(err); }
        }
      }
      g = await scan();
      noteOres(g, nx, cy, nz);
      // пол: дыра — заложить булыжником (обычно пещера под туннелем)
      const floor = g(nx, cy - 1, nz);
      if (floor !== '?' && (AIRLIKE.test(floor) || /water/.test(floor))) {
        if ((await api.count('cobblestone')) < 1) return out(`дыра в полу ${nx} ${cy - 1} ${nz}, а булыжника нет`);
        try { await api.cmd('place_at', { x: nx, y: cy - 1, z: nz, item: 'cobblestone' }); sealed.push([nx, cy - 1, nz]); }
        catch (e) { return out(`дыра в полу ${nx} ${cy - 1} ${nz}: ${e.message.slice(0, 80)}`); }
      }
      try { await api.cmd('goto', { x: nx, y: cy, z: nz, timeout: 20 }); }
      catch (e) { return out(`goto ${nx} ${cy} ${nz}: ${e.message.slice(0, 100)}`); }
      cx = nx; cz = nz; dug++;
      if (torchEvery > 0 && dug % torchEvery === 0 && (await api.count('torch')) > 0) {
        // факел сзади на пол (клетка, откуда пришли)
        const bx = cx - d[0], bz = cz - d[1];
        try { await api.cmd('place_at', { x: bx, y: cy, z: bz, item: 'torch' }); torches++; } catch (e) { api.log('факел: ' + e.message.slice(0, 80)); }
      }
      if (dug % 8 === 0) api.log(`туннель ${dug}/${length}, руд ${ores.size}`);
    }
    return out(null, true);
  }
};
