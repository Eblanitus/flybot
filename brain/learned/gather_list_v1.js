// версия: первая: крафт из имеющегося + collect недостающего сырья; dry=1
// gather_list — добрать список предметов: сначала крафт из того, что есть (доски из брёвен партиями по 4 со сверкой
// инвентаря), недостающее сырьё (брёвна, булыжник, уголь, земля, песок) — collect, с ограничением по времени.
// params: items: "cobblestone:90,spruce_planks:30,spruce_door:1" или {имя:n}; max_sec (600); dry=1 — только план.
// Возвращает {ok, have, missing, collected, crafted, errors} или dry-план {need, have, missing, plan, raw, crafts}.

// рецепт: что даёт (out) за один крафт, из чего (ing), нужен ли верстак (table)
const RECIPES = {
  spruce_planks: { out: 4, ing: { spruce_log: 1 } },
  oak_planks: { out: 4, ing: { oak_log: 1 } },
  birch_planks: { out: 4, ing: { birch_log: 1 } },
  stick: { out: 4, ing: { spruce_planks: 2 } },
  crafting_table: { out: 1, ing: { spruce_planks: 4 } },
  chest: { out: 1, ing: { spruce_planks: 8 }, table: true },
  furnace: { out: 1, ing: { cobblestone: 8 }, table: true },
  spruce_door: { out: 3, ing: { spruce_planks: 6 }, table: true },
  spruce_fence: { out: 3, ing: { spruce_planks: 4, stick: 2 }, table: true },
  spruce_fence_gate: { out: 1, ing: { spruce_planks: 2, stick: 4 }, table: true },
  spruce_stairs: { out: 4, ing: { spruce_planks: 6 }, table: true },
  spruce_slab: { out: 6, ing: { spruce_planks: 3 }, table: true },
  spruce_trapdoor: { out: 2, ing: { spruce_planks: 6 }, table: true },
  ladder: { out: 3, ing: { stick: 7 }, table: true },
  torch: { out: 4, ing: { coal: 1, stick: 1 } },
  cobblestone_stairs: { out: 4, ing: { cobblestone: 6 }, table: true },
  cobblestone_slab: { out: 6, ing: { cobblestone: 3 }, table: true },
  cobblestone_wall: { out: 6, ing: { cobblestone: 6 }, table: true },
  stone_pickaxe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
  stone_axe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
  stone_sword: { out: 1, ing: { cobblestone: 2, stick: 1 }, table: true },
  stone_shovel: { out: 1, ing: { cobblestone: 1, stick: 2 }, table: true }
};
// сырьё -> чем добывать (collect block)
const RAW = { spruce_log: 'spruce_log', oak_log: 'oak_log', birch_log: 'birch_log', cobblestone: 'stone', coal: 'coal', dirt: 'dirt', sand: 'sand', raw_iron: 'iron', raw_copper: 'copper' };

function parseItems(items) {
  const out = {};
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    for (const [k, v] of Object.entries(items)) { const n = Math.floor(Number(v)); if (k && n > 0) out[k.trim()] = n; }
    return out;
  }
  for (const part of String(items || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const [name, cnt] = part.split(/[:=]/);
    const n = cnt === undefined ? 1 : Math.floor(Number(cnt));
    const key = name.trim().replace(/^minecraft:/, '');
    if (key && n > 0) out[key] = (out[key] || 0) + n;
  }
  return out;
}

async function invMap(api) {
  const snap = await api.snapshot();
  const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return { inv: m, snap };
}

