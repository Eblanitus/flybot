// Офлайн-проверка хардкор-стенда (hardcore/, этап 1а): чистые функции и два прогона стенда на поддельном сервере и ботах —
// обычный (2 мира, архив, карточки, ротация архива) и «сервер не поднимается» (3 провала → NEED_HUMAN.txt).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../hardcore/lib');
const stand = require('../hardcore/stand');
const TL = require('../hardcore/timeline');

// --- чистые функции ---
for (let i = 0; i < 200; i++) { const s = L.makeSeed(); assert(/^-?\d+$/.test(s), s); assert(Math.abs(Number(s)) < 2 ** 48); }
assert.notStrictEqual(L.makeSeed(), L.makeSeed());

const props = '#Minecraft server properties\nhardcore=false\nlevel-seed=\nmotd=A Minecraft Server\nview-distance=10\n';
const out = L.patchProperties(props, { hardcore: 'true', 'level-seed': '123', 'server-port': 25566 });
assert(out.includes('hardcore=true\n') && out.includes('level-seed=123\n') && out.includes('view-distance=10\n'));
assert(out.includes('#Minecraft server properties') && out.endsWith('server-port=25566\n'));
assert.strictEqual(out.match(/hardcore=/g).length, 1);
const wp = L.worldProperties({ levelName: 'hc_world', port: 25566, bots: 3 }, '-5');
assert.strictEqual(wp['level-type'], 'minecraft\\:large_biomes');
assert.strictEqual(wp.hardcore, 'true'); assert.strictEqual(wp.difficulty, 'hard'); assert.strictEqual(wp['server-ip'], '127.0.0.1');

assert(L.WORLD_ID_RE.test(L.worldId(new Date(2026, 10, 1, 9, 5, 7), 3)));
assert.strictEqual(L.worldId(new Date(2026, 10, 1, 9, 5, 7), 3), 'w20261101-090507-3');
const names = ['w20261101-090000-1', 'w20261101-100000-2', 'w20261101-110000-3', 'leftover-x', 'notes.txt'];
assert.deepStrictEqual(L.pruneList(names, 2), ['w20261101-090000-1']);
assert.deepStrictEqual(L.pruneList(names, 10), []);

assert(L.isInside('/a/srv', '/a/srv/hc_world'));
assert(!L.isInside('/a/srv', '/a/srv'));
assert(!L.isInside('/a/srv', '/a/other'));
assert(!L.isInside('/a/srv', '/a/srv/../x'));

assert.strictEqual(L.countCheats([
  '[Server thread/INFO]: HC_1 issued server command: /gamemode creative',
  '[Server thread/INFO]: HC_1 issued server command: /help',
  '[Server thread/INFO]: [Server: Set the time to 1000]',
  '[Server thread/INFO]: HC_1 joined the game'
]), 2);

const log = ['[..] [Server thread/INFO]: HC_1 joined the game', '[..] [Server thread/INFO]: HC_1 was shot by Skeleton', '[..]: HC_10 fell from a high place'];
assert.strictEqual(L.deathMessage(log, 'HC_1'), 'HC_1 was shot by Skeleton');
assert.strictEqual(L.deathMessage(log, 'HC_10'), 'HC_10 fell from a high place');
assert.strictEqual(L.deathMessage(log, 'HC_2'), null);
assert.strictEqual(L.deathMessage(['HC_1 was slain by Zombie'], 'HC_1'), 'HC_1 was slain by Zombie');   // чат бота — без префикса
assert.strictEqual(L.causeOf('HC_1 was slain by Zombie'), 'Zombie');
assert.strictEqual(L.causeOf('HC_1 was shot by Skeleton using Bow'), 'Skeleton');
assert.strictEqual(L.causeOf('HC_1 starved to death'), 'starve');
assert.strictEqual(L.causeOf('HC_1 fell from a high place'), 'fall');
assert.strictEqual(L.causeOf(null), null);
// умерла в воде, но добил моб или муха — причина он, а не «утонула»; моб-утопленник Drowned — тоже моб
assert.strictEqual(L.causeOf('HC_1 drowned'), 'drown');
assert.strictEqual(L.causeOf('HC_1 drowned whilst trying to escape Zombie'), 'Zombie');
assert.strictEqual(L.causeOf('HC_1 drowned whilst trying to escape HC_2'), 'HC_2');
assert.strictEqual(L.causeOf('HC_1 drowned whilst trying to escape HC_2 using Stone Sword'), 'HC_2');
assert.strictEqual(L.causeOf('HC_1 was slain by Drowned'), 'Drowned');
assert.strictEqual(L.causeOf('HC_1 was impaled by Drowned using Trident'), 'Drowned');
assert.strictEqual(L.causeOf('HC_1 was killed while fighting Eblanitus228'), 'Eblanitus228');
assert.strictEqual(L.causeOf('HC_1 was smashed by Eblanitus228'), 'Eblanitus228');
{
  const { causeFromMessage } = require('../lib/body_events');
  assert.strictEqual(causeFromMessage('HC_1 drowned', 'HC_1'), 'утонул');
  assert.strictEqual(causeFromMessage('HC_1 drowned whilst trying to escape Zombie', 'HC_1'), 'zombie');
  assert.strictEqual(causeFromMessage('HC_1 drowned whilst trying to escape HC_2 using [Stone Sword]', 'HC_1'), 'hc_2');
  assert.strictEqual(causeFromMessage('HC_1 was slain by Drowned', 'HC_1'), 'drowned');
}

