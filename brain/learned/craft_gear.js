// craft_gear — из того, что есть (и что можно переплавить из сырья), делает лучшие кирку, меч, топор, лопату, броню и щит.
// Планирует на «виртуальном» инвентаре: сверху вниз по уровням (алмаз → железо → медь → камень → дерево),
// вещь делается только если она СТРОГО лучше уже имеющейся/надетой и хватает материалов; остатки уходят на уровень ниже.
// dry=1 — только посчитать (ничего не делает). Не ставит и не ломает ничего, кроме станций craft/smelt тела.
// Щит в левой руке снимок тела не показывает: если он уже там — убери shield из set.
const RANK = { wood: 1, stone: 2, copper: 3, iron: 4, diamond: 5 };
const TIERS = ['diamond', 'iron', 'copper', 'stone', 'wood'];
const PREFIX = { wood: 'wooden', stone: 'stone', copper: 'copper', iron: 'iron', diamond: 'diamond' };
const MAT = { wood: 'planks', stone: 'stone', copper: 'copper', iron: 'iron', diamond: 'diamond' };
const MAT_ITEM = { planks: 'planks', stone: 'cobblestone', copper: 'copper_ingot', iron: 'iron_ingot', diamond: 'diamond' };
// ранги уже имеющихся вещей
const TOOL_RANK = { wooden: 1, golden: 1, stone: 2, copper: 3, iron: 4, diamond: 5, netherite: 6 };
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, copper: 3.2, turtle: 3.5, iron: 4, diamond: 5, netherite: 6 };
const NEW_ARMOR_RANK = { copper: 3.2, iron: 4, diamond: 5 };
const TOOL_COST = { pickaxe: [3, 2], sword: [2, 1], axe: [3, 2], shovel: [1, 2] }; // [материал, палки]
const ARMOR_COST = { chestplate: 8, leggings: 7, boots: 4, helmet: 5 };
// порядок трат внутри уровня: что важнее
const ORDER = ['pickaxe', 'sword', 'chestplate', 'leggings', 'boots', 'helmet', 'shield', 'axe', 'shovel'];
const GROUPS = { tools: ['pickaxe', 'sword', 'axe', 'shovel'], armor: ['chestplate', 'leggings', 'boots', 'helmet'], shield: ['shield'] };
const COAL_UNITS = 8, WOOD_UNITS = 1.5;

const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const sum = (m, re) => Object.keys(m).filter(n => re.test(n)).reduce((s, n) => s + m[n], 0);

function itemName(slot, tier) {
  if (slot === 'shield') return 'shield';
  return `${PREFIX[tier]}_${slot}`;
}

function readState(snap) {
  const m = invMap(snap.inventory);
  const worn = (snap.armor || []).slice();
  const blocks = (snap.eyes && snap.eyes.blocks) || {};
  const near = k => !!(blocks[k] && (blocks[k].d === undefined || blocks[k].d <= 20));
  const cobble = sum(m, /^(cobblestone|cobbled_deepslate|blackstone)$/);
  const planks = sum(m, /_planks$/), logs = sum(m, /_(log|stem)$/);
  const st = {
    m, worn,
    planks, logs, planksEq: planks + logs * 4, sticks: m.stick || 0,
    cobble, coal: (m.coal || 0) + (m.charcoal || 0),
    ironIngot: m.iron_ingot || 0, rawIron: m.raw_iron || 0,
    copperIngot: m.copper_ingot || 0, rawCopper: m.raw_copper || 0,
    diamond: m.diamond || 0,
    table: (m.crafting_table || 0) > 0 || near('crafting_table'),
    furnace: (m.furnace || 0) > 0 || near('furnace'),
    cur: {}
  };
  const all = Object.keys(m).concat(worn);
  for (const slot of Object.keys(TOOL_COST)) {
    let r = 0;
    for (const n of all) { const mm = n.match(new RegExp('^(wooden|golden|stone|copper|iron|diamond|netherite)_' + slot + '$')); if (mm) r = Math.max(r, TOOL_RANK[mm[1]]); }
    st.cur[slot] = r;
  }
  for (const slot of Object.keys(ARMOR_COST)) {
    let r = 0;
    for (const n of all) { const mm = n.match(new RegExp('^(leather|golden|chainmail|copper|turtle|iron|diamond|netherite)_' + slot + '$')); if (mm) r = Math.max(r, ARMOR_RANK[mm[1]]); }
    st.cur[slot] = r;
  }
  st.cur.shield = (m.shield || 0) > 0 ? 9 : 0;
  return st;
}

