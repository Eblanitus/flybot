// Хардкор-стенд, этап 1а (docs/goal_path.md): мир за миром без человека.
//   новый сид → server.properties (hardcore) → сервер → боты → умер последний или вышел срок мира → stop →
//   папка мира в hardcore/archive/<мир>/ (хранятся последние keepArchives) → заново.
// Запуск: hardcore.cmd (или node hardcore/stand.js [путь к конфигу]). Стоп: файл hardcore/data/STOP (стенд доиграет мир и выйдет),
// hardcore/data/STOP_NOW или закрытие окна — сразу (мухи пишут карточки, серверу — stop)
// или закрыть окно. Сервер трижды подряд не поднялся → hardcore/data/NEED_HUMAN.txt и выход.
// FlyBot (bot.js, night.cmd) стенд не трогает: своя папка, свой порт.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');
const timeline = require('./timeline');
const TEACH = require('./teach');

const HERE = __dirname;
const DEFAULTS = {
  serverDir: '', serverJar: 'server.jar', java: 'java', javaArgs: ['-Xmx4G'], serverCmd: null,
  version: '26.1', port: 25566, levelName: 'hc_world', levelType: 'minecraft\\:large_biomes', bots: 5, botPrefix: 'HC_', botCmd: null, botMode: '1b', flyCtlBase: 3310, flyRunnerBase: 3410, flyJoinSec: 120,
  battleRoyale: true, brSpawnMin: 300, brSpawnMax: 900, brViewDistance: 20,   // этап 1в (хозяин 04.11): мухи охотятся друг на друга; расстановка ×3 (было 100–300)
  pool: false,   // пул навыков (hardcore/pool): включает хозяин в конфиге. С stage2 — навыки пула в списке решателя (HC_POOL); без — day_routine_v7/night_mine_v7 по HC_POOL_RUNS, как было
  stage2: false, controlBots: 2, teach: null,   // этап 2 (хозяин 05.11): учащиеся мухи; последние controlBots — контроль (без общей памяти и без проб решателя); teach: {id, offer, worlds} — правка учителя (В2)
  brStartTime: 12000,   // 1в (хозяин 04.11): мир начинается сразу вечером (12000 — закат, ночь с 13000), чтобы мухи не успевали спокойно развиться; null — как раньше
  maxWorldMin: 120, keepArchives: 10, worldsTarget: 0, serverStartTimeoutSec: 300, serverStopTimeoutSec: 90,
  botStaggerSec: 3, pauseBetweenWorldsSec: 5, maxServerFails: 3,
  dataDir: path.join(HERE, 'data'), archiveDir: path.join(HERE, 'archive')
};

function loadConfig(file) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`нет или битый конфиг ${file} — скопируй hardcore/config.example.json в hardcore/config.json и впиши serverDir (${e.message})`); }
  const cfg = Object.assign({}, DEFAULTS, user);
  for (const k of ['dataDir', 'archiveDir']) if (!path.isAbsolute(cfg[k])) cfg[k] = path.join(HERE, cfg[k]);
  return cfg;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let logFile = null;
// Консоль хозяина: строки, набранные в окне стенда, уходят в консоль текущего сервера (например `kill HC_1`).
// Каждая такая команда — вмешательство: пишется в stand.log и в строку мира (consoleCommands).
let current = null, currentBots = [];

