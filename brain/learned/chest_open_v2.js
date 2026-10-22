// версия: как v1, но проверка клетки, куда встать (опора под ногами, место для головы), и короче тайм-ауты goto
// chest_open — подготовить муху к открытию сундука: найти сундук, сказать, что мешает,
// встать на уровень сундука и посмотреть на открытую боковую грань (а не кликать вверх).
// Контейнер не открывает — это делает навык тела (chest_take / chest_store).
// Вспомогательный навык: звать chest_take или chest_store, а не его напрямую.
// Итог: {ok:true, chest:[x,y,z], ready, blocker, fly:[x,y,z], face, faces, note}.
// blocker — причина, почему открыть нельзя (null — можно). ok:false не возвращает: помеха — не поломка.
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|snow_layer|dandelion|poppy|allium|azure_bluet|[a-z_]*flower)$/;
const CHESTS = /^(chest|trapped_chest|barrel)$/;
const SIDES = [{ dx: 1, dz: 0, dir: 'В' }, { dx: -1, dz: 0, dir: 'З' }, { dx: 0, dz: 1, dir: 'Ю' }, { dx: 0, dz: -1, dir: 'С' }];

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const walkable = name => name === '?' || AIRLIKE.test(name) || name === 'torch';       // можно стоять
const solidBlock = name => name !== '?' && !AIRLIKE.test(name) && name !== 'water' && name !== 'lava';
const freeFace = name => (name === '?' ? null : AIRLIKE.test(name) ? true : false);      // грань открыта? null — не видно

