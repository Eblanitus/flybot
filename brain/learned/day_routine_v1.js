// версия: первая: дерево → кирки → булыжник → печь → уголь/железо → плавка → железное снаряжение; голоден — охота
// day_routine — дневное развитие без мозга (5–10 мин): дерево → деревянная кирка → булыжник → каменные кирка и меч →
// печь → уголь → железо → плавка → железные кирка/меч/броня; еда — охота и жарка, если есть нечего.
// Уголь и железо — только увиденные (честное зрение); не видно — одна вылазка explore и снова.
// Выходит сам: скоро ночь, мало HP, max_sec, или делать больше нечего. Уже готовое пропускает.
const PICK_ANY = /^(wooden|stone|golden|iron|diamond|netherite)_pickaxe$/;
const PICK_STONE = /^(stone|iron|diamond|netherite)_pickaxe$/;
const SWORD_STONE = /^(stone|iron|diamond|netherite)_sword$/;
const PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/;
const SWORD_IRON = /^(iron|diamond|netherite)_sword$/;
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
const FOOD_OK = /^(cooked_|bread$|baked_potato$|carrot$|apple$|golden_carrot$|melon_slice$|sweet_berries$|potato$|beetroot$|pumpkin_pie$|cookie$|mushroom_stew$|rabbit_stew$|beetroot_soup$|dried_kelp$)/;
// железная броня: [предмет, слитков, слот брони — чем ещё может быть занят]
const ARMOR = [['iron_chestplate', 8, /_chestplate$/], ['iron_helmet', 5, /_helmet$/], ['iron_leggings', 7, /_leggings$/], ['iron_boots', 4, /_boots$/]];
const BETTER_ARMOR = /^(iron|diamond|netherite)_/;

