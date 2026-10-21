// Стартовый набор: дерево -> деревянная кирка -> камень -> каменные кирка и меч.
// Шаги пропускаются, если нужное уже есть в инвентаре. Собран только из навыков тела.
const PICKAXES_ANY = /^(wooden|stone|golden|iron|diamond|netherite)_pickaxe$/;
const PICKAXES_STONE_PLUS = /^(stone|iron|diamond|netherite)_pickaxe$/;
const SWORDS_STONE_PLUS = /^(stone|iron|diamond|netherite)_sword$/;

// collect с повторами: если не нашёл — сходить в сторону (explore) и попробовать снова
async function collectRetry(api, block, count, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await api.cmd('collect', { block, count }); }
    catch (e) {
      lastErr = e;
      if (!/не нашёл|не получается добраться/.test(e.message)) throw e; // другая причина (нет инструмента и т.п.) — не лечится explore
      api.log(`${block}: ${e.message} -> explore`);
      await api.cmd('explore', { distance: 48 });
    }
  }
  throw lastErr;
}

module.exports = {
  name: 'starter_kit',
  description: 'Стартовый набор с нуля: бревна -> деревянная кирка -> булыжник -> каменные кирка и меч (+ запас булыжника). Пропускает уже сделанное. until: wooden_pickaxe | stone_tools.',
  params: {
    until: 'где остановиться: "wooden_pickaxe" или "stone_tools" (по умолчанию)',
    extra_stone: 'запас булыжника сверх крафта (для укрытия), по умолчанию 7'
  },
  async run(api, params) {
    const until = params.until === 'wooden_pickaxe' ? 'wooden_pickaxe' : 'stone_tools';
    const extra = Number(params.extra_stone) >= 0 ? Number(params.extra_stone) : 7;
    const steps = [];
    const step = async (title, fn) => {
      api.log('шаг: ' + title);
      try { const r = await fn(); steps.push({ step: title, done: true }); return r; }
      catch (e) {
        steps.push({ step: title, done: false, error: e.message });
        const err = new Error(`шаг "${title}": ${e.message}`); err.steps = steps; throw err;
      }
    };
    const inv = async () => (await api.snapshot()).inventory || [];
    const has = async re => (await inv()).some(i => re.test(i.name));
    const num = async re => (await inv()).filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0);

    try {
      // 1. деревянная кирка (нужно ~5 досок: ~2 бревна; берём 5 бревен с запасом на верстак и каменные инструменты)
      if (!(await has(PICKAXES_ANY))) {
        const logs = await num(/_log$/); const planks = await num(/_planks$/);
        const woodUnits = logs + Math.floor(planks / 4);
        if (woodUnits < 5) await step('бревна', () => collectRetry(api, 'log', 5 - woodUnits, 3));
        await step('деревянная кирка', () => api.cmd('craft', { item: 'wooden_pickaxe' }));
      } else steps.push({ step: 'деревянная кирка', skipped: true });
      if (until === 'wooden_pickaxe') return { ok: true, until, steps };

      // 2. камень: 3 на кирку + 2 на меч + запас
      const needPick = !(await has(PICKAXES_STONE_PLUS));
      const needSword = !(await has(SWORDS_STONE_PLUS));
      const cobble = await num(/^cobblestone$/);
      const want = (needPick ? 3 : 0) + (needSword ? 2 : 0) + extra;
      if (cobble < want) await step('булыжник', () => collectRetry(api, 'stone', want - cobble, 3));

      // 3. каменные инструменты
      if (needPick) await step('каменная кирка', () => api.cmd('craft', { item: 'stone_pickaxe' }));
      else steps.push({ step: 'каменная кирка', skipped: true });
      if (needSword) await step('каменный меч', () => api.cmd('craft', { item: 'stone_sword' }));
      else steps.push({ step: 'каменный меч', skipped: true });

      await api.cmd('equip_best', { for: 'dig' }).catch(e => api.log('equip_best: ' + e.message));
      return { ok: true, until, steps, cobblestone: await num(/^cobblestone$/) };
    } catch (e) {
      return { ok: false, error: e.message, steps: e.steps || steps };
    }
  }
};
