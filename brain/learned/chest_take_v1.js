// версия: первая: chest_open, потом навык тела chest_take; отказ за 2-3 с с причиной
// chest_take — взять из сундука, не тратя 20 с впустую.
// Сначала chest_open проверяет, что мешает (над сундуком блок, муха выше уровня сундука,
// сундук не виден) и ставит муху на уровень сундука боком к нему. Потом навык тела открывает
// контейнер; ждём недолго (open_sec) и, если окно так и не пришло, отдаём причину, а не «таймаут 20000».
// Итог: {ok, chest:[x,y,z], took, item, content} — content = что лежит в сундуке.
const isDry = p => p.dry === true || p.dry === 1 || p.dry === '1' || p.dry === 'true';

// понятная причина вместо «Event windowOpen did not fire within timeout of 20000ms»
function why(reason, chest, fly, extra) {
  const r = String(reason || 'без причины');
  const at = `сундук ${chest.join(' ')}, муха ${fly.join(' ')}`;
  if (/windowOpen|window_open|did not fire/i.test(r))
    return `не открылся ${at}: ${r} — скорее всего муха смотрит не в ту грань или над сундуком блок (проверь survey над ${chest[0]} ${chest[1] + 1} ${chest[2]})`;
  if (/не вижу сундука/i.test(r))
    return `не вижу ${at} — сундук за стеной или чанк не загружен, подойди ближе`;
  if (/в сундуке нет/i.test(r))
    return `${at}: ${r}`;
  return `${at}: ${r}`;
}

module.exports = {
  name: 'chest_take',
  description: 'Взять предмет из сундука: сначала проверяет, что мешает (над сундуком блок / муха выше уровня / сундук не виден), встаёт на уровень сундука и открывает сбоку. При недоступном сундуке — отказ за 2-3 с с понятной причиной, а не ожидание 20 с. Возвращает содержимое сундука.',
  params: {
    item: 'что взять (имя предмета); не задано — только показать содержимое',
    count: 'сколько взять (по умолчанию — всё, что есть)',
    x: 'x сундука (необязательно; иначе — ближайший видимый или известный)',
    y: 'y сундука', z: 'z сундука',
    dry: '1 — только показать, что мешает, ничего не открывая',
    open_sec: 'сколько ждать окно сундука, по умолчанию 6 (максимум 15)'
  },
  async run(api, params) {
    let prep;
    try {
      prep = await api.skill('chest_open', { x: params.x, y: params.y, z: params.z });
    } catch (e) {
      return { ok: false, error: 'не смогла подготовиться к сундуку: ' + e.message.slice(0, 200) };
    }
    if (!prep || prep.ok === false) return { ok: false, error: 'chest_open не сработал: ' + String((prep && prep.error) || 'без причины').slice(0, 200) };
    const chest = prep.chest;
    const fly = prep.fly || [];
    if (!chest) return { ok: false, error: prep.blocker || 'сундук не найден', fly, blocker: prep.blocker || 'сундук не найден' };
    if (prep.blocker) return { ok: false, error: prep.blocker, chest, fly, blocker: prep.blocker, faces: prep.faces };
    if (isDry(params)) return { ok: true, dry: true, chest, fly, faces: prep.faces, note: 'сундук доступен, открывать не буду' };

    // --- открыть контейнер навыком тела, но ждать недолго ---
    const body = { x: chest[0], y: chest[1], z: chest[2] };
    if (params.item) body.item = String(params.item);
    if (params.count != null && params.count !== '') body.count = Number(params.count);
    let started;
    try { started = await api.start('chest_take', body); }
    catch (e) { return { ok: false, error: `не открыла сундук ${chest.join(' ')}: ${e.message.slice(0, 200)}`, chest, fly }; }

    const limit = Math.min(Math.max(Number(params.open_sec) || 6, 2), 15);
    const deadline = Date.now() + limit * 1000;
    let ev = null;
    while (Date.now() < deadline) {
      let list = { events: [] };
      try { list = await api.events(0, 200); } catch (e) { api.log('events: ' + e.message.slice(0, 80)); }
      const events = (list && list.events) || [];
      ev = events.find(e => e.taskId === started.taskId && (e.type === 'task_done' || e.type === 'task_failed' || e.type === 'task_aborted'));
      if (ev) break;
      await api.sleep(250);
    }
    if (!ev) {
      try { await api.stop(); } catch (e) {}
      return {
        ok: false,
        error: `сундук ${chest.join(' ')} не открылся за ${limit} с (муха ${fly.join(' ')}) — скорее всего смотрит не в ту грань или над сундуком блок: проверь блок над ${chest[0]} ${chest[1] + 1} ${chest[2]}`,
        chest, fly, timeoutSec: limit
      };
    }
    if (ev.type === 'task_done') {
      const r = ev.result || {};
      return { ok: true, chest: r.chest || chest, took: r.took || 0, item: r.item || null, content: r.content || {}, fly, face: prep.face };
    }
    const res = ev.result || {};
    const content = res.content || null;
    return { ok: false, error: why(ev.reason, chest, fly), chest, fly, reason: String(ev.reason || ''), ...(content ? { content } : {}) };
  }
};