assert.strictEqual(L.firstNightEnd(0, 0), 23000);          // утро первого дня — до конца первой ночи
assert.strictEqual(L.firstNightEnd(1000, 6000), 18000);    // полдень
assert.strictEqual(L.firstNightEnd(0, 15000), 32000);      // появился ночью — считается следующая ночь
const sum = L.summarizeWorld([{ result: 'death', lifeSec: 10 }, { result: 'death', lifeSec: 30, firstNightSurvived: true }, { result: 'crash', lifeSec: 0 }]);
assert.deepStrictEqual([sum.bots, sum.deaths, sum.crashes, sum.firstNight, sum.medianLifeSec], [3, 2, 1, 1, 10]);
// очки жизни (этап 2, А4): средние по мухам и по группам; карточки без очков — полей нет (старые миры не ломаются)
{
  const ps = L.summarizeWorld([{ nick: 'HC_1', result: 'death', pointsTotal: 1, group: 'learn' }, { nick: 'HC_2', result: 'death', pointsTotal: 2, group: 'learn' },
    { nick: 'HC_3', result: 'timeout', pointsTotal: 6, group: 'control' }]);
  assert.strictEqual(ps.pointsAvg, 3);
  assert.deepStrictEqual(ps.pointsByGroup, { learn: 1.5, control: 6 });
  assert.deepStrictEqual(ps.pointsByNick, { HC_1: 1, HC_2: 2, HC_3: 6 });
  const old = L.summarizeWorld([{ nick: 'HC_1', result: 'death', lifeSec: 100 }]);
  assert(!('pointsAvg' in old) && !('pointsByGroup' in old));
  const tlHtml = TL.worldHtml({ id: 'w2', seed: '5', durSec: 120, cheats: 0, pointsAvg: 3 }, [{ nick: 'HC_1', result: 'death', pointsTotal: 4, events: [] }]);
  assert(tlHtml.includes('очки в среднем 3'), 'шапка мира: очки в среднем');
  assert(TL.svgFor([{ nick: 'HC_1', pointsTotal: 4, events: [{ wt: 1, kind: 'start', text: 'x' }] }]).includes('HC_1 · 4 оч.'), 'подпись мухи: очки');
}

// хроника: ночь, пережитая ночь, новый день, HP низкий (повтор — только после HP > 8)
{
  const ch = L.makeChronicle();
  ch.note(0, 'start', 'старт');
  for (let wt = 0; wt <= 26000; wt += 1000) ch.observe({ wt, hp: wt === 14000 ? 3 : wt === 15000 ? 2 : wt === 20000 ? 10 : wt === 21000 ? 4 : 15 });
  const kinds = ch.events.map(e => e.kind);
  assert.deepStrictEqual(kinds, ['start', 'night', 'lowhp', 'lowhp', 'night_survived', 'day'], kinds.join(','));
  assert.strictEqual(ch.events.find(e => e.kind === 'night_survived').text, 'пережил первую ночь');
  const big = L.makeChronicle(3); for (let i = 0; i < 10; i++) big.note(i, 'eat', 'x'); assert.strictEqual(big.events.length, 3);
}
// лента: SVG с ботами, смертью и днями; бот без событий не ломает картинку
{
  const cards = [
    { nick: 'HC_1', result: 'death', wtStart: 0, wtEnd: 30000, events: [{ wt: 0, kind: 'start', text: 'старт' }, { wt: 9000, kind: 'flee', text: 'бежит от zombie' }, { wt: 30000, kind: 'death', text: 'смерть: Zombie' }] },
    { nick: 'HC_2', result: 'crash', note: 'бот не написал карточку' }
  ];
  const svg = TL.svgFor(cards);
  assert(svg.startsWith('<svg') && svg.includes('HC_1') && svg.includes('HC_2') && svg.includes('✕ смерть: Zombie, день 2'));
  assert(svg.includes('день 1') && svg.includes('день 2') && svg.includes('нет событий: crash'));
  assert.strictEqual(TL.dayLabel(14000), 'день 1, ночь'); assert.strictEqual(TL.dayLabel(24000), 'день 2');
  assert(TL.svgFor([{ nick: '<b>', events: [{ wt: 1, kind: 'start', text: '<script>' }] }]).includes('&lt;script&gt;'));
  const html = TL.worldHtml({ id: 'w1', seed: '5', durSec: 120, cheats: 0 }, cards);
  assert(html.includes('<title>Мир w1</title>') && html.includes('index.html'));
}

