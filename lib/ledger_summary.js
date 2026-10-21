// Сводка учёта ресурсов по таблице days из data/ledger.json. Без зависимостей — этим же пользуется программа «Аудит»,
// когда тело не отвечает или ещё не перезапущено. Только арифметика над записанным: ничего не домысливает.
'use strict';

const REASONS = {
  mined: 'добыто', crafted: 'скрафчено', collected: 'подобрано', chest_take: 'взято из сундука', furnace_out: 'из печи', trade_in: 'получено в обмене',
  fished: 'выловлено', craft_spent: 'потрачено на крафт', placed: 'поставлено', chest_put: 'положено в сундук', furnace_in: 'положено в печь',
  trade_out: 'отдано в обмене', eaten: 'съедено', tossed: 'выброшено', died: 'потеряно при смерти', unknown: 'неизвестно'
};

// days: { <день|'older'|'unknown'>: { <предмет>: { in: {причина: {источник: n}}, out: {...} } } }
function summarize(days) {
  const items = {}, byReason = { in: {}, out: {} }, bySource = {}, byDay = [];
  let totIn = 0, totOut = 0, unkIn = 0, unkOut = 0;
  const rank = k => (k === 'older' ? -Infinity : k === 'unknown' ? Infinity : Number(k));
  const dayKeys = Object.keys(days || {}).sort((a, b) => rank(a) - rank(b) || 0);
  for (const day of dayKeys) {
    let dIn = 0, dOut = 0, dUnk = 0; const dItems = {};
    for (const item of Object.keys(days[day])) {
      const row = days[day][item];
      const it = items[item] || (items[item] = { item, in: 0, out: 0, inBy: {}, outBy: {} });
      const di = dItems[item] || (dItems[item] = { in: 0, out: 0 });
      for (const dir of ['in', 'out']) for (const rs of Object.keys(row[dir] || {})) for (const by of Object.keys(row[dir][rs])) {
        const n = row[dir][rs][by];
        it[dir] += n; di[dir] += n;
        const m = dir === 'in' ? it.inBy : it.outBy; m[rs] = (m[rs] || 0) + n;
        byReason[dir][rs] = (byReason[dir][rs] || 0) + n;
        const s = bySource[by] || (bySource[by] = { in: 0, out: 0 }); s[dir] += n;
        if (dir === 'in') { dIn += n; totIn += n; if (rs === 'unknown') { unkIn += n; dUnk += n; } } else { dOut += n; totOut += n; if (rs === 'unknown') { unkOut += n; dUnk += n; } }
      }
    }
    const top = Object.entries(dItems).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).slice(0, 8).map(([item, v]) => ({ item, in: v.in, out: v.out }));
    byDay.push({ day, in: dIn, out: dOut, unknown: dUnk, top });
  }
  const list = Object.values(items).map(it => ({ ...it, net: it.in - it.out })).sort((a, b) => (b.in + b.out) - (a.in + a.out)).slice(0, 80);
  return { totals: { in: totIn, out: totOut, unknownIn: unkIn, unknownOut: unkOut }, byReason, bySource, byDay, items: list };
}

module.exports = { REASONS, summarize };