module.exports = {
  name: 'chest_open',
  description: 'Вспомогательный: найти сундук, проверить, что мешает (над сундуком блок / муха выше уровня / сундук не виден), встать на уровень сундука и посмотреть на открытую боковую грань. Сам не открывает — зови chest_take или chest_store.',
  params: {
    x: 'x сундука (необязательно; иначе — ближайший видимый или известный)',
    y: 'y сундука', z: 'z сундука'
  },
  async run(api, params) {
    const flyOf = async () => {
      const s = await api.snapshot();
      const p = s.position || {};
      return [Math.floor(Number(p.x) || 0), Math.floor(Number(p.y) || 0), Math.floor(Number(p.z) || 0)];
    };

    // --- 1. где сундук ---
    let chest = null;
    const px = Number(params.x), py = Number(params.y), pz = Number(params.z);
    if ([px, py, pz].every(Number.isFinite)) chest = [Math.floor(px), Math.floor(py), Math.floor(pz)];
    else {
      try {
        const s = await api.snapshot();
        const b = s.eyes && s.eyes.blocks && s.eyes.blocks.chest;
        if (b && Array.isArray(b.at) && b.at.length === 3) chest = b.at.map(v => Math.floor(Number(v)));
      } catch (e) { api.log('снимок: ' + e.message.slice(0, 120)); }
    }
    if (!chest) {
      try {
        const g = await api.cmd('goto_known', { kind: 'chest' });
        if (g && Array.isArray(g.at) && g.at.length === 3) chest = g.at.map(v => Math.floor(Number(v)));
      } catch (e) { api.log('goto_known chest: ' + e.message.slice(0, 120)); }
    }
    let fly = await flyOf();
    if (!chest) {
      return { ok: true, chest: null, ready: false, blocker: 'сундук не виден рядом и я такого места не помню — найди его (find/explore) или дай x,y,z', fly, faces: null, note: 'сундук не найден' };
    }
    const [cx, cy, cz] = chest;

    // --- 2. подойти, если далеко: вблизи вокруг сундука видно ---
    const dist = Math.max(Math.abs(fly[0] - cx), Math.abs(fly[2] - cz));
    const vert = Math.abs(fly[1] - cy);
    if (dist > 3 || vert > 1) {
      try { await api.cmd('goto', { x: cx, y: cy, z: cz, timeout: Math.min(45, Math.round(10 + dist * 1.2)) }); }
      catch (e) { api.log('goto к сундуку: ' + e.message.slice(0, 120)); }
      fly = await flyOf();
    }

    // --- 3. что вокруг сундука ---
    let g;
    try {
      const sv = await api.cmd('survey', { x1: cx - 1, y1: cy - 1, z1: cz - 1, x2: cx + 1, y2: cy + 2, z2: cz + 1 });
      g = grid(sv);
    } catch (e) {
      return { ok: true, chest, ready: false, blocker: `не смогла осмотреть вокруг сундука ${cx} ${cy} ${cz}: ${e.message.slice(0, 100)}`, fly, faces: null, note: 'survey не удался' };
    }

    const here = g(cx, cy, cz);
    const above = g(cx, cy + 1, cz);
    const faces = { above, aboveOpen: freeFace(above), sides: {} };
    const sideOpen = {};
    for (const s of SIDES) { faces.sides[s.dir] = g(cx + s.dx, cy, cz + s.dz); sideOpen[s.dir] = freeFace(faces.sides[s.dir]); }

    if (here === '?') {
      return { ok: true, chest, ready: false, blocker: `сундук ${cx} ${cy} ${cz} не вижу (за стеной или чанк не загружен) — муха ${fly.join(' ')} не подошла; подойди и повтори`, fly, faces, note: 'сундук не виден' };
    }
    if (!CHESTS.test(here)) {
      return { ok: true, chest, ready: false, blocker: `в точке ${cx} ${cy} ${cz} не сундук, а ${here} — дай координаты сундука`, fly, faces, note: 'не тот блок' };
    }

    // --- 4. куда встать: боком к сундуку (уровень сундука) или сверху ---
    const standable = (x, y, z) => {
      const c = g(x, y, z);
      if (!walkable(c)) return false;              // клетка занята
      if (!solidBlock(g(x, y - 1, z))) return false; // под ногами пусто
      if (!walkable(g(x, y + 1, z))) return false;   // не пройдёт головой
      return true;
    };
    const cands = [];
    for (const s of SIDES) {
      const st = sideOpen[s.dir];
      if (st === false) continue;                 // грань точно закрыта
      const cell = [cx + s.dx, cy, cz + s.dz];
      const stands = fly[0] === cell[0] && fly[1] === cell[1] && fly[2] === cell[2];
      if (!stands && !standable(cell[0], cell[1], cell[2])) continue;
      cands.push({ ...s, cell, sure: st === true, d: Math.abs(fly[0] - cell[0]) + Math.abs(fly[2] - cell[2]) + Math.abs(fly[1] - cell[1]) });
    }
    cands.sort((a, b) => (a.sure === b.sure ? a.d - b.d : (a.sure ? -1 : 1)));

    let target = cands[0] || null;
    let mode = 'side';
    if (!target && freeFace(above) === true) { target = { dx: 0, dz: 0, dir: 'верх', cell: [cx, cy + 1, cz] }; mode = 'top'; }
    if (!target) {
      const blockedAbove = solidBlock(above);
      const blocker = blockedAbove
        ? `над сундуком ${cx} ${cy} ${cz} блок ${above} — сначала dig_at ${cx} ${cy + 1} ${cz}, потом открывай; с боков подойти не к чему`
        : `к сундуку ${cx} ${cy} ${cz} не подойти: сбоку занято (${SIDES.map(s => `${s.dir}:${faces.sides[s.dir]}`).join(' ')}) и над сундуком неизвестно (${above}) — подойди и повтори`;
      return { ok: true, chest, ready: false, blocker, fly, faces, note: 'некуда встать' };
    }

    // --- 5. встать и посмотреть на открытую грань ---
    const at = target.cell;
    if (!(fly[0] === at[0] && fly[1] === at[1] && fly[2] === at[2])) {
      try { await api.cmd('goto', { x: at[0], y: at[1], z: at[2], timeout: 14 }); }
      catch (e) { api.log('встать у сундука: ' + e.message.slice(0, 120)); }
      fly = await flyOf();
    }
    const look = mode === 'top'
      ? [cx + 0.5, cy + 1, cz + 0.5]
      : [cx + 0.5 + target.dx * 0.5, cy + 0.5, cz + 0.5 + target.dz * 0.5];
    try { await api.cmd('look_at', { x: look[0], y: look[1], z: look[2], exact: true }); }
    catch (e) { api.log('look_at: ' + e.message.slice(0, 120)); }

    const note = mode === 'top'
      ? 'сундук открыт сверху (сбоку не подойти) — муха встала на сундук'
      : `муха на уровне сундука (${at.join(' ')}), смотрит на грань ${target.dir}`;
    return { ok: true, chest, ready: true, blocker: null, fly, face: mode === 'top' ? 'top' : target.dir, look, faces, note };
  }
};
