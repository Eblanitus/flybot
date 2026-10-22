// версия: первая: перебежки по 24 блока, смотрит только врагов-игроков (escape)
// go_safe — дойти до точки перебежками (по step блоков), между ними смотреть на врагов-игроков (eyes.threats).
// Враг ближе 24 м — escape и снова в путь; 3 бегства или 3 неудачных перехода — провал.
module.exports = {
  name: 'go_safe',
  description: 'Дойти до x,z (y необязательно) перебежками по step блоков (24); между перебежками проверяет врагов-игроков (eyes.threats, d<=24) и убегает (escape). Провал после 3 бегств или 3 неудачных переходов.',
  params: { x: 'цель x', z: 'цель z', y: 'цель y (необязательно)', step: 'длина перебежки, по умолчанию 24' },
  async run(api, params) {
    const tx = Number(params.x), tz = Number(params.z), ty = Number(params.y);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) throw new Error('нужны x и z');
    const step = Number(params.step) > 4 ? Math.min(Number(params.step), 64) : 24;
    let escapes = 0, fails = 0, hops = 0;
    for (let i = 0; i < 200; i++) {
      const snap = await api.snapshot();
      const p = snap.position;
      const th = ((snap.eyes && snap.eyes.threats) || []).find(t => t.d <= 24);
      if (th) {
        if (++escapes > 3) throw new Error(`враг ${th.name} не отстаёт (${th.d} м) — 3 бегства`);
        api.log(`враг ${th.name} ${th.d} м ${th.dir} — убегаю`);
        try { await api.cmd('escape', {}); } catch (e) { api.log('escape: ' + e.message); }
        continue;
      }
      const dx = tx - p.x, dz = tz - p.z, dist = Math.hypot(dx, dz);
      if (dist <= 2 && (!Number.isFinite(ty) || Math.abs(ty - p.y) <= 2)) return { ok: true, at: [p.x, p.y, p.z], hops, escapes };
      const k = dist > step ? step / dist : 1;
      const goal = { x: Math.round(p.x + dx * k), z: Math.round(p.z + dz * k), timeout: 60 };
      if (k === 1 && Number.isFinite(ty)) goal.y = ty;
      try { await api.cmd('goto', goal); hops++; fails = 0; }
      catch (e) { if (++fails >= 3) throw new Error(`не дошла: ${e.message}`); api.log(`goto: ${e.message}`); }
    }
    throw new Error('слишком много перебежек');
  }
};
