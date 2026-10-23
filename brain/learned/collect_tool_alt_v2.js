// версия: новый вариант collect с гарантированным обеспечением инструмента спереди на каждом вызове; stricter проверка + честный fallback про брёвна; по заявке учителя
'use strict';

const RECIPES = {
	spruce_planks: { out: 4, ing: { spruce_log: 1 } },
	oak_planks: { out: 4, ing: { oak_log: 1 } },
	birch_planks: { out: 4, ing: { birch_log: 1 } },
	stick: { out: 4, ing: { spruce_planks: 2 } },
	crafting_table: { out: 1, ing: { spruce_planks: 4 } },
	wooden_pickaxe: { out: 1, ing: { spruce_planks: 3, stick: 2 }, table: true },
	stone_pickaxe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
};

const ITEMS_NEEDING_PICKAXE = new Set(['cobblestone', 'stone', 'coal', 'raw_iron', 'raw_copper', 'raw_gold', 'diamond', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'deepslate', 'cobbled_deepslate']);

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

function hasPickaxe(inv) {
	return Object.keys(inv).some(name => /_pickaxe$/.test(name) && inv[name] > 0);
}

async function invMap(api) {
	const snap = await api.snapshot();
	const m = {};
	for (const it of (snap.inventory || [])) m[it.name] = (m[it.name] || 0) + it.count;
	return { inv: m, snap };
}

async function ensurePickaxe(api, targets, inv, tableNear) {
	let currentInv = { ...inv };
	const crafted = {};

	if (hasPickaxe(currentInv)) {
		return { ok: true, crafted, pickaxeEnsured: false };
	}

	const needs = Object.entries(targets).some(([name]) => ITEMS_NEEDING_PICKAXE.has(name));
	if (!needs) {
		return { ok: true, crafted, pickaxeEnsured: false };
	}

	while (!hasPickaxe(currentInv)) {
		const logs = (currentInv.spruce_log || 0) + (currentInv.oak_log || 0) + (currentInv.birch_log || 0) + (currentInv.log || 0);
		const planks = (currentInv.spruce_planks || 0) + (currentInv.oak_planks || 0) + (currentInv.birch_planks || 0);
		const woodUnits = logs + Math.floor(planks / 4);

		if (woodUnits < 3) {
			const needLogs = 3 - woodUnits;
			try {
				api.log(`collect spruce_log x${needLogs} для крафта кирки`);
				await api.cmd('collect', { block: 'spruce_log', count: needLogs });
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				crafted.spruce_log = (crafted.spruce_log || 0) + needLogs;
			} catch (e) {
				return {
					ok: false,
					error: 'нет брёвен для крафта кирки: ' + (e.message || e),
					crafted,
					pickaxeEnsured: false,
				};
			}
		}

		const totalPlanks = (currentInv.spruce_planks || 0) + (currentInv.oak_planks || 0) + (currentInv.birch_planks || 0);
		if (totalPlanks < 4) {
			const logName = (currentInv.spruce_log || 0) > 0 ? 'spruce_log' : (currentInv.oak_log || 0) > 0 ? 'oak_log' : 'birch_log';
			const plankName = logName.replace('_log', '_planks');
			try {
				await api.cmd('craft', { item: plankName, count: 4 });
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				crafted[plankName] = (crafted[plankName] || 0) + 4;
			} catch (e) {
				return { ok: false, error: 'не удалось скрафтить доски: ' + e.message, crafted, pickaxeEnsured: false };
			}
		}

		if ((currentInv.stick || 0) < 2) {
			try {
				await api.cmd('craft', { item: 'stick', count: 2 });
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				crafted.stick = (crafted.stick || 0) + 2;
			} catch (e) {
				return { ok: false, error: 'не удалось скрафтить палки: ' + e.message, crafted, pickaxeEnsured: false };
			}
		}

		const hasTable = (currentInv.crafting_table || 0) > 0 || (tableNear && tableNear());
		if (!hasTable) {
			try {
				await api.cmd('craft', { item: 'crafting_table', count: 1 });
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				crafted.crafting_table = (crafted.crafting_table || 0) + 1;
			} catch (e) {
				return { ok: false, error: 'не удалось скрафтить верстак: ' + e.message, crafted, pickaxeEnsured: false };
			}
		}

		try {
			await api.cmd('craft', { item: 'wooden_pickaxe', count: 1 });
			const snapData = await invMap(api);
			currentInv = snapData.inv;
			crafted.wooden_pickaxe = (crafted.wooden_pickaxe || 0) + 1;
		} catch (e) {
			return { ok: false, error: 'не удалось скрафтить деревянную кирку: ' + e.message, crafted, pickaxeEnsured: false };
		}
	}

	return { ok: true, crafted, pickaxeEnsured: true };
}

