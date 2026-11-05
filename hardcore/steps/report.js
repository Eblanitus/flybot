// Сводка коротких навыков для людей: сколько было навыков, сколько коротких вышло, по категориям, и из чего состоит каждый длинный.
//   node hardcore/steps/report.js            — текст (Markdown) в консоль
//   node hardcore/steps/report.js --json     — то же данными (для схемы навыков)
'use strict';
const { STEPS, BY_ID, CATS } = require('./steps');
const { SPLIT, isLong } = require('./split');
const CATALOG = require('../pool/catalog.json');

const DELO = { wood: 'Дерево', stone: 'Камень', furnace: 'Печь, уголь и свет', food: 'Еда', farm: 'Поле и животные', night: 'Подземелье и ночь',
  iron: 'Железо', combat: 'Бой', bed: 'Кровать' };

function data() {
  const used = new Map(STEPS.map(s => [s.id, []]));
  for (const [id, e] of Object.entries(SPLIT)) for (const st of e.steps) used.get(st).push(id);
  const steps = STEPS.map(s => ({ id: s.id, cat: s.cat, catName: CATS[s.cat], title: s.title, cmd: s.cmd, from: used.get(s.id) }));
  const long = Object.entries(SPLIT).map(([id, e]) => ({ id, from: e.from, cat: e.from === 'pool' ? DELO[e.delo] : 'Свои навыки автопилота',
    title: e.title || null, long: isLong(e), steps: e.steps, ...(e.note ? { note: e.note } : {}) }));
  const pool = Object.values(CATALOG).flat().length;
  const own = long.filter(x => x.from === 'own').length;
  const byCat = {};
  for (const s of steps) byCat[s.catName] = (byCat[s.catName] || 0) + 1;
  return {
    total: { before: pool + own, pool, own, long: long.filter(x => x.long).length, alreadyShort: long.filter(x => !x.long && x.steps.length).length,
      notCut: long.filter(x => !x.steps.length).length, steps: steps.length, after: pool + own + steps.length },
    byCat, steps, long
  };
}

function markdown(d = data()) {
  const t = d.total, out = [];
  out.push('# Короткие навыки мух', '');
  out.push(`Было навыков: **${t.before}** (чужих ${t.pool} + своих длинных у автопилота ${t.own}). Из них длинных (2 шага и больше): **${t.long}**, уже коротких (1 шаг): ${t.alreadyShort}, не режется: ${t.notCut}.`);
  out.push(`Коротких навыков вышло: **${t.steps}**. Длинные остались. Всего у мухи теперь на выбор: **${t.after}**.`, '');
  out.push('## Короткие навыки по категориям', '');
  for (const cat of Object.values(CATS)) {
    const list = d.steps.filter(s => s.catName === cat);
    if (!list.length) continue;
    out.push(`### ${cat} (${list.length})`, '');
    for (const s of list) out.push(`- **${s.title}** — входит в ${s.from.length} длинных`);
    out.push('');
  }
  out.push('## Из каких шагов состоит каждый длинный навык', '');
  for (const g of [...new Set(d.long.map(x => x.cat))]) {
    out.push(`### ${g}`, '');
    for (const x of d.long.filter(y => y.cat === g)) {
      const name = x.title ? `${x.id} (${x.title})` : x.id;
      const chain = x.steps.length ? x.steps.map(s => BY_ID.get(s).title).join(' → ') : '—';
      out.push(`- **${name}**${x.long ? '' : ' _(уже короткий)_'}: ${chain}${x.note ? ` _(${x.note})_` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (require.main === module) {
  if (process.argv.includes('--json')) console.log(JSON.stringify(data(), null, 1));
  else console.log(markdown());
}

module.exports = { data, markdown };