// Разложить цели на шаги крафта и нехватку сырья на виртуальном инвентаре (цели сначала резервируют то, что есть)
function expand(targets, inv, tableNear) {
  const sim = { ...inv };
  const crafts = []; const raw = {}; const unknown = {};
  let needTable = false;
  const take = (name, n, depth) => {
    const have = sim[name] || 0;
    if (have >= n) { sim[name] = have - n; return; }
    sim[name] = 0;
    const short = n - have;
    const r = RECIPES[name];
    if (!r || depth > 5) {
      if (RAW[name]) raw[name] = (raw[name] || 0) + short;
      else unknown[name] = (unknown[name] || 0) + short;
      return;
    }
    const times = Math.ceil(short / r.out);
    for (const [ing, c] of Object.entries(r.ing)) take(ing, c * times, depth + 1);
    if (r.table) needTable = true;
    crafts.push({ item: name, times, count: times * r.out });
    sim[name] = (sim[name] || 0) + times * r.out - short; // излишек остаётся
  };
  for (const [name, n] of Object.entries(targets)) take(name, n, 0);
  // верстак: если нужен, его нет рядом и в инвентаре — заложить первым (4 доски)
  if (needTable && !tableNear && !(inv.crafting_table > 0) && !targets.crafting_table) {
    const before = crafts.length;
    take('crafting_table', 1, 1);
    const tbl = crafts.splice(before);
    crafts.unshift(...tbl);
  }
  return { crafts, raw, unknown, needTable };
}

function mergeCrafts(crafts) {
  // одинаковые шаги подряд не нужны: сложить по предмету, сохраняя первый порядок
  const order = []; const by = {};
  for (const c of crafts) {
    if (!by[c.item]) { by[c.item] = { ...c }; order.push(c.item); }
    else { by[c.item].times += c.times; by[c.item].count += c.count; }
  }
  // доски и палки — раньше всего остального (ингредиенты)
  const rank = n => (/_planks$/.test(n) ? 0 : n === 'stick' ? 1 : n === 'crafting_table' ? 2 : 3);
  return order.map(n => by[n]).sort((a, b) => rank(a.item) - rank(b.item));
}