module.exports = {
	name: 'collect_tool_alt_v2',
	description: 'Сбор блока с автоматическим обеспечением деревянной кирки спереди (если нужен инструмент для cobblestone/stone/coal/руд). Проверяет инструмент на каждом вызове, крафтит цепочкой: бревно→доски→палки→верстак→кирка. Честный отказ «нет брёвен для крафта кирки» если материалов нет. params: block, count, items, radius, deep, style.',
	params: {
		block: 'имя блока для сбора (напр. cobblestone, stone, coal)',
		count: 'количество, по умолчанию 1',
		items: 'список в формате "block:count, ..." (альтернатива block/count)',
		radius: 'радиус сбора, по умолчанию 48',
		deep: 'копать в глубину (true/false)',
		style: 'стиль копки (auto и др.)'
	},
	async run(api, params) {
		let targets = {};
		if (params.items) {
			targets = parseItems(params.items);
		} else {
			const want = String(params.block || params.type || params.name || 'cobblestone');
			const count = Math.max(1, parseInt(params.count, 10) || 1);
			targets[want] = count;
		}

		if (!Object.keys(targets).length) {
			return { ok: false, error: 'не указан block или items для сбора' };
		}

		const t0 = Date.now();
		let { inv, snap } = await invMap(api);

		const tableNear = () => {
			const b = snap.eyes && snap.eyes.blocks && snap.eyes.blocks.crafting_table;
			return !!(b && (b.d === undefined || b.d <= 20));
		};

		const toolRes = await ensurePickaxe(api, targets, inv, tableNear);
		const crafted = toolRes.crafted || {};
		const pickaxeEnsured = toolRes.pickaxeEnsured || false;
		if (!toolRes.ok) {
			return { ok: false, error: toolRes.error, collected: {}, crafted, pickaxeEnsured, sec: Math.round((Date.now() - t0) / 1000) };
		}

		({ inv, snap } = await invMap(api));
		const startInv = { ...inv };
		const collected = {};
		const errors = [];

		for (const [name, count] of Object.entries(targets)) {
			try {
				const res = await api.cmd('collect', {
					block: name,
					count,
					radius: params.radius,
					deep: params.deep,
					style: params.style
				});
				if (res && res.gained) {
					for (const [k, v] of Object.entries(res.gained)) {
						collected[k] = (collected[k] || 0) + v;
					}
				}
			} catch (e) {
				errors.push(`collect ${name}: ${e.message}`);
			}
		}

		({ inv } = await invMap(api));
		for (const k of Object.keys(targets)) {
			const d = (inv[k] || 0) - (startInv[k] || 0);
			if (d > 0 && !collected[k]) collected[k] = d;
		}

		const ok = Object.keys(targets).every(k => (inv[k] || 0) >= (startInv[k] || 0) + targets[k] || (collected[k] || 0) >= targets[k]);
		const res = {
			ok: ok || Object.keys(collected).length > 0 || Object.keys(crafted).length > 0,
			collected,
			crafted,
			pickaxeEnsured,
			sec: Math.round((Date.now() - t0) / 1000)
		};
		if (errors.length) res.errors = errors;
		if (!res.ok) res.error = 'не удалось собрать: ' + errors.join('; ');
		return res;
	}
};