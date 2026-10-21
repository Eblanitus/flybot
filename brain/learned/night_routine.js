// Подготовка к ночи: если ночь близко — убедиться, что есть блоки для укрытия, затем переждать ночь.
// Собран только из навыков тела: collect (добыча) и wait_night (кровать или укрытие, утром выходит).
const BUILD_BLOCKS = ['dirt', 'coarse_dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'];

module.exports = {
  name: 'night_routine',
  description: 'Перед ночью (осталось < lead_sec секунд или уже ночь): добыть блоки для укрытия, если их меньше min_blocks, и переждать ночь (wait_night). Днём с запасом времени ничего не делает.',
  params: {
    lead_sec: 'за сколько секунд до ночи начинать, по умолчанию 90',
    min_blocks: 'сколько блоков (земля/булыжник) иметь для укрытия, по умолчанию 9',
    max_sec: 'максимум ожидания ночи для wait_night, по умолчанию 720'
  },
  async run(api, params) {
    const lead = Number(params.lead_sec) > 0 ? Number(params.lead_sec) : 90;
    const need = Number(params.min_blocks) >= 0 ? Number(params.min_blocks) : 9;
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 720;

    const snap = await api.snapshot();
    const time = (snap.eyes && snap.eyes.time) || {};
    const isNight = time.phase === 'ночь';
    api.log(`фаза: ${time.phase}, до ночи: ${time.nightIn} с`);
    if (!isNight && time.nightIn > lead) {
      return { ok: true, skipped: true, reason: `до ночи ещё ${time.nightIn} с (> ${lead})` };
    }

    // 1. блоки для укрытия
    let have = await api.count(BUILD_BLOCKS);
    const gathered = {};
    if (have < need) {
      api.log(`блоков ${have}/${need}: добываю`);
      const lack = need - have + 1; // +1 про запас
      try {
        const r = await api.cmd('collect', { block: 'dirt', count: lack });
        gathered.dirt = r && r.mined;
      } catch (e) {
        api.log('земля не вышла (' + e.message + '), пробую камень');
        try {
          const r = await api.cmd('collect', { block: 'stone', count: lack });
          gathered.stone = r && r.mined;
        } catch (e2) {
          // не страшно: wait_night умеет закопаться, если блоков мало
          api.log('блоков добыть не удалось: ' + e2.message);
        }
      }
      have = await api.count(BUILD_BLOCKS);
    }

    // 2. переждать ночь (кровать, иначе укрытие; утром выходит)
    api.log(`жду ночь, блоков: ${have}`);
    const r = await api.cmd('wait_night', { max_sec: maxSec, min_wait: lead });
    return { ok: true, blocks: have, gathered, night: r };
  }
};
