// версия: этап 2 (хардкор-стенд) — один навык пула (hardcore/pool, Voyager/Odyssey, MIT) по id; его выбирает решатель (hardcore/decider.js), а не пул 70/30
// pool_run — дело «навык пула» в общем списке решателя: запускает ровно тот навык, который решатель выбрал, и отдаёт честный итог (ok и что прибавилось).
'use strict';
const path = require('path');
const HCP = path.join(__dirname, '..', '..', 'hardcore', 'pool');

module.exports = {
  name: 'pool_run',
  description: 'Этап 2 хардкор-стенда: один навык из пула по id (из каталога дела) — выбор делает решатель',
  params: {
    id: 'id навыка из hardcore/pool/catalog.json, например v1.mineWoodLog',
    delo: 'дело каталога: wood, stone, food, farm, furnace, night, iron, combat, bed',
    max_sec: 'потолок по времени: не больше 300 с (по умолчанию 300)'
  },
  async run(api, params = {}) {
    const entry = (require(path.join(HCP, 'catalog.json'))[params.delo] || []).find(e => e.id === params.id);
    if (!entry) return { ok: false, error: `pool_run: в пуле нет ${params.id} для дела ${params.delo}` };
    // навык, который ходит в поиске цели, без цели рядом не запускаем (решение хозяина 05.11; решатель такие уже не предлагает)
    const gate = require(path.join(HCP, 'gate.js'));
    if (gate.NEED[entry.id] && !gate.present(await gate.viewOfApi(api), entry.id)) return { ok: false, error: `pool_run: ${entry.id} — цели рядом нет` };
    const r = await require(path.join(HCP, 'shim.js')).runForeign(api, entry, { maxSec: Math.min(Number(params.max_sec) || 300, 300) });
    api.log(`пул: ${entry.id} ${r.ok ? 'удался' : 'не удался'} за ${r.sec} с${r.err ? ' — ' + r.err : ''}`);
    return r.ok ? { ok: true, gained: r.gained } : { ok: false, error: `pool_run ${entry.id}: ${r.err}`, gained: r.gained };
  }
};