// Стоп без человека (04.11: окно стенда закрыли, а java сервера осталась и держала порт).
//   - закрытие окна / Ctrl+C / завершение процесса (SIGHUP, SIGINT, SIGBREAK, SIGTERM) — мухи пишут карточки, серверу уходит stop;
//   - файл data/STOP_NOW — то же самое сразу, без ожидания конца мира (data/STOP — как раньше: доиграть мир и выйти).
// Сервер гасится своей командой stop (мир сохраняется), силой — только если за срок не вышел.
let shuttingDown = false;
async function shutdownNow(cfg, why) {
  if (shuttingDown) return; shuttingDown = true;
  log(`останавливаю стенд сейчас: ${why}`);
  for (const b of currentBots) try { b.p.stdin.write('quit\n'); } catch (e) {}
  await Promise.race([Promise.all(currentBots.map(b => b.p.exited)), sleep(8000)]);
  for (const b of currentBots) if (b.p.exitCode === null) try { b.p.kill(); } catch (e) {}
  if (current && current.exitCode === null) await stopServer({ ...cfg, serverStopTimeoutSec: Math.min(cfg.serverStopTimeoutSec, 30) }, current);
  log('стенд остановлен');
  process.exit(0);
}
function attachStop(cfg) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => { shutdownNow(cfg, sig === 'SIGHUP' ? 'окно стенда закрыто' : sig); }); } catch (e) {}
  }
  const now = path.join(cfg.dataDir, 'STOP_NOW');
  try { fs.unlinkSync(now); } catch (e) {}
  setInterval(() => { if (fs.existsSync(now)) { try { fs.unlinkSync(now); } catch (e) {} shutdownNow(cfg, 'найден STOP_NOW'); } }, 2000).unref();
}
function attachConsole() {
  if (!process.stdin.isTTY && process.env.HC_CONSOLE !== '1') return;   // в тестах stdin не трогаем
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).replace(/\r$/, '').trim().replace(/^\//, ''); buf = buf.slice(i + 1);
      if (!cmd) continue;
      if (!current || current.exitCode !== null) { log(`консоль: «${cmd}» — сервер сейчас не запущен`); continue; }
      try { current.stdin.write(cmd + '\n'); current.consoleCommands.push(cmd); log(`консоль хозяина → сервер: ${cmd}`); }
      catch (e) { log(`консоль: не отправлено: ${e.message}`); }
    }
  });
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch (e) {}
}
const appendJsonl = (f, obj) => fs.appendFileSync(f, JSON.stringify(obj) + '\n');

// Перенос папки: rename, а между дисками — копия и удаление.
function moveDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); return; }
  catch (e) {
    // занят другим процессом (Windows: EBUSY/EPERM/EACCES) — не копируем наполовину, а говорим, кто мешает
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw Object.assign(new Error(`папку ${src} держит другой процесс — скорее всего, ещё работает старый стенд или его сервер. Останови его и запусти снова`), { code: 'BUSY' });
    if (e.code !== 'EXDEV') throw e;
  }
  fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true });
}

// Порт сервера стенда уже занят — значит, работает старый стенд (или другой сервер на этом порту).
function portBusy(port) {
  return new Promise(resolve => {
    const net = require('net');
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });
}

function checkSetup(cfg) {
  if (!cfg.serverCmd) {
    if (!cfg.serverDir || !fs.existsSync(cfg.serverDir)) return `нет папки сервера: serverDir = "${cfg.serverDir}" в hardcore/config.json`;
    if (!fs.existsSync(path.join(cfg.serverDir, cfg.serverJar))) return `нет ${cfg.serverJar} в ${cfg.serverDir}`;
  }
  const eula = path.join(cfg.serverDir, 'eula.txt');
  if (!fs.existsSync(eula) || !/^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(eula, 'utf8')))
    return `в ${eula} нет eula=true — один раз запусти сервер руками и прими лицензию Minecraft (стенд не принимает её за тебя)`;
  if (!/^[A-Za-z0-9_-]+$/.test(cfg.levelName)) return `levelName "${cfg.levelName}" — только буквы, цифры, _ и -`;
  return null;
}

// Мир, оставшийся от прерванного прогона, — в архив с пометкой leftover, чтобы новый сид точно дал новый мир.
function clearLeftover(cfg) {
  const wdir = path.join(cfg.serverDir, cfg.levelName);
  if (!fs.existsSync(wdir)) return;
  if (!L.isInside(cfg.serverDir, wdir)) throw new Error(`папка мира ${wdir} не внутри ${cfg.serverDir}`);
  const dst = path.join(cfg.archiveDir, 'leftover-' + L.stamp(new Date()));
  log(`остался мир от прошлого прогона — переношу в ${dst}`);
  moveDir(wdir, dst);
}

