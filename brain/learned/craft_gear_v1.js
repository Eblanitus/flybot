// версия: вариант по заявке учителя (craft_gear_equip, L035): не крафтит — находит лучшее оружие (меч, далее топор) в инвентаре и надевает в руку, когда в руке не оружие; оружия в инвентаре нет — отказ «нужен крафт»; быстрая (секунды), боя не начинает, никуда не идёт; сам вызов = «мозг попросил»
const RANK = { wooden: 1, golden: 1, stone: 2, copper: 3, iron: 4, diamond: 5, netherite: 6 };
const clean = msg => String(msg).replace(/^навык тела "[^"]+" не удался: /, '');
const r1 = n => Math.round(n * 10) / 10;

// меч рейтингово выше топора одного материала (10 очков за материал + 1 за меч)
function weaponScore(name) {
  if (name === 'trident') return (RANK.iron || 4) * 10;
  const m = String(name).match(/^([a-z]+)_(sword|axe)$/);
  if (!m || RANK[m[1]] === undefined) return 0;
  return RANK[m[1]] * 10 + (m[2] === 'sword' ? 1 : 0);
}

module.exports = {
  name: 'craft_gear',
  description: 'Вариант: надеть оружие из сумки, ничего не крафтит — находит лучшее оружие (меч, далее топор) в инвентаре и надевает в руку; годится, когда в руке не оружие (пусто/блок/палка/кирка), а оружие в сумке есть; оружия нет — отказ «нужен крафт»; боя не начинает, никуда не идёт',
  params: {},
  async run(api) {
    const snap = await api.snapshot();
    const inBag = {};
    for (const i of snap.inventory || []) inBag[i.name] = (inBag[i.name] || 0) + i.count;
    const held = (snap.heldItem && snap.heldItem.name) || null;
    const eyes = snap.eyes || {};
    const enemies = eyes.enemies || [];
    const closestD = enemies.map(e => e.d).filter(d => typeof d === 'number').sort((a, b) => a - b)[0];
    const base = {
      hand: held || null,
      phase: (eyes.time && eyes.time.phase) || null,
      mobNear: closestD !== undefined ? r1(closestD) : null,
      weapons: Object.keys(inBag).filter(n => weaponScore(n) > 0)
    };
    if (base.mobNear !== null) api.log(`craft_gear: рядом враг ${base.mobNear} м — только надеваю оружие, в бой не лезу`);
    if (!base.weapons.length) {
      return { ok: false, error: 'оружия нет: нужен крафт (в руке ' + (held || 'пусто') + ')', ...base };
    }
    const best = base.weapons.sort((a, b) => weaponScore(b) - weaponScore(a))[0];
    if (held && weaponScore(held) >= weaponScore(best)) {
      return { ok: true, ...base, note: 'в руке уже оружие ' + held + ' — не хуже лучшего в сумке, ничего не делаю' };
    }
    try {
      await api.cmd('equip_item', { item: best, dest: 'hand' });
    } catch (e) {
      return { ok: false, error: 'equip_item не удался: ' + clean(e.message), ...base };
    }
    await api.sleep(250);
    let heldNow = null;
    try {
      const s2 = await api.snapshot();
      heldNow = (s2.heldItem && s2.heldItem.name) || null;
    } catch (e) {}
    if (!heldNow || weaponScore(heldNow) === 0) {
      return { ok: false, error: 'после equip_item в руке ' + (heldNow || 'пусто') + ' — оружие не в руке', ...base };
    }
    return {
      ok: true, ...base,
      equipped: heldNow, hand: heldNow,
      handBefore: held,
      note: 'в руке ' + heldNow + (held ? ' (было: ' + held + ')' : ' (рука была пуста)')
    };
  }
};
