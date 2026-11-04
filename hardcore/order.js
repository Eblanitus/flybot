// Порядок дел бота этапа 1б (docs/goal_path.md, «Этап 1б», пункт 1, и раздел 8.1). Чистые функции, без игры — их проверяет test/hardcore_order.js.
// Каждую секунду бот снимает «обстановку» (HP, сытость, время суток, инвентарь, враг рядом, сидит ли в укрытии) и спрашивает decide(): что делать сейчас.
// Порядок (сверху важнее):
//   в укрытии: ночью сидеть; днём выходить, только если HP ≥ 14, или HP низкий и еды нет (тогда сразу за едой); стрелок ближе 16 — не выходить;
//   снаружи:  враг рядом → бежать (или драться, если есть каменный меч, HP высокий и это не крипер) → голоден и есть еда → есть →
//             вечер: еды меньше 5 — успеть поохотиться до 12000, иначе укрытие → ночь: укрытие →
//             голоден и еды нет → охота → ступени: брёвна → верстак → деревянная кирка → камень → каменные кирка и меч → запас еды 5 → дальше разведка.
// Дело, которое не вышло 3 раза подряд, — «застрял»: 5 минут его не берём, бот делает следующее по списку.
'use strict';

const T = {
  EAT_FOOD: 14, EAT_HURT_FOOD: 17, HEAL_FOOD: 18,   // есть при сытости ≤ 14 или раненым при ≤ 17; лечение идёт только с 18
  FLEE_DIST: 10, RANGED_DIST: 16, FIGHT_HP: 14,     // враг ближе 10 — реагировать; стрелок ближе 16 — не выходить к нему
  EXIT_HP: 14,                                       // выход из укрытия (8.1): не ниже 14 HP
  FOOD_STOCK: 5, FOOD_MORE: 10,                      // ступень 5 — запас 5; потом добирать до 10 днём
  DUSK: 11000, LAST_HUNT: 12000, NIGHT: 13000, DAWN: 23500,   // время суток в тиках
  STUCK_FAILS: 3, STUCK_MS: 5 * 60 * 1000,
  WOOD_PLANKS: { table: 4, pick: 5, stoneSticks: 2 }, // доски: верстак 4; кирка 3 + 2 палки (≈2 доски); палки на каменные кирку и меч ≈ 2 доски
  STONE_NEED: 8                                      // булыжник: кирка 3 + меч 2 + 3 на заделку укрытия
};

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'parched']);
const NO_MELEE = new Set(['creeper', 'warden', 'ravager', 'enderman', 'evoker', 'vindicator']);
const PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const SWORDS_STONE_UP = ['stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'];

const tod24 = t => ((Number(t) % 24000) + 24000) % 24000;
const isDay = t => { const x = tod24(t); return x >= T.DAWN || x < T.DUSK; };
const isNight = t => { const x = tod24(t); return x >= T.NIGHT && x < T.DAWN; };
const has = (inv, n) => (inv[n] || 0) > 0;
const hasAny = (inv, names) => names.some(n => has(inv, n));
const logs = inv => Object.keys(inv).filter(n => /_(log|stem)$/.test(n) && !n.startsWith('stripped_')).reduce((s, n) => s + inv[n], 0);
const planks = inv => Object.keys(inv).filter(n => n.endsWith('_planks')).reduce((s, n) => s + inv[n], 0);

// Ступени 1–6 лестницы (раздел 1): какие взяты по нынешней обстановке. Взятая ступень не теряется — это помнит makeLadder.
// s.inv — {имя: штук}; s.food — штук годной еды (без гнилой плоти и т. п.); s.tablePlaced — бот ставил верстак; s.nightSurvived — пережил ночь.
function stepsNow(s) {
  const inv = s.inv || {};
  const r = [];
  if (logs(inv) >= 4) r.push(1);
  if (has(inv, 'crafting_table') || s.tablePlaced) r.push(2);
  if (hasAny(inv, PICKS)) r.push(3);
  if (hasAny(inv, PICKS.slice(1)) && hasAny(inv, SWORDS_STONE_UP)) r.push(4);
  if ((s.food || 0) >= T.FOOD_STOCK) r.push(5);
  if (s.nightSurvived) r.push(6);
  return r;
}
const STEP_TEXT = { 1: '4 бревна', 2: 'верстак', 3: 'деревянная кирка', 4: 'каменные кирка и меч', 5: 'запас еды 5', 6: 'пережил первую ночь' };

function makeLadder() {
  const reached = {};   // ступень → { lifeSec, wt }
  return {
    reached,
    // вернуть новые ступени (их пишут в ленту)
    update(s, lifeSec, wt) {
      const fresh = [];
      for (const n of stepsNow(s)) if (!reached[n]) { reached[n] = { lifeSec, wt: wt == null ? null : Math.round(wt) }; fresh.push(n); }
      return fresh;
    },
    top() { const k = Object.keys(reached).map(Number); return k.length ? Math.max(...k) : 0; }
  };
}

// Счёт неудач по делам: 3 подряд — «застрял» на 5 минут.
function makeStuck() {
  const fails = {}, until = {};
  return {
    fails, until,
    isStuck(a, now) { return (until[a] || 0) > now; },
    ok(a) { fails[a] = 0; },
    // true — только что застрял (это событие для ленты)
    fail(a, now) {
      fails[a] = (fails[a] || 0) + 1;
      if (fails[a] >= T.STUCK_FAILS) { fails[a] = 0; until[a] = now + T.STUCK_MS; return true; }
      return false;
    }
  };
}