function startServer(cfg, serverLog) {
  const [cmd, ...args] = cfg.serverCmd || [cfg.java, ...cfg.javaArgs, '-jar', cfg.serverJar, 'nogui'];
  const p = spawn(cmd, args, { cwd: cfg.serverDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let buf = '';
  const onData = d => {
    fs.appendFileSync(serverLog, d);
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); lines.push(l); p.emit('line', l); }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.exited = new Promise(r => { p.on('exit', code => r(code)); p.on('error', e => { lines.push(`[stand] не запустился: ${e.message}`); r(-1); }); });
  p.lines = lines;
  return p;
}

function waitReady(p, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const fin = ok => { if (!done) { done = true; clearTimeout(t); resolve(ok); } };
    const t = setTimeout(() => fin(false), timeoutMs);
    p.on('line', l => { if (/\]: Done \(|^Done \(/.test(l)) fin(true); });
    p.exited.then(() => fin(false));
  });
}

async function stopServer(cfg, p) {
  try { p.stdin.write('stop\n'); } catch (e) {}
  const code = await Promise.race([p.exited, sleep(cfg.serverStopTimeoutSec * 1000).then(() => 'timeout')]);
  if (code === 'timeout') { log('сервер не остановился за срок — гашу'); try { p.kill(); } catch (e) {} await Promise.race([p.exited, sleep(10000)]); }
}

const isBr = cfg => !!cfg.battleRoyale && cfg.botMode !== '1a';   // баттл-рояль только у бота FlyBot (1б/1в)

