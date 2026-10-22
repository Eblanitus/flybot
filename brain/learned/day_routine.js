// версия: была текущей на 22.10; как v5, но если брёвен собрала мало — всё равно крафтит кирку из того, что есть
// day_routine — дневное развитие без мозга (5–10 мин): дерево → деревянная кирка → булыжник → каменные кирка и меч →
// печь → уголь → железо → плавка → железные кирка/меч/броня; пока железа нет — медь: плавка → медные кирка и броня (железо потом заменит); еда — охота и жарка, если есть нечего.
// Уголь, железо и медь — только увиденные (честное зрение); не видно — одна вылазка explore и снова.
// Выходит сам: скоро ночь, мало HP, max_sec, или делать больше нечего. Уже готовое пропускает.
//
// ПРАВКА УЧИТЕЛЯ (случай 20261022-044830, урок L032 — тот же дефект, что в gather_wood, L008/L009):
//   1) СБОР — МАЛЫМ РАДИУСОМ. Тело по умолчанию ищет в радиусе 48 м: муха уходила от базы через обрыв и падала
//      (18:48 — сбор брёвен без радиуса → collect → смерть «падение» с 68 на 32 у края каньона).
//      Теперь collect всегда с radius 8..12 и только рядом: брёвна — сначала доходим до известного места
//      (точка леса: params wood_x/y/z или то, что тело знает — «лес» в памяти/снимке), потом собираем рядом;
//      уголь/железо/медь — только если видны/известны ВНУТРИ радиуса, иначе отказ (тело само ушло бы искать по всей окрестности).
//   2) КРАЙ — ДО СБОРА. Снимок называет «обрыв» (1–2 м) или survey (edges) нашёл край рядом → сбор НЕ начинаем:
//      отказ с причиной («край в 6 м З — сбор не начинаю»). База стоит на краю каньона — сбор рядом с ней всегда риск.
//   3) СМЕРТЬ — НЕ «НЕ НАШЁЛ». Муха погибла во время шага → навык останавливается с отказом «муха погибла»
//      и НЕ идёт к следующему шагу (раньше после смерти шёл «шаг: explore за деревом»).
//   4) Порядок шагов, плавка и крафт не тронуты — это работает.
const PICK_ANY = /^(wooden|stone|golden|copper|iron|diamond|netherite)_pickaxe$/;
const PICK_STONE = /^(stone|copper|iron|diamond|netherite)_pickaxe$/;
const AXE_ANY = /_axe$/;
const SWORD_STONE = /^(stone|iron|diamond|netherite)_sword$/;
const PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/;
const SWORD_IRON = /^(iron|diamond|netherite)_sword$/;
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
const FOOD_OK = /^(cooked_|bread$|baked_potato$|carrot$|apple$|golden_carrot$|melon_slice$|sweet_berries$|potato$|beetroot$|pumpkin_pie$|cookie$|mushroom_stew$|rabbit_stew$|beetroot_soup$|dried_kelp$)/;
// железная броня: [предмет, слитков, слот брони — чем ещё может быть занят]
const ARMOR = [['iron_chestplate', 8, /_chestplate$/], ['iron_helmet', 5, /_helmet$/], ['iron_leggings', 7, /_leggings$/], ['iron_boots', 4, /_boots$/]];
const BETTER_ARMOR = /^(iron|diamond|netherite)_/;
// медь (пока нет железа): кирка 3 слитка + броня, дёшево вперёд; медное или лучше уже есть — пропуск
const PICK_COPPER = /^(copper|iron|diamond|netherite)_pickaxe$/;
const COPPER_ARMOR = [['copper_boots', 4, /_boots$/], ['copper_helmet', 5, /_helmet$/], ['copper_leggings', 7, /_leggings$/], ['copper_chestplate', 8, /_chestplate$/]];
const COPPER_OR_BETTER = /^(copper|iron|diamond|netherite)_/;

