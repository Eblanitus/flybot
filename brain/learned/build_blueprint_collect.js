// версия: новый навык по заявке build_blueprint_variants: build_blueprint с автоматическим сбором ресурсов в радиусе 48 блоков перед стройкой
'use strict';

const path = require('path');

module.exports = {
  name: 'build_blueprint_collect',
  description: 'Строит по чертежу с предварительным сбором нехватающих материалов. Сначала делает dry-запуск build_blueprint, чтобы узнать need/missing, затем вызывает gather_list (или collect) для добычи недостающего в радиусе 48 блоков, потом запускает build_blueprint. Если ресурсы не собрать — ставит стройку на паузу и уходит к базе за ресурсами.',
  params: {
    blueprint: 'имя чертежа (по умолчанию hut_west)',
    x: 'x северо-западного нижнего угла постройки',
    y: 'y верхнего блока пола (на котором стоят внутри)',
    z: 'z северо-западного нижнего угла постройки',
    rot: 'поворот чертежа: 0|90|180|270 (по умолчанию 0)',
    radius: 'радиус сбора ресурсов, по умолчанию 48',
    max_sec: 'лимит времени на всё, по умолчанию 1200',
    dry: '1 — только план (dry build_blueprint + план сбора), ничего не делать',
    pause_on_low_hp: '1 — при HP<12 и мобах рядом делать паузу перед сбором/стройкой (по умолчанию 1)',
    min_hp: 'минимальный HP для продолжения, по умолчанию 12',
    base_x: 'x базы для пополнения ресурсов (если сбор не удался)',
    base_y: 'y базы',
    base_z: 'z базы'
  },
  async run(api, params) {
    try {
      return await runInner(api, params);
    } catch (e) {
      const why = String(e && e.message ? e.message : e);
      return { ok: false, error: 'build_blueprint_collect crash: ' + why };
    }
  }
};

function invMap(inv) {
  const m = {};
  for (const i of (inv || [])) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}