// этап 2: группа мухи по нику — последние controlBots мух (HC_9, HC_10 при 10 мухах) контроль, остальные учатся; без stage2 — null
function groupOf(cfg, nick) {
  if (!cfg.stage2) return null;
  const num = Number((/(\d+)$/.exec(nick) || [0, 0])[1]);
  return num > cfg.bots - cfg.controlBots ? 'control' : 'learn';
}
// правка учителя (В2): id проверки, пока нет вердикта (result.json); группа А — учащиеся HC_1–HC_5 (с правкой), Б — остальные учащиеся
const TEACH_A = 5;
const teachId = cfg => (cfg.stage2 && cfg.teach && cfg.teach.id ? String(cfg.teach.id) : null);
// готово — когда в result.json есть вердикт (до него файл есть, но verdict: null)
const teachDone = cfg => { const id = teachId(cfg); if (!id) return false; try { return !!JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'teach', id, 'result.json'), 'utf8')).verdict; } catch (e) { return false; } };
// В3: после каждого мира — средние очков групп А и Б в result.json; набралось teach.worlds миров — вердикт (оставить / откат)
function teachAfterWorld(cfg, worldId, cards, log = () => {}) {
  const tid = teachId(cfg);
  if (!tid || teachDone(cfg)) return null;
  const file = path.join(cfg.dataDir, 'teach', tid, 'result.json');
  let res = { id: tid, worlds: [], verdict: null };
  try { res = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const avgOf = g => { const ps = cards.filter(c => c.teachGroup === g && typeof c.pointsTotal === 'number').map(c => c.pointsTotal); return ps.length ? Math.round(ps.reduce((s, x) => s + x, 0) / ps.length * 100) / 100 : null; };
  const A = avgOf('A'), B = avgOf('B');
  res.worlds.push({ world: worldId, A, B });
  const need = Number(cfg.teach.worlds) || 3;
  res.verdict = TEACH.verdictOf(res, need);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(res, null, 1));
  const f = v => (v == null ? 'нет' : v.toFixed(1));
  log(`учитель ${tid}: мир ${worldId} — А ${f(A)}, Б ${f(B)} (миров ${res.worlds.length} из ${need})${res.verdict ? ` — ${res.verdict}` : ''}`);
  return res.verdict;
}
function teachGroupOf(cfg, nick) {
  if (!teachId(cfg) || teachDone(cfg) || groupOf(cfg, nick) !== 'learn') return null;
  return Number((/(\d+)$/.exec(nick) || [0, 0])[1]) <= TEACH_A ? 'A' : 'B';
}
// состав групп для лога мира: «учатся HC_1–HC_8, контроль HC_9, HC_10»
function groupsText(cfg) {
  const nicks = Array.from({ length: cfg.bots }, (_, i) => cfg.botPrefix + (i + 1));
  const span = a => (a.length > 2 ? `${a[0]}–${a[a.length - 1]}` : a.join(', '));
  const learn = nicks.filter(n => groupOf(cfg, n) === 'learn'), ctl = nicks.filter(n => groupOf(cfg, n) === 'control');
  return [learn.length ? `учатся ${span(learn)}` : '', ctl.length ? `контроль ${span(ctl)}` : ''].filter(Boolean).join(', ');
}
// аргументы мухи (тела) без запуска — чистая сборка, её проверяет test/hardcore_stage2_stand.js
function botArgs(cfg, w, nick, cardFile) {
  const fly = cfg.botMode !== '1a';   // 1б: настоящий FlyBot с автопилотом (hardcore/fly.js); 1а: простой бот life.js
  const group = groupOf(cfg, nick);
  const tg = teachGroupOf(cfg, nick), tid = teachId(cfg), offer = tg === 'A' ? [].concat((cfg.teach && cfg.teach.offer) || []) : [];
  return ['--host', '127.0.0.1', '--port', String(cfg.port), '--name', nick, '--version', cfg.version,
    '--world', w.id, '--seed', w.seed, '--out', cardFile, '--maxSec', String(cfg.maxWorldMin * 60 + 60),
    ...(fly ? ['--ctlBase', String(cfg.flyCtlBase), '--runnerBase', String(cfg.flyRunnerBase), '--joinSec', String(cfg.flyJoinSec)] : []),
    ...(isBr(cfg) ? ['--br', cfg.botPrefix] : []), ...(fly && cfg.pool ? ['--pool', path.join(cfg.dataDir, 'pool_runs.jsonl')] : []),
    ...(fly && group ? ['--stage2', '1', '--group', group] : []),
    ...(fly && group === 'learn' ? ['--shared', path.join(cfg.dataDir, 'shared')] : []),
    ...(fly && tg === 'A' ? ['--learned', path.join(cfg.dataDir, 'teach', tid, 'learned')] : []),   // группа А: папка навыков с правкой
    ...(fly && tg ? ['--teach', `${tid}:${tg}`] : []),
    ...(fly && tg === 'A' && offer.length ? ['--offer', offer.join(',')] : [])];
}

function startBot(cfg, w, nick, cardFile) {
  const fly = cfg.botMode !== '1a';   // 1б: настоящий FlyBot с автопилотом (hardcore/fly.js); 1а: простой бот life.js
  const base = cfg.botCmd || [process.execPath, path.join(HERE, fly ? 'fly.js' : 'life.js')];
  const args = [...base.slice(1), ...botArgs(cfg, w, nick, cardFile)];
  const out = fs.openSync(path.join(w.dir, `${nick}.out.log`), 'a');
  const p = spawn(base[0], args, { cwd: HERE, stdio: ['pipe', out, out], windowsHide: true });
  p.exited = new Promise(r => {
    p.on('exit', code => { try { fs.closeSync(out); } catch (e) {} r(code); });
    p.on('error', e => { log(`${nick}: не запустился: ${e.message}`); r(-1); });
  });
  return p;
}