// ---- Правка L032: край, смерть, малый радиус (помощники) ----
const DEATH_RE = /смерт|умер|умерла|погиб|dead|death|fell|упал|падени|респавн/i;
const STONE_LIKE = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff'];
const MAX_SURVEY = 4096;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function cleanMsg(m) { return String(m == null ? '' : m).replace(/^навык тела "[^"]+" не удался:\s*/, '').trim(); }
function isDeath(m) { return DEATH_RE.test(cleanMsg(m)); }
function deathsOf(s) { const d = s && s.stats && Number(s.stats.deaths); return Number.isFinite(d) ? d : 0; }
function d2(a, b) { return Math.hypot(((a && a.x) || 0) - ((b && b.x) || 0), ((a && a.z) || 0) - ((b && b.z) || 0)); }
// направление от мухи к точке: С/Ю/В/З (и диагонали)
function dirTo(dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);
  if (ax < 1 && az < 1) return 'здесь';
  if (ax > az * 2) return dx > 0 ? 'В' : 'З';
  if (az > ax * 2) return dz > 0 ? 'Ю' : 'С';
  return (dz > 0 ? 'Ю' : 'С') + (dx > 0 ? 'В' : 'З');
}
// край в снимке: «обрыв В,З,Ю,С» (соседняя колонка без опоры, 1–2 м рядом)
function cliffDirs(snap) {
  const hz = ((snap && snap.eyes && snap.eyes.hazards) || []).map(String);
  for (const h of hz) {
    const m = /^обрыв\s*(.+)$/.exec(h.trim());
    if (!m) continue;
    const dirs = m[1].replace(/[↑↓\s]/g, '').split('').filter(d => 'СЮЗВ'.indexOf(d) >= 0);
    if (dirs.length) return dirs;
  }
  return null;
}
// survey вокруг мухи (только чтение): края обрыва и что вокруг известно
async function surveyAround(api, snap, r) {
  const rad = clampN(Math.round(r) || 8, 3, 11);
  for (const dy of [4, 3, 2]) {
    if ((2 * rad + 1) * (2 * rad + 1) * (2 * dy + 1) > MAX_SURVEY) continue;
    try {
      const sv = await api.cmd('survey', { radius: rad, dy });
      if (sv && sv.layers) return sv;
    } catch (e) { /* объём не подошёл или сломалось — пробуем ниже */ }
  }
  return null;
}
// ближайший край (обрыв) по survey.edges: {dist, dir, drop, at}
function nearestEdge(sv, snap) {
  if (!sv || !sv.edges || !sv.edges.length) return null;
  const p = (snap && snap.position) || { x: 0, z: 0 };
  let best = null;
  for (const e of sv.edges) {
    const dx = e.x - p.x, dz = e.z - p.z;
    const d = Math.hypot(dx, dz);
    if (!best || d < best.dist) best = { dist: Math.round(d), dir: dirTo(dx, dz), drop: e.drop, at: [e.x, e.y, e.z], dirs: e.dirs };
  }
  return best;
}
// есть ли такой блок ВИДИМО/ИЗВЕСТНО рядом с мухой (по survey) — чтобы звать collect без «бродяжьей охоты»
function blockNear(sv, snap, r, names) {
  if (!sv || !sv.layers) return false;
  const legend = sv.legend || {};
  const codes = new Set();
  for (const n of names) for (const c of Object.keys(legend)) if (legend[c] === n) codes.add(c);
  if (!codes.size) return false;
  const p = (snap && snap.position) || { x: 0, z: 0 };
  for (const key of Object.keys(sv.layers)) {
    const rows = sv.layers[key];
    for (let dz = 0; dz < rows.length; dz++) {
      if (Math.abs((sv.origin.z + dz) - p.z) > r) continue;
      const row = rows[dz];
      for (let dx = 0; dx < row.length; dx++) {
        if (Math.abs((sv.origin.x + dx) - p.x) > r) continue;
        if (codes.has(row[dx])) return true;
      }
    }
  }
  return false;
}
// известное место для брёвен: params → «лес» из памяти → ближайшее известное бревно из снимка
function woodSpot(snap, params) {
  const px = Number(params.wood_x), py = Number(params.wood_y), pz = Number(params.wood_z);
  if (Number.isFinite(px) && Number.isFinite(pz)) {
    return { x: px, y: Number.isFinite(py) ? py : null, z: pz, from: 'params' };
  }
  const mem = String((snap && snap.memory) || '');
  const m = /лес\s+(\d+)\s*м\s+([СЮЗВ]+)[↑↓]?\s+(-?\d+),(-?\d+),(-?\d+)/.exec(mem);
  if (m) return { x: +m[3], y: +m[4], z: +m[5], from: `память (лес ${m[1]} м ${m[2]})` };
  const b = snap && snap.eyes && snap.eyes.blocks && snap.eyes.blocks.log;
  if (b && Array.isArray(b.at) && b.at.length === 3) return { x: b.at[0], y: b.at[1], z: b.at[2], from: `снимок (бревно ${b.d} м ${b.dir || ''})` };
  return null;
}
// расстояние до ближайшего известного бревна (снимок); null — брёвен не знаем
function logDist(snap) {
  const b = snap && snap.eyes && snap.eyes.blocks && snap.eyes.blocks.log;
  const d = b && Number(b.d);
  return Number.isFinite(d) ? d : null;
}
// место добычи камня/руды (params) — если задано, идём туда перед сбором
function mineSpot(params) {
  const x = Number(params.mine_x), y = Number(params.mine_y), z = Number(params.mine_z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, y: Number.isFinite(y) ? y : null, z };
}

