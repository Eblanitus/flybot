// make_bed — кровать: 3 шерсти одного цвета + 3 доски. Шерсти нет — стрижёт овец (есть ножницы) или охотится на овец.
// Кровать только крафтит, НЕ ставит (поставит sleep/мозг). Доски/бревна сама не добывает — вернёт missing.
// Цвет кровати = цвет шерсти; color задаёт нужный цвет (не белый — овцы такого цвета редки, попыток меньше).
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const sum = (m, re) => Object.keys(m).filter(n => re.test(n)).reduce((s, n) => s + m[n], 0);

function woolBest(m, color) {
  if (color) return { color, n: m[color + '_wool'] || 0 };
  let best = { color: 'white', n: 0 };
  for (const c of COLORS) { const n = m[c + '_wool'] || 0; if (n > best.n) best = { color: c, n }; }
  return best;
}
const woolTotal = m => sum(m, /_wool$/);

module.exports = {
  name: 'make_bed',
  description: 'Крафтит кровать (3 шерсти одного цвета + 3 доски); шерсти нет — стрижёт овец ножницами или охотится на овец. Не ставит кровать. Нет досок/бревна — {ok:false, missing}.',
  params: {
    color: 'цвет шерсти/кровати (white, red, …); по умолчанию любой, где набирается 3',
    dry: '1 — только посчитать, что есть и чего не хватает',
    max_sec: 'потолок по времени, по умолчанию 240'
  },
  async run(api, params) {
    params = params || {};
    const color = params.color ? String(params.color).toLowerCase().replace(/[\s-]/g, '_') : null;
    if (color && !COLORS.includes(color)) return { ok: false, error: `color "${params.color}": один из ${COLORS.join(', ')}` };
    const dry = truthy(params.dry);
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 240) * 1000;

    let snap = await api.snapshot();
    let m = invMap(snap.inventory);
    const haveBed = Object.keys(m).find(n => /_bed$/.test(n) && m[n] > 0 && (!color || n === color + '_bed'));
    if (haveBed) return { ok: true, already: true, bed: haveBed, note: 'кровать уже в инвентаре' };

    // доски: 3 на кровать (+4 на верстак, если рядом его нет)
    const blocks = (snap.eyes && snap.eyes.blocks) || {};
    const tableNear = (m.crafting_table || 0) > 0 || !!(blocks.crafting_table && (blocks.crafting_table.d === undefined || blocks.crafting_table.d <= 20));
    const woodEq = sum(m, /_planks$/) + 4 * sum(m, /_(log|stem)$/);
    const woodNeed = 3 + (tableNear ? 0 : 4);
    const woodMissing = Math.max(0, woodNeed - woodEq);
    const wb0 = woolBest(m, color);
    if (dry) {
      return { ok: true, dry: true, wool: { color: wb0.color, have: wb0.n, need: 3 }, shears: (m.shears || 0) > 0, wood: { have: woodEq, need: woodNeed }, missing: { ...(woodMissing ? { planks: woodMissing } : {}), ...(wb0.n < 3 ? { [wb0.color + '_wool']: 3 - wb0.n } : {}) } };
    }
    if (woodMissing > 0) {
      return { ok: false, error: `не хватает досок: нужно ${woodNeed} (3 на кровать${tableNear ? '' : ' + 4 на верстак'}), есть ${woodEq} в пересчёте на доски; добудь бревна (gather_wood)`, missing: { planks: woodMissing } };
    }

    // шерсть
    const did = { sheared: 0, hunted: 0, explores: 0, attempts: 0 };
    let noProgress = 0;
    const maxAttempts = color && color !== 'white' ? 3 : 8;
    while (woolBest(m, color).n < 3 && did.attempts < maxAttempts && Date.now() < deadline) {
      did.attempts++;
      const before = woolTotal(m);
      const useShears = (m.shears || 0) > 0 && noProgress < 2;
      try {
        if (useShears) { const r = await api.cmd('shear', { animal: 'sheep', radius: 16, max: 6 }); did.sheared += (r && r.sheared) || 0; }
        else { await api.cmd('hunt', { animal: 'sheep', count: 2 }); did.hunted += 2; }
      } catch (e) { api.log(`make_bed: ${useShears ? 'shear' : 'hunt'}: ${e.message}`); }
      snap = await api.snapshot(); m = invMap(snap.inventory);
      if (woolTotal(m) > before) { noProgress = 0; continue; }
      noProgress++;
      if (noProgress >= 4 || did.explores >= 3) break;
      did.explores++;
      try { await api.cmd('explore', { distance: 40 }); } catch (e) { api.log('make_bed: explore: ' + e.message); }
      snap = await api.snapshot(); m = invMap(snap.inventory);
    }
    const wb = woolBest(m, color);
    if (wb.n < 3) {
      const wool = {}; for (const c of COLORS) if (m[c + '_wool']) wool[c + '_wool'] = m[c + '_wool'];
      return {
        ok: false, wool, ...did,
        error: `шерсти ${color || 'одного цвета'}: ${wb.n} из 3 — ${Date.now() >= deadline ? 'вышло время' : (m.shears ? 'овец рядом не нашла / уже острижены' : 'нет ножниц и овец рядом не нашла')}`,
        missing: { [wb.color + '_wool']: 3 - wb.n }
      };
    }

    const bed = wb.color + '_bed';
    try { await api.cmd('craft', { item: bed }); }
    catch (e) { return { ok: false, error: 'крафт кровати не удался: ' + String(e.message).replace(/^навык тела "[^"]+" не удался: /, ''), ...(e.result && e.result.missing ? { missing: e.result.missing } : {}), ...did }; }
    return { ok: true, bed, ...did, note: 'кровать в инвентаре, не поставлена' };
  }
};