async function runInner(api, params) {
  const pr = params || {};
  const bpName = String(pr.blueprint || 'hut_west').trim();
  const x = Math.round(Number(pr.x));
  const z = Math.round(Number(pr.z));
  const y = Math.round(Number(pr.y));
  const rot = Math.round(Number(pr.rot) || 0);
  const radius = Math.round(Number(pr.radius) || 48);
  const maxSec = Math.min(Math.max(Number(pr.max_sec) || 1200, 30), 1800);
  const dry = Boolean(pr.dry);
  const pauseOnLowHp = pr.pause_on_low_hp !== 0 && pr.pause_on_low_hp !== false && pr.pause_on_low_hp !== '0' && pr.pause_on_low_hp !== 'false';
  const minHp = Math.round(Number(pr.min_hp) || 12);
  const baseX = pr.base_x !== undefined ? Math.round(Number(pr.base_x)) : null;
  const baseY = pr.base_y !== undefined ? Math.round(Number(pr.base_y)) : null;
  const baseZ = pr.base_z !== undefined ? Math.round(Number(pr.base_z)) : null;

  if (![x, y, z].every(Number.isFinite)) {
    return { ok: false, error: 'нужны x, y, z (северо-западный нижний угол постройки)' };
  }

  // 1) Dry run build_blueprint to get need/missing
  api.log(`build_blueprint_collect: dry run ${bpName} at ${x},${y},${z} rot=${rot}`);
  let dryResult;
  try {
    dryResult = await api.cmd('buildblueprint', { name: bpName, x, y, z, rot, dry: true });
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes('нет чертежа')) {
      return { ok: false, error: `нет чертежа ${bpName}`, dry: true };
    }
    return { ok: false, error: 'dry build_blueprint failed: ' + msg };
  }

  if (dry) {
    // Just return the plan with collection plan
    const need = dryResult.need || {};
    const have = dryResult.have || {};
    const missing = dryResult.missing || {};
    const plan = dryResult.plan || {};
    return {
      ok: true,
      dry: true,
      blueprint: bpName,
      at: [x, y, z],
      rot,
      need,
      have,
      missing,
      plan,
      collect_plan: Object.keys(missing).length ? `собрать: ${Object.entries(missing).map(([k, n]) => `${k}×${n}`).join(', ')}` : 'всё есть',
      radius,
      max_sec: maxSec
    };
  }

  // 2) Check HP and threats before collecting/building
  const snap = await api.snapshot();
  const hp = snap.health || 20;
  const threats = (snap.eyes && snap.eyes.threats) || [];
  const mobsNear = threats.some(t => t.d !== null && t.d <= 16);

  if (pauseOnLowHp && hp < minHp && mobsNear) {
    api.log(`HP ${hp} < ${minHp} и мобы рядом — пауза`);
    // Wait a bit for threats to clear or HP to regen
    await api.sleep(5000);
    const snap2 = await api.snapshot();
    const hp2 = snap2.health || 20;
    const threats2 = (snap2.eyes && snap2.eyes.threats) || [];
    const mobsNear2 = threats2.some(t => t.d !== null && t.d <= 16);
    if (hp2 < minHp && mobsNear2) {
      return { ok: false, error: `HP ${hp2} < ${minHp} и мобы всё ещё рядом — отказ`, hp: hp2, paused: true };
    }
    api.log(`продолжаем: HP ${hp2}`);
  }

  // 3) Collect missing materials
  const missing = dryResult.missing || {};
  if (Object.keys(missing).length > 0) {
    api.log(`build_blueprint_collect: не хватает ${JSON.stringify(missing)}, собираю...`);
    
    // Convert missing to gather_list format
    const itemsStr = Object.entries(missing).map(([k, n]) => `${k}:${n}`).join(',');
    
    // Try to gather with gather_list (which handles crafting too)
    let gatherResult;
    try {
      gatherResult = await api.skill('gather_list', {
        items: itemsStr,
        max_sec: Math.min(maxSec, 600),
        dry: false
      });
    } catch (e) {
      api.log(`gather_list failed: ${e.message || e}, пробую collect напрямую`);
      // Fallback: try collect for each missing item
      gatherResult = { ok: false, collected: {}, missing: { ...missing } };
      for (const [item, count] of Object.entries(missing)) {
        if (gatherResult.ok) break;
        try {
          api.log(`collect ${item} x${count} radius=${radius}`);
          await api.cmd('collect', { block: item, count, radius });
          gatherResult.collected[item] = (gatherResult.collected[item] || 0) + count;
          gatherResult.ok = true;
        } catch (e2) {
          api.log(`collect ${item} failed: ${e2.message || e2}`);
        }
      }
    }

    api.log(`gather result: ok=${gatherResult.ok}, collected=${JSON.stringify(gatherResult.collected)}, missing=${JSON.stringify(gatherResult.missing)}`);

    // If still missing and base coordinates provided, go to base
    if (Object.keys(gatherResult.missing || {}).length > 0 && baseX !== null && baseY !== null && baseZ !== null) {
      api.log(`всё ещё не хватает: ${JSON.stringify(gatherResult.missing)} — иду к базе`);
      try {
        await api.cmd('go_safe', { x: baseX, y: baseY, z: baseZ, step: 24, mob_d: 16, min_hp: minHp });
        // At base, try to take from chest
        try {
          await api.cmd('chest_take', { item: Object.keys(gatherResult.missing)[0], count: Object.values(gatherResult.missing)[0], x: baseX, y: baseY, z: baseZ });
        } catch (e) {
          api.log(`chest_take failed: ${e.message || e}`);
        }
      } catch (e) {
        api.log(`go_safe to base failed: ${e.message || e}`);
      }
    }

    // Final check - if still missing critical materials, fail
    const finalMissing = gatherResult.missing || {};
    const criticalMissing = Object.entries(finalMissing).filter(([k, n]) => n > 0 && (dryResult.need || {})[k]);
    if (criticalMissing.length > 0) {
      return {
        ok: false,
        error: 'не удалось собрать все материалы',
        missing: finalMissing,
        need: dryResult.need,
        collected: gatherResult.collected,
        at_base: baseX !== null,
        paused: true
      };
    }
  }

  // 4) Run actual build_blueprint
  api.log(`build_blueprint_collect: запуск build_blueprint ${bpName}`);
  try {
    const buildResult = await api.cmd('buildblueprint', { name: bpName, x, y, z, rot, dry: false });
    return { ok: true, ...buildResult, collected: gatherResult?.collected || {} };
  } catch (e) {
    const msg = e.message || String(e);
    // build_blueprint throws SkillError with result in e.result
    const result = e.result || {};
    return { ok: false, error: msg, ...result, collected: gatherResult?.collected || {} };
  }
}