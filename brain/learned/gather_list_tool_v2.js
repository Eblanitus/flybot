// версия: как gather_list_tool, но v2 исправляет обработку случая «нет брёвен»: даёт честный отказ про брёвна, а не «нужен инструмент»; рабочая цепочка инструментов без TypeError
// gather_list_tool_v2 — добрать список с обеспечением инструмента спереди.
// Если в items есть блоки, требующие кирку (cobblestone, stone, coal, raw_iron, raw_copper, raw_gold, diamond) и кирки нет —
// сначала craft-цепочкой делает wooden_pickaxe (собирает бревна → доски → палки → верстак → кирка), затем collect.
// Если брёвен/досок/палок нет — честный отказ «нет брёвнов для крафта кирки» (не «нужен инструмент»).
// В ответе видно crafted.wooden_pickaxe и collected.cobblestone.
// Если список можно выполнить без инструмента (только доски/брёвна) — старая логика без инструмента работает.

const RECIPES = {
	spruce_planks: { out: 4, ing: { spruce_log: 1 } },
	oak_planks: { out: 4, ing: { oak_log: 1 } },
	birch_planks: { out: 4, ing: { birch_log: 1 } },
	stick: { out: 4, ing: { spruce_planks: 2 } },
	crafting_table: { out: 1, ing: { spruce_planks: 4 } },
	wooden_pickaxe: { out: 1, ing: { spruce_planks: 3, stick: 2 }, table: true },
	stone_pickaxe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
	stone_axe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
	stone_sword: { out: 1, ing: { cobblestone: 2, stick: 1 }, table: true },
	stone_shovel: { out: 1, ing: { cobblestone: 1, stick: 2 }, table: true },
	torch: { out: 4, ing: { coal: 1, stick: 1 } },
	cobblestone_stairs: { out: 4, ing: { cobblestone: 6 }, table: true },
	cobblestone_slab: { out: 6, ing: { cobblestone: 3 }, table: true },
	cobblestone_wall: { out: 6, ing: { cobblestone: 6 }, table: true },
	spruce_door: { out: 3, ing: { spruce_planks: 6 }, table: true },
	spruce_fence: { out: 3, ing: { spruce_planks: 4, stick: 2 }, table: true },
	spruce_fence_gate: { out: 1, ing: { spruce_planks: 2, stick: 4 }, table: true },
	spruce_stairs: { out: 4, ing: { spruce_planks: 6 }, table: true },
	spruce_slab: { out: 6, ing: { spruce_planks: 3 }, table: true },
	spruce_trapdoor: { out: 2, ing: { spruce_planks: 6 }, table: true },
};

const RAW = {
	spruce_log: 'spruce_log', oak_log: 'oak_log', birch_log: 'birch_log',
	cobblestone: 'stone', coal: 'coal', dirt: 'dirt', sand: 'sand',
	raw_iron: 'iron', raw_copper: 'copper', raw_gold: 'gold', diamond: 'diamond',
};

const ALIAS = {
	stone: 'cobblestone', cobble: 'cobblestone', rock: 'cobblestone', rocks: 'cobblestone',
	planks: 'spruce_planks', plank: 'spruce_planks', boards: 'spruce_planks',
	log: 'log', logs: 'log', wood: 'log',
	ore: 'coal', coal_ore: 'coal',
	iron_ore: 'raw_iron', iron: 'raw_iron',
	copper_ore: 'raw_copper', copper: 'raw_copper',
	gold_ore: 'raw_gold', gold: 'raw_gold',
	diamond_ore: 'diamond', soil: 'dirt',
};

const GROUPS = { log: ['spruce_log', 'oak_log', 'birch_log'] };

const SMELT_ONLY = {
	iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold',
	glass: 'sand', brick: 'clay_ball', charcoal: 'spruce_log', smooth_stone: 'cobblestone',
};

const ITEMS_NEEDING_TOOL = new Set(['cobblestone', 'stone', 'coal', 'raw_iron', 'raw_copper', 'raw_gold', 'diamond']);

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

function resolveName(name, inv) {
	const k = String(name || '').trim().toLowerCase().replace(/^minecraft:/, '');
	const a = ALIAS[k];
	if (!a) return k;
	if (a === 'spruce_planks' && !(inv.spruce_planks > 0) && ((inv.oak_planks || 0) > 0 || (inv.birch_planks || 0) > 0)) {
		return (inv.oak_planks || 0) >= (inv.birch_planks || 0) ? 'oak_planks' : 'birch_planks';
	}
	return a;
}

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

