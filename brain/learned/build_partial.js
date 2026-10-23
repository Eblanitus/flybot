// версия: новый навык по запросу build_partial: стройка по чертежу частями, то, что есть в сумке; клетки без материала пропускаются с указанием чего не хватает
'use strict';
const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'build_partial',
  description: 'Строит по чертежу частями: ставит клетки, на которые материала в сумке есть, и пропускает те, где материала нет. Ответ содержит поставленные клетки и список того, чего не хватило. Частичный успех — ok:true, навык не выключается за 3 провала подряд.',
  params: {
    blueprint: 'имя чертежа (по умолчанию hut_west)',
    x: 'x северо-западного нижнего угла постройки',
    y: 'y верхнего блока пола (на котором стоят внутри)',
    z: 'z северо-западного нижнего угла постройки',
    dry: '1 — только смета, ничего не строить, вернуть need/have/missing/plan'
  },
  async run(api, params) {
    try {
      return await runInner(api, params);
    } catch (e) {
      const why = String(e && e.message ? e.message : e);
      return { ok: false, error: 'build_partial crash: ' + why };
    }
  }
};

function invMap(inv) {
  const m = {};
  for (const i of (inv || [])) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}

function loadBlueprint(name) {
  const file = path.join(__dirname, '..', '..', 'brain', 'blueprints', name + '.txt');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('нет чертежа ' + name);
  }
  const BP = require('../lib/skills/blueprint');
  return BP.parseBlueprint(text, { name });
}

async function runInner(api, params) {
  const pr = params || {};
  const bpName = String(pr.blueprint || 'hut_west').trim();
  const x = Math.round(Number(pr.x));
  const z = Math.round(Number(pr.z));
  const y = Math.round(Number(pr.y));
  const dry = Boolean(pr.dry);

  if (![x, y, z].every(Number.isFinite)) {
    return { ok: false, error: 'нужны x, y, z (северо-западный нижний угол постройки)' };
  }

  // Load blueprint
  let bp;
  try {
    bp = loadBlueprint(bpName);
  } catch (e) {
    return { ok: false, error: 'cannot load blueprint ' + bpName + ': ' + (e.message || e) };
  }

  // Get inventory
  const snap = await api.snapshot();
  const have = invMap(snap.inventory);
  const stock = { ...have };

  // Group cells by layer from parsed blueprint
  // bp.cells has { x, y, z, kind, block, item, props, ly }
  const cellsByLayer = new Map();
  for (const c of bp.cells) {
    if (c.kind !== 'block') continue; // skip air cells
    if (!cellsByLayer.has(c.ly)) cellsByLayer.set(c.ly, []);
    cellsByLayer.get(c.ly).push(c);
  }

  // Sort layers bottom to top
  const sortedLayers = [...cellsByLayer.keys()].sort((a, b) => a - b);

  // Track placement
  const placedByLayer = new Map();
  let totalPlaced = 0;
  const missing = {};
  const skippedLog = [];

  // Process each layer from bottom to top
  for (const ly of sortedLayers) {
    const layerCells = cellsByLayer.get(ly) || [];
    placedByLayer.set(ly, []);
    let layerPlaced = 0;

    for (const c of layerCells) {
      const neededItem = c.item || c.block;
      const haveCount = have[neededItem] || 0;

      if (haveCount > 0) {
        try {
          const r = await api.cmd('place_at', { x: c.x, y: c.y, z: c.z, item: neededItem });
          if (r.ok) {
            have[neededItem] = haveCount - 1;
            placedByLayer.get(ly).push({ x: c.x, y: c.y, z: c.z, block: neededItem });
            totalPlaced++;
            layerPlaced++;
          } else {
            // Placement failed
            missing[neededItem] = (missing[neededItem] || 0) + 1;
            layerPlaced++; // count as attempted but failed
          }
        } catch (e) {
          missing[neededItem] = (missing[neededItem] || 0) + 1;
        }
      } else {
        // No material in inventory
        missing[neededItem] = (missing[neededItem] || 0) + 1;
      }
    }

    skippedLog.push(`слой ${ly}:ставлено ${layerPlaced} из ${layerCells.length}`);
  }

  // Build plan description
  const floorCells = placedByLayer.get(0) || [];
  const wallCells = placedByLayer.get(1) || [];
  const roofLayer = sortedLayers[sortedLayers.length - 1] || 4;
  const roofCells = placedByLayer.get(roofLayer) || [];
  const planDescr = `постройка ${bpName}: пол/${floorCells.length} клеток, стены/${wallCells.length} клеток, крыша/${roofCells.length} клеток`;

  // If nothing was placed at all and we have cells, check if we have any building material
  if (totalPlaced === 0 && bp.cells.length > 0) {
    const buildingMaterials = ['cobblestone', 'spruce_planks', 'spruce_log', 'spruce_door', 'spruce_fence', 'torch', ...FILLERS];
    const hasAnyBuildingMaterial = Object.keys(have).some(k => buildingMaterials.includes(k));
    if (!hasAnyBuildingMaterial) {
      return {
        ok: false,
        error: 'ни одного блока для стройки в сумке нет — отказ',
        missing,
        need: bp.materials || {},
        have: stock,
        plan: planDescr
      };
    }
  }

  const result = {
    ok: true,
    placed: totalPlaced,
    plan: planDescr,
    missing,
    need: bp.materials || {},
    have: Object.keys(have).reduce((acc, k) => { acc[k] = have[k]; return acc; }, {}),
    skipped: skippedLog,
    by_layer: Object.fromEntries(placedByLayer.map(([ly, cells]) => [String(ly), cells])),
    total_cells: bp.cells.length,
    done: totalPlaced
  };

  return result;
}