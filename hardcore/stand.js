// Хардкор-стенд, этап 1а (docs/goal_path.md): мир за миром без человека.
//   новый сид → server.properties (hardcore) → сервер → боты → умер последний или вышел срок мира → stop →
//   папка мира в hardcore/archive/<мир>/ (хранятся последние keepArchives) → заново.
// Запуск: hardcore.cmd (или node hardcore/stand.js [путь к конфигу]). Стоп: файл hardcore/data/STOP (стенд доиграет мир и выйдет)
// или закрыть окно. Сервер трижды подряд не поднялся → hardcore/data/NEED_HUMAN.txt и выход.
// FlyBot (bot.js, night.cmd) стенд не трогает: своя папка, свой порт.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');
const timeline = require('./timeline');

const HERE = __dirname;
const DEFAULTS = {
  serverDir: '', serverJar: 'server.jar', java: 'java', javaArgs: ['-Xmx4G'], serverCmd: null,
  version: '26.1', port: 25566, levelName: 'hc_world', bots: 5, botPrefix: 'HC_', botCmd: null,
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
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch (e) {}
}
const appendJsonl = (f, obj) => fs.appendFileSync(f, JSON.stringify(obj) + '\n');

// Перенос папки: rename, а между дисками — копия и удаление.
function moveDir(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch (e) { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
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

function startBot(cfg, w, nick, cardFile) {
  const base = cfg.botCmd || [process.execPath, path.join(HERE, 'life.js')];
  const args = [...base.slice(1), '--host', '127.0.0.1', '--port', String(cfg.port), '--name', nick, '--version', cfg.version,
    '--world', w.id, '--seed', w.seed, '--out', cardFile, '--maxSec', String(cfg.maxWorldMin * 60 + 60)];
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
  log(`мир ${id}: сид ${seed}, ботов ${cfg.bots}, порт ${cfg.port}`);

  const srv = startServer(cfg, path.join(dir, 'server.log'));
  const ready = await waitReady(srv, cfg.serverStartTimeoutSec * 1000);
  if (!ready) {
    log(`мир ${id}: сервер не поднялся (подробности — ${path.join(dir, 'server.log')})`);
    try { srv.kill(); } catch (e) {}
    await Promise.race([srv.exited, sleep(10000)]);
    return { ...w, serverOk: false };
  }
  const t0 = Date.now();
  const bots = [];
  for (let i = 1; i <= cfg.bots; i++) {
    const nick = `${cfg.botPrefix}${i}`;
    const cardFile = path.join(dir, `${nick}.json`);
    bots.push({ nick, cardFile, p: startBot(cfg, w, nick, cardFile) });
    if (i < cfg.bots) await sleep(cfg.botStaggerSec * 1000);
  }
  const allDone = Promise.all(bots.map(b => b.p.exited));
  const timedOut = await Promise.race([allDone.then(() => false), sleep(cfg.maxWorldMin * 60000).then(() => true)]);
  if (timedOut) {
    log(`мир ${id}: вышел срок ${cfg.maxWorldMin} мин — боты пишут карточки и выходят`);
    for (const b of bots) try { b.p.stdin.write('quit\n'); } catch (e) {}
    await Promise.race([allDone, sleep(20000)]);
    for (const b of bots) if (b.p.exitCode === null) try { b.p.kill(); } catch (e) {}
    await Promise.race([allDone, sleep(5000)]);
  }
  await stopServer(cfg, srv);
  const durSec = Math.round((Date.now() - t0) / 1000);

  // Карточки: что написал бот + сообщение о смерти из журнала сервера. Нет карточки — бот упал.
  const cards = bots.map(b => {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(b.cardFile, 'utf8')); } catch (e) {}
    if (!c) c = { nick: b.nick, result: timedOut ? 'timeout' : 'crash', exitCode: b.p.exitCode, note: 'бот не написал карточку' };
    const msg = L.deathMessage(srv.lines, b.nick);
    if (msg) { c.deathMessageServer = msg; if (!c.cause) c.cause = L.causeOf(msg); }
    return Object.assign({ world: id, seed, nick: b.nick, mode: 'stage1a' }, c);
  });
  for (const c of cards) appendJsonl(path.join(cfg.dataDir, 'lives.jsonl'), c);

  // Мир в архив: только папку мира внутри папки сервера.
  const wdir = path.join(cfg.serverDir, cfg.levelName);
  let archived = null;
  if (fs.existsSync(wdir)) {
    if (!L.isInside(cfg.serverDir, wdir)) throw new Error(`папка мира ${wdir} не внутри ${cfg.serverDir}`);
    archived = path.join(cfg.archiveDir, id);
    moveDir(wdir, path.join(archived, 'world'));
    fs.cpSync(dir, path.join(archived, 'stand'), { recursive: true });
  }
  return { _cards: cards, ...w, serverOk: true, endedAt: new Date().toISOString(), durSec, timedOut, cheats: L.countCheats(srv.lines), archived, ...L.summarizeWorld(cards) };
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
  try { fs.unlinkSync(needHuman); } catch (e) {}
  try { fs.unlinkSync(stopFlag); } catch (e) {}
  clearLeftover(cfg);
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
      log(`мир ${r.id} готов за ${r.durSec} с: смертей ${r.deaths}/${r.bots}, первую ночь пережили ${r.firstNight}, читов ${r.cheats}; лента — ${path.join(cfg.dataDir, 'timeline', r.id + '.html')}`);
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

module.exports = { main, loadConfig, checkSetup, DEFAULTS };
if (require.main === module) main().then(c => { process.exitCode = c; }, e => { log(`стенд упал: ${e.stack || e}`); process.exitCode = 1; });