async function runWorld(cfg, n) {
  const seed = L.makeSeed();
  const id = L.worldId(new Date(), n);
  const dir = path.join(cfg.dataDir, 'worlds', id);
  fs.mkdirSync(dir, { recursive: true });
  const w = { id, seed, dir, startedAt: new Date().toISOString() };
  const propsFile = path.join(cfg.serverDir, 'server.properties');
  const old = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '';
  fs.writeFileSync(propsFile, L.patchProperties(old, L.worldProperties(cfg, seed)));
  const stage = cfg.botMode === '1a' ? '1а' : isBr(cfg) ? '1в (баттл-рояль)' : '1б';
  log(`мир ${id}: сид ${seed}, ботов ${cfg.bots}, порт ${cfg.port}, бот этапа ${stage}${cfg.stage2 ? `, этап 2 — ${groupsText(cfg)}` : ''}`);

  const srv = startServer(cfg, path.join(dir, 'server.log'));
  srv.consoleCommands = [];
  current = srv;
  const ready = await waitReady(srv, cfg.serverStartTimeoutSec * 1000);
  if (!ready) {
    log(`мир ${id}: сервер не поднялся (подробности — ${path.join(dir, 'server.log')})`);
    try { srv.kill(); } catch (e) {}
    await Promise.race([srv.exited, sleep(10000)]);
    return { ...w, serverOk: false };
  }
  // Баттл-рояль: мир стартует вечером (time set — команда стенда до входа мух, пишется в строку мира, не в consoleCommands)
  if (isBr(cfg) && cfg.brStartTime != null) {
    try { srv.stdin.write(`time set ${cfg.brStartTime}\n`); w.startTime = cfg.brStartTime; log(`мир ${id}: время ${cfg.brStartTime} (вечер)`); }
    catch (e) { log(`мир ${id}: время не выставлено: ${e.message}`); }
  }
  const t0 = Date.now();
  const bots = [];
  currentBots = bots;
  // Баттл-рояль: каждую муху сразу после входа переносим на её точку (пары в brSpawnMin..brSpawnMax блоков).
  // spreadplayers с разбросом 0 и радиусом 1 ставит на поверхность у точки — не в воздух и не в камень. Это расстановка стенда,
  // а не вмешательство: команды пишутся в строку мира (brSpawn), а не в consoleCommands.
  if (isBr(cfg)) {
    const BR = require('./br');
    const sp = BR.spawnPoints(cfg.bots, { min: cfg.brSpawnMin, max: cfg.brSpawnMax });
    w.brSpawn = { ok: sp.ok, points: {} };
    if (!sp.ok) log(`мир ${id}: ${cfg.bots} мух не расставить так, чтобы все пары были в ${cfg.brSpawnMin}–${cfg.brSpawnMax} блоках — беру лучшую найденную расстановку`);
    const byPoint = {};   // «x z» → ник: ответ сервера на spreadplayers называет точку, а не муху
    sp.points.forEach((pt, i) => { const nick = `${cfg.botPrefix}${i + 1}`; w.brSpawn.points[nick] = pt; byPoint[`${pt.x} ${pt.z}`] = nick; });
    const send = (nick, pt) => {
      try { srv.stdin.write(BR.spreadCmd(pt, nick, pt.tries) + '\n'); return true; }
      catch (e) { log(`мир ${id}: ${nick} не расставлен: ${e.message}`); return false; }
    };
    const onJoin = l => {
      const m = /: ([A-Za-z0-9_]{3,16}) joined the game/.exec(l);
      const pt = m && w.brSpawn.points[m[1]];
      if (!pt || pt.sent) return;
      pt.sent = true; pt.tries = 0;
      if (send(m[1], pt)) log(`мир ${id}: ${m[1]} → ${pt.x} ${pt.z}`);
    };
    // Сервер не нашёл суши у точки (вода) — та же точка с радиусом шире; без этого муха остаётся у точки появления мира, в куче с другими
    const onSpread = l => {
      const s = BR.parseSpread(l);
      const nick = s && byPoint[`${s.x} ${s.z}`], pt = nick && w.brSpawn.points[nick];
      if (!pt || !pt.sent || pt.placed || pt.failed) return;
      if (s.ok) {
        pt.placed = true;
        if (pt.tries) log(`мир ${id}: ${nick} поставлен в ${BR.SPREAD_RADII[pt.tries]} блоках от точки ${pt.x} ${pt.z}`);
        return;
      }
      if (++pt.tries >= BR.SPREAD_RADII.length) {
        pt.failed = true;
        log(`мир ${id}: ${nick} не поставлен — в ${BR.SPREAD_RADII[BR.SPREAD_RADII.length - 1]} блоках от ${pt.x} ${pt.z} нет суши, остался у точки появления мира`);
        return;
      }
      log(`мир ${id}: ${nick} — у ${pt.x} ${pt.z} нет суши, пробую в ${BR.SPREAD_RADII[pt.tries]} блоках`);
      send(nick, pt);
    };
    for (const l of srv.lines.slice()) { onJoin(l); onSpread(l); }   // вошёл раньше, чем мы начали слушать
    srv.on('line', onJoin);
    srv.on('line', onSpread);
  }
  if (teachId(cfg) && !teachDone(cfg)) { // В2: папка навыков группы А — копия brain/learned и правка учителя поверх (hardcore/teach/<id>/learned)
    const tid = teachId(cfg), over = TEACH.buildLearned(path.join(HERE, '..', 'brain', 'learned'), path.join(HERE, 'teach', tid, 'learned'), path.join(cfg.dataDir, 'teach', tid, 'learned'));
    log(`правка учителя ${tid}: группа А (HC_1–HC_${TEACH_A}) — ${over.length ? 'правка: ' + over.join(', ') : 'файлов правки нет, группа А идёт без правки'}`);
  }
  for (let i = 1; i <= cfg.bots; i++) {
    const nick = `${cfg.botPrefix}${i}`;
    const cardFile = path.join(dir, `${nick}.json`);
    bots.push({ nick, cardFile, p: startBot(cfg, w, nick, cardFile) });
    if (i < cfg.bots) await sleep(cfg.botStaggerSec * 1000);
  }
  const allDone = Promise.all(bots.map(b => b.p.exited));
  // Баттл-рояль: мир кончается, когда осталась одна муха (убивать больше некого) — или по сроку.
  let lastOne = null;
  const oneLeft = !isBr(cfg) || bots.length < 2 ? new Promise(() => {}) : new Promise(resolve => {
    const iv = setInterval(() => {
      const alive = bots.filter(b => b.p.exitCode === null);
      if (alive.length <= 1) { clearInterval(iv); lastOne = alive[0] ? alive[0].nick : null; resolve('one'); }
    }, 2000);
    allDone.then(() => clearInterval(iv));
  });
  const ended = await Promise.race([allDone.then(() => 'all'), oneLeft, sleep(cfg.maxWorldMin * 60000).then(() => 'time')]);
  const timedOut = ended === 'time';
  if (ended === 'one' && lastOne) {
    log(`мир ${id}: осталась одна муха (${lastOne}) — мир окончен`);
    for (const b of bots) if (b.p.exitCode === null) try { b.p.stdin.write('quit\n'); } catch (e) {}
    await Promise.race([allDone, sleep(20000)]);
    for (const b of bots) if (b.p.exitCode === null) try { b.p.kill(); } catch (e) {}
  }
  if (timedOut) {
    log(`мир ${id}: вышел срок ${cfg.maxWorldMin} мин — боты пишут карточки и выходят`);
    for (const b of bots) try { b.p.stdin.write('quit\n'); } catch (e) {}
    await Promise.race([allDone, sleep(20000)]);
    for (const b of bots) if (b.p.exitCode === null) try { b.p.kill(); } catch (e) {}
    await Promise.race([allDone, sleep(5000)]);
  }
  await stopServer(cfg, srv);
  current = null;
  const durSec = Math.round((Date.now() - t0) / 1000);

  // Карточки: что написал бот + сообщение о смерти из журнала сервера. Нет карточки — бот упал.
  const cards = bots.map(b => {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(b.cardFile, 'utf8')); } catch (e) {}
    if (!c) c = { nick: b.nick, result: timedOut ? 'timeout' : 'crash', exitCode: b.p.exitCode, note: 'бот не написал карточку' };
    const msg = L.deathMessage(srv.lines, b.nick);
    if (msg) { c.deathMessageServer = msg; if (!c.cause) c.cause = L.causeOf(msg); }
    return Object.assign({ world: id, seed, nick: b.nick, mode: cfg.botMode === '1a' ? 'stage1a' : cfg.stage2 ? 'stage2' : isBr(cfg) ? 'stage1v-br' : 'stage1b-flybot' }, c);
  });
  for (const c of cards) appendJsonl(path.join(cfg.dataDir, 'lives.jsonl'), c);
  // этап 2 (В1): дела всех мух мира — в общий журнал для сводки hardcore/skills_report.js (у мух без этапа 2 дел нет — строк нет)
  for (const b of bots) {
    const c = cards.find(x => x.nick === b.nick);
    let rows = [];
    try { rows = fs.readFileSync(path.join(path.dirname(b.cardFile), b.nick + '.fly', 'deeds.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) {}
    const lines = rows.map(x => JSON.stringify({ ...x, world: id, nick: b.nick, group: c ? c.group || null : null })).join('\n');
    if (lines) fs.appendFileSync(path.join(cfg.dataDir, 'deeds_all.jsonl'), lines + '\n');
  }
  // этап 2 (Б10): общая память — только учащиеся мухи (группа learn), только законченные жизни (смерть или срок); мухи мира друг у друга не учатся
  if (teachId(cfg)) { // В3: средние группы А и Б за этот мир; набралось teach.worlds — вердикт (правка остаётся в проверке, пока нет вердикта)
    const v = teachAfterWorld(cfg, id, cards, log);
    if (v) log(`учитель ${teachId(cfg)}: проверка закончена — ${v}${v === 'откат' ? ', правка никому не выдаётся' : ', правку переносит учитель (В4)'}`);
  }
  if (cfg.stage2) for (const b of bots) {
    const c = cards.find(x => x.nick === b.nick);
    if (!c || c.group !== 'learn' || c.teachGroup === 'A' || !(c.result === 'death' || c.result === 'timeout')) continue;   // В2: дела группы А во время проверки не сливаем
    try { const n = require('./memory').mergeLife(path.join(cfg.dataDir, 'shared'), path.join(path.dirname(b.cardFile), b.nick + '.fly')); log(`общая память: ${b.nick} +${n} дел`); }
    catch (e) { log(`общая память: ${b.nick} не слита — ${e.message}`); }
  }

  // Мир в архив: только папку мира внутри папки сервера.
  const wdir = path.join(cfg.serverDir, cfg.levelName);
  let archived = null;
  if (fs.existsSync(wdir)) {
    if (!L.isInside(cfg.serverDir, wdir)) throw new Error(`папка мира ${wdir} не внутри ${cfg.serverDir}`);
    archived = path.join(cfg.archiveDir, id);
    moveDir(wdir, path.join(archived, 'world'));
    fs.cpSync(dir, path.join(archived, 'stand'), { recursive: true });
  }
  return { _cards: cards, ...w, serverOk: true, endedAt: new Date().toISOString(), durSec, timedOut, ...(isBr(cfg) ? { br: true, lastAlive: lastOne } : {}), cheats: L.countCheats(srv.lines), consoleCommands: srv.consoleCommands, archived, ...L.summarizeWorld(cards) };
}

function prune(cfg) {
  let names = [];
  try { names = fs.readdirSync(cfg.archiveDir); } catch (e) { return; }
  for (const n of L.pruneList(names, cfg.keepArchives)) {
    const p = path.join(cfg.archiveDir, n);
    if (L.isInside(cfg.archiveDir, p)) { fs.rmSync(p, { recursive: true, force: true }); log(`архив: удалён старый ${n}`); }
  }
}

async function main(cfgFile) {
  const cfg = loadConfig(cfgFile || process.argv[2] || path.join(HERE, 'config.json'));
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.archiveDir, { recursive: true });
  logFile = path.join(cfg.dataDir, 'stand.log');
  const needHuman = path.join(cfg.dataDir, 'NEED_HUMAN.txt');
  const stopFlag = path.join(cfg.dataDir, 'STOP');
  const problem = checkSetup(cfg);
  if (problem) { fs.writeFileSync(needHuman, problem + '\n'); log(`нужен человек: ${problem}`); return 2; }
  if (await portBusy(cfg.port)) {
    const msg = `порт ${cfg.port} уже занят — работает старый стенд или другой сервер. Закрой старое окно стенда (или останови его процессы node/java) и запусти снова`;
    fs.writeFileSync(needHuman, msg + '\n'); log(`нужен человек: ${msg}`); return 4;
  }
  try { fs.unlinkSync(needHuman); } catch (e) {}
  try { fs.unlinkSync(stopFlag); } catch (e) {}
  try { clearLeftover(cfg); }
  catch (e) { if (e.code !== 'BUSY') throw e; fs.writeFileSync(needHuman, e.message + '\n'); log(`нужен человек: ${e.message}`); return 4; }
  attachConsole();
  if (require.main === module) attachStop(cfg);
  log(`стенд запущен: ${cfg.worldsTarget ? cfg.worldsTarget + ' миров' : 'без конца'}, срок мира ${cfg.maxWorldMin} мин`);
  let fails = 0, n = 0;
  while (!cfg.worldsTarget || n < cfg.worldsTarget) {
    n++;
    const { _cards, ...r } = await runWorld(cfg, n);
    appendJsonl(path.join(cfg.dataDir, 'worlds.jsonl'), r);
    try {
      const worlds = fs.readFileSync(path.join(cfg.dataDir, 'worlds.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      timeline.write(cfg.dataDir, r.serverOk ? r : null, r.serverOk ? _cards : null, worlds);
    } catch (e) { log(`лента мира не нарисована: ${e.message}`); }
    if (r.serverOk) {
      fails = 0;
      log(`мир ${r.id} готов за ${r.durSec} с: смертей ${r.deaths}/${r.bots}, первую ночь пережили ${r.firstNight}, высшая ступень ${r.topStepMax}${r.br ? `, убийств муха→муха ${r.kills} (оружием ${r.killsArmed})` : ''}, читов ${r.cheats}${r.pointsAvg != null ? `, очки в среднем ${r.pointsAvg}` : ''}${r.pointsByGroup && Object.keys(r.pointsByGroup).some(g => g !== 'all') ? `, очки по группам: ${Object.entries(r.pointsByGroup).map(([g, v]) => `${L.GROUP_TEXT[g] || g} ${v}`).join(', ')}` : ''}; лента —${path.join(cfg.dataDir, 'timeline', r.id + '.html')}`);
      prune(cfg);
    } else if (++fails >= cfg.maxServerFails) {
      const msg = `сервер ${fails} раза подряд не поднялся — стенд остановлен. Смотри server.log в ${path.join(cfg.dataDir, 'worlds')}`;
      fs.writeFileSync(needHuman, msg + '\n'); log(`нужен человек: ${msg}`); return 3;
    }
    if (fs.existsSync(stopFlag)) { log('найден STOP — выхожу'); try { fs.unlinkSync(stopFlag); } catch (e) {} break; }
    await sleep(cfg.pauseBetweenWorldsSec * 1000);
  }
  log('стенд закончил');
  return 0;
}

module.exports = { main, loadConfig, checkSetup, DEFAULTS, botArgs, groupOf, groupsText, teachGroupOf, teachId, teachDone, teachAfterWorld, TEACH_A };
if (require.main === module) main().then(c => process.exit(c), e => { log(`стенд упал: ${e.stack || e}`); process.exit(1); });   // exit: консоль держит stdin открытым
