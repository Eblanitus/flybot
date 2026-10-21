// mine_vein — найти видимую жилу руды и выкопать связные блоки (в т.ч. по диагонали), пока она не кончится или не наберётся max.
// Руду берёт только из увиденного (eyes.blocks, честное зрение): не видно — {ok:false, seen:false}, там нужен explore/branch_mine.
// После каждого блока заново смотрит survey: жила открывается дальше. Клетки с лавой рядом пропускает. Сам не ищет, не копает проходы.
const ORES = { coal: 0, iron: 1, copper: 1, lapis: 1, gold: 2, redstone: 2, diamond: 2, emerald: 2 }; // нужный уровень кирки
const PICK = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, copper_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 3 };
const PICK_NAME = ['деревянная', 'каменная (или медная)', 'железная', 'алмазная'];

const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const key = (x, y, z) => x + ',' + y + ',' + z;
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
  name: 'mine_vein',
  description: 'Находит видимую жилу руды (iron, copper, coal, gold, diamond, redstone, lapis) и выкапывает все связные блоки до max. Руды не видно или кирка слабая — {ok:false} с причиной. Возвращает mined, gained.',
  params: {
    ore: 'iron | copper | coal | gold | diamond | redstone | lapis | emerald',
    max: 'сколько блоков руды выкопать максимум, по умолчанию 16',
    max_sec: 'потолок по времени, по умолчанию 180'
  },
  async run(api, params) {
    params = params || {};
    const ore = String(params.ore || '').toLowerCase().replace(/_ore$/, '').replace(/^raw_/, '');
    if (!(ore in ORES)) return { ok: false, error: `ore "${params.ore}": нужно ${Object.keys(ORES).join('|')}` };
    const max = Math.min(64, Math.max(1, Math.floor(Number(params.max)) || 16));
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 180) * 1000;
    const names = new Set([ore + '_ore', 'deepslate_' + ore + '_ore']);

    let snap = await api.snapshot();
    const inv0 = invMap(snap.inventory);
    let tier = -1;
    for (const n of Object.keys(inv0)) if (n in PICK && inv0[n] > 0) tier = Math.max(tier, PICK[n]);
    if (tier < ORES[ore]) {
      return { ok: false, error: `для ${ore} нужна ${PICK_NAME[ORES[ore]]} кирка или лучше, ${tier < 0 ? 'кирки нет' : 'у меня слабее'}`, missing: { pickaxe: PICK_NAME[ORES[ore]] }, mined: 0 };
    }
    const seedInfo = snap.eyes && snap.eyes.blocks && snap.eyes.blocks[ore + '_ore'];
    if (!seedInfo || !seedInfo.at) {
      return { ok: false, seen: false, error: `не вижу ${ore}_ore рядом (eyes.blocks) — исследуй (explore) или копай шахту (branch_mine)`, mined: 0 };
    }
    try { await api.cmd('equip_best', { for: 'dig' }); } catch (e) { api.log('equip_best: ' + e.message); }

    const seed = { x: seedInfo.at[0], y: seedInfo.at[1], z: seedInfo.at[2] };
    const dug = new Map();     // key -> {x,y,z}
    const failed = new Map();  // key -> причина
    let last = seed, mined = 0, consecFails = 0, reason = null, remaining = 0;
    const W = 5, DOWN = 4, UP = 4;

    for (let iter = 0; iter < max * 3 + 6; iter++) {
      if (mined >= max) { reason = 'набрано max'; break; }
      if (Date.now() > deadline) { reason = 'вышло время max_sec'; break; }
      snap = await api.snapshot();
      if (typeof snap.health === 'number' && snap.health < 8) { reason = 'мало HP'; break; }
      if ((snap.inventory || []).filter(i => i.slot >= 9 && i.slot <= 44).length >= 36) { reason = 'инвентарь полон'; break; }
      let g;
      try {
        g = gridOf(await api.cmd('survey', { x1: last.x - W, y1: last.y - DOWN, z1: last.z - W, x2: last.x + W, y2: last.y + UP, z2: last.z + W }));
      } catch (e) { reason = 'survey: ' + String(e.message).replace(/^навык тела "[^"]+" не удался: /, ''); break; }

      // связная компонента от затравки (раскопанные клетки — проходные узлы)
      const isOre = (x, y, z) => names.has(g(x, y, z));
      const start = [];
      if (isOre(seed.x, seed.y, seed.z) || dug.has(key(seed.x, seed.y, seed.z))) start.push(seed);
      for (const d of dug.values()) start.push(d);
      const seen = new Set(start.map(p => key(p.x, p.y, p.z)));
      const queue = start.slice();
      const cands = [];
      while (queue.length) {
        const p = queue.pop();
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const x = p.x + dx, y = p.y + dy, z = p.z + dz, k = key(x, y, z);
          if (seen.has(k) || !isOre(x, y, z)) continue;
          seen.add(k);
          const c = { x, y, z };
          queue.push(c);
          if (!dug.has(k) && !failed.has(k)) cands.push(c);
        }
      }
      // сама затравка — тоже кандидат, пока не копана
      if (isOre(seed.x, seed.y, seed.z) && !dug.has(key(seed.x, seed.y, seed.z)) && !failed.has(key(seed.x, seed.y, seed.z))) cands.push(seed);
      // лава рядом с клеткой — пропуск
      const safe = [];
      for (const c of cands) {
        let lava = false;
        for (let dx = -1; dx <= 1 && !lava; dx++) for (let dy = -1; dy <= 1 && !lava; dy++) for (let dz = -1; dz <= 1; dz++) if (g(c.x + dx, c.y + dy, c.z + dz) === 'lava') { lava = true; break; }
        if (lava) failed.set(key(c.x, c.y, c.z), 'лава рядом'); else safe.push(c);
      }
      remaining = safe.length;
      if (!safe.length) { reason = mined ? 'жила кончилась (видимая часть выкопана)' : (failed.size ? 'все блоки жилы небезопасны/недоступны' : 'жила не найдена в survey'); break; }
      const p = snap.position || seed;
      safe.sort((a, b) => Math.hypot(a.x + .5 - p.x, a.y + .5 - p.y, a.z + .5 - p.z) - Math.hypot(b.x + .5 - p.x, b.y + .5 - p.y, b.z + .5 - p.z));
      const t = safe[0];
      try {
        await api.cmd('dig_at', { x: t.x, y: t.y, z: t.z });
        mined++; consecFails = 0; remaining = Math.max(0, remaining - 1);
        dug.set(key(t.x, t.y, t.z), t); last = t;
      } catch (e) {
        const why = String(e.message).replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 100);
        failed.set(key(t.x, t.y, t.z), why);
        api.log(`mine_vein: dig_at ${t.x} ${t.y} ${t.z}: ${why}`);
        if (++consecFails >= 3) { reason = 'копание не получается: ' + why; break; }
      }
    }
    if (!reason) reason = 'исчерпан лимит итераций';
    if (mined) { try { await api.cmd('pickup', { radius: 6, max_sec: 8 }); } catch (e) { /* не страшно */ } }

    let gained = {};
    try {
      const now = invMap((await api.snapshot()).inventory);
      for (const n of Object.keys(now)) { const d = now[n] - (inv0[n] || 0); if (d > 0) gained[n] = d; }
    } catch (e) { /* не страшно */ }
    const skipped = [...failed.entries()].slice(0, 5).map(([k, why]) => ({ at: k, why }));
    api.log(`mine_vein ${ore}: выкопано ${mined}, ${reason}`);
    const out = { ore, mined, gained, left: remaining, reason, ...(skipped.length ? { skipped } : {}) };
    if (!mined) return { ok: false, error: `не выкопала ни блока ${ore}: ${reason}`, ...out };
    return { ok: true, ...out };
  }
};
