// версия: как collect_v1, но с авто-explore при поиске брёвен для кирки и циклом повтора/сменой типа брёвен (spruce/oak/birch/log), чтобы не застревать без кирки; по заявке учителя brain/skill_requests/collect.md
'use strict';

const RECIPES = {
	spruce_planks: { out: 4, ing: { spruce_log: 1 } },
	oak_planks: { out: 4, ing: { oak_log: 1 } },
	birch_planks: { out: 4, ing: { birch_log: 1 } },
	planks: { out: 4, ing: { log: 1 } },
	stick: { out: 4, ing: { spruce_planks: 2 } },
	crafting_table: { out: 1, ing: { spruce_planks: 4 } },
	wooden_pickaxe: { out: 1, ing: { spruce_planks: 3, stick: 2 }, table: true },
	stone_pickaxe: { out: 1, ing: { cobblestone: 3, stick: 2 }, table: true },
};

const ITEMS_NEEDING_PICKAXE = new Set([
	'cobblestone', 'stone', 'coal', 'raw_iron', 'raw_copper', 'raw_gold',
	'diamond', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore',
	'deepslate', 'cobbled_deepslate',
]);

const LOG_TYPES = ['spruce_log', 'oak_log', 'birch_log', 'log'];

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

async function isAnyLogVisible(api, radius = 48) {
	const snap = await api.snapshot();
	const blocks = snap.eyes && snap.eyes.blocks;
	if (!blocks) return false;
	for (const logType of LOG_TYPES) {
		const b = blocks[logType];
		if (b && (b.n > 0 || (Array.isArray(b.at) && b.at.length > 0))) {
			if (b.n > 0) return logType;
			for (const pos of b.at) {
				const d = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
				if (d <= radius) return logType;
			}
		}
	}
	return false;
}

