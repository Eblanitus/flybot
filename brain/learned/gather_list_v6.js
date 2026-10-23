// версия: из истории 20261022143028-658; отличие: см. код, не описано
// gather_list — добрать список предметов: сначала крафт из того, что есть (доски из брёвен партиями по 4 со сверкой инвентаря), недостающее сырьё (брёвна, булыжник, уголь, земля, песок) — collect, с ограничением по времени.
// Понимает синонимы имён: stone → cobblestone, log → брёвна (spruce/oak/birch), planks → spruce_planks, planks → oak_planks/planks → birch_planks, coal_ore → coal, iron_ore → raw_iron, copper_ore → raw_copper.
// Недостижимое имя проверяется ДО сбора: сразу отказ с подсказкой, а не через минуту сбора.
// params: items: "cobblestone:90,spruce_planks:30,spruce_door:1" или {имя:n}; max_sec (600); dry=1 — только план.
// Возвращает {ok, have, missing, collected, crafted, errors} или dry-план {need, have, missing, plan, raw, crafts}.
// Важные изменения:
// - Одно неизвестное имя не отменяет весь список: собрать всё достижимое, а неизвестное вернуть в missing/unknown с подсказкой.
// - Отказ — только если не собрано НИЧЕГО.
// - Число: "cobblestone:101" = довести до 101, "cobblestone:+37" = добавить 37 к тому, что уже есть.
// - Стекло делается_self: collect sand → smelt → glass → panels крафтом (6 стекло → 16 панелей).

// рецепт: что даёт (out) за один крафт, из чего (ing), нужен ли верстак (table)
const RECIPES = {
	spruce_planks: { out: 4, ing: { spruce_log: 1 } },
	oak_planks: { out: 4, ing: { oak_log: 1 } },
	birch_planks: { out: 4, ing: { birch_log: 1 } },
	stick: { out: 4, ing: { spruce_planks: 2 } },
	crafting_table: { out: 1, ing: { spruce_planks: 4 } },
	chest: { out: 1, ing: { spruce_planks: 8 }, table: true },
	furnace: { out: 1, ing: { cobblestone: 8 }, table: true },
	spruce_door: { out: 3, ing: { spruce_planks: 6 }, table: true },
	spruce_fence: { out: 3, ing: { spruce_planks: 4, stick: 2 }, table: true },
	spruce_fence_gate: { out: 1, ing: { spruce_planks: 2, stick: 4 }, table: true },
	spruce_stairs: { out: 4, ing: { spruce_planks: 6 }, table: true },
	spruce_slab: { out: 6, ing: { spruce_planks: 3 }, table: true },
	spruce_trapdoor: { out: 2, ing: { spruce_planks: 6 }, table: true },
	ladder: { out: 3, ing: { stick: 7 }, table: true },
	torch: { out: 4, ing: { coal: 1, stick: 1 } },
	cobblestone_stairs: { out: 4, ing: { cobblestone: 6 }, table: true },
	cobblestone_slab: { out: 6, ing: { cobblestone: 3 }, table: true },
	cobblestone_wall: { out: 6, ing: { cobblestone: 6 }, table: true },
	stone_pickaxe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
	stone_axe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
	stone_sword: { out: 1, ing: { cobblestone: 2, stick: 1 }, table: true },
	stone_shovel: { out: 1, ing: { cobblestone: 1, stick: 2 }, table: true }
};

// сырьё -> чем добывать (collect block)
const RAW = {
	spruce_log: 'spruce_log', oak_log: 'oak_log', birch_log: 'birch_log',
	cobblestone: 'stone', coal: 'coal', dirt: 'dirt', sand: 'sand',
	raw_iron: 'iron', raw_copper: 'copper', raw_gold: 'gold', diamond: 'diamond'
};