module.exports = {
  name: 'day_routine',
  description: 'Днём без мозга 5–10 мин: дерево → деревянная кирка → булыжник ×20 → каменные кирка/меч → печь → уголь, железо и медь (только видимые, иначе explore) → плавка → железные кирка/меч/броня (пока железа нет — медные кирка и броня); если голоден и нечего есть — охота и жарка. Пропускает готовое. Сбор — только малым радиусом 8–12 м и только рядом с известным местом (брёвна — сначала до точки леса); рядом край (снимок «обрыв» или survey edges) — отказ «край … — сбор не начинаю», а не бродяжья охота; смерть мухи — отказ «муха погибла» и конец работы. Сам выходит: скоро ночь (night_soon), HP<8, max_sec или делать нечего.',
  params: {
    max_sec: 'потолок по времени, по умолчанию 600',
    stone: 'сколько булыжника держать, по умолчанию 20',
    radius: 'радиус сбора вокруг текущей точки, м (8..12), по умолчанию 10; больше нельзя — широкий радиус тела (48) уводит муху через обрыв',
    edge_d: 'на каком расстоянии край запрещает сбор, м (6..16), по умолчанию 10',
    wood_x: 'x точки леса для брёвен (по умолчанию — известное дерево из снимка/памяти)',
    wood_y: 'y точки леса (необязательно)',
    wood_z: 'z точки леса для брёвен',
    mine_x: 'x места добычи камня и руды (необязательно; по умолчанию — добыча на месте)',
    mine_y: 'y места добычи (необязательно)',
    mine_z: 'z места добычи камня и руды (необязательно)'
  },
  async run(api, params) {
    const maxSec = Number(params.max_sec) > 0 ? Number(params.max_sec) : 600;
    const stoneWant = Number(params.stone) > 0 ? Number(params.stone) : 20;
    const radius = clampN(num(params.radius, 10), 8, 12);   // Л032: радиус тела 48 уводил муху через обрыв
    const edgeD = clampN(num(params.edge_d, 10), 6, 16);   // на каком расстоянии край запрещает сбор
    const deadline = Date.now() + maxSec * 1000;
    const did = [], skipped = [], blocked = [];
    let snap = await api.snapshot();
    const inv0 = invMap(snap.inventory);
    let explores = 0;
    let dead = false;
    const o = { deaths0: deathsOf(snap), radius, edgeD, deadline };
    // смерть мухи — конец работы: бросаем наружу, чтобы НЕ пойти к следующему шагу
    const deathStop = () => { const e = new Error('муха погибла'); e.__death = true; throw e; };

    const refresh = async () => { snap = await api.snapshot(); return invMap(snap.inventory); };
    const stopReason = () => {
      const t = (snap.eyes && snap.eyes.time) || {};
      if (t.phase === 'ночь' || (typeof t.nightIn === 'number' && t.nightIn > 0 && t.nightIn < 60) || t.phase === 'закат') return 'night_soon: скоро ночь';
      if (typeof snap.health === 'number' && snap.health < 8) return 'мало HP';
      if (Date.now() > deadline) return 'вышло время max_sec';
      return null;
    };
    const finish = async (reason, err) => {
      let gained = {};
      try { const m = await refresh(); for (const n of Object.keys(m)) { const d = m[n] - (inv0[n] || 0); if (d > 0) gained[n] = d; } } catch (e) {}
      api.log(`day_routine: ${reason}; сделано: ${did.join(', ') || 'ничего'}`);
      if (dead) return { ok: false, error: 'муха погибла', did, skipped, blocked, gained, reason: 'муха погибла' };
      if (err) return { ok: false, error: String(err), did, skipped, blocked, gained, reason };
      return { ok: true, did, skipped, blocked, gained, reason };
    };
    // шаг: ok -> true; отказ -> false (в skipped); смерть -> стоп «муха погибла» (дальше не идём)
    const step = async (title, action, p) => {
      if (dead) return false;
      api.log('шаг: ' + title);
      try { await api.cmd(action, p); did.push(title); }
      catch (e) {
        const msg = cleanMsg(e.message);
        if (isDeath(msg)) { dead = true; api.log(`${title}: муха погибла (${msg})`); deathStop(); }
        skipped.push(`${title}: ${msg.slice(0, 120)}`);
        api.log(`${title}: ${msg}`);
        return false;
      }
      // муха могла погибнуть внутри шага (падение) — счётчик смертей это покажет
      const s2 = await api.snapshot();
      if (deathsOf(s2) > o.deaths0) { dead = true; api.log(`${title}: муха погибла`); deathStop(); }
      return true;
    };

    // СБОР (Л032): малым радиусом, только рядом с целью, и не тогда, когда рядом край
    const collectSafe = async (title, block, count, opts) => {
      opts = opts || {};
      if (dead) return { ok: false, error: 'муха погибла' };
      const s = await api.snapshot();
      if (deathsOf(s) > o.deaths0) { dead = true; deathStop(); }
      // 1) край совсем рядом (снимок называет «обрыв» 1–2 м) — не начинаем
      const dirs = cliffDirs(s);
      if (dirs) {
        const err = `край в 1-2 м ${dirs.join(',')} — сбор не начинаю`;
        api.log(`${title}: ${err}`);
        return { ok: false, error: err, blocked: true };
      }
      // 2) край по survey (edges) — с цифрами: сколько вниз и где
      const sv = await surveyAround(api, s, edgeD);
      const e = nearestEdge(sv, s);
      if (e && e.dist <= edgeD) {
        const err = `край в ${e.dist} м ${e.dir} (перепад ${e.drop} м) — сбор не начинаю`;
        api.log(`${title}: ${err}`);
        return { ok: false, error: err, blocked: true };
      }
      // 3) цель должна быть известна ВНУТРИ радиуса: иначе тело само уйдёт искать (и сорвётся с обрыва)
      if (block === 'log') {
        const ld = logDist(s);
        if (ld == null || ld > radius) {
          const err = `бревно в ${ld == null ? '?' : ld} м (радиус ${radius} м) — сбор не начинаю`;
          api.log(`${title}: ${err}`);
          return { ok: false, error: err, blocked: true };
        }
      }
      if (opts.far) {
        const msg = opts.far(s);
        if (msg) { api.log(`${title}: ${msg}`); return { ok: false, error: msg, blocked: true }; }
      }
      // 4) камень: если рядом не видно камня — тело пойдёт копать вслепую; при крае рядом — не начинаем
      if (opts.needLocal && e && !blockNear(sv, s, radius, STONE_LIKE)) {
        const err = `камня рядом не видно, а край в ${e.dist} м ${e.dir} — сбор не начинаю`;
        api.log(`${title}: ${err}`);
        return { ok: false, error: err, blocked: true };
      }
      try {
        const res = await api.cmd('collect', { block, count: Math.max(1, Math.round(count)), radius });
        api.log(`${title}: ${JSON.stringify(res || {}).slice(0, 120)}`);
        did.push(title);
      } catch (e) {
        const msg = cleanMsg(e.message);
        if (isDeath(msg)) { dead = true; api.log(`${title}: муха погибла (${msg})`); deathStop(); }
        skipped.push(`${title}: ${msg.slice(0, 120)}`);
        api.log(`${title}: ${msg}`);
        return { ok: false, error: msg };
      }
      const s2 = await api.snapshot();
      if (deathsOf(s2) > o.deaths0) { dead = true; api.log(`${title}: муха погибла`); deathStop(); }
      return { ok: true };
    };

    // БРЁВНА (Л032): сначала доходим до известного места (лес), потом собираем рядом малым радиусом
    const gatherWood = async (need) => {
      let s = await api.snapshot();
      if (deathsOf(s) > o.deaths0) { dead = true; deathStop(); }
      const here = logDist(s);
      if (here != null && here <= radius) return collectSafe('бревна', 'log', need);
      const spot = woodSpot(s, params);
      if (!spot) return { ok: false, error: 'лес неизвестен (в снимке нет брёвен) — некуда идти за древесиной' };
      api.log(`иду за брёвнами к лесу ${spot.x} ${spot.y} ${spot.z} (${spot.from}), отсюда ${Math.round(d2(s.position, spot))} м`);
      const trip = await goTo(spot);
      if (!trip.ok) return trip;
      s = await api.snapshot();
      const d1 = logDist(s);
      if (d1 != null && d1 <= radius) return collectSafe('бревна', 'log', need);
      // брёвен рядом не видно — короткий осмотр (не широкий поиск по склону)
      if (explores++ < 2 && await safeExplore('осмотр рядом с лесом', 16)) {
        s = await api.snapshot();
        const d3 = logDist(s);
        if (d3 != null && d3 <= radius) return collectSafe('бревна', 'log', need);
      }
      return { ok: false, error: `брёвна рядом не видно (радиус ${radius} м) — сбор не начинаю` };
    };

    // дорога до известного места: go_safe сам смотрит край, мобов и смерть
    const goTo = async (spot) => {
      const s = await api.snapshot();
      if (deathsOf(s) > o.deaths0) { dead = true; deathStop(); }
      if (d2(s.position, spot) <= 6) return { ok: true };
      const left = Math.max(20, Math.min(240, Math.floor((o.deadline - Date.now()) / 1000) - 15));
      const gp = { x: spot.x, z: spot.z, step: 10, max_sec: left, night_wait: 0 };
      if (spot.y != null && Number.isFinite(Number(spot.y))) gp.y = Number(spot.y);
      try {
        const r = await api.skill('go_safe', gp);
        if (r && r.ok === false) {
          const err = String(r.error || 'не дошла');
          if (/погибла|респавн/i.test(err)) { dead = true; deathStop(); }
          return { ok: false, error: 'к лесу не дошла: ' + err };
        }
        return { ok: true };
      } catch (e) {
        const msg = cleanMsg(e.message);
        if (isDeath(msg)) { dead = true; deathStop(); }
        return { ok: false, error: 'к лесу не дошла: ' + msg };
      }
    };

    // короткий осмотр: только если рядом нет края (иначе — к обрыву)
    const safeExplore = async (title, distance) => {
      if (dead) return false;
      const s = await api.snapshot();
      if (deathsOf(s) > o.deaths0) { dead = true; deathStop(); }
      const dirs = cliffDirs(s);
      const sv = dirs ? null : await surveyAround(api, s, edgeD);
      const e = nearestEdge(sv, s);
      if (dirs || (e && e.dist <= edgeD)) {
        api.log(`${title}: край рядом (${dirs ? dirs.join(',') + ' 1-2 м' : e.dist + ' м ' + e.dir}) — не иду искать вслепую`);
        return false;
      }
      return step(title, 'explore', { distance });
    };

    const has = (m, re) => Object.keys(m).some(n => re.test(n) && m[n] > 0);
    const sum = (m, re) => Object.keys(m).filter(n => re.test(n)).reduce((s, n) => s + m[n], 0);

    try {
      // смерть мухи внутри шага выбрасывает нас из цикла (deathStop) — к следующему шагу не идём
    for (let pass = 0; pass < 12; pass++) {
      let m = await refresh();
      let r = stopReason(); if (r) return finish(r);
      let progress = false;

      // еда: голоден и нечего есть — охота, потом жарка
      if ((typeof snap.food === 'number' ? snap.food : 20) < 14 && !Object.keys(m).some(n => FOOD_OK.test(n))) {
        const animals = ((snap.eyes && snap.eyes.animals) || []).filter(a => /cow|pig|sheep|chicken|rabbit|mooshroom|goat/.test(a.name));
        if (animals.length && await step('охота', 'hunt', { count: 2 })) progress = true;
        m = await refresh();
      }
      const raw = RAW_MEAT.find(n => m[n] > 0);
      if (raw && has(m, /^(coal|charcoal)$|_planks$|_log$/) && await step('жарка ' + raw, 'smelt', { item: 'cooked_' + raw, count: Math.min(m[raw], 8) })) { progress = true; m = await refresh(); }

      // 1. дерево и деревянная кирка
      if (!has(m, PICK_ANY)) {
        const wood = sum(m, /_(log|stem)$/) + Math.floor(sum(m, /_planks$/) / 4);
        if (wood < 8) {
          // Л032: сначала до известного места (лес), потом сбор рядом малым радиусом; край — отказ
          const res = await gatherWood(8 - wood);
          const m2 = await refresh();
          const wood2 = sum(m2, /_(log|stem)$/) + Math.floor(sum(m2, /_planks$/) / 4);
          // частично собрали — кирку всё равно скрафтим (на 3 доски хватает одного бревна)
          if (!res.ok && wood2 < 2) return finish('не собрала брёвна: ' + res.error, 'не собрала брёвна: ' + res.error);
          m = m2;
        }
        if (!(await step('деревянная кирка', 'craft', { item: 'wooden_pickaxe' }))) return finish('не скрафтила деревянную кирку');
        progress = true; m = await refresh();
      }
      if ((r = stopReason())) return finish(r);

      // 1б. место добычи камня и руды: если задано в params — идём туда (край/мобы/смерть смотрит go_safe)
      const pl = mineSpot(params);
      let placeOk = true;
      if (pl) {
        const tr = await goTo(pl);
        if (!tr.ok) { placeOk = false; blocked.push('место добычи: ' + tr.error); }
      }

      // 2. булыжник, каменные кирка и меч, печь
      const needPick = !has(m, PICK_STONE), needSword = !has(m, SWORD_STONE), needFurnace = !m.furnace;
      const cobble = sum(m, /^(cobblestone|cobbled_deepslate)$/);
      const want = Math.max(stoneWant, (needPick ? 3 : 0) + (needSword ? 2 : 0) + (needFurnace ? 8 : 0) + 9);
      if (placeOk && cobble < want && (needPick || needSword || needFurnace || cobble < 10)) {
        const res = await collectSafe('булыжник', 'stone', Math.min(want - cobble, 24), { needLocal: true });
        if (res.ok) progress = true; else if (res.blocked) blocked.push('булыжник: ' + res.error);
        m = await refresh();
      }
      if (needPick && await step('каменная кирка', 'craft', { item: 'stone_pickaxe' })) progress = true;
      if (needSword && await step('каменный меч', 'craft', { item: 'stone_sword' })) progress = true;
      m = await refresh();
      if (!has(m, AXE_ANY) && sum(m, /^(cobblestone|cobbled_deepslate|blackstone)$/) >= 3 && await step('каменный топор', 'craft', { item: 'stone_axe' })) progress = true;
      m = await refresh();
      if (!m.furnace && sum(m, /^(cobblestone|cobbled_deepslate)$/) >= 8 && await step('печь', 'craft', { item: 'furnace' })) progress = true;
      if ((r = stopReason())) return finish(r);
      m = await refresh();

      // 3. сколько железа нужно на недостающее железное
      let ingotsNeed = 0;
      const wantIron = [];
      if (!has(m, PICK_IRON)) { ingotsNeed += 3; wantIron.push(['iron_pickaxe', 3]); }
      if (!has(m, SWORD_IRON)) { ingotsNeed += 2; wantIron.push(['iron_sword', 2]); }
      const worn = new Set(snap.armor || []);
      for (const [item, n, slot] of ARMOR) {
        const already = [...worn, ...Object.keys(m)].some(x => slot.test(x) && BETTER_ARMOR.test(x));
        if (!already) { ingotsNeed += n; wantIron.push([item, n]); }
      }
      const ingots = m.iron_ingot || 0, rawIron = m.raw_iron || 0;
      const ironShort = Math.max(0, ingotsNeed - ingots - rawIron);

      // медь, пока нет железной кирки: что ещё не сделано и сколько слитков нужно
      const cuWant = has(m, PICK_IRON) ? [] : copperWant(m, snap.armor);
      const cuNeed = cuWant.reduce((s, [, n]) => s + n, 0);

      // 4. уголь (видимый) — на плавку
      const coal = (m.coal || 0) + (m.charcoal || 0);
      const visible = k => !!(snap.eyes && snap.eyes.blocks && snap.eyes.blocks[k]);
      const seen = k => (snap.eyes && snap.eyes.blocks && snap.eyes.blocks[k]) || null;
      const tooFar = (name, b) => (b && Number(b.d) > radius ? `${name} в ${b.d} м (радиус ${radius} м) — сбор не начинаю` : null);
      const coalB = seen('coal_ore');
      if (placeOk && has(m, PICK_ANY) && coal < 8 && (ironShort > 0 || rawIron > 0 || cuNeed > 0 || coal < 4) && coalB) {
        const res = await collectSafe('уголь', 'coal', 8 - coal, { far: () => tooFar('уголь', coalB) });
        if (res.ok) progress = true; else if (res.blocked) blocked.push('уголь: ' + res.error);
        m = await refresh();
      }
      // 5. железо (видимое; нужна каменная кирка)
      m = await refresh();
      const ironB = seen('iron_ore');
      if (placeOk && has(m, PICK_STONE) && ironShort > 0 && ironB) {
        const res = await collectSafe('железо', 'iron', Math.min(ironShort, 10), { far: () => tooFar('железо', ironB) });
        if (res.ok) progress = true; else if (res.blocked) blocked.push('железо: ' + res.error);
        m = await refresh();
      }
      if ((r = stopReason())) return finish(r);

      // 6. плавка железа
      m = await refresh();
      if ((m.raw_iron || 0) > 0 && has(m, /^(coal|charcoal)$|_planks$|_log$/)) {
        if (await step('плавка железа', 'smelt', { item: 'iron_ingot', count: Math.min(m.raw_iron, 16) })) progress = true;
        m = await refresh();
      }
      // 7. железные кирка, меч, броня — пока хватает слитков
      // железный топор — самый низкий приоритет: только после брони, из лишних слитков
      const spare = (m.iron_ingot || 0) + (m.raw_iron || 0) - ingotsNeed;
      if (!has(m, /^(iron|diamond|netherite)_axe$/) && wantIron.length === 0 && spare >= 3) wantIron.push(['iron_axe', 3]);
      for (const [item, n] of wantIron) {
        m = await refresh();
        if ((m.iron_ingot || 0) < n) continue;
        if (await step(item, 'craft', { item })) progress = true;
      }
      // 8. медь — только пока нет железной кирки; железо приоритетнее (видимое железо при каменной кирке берём вместо меди)
      m = await refresh();
      if (!has(m, PICK_IRON)) {
        const cu = copperWant(m, snap.armor), need = cu.reduce((s, [, n]) => s + n, 0);
        const short = Math.max(0, need - (m.copper_ingot || 0) - (m.raw_copper || 0));
        const cuB = seen('copper_ore');
        if (placeOk && short > 0 && cuB && !(has(m, PICK_STONE) && visible('iron_ore') && ironShort > 0)) {
          const res = await collectSafe('медь', 'copper', Math.min(short, 8), { far: () => tooFar('медь', cuB) });
          if (res.ok) progress = true; else if (res.blocked) blocked.push('медь: ' + res.error);
          m = await refresh();
        }
        const toSmelt = Math.min(m.raw_copper || 0, Math.max(0, need - (m.copper_ingot || 0)));
        if (toSmelt > 0 && has(m, /^(coal|charcoal)$|_planks$|_log$/)) {
          if (await step('плавка меди', 'smelt', { item: 'copper_ingot', count: toSmelt })) progress = true;
          m = await refresh();
        }
        for (const [item, n] of cu) {
          if ((m.copper_ingot || 0) < n) continue;
          if (await step(item, 'craft', { item })) { progress = true; m = await refresh(); }
        }
      }
      if (did.some(d => /^(iron|copper)_/.test(d))) { try { await api.cmd('equip_best', { for: 'fight' }); } catch (e) {} }
      if ((r = stopReason())) return finish(r);

      m = await refresh();
      const ironDone = has(m, PICK_IRON) && has(m, SWORD_IRON) && ARMOR.every(([, , slot]) => [...(snap.armor || []), ...Object.keys(m)].some(x => slot.test(x) && BETTER_ARMOR.test(x)));
      if (ironDone) return finish('железное снаряжение готово');
      if (!progress) {
        // сбор запрещён краем — честно говорим почему, а не «делать нечего»
        if (blocked.length) return finish('сбор не начался: ' + blocked[0], blocked[0]);
        // руды не видно — одна короткая вылазка (не широкий поиск), потом снова; не больше 4 за запуск
        if (explores >= 4) return finish('делать нечего: руды не видно после вылазок');
        explores++;
        if (!(await safeExplore('explore за рудой', 16))) {
          if (blocked.length) return finish('сбор не начался: ' + blocked[0], blocked[0]);
          return finish('explore не удался');
        }
      }
    }
    return finish('исчерпан лимит проходов', blocked.length ? 'сбор не начался: ' + blocked[0] : null);
    } catch (e) {
      if (e && e.__death) return finish('муха погибла', 'муха погибла');
      throw e;
    }
  }
};

// недостающее медное: [предмет, слитков] — кирка, потом броня от дешёвого к дорогому; железная/медная замена уже есть — пропуск
function copperWant(m, worn) {
  const have = [...(worn || []), ...Object.keys(m)];
  const out = [];
  if (!Object.keys(m).some(n => PICK_COPPER.test(n) && m[n] > 0)) out.push(['copper_pickaxe', 3]);
  for (const [item, n, slot] of COPPER_ARMOR) if (!have.some(x => slot.test(x) && COPPER_OR_BETTER.test(x))) out.push([item, n]);
  return out;
}

function invMap(inv) {
  const m = {};
  for (const i of inv || []) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}
