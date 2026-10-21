// cook_food — довести запас готовой еды до min: пожарить сырое мясо (smelt), нет мяса — охота (hunt), потом жарка.
// Готовая еда = cooked_*, хлеб, печёная картошка, морковь, яблоки, ягоды и т.п. (то, что можно есть без плавки).
// Итог всегда содержит ready (сколько готовой еды) — даже при ok:false. Не ест сама.
const RAW = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
const READY = /^(cooked_|bread$|baked_potato$|carrot$|apple$|golden_carrot$|golden_apple$|melon_slice$|sweet_berries$|glow_berries$|pumpkin_pie$|cookie$|mushroom_stew$|rabbit_stew$|beetroot_soup$|dried_kelp$|beetroot$)/;
const FUEL = /^(coal|charcoal|coal_block|blaze_rod)$|_planks$|_(log|stem)$/;
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const invMap = inv => { const m = {}; for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
const readyOf = m => Object.keys(m).filter(n => READY.test(n)).reduce((s, n) => s + m[n], 0);
const hasFuel = m => Object.keys(m).some(n => FUEL.test(n) && m[n] > 0);
const clean = e => String(e.message).replace(/^навык тела "[^"]+" не удался: /, '');

module.exports = {
  name: 'cook_food',
  description: 'Доводит запас готовой еды до min: жарит сырое мясо в печи; мяса нет — охотится (hunt) и жарит. Возвращает ready (сколько готовой еды), cooked, hunted. Нужно топливо (уголь/доски/бревна).',
  params: {
    min: 'сколько готовой еды нужно, по умолчанию 8',
    dry: '1 — только посчитать (ready, сырого мяса, топливо)',
    max_sec: 'потолок по времени, по умолчанию 420'
  },
  async run(api, params) {
    params = params || {};
    const min = Math.max(1, Math.floor(Number(params.min)) || 8);
    const deadline = Date.now() + (Number(params.max_sec) > 0 ? Number(params.max_sec) : 420) * 1000;
    let snap = await api.snapshot();
    let m = invMap(snap.inventory);
    const ready0 = readyOf(m);
    const rawCount = mm => RAW.reduce((s, n) => s + (mm[n] || 0), 0);
    if (truthy(params.dry)) return { ok: true, dry: true, ready: ready0, min, raw: rawCount(m), fuel: hasFuel(m), needToCook: Math.max(0, min - ready0) };
    if (ready0 >= min) return { ok: true, ready: ready0, min, cooked: 0, hunted: 0, note: 'готовой еды уже достаточно' };

    // без топлива жарить нечего — не гоняем животных зря
    if (!hasFuel(m)) return { ok: false, error: 'нет топлива для печи (coal/charcoal/доски/бревна)', missing: { fuel: 'coal/charcoal/planks/logs' }, ready: ready0, min, cooked: 0, hunted: 0 };

    let cooked = 0, hunted = 0, explores = 0, huntFails = 0;
    const errors = [];
    for (let pass = 0; pass < 8 && Date.now() < deadline; pass++) {
      m = invMap(snap.inventory);
      const need = min - readyOf(m);
      if (need <= 0) break;
      // 1. жарка того, что есть (чего больше — первым)
      const raws = RAW.filter(n => m[n] > 0).sort((a, b) => m[b] - m[a]);
      if (raws.length) {
        let progressed = false;
        for (const r of raws) {
          const left = min - readyOf(invMap((snap = await api.snapshot()).inventory));
          if (left <= 0 || Date.now() > deadline) break;
          const cnt = Math.min(invMap(snap.inventory)[r], left);
          try {
            const res = await api.cmd('smelt', { item: r, count: cnt });
            cooked += (res && Number(res.made)) || cnt; progressed = true;
            api.log(`cook_food: пожарила ${r} x${cnt}`);
          } catch (e) { errors.push(`${r}: ${clean(e)}`); api.log(`cook_food: smelt ${r}: ${e.message}`); }
        }
        snap = await api.snapshot();
        if (!progressed) break; // жарка не идёт (нет печи/топлива) — дальше охота не поможет
        continue;
      }
      // 2. мяса нет — охота
      const before = rawCount(m);
      const animals = ((snap.eyes && snap.eyes.animals) || []).filter(a => /cow|pig|sheep|chicken|rabbit|mooshroom|goat/.test(a.name));
      if (!animals.length && explores < 2) {
        explores++;
        try { await api.cmd('explore', { distance: 40 }); } catch (e) { errors.push('explore: ' + clean(e)); }
        snap = await api.snapshot();
        continue;
      }
      try {
        await api.cmd('hunt', { count: Math.min(6, Math.max(1, Math.ceil(need / 2))) });
        hunted++;
      } catch (e) { errors.push('hunt: ' + clean(e)); api.log('cook_food: hunt: ' + e.message); }
      snap = await api.snapshot();
      if (rawCount(invMap(snap.inventory)) <= before) { if (++huntFails >= 2) break; }
    }
    m = invMap((snap = await api.snapshot()).inventory);
    const ready = readyOf(m);
    const out = { ready, min, cooked, hunted, rawLeft: rawCount(m), ...(errors.length ? { errors: errors.slice(0, 4) } : {}) };
    if (ready >= min) return { ok: true, ...out };
    return {
      ok: false, ...out, missing: { food: min - ready },
      error: `готовой еды ${ready} из ${min}: ` + (errors[0] || (hunted ? 'охота не дала мяса' : 'нет мяса и животных рядом'))
    };
  }
};
