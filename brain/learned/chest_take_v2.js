// версия: переписана: в отказе описание мира (сундук, муха, над сундуком, сбоку, рука); точные координаты сундука телу
// chest_take — взять предмет из сундука: коротко и честно, без 20-секундного «Event windowOpen…».
// Сначала chest_open готовит муху и говорит, что мешает (блок над сундуком, сундук не виден,
// сбоку занято, муха не на уровне сундука, в руке блок). Если помеха — отказ сразу, с миром и позициями.
// Если всё чисто — зовёт навык тела chest_take с ТОЧНЫМИ координатами сундука (тело ищет «ближайший
// запомненный» и может открыть не тот) и ждёт итог недолго (open_sec, по умолчанию 5 с).
// Успех: {ok:true, chest:[x,y,z], took, item, content, fly, held, above}.
// Отказ: {ok:false, error:'…'} — причина о мире (сундук, муха, блок над сундуком, сбоку, рука), а не текст mineflayer.
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
  name: 'chest_take',
  description: 'Взять предмет из сундука: сначала проверяет, что мешает (над сундуком блок / сундук не виден / сбоку занято / муха не на уровне / в руке блок), встаёт на уровень сундука и открывает его сбоку. На недоступном сундуке — отказ за 2-3 с с причиной о мире и позициями, а не ожидание 20 с. Возвращает содержимое сундука.',
  params: {
    item: 'что взять (имя предмета); не задано — только показать содержимое',
    count: 'сколько взять (по умолчанию — всё, что есть)',
    x: 'x сундука (необязательно; иначе — видимый или известный)',
    y: 'y сундука', z: 'z сундука',
    dig_above: '1 (по умолчанию) — выкопать блок над сундуком, если он мешает; 0 — только сообщить',
    hand: 'auto (по умолчанию) — взять в руку не-блок; skip — руку не трогать',
    walk_sec: 'сколько секунд идти к сундуку, по умолчанию 20',
    open_sec: 'сколько ждать окно сундука, по умолчанию 5 (минимум 2, максимум 20)',
    dry: '1 — только показать, что мешает, ничего не открывая'
  },
  async run(api, params) {
    const log = m => { try { api.log(m); } catch (e) {} };
    const dry = isDry(params);

    // --- 1. подготовка: где сундук, что мешает ---
    let prep = null;
    try {
      prep = await api.skill('chest_open', {
        x: params.x, y: params.y, z: params.z,
        dig_above: dry ? 0 : params.dig_above,
        hand: params.hand,
        walk_sec: params.walk_sec
      });
    } catch (e) {
      return { ok: false, error: 'chest_open не отработал: ' + String(e.message).slice(0, 200) };
    }
    if (!prep || prep.ok === false) {
      return { ok: false, error: 'chest_open: ' + String((prep && prep.error) || 'без причины').slice(0, 200) };
    }
    const chest = prep.chest;
    const fly = prep.fly || [];
    if (!chest) {
      const err = String(prep.blocker || 'сундук не найден');
      return { ok: false, error: err, fly, blocker: err };
    }
    if (prep.blocker) {
      return { ok: false, error: prep.blocker, chest, fly, blocker: prep.blocker, faces: prep.faces, above: prep.above, held: prep.held };
    }
    if (dry) {
      return { ok: true, dry: true, chest, fly, faces: prep.faces, above: prep.above, held: prep.held, note: 'сундук доступен, открывать не буду' };
    }

    // --- 2. открыть контейнер навыком тела (точные координаты!) и ждать недолго ---
    const body = { x: chest[0], y: chest[1], z: chest[2] };
    if (params.item) body.item = String(params.item);
    if (params.count != null && params.count !== '') body.count = Number(params.count);
    let cursor = 0;
    try { const l = await api.events(0, 1); cursor = (l && l.lastId) || 0; } catch (e) {}
    let started = null;
    try { started = await api.start('chest_take', body); }
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
        ok: true, chest: r.chest || chest, took: r.took || 0, item: r.item || null,
        content: r.content || {}, fly, held: prep.held, above: prep.above
      };
    }
    const res = ev.result || {};
    const content = res.content || null;
    const reason = String(ev.reason || 'без причины');
    return {
      ok: false, error: `сундук ${chest.join(' ')}: ${reason} (${world(prep)})`,
      chest, fly, reason, above: prep.above, held: prep.held,
      ...(content ? { content } : {})
    };
  }
};
