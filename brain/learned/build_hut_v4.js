// версия: как v3, но стену ставит с заменой: сначала копает клетку, потом ставит; проём двери расчищает
// build_hut — строит хижину 5x5 внутри (7x7 снаружи) из булыжника и еловых брёвен,
// пол — булыжник, крыша — еловые доски, дверь — с указанной стороны (по умолчанию запад).
// params: x,z — внутренний юго-западный угол (минимальные x,z), y — верхний блок пола,
//         door: west|east|south|north.
// Сначала survey площадки, потом пол -> стены снизу вверх -> крыша -> дверь.
const COBBLE = 'cobblestone';
const LOG = 'spruce_log';
const PLANK = 'spruce_planks';

function parseSurvey(sv) {
  return {
    origin: sv.origin,
    legend: sv.legend || {},
    layers: sv.layers || {},
    heightmap: sv.heightmap,
  };
}
function blockAt(sv, x, y, z) {
  const rows = sv.layers['y=' + y];
  if (!rows) return undefined;
  const row = rows[z - sv.origin.z];
  if (!row) return undefined;
  const ch = row[x - sv.origin.x];
  if (ch === undefined) return undefined;
  return sv.legend[ch];
}
function heightAt(sv, x, z) {
  if (!sv.heightmap) return null;
  const row = sv.heightmap[z - sv.origin.z];
  if (!row) return null;
  const v = row[x - sv.origin.x];
  return v === undefined ? null : v;
}

