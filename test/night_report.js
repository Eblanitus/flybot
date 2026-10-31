// Офлайн-проверка tools/night_report.js на маленьких фикстурах во временной папке: смерти по причинам, блоки/вырубка, простой,
// топ провалов, доля fled:false, убийства мозга, лимиты учителя; «нет данных» там, где данных нет; отчёт ничего не пишет.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../tools/night_report');

const pad = n => String(n).padStart(2, '0');
const localStamp = ms => { const d = new Date(ms); return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`; };

module.exports = async () => {
  // чистые функции
  assert.strictEqual(R.normReason('нет блока в 10 -5 33 (добыто 0/4)'), 'нет блока в # # # (добыто #/#)');
  const NOW = Date.UTC(2026, 9, 31, 6, 0, 0); // 06:00 UTC
  const o = R.parseArgs(['8', '--data', os.tmpdir()]); assert.strictEqual(o.hours, 8);
  assert.strictEqual(R.parseArgs(['--since', '2026-10-31T00:00:00Z']).since, Date.UTC(2026, 9, 31));
  assert.throws(() => R.parseArgs(['--since', 'вчера']), /--since/);
  // даты восстанавливаются от mtime: 23:00 -> 01:00 (после полуночи) -> 05:59
  const ts = R.resolveTimes([82800, 3600, 21540], NOW);
  assert.strictEqual(new Date(ts[0]).toISOString(), '2026-10-30T23:00:00.000Z'); assert.strictEqual(new Date(ts[1]).toISOString(), '2026-10-31T01:00:00.000Z');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flybot-nightrep-'));
  try {
    // ----- полный набор данных -----
    const data = path.join(dir, 'data'); fs.mkdirSync(path.join(data, 'blackbox'), { recursive: true });
    const ev = [
      { id: 1, t: '10:00:00', type: 'task_failed', name: 'collect', reason: 'старое, вне окна' },                       // 30.10 — вне окна 8 ч
      { id: 2, t: '23:30:00', type: 'task_failed', name: 'pillar_up', reason: 'столб не вышел: потолок над головой' },   // 30.10 23:30 — в окне (06:00 - 8 ч = 22:00)
      { id: 3, t: '23:40:00', type: 'task_failed', name: 'dig_at', reason: 'нет блока в 1 2 3' },
      { id: 4, t: '23:41:00', type: 'task_failed', name: 'dig_at', reason: 'нет блока в 4 5 6' },
      { id: 5, t: '00:10:00', type: 'task_done', name: 'escape', result: { fled: false } },
      { id: 6, t: '00:11:00', type: 'task_done', name: 'escape', result: { fled: true } },
      { id: 7, t: '00:12:00', type: 'task_done', name: 'escape', result: { fled: false } },
      { id: 8, t: '00:13:00', type: 'task_done', name: 'escape', result: { moved: 1 } },                                 // без fled — не считается
      { id: 9, t: '01:00:00', type: 'progress_idle', min: 10 }, { id: 10, t: '01:10:00', type: 'progress_idle', min: 20 },
      { id: 11, t: '02:00:00', type: 'day_report', day: 5, built: 10, cut: 32, aux: 4, idleMaxMin: 25, minHp: 3, lowHpMin: 1.5, duskFood: 4 },
      { id: 12, t: '03:00:00', type: 'day_report', day: 6, built: 0, cut: 0, aux: 1, idleMaxMin: 40, minHp: 9, lowHpMin: 0, duskFood: 0 },
      { id: 13, t: '04:00:00', type: 'day_report', day: 7, built: 5, cut: 0, aux: 0, idleMaxMin: 5 }
    ];
    fs.writeFileSync(path.join(data, 'events.log'), ev.map(e => JSON.stringify(e)).join('\n') + '\nэто не json\n');
    fs.utimesSync(path.join(data, 'events.log'), new Date(NOW), new Date(NOW));        // последнее событие 04:00 <= mtime 06:00
    const bb = (name, savedAt, cause) => fs.writeFileSync(path.join(data, 'blackbox', name), JSON.stringify({ v: 1, kind: 'death', savedAt, summary: { cause } }));
    bb('death-1.json', '2026-10-31T01:00:00.000Z', 'zombie'); bb('death-2.json', '2026-10-31T02:00:00.000Z', 'zombie'); bb('death-3.json', '2026-10-31T03:00:00.000Z', 'skeleton');
    bb('death-old.json', '2026-10-29T03:00:00.000Z', 'creeper'); fs.writeFileSync(path.join(data, 'blackbox', 'near-1.json'), '{}');
    const at = (h, m) => localStamp(Date.UTC(2026, 9, 31, h, m, 0));
    const guard = [
      `${localStamp(NOW - 30 * 3600000)} журнал молчит 10 мин — мозг завис, убиваю (1)`,                    // вне окна
      `${at(1, 0)} журнал молчит 10 мин — мозг завис, убиваю (2)`, `${at(2, 0)} журнал молчит 10 мин — мозг завис, убиваю (3)`,
      `${at(1, 5)} учитель: взял случай 20261031-000000-1 (near, pid 1, модель x)`, `${at(1, 6)} учитель: 20261031-000000-1 — закончил (done)`,
      `${at(1, 7)} учитель: взял случай 20261031-000000-2 (fail, pid 2, модель x)`, `${at(1, 8)} учитель: 20261031-000000-2 — закончил (failed)`,
      `${at(1, 9)} учитель: 20261031-000000-2 — лимит запросов модели, случай в очереди, повтор через 5 мин`,
      `${at(1, 10)} инженер: collect_x — лимит запросов модели, повтор через 2 мин`
    ];
    fs.writeFileSync(path.join(data, 'guard.log'), guard.join('\r\n') + '\r\n');
    fs.writeFileSync(path.join(data, 'teacher_queue.json'), JSON.stringify({ cases: [{ status: 'pending' }, { status: 'pending' }, { status: 'done' }] }));
    const before = fs.readdirSync(data).map(n => n + ':' + fs.statSync(path.join(data, n)).mtimeMs).join('|');

    const rep = R.buildReport({ hours: 8, data, now: NOW });
    assert(/Смерти: 3 \(zombie 2, skeleton 1\)/.test(rep), rep);                         // creeper вне окна, near-* — не смерть
    assert(/Построено: 15 бл\., вырублено: 32 бл\.; служебных 5; игровых дней 3, из них без прогресса 1/.test(rep), rep);
    assert(/минимум HP 3; при HP≤4 всего 1\.5 мин; еда на закате: 4, 0/.test(rep), rep);
    assert(/Самый долгий простой: 40 мин \(progress_idle: 20 мин; day_report: 40 мин\)/.test(rep), rep);
    assert(/Провалы задач: 3; топ-5:\n  2× dig_at — нет блока в # # #\n  1× pillar_up — столб не вышел: потолок над головой/.test(rep), rep);
    assert(!/старое/.test(rep), 'событие вне окна не считается');
    assert(/Побеги escape: 3, не убежала \(fled:false\) 2 = 67%/.test(rep), rep);
    assert(/Сторож убил мозг: 2 раз/.test(rep), rep);
    assert(/упёрлись в лимит запросов 2 раз \(инженер 1, учитель 1\); случаев взято 2, закончено done 1 \/ failed 1/.test(rep), rep);
    assert(/Очередь учителя сейчас \(снимок, не за окно\): pending 2, done 1/.test(rep), rep);
    // отчёт ничего не пишет
    assert.strictEqual(fs.readdirSync(data).map(n => n + ':' + fs.statSync(path.join(data, n)).mtimeMs).join('|'), before, 'только чтение');
    // --since вместо часов
    const rep2 = R.buildReport({ since: Date.UTC(2026, 9, 31, 3, 30), data, now: NOW });
    assert(/Смерти: 0/.test(rep2) && /Провалы задач: 0/.test(rep2) && /игровых дней 1,/.test(rep2), rep2);

    // ----- старые day_report без cut/minHp и пустые данные: «нет данных», ничего не выдумываем -----
    const d2 = path.join(dir, 'data2'); fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'events.log'), JSON.stringify({ id: 1, t: '04:00:00', type: 'day_report', day: 5, built: 3, aux: 1 }) + '\n');
    fs.utimesSync(path.join(d2, 'events.log'), new Date(NOW), new Date(NOW));
    const r3 = R.buildReport({ hours: 8, data: d2, now: NOW });
    assert(/Смерти: нет данных/.test(r3), r3); assert(/вырублено: нет данных/.test(r3), r3); assert(/минимум HP: нет данных; минуты при HP≤4: нет данных; еда на закате: нет данных/.test(r3), r3);
    assert(/Побеги escape: нет данных/.test(r3), r3); assert(/Сторож убил мозг: нет данных/.test(r3), r3); assert(/Лимиты учителя: нет данных/.test(r3), r3);
    assert(/Очередь учителя сейчас: нет данных/.test(r3), r3);
    const d3 = path.join(dir, 'пусто'); fs.mkdirSync(d3);
    const r4 = R.buildReport({ hours: 12, data: d3, now: NOW });
    assert(/Построено\/вырублено: нет данных/.test(r4) && /Провалы задач: нет данных/.test(r4) && /Самый долгий простой: нет данных/.test(r4), r4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('night_report: OK');
};
if (require.main === module) module.exports().catch(e => { console.error(e); process.exit(1); });