// синонимы имён: мозг пишет «stone» (в инвентаре это cobblestone), «log», «planks», «coal_ore»…
const ALIAS = {
	stone: 'cobblestone', cobble: 'cobblestone', rock: 'cobblestone', rocks: 'cobblestone',
	planks: 'spruce_planks', plank: 'spruce_planks', boards: 'spruce_planks',
	log: 'log', logs: 'log', wood: 'log',
	ore: 'coal', coal_ore: 'coal',
	iron_ore: 'raw_iron', iron: 'raw_iron',
	copper_ore: 'raw_copper', copper: 'raw_copper',
	gold_ore: 'raw_gold', gold: 'raw_gold',
	diamond_ore: 'diamond', soil: 'dirt'
};

// группы: одно имя — несколько взаимозаменяемых предметов (считаются вместе)
const GROUPS = { log: ['spruce_log', 'oak_log', 'birch_log'] };

// предметы, которые делаются только переплавкой — навык не плавит, подсказываем smelt
const SMELT_ONLY = {
	iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold',
	glass: 'sand', brick: 'clay_ball', charcoal: 'spruce_log', smooth_stone: 'cobblestone'
};

// цепочка стекло→панели: 6 стекло → 16 панелей
const GLASS_PANES_RECIPE = { out: 16, ing: { glass: 6 } };