module.exports = {
  name: 'day_routine',
  description: 'Днём без мозга 5–10 мин: дерево → деревянная кирка → булыжник ×20 → каменные кирка/меч → печь → уголь и железо (только видимые, иначе explore) → плавка → железные кирка/меч/броня; если голоден и нечего есть — охота и жарка. Пропускает готовое. Сам выходит: скоро ночь (night_soon), HP<8, max_sec или делать нечего.',
  params: {
    max_sec: 'потолок по времени, по умолчанию 600',
    stone: 'сколько булыжника держать, по умолчанию 20'
  },
  async run(api, params) {
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 600;
    const stoneWant = Number(params.stone) > 0 ? Number(params.stone) : 20;
    const deadline = Date.now() + maxSec * 1000;
    const did = [], skipped = [];
    let snap = await api.snapshot();
    const inv0 = invMap(snap.inventory);
    let explores = 0;

    const refresh = async () => { snap = await api.snapshot(); return invMap(snap.inventory); };
    const stopReason = () => {
      const t = (snap.eyes && snap.eyes.time) || {};
      if (t.phase === 'ночь' || (typeof t.nightIn === 'number' && t.nightIn > 0 && t.nightIn < 60) || t.phase === 'закат') return 'night_soon: скоро ночь';
      if (typeof snap.health === 'number' && snap.health < 8) return 'мало HP';
      if (Date.now() > deadline) return 'вышло время max_sec';
      return null;
    };
    const finish = async reason => {
      let gained = {};
      try { const m = await refresh(); for (const n of Object.keys(m)) { const d = m[n] - (inv0[n] || 0); if (d > 0) gained[n] = d; } } catch (e) {}
      api.log(`day_routine: ${reason}; сделано: ${did.join(', ') || 'ничего'}`);
      return { ok: true, did, skipped, gained, reason };
    };
    // шаг: ok -> true; «не вижу/не нашёл» -> false (пропуск); остальные ошибки -> false с записью
    const step = async (title, action, p) => {
      api.log('шаг: ' + title);
      try { await api.cmd(action, p); did.push(title); return true; }
      catch (e) { skipped.push(`${title}: ${e.message.replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 120)}`); api.log(`${title}: ${e.message}`); return false; }
    };
    const has = (m, re) => Object.keys(m).some(n => re.test(n) && m[n] > 0);
    const sum = (m, re) => Object.keys(m).filter(n => re.test(n)).reduce((s, n) => s + m[n], 0);

    for (let pass = 0; pass < 12; pass++) {
      let m = await refresh();
      let r = stopReason(); if (r) return finish(r);
      let progress = false;

      // еда: голоден и нечего есть — охота, потом жарка
      if ((typeof snap.food === 'number' ? snap.food : 20) < 14 && !Object.keys(m).some(n => FOOD_OK.test(n))) {
        const animals = ((snap.eyes && snap.eyes.animals) || []).filter(a => /cow|pig|sheep|chicken|rabbit|mooshroom|goat/.test(a.name));
        if (animals.length && await step('охота', 'hunt', { count: 2 })) progress = true;
        m = await refresh();
      }
      const raw = RAW_MEAT.find(n => m[n] > 0);
      if (raw && has(m, /^(coal|charcoal)$|_planks$|_log$/) && await step('жарка ' + raw, 'smelt', { item: 'cooked_' + raw, count: Math.min(m[raw], 8) })) { progress = true; m = await refresh(); }

      // 1. дерево и деревянная кирка
      if (!has(m, PICK_ANY)) {
        const wood = sum(m, /_(log|stem)$/) + Math.floor(sum(m, /_planks$/) / 4);
        if (wood < 8) {
          const okLog = await step('бревна', 'collect', { block: 'log', count: 8 - wood });
          if (!okLog) { if (explores++ < 3 && await step('explore за деревом', 'explore', { distance: 48 })) continue; return finish('не нашла дерево'); }
        }
        if (!(await step('деревянная кирка', 'craft', { item: 'wooden_pickaxe' }))) return finish('не скрафтила деревянную кирку');
        progress = true; m = await refresh();
      }
      if ((r = stopReason())) return finish(r);

      // 2. булыжник, каменные кирка и меч, печь
      const needPick = !has(m, PICK_STONE), needSword = !has(m, SWORD_STONE), needFurnace = !m.furnace;
      const cobble = sum(m, /^(cobblestone|cobbled_deepslate)$/);
      const want = Math.max(stoneWant, (needPick ? 3 : 0) + (needSword ? 2 : 0) + (needFurnace ? 8 : 0) + 9);
      if (cobble < want && (needPick || needSword || needFurnace || cobble < 10)) {
        if (await step('булыжник', 'collect', { block: 'stone', count: Math.min(want - cobble, 24) })) progress = true;
        m = await refresh();
      }
      if (needPick && await step('каменная кирка', 'craft', { item: 'stone_pickaxe' })) progress = true;
      if (needSword && await step('каменный меч', 'craft', { item: 'stone_sword' })) progress = true;
      m = await refresh();
      if (!m.furnace && sum(m, /^(cobblestone|cobbled_deepslate)$/) >= 8 && await step('печь', 'craft', { item: 'furnace' })) progress = true;
      if ((r = stopReason())) return finish(r);
      m = await refresh();

      // 3. сколько железа нужно на недостающее железное
      let ingotsNeed = 0;
      const wantIron = [];
      if (!has(m, PICK_IRON)) { ingotsNeed += 3; wantIron.push(['iron_pickaxe', 3]); }
      if (!has(m, SWORD_IRON)) { ingotsNeed += 2; wantIron.push(['iron_sword', 2]); }
      const worn = new Set(snap.armor || []);
      for (const [item, n, slot] of ARMOR) {
        const already = [...worn, ...Object.keys(m)].some(x => slot.test(x) && BETTER_ARMOR.test(x));
        if (!already) { ingotsNeed += n; wantIron.push([item, n]); }
      }
      const ingots = m.iron_ingot || 0, rawIron = m.raw_iron || 0;
      const ironShort = Math.max(0, ingotsNeed - ingots - rawIron);

      // 4. уголь (видимый) — на плавку
      const coal = (m.coal || 0) + (m.charcoal || 0);
      const visible = k => !!(snap.eyes && snap.eyes.blocks && snap.eyes.blocks[k]);
      if (has(m, PICK_ANY) && coal < 8 && (ironShort > 0 || rawIron > 0 || coal < 4) && visible('coal_ore')) {
        if (await step('уголь', 'collect', { block: 'coal', count: 8 - coal })) progress = true;
      }
      // 5. железо (видимое; нужна каменная кирка)
      m = await refresh();
      if (has(m, PICK_STONE) && ironShort > 0 && visible('iron_ore')) {
        if (await step('железо', 'collect', { block: 'iron', count: Math.min(ironShort, 10) })) progress = true;
      }
      if ((r = stopReason())) return finish(r);

      // 6. плавка железа
      m = await refresh();
      if ((m.raw_iron || 0) > 0 && has(m, /^(coal|charcoal)$|_planks$|_log$/)) {
        if (await step('плавка железа', 'smelt', { item: 'iron_ingot', count: Math.min(m.raw_iron, 16) })) progress = true;
        m = await refresh();
      }
      // 7. железные кирка, меч, броня — пока хватает слитков
      for (const [item, n] of wantIron) {
        m = await refresh();
        if ((m.iron_ingot || 0) < n) continue;
        if (await step(item, 'craft', { item })) progress = true;
      }
      if (did.some(d => /^iron_/.test(d))) { try { await api.cmd('equip_best', { for: 'fight' }); } catch (e) {} }
      if ((r = stopReason())) return finish(r);

      m = await refresh();
      const ironDone = has(m, PICK_IRON) && has(m, SWORD_IRON) && ARMOR.every(([, , slot]) => [...(snap.armor || []), ...Object.keys(m)].some(x => slot.test(x) && BETTER_ARMOR.test(x)));
      if (ironDone) return finish('железное снаряжение готово');
      if (!progress) {
        // руды не видно — одна вылазка, потом снова; не больше 4 за запуск
        if (explores >= 4) return finish('делать нечего: руды не видно после вылазок');
        explores++;
        if (!(await step('explore за рудой', 'explore', { distance: 48 }))) return finish('explore не удался');
      }
    }
    return finish('исчерпан лимит проходов');
  }
};

function invMap(inv) {
  const m = {};
  for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}
