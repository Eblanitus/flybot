// версия: была текущей на 22.10; против v1: без cells сама находит кромку обрыва (survey.edges, радиус r), dry=1, не хватает заборов — не начинает (missing)
// build_fence_line — забор по краю обрыва.
// Клетки: cells=[[x,y,z],…] (y — верхний твёрдый блок, забор в y+1), или линия x1,z1,x2,z2,y,
// или авто: край обрыва из survey.edges в радиусе r от x,z (y — уровень площадки, по умолчанию где стою):
// берутся клетки края на высоте y±2 (а не уступы внутри каньона), забор — на самой кромке, со стороны суши.
// dirs="З" — только края, где обрыв на запад. max — не больше стольких столбов. dry=1 — только посчитать.
// Возвращает {ok, placed, already, total, verified, skipped, failed} или {ok:false, error, missing}.
const DEFAULT_ITEM = 'spruce_fence';
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|dandelion|poppy|[a-z_]*flower)$/;

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

// цепочка «ближайший сосед» от точки — чтобы бот шёл вдоль края, а не прыгал
function chain(cells, from) {
  const rest = cells.slice(); const out = [];
  let cur = from;
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = Math.abs(rest[i][0] - cur[0]) + Math.abs(rest[i][2] - cur[2]); if (d < bd) { bd = d; bi = i; } }
    cur = rest.splice(bi, 1)[0]; out.push(cur);
  }
  return out;
}