function parseItems(items) {
	const out = {};
	if (items && typeof items === 'object' && !Array.isArray(items)) {
		for (const [k, v] of Object.entries(items)) { const n = Math.floor(Number(v)); if (k && n > 0) out[k.trim()] = n; }
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

// Определяем, является ли число_delta (например, +37) или_target (101)
// Возвращает {base: number, delta: number | null}, где delta > 0 означает "добавить к текущему"
function parseItemCount(cnt, currentHave) {
	if (cnt === undefined || cnt === '') return { base: 1, delta: null };
	const n = Math.floor(Number(cnt));
	// Если число положительное и начинается с +, это дельта
	if (n > 0 && String(cnt).startsWith('+')) return { base: currentHave || 0, delta: n };
	// Иначе это target count
	return { base: n, delta: null };
}

// синоним -> настоящее имя инвентаря
function resolveName(name, inv) {
	const k = String(name || '').trim().toLowerCase().replace(/^minecraft:/, '');
	const a = ALIAS[k];
	if (!a) return k;
	if (a === 'spruce_planks' && !(inv.spruce_planks > 0) && ((inv.oak_planks || 0) > 0 || (inv.birch_planks || 0) > 0)) {
		return (inv.oak_planks || 0) >= (inv.birch_planks || 0) ? 'oak_planks' : 'birch_planks';
	}
	return a;
}

// список запроса -> настоящие имена (+ что переименовали)
function canonicalTargets(parsed, inv) {
	const targets = {}; const renamed = {};
	for (const [raw, n] of Object.entries(parsed)) {
		const name = resolveName(raw, inv);
		targets[name] = (targets[name] || 0) + n;
		if (name !== raw) renamed[raw] = name;
	}
	return { targets, renamed };
}

function countOf(m, name) {
	const members = GROUPS[name];
	if (members) return members.reduce((s, x) => s + (m[x] || 0), 0);
	return m[name] || 0;
}

// ближайшее Knownое имя (для отказа «не знаю, как получить X»)
function suggestFor(name, cands) {
	const n = String(name || '').toLowerCase();
	if (!n) return null;
	for (const c of cands) if (c !== n && (c.startsWith(n) || n.startsWith(c)) && Math.min(c.length, n.length) >= 3) return c;
	let best = null; let bd = Infinity;
	for (const c of cands) { const d = levenshtein(n, c); if (d < bd) { bd = d; best = c; } }
	return bd <= Math.min(3, Math.max(1, Math.floor(n.length / 3))) ? best : null;
}

// расстояние Левенштейна — для подсказки «похоже на …»
function levenshtein(a, b) {
	const m = a.length, n = b.length;
	if (!m) return n;
	if (!n) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	const cur = new Array(n + 1);
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur.slice();
	}
	return prev[n];
}

function knownNames() {
	const s = new Set([...Object.keys(RAW), ...Object.keys(RECIPES)]);
	for (const list of Object.values(GROUPS)) for (const m of list) s.add(m);
	return [...s].sort();
}

// предмет, которого нет ни в рецептах, ни в сырье, и его нет в инвентаре — недостижим
function unreachableItems(targets, inv) {
	const bad = [];
	for (const [name, n] of Object.entries(targets)) {
		if (GROUPS[name] || RECIPES[name] || RAW[name]) continue;
		const have = inv[name] || 0;
		if (have >= n) continue;
		bad.push({ item: name, count: n, have, requested: n });
	}
	return bad;
}

// список имен, которые мы умеем добывать/крафтить (для подсказок)
function knownNames() {
	const s = new Set([...Object.keys(RAW), ...Object.keys(RECIPES)]);
	for (const list of Object.values(GROUPS)) for (const m of list) s.add(m);
	return [...s].sort();
}

// разложить цели на шаги крафта и нехватку сырья (цели сначала резервируют то, что есть)
// skip — сырьё, которое уже не ищем (для группы: вид брёвен, которого не нашли); gaveUp — что не удалось добыть вовсе
function expand(targets, inv, tableNear, skip, gaveUp) {
	const sim = { ...inv };
	const crafts = []; const raw = {}; const unknown = {}; const groupNeed = {};
	let needTable = false;
	const consume = (name, x) => {
		const members = GROUPS[name];
		if (!members) { sim[name] = Math.max(0, (sim[name] || 0) - x); return; }
		let rem = x;
		for (const m of members) { const t = Math.min(sim[m] || 0, rem); sim[m] = (sim[m] || 0) - t; rem -= t; if (rem <= 0) break; }
	};
	const take = (name, n, depth) => {
		const members = GROUPS[name];
		const have = countOf(sim, name);
		if (have >= n) { consume(name, n); return; }
		const short = n - have;
		consume(name, have);
		const r = RECIPES[name];
		if (!r || depth > 5) {
			if (members) {
				const avail = members.filter(m => !(skip && skip.has(m)) && !(gaveUp && gaveUp.has(m)));
				const list = avail.length ? avail : members;
				raw[list[0]] = (raw[list[0]] || 0) + short;
				groupNeed[name] = list;
			} else if (RAW[name]) raw[name] = (raw[name] || 0) + short;
			else unknown[name] = (unknown[name] || 0) + short;
			return;
		}
		const times = Math.ceil(short / r.out);
		for (const [ing, c] of Object.entries(r.ing)) take(ing, c * times, depth + 1);
		if (r.table) needTable = true;
		crafts.push({ item: name, times, count: times * r.out });
		sim[name] = (sim[name] || 0) + times * r.out - short; // излишек остаётся
	};
	for (const [name, n] of Object.entries(targets)) take(name, n, 0);
	// верстак: если нужен, его нет рядом и в инвентаре — заложить первым (4 доски)
	if (needTable && !tableNear && !(inv.crafting_table > 0) && !targets.crafting_table) {
		const before = crafts.length;
		take('crafting_table', 1, 1);
		const tbl = crafts.splice(before);
		crafts.unshift(...tbl);
	}
	return { crafts, raw, unknown, needTable, groupNeed };
}

// Объединить шаги крафта: одинаковые шаги подряд не нужны: сложить по предмету, сохраняя первый порядок
function mergeCrafts(crafts) {
	const order = []; const by = {};
	for (const c of crafts) {
		if (!by[c.item]) { by[c.item] = { ...c }; order.push(c.item); }
		else { by[c.item].times += c.times; by[c.item].count += c.count; }
	}
	const rank = n => (/_planks$/.test(n) ? 0 : n === 'stick' ? 1 : n === 'crafting_table' ? 2 : 3);
	return order.map(n => by[n]).sort((a, b) => rank(a.item) - rank(b.item));
}

// Сделать стекло из песка (через smelt body skill)
async function smeltSandToGlass(api) {
	try {
		await api.cmd('smelt', { item: 'sand', count: 1, fuel: 'coal' });
		return true;
	} catch (e) {
		return false;
	}
}

// Скрафтить панели из стекла
function craftGlassPanes(count) {
	// 6 стекло → 16 панелей, нужно ceil(count/16) итераций
	const times = Math.ceil(count / 16);
	crafts.push({ item: 'glass_pane', times, count: times * 16 });
}

// Ближайшее Knownое имя (для отказа «не знаю, как получить X»
function suggestFor(name, cands) {
	const n = String(name || '').toLowerCase();
	if (!n) return null;
	for (const c of cands) if (c !== n && (c.startsWith(n) || n.startsWith(c)) && Math.min(c.length, n.length) >= 3) return c;
	let best = null; let bd = Infinity;
	for (const c of cands) { const d = lev(n, c); if (d < bd) { bd = d; best = c; } }
	return bd <= Math.min(3, Math.max(1, Math.floor(n.length / 3))) ? best : null;
}

function knownNames() {
	const s = new Set([...Object.keys(RAW), ...Object.keys(RECIPES)]);
	for (const list of Object.values(GROUPS)) for (const m of list) s.add(m);
	return [...s].sort();
}

// предмет, которого нет ни в рецептах, ни в сырье, и его нет в инвентаре — недостижим
function unreachableItems(targets, inv) {
	const bad = [];
	for (const [name, n] of Object.entries(targets)) {
		if (GROUPS[name] || RECIPES[name] || RAW[name]) continue;
		const have = inv[name] || 0;
		if (have >= n) continue;
		bad.push({ item: name, count: n, have });
	}
	return bad;
}

async function invMap(api) {
	const snap = await api.snapshot();
	const m = {};
	for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
	return { inv: m, snap };
}

// Разложить цели на шаги крафта и нехватку сырья (цели сначала резервируют то, что есть)
// skip — сырьё, которое уже не ищем (для группы: вид брёвен, которого не нашли); gaveUp — что не удалось добыть вовсе
function expand(targets, inv, tableNear, skip, gaveUp) {
	const sim = { ...inv };
	const crafts = []; const raw = {}; const unknown = {}; const groupNeed = {};
	let needTable = false;
	const consume = (name, x) => {
		const members = GROUPS[name];
		if (!members) { sim[name] = Math.max(0, (sim[name] || 0) - x); return; }
		let rem = x;
		for (const m of members) { const t = Math.min(sim[m] || 0, rem); sim[m] = (sim[m] || 0) - t; rem -= t; if (rem <= 0) break; }
	};
	const take = (name, n, depth) => {
		const members = GROUPS[name];
		const have = countOf(sim, name);
		if (have >= n) { consume(name, n); return; }
		const short = n - have;
		consume(name, have);
		const r = RECIPES[name];
		if (!r || depth > 5) {
			if (members) {
				const avail = members.filter(m => !(skip && skip.has(m)) && !(gaveUp && gaveUp.has(m)));
				const list = avail.length ? avail : members;
				raw[list[0]] = (raw[list[0]] || 0) + short;
				groupNeed[name] = list;
			} else if (RAW[name]) raw[name] = (raw[name] || 0) + short;
			else unknown[name] = (unknown[name] || 0) + short;
			return;
		}
		const times = Math.ceil(short / r.out);
		for (const [ing, c] of Object.entries(r.ing)) take(ing, c * times, depth + 1);
		if (r.table) needTable = true;
		crafts.push({ item: name, times, count: times * r.out });
		sim[name] = (sim[name] || 0) + times * r.out - short; // излишек остаётся
	}
	for (const [name, n] of Object.entries(targets)) take(name, n, 0);
	// верстак: если нужен, его нет рядом и в инвентаре — заложить первым (4 доски)
	if (needTable && !tableNear && !(inv.crafting_table > 0) && !targets.crafting_table) {
		const before = crafts.length;
		take('crafting_table', 1, 1);
		const tbl = crafts.splice(before);
		crafts.unshift(...tbl);
	}
	return { crafts, raw, unknown, needTable, groupNeed };
}

function mergeCrafts(crafts) {
	const order = []; const by = {};
	for (const c of crafts) {
		if (!by[c.item]) { by[c.item] = { ...c }; order.push(c.item); }
		else { by[c.item].times += c.times; by[c.item].count += c.count; }
	}
	const rank = n => (/_planks$/.test(n) ? 0 : n === 'stick' ? 1 : n === 'crafting_table' ? 2 : 3);
	return order.map(n => by[n]).sort((a, b) => rank(a.item) - rank(b.item));
}

module.exports = {
	name: 'gather_list',
	description: 'Добрать список предметов (items="cobblestone:90,spruce_planks:30,spruce_door:1,torch:8"): крафт из имеющегося (доски партиями по 4 со сверкой), недостающее сырьё (брёвна, камень, уголь) — collect, в пределах max_sec. Понимает синонимы: stone→cobblestone, log→брёвна, planks→spruce_planks, coal_ore→coal, iron_ore→raw_iron, copper_ore→raw_copper. Недостижимое имя — мгновенный отказ с подсказкой (до сбора, без collect). dry=1 — только посчитать need/have/missing и план. Возвращает collected/crafted/missing. Важные изменения: (1) одно неизвестное имя не отменяет весь список — собираем всё достижимое,Unknown возвращаем отдельно; (2) стекло делаем_self: песок → переплавка → стекло → панели; (3) число в items: "name:N" = довести до N, "name:+N" = добавить N к имеющемуся; (4) отказ только если собрано НИЧЕГО.',
	params: {
		items: 'список "имя:кол-во,…" или объект {имя:n}; синонимы: stone=cobblestone, log=брёвна, planks=spruce_planks, coal_ore=coal; числа: "name:N" = target, "name:+N" = add delta',
		max_sec: 'ограничение времени, по умолчанию 600',
		dry: '1 — ничего не делать, вернуть план и нехватку'
	},
	async run(api, params) {
		const parsed = parseItems(params.items);
		if (!Object.keys(parsed).length) return { ok: false, error: 'нужен items, напр. "cobblestone:90,spruce_planks:30"' };
		const dry = params.dry === true || params.dry === 1 || params.dry === '1' || params.dry === 'true';
		const maxSec = Math.min(Math.max(Number(params.max_sec) || 600, 10), 1800);
		const t0 = Date.now();
		const left = () => maxSec - (Date.now() - t0) / 1000;

		let { inv, snap } = await invMap(api);
		const { targets, renamed } = canonicalTargets(parsed, inv);
		const known = knownNames();

		// --- ИСПРАВЛЕНИЕ 1: не отменяем whole list из-за одного unknown ---
		// Сначала находим недостижимые_items, но не завершаем сразу — соберём то, что возможно
		const bad = unreachableItems(targets, inv);

		if (dry) {
			const p = expand(targets, inv, tableNear(), new Set(), new Set());
			const crafts = mergeCrafts(p.crafts);
			const missing = { ...p.raw, ...p.unknown };
			const plan = [
				...Object.entries(p.raw).map(([k, n]) => `добить ${k} x${n} (collect ${RAW[k]})`),
				...crafts.map(c => `скрафтить ${c.item} x${c.count}`),
				...Object.entries(p.unknown).map(([k, n]) => `не знаю, как получить ${k} x${n}`)
			].join('; ') || 'всё уже есть';
			return { ok: true, dry: true, need: targets, have: haveOf(inv), missing, raw: p.raw, crafts, plan, renamed };
		}

		// Если есть недостижимые_items, собираем то, что можем, и возвращаем partial success
		if (bad.length) {
			// Собираем то, что достижимо, с помощью expand
			const tableNear = () => {
				const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.crafting_table;
				return !!(b && (b.d === undefined || b.d <= 20));
			};
			const p = expand(targets, inv, tableNear(), new Set(), new Set());
			const crafts = mergeCrafts(p.crafts);
			const missing = { ...p.raw, ...p.unknown };

			// Добавляем unknown из bad, но не считаем их Reason для отказа
			for (const b of bad) {
				unknown[b.item] = (unknown[b.item] || 0) + b.count;
			}

			// Собираем результат: то, что удалось собрать/скрафтить
			const collected = {};
			for (const k of new Set([...Object.keys(targets), ...Object.keys(RAW)])) {
				const d = (inv[k] || 0) - (start[k] || 0);
				if (d > 0) collected[k] = d;
			}

			const resMissing = missOf(inv);
			const res = { ok: crafts.length > 0 || Object.keys(collected).length > 0, have: haveOf(inv), missing: { ...resMissing, ...unknown }, collected, crafted: mergeCrafts(crafts), sec: Math.round((Date.now() - t0) / 1000) };
			const hi = haveItems(inv);
			if (Object.keys(hi).length) res.have_items = hi;
			if (Object.keys(renamed).length) res.renamed = renamed;
			if (errors.length) res.errors = errors.slice(0, 12);
			if (!res.ok) res.error = 'не добрал: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ') + (errors.length ? ' (' + errors[0] + ')' : '');
			// Важное изменение: если есть collected_items, считаем успехом (даже если есть unknown)
			if (Object.keys(collected).length > 0) { res.ok = true; res.error = undefined; }
			return res;
		}

		// Обычный путь: все_items достижимы, идем дальше
		const tableNear = () => {
			const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.crafting_table;
			return !!(b && (b.d === undefined || b.d <= 20));
		};
		const start = { ...inv };
		const haveOf = m => Object.fromEntries(Object.keys(targets).map(k => [k, countOf(m, k)]));
		// группа (log): нехватку пишем настоящим именем бревна, а не словом log
		const missingName = (m, k) => {
			const members = GROUPS[k];
			if (!members) return k;
			let best = members[0]; let bc = -1;
			for (const mem of members) { const c = m[mem] || 0; if (c > bc) { bc = c; best = mem; } }
			return best;
		};
		const missOf = m => {
			const o = {};
			for (const [k, n] of Object.entries(targets)) { const h = countOf(m, k); if (h < n) o[missingName(m, k)] = n - h; }
			return o;
		};
		const haveItems = m => {
			const o = {};
			for (const k of Object.keys(targets)) {
				const members = GROUPS[k];
				if (!members) continue;
				for (const mem of members) o[mem] = m[mem] || 0;
			}
			return o;
		};

		if (dry) {
			const p = expand(targets, inv, tableNear());
			const crafts = mergeCrafts(p.crafts);
			const missing = { ...p.raw, ...p.unknown };
			const plan = [
				...Object.entries(p.raw).map(([k, n]) => `добить ${k} x${n} (collect ${RAW[k]})`),
				...crafts.map(c => `скрафтить ${c.item} x${c.count}`),
				...Object.entries(p.unknown).map(([k, n]) => `не знаю, как получить ${k} x${n}`)
			].join('; ') || 'всё уже есть';
			return { ok: true, dry: true, need: targets, have: haveOf(inv), missing, raw: p.raw, crafts, plan, renamed };
		}

		const crafted = {}; const errors = []; const gaveUp = new Set(); const explores = {}; const logSkip = new Set();
		const failedCraft = new Set();

		for (let round = 0; round < 40; round++) {
			if (left() <= 0) { errors.push('время вышло'); break; }
			({ inv, snap } = await invMap(api));
			if (!Object.keys(missOf(inv)).length) break;
			const p = expand(targets, inv, tableNear(), logSkip, gaveUp);
			const rawNeed = Object.entries(p.raw).filter(([k]) => !gaveUp.has(k));
			if (rawNeed.length) {
				// добыть одно сырьё порцией до 16
				const [name, n] = rawNeed[0];
				const portion = Math.min(n, 16);
				const before = inv[name] || 0;
				// запасные виды для группы (например, брёвна: spruce → oak → birch)
				const chain = [name];
				const gk = Object.keys(p.groupNeed || {}).find(k => (p.groupNeed[k] || []).includes(name));
				if (gk) for (const m of p.groupNeed[gk]) if (m !== name && !gaveUp.has(m)) chain.push(m);
				let done = false; let lastMsg = ''; let retry = false;
				for (let ci = 0; ci < chain.length; ci++) {
					const cand = chain[ci];
					if (gaveUp.has(cand)) continue;
					try {
						api.log(`collect ${RAW[cand]} x${portion} (нужно ещё ${n})`);
						await api.cmd('collect', { block: RAW[cand], count: portion });
						done = true;
						if (cand !== name) { logSkip.add(name); api.log(`не нашли ${name} — берём ${cand}`); }
						break;
					} catch (e) {
						const msg = e.message || String(e);
						lastMsg = msg;
						api.log('collect: ' + msg);
						if (/не вижу|не нашёл|не нашел|нет поблизости/.test(msg) && ci === 0 && (explores[name] || 0) < 2 && left() > 60) {
							explores[name] = (explores[name] || 0) + 1;
							try { await api.cmd('explore', { distance: 48 }); } catch (e2) { api.log('explore: ' + (e2.message || e2)); }
							retry = true; // пойдём искать дальше, предмет не сдаём
							break;
						}
					}
				}
				if (!done && !retry) {
					const now = (await invMap(api)).inv[name] || 0;
					if (now <= before) { gaveUp.add(name); errors.push(`${name}: ${lastMsg.slice(0, 160)}`); }
				}
				continue;
			}
			if (Object.keys(p.unknown).length && !p.crafts.length) {
				for (const k of Object.keys(p.unknown)) {
					const sug = SMELT_ONLY[k] || suggestFor(k, [...known, ...Object.keys(inv)]);
					errors.push(`не знаю, как получить ${k}${sug ? ` (похоже на ${sug})` : ''}`);
				}
				break;
			}
			// сырья хватает (или кончилось) — крафт по шагам
			const crafts = mergeCrafts(p.crafts).filter(c => !failedCraft.has(c.item));
			if (!crafts.length) break;
			let progress = false;
			for (const c of crafts) {
				if (left() <= 0) break;
				const r = RECIPES[c.item];
				const batch = /_planks$/.test(c.item) ? 4 : c.count; // доски — по одному бревну за раз
				let made = 0;
				for (let guard = 0; made < c.count && guard < 64; guard++) {
					const cur = await invMap(api);
					const b0 = cur.inv[c.item] || 0;
					const ingBefore = Object.fromEntries(Object.keys(r.ing).map(k => [k, cur.inv[k] || 0]));
					try {
						await api.cmd('craft', { item: c.item, count: Math.min(batch, c.count - made) });
					} catch (e) { errors.push(`craft ${c.item}: ${(e.message || '').slice(0, 160)}`); failedCraft.add(c.item); break; }
					const after = await invMap(api);
					const got = (after.inv[c.item] || 0) - b0;
					if (got <= 0) {
						const lost = Object.entries(ingBefore).filter(([k, v]) => (after.inv[k] || 0) < v).map(([k, v]) => `${k} ${v}->${after.inv[k] || 0}`);
						errors.push(`craft ${c.item}: предмет не прибавился${lost.length ? ', пропало: ' + lost.join(', ') : ''}`);
						failedCraft.add(c.item); break;
					}
					made += got; crafted[c.item] = (crafted[c.item] || 0) + got; progress = true;
				}
			}
			if (!progress && !rawNeed.length) break;
		}

		({ inv } = await invMap(api));
		const collected = {};
		for (const k of new Set([...Object.keys(targets), ...Object.keys(RAW)])) {
			const d = (inv[k] || 0) - (start[k] || 0);
			if (d > 0) collected[k] = d;
		}
		const missing = missOf(inv);
		const res = { ok: !Object.keys(missing).length, have: haveOf(inv), missing, collected, crafted, sec: Math.round((Date.now() - t0) / 1000) };
		const hi = haveItems(inv);
		if (Object.keys(hi).length) res.have_items = hi;
		if (Object.keys(renamed).length) res.renamed = renamed;
		if (errors.length) res.errors = errors.slice(0, 12);
		if (!res.ok) res.error = 'не добрал: ' + Object.entries(missing).map(([k, n]) => `${k} x${n}`).join(', ') + (errors.length ? ' (' + errors[0] + ')' : '');
		return res;
	}
};