// можно ли плавить: печь есть/можно сделать, топливо есть
function smeltable(st) {
  const fuel = st.coal > 0 || st.planksEq > 0;
  const stationOk = st.furnace || (st.cobble >= 8 && (st.table || st.planksEq >= 4));
  return { fuel, stationOk, ok: fuel && stationOk };
}

// списать spec с пула B; вернуть новый пул или null, если не хватает
function take(B, spec) {
  const b = { ...B };
  let planks = spec.planks || 0;
  if (spec.mat === 'planks') planks += spec.n;
  else { if (b[spec.mat] < spec.n) return null; b[spec.mat] -= spec.n; }
  let need = spec.sticks || 0;
  const use = Math.min(b.sticks, need); b.sticks -= use; need -= use;
  if (need > 0) { const crafts = Math.ceil(need / 4); planks += crafts * 2; b.sticks += crafts * 4 - need; }
  planks += b.tableNeed; b.tableNeed = 0;
  if (b.planks < planks) return null;
  b.planks -= planks;
  return b;
}

function specFor(slot, tier) {
  if (slot === 'shield') return { mat: 'iron', n: 1, planks: 6, sticks: 0 };
  if (TOOL_COST[slot]) return { mat: MAT[tier], n: TOOL_COST[slot][0], sticks: TOOL_COST[slot][1] };
  return { mat: MAT[tier], n: ARMOR_COST[slot], sticks: 0 };
}

function makePlan(st, capTier, want, reserve) {
  const sm = smeltable(st);
  const B = {
    planks: st.planksEq - reserve.wood, sticks: st.sticks, stone: st.cobble - reserve.cobble,
    copper: st.copperIngot + (sm.ok ? st.rawCopper : 0), iron: st.ironIngot + (sm.ok ? st.rawIron : 0), diamond: st.diamond,
    tableNeed: st.table ? 0 : 4
  };
  const B0 = { ...B };
  const cur = { ...st.cur };
  const items = [];
  let pool = B;
  for (const tier of TIERS) {
    if (RANK[tier] > RANK[capTier]) continue;
    for (const slot of ORDER) {
      if (!want.has(slot)) continue;
      if (slot === 'shield') { if (tier !== 'iron' || cur.shield) continue; }
      else {
        const isArmor = !!ARMOR_COST[slot];
        if (isArmor && !NEW_ARMOR_RANK[tier]) continue;
        const rank = isArmor ? NEW_ARMOR_RANK[tier] : RANK[tier];
        if (rank <= cur[slot]) continue;
      }
      const nb = take(pool, specFor(slot, tier));
      if (!nb) continue;
      pool = nb;
      cur[slot] = slot === 'shield' ? 9 : (ARMOR_COST[slot] ? NEW_ARMOR_RANK[tier] : RANK[tier]);
      items.push({ item: itemName(slot, tier), slot, tier });
    }
  }
  const used = {};
  for (const k of ['planks', 'stone', 'copper', 'iron', 'diamond']) if (B0[k] - pool[k] > 0) used[k] = B0[k] - pool[k];
  const smelt = {};
  if (sm.ok) {
    const needIron = Math.max(0, (used.iron || 0) - st.ironIngot), needCopper = Math.max(0, (used.copper || 0) - st.copperIngot);
    if (needIron) smelt.raw_iron = needIron;
    if (needCopper) smelt.raw_copper = needCopper;
  }
  return { items, pool, B0, used, smelt, cur, sm };
}

