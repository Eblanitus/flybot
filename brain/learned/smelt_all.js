// smelt_all — переплавить всё перечисленное, что есть в инвентаре. Печь — ближайшая или сам делает и ставит (тело, навык smelt).
// Порядок: сначала руды и песок, булыжник в последнюю очередь (на печь нужно 8, и запас keep_cobble остаётся).
// Топливо берётся в порядке fuel; если одного вида не хватает — докидывается следующим. Порциями по ≤64 (одна загрузка печи).
// ВАЖНО: плавка идёт ~10 с на предмет — запускай с большим timeout_sec (64 слитка ≈ 11 мин).
const OUT = {
  raw_iron: 'iron_ingot', raw_copper: 'copper_ingot', raw_gold: 'gold_ingot', iron_ore: 'iron_ingot', copper_ore: 'copper_ingot', gold_ore: 'gold_ingot',
  deepslate_iron_ore: 'iron_ingot', deepslate_copper_ore: 'copper_ingot', deepslate_gold_ore: 'gold_ingot',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', cobbled_deepslate: 'deepslate', stone: 'smooth_stone', clay_ball: 'brick',
  netherrack: 'nether_brick', kelp: 'dried_kelp', cactus: 'green_dye', potato: 'baked_potato', wet_sponge: 'sponge',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon'
};
const ALIAS = { iron: 'raw_iron', copper: 'raw_copper', gold: 'raw_gold', cobble: 'cobblestone', ore: ['raw_iron', 'raw_copper', 'raw_gold'], meat: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon'] };
const FUEL_UNITS = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20, stick: 0.5 };
const LOG = /_(log|stem)$/, PLANKS = /_planks$/;
const LAST = new Set(['cobblestone', 'cobbled_deepslate', 'stone']);

const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const list = s => String(s || '').toLowerCase().split(/[,\s]+/).filter(Boolean);

function fuelList(m, prefs, exclude) {
  const out = [], seen = new Set();
  const byCount = re => Object.keys(m).filter(n => re.test(n) && m[n] > 0).sort((a, b) => m[b] - m[a]);
  for (const p of prefs) {
    const names = p === 'planks' ? byCount(PLANKS) : (p === 'logs' || p === 'log') ? byCount(LOG) : [p];
    for (const n of names) {
      if (seen.has(n) || n === exclude || !(m[n] > 0)) continue;
      const per = FUEL_UNITS[n] || (PLANKS.test(n) || LOG.test(n) ? 1.5 : 0);
      if (per > 0) { seen.add(n); out.push({ name: n, per, units: m[n] * per }); }
    }
  }
  return out;
}