// --- стенд на поддельном сервере ---
function setup(extra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  const srv = path.join(tmp, 'srv');
  fs.mkdirSync(srv);
  fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(srv, 'server.properties'), props);
  const fakes = path.join(__dirname, 'hardcore_fakes');
  const cfg = Object.assign({
    serverDir: srv, serverCmd: [process.execPath, path.join(fakes, 'server.js')], botCmd: [process.execPath, path.join(fakes, 'bot.js')],
    bots: 2, worldsTarget: 3, keepArchives: 2, botStaggerSec: 0, pauseBetweenWorldsSec: 0, serverStartTimeoutSec: 10, serverStopTimeoutSec: 5,
    maxWorldMin: 1, dataDir: path.join(tmp, 'data'), archiveDir: path.join(tmp, 'archive'),
    port: 40000 + Math.floor(Math.random() * 20000)   // не 25566: тест не должен падать, пока на ПК работает настоящий стенд
  }, extra);
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { tmp, srv, cfg, file };
}
const readJsonl = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

(async () => {
  // нет eula — стенд не стартует и просит человека
  {
    const s = setup();
    fs.writeFileSync(path.join(s.srv, 'eula.txt'), 'eula=false\n');
    assert.strictEqual(await stand.main(s.file), 2);
    assert(/eula/.test(fs.readFileSync(path.join(s.cfg.dataDir, 'NEED_HUMAN.txt'), 'utf8')));
  }
  // обычный прогон: 3 мира, в архиве последние 2, карточки, остаток прошлого прогона — в leftover
  {
    const s = setup();
    fs.mkdirSync(path.join(s.srv, 'hc_world'));
    assert.strictEqual(await stand.main(s.file), 0);
    const worlds = readJsonl(path.join(s.cfg.dataDir, 'worlds.jsonl'));
    assert.strictEqual(worlds.length, 3);
    for (const w of worlds) {
      assert(w.serverOk && w.bots === 2 && w.deaths === 1 && w.crashes === 1 && w.cheats === 0, JSON.stringify(w));
    }
    assert.strictEqual(new Set(worlds.map(w => w.seed)).size, 3, 'каждый мир — свой сид');
    const props2 = fs.readFileSync(path.join(s.srv, 'server.properties'), 'utf8');
    assert(props2.includes('level-type=minecraft\\:large_biomes') && props2.includes('hardcore=true') && props2.includes('difficulty=hard') && props2.includes('pvp=true'));
    // баттл-рояль (1в, по умолчанию): дальность прорисовки 20 — локатор видит всю расстановку; мух переносят на точки после входа
    assert(props2.includes('view-distance=20'), 'view-distance=20 в баттл-рояле');
    for (const w of worlds) assert(w.br && w.brSpawn && w.brSpawn.points.HC_1 && w.brSpawn.points.HC_1.sent, JSON.stringify(w.brSpawn));
    assert(/got: spreadplayers -?\d+ -?\d+ 0 1 false HC_1/.test(fs.readFileSync(path.join(s.cfg.dataDir, 'worlds', worlds[0].id, 'server.log'), 'utf8')), 'расстановка ушла в сервер');
    // 05.11: у точки нет суши — сервер «Could not spread», стенд пробует ту же точку с радиусом шире (иначе муха остаётся в куче у спавна)
    for (const w of worlds) {
      const p1 = w.brSpawn.points.HC_1, p2 = w.brSpawn.points.HC_2;
      assert(p1.placed && p1.tries === 0, 'HC_1 поставлен с первого раза: ' + JSON.stringify(p1));
      assert(p2.placed && p2.tries === 1 && !p2.failed, 'HC_2 поставлен со второй попытки: ' + JSON.stringify(p2));
      assert(new RegExp(`got: spreadplayers ${p2.x} ${p2.z} 0 24 false HC_2`).test(fs.readFileSync(path.join(s.cfg.dataDir, 'worlds', w.id, 'server.log'), 'utf8')), 'повтор с радиусом 24');
    }
    assert(!fs.existsSync(path.join(s.srv, 'hc_world')), 'мир ушёл в архив');
    const arch = fs.readdirSync(s.cfg.archiveDir).sort();
    assert.strictEqual(arch.filter(n => L.WORLD_ID_RE.test(n)).length, 2, arch.join(','));
    assert(arch.some(n => n.startsWith('leftover-')));
    const last = worlds[2];
    assert(fs.readFileSync(path.join(s.cfg.archiveDir, last.id, 'world', 'level.dat'), 'utf8').includes(last.seed));
    const lives = readJsonl(path.join(s.cfg.dataDir, 'lives.jsonl'));
    assert.strictEqual(lives.length, 6);
    const hc1 = lives.find(c => c.nick === 'HC_1');
    assert.strictEqual(hc1.cause, 'Zombie'); assert.strictEqual(hc1.deathMessageServer, 'HC_1 was slain by Zombie');
    assert.strictEqual(lives.find(c => c.nick === 'HC_2').result, 'crash');
    const tl = path.join(s.cfg.dataDir, 'timeline');
    for (const w of worlds) assert(fs.existsSync(path.join(tl, w.id + '.html')), 'лента мира ' + w.id);
    const idx = fs.readFileSync(path.join(tl, 'index.html'), 'utf8');
    assert(worlds.every(w => idx.includes(w.id + '.html')));
    assert(fs.readFileSync(path.join(tl, last.id + '.html'), 'utf8').includes('пережил первую ночь'));
    fs.rmSync(tl, { recursive: true }); TL.rebuild(s.cfg.dataDir);
    assert(fs.existsSync(path.join(tl, last.id + '.html')), 'rebuild перерисовал ленты');
  }
  // бот 1а: баттл-рояля нет — дальность прорисовки не трогаем, мух не переносим
  {
    const s = setup({ worldsTarget: 1, botMode: '1a' });
    assert.strictEqual(await stand.main(s.file), 0);
    const props2 = fs.readFileSync(path.join(s.srv, 'server.properties'), 'utf8');
    assert(props2.includes('view-distance=10'), 'в 1а view-distance как был');
    const w = readJsonl(path.join(s.cfg.dataDir, 'worlds.jsonl'))[0];
    assert(!w.br && !w.brSpawn, JSON.stringify(w));
  }
  // сервер не поднимается: 3 провала подряд → NEED_HUMAN.txt, код 3
  {
    process.env.FAKE_FAIL = '1';
    const s = setup({ worldsTarget: 10 });
    assert.strictEqual(await stand.main(s.file), 3);
    delete process.env.FAKE_FAIL;
    assert.strictEqual(readJsonl(path.join(s.cfg.dataDir, 'worlds.jsonl')).length, 3);
    assert(/не поднялся/.test(fs.readFileSync(path.join(s.cfg.dataDir, 'NEED_HUMAN.txt'), 'utf8')));
  }
  // порт занят (старый стенд ещё работает) — стенд не трогает мир и просит человека
  {
    const net = require('net');
    const srv = net.createServer().listen(0, '127.0.0.1');
    await new Promise(r => srv.on('listening', r));
    const s = setup({ port: srv.address().port });
    fs.mkdirSync(path.join(s.srv, 'hc_world'));
    assert.strictEqual(await stand.main(s.file), 4);
    assert(/порт .* занят/.test(fs.readFileSync(path.join(s.cfg.dataDir, 'NEED_HUMAN.txt'), 'utf8')));
    assert(fs.existsSync(path.join(s.srv, 'hc_world')), 'мир не тронут');
    srv.close();
  }
  // консоль хозяина: строка из окна стенда уходит в сервер и записывается как вмешательство
  {
    const s = setup({ worldsTarget: 1, bots: 1 });
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'hardcore', 'stand.js'), s.file],
      { env: Object.assign({}, process.env, { HC_CONSOLE: '1', FAKE_BOT_WAIT_MS: '1500' }), stdio: ['pipe', 'ignore', 'inherit'] });
    setTimeout(() => p.stdin.write('/kill HC_1\n'), 700);
    const code = await new Promise(r => p.on('exit', r));
    assert.strictEqual(code, 0);
    const w = readJsonl(path.join(s.cfg.dataDir, 'worlds.jsonl'))[0];
    assert.deepStrictEqual(w.consoleCommands, ['kill HC_1']);
    assert(fs.readFileSync(path.join(s.cfg.dataDir, 'worlds', w.id, 'server.log'), 'utf8').includes('got: kill HC_1'));
    assert(fs.readFileSync(path.join(s.cfg.dataDir, 'stand.log'), 'utf8').includes('консоль хозяина → сервер: kill HC_1'));
  }
  console.log('hardcore: ok');
})().catch(e => { console.error(e); process.exit(1); });
