// lamp_posts — фонарные столбы вдоль линии (x1,z1)→(x2,z2) с шагом every.
// Каждый столб ставится готовым чертежом тела build_blueprint (по умолчанию fence_post_lamp).
// Перед стройкой считается точная смета по каждой клетке; не хватает блоков — ничего не строит.
const DEFAULT_BLUEPRINT = 'fence_post_lamp';
const truthy = v => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const short = m => String(m || '').replace(/^навык тела "[^"]+" не удался: /, '').slice(0, 160);

function lineCells(x1, z1, x2, z2, every) {
  const dx = x2 - x1, dz = z2 - z1;
  const n = Math.max(Math.abs(dx), Math.abs(dz));
  if (!n) return [[x1, z1]];
  const out = [], seen = new Set();
  for (let i = 0; i <= n; i += every) {
    const x = Math.round(x1 + dx * i / n);
    const z = Math.round(z1 + dz * i / n);
    const k = x + ',' + z;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([x, z]);
  }
  return out;
}

function invMap(inv) {
  const m = {};
  for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}

function addNeed(total, need) {
  for (const [k, n] of Object.entries(need || {})) {
    const v = Number(n);
    if (v > 0) total[k] = (total[k] || 0) + v;
  }
}

function missingOf(need, have) {
  const missing = {};
  for (const [k, n] of Object.entries(need)) {
    const lack = n - (have[k] || 0);
    if (lack > 0) missing[k] = lack;
  }
  return missing;
}

function pickHave(need, have) {
  const out = {};
  for (const k of Object.keys(need)) out[k] = have[k] || 0;
  return out;
}

function todoOf(plan) {
  const t = (plan && plan.todo) || {};
  const counts = ['place', 'replace', 'badprops', 'cut'].reduce((s, k) => s + (Number(t[k]) || 0), 0);
  return counts + (Number(plan && plan.unloaded) || 0);
}

module.exports = {
  name: 'lamp_posts',
  description: 'Фонарные столбы вдоль линии (x1,z1)→(x2,z2) с шагом every: каждый столб — build_blueprint (по умолчанию fence_post_lamp, 5 блоков). Сначала точная смета; не хватает блоков — не начинает (missing). dry=1 — только смета.',
  params: {
    x1: 'начало линии, x', z1: 'начало линии, z',
    x2: 'конец линии, x', z2: 'конец линии, z',
    every: 'шаг между столбами в клетках, по умолчанию 1',
    y: 'высота основания столба (слой 0 чертежа), по умолчанию 68',
    name: 'имя чертежа, по умолчанию fence_post_lamp',
    dry: '1 — ничего не строить, вернуть posts/need/have/missing',
    max_sec: 'потолок времени, по умолчанию 600'
  },
  async run(api, params) {
    params = params || {};
    const x1 = Math.round(num(params.x1, NaN));
    const z1 = Math.round(num(params.z1, NaN));
    const x2 = Math.round(num(params.x2, NaN));
    const z2 = Math.round(num(params.z2, NaN));
    if (![x1, z1, x2, z2].every(Number.isFinite)) return { ok: false, error: 'нужны числа x1, z1, x2, z2' };

    const y = Math.round(num(params.y, 68));
    const every = Math.max(1, Math.min(64, Math.floor(num(params.every, 1))));
    const name = String(params.name || DEFAULT_BLUEPRINT).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return { ok: false, error: `плохое имя чертежа «${name}»` };
    const dry = truthy(params.dry);
    const maxSec = Math.max(30, Math.min(1800, num(params.max_sec, 600)));
    const deadline = Date.now() + maxSec * 1000;

    const cells = lineCells(x1, z1, x2, z2, every);
    if (cells.length > 256) return { ok: false, error: `слишком длинная линия: ${cells.length} столбов (максимум 256)` };

    const snap = await api.snapshot();
    const have = invMap(snap.inventory);
    const need = {};
    const plans = [];
    let todo = 0;
    for (const [x, z] of cells) {
      let d;
      try {
        d = await api.cmd('build_blueprint', { name, x, y, z, rot: 0, dry: 1 });
      } catch (e) {
        return { ok: false, error: `смета столба ${x} ${y} ${z}: ${short(e.message)}`, posts: cells.length };
      }
      plans.push({ x, z, d });
      addNeed(need, d && d.need);
      if (todoOf(d && d.plan) > 0) todo++;
    }
    const missing = missingOf(need, have);
    const total = Object.values(need).reduce((s, n) => s + n, 0);

    if (dry) {
      return {
        ok: true, dry: true,
        posts: cells.length, todo,
        at: cells.map(([x, z]) => [x, y, z]),
        need, have: pickHave(need, have), missing, total,
        enough: !Object.keys(missing).length
      };
    }
    if (Object.keys(missing).length) {
      const msg = 'не хватает блоков: ' + Object.entries(missing).map(([k, n]) => `${k} ×${n}`).join(', ');
      return {
        ok: false, error: msg, missing,
        need, have: pickHave(need, have),
        posts: cells.length, at: cells.map(([x, z]) => [x, y, z])
      };
    }

    const at = [];
    const failed = [];
    for (let i = 0; i < cells.length; i++) {
      const [x, z] = cells[i];
      if (Date.now() >= deadline) {
        failed.push([x, y, z, 'время max_sec вышло']);
        continue;
      }
      if (todoOf(plans[i] && plans[i].d && plans[i].d.plan) === 0) {
        at.push([x, y, z]);
        continue;
      }
      try {
        const r = await api.cmd('build_blueprint', { name, x, y, z, rot: 0 });
        if (r && r.ok === false) {
          failed.push([x, y, z, short(r.error || 'ok:false')]);
          continue;
        }
        if (r && r.total != null && r.matched != null && r.matched < r.total) {
          failed.push([x, y, z, `собрано ${r.matched}/${r.total}`]);
          continue;
        }
        at.push([x, y, z]);
        api.log(`lamp_posts: столб ${i + 1}/${cells.length} ${x} ${y} ${z}`);
      } catch (e) {
        const res = e && e.result;
        failed.push([x, y, z, short((res && res.error) || e.message)]);
      }
    }

    if (failed.length) {
      return {
        ok: false,
        error: `поставлено ${at.length} из ${cells.length}; провалов ${failed.length}`,
        posts: at.length, at, failed
      };
    }
    return { ok: true, posts: at.length, at, failed: [] };
  }
};
