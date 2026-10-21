// farm_plot — грядка size×size у воды: вскопать (till) только клетки в 4 блоках от воды и посадить семена (plant).
// Повторный вызов на том же месте: собирает спелое и пересаживает (harvest), довскапывает и досаживает свободное.
// Центр участка — x,z; не задан — ближайшая видимая вода (она в центре, как классическая ферма 9×9 с водой посередине).
// Нет воды рядом — ничего не копает ({ok:false, missing:{water}}). Мотыгу при отсутствии пробует скрафтить деревянную.
const SEED_CROP = { wheat_seeds: 'wheat', carrot: 'carrot', potato: 'potato', beetroot_seeds: 'beetroot' };
const GROUND = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path', 'farmland']);
const CROP_BLOCK = { wheat: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot: 'beetroots' };
const AIRISH = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|[a-z]+_tulip|snow)$/;

const clean = e => String(e && e.message || e).replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 140);
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

module.exports = {
  name: 'farm_plot',
  description: 'Грядка size×size у воды: вскапывает (till) клетки в 4 блоках от воды и сажает семена; повторный вызов — собирает спелое и пересаживает. Нет воды/мотыги/семян — {ok:false, missing}. Возвращает harvested, tilled, planted, plot.',
  params: {
    x: 'x центра участка; по умолчанию — ближайшая видимая вода',
    z: 'z центра участка',
    size: 'сторона участка, 2..11; по умолчанию 5',
    seed: 'wheat_seeds (по умолчанию) | carrot | potato | beetroot_seeds',
    max_sec: 'потолок по времени, по умолчанию 300'
  },
  async run(api, params) {
    params = params || {};
    const seed = String(params.seed || 'wheat_seeds').toLowerCase();
    const crop = SEED_CROP[seed];
    if (!crop) return { ok: false, error: `seed "${params.seed}": ${Object.keys(SEED_CROP).join('|')} (арбуз/тыкву на грядке не собираю)` };
    const size = Math.min(11, Math.max(2, Math.floor(Number(params.size)) || 5));
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 300) * 1000;
    const notes = [];

    let snap = await api.snapshot();
    const inv0 = invMap(snap.inventory);
    // центр
    let cx, cz;
    if (params.x !== undefined && params.z !== undefined && Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.z))) {
      cx = Math.floor(Number(params.x)); cz = Math.floor(Number(params.z));
    } else {
      const w = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.water;
      if (!w || !w.at) return { ok: false, error: 'не задан x,z и воды не видно: найди воду (explore/find water) или укажи x,z участка рядом с водой', missing: { water: 'видимый водоём' } };
      cx = w.at[0]; cz = w.at[2];
    }
    const x1 = cx - Math.floor((size - 1) / 2), z1 = cz - Math.floor((size - 1) / 2), x2 = x1 + size - 1, z2 = z1 + size - 1;

    // подойти
    const p0 = snap.position;
    if (Math.hypot(p0.x - cx, p0.z - cz) > 6) {
      try { await api.cmd('goto', { x: cx, z: cz, timeout: 90 }); }
      catch (e) { return { ok: false, error: 'не дошла до участка: ' + clean(e), plot: { x1, z1, x2, z2 } }; }
      snap = await api.snapshot();
    }
    const by = Math.floor(snap.position.y + 0.001);

    // survey участка и воды вокруг
    let g;
    try { g = gridOf(await api.cmd('survey', { x1: x1 - 4, y1: by - 4, z1: z1 - 4, x2: x2 + 4, y2: by + 3, z2: z2 + 4 })); }
    catch (e) { return { ok: false, error: 'survey участка: ' + clean(e), plot: { x1, z1, x2, z2 } }; }
    // верхний «земляной» блок каждой колонки
    const col = (x, z) => {
      for (let y = by + 3; y >= by - 4; y--) { const n = g(x, y, z); if (GROUND.has(n) || n === 'water') return { y, n }; }
      return null;
    };
    const yCount = {};
    const cells = [];
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      const c = col(x, z);
      cells.push({ x, z, c });
      if (c) yCount[c.y] = (yCount[c.y] || 0) + 1;
    }
    const ys = Object.keys(yCount).sort((a, b) => yCount[b] - yCount[a]);
    if (!ys.length) return { ok: false, error: 'на участке нет земли/воды в видимом (survey) — подойди ближе или выбери другое место', plot: { x1, z1, x2, z2 } };
    const yF = Number(ys[0]);
    // вода у участка на уровне грядки или на 1 выше
    const water = [];
    for (let x = x1 - 4; x <= x2 + 4; x++) for (let z = z1 - 4; z <= z2 + 4; z++) for (const y of [yF, yF + 1]) if (g(x, y, z) === 'water') water.push({ x, y, z });
    const wet = (x, z) => water.some(q => Math.abs(q.x - x) <= 4 && Math.abs(q.z - z) <= 4);
    if (!water.length) return { ok: false, error: `у участка ${x1},${z1}..${x2},${z2} нет воды в 4 клетках на уровне y=${yF} (или на 1 выше) — без неё земля высохнет; выбери место у воды`, missing: { water: 'в 4 клетках от грядок' }, plot: { x1, z1, x2, z2, y: yF } };

    let uneven = 0, dry = 0, farmland = 0, crops = 0;
    const toTill = [];
    for (const { x, z, c } of cells) {
      if (!c || c.n === 'water') continue;
      if (c.y !== yF) { uneven++; continue; }
      if (!wet(x, z)) { dry++; continue; }
      if (c.n === 'farmland') { farmland++; if (g(x, yF + 1, z) === CROP_BLOCK[crop]) crops++; continue; }
      if (!AIRISH.test(g(x, yF + 1, z) || 'air') && g(x, yF + 1, z) !== '?') continue; // сверху что-то твёрдое
      toTill.push({ x, z });
    }
    const out = { plot: { x1, z1, x2, z2, y: yF }, crop, seed, wetCells: cells.filter(c => c.c && c.c.n !== 'water' && c.c.y === yF && wet(c.x, c.z)).length, dryCells: dry, unevenCells: uneven, harvested: 0, replanted: 0, tilled: 0, planted: 0, notes };

    // 1. собрать спелое
    let anyCrop = false;
    for (let x = x1; x <= x2 && !anyCrop; x++) for (let z = z1; z <= z2; z++) if (g(x, yF + 1, z) === CROP_BLOCK[crop]) { anyCrop = true; break; }
    if (anyCrop && Date.now() < deadline) {
      try {
        const r = await api.cmd('harvest', { crop, radius: Math.min(32, Math.ceil(size * 0.75) + 2), replant: true });
        out.harvested = r.harvested || 0; out.replanted = typeof r.replanted === 'number' ? r.replanted : 0; out.immature = r.immature;
        if (r.note) notes.push(r.note);
      } catch (e) { notes.push('harvest: ' + clean(e)); }
    }

    // 2. вскопать
    if (toTill.length && Date.now() < deadline) {
      snap = await api.snapshot();
      let m = invMap(snap.inventory);
      if (!Object.keys(m).some(n => /_hoe$/.test(n) && m[n] > 0)) {
        try { await api.cmd('craft', { item: 'wooden_hoe' }); notes.push('скрафтила деревянную мотыгу'); m = invMap((await api.snapshot()).inventory); }
        catch (e) { notes.push('мотыги нет и не скрафтить: ' + clean(e)); }
      }
      if (Object.keys(m).some(n => /_hoe$/.test(n) && m[n] > 0)) {
        // строки → непрерывные отрезки по x
        const byZ = {};
        for (const c of toTill) (byZ[c.z] = byZ[c.z] || []).push(c.x);
        for (const z of Object.keys(byZ).map(Number).sort((a, b) => a - b)) {
          const xs = byZ[z].sort((a, b) => a - b);
          let i = 0;
          while (i < xs.length) {
            let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
            if (Date.now() > deadline) { notes.push('вышло время max_sec на вскапывании'); i = xs.length; break; }
            try { const r = await api.cmd('till', { x1: xs[i], z1: z, x2: xs[j], z2: z, y: yF }); out.tilled += r.tilled || 0; }
            catch (e) { notes.push(`till ${xs[i]}..${xs[j]},${z}: ${clean(e)}`); }
            i = j + 1;
          }
        }
      } else out.missing = { hoe: 'любая мотыга (2 палки + 2 доски/булыжника…)' };
    }

    // 3. посадить на свободное
    snap = await api.snapshot();
    const seedsNow = invMap(snap.inventory)[seed] || 0;
    if (farmland + out.tilled > 0 || out.harvested) {
      if (seedsNow > 0) {
        try {
          const r = await api.cmd('plant', { seed, x1, z1, x2, z2, y: yF });
          out.planted = r.planted || 0; out.freeBeds = r.freeBeds; if (r.note) notes.push(r.note);
        } catch (e) { notes.push('plant: ' + clean(e)); }
      } else {
        out.missing = { ...(out.missing || {}), [seed]: 'нет семян для посадки' };
      }
    }
    try {
      const now = invMap((await api.snapshot()).inventory), gained = {};
      for (const n of Object.keys(now)) { const dd = now[n] - (inv0[n] || 0); if (dd > 0) gained[n] = dd; }
      out.gained = gained;
    } catch (e) { /* не страшно */ }

    const did = out.harvested + out.tilled + out.planted + out.replanted;
    if (dry) notes.push(`${dry} клеток вне 4 блоков от воды — не трогала`);
    if (uneven) notes.push(`${uneven} клеток на другой высоте — пропущены`);
    if (!did) {
      if (out.missing) return { ok: false, error: 'ничего не сделано: ' + Object.keys(out.missing).join(', ') + ' — ' + Object.values(out.missing).join('; '), ...out };
      if (farmland + crops > 0) return { ok: true, ...out, note: 'всё уже вскопано и посажено, спелого нет — приходи позже' };
      return { ok: false, error: 'на участке нечего вскапывать/сажать' + (notes[0] ? ': ' + notes[0] : ''), ...out };
    }
    return { ok: true, ...out };
  }
};