// чего не хватает до полного набора целевого уровня
function missingFor(st, plan, targetTier, want) {
  const need = { planks: 0, stone: 0, copper: 0, iron: 0, diamond: 0 };
  let sticks = 0, any = false;
  const done = new Set(plan.items.map(i => i.slot));
  for (const slot of ORDER) {
    if (!want.has(slot) || done.has(slot)) continue;
    let spec;
    if (slot === 'shield') { if (plan.cur.shield || RANK[targetTier] < RANK.iron) continue; spec = specFor('shield'); }
    else if (ARMOR_COST[slot]) {
      if (!NEW_ARMOR_RANK[targetTier] || NEW_ARMOR_RANK[targetTier] <= plan.cur[slot]) continue;
      spec = specFor(slot, targetTier);
    } else { if (RANK[targetTier] <= plan.cur[slot]) continue; spec = specFor(slot, targetTier); }
    any = true;
    need[spec.mat] += spec.n; need.planks += spec.planks || 0; sticks += spec.sticks || 0;
  }
  if (!any) return {};
  need.planks += Math.ceil(Math.max(0, sticks - plan.pool.sticks) / 4) * 2 + plan.pool.tableNeed;
  const out = {};
  for (const k of Object.keys(need)) {
    const short = Math.max(0, need[k] - Math.max(0, plan.pool[k]));
    if (short > 0) out[MAT_ITEM[k]] = short;
  }
  return out;
}

function pickFuel(m, n) {
  const coal = m.coal || 0, charcoal = m.charcoal || 0;
  if (coal * COAL_UNITS >= n) return 'coal';
  if (charcoal * COAL_UNITS >= n) return 'charcoal';
  const pl = Object.keys(m).filter(k => /_planks$/.test(k)).sort((a, b) => m[b] - m[a])[0];
  if (pl && m[pl] * WOOD_UNITS >= n) return pl;
  const lg = Object.keys(m).filter(k => /_(log|stem)$/.test(k)).sort((a, b) => m[b] - m[a])[0];
  if (lg && m[lg] * WOOD_UNITS >= n) return lg;
  if (coal + charcoal > 0) return coal >= charcoal ? 'coal' : 'charcoal';
  return pl || lg || null;
}