module.exports = {
  name: 'build_hut',
  description: 'Хижина 5x5 (7x7 снаружи): пол булыжник, стены булыжник + брёвна по углам, плоская крыша из досок, дверь. Строит выученным планом после survey.',
  params: {
    x: 'x внутреннего юго-западного угла (минимум)',
    z: 'z внутреннего юго-западного угла (минимум)',
    y: 'y верхнего блока пола (на нём стоит бот внутри)',
    door: 'сторона двери: west (по умолчанию), east, south, north',
    roof: 'planks (по умолчанию, 49 досок) или mixed (25 досок внутри + булыжник по краю, экономит дерево)',
    corners: 'log (по умолчанию, брёвна по углам) или cobble (без дерева, если мало леса)'
  },
  async run(api, params) {
    const ix = Math.round(Number(params.x));
    const iz = Math.round(Number(params.z));
    const fy = Math.round(Number(params.y));
    const door = ['west', 'east', 'south', 'north'].includes(params.door) ? params.door : 'west';
    const roof = params.roof === 'mixed' ? 'mixed' : 'planks';
    const corners = params.corners === 'cobble' ? 'cobble' : 'log';
    if (!Number.isFinite(ix) || !Number.isFinite(iz) || !Number.isFinite(fy)) {
      return { ok: false, error: 'нужны x, z, y' };
    }
    const ox1 = ix - 1, ox2 = ix + 5, oz1 = iz - 1, oz2 = iz + 5;
    const sv = parseSurvey(await api.cmd('survey', { x1: ix - 2, y1: fy - 3, z1: iz - 2, x2: ix + 6, y2: fy + 5, z2: iz + 6 }));
    if (!sv.heightmap) return { ok: false, error: 'survey без heightmap' };

    if ((await api.count(COBBLE)) < 10) return { ok: false, error: 'мало булыжника (нужно ~80)' };
    if ((await api.count(LOG)) + Math.floor((await api.count(PLANK)) / 4) < 1) return { ok: false, error: 'нет дерева на крышу/углы' };

    // проверим, что чанки загружены (в legend не должно быть '?' в нужных слоях)
    for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
      const h = heightAt(sv, x, z);
      if (h === null && blockAt(sv, x, fy + 1, z) === undefined) return { ok: false, error: `чанк не загружен у ${x},${z}` };
    }

    const placed = {}, failed = [], missing = [];
    const put = async (x, y, z, item) => {
      const cur = blockAt(sv, x, y, z);
      if (cur && cur !== 'air' && !/water|lava/.test(cur)) return; // уже стоит твёрдое — не трогаем
      if (cur && /water|lava/.test(cur)) { failed.push({ x, y, z, item, why: 'жидкость' }); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await api.cmd('place_at', { x, y, z, item });
          placed[item] = (placed[item] || 0) + 1;
          return;
        } catch (e) {
          if (attempt === 1) failed.push({ x, y, z, item, why: e.message });
          else await api.sleep(250);
        }
      }
    };
    const clear = async (x, y, z) => {
      const cur = blockAt(sv, x, y, z);
      if (!cur || cur === 'air') return;
      if (/water|lava/.test(cur)) return;
      try { await api.cmd('dig_at', { x, y, z }); } catch (e) { api.log(`dig ${x},${y},${z}: ${e.message}`); }
    };
    const putForce = async (x, y, z, item) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await api.cmd('place_at', { x, y, z, item });
          placed[item] = (placed[item] || 0) + 1;
          return;
        } catch (e) {
          if (/занято|уже стоит|нельзя/.test(e.message)) return;
          if (attempt === 1) failed.push({ x, y, z, item, why: e.message });
          else await api.sleep(250);
        }
      }
    };

    // 0. подойти снаружи с юга, чтобы не мешать полу
    try { await api.cmd('goto', { x: ix + 2, y: fy + 1, z: iz + 6 }); } catch (e) { api.log('goto старт: ' + e.message); }

    // 1. пол: заполняем пустоты на уровне fy
    for (let z = iz; z <= iz + 4; z++) for (let x = ix; x <= ix + 4; x++) {
      const h = heightAt(sv, x, z);
      if (h !== null && h > fy) {
        for (let yy = h; yy > fy; yy--) await clear(x, yy, z);
      }
      await put(x, fy, z, COBBLE);
    }
    api.log(`пол: ${JSON.stringify(placed)}`);

    // 2. стены: кольцо 7x7, снизу вверх
    const doorCell = {
      west: { x: ox1, z: iz + 2 }, east: { x: ox2, z: iz + 2 },
      south: { x: ix + 2, z: oz2 }, north: { x: ix + 2, z: oz1 }
    }[door];
    for (let y = fy + 1; y <= fy + 3; y++) {
      for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
        const isRing = x === ox1 || x === ox2 || z === oz1 || z === oz2;
        if (!isRing) continue;
        if (x === doorCell.x && z === doorCell.z && (y === fy + 1 || y === fy + 2)) { await clear(x, y, z); continue; } // проём двери
        const corner = (x === ox1 || x === ox2) && (z === oz1 || z === oz2);
        await clear(x, y, z);
        await putForce(x, y, z, corner && y <= fy + 2 && corners === 'log' ? LOG : COBBLE);
      }
    }
    api.log(`стены: ${JSON.stringify(placed)}`);

    // 3. крыша: 7x7 по цепочке, чтобы у каждого блока был сосед
    for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
      const edge = x === ox1 || x === ox2 || z === oz1 || z === oz2;
      await put(x, fy + 4, z, roof === 'mixed' && edge ? COBBLE : PLANK);
    }
    api.log(`крыша: ${JSON.stringify(placed)}`);

    // 4. дверь
    try {
      await api.cmd('place_at', { x: doorCell.x, y: fy + 1, z: doorCell.z, item: 'spruce_door' });
      placed.spruce_door = 1;
    } catch (e) { failed.push({ x: doorCell.x, y: fy + 1, z: doorCell.z, item: 'spruce_door', why: e.message }); }

    // 5. проверка: survey заново, считаем дырки в стенах/крыше
    await api.sleep(400);
    const sv2 = parseSurvey(await api.cmd('survey', { x1: ix - 2, y1: fy, z1: iz - 2, x2: ix + 6, y2: fy + 5, z2: iz + 6 }));
    let holes = 0;
    for (let y = fy + 1; y <= fy + 4; y++) {
      for (let z = oz1; z <= oz2; z++) for (let x = ox1; x <= ox2; x++) {
        const isRing = x === ox1 || x === ox2 || z === oz1 || z === oz2;
        const isRoof = y === fy + 4;
        if (!isRing && !isRoof) continue;
        if (!isRoof && x === doorCell.x && z === doorCell.z && y <= fy + 2) continue;
        const b = blockAt(sv2, x, y, z);
        if (!b || b === 'air') { holes++; if (missing.length < 40) missing.push([x, y, z]); }
      }
    }

    return {
      ok: failed.length === 0 && holes === 0,
      placed, failed: failed.slice(0, 20), holes, missing,
      door: doorCell, floorY: fy, interior: { x: ix, z: iz }
    };
  }
};
