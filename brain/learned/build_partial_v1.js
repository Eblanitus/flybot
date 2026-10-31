// версия: 30.10 по заявке behavior_autopilot_build_step — частичная стройка шагом: ставит то, что есть в сумке,
// пол/стены раньше крыши; возвращает placed/missing, чтобы автопилот добрал ровно шаг, а не весь список 101.
// build_partial — обёртка над телом build_blueprint(partial=1): ядро уже умеет строить частью (клетка без предмета
// уходит в lack, остальные ставятся). Не хватило и поставить нечего — ok:false «нечего ставить: нет …», а не
// «стройка не удалась». params: blueprint|name (hut_west), x, y, z, rot=0; dry=1 — только план и нехватка.
// Возвращает {ok, placed, removed, skipped, matched, total, remaining, missing, complete, warnings}
// или при нехватке {ok:true, partial:true, placed>0, missing, remaining} — стройка продолжится следующим шагом.

function short(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 180); }
function num(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; }
function pairs(m) { return Object.entries(m || {}).map(([k, n]) => `${k} ×${n}`).join(', '); }

async function buildPart(api, p) {
  const name = String(p.blueprint || p.name || 'hut_west').trim();
  const x = num(p.x), y = num(p.y), z = num(p.z);
  if (x == null || y == null || z == null) return { ok: false, error: 'нужны x, y, z (угол постройки)' };
  const rot = num(p.rot) || 0;
  const dry = p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';
  const args = { name, x, y, z, rot, partial: true };
  if (dry) {
    const r = await api.cmd('build_blueprint', { ...args, dry: true });
    return { ok: true, dry: true, need: r.need, have: r.have, missing: r.missing, plan: r.plan };
  }
  let res = null, msg = '';
  try {
    res = await api.cmd('build_blueprint', args);
  } catch (e) {
    msg = short(e && e.message || e);
    const r = e && e.result;
    // у частичного провала итог в e.result; у «нет пути» — {ok:false, partial: res} (частичный итог внутри)
    res = r && typeof r === 'object'
      ? (r.partial && typeof r.partial === 'object' ? { ...r.partial, ...r } : r)
      : null;
  }
  if (!res || typeof res !== 'object') return { ok: false, error: 'стройка не дала итога: ' + (msg || '?') };
  const placed = Number(res.placed) || 0;
  const total = Number(res.total) || 0;
  const matched = Number(res.matched) || 0;
  const remaining = total ? Math.max(0, total - matched) : null;
  const missing = res.missing && typeof res.missing === 'object' ? res.missing : {};
  const lack = pairs(missing);
  const out = {
    placed, removed: Number(res.removed) || 0, skipped: Number(res.skipped) || 0,
    matched, total, remaining, missing, complete: remaining === 0
  };
  if (Array.isArray(res.warnings) && res.warnings.length) out.warnings = res.warnings.slice(0, 5);
  if (res.ok === true || out.complete) {
    out.ok = true; out.complete = true;
    out.plan = `готово ${matched}/${total}`;
    return out;
  }
  if (placed > 0) {
    out.ok = true; out.partial = true;
    out.plan = `поставил ${placed} клеток, готово ${matched}/${total}${lack ? `, не хватило ${lack}` : ''}`;
    return out;
  }
  out.ok = false;
  out.error = lack ? `нечего ставить: нет ${lack}` : (msg || 'нечего ставить: клетки уже стоят или не подошли');
  return out;
}

module.exports = {
  name: 'build_partial',
  description: 'Достроить постройку частью: ставит всё, на что есть материал (пол/стены раньше крыши), недостающие клетки называет в missing и возвращает placed/matched/total/remaining. Это шаг: автопилот добирает по missing ровно шаг и зовёт снова. params: blueprint (hut_west), x, y, z, rot; dry=1 — только план.',
  params: {
    blueprint: 'имя чертежа из brain/blueprints (по умолчанию hut_west)',
    x: 'x угла постройки', y: 'y угла постройки', z: 'z угла постройки',
    rot: 'поворот чертежа, 0 по умолчанию',
    dry: '1 — только план и нехватка, ничего не строить'
  },
  async run(api, params) {
    try {
      return await buildPart(api, params || {});
    } catch (e) {
      return { ok: false, error: 'build_partial: ' + short(e && e.message || e) };
    }
  }
};