function suggestFor(name, cands) {
	const n = String(name || '').toLowerCase();
	if (!n) return null;
	for (const c of cands) if (c !== n && (c.startsWith(n) || n.startsWith(c)) && Math.min(c.length, n.length) >= 3) return c;
	let best = null; let bd = Infinity;
	for (const c of cands) { const d = lev(n, c); if (d < bd) { bd = d; best = c; } }
	return bd <= Math.min(3, Math.max(1, Math.floor(n.length / 3))) ? best : null;
}

function lev(a, b) {
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

function hasPickaxe(inv) {
	return Object.keys(inv).some(name => /_pickaxe$/.test(name) && inv[name] > 0);
}

async function ensureTool(api, targets, inv, tableNear) {
	let currentInv = { ...inv };
	const crafted = [];

	if (hasPickaxe(currentInv)) return { ok: true, craftedItems: crafted };

	const needs = Object.entries(targets).some(([name]) => ITEMS_NEEDING_TOOL.has(name));
	if (!needs) return { ok: true, craftedItems: crafted };

	// Сначала пытаемся собрать бревна, если их нет
	const logs = countOf(currentInv, 'log');
	if (logs < 3) {
		const needLogs = 3 - logs;
		try {
			api.log(`collect spruce_log x${needLogs} для крафта кирки`);
			await api.cmd('collect', { block: 'spruce_log', count: needLogs });
			const snap = await api.snapshot();
			currentInv = {};
			for (const it of (snap.inventory || [])) currentInv[it.name] = (currentInv[it.name] || 0) + it.count;
			crafted.push({ item: 'spruce_log', count: needLogs });
		} catch (e) {
			return {
				ok: false,
				error: 'нет брёвнов рядом — не сделать кирку: ' + (e.message || e),
				craftedItems: crafted,
			};
		}
	}

	// Крафт досок, если нужно
	const totalPlanks = (currentInv.spruce_planks || 0) + (currentInv.oak_planks || 0) + (currentInv.birch_planks || 0);
	if (totalPlanks < 9) {
		const logName = (currentInv.spruce_log || 0) > 0 ? 'spruce_log' : (currentInv.oak_log || 0) > 0 ? 'oak_log' : 'birch_log';
		const plankName = logName.replace('_log', '_planks');
		const times = Math.ceil((9 - totalPlanks) / 4);
		try {
			await api.cmd('craft', { item: plankName, count: times * 4 });
			const snap = await api.snapshot();
			currentInv = {};
			for (const it of (snap.inventory || [])) currentInv[it.name] = (currentInv[it.name] || 0) + it.count;
			crafted.push({ item: plankName, count: times * 4 });
		} catch (e) {
			return { ok: false, error: 'не удалось скрафтить доски: ' + e.message, craftedItems: crafted };
		}
	}

	// Крафт палок, если нужно
	if ((currentInv.stick || 0) < 2) {
		try {
			await api.cmd('craft', { item: 'stick', count: 2 });
			const snap = await api.snapshot();
			currentInv = {};
			for (const it of (snap.inventory || [])) currentInv[it.name] = (currentInv[it.name] || 0) + it.count;
			crafted.push({ item: 'stick', count: 2 });
		} catch (e) {
			return { ok: false, error: 'не удалось скрафтить палки: ' + e.message, craftedItems: crafted };
		}
	}

	// Крафт верстака, если нужно
	const hasTable = (currentInv.crafting_table || 0) > 0;
	if (!hasTable) {
		try {
			await api.cmd('craft', { item: 'crafting_table', count: 1 });
			const snap = await api.snapshot();
			currentInv = {};
			for (const it of (snap.inventory || [])) currentInv[it.name] = (currentInv[it.name] || 0) + it.count;
			crafted.push({ item: 'crafting_table', count: 1 });
		} catch (e) {
			return { ok: false, error: 'не удалось скрафтить верстак: ' + e.message, craftedItems: crafted };
		}
	}

	// Крафт деревянной кирки
	try {
		await api.cmd('craft', { item: 'wooden_pickaxe', count: 1 });
		const snap = await api.snapshot();
		currentInv = {};
		for (const it of (snap.inventory || [])) currentInv[it.name] = (currentInv[it.name] || 0) + it.count;
		crafted.push({ item: 'wooden_pickaxe', count: 1 });
	} catch (e) {
		return { ok: false, error: 'не удалось скрафтить деревянную кирку: ' + e.message, craftedItems: crafted };
	}
	return { ok: true, craftedItems: crafted };
}

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
		sim[name] = (sim[name] || 0) + times * r.out - short;
	};
	for (const [name, n] of Object.entries(targets)) take(name, n, 0);
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

