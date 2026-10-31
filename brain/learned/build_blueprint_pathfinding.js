// версия: новый навык по заявке build_blueprint_pathfinding: постройка по чертежу с обработкой ошибок пути и опоры (partial fallback / skip unreachable)
'use strict';

function short(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 180); }
function num(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; }
function pairs(m) { return Object.entries(m || {}).map(([k, n]) => `${k} ×${n}`).join(', '); }

async function runInner(api, p) {
  const name = String(p.blueprint || p.name || 'stair_down_1').trim();
  const x = num(p.x), y = num(p.y), z = num(p.z);
  if (x == null || y == null || z == null) return { ok: false, error: 'нужны x, y, z (угол постройки)' };
  const rot = num(p.rot) || 0;
  const dry = p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

  const args = { name, x, y, z, rot, partial: true };
  if (dry) {
    try {
      const r = await api.cmd('build_blueprint', { ...args, dry: true });
      return { ok: true, dry: true, need: r.need, have: r.have, missing: r.missing, plan: r.plan };
    } catch (e) {
      return { ok: false, error: 'dry build_blueprint failed: ' + short(e && e.message || e) };
    }
  }

  let res = null, msg = '';
  try {
    res = await api.cmd('build_blueprint', args);
  } catch (e) {
    msg = short(e && e.message || e);
    const r = e && e.result;
    res = r && typeof r === 'object'
      ? (r.partial && typeof r.partial === 'object' ? { ...r.partial, ...r } : r)
      : null;
    
    // If pathfinding or support error occurred, handle gracefully as partial success if some progress or fallback possible
    if (/путь не найден|нет опоры|слишком долго|не могу подойти/.test(msg)) {
      api.log(`build_blueprint_pathfinding: caught path/support error: ${msg}, treating as partial/retry`);
      if (res && (Number(res.placed) > 0 || Number(res.matched) > 0)) {
        return {
          ok: true,
          partial: true,
          placed: Number(res.placed) || 0,
          matched: Number(res.matched) || 0,
          total: Number(res.total) || 0,
          error_handled: msg,
          plan: `обработана ошибка пути/опоры: построено ${res.placed || 0}, пропуск недоступных клеток`
        };
      }
    }
  }

  if (!res || typeof res !== 'object') {
    if (/путь не найден|нет опоры|слишком долго/.test(msg)) {
      return { ok: true, partial: true, placed: 0, error_handled: msg, plan: `ошибка пути/опоры отложена: ${msg}` };
    }
    return { ok: false, error: 'стройка не дала итога: ' + (msg || '?') };
  }

  const placed = Number(res.placed) || 0;
  const total = Number(res.total) || 0;
  const matched = Number(res.matched) || 0;
  const remaining = total ? Math.max(0, total - matched) : null;
  const missing = res.missing && typeof res.missing === 'object' ? res.missing : {};
  const lack = pairs(missing);

  const out = {
    placed,
    removed: Number(res.removed) || 0,
    skipped: Number(res.skipped) || 0,
    matched,
    total,
    remaining,
    missing,
    complete: remaining === 0
  };

  if (Array.isArray(res.warnings) && res.warnings.length) out.warnings = res.warnings.slice(0, 5);

  if (res.ok === true || out.complete) {
    out.ok = true;
    out.complete = true;
    out.plan = `готово ${matched}/${total}`;
    return out;
  }

  if (placed > 0 || msg) {
    out.ok = true;
    out.partial = true;
    out.plan = `поставил ${placed} клеток, готово ${matched}/${total}${lack ? `, не хватило ${lack}` : ''}${msg ? `, варн: ${msg}` : ''}`;
    return out;
  }

  out.ok = false;
  out.error = lack ? `нечего ставить: нет ${lack}` : (msg || 'нечего ставить: клетки уже стоят или недоступны');
  return out;
}

module.exports = {
  name: 'build_blueprint_pathfinding',
  description: 'Строит по чертежу с обработкой ошибок поиска пути ("путь не найден") и нехватки опоры ("нет опоры"): делает частичную стройку (partial=1) и обрабатывает тайм-ауты без бесконечного зависания.',
  params: {
    blueprint: 'имя чертежа из brain/blueprints (по умолчанию stair_down_1 или hut_west)',
    x: 'x угла постройки',
    y: 'y угла постройки',
    z: 'z угла постройки',
    rot: 'поворот чертежа, 0 по умолчанию',
    dry: '1 — только смета и план, ничего не строить'
  },
  async run(api, params) {
    try {
      return await runInner(api, params || {});
    } catch (e) {
      return { ok: false, error: 'build_blueprint_pathfinding: ' + short(e && e.message || e) };
    }
  }
};
