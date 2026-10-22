// версия: первая: забор только по заданным клеткам cells или линии x1,z1,x2,z2,y
// build_fence_line — ставит забор по линии клеток у края обрыва.
// params: cells: [[x,y,z], ...] где y — ВЕРХНИЙ твёрдый блок; забор ставится в y+1.
//         или x1,z1,x2,z2,y — линия (по x или z, шаг 1).
//         item — "spruce_fence" (по умолчанию), count проверяется по инвентарю.
// Сначала survey, потом place_at по одной клетке; клетки с жидкостью/без опоры пропускаются.
const DEFAULT_ITEM = 'spruce_fence';

module.exports = {
  name: 'build_fence_line',
  description: 'Забор (spruce_fence) по линии на краю обрыва. cells=[[x,y,z]...] (y верхнего твёрдого блока) или x1,z1,x2,z2,y. Ставит в y+1, проверяет survey.',
  params: {
    cells: 'массив [x,y,z] верхних твёрдых блоков (необязательно)',
    x1: 'начало линии (если нет cells)', z1: 'начало линии', x2: 'конец линии', z2: 'конец линии', y: 'верхний твёрдый блок для линии',
    item: 'блок забора, по умолчанию spruce_fence'
  },
  async run(api, params) {
    const item = params.item || DEFAULT_ITEM;
    let cells = Array.isArray(params.cells) ? params.cells.map(c => c.map(Number)) : [];
    if (!cells.length) {
      const x1 = Math.round(Number(params.x1)), z1 = Math.round(Number(params.z1));
      const x2 = Math.round(Number(params.x2)), z2 = Math.round(Number(params.z2));
      const y = Math.round(Number(params.y));
      if (![x1, z1, x2, z2, y].every(Number.isFinite)) return { ok: false, error: 'нужны cells или x1,z1,x2,z2,y' };
      if (x1 !== x2 && z1 !== z2) return { ok: false, error: 'линия должна быть по x или по z' };
      const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
      for (let i = 0; i <= n; i++) cells.push([x1 + Math.sign(x2 - x1) * i, y, z1 + Math.sign(z2 - z1) * i]);
    }
    const have = await api.count(item);
    if (have < cells.length) return { ok: false, error: `не хватает ${item}: ${have}/${cells.length}` };

    const xs = cells.map(c => c[0]), zs = cells.map(c => c[2]);
    const sv = await api.cmd('survey', {
      x1: Math.min(...xs) - 1, y1: Math.min(...cells.map(c => c[1])) - 1, z1: Math.min(...zs) - 1,
      x2: Math.max(...xs) + 1, y2: Math.max(...cells.map(c => c[1])) + 2, z2: Math.max(...zs) + 1
    });
    const blockAt = (x, y, z) => {
      const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return undefined;
      const row = rows[z - sv.origin.z]; if (!row) return undefined;
      const ch = row[x - sv.origin.x]; if (ch === undefined) return undefined;
      return sv.legend[ch];
    };

    const placed = [], skipped = [], failed = [];
    for (const [x, y, z] of cells) {
      const top = blockAt(x, y, z);
      if (!top || top === 'air' || /water|lava/.test(top)) { skipped.push({ x, y, z, why: 'нет опоры (' + top + ')' }); continue; }
      const above = blockAt(x, y + 1, z);
      if (above && above !== 'air') { skipped.push({ x, y, z, why: 'занято (' + above + ')' }); continue; }
      try {
        await api.cmd('place_at', { x, y: y + 1, z, item });
        placed.push([x, y + 1, z]);
      } catch (e) {
        failed.push({ x, y: y + 1, z, why: e.message });
      }
    }
    return { ok: failed.length === 0 && placed.length > 0, placed: placed.length, skipped, failed, item };
  }
};
