// версия: как текущая deposit (22.10), но кладёт через chest_store_v6 (тот зовёт chest_open_v6): по заданным координатам без сундука ищется и открывается ближайший известный контейнер сам (subst), а не отказ; по заявке учителя (случай 20261022-111057-77, урок L053)
// deposit — дойти до сундука базы и сложить всё, кроме keep.
// Сундук: ближайший в радиусе 8 от x,y,z (params) или от метки home. Нет сундука — скрафтить (доски/брёвна) и поставить.
// keep: "pickaxe,axe,sword,shovel,food,torch,bed" (по умолчанию; плюс броня и щит всегда), "имя:n" — оставить n штук.
// Возвращает {ok, chest:[x,y,z], stored:{имя:n}, kept:[...], placedChest?}. dry=1 — только список.
const DEFAULT_KEEP = 'pickaxe,axe,sword,shovel,hoe,food,torch,bed';
const FOOD = /^(cooked_[a-z_]+|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|apple|golden_apple|golden_carrot|carrot|potato|baked_potato|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|suspicious_stew|honey_bottle)$/;
const ALWAYS = /_(helmet|chestplate|leggings|boots)$|^shield$|^(bow|crossbow|arrow|fishing_rod|shears|flint_and_steel|bucket|water_bucket|clock|compass)$/;
const AIRLIKE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow)$/;

function grid(sv) {
  return (x, y, z) => {
    const rows = sv.layers && sv.layers['y=' + y]; if (!rows) return '?';
    const row = rows[z - sv.origin.z]; if (!row) return '?';
    const ch = row[x - sv.origin.x]; if (ch === undefined) return '?';
    return (sv.legend && sv.legend[ch]) || '?';
  };
}
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