module.exports = {
  name: 'build_fence_line',
  description: 'Забор (spruce_fence) по краю обрыва. Без cells сам находит кромку через survey.edges в радиусе r от x,z (высота y±2) и ставит забор в y+1 на кромке. Или cells=[[x,y,z]…] / x1,z1,x2,z2,y. Не хватает заборов — не начинает (missing). dry=1 — посчитать. Итог проверяет survey.',
  params: {
    x: 'центр поиска края (авто-режим), по умолчанию где стою', z: 'центр поиска края', r: 'радиус поиска края, по умолчанию 8 (максимум 12)',
    y: 'уровень площадки (верхний твёрдый блок у края), по умолчанию под ногами',
    dirs: 'необязательно: только края с обрывом в эти стороны, напр. "З" или "ЗС"',
    max: 'не больше стольких столбов (по умолчанию 40)',
    cells: 'массив [x,y,z] верхних твёрдых блоков (вместо авто)',
    x1: 'начало линии (вместо авто)', z1: 'начало линии', x2: 'конец линии', z2: 'конец линии',
    item: 'блок забора, по умолчанию spruce_fence',
    dry: '1 — ничего не ставить, вернуть need/have/missing'
  },
  async run(api, params) {
    const item = params.item || DEFAULT_ITEM;
    const max = Math.min(Math.max(Math.floor(Number(params.max)) || 40, 1), 120);
    const snap = await api.snapshot();
    const pos = snap.position || { x: 0, y: 64, z: 0 };
    let cells = Array.isArray(params.cells) ? params.cells.map(c => c.map(Number)).filter(c => c.length === 3 && c.every(Number.isFinite)) : [];
    let mode = 'cells';
    const hasLine = ['x1', 'z1', 'x2', 'z2'].every(k => params[k] !== undefined);
    if (!cells.length && hasLine) {
      mode = 'line';
      const x1 = Math.round(Number(params.x1)), z1 = Math.round(Number(params.z1));
      const x2 = Math.round(Number(params.x2)), z2 = Math.round(Number(params.z2));
      const y = Math.round(Number(params.y));
      if (![x1, z1, x2, z2, y].every(Number.isFinite)) return { ok: false, error: 'для линии нужны x1,z1,x2,z2,y' };
      if (x1 !== x2 && z1 !== z2) return { ok: false, error: 'линия должна быть по x или по z' };
      const n = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1));
      for (let i = 0; i <= n; i++) cells.push([x1 + Math.sign(x2 - x1) * i, y, z1 + Math.sign(z2 - z1) * i]);
    }
    let edgesFound = 0;
    if (!cells.length) {
      mode = 'auto';
      const cx = Math.floor(Number.isFinite(Number(params.x)) && params.x !== undefined ? Number(params.x) : pos.x);
      const cz = Math.floor(Number.isFinite(Number(params.z)) && params.z !== undefined ? Number(params.z) : pos.z);
      const ry = Math.floor(params.y !== undefined && Number.isFinite(Number(params.y)) ? Number(params.y) : pos.y - 1);
      const r = Math.min(Math.max(Math.floor(Number(params.r)) || 8, 2), 12);
      const h = Math.max(6, Math.min(16, Math.floor(4096 / ((2 * r + 1) * (2 * r + 1)))));
      const sv = await api.cmd('survey', { x1: cx - r, y1: ry + 3 - h, z1: cz - r, x2: cx + r, y2: ry + 2, z2: cz + r });
      const want = params.dirs ? String(params.dirs) : null;
      const g0 = grid(sv);
      // уже стоящий забор сам становится «верхним блоком» края — опустить такую клетку на блок ниже
      const edges = (sv.edges || []).map(e => (/fence|wall/.test(g0(e.x, e.y, e.z)) ? { ...e, y: e.y - 1 } : e))
        .filter(e => Math.abs(e.y - ry) <= 2 && (!want || [...e.dirs].some(d => want.includes(d))));
      edgesFound = edges.length;
      cells = [...new Map(edges.map(e => [e.x + ',' + e.z, [e.x, e.y, e.z]])).values()];
      if (!cells.length) return { ok: false, error: `края обрыва в радиусе ${r} от ${cx} ${cz} на высоте ${ry}±2 не нашла (edges всего ${(sv.edges || []).length})` };
    }
    if (cells.length > max) cells = chain(cells, [pos.x, pos.y, pos.z]).slice(0, max);
    cells = chain(cells, [pos.x, pos.y, pos.z]);

    const xs = cells.map(c => c[0]), zs = cells.map(c => c[2]), ys = cells.map(c => c[1]);
    const box = { x1: Math.min(...xs), y1: Math.min(...ys), z1: Math.min(...zs), x2: Math.max(...xs), y2: Math.max(...ys) + 1, z2: Math.max(...zs) };
    const vol = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1);
    if (vol > 4096) return { ok: false, error: `клетки слишком разбросаны (${vol} блоков объёма) — раздели на части` };
    let g = grid(await api.cmd('survey', box));

    const todo = []; const skipped = []; let already = 0;
    for (const [x, y, z] of cells) {
      const top = g(x, y, z), above = g(x, y + 1, z);
      if (/fence|wall/.test(above)) { already++; continue; }
      if (top === '?' || AIRLIKE.test(top) || /water|lava/.test(top)) { skipped.push({ at: [x, y, z], why: 'нет опоры (' + top + ')' }); continue; }
      if (above !== '?' && !AIRLIKE.test(above)) { skipped.push({ at: [x, y, z], why: 'занято (' + above + ')' }); continue; }
      todo.push([x, y, z]);
    }
    const have = (snap.inventory || []).filter(i => i.name === item).reduce((s, i) => s + i.count, 0);
    const need = { [item]: todo.length };
    const missing = have < todo.length ? { [item]: todo.length - have } : {};
    const plan = `${mode}: клеток ${cells.length}${edgesFound ? ` (край найден: ${edgesFound})` : ''}, уже стоит ${already}, ставить ${todo.length}, пропуск ${skipped.length}` +
      (todo.length ? `; от ${todo[0].join(' ')} до ${todo[todo.length - 1].join(' ')}` : '');

    if (isDry(params)) return { ok: true, dry: true, need, have: { [item]: have }, missing, plan, cells: todo.slice(0, 60), skipped: skipped.slice(0, 10) };
    if (!todo.length) return { ok: already > 0, placed: 0, already, total: cells.length, skipped, plan, ...(already ? {} : { error: 'некуда ставить: ' + JSON.stringify(skipped.slice(0, 3)) }) };
    if (Object.keys(missing).length) return { ok: false, error: `не хватает ${item}: ${have}/${todo.length} (gather_list items="${item}:${todo.length}")`, need, have: { [item]: have }, missing, plan };

    const placed = []; const failed = [];
    for (const [x, y, z] of todo) {
      try { await api.cmd('place_at', { x, y: y + 1, z, item }); placed.push([x, y + 1, z]); }
      catch (e) { failed.push({ at: [x, y + 1, z], why: e.message.slice(0, 100) }); if (failed.length >= 6 && !placed.length) break; }
    }
    await api.sleep(300);
    g = grid(await api.cmd('survey', box));
    const verified = cells.filter(([x, y, z]) => /fence|wall/.test(g(x, y + 1, z))).length;
    const ok = !failed.length && verified >= already + placed.length;
    const res = { ok, placed: placed.length, already, total: cells.length, verified, item, plan };
    if (skipped.length) res.skipped = skipped.slice(0, 10);
    if (failed.length) res.failed = failed.slice(0, 10);
    if (!ok) res.error = `стоит ${verified} из ${cells.length - skipped.length}; ошибок ${failed.length}` + (failed[0] ? ': ' + failed[0].why : '');
    return res;
  }
};
