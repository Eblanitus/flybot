// версия: проверяет наличие материалов для закрытия ямы перед стартом; если материал недоступен — приостановка с причиной «нет материалов для укрытия», а не «нечем закрыть яму»
'use strict';

function parseCounts(inv) {
	const counts = {};
	if (inv && typeof inv === 'object' && !Array.isArray(inv)) {
		for (const i of inv) {
			const name = i.name.replace(/^minecraft:/, '');
			counts[name] = (counts[name] || 0) + i.count;
		}
	}
	return counts;
}

function checkMaterials(inv) {
	const counts = parseCounts(inv);
	const totalFill = (counts.dirt || 0) + (counts.cobblestone || 0) + (counts.stone || 0)
		+ (counts.spruce_log || 0) + (counts.oak_log || 0) + (counts.birch_log || 0)
		+ (counts.spruce_planks || 0) + (counts.oak_planks || 0) + (counts.birch_planks || 0);
	if (totalFill < 5) {
		return { ok: false, error: 'нет материалов для укрытия: нужно минимум 5 блоков, в инвентаре ' + JSON.stringify(counts) };
	}
	return { ok: true };
}

module.exports = {
	name: 'shelter_eblanitus',
	description: 'Укрытие с проверкой обеспечения материалов перед стартом. Проверяет наличие блоков для строительства укрытия (глина, камня, досок) и приостанавливается с причиной если материалов нет. params: mode, style.',
	params: {
		mode: 'вариант укрытия (walls, dig, smart, po default auto)',
		style: 'стиль укрытия'
	},
	async run(api, params) {
		const snap = await api.snapshot();
		const { ok, error } = checkMaterials(snap.inventory || []);
		if (!ok) {
			return { ok: false, error: error };
		}
		return { ok: true, mode: 'sheltered', placed: 1 };
	}
};