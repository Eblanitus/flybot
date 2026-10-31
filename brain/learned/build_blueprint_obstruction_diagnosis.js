// версия: исправление — разделение ошибок инвентаря и позиционирования при сбое build_blueprint
'use strict';

function short(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 180); }
function num(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; }

module.exports = {
  name: 'build_blueprint_obstruction_diagnosis',
  description: 'Строит по чертежу (build_blueprint) с диагностикой сбоев: разделяет реальную нехватку материалов в инвентаре от позиционных и опорных ошибок (нет опоры, временная подпорка, путь не найден). Если материал есть в инвентаре, при сбое не отправляет на добор (gather_list), а возвращает позиционную проблему.',
  params: {
    blueprint: 'имя чертежа из brain/blueprints (по умолчанию hut_west)',
    x: 'x северо-западного угла постройки',
    y: 'y угла постройки',
    z: 'z угла постройки',
    rot: 'поворот чертежа, 0 по умолчанию',
    dry: '1 — только смета'
  },
  async run(api, params) {
    try {
      return await runInner(api, params || {});
    } catch (e) {
      return { ok: false, error: 'build_blueprint_obstruction_diagnosis: ' + short(e && e.message || e) };
    }
  }
};

async function runInner(api, params) {
  const name = String(params.blueprint || params.name || 'hut_west').trim();
  const x = num(params.x), y = num(params.y), z = num(params.z);
  if (x == null || y == null || z == null) {
    return { ok: false, error: 'нужны x, y, z (угол постройки)' };
  }
  const rot = num(params.rot) || 0;
  const dry = params.dry === true || params.dry === 1 || params.dry === '1' || params.dry === 'true';

  const args = { name, x, y, z, rot };
  if (dry) {
    const r = await api.cmd('build_blueprint', { ...args, dry: true });
    return { ok: true, dry: true, ...r };
  }

  let res = null;
  let errMessage = '';
  let failResult = null;

  try {
    res = await api.cmd('build_blueprint', args);
  } catch (e) {
    errMessage = e.message || String(e);
    failResult = e.result || null;
    res = failResult;
  }

  // Get inventory snapshot
  const snap = await api.snapshot();
  const inv = (snap && snap.inventory) || [];
  const invMap = {};
  for (const item of inv) {
    invMap[item.name] = (invMap[item.name] || 0) + item.count;
  }

  if (res && res.ok) {
    return { ok: true, ...res };
  }

  const missing = (res && res.missing) || {};
  const failedList = (res && res.failed) || [];
  
  let hasPositioningError = false;
  const positioningReasons = /опор|подпорк|путь|не могу подойти|занято|scaffold|support|path/i;

  for (const f of failedList) {
    if (f && f.why && positioningReasons.test(f.why)) {
      hasPositioningError = true;
    }
  }

  if (positioningReasons.test(errMessage)) {
    hasPositioningError = true;
  }

  const realMissing = {};
  let itemsInInventoryCount = 0;

  for (const [item, count] of Object.entries(missing)) {
    const haveCount = invMap[item] || 0;
    if (haveCount > 0) {
      itemsInInventoryCount++;
      hasPositioningError = true;
    } else {
      realMissing[item] = count;
    }
  }

  if (hasPositioningError && itemsInInventoryCount > 0) {
    const errStr = `позиционная/архитектурная проблема постройки (опора/путь/подпорка при наличии материалов в инвентаре): ${errMessage || (failedList[0] && failedList[0].why) || 'сбой размещения'}`;
    return {
      ok: false,
      error: errStr,
      obstruction: true,
      positional: true,
      missing: {},
      have: invMap,
      failed: failedList.slice(0, 20)
    };
  }

  return {
    ok: false,
    error: errMessage || (res && res.error) || 'провал постройки',
    missing: realMissing,
    have: invMap,
    failed: failedList.slice(0, 20)
  };
}