module.exports = {
  name: 'craft_gear',
  description: 'Делает лучшие доступные кирку, меч, топор, лопату, броню и щит из имеющегося (сырьё сам переплавит) и надевает. Вещь делается, только если лучше уже имеющейся; остатки уходят на уровень ниже. dry=1 — только посчитать. Возвращает crafted, missing, plan.',
  params: {
    tier: 'auto (по умолчанию, лучшее из доступного) | wood | stone | copper | iron | diamond — потолок уровня',
    set: 'что делать, через запятую: tools,armor,shield (по умолчанию все) или отдельно pickaxe,sword,axe,shovel,helmet,chestplate,leggings,boots',
    dry: '1 — ничего не делать, вернуть plan/smelt/missing',
    max_sec: 'потолок по времени, по умолчанию 600'
  },
  async run(api, params) {
    params = params || {};
    const tierArg = String(params.tier || 'auto').toLowerCase().replace(/^wooden$/, 'wood');
    if (tierArg !== 'auto' && !RANK[tierArg]) return { ok: false, error: `tier "${params.tier}": нужен auto|wood|stone|copper|iron|diamond` };
    const dry = truthy(params.dry);
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 600;
    const deadline = Date.now() + maxSec * 1000;
    const want = new Set();
    const setArg = String(params.set || 'tools,armor,shield').toLowerCase().split(/[,\s]+/).filter(Boolean);
    for (const tok of setArg) {
      if (GROUPS[tok]) GROUPS[tok].forEach(s => want.add(s));
      else if (ORDER.includes(tok)) want.add(tok);
      else return { ok: false, error: `set: неизвестное "${tok}" (tools,armor,shield,pickaxe,sword,axe,shovel,helmet,chestplate,leggings,boots)` };
    }
    if (!want.size) return { ok: false, error: 'set пустой' };

    let snap = await api.snapshot();
    const st = readState(snap);
    // потолок уровня
    let cap = tierArg, target = tierArg;
    if (tierArg === 'auto') {
      cap = 'diamond';
      const pools = { diamond: st.diamond, iron: st.ironIngot + st.rawIron, copper: st.copperIngot + st.rawCopper, stone: st.cobble, wood: st.planksEq };
      target = TIERS.find(t => pools[t] > 0) || 'wood';
    }
    // два прохода: второй учитывает печь (8 булыжника) и топливо для плавки
    let plan = makePlan(st, cap, want, { wood: 0, cobble: 0 });
    const smeltN = Object.values(plan.smelt).reduce((s, v) => s + v, 0);
    if (smeltN > 0) {
      const reserve = { wood: 0, cobble: st.furnace ? 0 : 8 };
      const coalUnits = st.coal * COAL_UNITS;
      if (coalUnits < smeltN) {
        const fuelN = Math.ceil((smeltN - coalUnits) / WOOD_UNITS);
        reserve.wood = st.planks >= fuelN ? fuelN : fuelN * 4;
      }
      plan = makePlan(st, cap, want, reserve);
    }
    const missing = missingFor(st, plan, target, want);
    const notes = [];
    const sm = plan.sm;
    if ((st.rawIron + st.rawCopper) > 0 && !sm.ok) {
      notes.push(`сырьё (raw_iron/raw_copper) не плавлю: ${!sm.fuel ? 'нет топлива (coal/charcoal/доски/бревна)' : 'нет печи и нет 8 булыжника на печь'}`);
      if (!sm.fuel) missing.fuel = 'coal/charcoal/доски/бревна';
      else missing.furnace = 'печь или 8 cobblestone';
    }
    if (target !== 'wood' && RANK[target] < RANK.copper && [...want].some(s => ARMOR_COST[s])) notes.push('броня делается из copper/iron/diamond — на этом уровне её нет');
    const planOut = plan.items.map(i => i.item);
    const base = { tier: tierArg === 'auto' ? `auto(цель ${target})` : tierArg, plan: planOut, smelt: plan.smelt, materials: Object.fromEntries(Object.entries(plan.used).map(([k, v]) => [MAT_ITEM[k], v])), missing, notes };

    if (dry) return { ok: true, dry: true, ...base, canCraftAll: Object.keys(missing).length === 0 };
    if (!plan.items.length) {
      if (Object.keys(missing).length) return { ok: false, error: 'не хватает материалов: ' + Object.entries(missing).map(([k, v]) => `${k} ${v}`).join(', '), ...base, crafted: [] };
      return { ok: true, crafted: [], note: 'нечего улучшать: имеющееся не хуже того, что можно сделать', ...base };
    }

    const crafted = [], failed = [], skipped = [], smelted = {};
    // 1. плавка сырья
    for (const [raw, n] of Object.entries(plan.smelt)) {
      if (Date.now() > deadline) break;
      const m = invMap((snap = await api.snapshot()).inventory);
      const fuel = pickFuel(m, n);
      try {
        const r = await api.cmd('smelt', { item: raw, count: Math.min(n, m[raw] || n), ...(fuel ? { fuel } : {}) });
        smelted[raw] = (r && r.made) || n;
        api.log(`craft_gear: переплавила ${raw} x${smelted[raw]}`);
      } catch (e) { failed.push({ item: raw, error: String(e.message).replace(/^навык тела "[^"]+" не удался: /, '') }); }
    }
    // 2. крафт в порядке важности
    for (const it of plan.items) {
      if (Date.now() > deadline) { skipped.push(it.item); continue; }
      try {
        await api.cmd('craft', { item: it.item });
        crafted.push(it.item);
        api.log('craft_gear: сделала ' + it.item);
      } catch (e) {
        failed.push({ item: it.item, error: String(e.message).replace(/^навык тела "[^"]+" не удался: /, '') });
        if (e.result && e.result.missing) failed[failed.length - 1].missing = e.result.missing;
      }
    }
    // 3. надеть
    let equipped = false;
    if (crafted.length) {
      try { await api.cmd('equip_best', { for: 'fight' }); equipped = true; } catch (e) { notes.push('equip_best: ' + e.message); }
      if (crafted.includes('shield')) {
        try { await api.cmd('equip_item', { item: 'shield', dest: 'off-hand' }); } catch (e) { notes.push('щит в левую руку: ' + e.message); }
      }
    }
    const out = { ...base, crafted, smelted, equipped, ...(failed.length ? { failed } : {}), ...(skipped.length ? { skipped, reason: 'вышло время max_sec' } : {}) };
    if (!crafted.length) {
      const why = failed[0] ? failed[0].item + ': ' + failed[0].error : 'ничего не сделано';
      return { ok: false, error: 'крафт не удался — ' + why, ...out };
    }
    return { ok: true, ...out };
  }
};
