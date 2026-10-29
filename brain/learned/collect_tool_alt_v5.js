// версия: collect с кирками вперёд, но без ручной цепочки крафта: кирку делает одна команда craft (тело само делает доски/палки/верстак), а труд навыка — найти дерево (log любого вида, explore при «не вижу», до 3 раз) и честно отказать «нет брёвен для крафта кирки», а не «нужен инструмент»; прирост считает по инвентарю до/после; ok:true только если каждая цель добрана; по заявке учителя collect_tool_alt_ensure
'use strict';

// блоки, которые без кирки не копаются
const NEEDS_PICK = /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|sandstone|coal|iron|copper|gold|diamond|redstone|lapis|raw_[a-z_]+|[a-z_]+_ore|obsidian|netherrack|basalt|blackstone)$/;
const PICK = /_pickaxe$/;
// имя запрошенного блока -> что прибавится в инвентаре (stone даёт булыжник, руды — добычу)
const DROP = { stone: 'cobblestone', deepslate: 'cobbled_deepslate', coal: 'coal', coal_ore: 'coal', iron: 'raw_iron', iron_ore: 'raw_iron', copper: 'raw_copper', copper_ore: 'raw_copper', gold: 'raw_gold', gold_ore: 'raw_gold', diamond: 'diamond', diamond_ore: 'diamond' };
const NO_VIS = /не вижу|не нашёл|не нашел|нет поблизости|не дотянул|не получается добраться/i;

function parseItems(items) {
  const out = {};
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    for (const [k, v] of Object.entries(items)) { const n = Math.floor(Number(v)); if (k && n > 0) out[String(k).trim()] = n; }
    return out;
  }
  for (const part of String(items || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const [name, cnt] = part.split(/[:=]/);
    const n = cnt === undefined ? 1 : Math.floor(Number(cnt));
    const key = name.trim().replace(/^minecraft:/, '');
    if (key && n > 0) out[key] = (out[key] || 0) + n;
  }
  return out;
}

const msgOf = e => String((e && e.message) || e || '').replace(/^навык тела "[^"]+" не удался:\s*/, '').trim().slice(0, 200);

async function invMap(api) {
  const snap = await api.snapshot();
  const m = {};
  for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
  return { inv: m, snap };
}
const hasPick = inv => Object.keys(inv).some(n => PICK.test(n) && inv[n] > 0);
const woodUnits = inv => {
  let logs = 0, planks = 0;
  for (const [n, c] of Object.entries(inv)) { if (/_log$|_stem$/.test(n)) logs += c; else if (/_planks$/.test(n)) planks += c; }
  return logs + planks / 4;
};