// Что делать сейчас. s: { hp, food (сытость 0–20), foodItems (штук годной еды), tod, inv, enemy: {name, d} | null, sheltered,
// tableNear (верстак рядом стоит), nightSurvived }. stuck — makeStuck() или null, now — мс.
// Ответ: { do, why, ...параметры }. Дела: flee, fight, eat, wait, leave, shelter, hunt, logs, table, pickaxe, stone, stone_tools, explore.
function decide(s, stuck = null, now = Date.now()) {
  const inv = s.inv || {};
  const hp = s.hp == null ? 20 : s.hp, food = s.food == null ? 20 : s.food, fi = s.foodItems || 0;
  const tod = tod24(s.tod || 0);
  const free = a => !stuck || !stuck.isStuck(a, now);
  const enemy = s.enemy && s.enemy.d != null ? s.enemy : null;
  const name = enemy ? String(enemy.name || '').toLowerCase() : '';
  const ranged = enemy && RANGED.has(name) && enemy.d < T.RANGED_DIST;
  const hungry = food <= T.EAT_FOOD || (hp < 20 && food <= T.EAT_HURT_FOOD);

  if (s.sheltered) {
    if (hungry && fi > 0) return { do: 'eat', why: 'в укрытии: поесть' };
    if (!isDay(tod)) return { do: 'wait', why: 'в укрытии: ночь' };
    if (ranged) return { do: 'wait', why: `в укрытии: стрелок ${name} в ${Math.round(enemy.d)} бл.` };
    if (hp >= T.EXIT_HP) return { do: 'leave', why: `утро, HP ${hp}` };
    if (fi > 0 && food < 20) return { do: 'eat', why: `в укрытии: HP ${hp}, ем ради лечения` };
    if (food >= T.HEAL_FOOD) return { do: 'wait', why: `в укрытии: лечусь, HP ${hp}` };
    return { do: 'leave', why: `HP ${hp} и еды нет — днём сразу за едой`, then: 'hunt' };
  }

  if (enemy && enemy.d < T.FLEE_DIST) {
    const canFight = hasAny(inv, SWORDS_STONE_UP) && hp >= T.FIGHT_HP && !NO_MELEE.has(name) && !ranged;
    if (canFight && free('fight')) return { do: 'fight', why: `${name} в ${Math.round(enemy.d)} бл., меч есть` };
    if (free('flee')) return { do: 'flee', why: `${name} в ${Math.round(enemy.d)} бл.` };
  }
  if (hungry && fi > 0) return { do: 'eat', why: `сытость ${food}` };

  if (!isDay(tod)) {
    if (!isNight(tod) && tod < T.LAST_HUNT && fi < T.FOOD_STOCK && free('hunt')) return { do: 'hunt', why: `вечер, еды ${fi} — сначала охота`, count: 2 };
    if (free('shelter')) return { do: 'shelter', why: isNight(tod) ? 'ночь' : 'закат' };
    return { do: 'wait', why: 'укрытие не выходит — стою' };
  }

  if (hungry && fi === 0 && free('hunt')) return { do: 'hunt', why: `сытость ${food}, еды нет`, count: 2 };

  const tableOk = has(inv, 'crafting_table') || s.tableNear;
  const pickOk = hasAny(inv, PICKS);
  const stonePick = hasAny(inv, PICKS.slice(1)), stoneSword = hasAny(inv, SWORDS_STONE_UP);
  const W = T.WOOD_PLANKS;
  const needPlanks = (tableOk ? 0 : W.table) + (pickOk ? 0 : W.pick) + (stonePick && stoneSword ? 0 : W.stoneSticks);
  const havePlanks = planks(inv) + 4 * logs(inv);
  if (havePlanks < needPlanks && free('logs'))
    return { do: 'logs', why: `дерева мало: ${havePlanks} досок из ${needPlanks}`, count: Math.max(4, Math.ceil((needPlanks - havePlanks) / 4) + 1) };
  // дерева не хватает и рубка «застряла» — верстак и кирку не пробуем (нечем), идём дальше по списку
  if (!tableOk && havePlanks >= W.table && free('table')) return { do: 'table', why: 'нет верстака' };
  if (!pickOk && tableOk && havePlanks + (inv.stick || 0) / 2 >= W.pick && free('pickaxe')) return { do: 'pickaxe', why: 'нет кирки' };
  if (pickOk && !(stonePick && stoneSword)) {
    const need = (stonePick ? 0 : 3) + (stoneSword ? 0 : 2);
    const cobble = (inv.cobblestone || 0) + (inv.cobbled_deepslate || 0) + (inv.blackstone || 0);
    if (cobble < need && free('stone')) return { do: 'stone', why: 'нужен булыжник', count: T.STONE_NEED };
    if (cobble >= need && free('stone_tools')) return { do: 'stone_tools', why: 'булыжник есть', items: [stonePick ? null : 'stone_pickaxe', stoneSword ? null : 'stone_sword'].filter(Boolean) };
  }
  if (fi < T.FOOD_STOCK && free('hunt')) return { do: 'hunt', why: `еды ${fi} из ${T.FOOD_STOCK}`, count: 2 };
  if (fi < T.FOOD_MORE && tod < 9000 && free('hunt')) return { do: 'hunt', why: `еды ${fi}, добираю до ${T.FOOD_MORE}`, count: 2 };
  const lack = [havePlanks < needPlanks && 'дерево', fi < T.FOOD_STOCK && 'еду', pickOk && !(stonePick && stoneSword) && 'камень'].filter(Boolean);
  return { do: 'explore', why: lack.length ? `ищу ${lack.join(', ')} — разведка` : 'ступени 1–5 взяты — разведка' };
}

module.exports = { T, decide, stepsNow, makeLadder, makeStuck, STEP_TEXT, isDay, isNight, logs, planks, RANGED };
