// версия: пул навыков (хардкор-стенд, этап 2, 04.11): каждую ночь муха с температурой выбирает родной night_mine_v6 или чужой ночной навык Voyager/Odyssey (hardcore/pool, MIT: пещеры, руда, глубинный сланец, а с оружием иногда — бой с мобом): 70% лучший по общему счёту всех мух, 30% новичок. Вне стенда — просто night_mine_v6
// night_mine — полезная работа ночью вместо простоя. Итог каждого запуска пишется в общую память пула (hardcore/data/pool_runs.jsonl).
'use strict';
const pool = require(require('path').join(__dirname, '..', '..', 'hardcore', 'pool', 'run.js'));

module.exports = {
  name: 'night_mine',
  description: 'Ночью вместо простоя. На хардкор-стенде — пул навыков: с температурой берёт родной night_mine_v6 (туннель 1×2) или чужой ночной навык Voyager/Odyssey (пещеры, руда, сланец; с мечом или луком иногда бой) — 70% лучший по общему счёту мух, 30% новичок; итог пишет в общую память пула. Вне стенда — то же, что night_mine_v6.',
  params: {
    max_blocks: 'для night_mine_v6: сколько блоков выкопать максимум',
    until: 'для night_mine_v6: "day" или "blocks"',
    max_sec: 'потолок по времени: родному как есть (по умолчанию 600), чужому — не больше 300'
  },
  async run(api, params) {
    return pool.dispatch(api, params || {}, { slot: 'night', native: 'night_mine_v6', maxSec: 300 });
  }
};