module.exports = {
  name: 'collect_tool_alt',
  description: 'Добыть блок(и), которым нужна кирка (cobblestone, stone, coal, руды), с обеспечением кирки заранее: нет кирки — делает деревянную (craft wooden_pickaxe; тело само делает доски, палки, верстак), при нехватке дерева ищет брёвна (collect log, при «не вижу» — explore, до 3 раз) и только потом копает. Нет брёвен вокруг — отказ «нет брёвен для крафта кирки: …», а не «нужен инструмент». В ответе crafted (в т.ч. wooden_pickaxe) и collected. params: block+count или items="block:count,…", radius, deep, style, max_sec, explores.',
  params: {
    block: 'что добыть (cobblestone, stone, coal, iron …), по умолчанию cobblestone',
    count: 'сколько, по умолчанию 1',
    items: 'список "block:count,…" вместо block/count',
    radius: 'радиус поиска для collect, по умолчанию как у тела (48)',
    deep: 'копать в глубину (true/false)',
    style: 'стиль копки (auto и др.)',
    max_sec: 'потолок времени, по умолчанию 300',
    explores: 'сколько раз уходить искать деревья, если брёвен не видно (по умолчанию 3, 0 — не искать)'
  },
  async run(api, params) {
    params = params || {};
    const t0 = Date.now();
    const maxSec = Math.max(30, Number(params.max_sec) || 300);
    const deadline = t0 + maxSec * 1000;
    const sec = () => Math.round((Date.now() - t0) / 1000);
    const explores = params.explores === undefined ? 3 : Math.max(0, Math.min(6, Math.floor(Number(params.explores)) || 0));

    let targets = {};
    if (params.items) targets = parseItems(params.items);
    else targets[String(params.block || params.type || 'cobblestone').trim()] = Math.max(1, Math.floor(Number(params.count)) || 1);
    if (!Object.keys(targets).length) return { ok: false, error: 'не указан block или items', collected: {}, crafted: {}, sec: sec() };

    const crafted = {};
    let { inv } = await invMap(api);
    const start = { ...inv };
    const gainOf = (name, cur) => (cur[DROP[name] || name] || 0) - (start[DROP[name] || name] || 0);

    // ---- 1. кирка ----
    const needPick = Object.keys(targets).some(n => NEEDS_PICK.test(n));
    let pickaxeEnsured = false;
    if (needPick && !hasPick(inv)) {
      let craftErr = '';
      const tryCraft = async () => {
        try { await api.cmd('craft', { item: 'wooden_pickaxe', count: 1 }); return true; }
        catch (e) { craftErr = msgOf(e); return false; }
      };
      let done = await tryCraft();
      if (!done) {
        // дерева не хватило: добыть брёвна (любого вида), при «не вижу» — уйти поискать
        let tries = 0, logErr = '';
        while (!done && Date.now() < deadline) {
          ({ inv } = await invMap(api));
          const have = woodUnits(inv);
          if (have >= 3) { done = await tryCraft(); break; }      // дерева хватает, а craft не вышел — причина в craftErr
          const need = Math.max(1, Math.ceil(3 - have));
          try {
            api.log('collect log x' + need + ' для кирки');
            await api.cmd('collect', { block: 'log', count: need, radius: params.radius });
          } catch (e) {
            logErr = msgOf(e);
            ({ inv } = await invMap(api));
            if (woodUnits(inv) >= 3) continue;                    // успел набрать, хоть и «не вижу» в конце
            if (NO_VIS.test(logErr) && tries < explores && Date.now() < deadline) {
              tries++;
              api.log('брёвен не видно — explore ' + tries + '/' + explores);
              try { await api.cmd('explore', { distance: 48 }); } catch (e2) { api.log('explore: ' + msgOf(e2)); }
              continue;
            }
            return { ok: false, error: 'нет брёвен для крафта кирки: ' + logErr + (tries ? ' (искала, explore ×' + tries + ')' : ''), collected: {}, crafted, missing: { wooden_pickaxe: 1 }, pickaxeEnsured: false, sec: sec() };
          }
        }
        if (!done) {
          ({ inv } = await invMap(api));
          if (hasPick(inv)) done = true;
          else return { ok: false, error: (Date.now() >= deadline ? 'время вышло, ' : '') + 'не удалось сделать кирку: ' + (craftErr || logErr || 'нет причины'), collected: {}, crafted, missing: { wooden_pickaxe: 1 }, pickaxeEnsured: false, sec: sec() };
        }
      }
      ({ inv } = await invMap(api));
      if (!hasPick(inv)) return { ok: false, error: 'кирки нет после крафта: ' + (craftErr || 'craft ничего не вернул'), collected: {}, crafted, missing: { wooden_pickaxe: 1 }, pickaxeEnsured: false, sec: sec() };
      for (const [n, c] of Object.entries(inv)) if (PICK.test(n) && c > (start[n] || 0)) crafted[n] = c - (start[n] || 0);
      pickaxeEnsured = true;
      api.log('кирка есть: ' + Object.keys(crafted).join(','));
    }

    // ---- 2. добыча ----
    const errors = [];
    for (const [name, count] of Object.entries(targets)) {
      if (Date.now() > deadline) { errors.push('время вышло до ' + name); break; }
      ({ inv } = await invMap(api));
      const left = count - gainOf(name, inv);
      if (left <= 0) continue;
      try {
        const p = { block: name, count: left };
        if (params.radius !== undefined) p.radius = params.radius;
        if (params.deep !== undefined) p.deep = params.deep;
        if (params.style !== undefined) p.style = params.style;
        await api.cmd('collect', p);
      } catch (e) { errors.push(name + ': ' + msgOf(e)); }
    }

    ({ inv } = await invMap(api));
    const collected = {}, missing = {};
    for (const [name, count] of Object.entries(targets)) {
      const g = gainOf(name, inv);
      if (g > 0) collected[DROP[name] || name] = g;
      if (g < count) missing[name] = count - Math.max(0, g);
    }
    const ok = Object.keys(missing).length === 0;
    const res = { ok, collected, crafted, pickaxeEnsured, sec: sec() };
    if (!ok) {
      res.missing = missing;
      res.error = 'не добрала: ' + Object.entries(missing).map(([k, n]) => k + ' x' + n).join(', ') + (errors.length ? ' (' + errors.join('; ') + ')' : '');
    }
    return res;
  }
};