module.exports = {
  name: 'smelt_all',
  description: 'Переплавляет в печи всё перечисленное, что есть (по умолчанию raw_iron, raw_copper, raw_gold, sand, cobblestone). Печь рядом или сама делает и ставит. Топливо по очереди из fuel. Долго (~10 с на предмет) — нужен большой timeout_sec.',
  params: {
    what: 'через запятую: raw_iron,raw_copper,raw_gold,sand,cobblestone (по умолчанию); можно iron,copper,gold,ore,meat,logs(→charcoal) и любое сырьё печи',
    fuel: 'через запятую по приоритету: coal,charcoal,planks (по умолчанию); также logs, любое имя предмета-топлива',
    keep_cobble: 'сколько булыжника не плавить, по умолчанию 16 (на укрытие)',
    dry: '1 — только показать, что и сколько переплавит',
    max_sec: 'потолок по времени, по умолчанию 600'
  },
  async run(api, params) {
    params = params || {};
    const dry = truthy(params.dry);
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 600) * 1000;
    const keepCobble = params.keep_cobble === undefined ? 16 : Math.max(0, Math.floor(Number(params.keep_cobble)) || 0);
    const prefs = list(params.fuel || 'coal,charcoal,planks');
    const rawWhat = list(params.what || 'raw_iron,raw_copper,raw_gold,sand,cobblestone');
    // раскрыть псевдонимы
    let snap = await api.snapshot();
    let m = invMap(snap.inventory);
    const items = [];
    for (const w of rawWhat) {
      const a = ALIAS[w];
      let names;
      if (w === 'logs' || w === 'log') names = Object.keys(m).filter(n => LOG.test(n));
      else if (a) names = Array.isArray(a) ? a : [a];
      else names = [w];
      for (const n of names) {
        if (!(n in OUT) && !LOG.test(n)) return { ok: false, error: `what: не знаю, как плавить "${n}"` };
        if (!items.includes(n)) items.push(n);
      }
    }
    // булыжник и камень в конце
    items.sort((a, b) => (LAST.has(a) ? 1 : 0) - (LAST.has(b) ? 1 : 0));

    const have = items.filter(n => m[n] > 0);
    if (!have.length) return { ok: false, error: 'нечего плавить: в инвентаре нет ' + items.join(', '), missing: { items: items }, smelted: {} };
    const outOf = n => (LOG.test(n) ? 'charcoal' : OUT[n]);

    // сколько можно взять сейчас (булыжник: запас + 8 на печь, если её не видно)
    const amountFor = (n, mm, sn) => {
      let c = mm[n] || 0;
      if (LAST.has(n)) {
        const blocks = (sn.eyes && sn.eyes.blocks) || {};
        const furn = (mm.furnace || 0) > 0 || !!(blocks.furnace && (blocks.furnace.d === undefined || blocks.furnace.d <= 20));
        c -= keepCobble + (furn ? 0 : 8);
      }
      return Math.max(0, c);
    };
    const plan = have.map(n => ({ item: n, output: outOf(n), count: amountFor(n, m, snap) })).filter(p => p.count > 0);
    const totalUnits = plan.reduce((s, p) => s + p.count, 0);
    const fuels0 = plan.length ? fuelList(m, prefs, null) : [];
    const fuelUnits = fuels0.reduce((s, f) => s + f.units, 0);
    const skippedKeep = have.filter(n => !plan.find(p => p.item === n));
    if (dry) return { ok: true, dry: true, plan, fuel: fuels0.map(f => ({ name: f.name, units: f.units })), fuelEnough: fuelUnits >= totalUnits, skipped: skippedKeep };
    if (!plan.length) return { ok: false, error: `нечего плавить: ${have.join(', ')} есть, но всё в запасе (keep_cobble=${keepCobble}${LAST.has(have[0]) ? ', +8 на печь' : ''})`, missing: { items: items }, smelted: {} };
    if (!fuels0.length) return { ok: false, error: `нет топлива (${prefs.join(', ')}): нужно ~${Math.ceil(totalUnits / 8)} угля или ${Math.ceil(totalUnits / 1.5)} досок`, missing: { fuel: prefs.join('/') }, smelted: {} };

    const smelted = {}, failed = [];
    let stopReason = null, fuelOut = false;
    for (const p of plan) {
      let remaining = p.count;
      let guard = 0;
      while (remaining > 0 && guard++ < 12) {
        if (Date.now() > deadline - 12000) { stopReason = 'вышло время max_sec'; break; }
        snap = await api.snapshot(); m = invMap(snap.inventory);
        remaining = Math.min(remaining, amountFor(p.item, m, snap));
        if (remaining <= 0) break;
        const fl = fuelList(m, prefs, p.item).filter(f => f.units >= 1);
        if (!fl.length) { fuelOut = true; break; }
        const f = fl[0];
        const timeCap = Math.floor((deadline - Date.now()) / 10500);
        const chunk = Math.min(remaining, 64, Math.floor(f.units), Math.max(1, timeCap));
        try {
          const r = await api.cmd('smelt', { item: p.item, count: chunk, fuel: f.name });
          const made = (r && Number(r.made)) || chunk;
          smelted[p.output] = (smelted[p.output] || 0) + made;
          remaining -= chunk;
          api.log(`smelt_all: ${p.item} x${chunk} → ${p.output} (топливо ${f.name})`);
        } catch (e) {
          failed.push({ item: p.item, error: String(e.message).replace(/^навык тела "[^"]+" не удался: /, '') });
          break;
        }
      }
      if (stopReason || fuelOut) break;
    }
    const total = Object.values(smelted).reduce((s, v) => s + v, 0);
    const out = { smelted, failed: failed.length ? failed : undefined, skipped: skippedKeep.length ? skippedKeep : undefined, ...(stopReason ? { reason: stopReason } : {}) };
    if (fuelOut) {
      out.missing = { fuel: prefs.join('/') };
      if (!total) return { ok: false, error: 'топливо кончилось/нет: ' + prefs.join(', '), ...out };
      out.note = 'топливо кончилось, часть не переплавлена';
    }
    if (!total) return { ok: false, error: 'ничего не выплавилось: ' + (failed[0] ? failed[0].item + ' — ' + failed[0].error : 'нет результата'), ...out };
    return { ok: true, ...out };
  }
};