function keepRules(spec) {
  const rules = [];
  for (const tok of String(spec || '').split(/[,;\s]+/).filter(Boolean)) {
    const [name, n] = tok.split(/[:=]/);
    const cnt = n === undefined ? Infinity : Math.max(0, Math.floor(Number(n)) || 0);
    let test;
    if (name === 'food') test = s => FOOD.test(s);
    else if (name === 'bed') test = s => /_bed$/.test(s);
    else if (name === 'armor') test = s => /_(helmet|chestplate|leggings|boots)$/.test(s);
    else if (['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].includes(name)) test = s => s.endsWith('_' + name);
    else test = s => s === name;
    rules.push({ name, cnt, test });
  }
  return rules;
}

async function invMap(api) {
  const snap = await api.snapshot(); const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return { inv: m, snap };
}

module.exports = {
  name: 'deposit',
  description: 'Дойти до сундука базы (ближайший в радиусе 8 от x,y,z или метки home) и сложить всё, кроме keep ("pickaxe,axe,sword,shovel,food,torch,bed"; "cobblestone:16" — оставить 16). Броня/щит не кладёт. Нет сундука — скрафтит и поставит; заданные координаты пусты — chest_store_v6 найдёт и откроет ближайший известный контейнер сам. Сундук открывает через chest_store_v6: если мешает (блок над сундуком, сбоку занято) — отказ за 2-3 с с причиной. dry=1 — что сложит.',
  params: {
    keep: 'что оставить: "pickaxe,axe,sword,shovel,food,torch,bed" (по умолчанию); имя:n — оставить n штук',
    x: 'точка базы (необязательно; иначе метка home)', y: 'y', z: 'z',
    dry: '1 — ничего не делать, вернуть план'
  },
  async run(api, params) {
    let base = null;
    const px = Number(params.x), py = Number(params.y), pz = Number(params.z);
    if ([px, py, pz].every(Number.isFinite)) base = [Math.floor(px), Math.floor(py), Math.floor(pz)];
    else {
      try {
        const w = await api.cmd('waypoints', {});
        const home = (w.waypoints || []).find(p => p.name === 'home');
        if (home) base = home.at;
      } catch (e) { api.log('waypoints: ' + e.message); }
    }
    if (!base) return { ok: false, error: 'нет точки базы: дай x,y,z или поставь метку home (setup_base / mark name=home)' };
    const [bx, by, bz] = base;
    const rules = keepRules(params.keep || DEFAULT_KEEP);

    let { inv, snap } = await invMap(api);
    const plan = {}; const kept = [];
    for (const [name, n] of Object.entries(inv)) {
      if (ALWAYS.test(name)) { kept.push(name); continue; }
      const r = rules.find(q => q.test(name));
      if (r && r.cnt === Infinity) { kept.push(name); continue; }
      const keepN = r ? r.cnt : 0;
      if (n > keepN) plan[name] = n - keepN;
      if (keepN > 0) kept.push(`${name}:${Math.min(n, keepN)}`);
    }

    // найти сундук (если рядом — сразу, иначе после подхода)
    const findChest = async () => {
      const sv = await api.cmd('survey', { x1: bx - 8, y1: by - 3, z1: bz - 8, x2: bx + 8, y2: by + 3, z2: bz + 8 });
      const g = grid(sv); let best = null;
      for (let y = by - 3; y <= by + 3; y++) for (let z = bz - 8; z <= bz + 8; z++) for (let x = bx - 8; x <= bx + 8; x++) {
        if (!/^(chest|barrel|trapped_chest)$/.test(g(x, y, z))) continue;
        const d = Math.abs(x - bx) + Math.abs(y - by) + Math.abs(z - bz);
        if (!best || d < best.d) best = { d, at: [x, y, z] };
      }
      return { chest: best && best.at, g };
    };
    let { chest, g } = await findChest();
    const p0 = snap.position || {};
    const far = !(Math.abs((p0.x || 0) - bx) < 24 && Math.abs((p0.z || 0) - bz) < 24);

    if (isDry(params)) {
      const needChest = !chest;
      const need = needChest ? { chest: 1 } : {};
      const have = needChest ? { chest: inv.chest || 0, spruce_planks: (inv.spruce_planks || 0) + 4 * (inv.spruce_log || 0) } : {};
      const missing = needChest && !(inv.chest > 0) && have.spruce_planks < 8 ? { spruce_planks: 8 - have.spruce_planks } : {};
      return { ok: true, dry: true, need, have, missing, chest, store: plan, kept, plan: chest ? `сложить ${Object.keys(plan).length} видов в сундук ${chest.join(' ')}` : (far ? 'сундук не виден отсюда (далеко) — подойду и поищу; нет — поставлю новый' : 'сундука нет — скрафтить и поставить у базы') };
    }
    if (!Object.keys(plan).length) return { ok: true, chest, stored: {}, kept, note: 'складывать нечего' };

    // дойти до базы
    try { await api.cmd('goto', { x: bx, y: by, z: bz, timeout: 120 }); }
    catch (e) { return { ok: false, error: 'не дошла до базы: ' + e.message.slice(0, 160) }; }
    ({ chest, g } = await findChest());

    let placedChest = false;
    if (!chest) {
      ({ inv } = await invMap(api));
      if (!(inv.chest > 0)) {
        const r = await api.skill('gather_list', { items: 'chest:1', max_sec: 120 });
        if (!r || r.ok === false) return { ok: false, error: 'сундука нет и не скрафтить: ' + ((r && r.error) || '?') };
      }
      const spots = [];
      for (let z = bz - 3; z <= bz + 3; z++) for (let x = bx - 3; x <= bx + 3; x++) {
        const dh = Math.abs(x - bx) + Math.abs(z - bz); if (dh < 1) continue;
        for (let y = by - 1; y <= by + 1; y++) {
          const below = g(x, y - 1, z);
          if (AIRLIKE.test(g(x, y, z)) && below !== '?' && !AIRLIKE.test(below) && !/water|lava/.test(below) && AIRLIKE.test(g(x, y + 1, z))) { spots.push({ x, y, z, d: dh }); break; }
        }
      }
      spots.sort((a, b) => a.d - b.d);
      for (const s of spots.slice(0, 5)) {
        try { await api.cmd('place_at', { x: s.x, y: s.y, z: s.z, item: 'chest' }); chest = [s.x, s.y, s.z]; placedChest = true; break; }
        catch (e) { api.log('place chest: ' + e.message); }
      }
      if (!chest) return { ok: false, error: 'не смогла поставить сундук у базы' };
      // сундук сам может уйти в план — убрать
      delete plan.chest;
    }

    // сложить: полные — одним вызовом, частичные (keep имя:n) — по одному с count
    ({ inv } = await invMap(api));
    const stored = {}; const errors = [];
    const full = Object.keys(plan).filter(n => (inv[n] || 0) > 0 && plan[n] >= (inv[n] || 0));
    const part = Object.keys(plan).filter(n => (inv[n] || 0) > 0 && plan[n] < (inv[n] || 0));
    const [cx, cy, cz] = chest;
    // сложить через chest_store_v6: он (через chest_open_v6) проверяет, что мешает, встаёт на уровень сундука,
    // а если в точке сундука нет — сам ищет и открывает ближайший известный контейнер (subst в его ответе);
    // отказ приходит за 2-3 с с причиной и списком known
    let usedChest = chest;
    if (full.length) {
      try {
        const r = await api.skill('chest_store_v6', { items: full, x: cx, y: cy, z: cz });
        if (!r || r.ok === false) errors.push(String((r && r.error) || 'сундук не открылся').slice(0, 160));
        else { Object.assign(stored, r.stored || {}); if (Array.isArray(r.chest)) usedChest = r.chest; }
      }
      catch (e) { errors.push(e.message.slice(0, 160)); }
    }
    for (const n of part) {
      try {
        const r = await api.skill('chest_store_v6', { items: [n], count: plan[n], x: cx, y: cy, z: cz });
        if (!r || r.ok === false) errors.push(`${n}: ${String((r && r.error) || 'сундук не открылся').slice(0, 140)}`);
        else { Object.assign(stored, r.stored || {}); if (Array.isArray(r.chest)) usedChest = r.chest; }
      }
      catch (e) { errors.push(`${n}: ${e.message.slice(0, 120)}`); }
    }
    const bad = Object.entries(stored).filter(([, v]) => typeof v !== 'number');
    const ok = !errors.length && !bad.length && Object.keys(stored).length > 0;
    const res = { ok, chest: usedChest, stored, kept };
    if (placedChest) res.placedChest = true;
    if (!ok) res.error = 'не всё сложено: ' + (errors[0] || (bad[0] && `${bad[0][0]} ${bad[0][1]}`) || 'сундук полон?');
    return res;
  }
};