async function ensurePickaxe(api, targets, inv, tableNear, params) {
	let currentInv = { ...inv };
	const crafted = {};

	if (hasPickaxe(currentInv)) {
		return { ok: true, crafted, pickaxeEnsured: false };
	}

	const needsPickaxe = Object.entries(targets).some(([name]) => ITEMS_NEEDING_PICKAXE.has(name));
	if (!needsPickaxe) {
		return { ok: true, crafted, pickaxeEnsured: false };
	}

	let attempts = 0;
	while (!hasPickaxe(currentInv) && attempts < 10) {
		attempts++;
		const logs = LOG_TYPES.reduce((sum, lt) => sum + (currentInv[lt] || 0), 0);
		const planks = (currentInv.spruce_planks || 0) + (currentInv.oak_planks || 0) + (currentInv.birch_planks || 0) + (currentInv.planks || 0);
		const woodUnits = logs + Math.floor(planks / 4);

		if (woodUnits < 3) {
			const needLogs = 3 - woodUnits;
			let visibleLog = await isAnyLogVisible(api, params.radius || 48);
			if (!visibleLog) {
				api.log(`брёвна не видны в радиусе ${params.radius || 48} — запускаем explore для поиска леса`);
				try {
					await api.cmd('explore', { distance: params.radius || 48 });
					const snapData = await invMap(api);
					currentInv = snapData.inv;
					visibleLog = await isAnyLogVisible(api, params.radius || 48);
				} catch (e) {
					api.log(`explore не удался: ${e.message}`);
				}
			}

			const targetLog = visibleLog || 'spruce_log';
			try {
				api.log(`collect ${targetLog} x${needLogs} для крафта кирки (попытка ${attempts})`);
				await api.cmd('collect', { block: targetLog, count: needLogs, radius: params.radius });
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				crafted[targetLog] = (crafted[targetLog] || 0) + needLogs;
			} catch (e) {
				api.log(`не удалось собрать ${targetLog}: ${e.message}, пробуем explore и другой лог`);
				try {
					await api.cmd('explore', { distance: params.radius || 48 });
				} catch (e2) {}
				const snapData = await invMap(api);
				currentInv = snapData.inv;
				continue;
			}
		}

		const totalPlanks = (currentInv.spruce_planks || 0) + (currentInv.oak_planks || 0) + (currentInv.birch_planks || 0) + (currentInv.planks || 0);
		if (totalPlanks < 4) {
			const availableLog = LOG_TYPES.find(lt => (currentInv[lt] || 0) > 0) || 'spruce_log';
			const plankName = availableLog === 'log' ? 'planks' : availableLog.replace('_log', '_planks');
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

	if (!hasPickaxe(currentInv)) {
		return { ok: false, error: 'превышено число попыток крафта кирки (нет материалов или доступа)', crafted, pickaxeEnsured: false };
	}

	return { ok: true, crafted, pickaxeEnsured: true };
}

async function isBlockVisible(api, blockName, radius = 48) {
	const snap = await api.snapshot();
	const blocks = snap.eyes && snap.eyes.blocks && snap.eyes.blocks[blockName];
	if (blocks && blocks.n > 0) return true;
	if (blocks && Array.isArray(blocks.at) && blocks.at.length > 0) {
		for (const pos of blocks.at) {
			const d = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
			if (d <= radius) return true;
		}
	}
	return false;
}

async function collectWithToolEnsure(api, targets, params, tableNear, t0) {
	let { inv, snap } = await invMap(api);
	const startInv = { ...inv };
	const collected = {};
	const crafted = {};
	const errors = [];

	for (const [name, count] of Object.entries(targets)) {
		let remaining = count;
		const needsPickaxe = ITEMS_NEEDING_PICKAXE.has(name);

		if (needsPickaxe) {
			const toolRes = await ensurePickaxe(api, { [name]: remaining }, inv, tableNear, params);
			if (!toolRes.ok) {
				errors.push(`ensure pickaxe for ${name}: ${toolRes.error}`);
				for (const [k, v] of Object.entries(toolRes.crafted || {})) {
					crafted[k] = (crafted[k] || 0) + v;
				}
				inv = { ...inv, ...toolRes.crafted };
				continue;
			}
			for (const [k, v] of Object.entries(toolRes.crafted || {})) {
				crafted[k] = (crafted[k] || 0) + v;
			}
			if (toolRes.pickaxeEnsured) {
				const snapData = await invMap(api);
				inv = snapData.inv;
			}
		}

		if (LOG_TYPES.includes(name) || name === 'log') {
			const visible = await isBlockVisible(api, name, params.radius || 48);
			if (!visible) {
				api.log(`блок ${name} не виден в радиусе ${params.radius || 48} — explore к лесу`);
				try {
					await api.cmd('explore', { distance: params.radius || 48 });
					const snapData = await invMap(api);
					inv = snapData.inv;
				} catch (e) {
					errors.push(`explore для ${name}: ${e.message}`);
					continue;
				}
			}
		}

		try {
			const res = await api.cmd('collect', {
				block: name,
				count: remaining,
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
			const msg = (e.message || e).toLowerCase();
			if (msg.includes('нужен инструмент') || msg.includes('нужна кирка') || msg.includes('no tool') || msg.includes('need pickaxe')) {
				errors.push(`collect ${name}: ${e.message} — fallback to no-tool blocks`);
				const fallbackBlocks = ['spruce_log', 'oak_log', 'birch_log', 'dirt', 'sand'];
				for (const fb of fallbackBlocks) {
					if (fb === name) continue;
					const fbVisible = await isBlockVisible(api, fb, params.radius || 48);
					if (fbVisible) {
						api.log(`пробуем собрать ${fb} вместо ${name}`);
						try {
							const res = await api.cmd('collect', {
								block: fb,
								count: Math.min(remaining, 8),
								radius: params.radius,
								deep: params.deep,
								style: params.style
							});
							if (res && res.gained) {
								for (const [k, v] of Object.entries(res.gained)) {
									collected[k] = (collected[k] || 0) + v;
								}
							}
						} catch (e2) {
							errors.push(`fallback collect ${fb}: ${e2.message}`);
						}
						break;
					}
				}
			} else {
				errors.push(`collect ${name}: ${e.message}`);
			}
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
		sec: Math.round((Date.now() - t0) / 1000)
	};
	if (errors.length) res.errors = errors;
	if (!res.ok) res.error = 'не удалось собрать: ' + errors.join('; ');
	return res;
}

module.exports = {
	name: 'collect',
	description: 'Сбор блока с надежным обеспечением инструмента (автокрафт деревянной кирки с поиском брёвен и explore); fallback на блоки без кирки при неудаче. params: block, count, items, radius, deep, style.',
	params: {
		block: 'имя блока для сбора (напр. cobblestone, stone, spruce_log)',
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

		const result = await collectWithToolEnsure(api, targets, params, tableNear, t0);
		return { ...result, sec: Math.round((Date.now() - t0) / 1000) };
	}
};
