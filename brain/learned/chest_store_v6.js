// версия: как текущая chest_store (22.10), но зовёт chest_open_v6: по заданным координатам без сундука он сам ищет ближайший известный контейнер и кладёт в него (в ответе subst), отказ один на факт, а при полном неуспехе известен known (список контейнеров из памяти тела); по заявке учителя (случай 20261022-111057-77, урок L053)
// chest_store — положить вещи в сундук: коротко и честно, без 20-секундного «Event windowOpen…».
// Как chest_take: сначала chest_open_v6 готовит муху и говорит, что мешает (блок над сундуком,
// сбоку занято, муха не на уровне сундука, в руке блок); если по заданным координатам сундука нет —
// ищет ближайший известный контейнер сам. Помеха — отказ сразу. Иначе — навык тела chest_store
// с ТОЧНЫМИ координатами найденного контейнера, ждём недолго (open_sec).
// Успех: {ok:true, chest:[x,y,z], stored:{имя:n}, fly, held, above} (или subst, если открыт не тот контейнер, что в заявке).
// Отказ: {ok:false, error:'…', known?} — один отказ на один факт о мире.
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

// короткое описание мира вокруг сундука — чтобы мозг не гадал, что мешает
function world(prep) {
  const f = (prep && prep.faces) || {};
  const s = f.sides || {};
  const sides = Object.keys(s).map(k => `${k}:${s[k]}`).join(' ');
  const chest = (prep && prep.chest) || [];
  const fly = (prep && prep.fly) || [];
  return `сундук ${chest.join(' ')}, муха ${fly.join(' ')}, над сундуком ${f.above || prep.above || '?'}, сбоку ${sides || '?'}, в руке ${(prep && prep.held) || 'пусто'}`;
}