async function invMap(api) {
	const snap = await api.snapshot();
	const m = {};
	for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
	return { inv: m, snap };
}

module.exports = {
	name: 'gather_list_tool_v2',
	description: 'Добрать список предметов с обеспечением инструмента спереди: если нужна кирка (камень/уголь/руда) и её нет — craft-цепочкой делает wooden_pickaxe (бревно → доски → палки → верстак → кирка), затемcollect. Если брёвен нет — честный отказ «нет брёвнов для крафта кирки». В ответе: crafted.wooden_pickaxe, collected.cobblestone. dry=1 — только план.',
	params: {
		items: 'список "имя:кол-во,…" или объект {имя:n}; синонимы: stone=cobblestone, log=брёвна, planks=spruce_planks, coal_ore=coal; max_sec (600); dry: 1 — только план',
		max_sec: 'ограничение времени, по умолчанию 600',
		dry: '1 — только план'
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

		const tableNear = () => {
			const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.crafting_table;
			return !!(b && (b.d === undefined || b.d <= 20));
		};

		const needsTool = Object.entries(targets).some(([name]) => ITEMS_NEEDING_TOOL.has(name) && !hasPickaxe(inv));

		let toolCraftedItems = [];
		if (needsTool) {
			const result = await ensureTool(api, targets, inv, tableNear());
			if (!result.ok) {
				if (result.error.includes('нет брёвнов')) {
					const bad = unreachableItems(targets, inv);
					const cands = [...known, ...Object.keys(inv)];
					const missing = {}; const unknown = [];
					for (const b of bad) {
						missing[b.item] = b.count;
						unknown.push({ item: b.item, count: b.count, have: b.have, suggest: SMELT_ONLY[b.item] || suggestFor(b.item, cands) });
					}
					return {
						ok: false, error: result.error, missing, unknown, requested: parsed, renamed,
						collected: {}, crafted: {}, known,
						sec: Math.round((Date.now() - t0) / 1000)
					};
				}
				return {
					ok: false, error: result.error, collected: {}, crafted: {}, sec: Math.round((Date.now() - t0) / 1000)
				};
			}
			toolCraftedItems = result.craftedItems;
			({ inv, snap } = await invMap(api));
		}

		const haveOf = m => Object.fromEntries(Object.keys(targets).map(k => [k, countOf(m, k)]));
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
			const p = expand(targets, inv, tableNear(), new Set(), new Set());
			const crafts = mergeCrafts(p.crafts);
			const missing = { ...p.raw, ...p.unknown };
			const plan = [
				...Object.entries(p.raw).map(([k, n]) => `добыть ${k} x${n} (collect ${RAW[k]})`),
				...crafts.map(c => `скрафтить ${c.item} x${c.count}`),
				...Object.entries(p.unknown).map(([k, n]) => `не знаю, как получить ${k} x${n}`)
			].join('; ') || 'всё уже есть';
			let toolInfo = '';
			if (needsTool && toolCraftedItems.length > 0) {
				toolInfo = ` (инструмент скрафчен: ${toolCraftedItems.map(c => `${c.item} x${c.count}`).join(', ')}).`;
			} else if (needsTool) {
				toolInfo = ` (нет брёвнов для крафта кирки — отказ).`;
			}
			return { ok: true, dry: true, need: targets, have: haveOf(inv), missing, raw: p.raw, crafts, plan: plan + toolInfo, renamed };
		}

		const crafted = {};
		for (const c of toolCraftedItems) {
			crafted[c.item] = (crafted[c.item] || 0) + c.count;
		}

		const errors = []; const gaveUp = new Set(); const explores = {}; const logSkip = new Set();
		const failedCraft = new Set();
		const start = { ...inv };

		for (let round = 0; round < 40; round++) {
			if (left() <= 0) { errors.push('время вышло'); break; }
			({ inv, snap } = await invMap(api));
			if (!Object.keys(missOf(inv)).length) break;
			const p = expand(targets, inv, tableNear(), logSkip, gaveUp);
			const rawNeed = Object.entries(p.raw).filter(([k]) => !gaveUp.has(k));
			if (rawNeed.length) {
				const [name, n] = rawNeed[0];
				const portion = Math.min(n, 16);
				const before = inv[name] || 0;
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
							retry = true;
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
			const crafts = mergeCrafts(p.crafts).filter(c => !failedCraft.has(c.item));
			if (!crafts.length) break;
			let progress = false;
			for (const c of crafts) {
				if (left() <= 0) break;
				const r = RECIPES[c.item];
				const batch = /_planks$/.test(c.item) ? 4 : c.count;
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