module.exports = {
  name: 'gather_list',
  description: 'Добрать список предметов (items="cobblestone:90,spruce_planks:30,spruce_door:1,torch:8"): крафт из имеющегося (доски партиями по 4 со сверкой), недостающее сырьё (брёвна, камень, уголь) — collect, в пределах max_sec. dry=1 — только посчитать need/have/missing и план. Возвращает collected/crafted/missing.',
  params: {
    items: 'список "имя:кол-во,…" или объект {имя:n}',
    max_sec: 'ограничение времени, по умолчанию 600',
    dry: '1 — ничего не делать, вернуть план и нехватку'
  },
  async run(api, params) {
    const targets = parseItems(params.items);
    if (!Object.keys(targets).length) return { ok: false, error: 'нужен items, напр. "cobblestone:90,spruce_planks:30"' };
    const dry = params.dry === true || params.dry === 1 || params.dry === '1' || params.dry === 'true';
    const maxSec = Math.min(Math.max(Number(params.max_sec) || 600, 10), 1800);
    const t0 = Date.now();
    const left = () => maxSec - (Date.now() - t0) / 1000;

    let { inv, snap } = await invMap(api);
    const tableNear = () => {
      const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.crafting_table;
      return !!(b && (b.d === undefined || b.d <= 20));
    };
    const start = { ...inv };
    const haveOf = m => Object.fromEntries(Object.keys(targets).map(k => [k, m[k] || 0]));
    const missOf = m => {
      const o = {};
      for (const [k, n] of Object.entries(targets)) if ((m[k] || 0) < n) o[k] = n - (m[k] || 0);
      return o;
    };

    if (dry) {
      const p = expand(targets, inv, tableNear());
      const crafts = mergeCrafts(p.crafts);
      const missing = { ...p.raw, ...p.unknown };
      const plan = [
        ...Object.entries(p.raw).map(([k, n]) => `добыть ${k} x${n} (collect ${RAW[k]})`),
        ...crafts.map(c => `скрафтить ${c.item} x${c.count}`),
        ...Object.entries(p.unknown).map(([k, n]) => `не знаю, как получить ${k} x${n}`)
      ].join('; ') || 'всё уже есть';
      return { ok: true, dry: true, need: targets, have: haveOf(inv), missing, raw: p.raw, crafts, plan };
    }

    const crafted = {}; const errors = []; const gaveUp = new Set(); const explores = {};
    const failedCraft = new Set();
    for (let round = 0; round < 40; round++) {
      if (left() <= 0) { errors.push('время вышло'); break; }
      ({ inv, snap } = await invMap(api));
      if (!Object.keys(missOf(inv)).length) break;
      const p = expand(targets, inv, tableNear());
      const rawNeed = Object.entries(p.raw).filter(([k]) => !gaveUp.has(k));
      if (rawNeed.length) {
        // добыть одно сырьё порцией до 16
        const [name, n] = rawNeed[0];
        const portion = Math.min(n, 16);
        const before = inv[name] || 0;
        try {
          api.log(`collect ${RAW[name]} x${portion} (нужно ещё ${n})`);
          await api.cmd('collect', { block: RAW[name], count: portion });
        } catch (e) {
          const msg = e.message || String(e);
          api.log('collect: ' + msg);
          if (/не вижу|не нашёл|не нашел|нет поблизости/.test(msg) && (explores[name] || 0) < 2 && left() > 60) {
            explores[name] = (explores[name] || 0) + 1;
            try { await api.cmd('explore', { distance: 48 }); } catch (e2) { api.log('explore: ' + e2.message); }
            continue;
          }
          const now = (await invMap(api)).inv[name] || 0;
          if (now <= before) { gaveUp.add(name); errors.push(`${name}: ${msg.slice(0, 160)}`); }
        }
        continue;
      }
      if (Object.keys(p.unknown).length && !p.crafts.length) {
        for (const k of Object.keys(p.unknown)) errors.push(`не знаю, как получить ${k}`);
        break;
      }
      // сырья хватает (или кончилось) — крафт по шагам
      const crafts = mergeCrafts(p.crafts).filter(c => !failedCraft.has(c.item));
      if (!crafts.length) break;
      let progress = false;
      for (const c of crafts) {
        if (left() <= 0) break;
        const r = RECIPES[c.item];
        const batch = /_planks$/.test(c.item) ? 4 : c.count; // доски — по одному бревну за раз
        let made = 0;
        for (let guard = 0; made < c.count && guard < 64; guard++) {
          const cur = await invMap(api);
          const b0 = cur.inv[c.item] || 0;
          const ingBefore = Object.fromEntries(Object.keys(r.ing).map(k => [k, cur.inv[k] || 0]));
          try {
            await api.cmd('craft', { item: c.item, count: Math.min(batch, c.count - made) });
          } catch (e) { errors.push(`craft ${c.item}: ${(e.message || '').slice(0, 160)}`); failedCraft.add(c.item); break; }
          const after = await invMap(api);
          const got = (after.inv[c.item] || 0) - b0;
          if (got <= 0) {
            const lost = Object.entries(ingBefore).filter(([k, v]) => (after.inv[k] || 0) < v).map(([k, v]) => `${k} ${v}->${after.inv[k] || 0}`);
            errors.push(`craft ${c.item}: предмет не прибавился${lost.length ? ', пропало: ' + lost.join(', ') : ''}`);
            failedCraft.add(c.item); break;
          }
          made += got; crafted[c.item] = (crafted[c.item] || 0) + got; progress = true;
        }
      }
      if (!progress && !rawNeed.length) break;
    }

    ({ inv } = await invMap(api));
    const collected = {};
    for (const k of new Set([...Object.keys(targets), ...Object.keys(RAW)])) {
      const d = (inv[k] || 0) - (start[k] || 0);
      if (d > 0) collected[k] = d;
    }
    const missing = missOf(inv);
    const res = { ok: !Object.keys(missing).length, have: haveOf(inv), missing, collected, crafted, sec: Math.round((Date.now() - t0) / 1000) };
    if (errors.length) res.errors = errors.slice(0, 12);
    if (!res.ok) res.error = 'не добрал: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ') + (errors.length ? ' (' + errors[0] + ')' : '');
    return res;
  }
};