module.exports = {
  name: 'chest_store',
  description: 'Положить вещи в сундук: сначала проверяет, что мешает (над сундуком блок / сбоку занято / муха не на уровне / в руке блок), встаёт на уровень сундука и открывает его сбоку. Если по заданным координатам сундука нет — сам ищет и кладёт в ближайший известный контейнер (subst в ответе). На недоступном сундуке — один отказ за 2-3 с с причиной о мире и как найти сундук (known). Возвращает, что положили.',
  params: {
    items: 'что положить: "all" (всё, кроме инструментов, брони и еды) или список имён ["dirt","cobblestone"]',
    count: 'сколько положить (по умолчанию — всё, что есть)',
    x: 'x сундука (необязательно; иначе — видимый или известный)',
    y: 'y сундука', z: 'z сундука',
    search: '1 (по умолчанию) — по координатам сундука нет? ищем ближайший известный контейнер сами; 0 — не искать, отказ сразу',
    dig_above: '0 — не копать; 1 (по умолчанию) — выкопать мягкий блок над сундуком (земля/снег/листа); 2 — выкопать любой блок над сундуком (кроме контейнера)',
    hand: 'auto (по умолчанию) — взять в руку не-блок; toss — если не-блока нет, выбросить блок из руки; skip — руку не трогать',
    walk_sec: 'сколько секунд идти к сундуку, по умолчанию 20',
    open_sec: 'сколько ждать окно сундука, по умолчанию 5 (минимум 2, максимум 20)',
    dry: '1 — только показать, что мешает, ничего не открывая'
  },
  async run(api, params) {
    const log = m => { try { api.log(m); } catch (e) {} };
    const dry = isDry(params);

    // --- 1. подготовка: где сундук, что мешает (ищет и подменяет сам — см. chest_open_v6) ---
    let prep = null;
    try {
      prep = await api.skill('chest_open_v6', {
        x: params.x, y: params.y, z: params.z,
        search: params.search,
        dig_above: dry ? 0 : params.dig_above,
        hand: dry ? 'skip' : params.hand,
        walk_sec: params.walk_sec
      });
    } catch (e) {
      return { ok: false, error: 'chest_open_v6 не отработал: ' + String(e.message).slice(0, 200) };
    }
    if (!prep || prep.ok === false) {
      return { ok: false, error: 'chest_open_v6: ' + String((prep && prep.error) || 'без причины').slice(0, 200) };
    }
    const chest = prep.chest;
    const fly = prep.fly || [];
    if (!chest) {
      // один отказ: где сундук, что помню о контейнерах (known), что делать
      return {
        ok: false, error: String(prep.blocker || 'сундук не найден'), fly,
        ...(prep.known ? { known: prep.known } : {}), blocker: prep.blocker || 'сундук не найден'
      };
    }
    if (prep.blocker) {
      return { ok: false, error: prep.blocker, chest, fly, blocker: prep.blocker, faces: prep.faces, above: prep.above, held: prep.held };
    }
    if (dry) {
      return { ok: true, dry: true, chest, fly, subst: prep.subst || null, faces: prep.faces, above: prep.above, held: prep.held, note: prep.subst ? `клали бы в ближайший известный контейнер (см. subst): ${prep.note}` : 'сундук доступен, открывать не буду' };
    }

    // --- 2. положить через навык тела (точные координаты!) и ждать недолго ---
    const body = { x: chest[0], y: chest[1], z: chest[2] };
    const items = params.items === 'all' || params.items === undefined || params.items === null || params.items === ''
      ? 'all'
      : (Array.isArray(params.items) ? params.items : [String(params.items)]);
    body.items = items;
    if (params.count != null && params.count !== '' && Number(params.count) > 0) body.count = Number(params.count);
    let cursor = 0;
    try { const l = await api.events(0, 1); cursor = (l && l.lastId) || 0; } catch (e) {}
    let started = null;
    try {
      if (typeof api.start === 'function') started = await api.start('chest_store', body);
      else {
        // api.start нет (офлайн-проверка без фоновых задач) — кладём синхронно и берём итог сразу
        const r = await api.cmd('chest_store', body);
        const st = (r && r.stored) || {};
        return { ok: true, chest: (r && r.chest) || chest, stored: st, fly, held: prep.held, above: prep.above, ...(prep.subst ? { subst: prep.subst } : {}) };
      }
    }
    catch (e) {
      return { ok: false, error: `сундук ${chest.join(' ')} не открылся: ${String(e.message).slice(0, 180)} (${world(prep)})`, chest, fly, above: prep.above, held: prep.held };
    }
    if (!started || !started.taskId) {
      const why = (started && (started.error || started.hint)) || 'навык встал в очередь, а не пошёл';
      return { ok: false, error: `сундук ${chest.join(' ')} не открываю: тело занято (${why}) (${world(prep)})`, chest, fly, above: prep.above, held: prep.held };
    }

    const limit = Math.min(Math.max(Number(params.open_sec) || 5, 2), 20);
    const deadline = Date.now() + limit * 1000;
    let ev = null;
    while (Date.now() < deadline) {
      let list = { events: [] };
      try { list = await api.events(cursor, 60); } catch (e) { log('events: ' + String(e.message).slice(0, 80)); }
      const events = (list && list.events) || [];
      ev = events.find(x => x.taskId === started.taskId && (x.type === 'task_done' || x.type === 'task_failed' || x.type === 'task_aborted'));
      if (ev) break;
      await api.sleep(200);
    }
    if (!ev) {
      try { await api.stop(); } catch (e) {}
      return {
        ok: false,
        error: `сундук ${chest.join(' ')} не открылся за ${limit} с — сервер не открыл окно (${world(prep)}); проверь блок над сундуком и ту грань, с которой смотрит муха`,
        chest, fly, above: prep.above, held: prep.held, timeoutSec: limit
      };
    }
    if (ev.type === 'task_done') {
      const r = ev.result || {};
      return {
        ok: true, chest: r.chest || chest, stored: r.stored || {},
        fly, held: prep.held, above: prep.above,
        ...(prep.subst ? { subst: prep.subst } : {})
      };
    }
    const reason = String(ev.reason || 'без причины');
    return {
      ok: false, error: `сундук ${chest.join(' ')}: ${reason} (${world(prep)})`,
      chest, fly, reason, above: prep.above, held: prep.held
    };
  }
};
