// FlyBot («муха»): тело для внешнего LLM-мозга (Hermes).
// Подключается к Minecraft (LAN, без авторизации) и поднимает HTTP API на 127.0.0.1:CONTROL_PORT.
// Запуск: node bot.js <host> <port> [username] [controlPort]
// Env: MC_HOST, MC_PORT, MC_USER, CONTROL_PORT, MC_VERSION, DATA_DIR
//
// Эндпоинты:
//   GET  /health                — подключён ли бот
//   GET  /snapshot              — снимок + "глаза" (summary на русском)
//   GET  /stats                 — статистика
//   GET  /wait?timeout=60       — long-poll: ждать важное событие (навык завершён/провален, опасность, смерть, чат)
//   GET  /events?since=N        — журнал последних событий
//   GET  /task                  — текущий навык и история
//   GET  /autopilot[?on=0|1]    — автопилот: состояние / выключить / включить
//   POST /cmd {"action":"...","params":{...}}  (Content-Type: application/json)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');

const { EventHub } = require('./lib/events');
const { TaskManager } = require('./lib/tasks');
const { makeMovements } = require('./lib/actions');
const reflexes = require('./lib/reflexes');
const referee = require('./lib/referee');
const { snapshot, eyes } = require('./lib/perception');
const { makeDispatcher } = require('./lib/commands');
const vision = require('./lib/vision');
const { cellKey } = require('./lib/skills/gather');
const { ChatLog } = require('./lib/chatlog');

const HOST = process.argv[2] || process.env.MC_HOST || 'localhost';
const PORT = parseInt(process.argv[3] || process.env.MC_PORT || '25565', 10);
const USER = process.argv[4] || process.env.MC_USER || 'FlyBot';
const CONTROL = parseInt(process.argv[5] || process.env.CONTROL_PORT || '3099', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const DEATHS_LOG = path.join(DATA_DIR, 'deaths.log');
const EVENTS_LOG = path.join(DATA_DIR, 'events.log');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

// ---------- Общее состояние (живёт между переподключениями) ----------
const ctx = {
  bot: null, ready: false, lastError: null,
  events: new EventHub(200),
  stats: { deaths: 0, damageTaken: 0, blocksMined: 0, blocksPlaced: 0, distanceTraveled: 0, longestLifeSec: 0 },
  statsDirty: false,
  processStart: Date.now(), aliveSince: null, lastPos: null,
  lastDamage: null, combatUntil: 0, manualControl: false,
  visited: new Set(),
  movements: null, sprintMovements: null
};
ctx.tasks = new TaskManager(ctx);
ctx.chat = new ChatLog(40); // чат/системные строки/экшн-бар — мозг читает их из /snapshot

try { if (fs.existsSync(STATS_FILE)) Object.assign(ctx.stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch (e) { console.log('[stats] read fail', e.message); }
delete ctx.stats.lastPos; delete ctx.stats.startTime; delete ctx.stats.timeAlive;

ctx.markVisited = p => { ctx.visited.add(cellKey(p.x, p.z)); if (ctx.visited.size > 20000) ctx.visited.clear(); };
ctx.timeAliveSec = () => ctx.aliveSince ? Math.floor((Date.now() - ctx.aliveSince) / 1000) : 0;
ctx.statsBrief = () => ({
  deaths: ctx.stats.deaths, damageTaken: Math.round(ctx.stats.damageTaken), blocksMined: ctx.stats.blocksMined,
  blocksPlaced: ctx.stats.blocksPlaced, distanceTraveled: Math.round(ctx.stats.distanceTraveled),
  timeAlive: ctx.timeAliveSec(), uptime: Math.floor((Date.now() - ctx.processStart) / 1000)
});
ctx.logDeath = line => fs.promises.appendFile(DEATHS_LOG, line).catch(() => {});
ctx.haltBody = () => {
  const bot = ctx.bot; if (!bot) return;
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  try { if (bot.targetDigBlock) bot.stopDigging(); } catch (e) {}
  try { bot.clearControlStates(); } catch (e) {}
  try { if (ctx.movements) bot.pathfinder.setMovements(ctx.movements); } catch (e) {}
};

// события — ещё и в файл (по строке JSON)
const origPush = ctx.events.push.bind(ctx.events);
ctx.events.push = (type, data) => {
  const ev = origPush(type, data);
  fs.promises.appendFile(EVENTS_LOG, JSON.stringify(ev) + '\n').catch(() => {});
  try { statusFromEvent(type, data || {}); } catch (e) {}
  return ev;
};

// ---------- Техническое состояние тела — в чат (хозяин видит, даже если мозг молчит) ----------
let lastStatusAt = 0;
function statusChat(text, urgent = false) {
  const bot = ctx.bot;
  if (!bot || !ctx.ready) return;
  if (!urgent && Date.now() - lastStatusAt < 30000) return; // не спамить: сервер кикает
  lastStatusAt = Date.now();
  try { bot.chat(('[тело] ' + text).replace(/^\//, '').slice(0, 200)); } catch (e) {}
}
ctx.statusChat = statusChat; // автопилот пишет состояние сам (не чаще раза в минуту)
function statusFromEvent(type, d) {
  if (type === 'spawn' && d.msg === 'вошёл в мир')
    setTimeout(() => statusChat(`в мире. Смертей всего: ${ctx.stats.deaths || 0}`, true), 4000);
  else if (type === 'death') { referee.onDeath(ctx, d); statusChat(`умер: ${d.cause || '?'}${d.phase ? ' (' + d.phase + ')' : ''}. Смерть №${d.deaths || '?'}`, true); }
  else if (type === 'danger' && d.kind === 'low_hp') statusChat(`мало здоровья: ${d.hp}/20 (урон: ${d.lastDamage || '?'})`);
  else if (type === 'danger' && d.kind === 'hunger') statusChat('голодаю, а есть нечего');
}
ctx.lastBrainContact = Date.now();
let brainSilentWarned = false;
setInterval(() => {
  const min = (Date.now() - ctx.lastBrainContact) / 60000;
  if (min >= 5 && !brainSilentWarned) { brainSilentWarned = true; statusChat(`мозг молчит уже ${Math.round(min)} мин — стою и только отбиваюсь`, true); }
  if (min < 1 && brainSilentWarned) { brainSilentWarned = false; statusChat('мозг снова на связи', true); }
}, 30000);

let saving = false;
async function saveStats(force = false) {
  if ((!ctx.statsDirty && !force) || saving) return;
  saving = true; ctx.statsDirty = false;
  ctx.stats.longestLifeSec = Math.max(ctx.stats.longestLifeSec || 0, ctx.timeAliveSec());
  try { await fs.promises.writeFile(STATS_FILE, JSON.stringify(ctx.stats, null, 2)); } catch (e) {} finally { saving = false; }
}
setInterval(() => saveStats(), 10000);

const dispatch = makeDispatcher(ctx);

// Кто прислал команду: пока исполнитель (:3200) выполняет навык, запущенный автопилотом, его запросы (node, без
// User-Agent) — это автопилот; всё остальное — мозг (curl, или исполнитель с навыком мозга). Команда мозга
// сначала вытесняет автопилот (прерывает его выученный навык), потом выполняется.
async function fromBrainOrAutopilot(req, cmd) {
  const ap = ctx.autopilot;
  if (ap && !req.headers['user-agent'] && ap.ownsRunner()) return 'autopilot';
  if (ap) { try { await ap.brainCommand(cmd && (cmd.action || cmd.cmd)); } catch (e) {} }
  return 'brain';
}

// ---------- Подключение с переподключением ----------
let backoff = 2000;
let reconnectTimer = null;

function connect() {
  reconnectTimer = null;
  console.log(`[bot] connecting to ${HOST}:${PORT} as ${USER}`);
  let bot;
  try {
    bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: process.env.MC_VERSION || '26.1' });
  } catch (e) {
    ctx.lastError = String(e); scheduleReconnect(); return;
  }
  const session = { bot, timers: [], ended: false, spawned: false };
  ctx.bot = bot; ctx.ready = false;
  bot.loadPlugin(pathfinder);
  reflexes.attach(ctx, session); // один раз на экземпляр бота
  vision.attach(ctx, bot, session); // честное зрение: память увиденного + периодический просмотр

  let firstSpawn = true;
  bot.on('spawn', () => {
    ctx.ready = true; ctx.lastError = null; backoff = 2000; session.spawned = true;
    ctx.aliveSince = Date.now(); ctx.lastPos = null;
    if (firstSpawn) {
      firstSpawn = false;
      try {
        ctx.movements = makeMovements(bot);
        ctx.sprintMovements = makeMovements(bot, { sprint: true });
        bot.pathfinder.setMovements(ctx.movements);
        bot.pathfinder.thinkTimeout = 8000;
      } catch (e) { console.log('[pf] movements err', e); }
      // попытка включить выживание (сработает только с правами оператора)
      session.timers.push(setTimeout(() => { try { if (bot.game && bot.game.gameMode !== 'survival') bot.chat('/gamemode survival ' + bot.username); } catch (e) {} }, 2000));
      ctx.events.push('spawn', { msg: 'вошёл в мир' });
    } else {
      ctx.events.push('spawn', { msg: 'респавн' });
    }
    console.log('[bot] spawned');
  });

  const onEnd = (reason) => {
    if (session.ended) return;
    session.ended = true;
    ctx.ready = false;
    for (const tm of session.timers) { clearInterval(tm); clearTimeout(tm); }
    session.timers = [];
    if (ctx.tasks.current) ctx.tasks.current.abort('отключение');
    try { bot.removeAllListeners(); bot.on('error', () => {}); } catch (e) {}
    console.log('[bot] ended:', reason);
    ctx.events.push(session.spawned ? 'disconnect' : 'info', { reason: String(reason || ctx.lastError || 'unknown'), retryInSec: Math.round(backoff / 1000) });
    scheduleReconnect();
  };
  bot.on('end', onEnd);
  bot.on('kicked', (reason) => { ctx.lastError = 'kicked: ' + (typeof reason === 'string' ? reason : JSON.stringify(reason)); console.log('[bot] kicked:', ctx.lastError); });
  bot.on('error', (e) => {
    ctx.lastError = String((e && (e.code || e.message)) || e); console.log('[bot] error:', ctx.lastError);
    // если соединение так и не установилось и 'end' не пришёл — закрыть сами
    if (!ctx.ready) session.timers.push(setTimeout(() => { if (!session.ended) { try { bot.end(); } catch (er) {} onEnd('error: ' + ctx.lastError); } }, 5000));
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 60000);
  console.log(`[bot] reconnect in ${Math.round(wait / 1000)}s`);
  reconnectTimer = setTimeout(connect, wait);
}

// ---------- HTTP API ----------
const MAX_BODY = 64 * 1024;
function send(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

// Запрос со стороннего сайта в браузере (curl таких заголовков не шлёт) — GET /do таким нельзя
function fromBrowser(req) {
  const h = req.headers;
  return !!(h.origin || h.referer || (h['sec-fetch-site'] && h['sec-fetch-site'] !== 'none'));
}
// ?action=place_at&x=1&y=64&z=2&item=cobblestone&wait=1 → {action, params:{x:1,...}, wait:true}
// значения: числа, true/false, [массивы] и {объекты} — как JSON, остальное — строкой
function queryToCmd(q, nameKey) {
  const name = q.get(nameKey);
  if (!name) return { error: `нет ${nameKey}: пример /do?action=collect&block=log&count=8&wait=1` };
  const params = {};
  for (const [k, v] of q) {
    if (k === nameKey || k === 'wait') continue;
    try { params[k] = JSON.parse(v); } catch (e) { params[k] = v; }
  }
  const w = q.get('wait');
  return { cmd: { [nameKey]: name, params, wait: w === '1' || w === 'true' } };
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(res, 400, { ok: false, error: 'bad url' }); }
  const q = url.searchParams;
  if (url.pathname !== '/health') ctx.lastBrainContact = Date.now(); // мозг (или исполнитель) жив и спрашивает тело
  try {
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/health': return send(res, 200, { ready: ctx.ready, error: ctx.lastError, host: HOST, port: PORT, user: USER, task: ctx.tasks.info() });
        case '/do': {
          // быстрая команда без JSON-файла: /do?action=collect&block=log&count=8&wait=1
          if (fromBrowser(req)) return send(res, 403, { ok: false, error: 'запрос из браузера запрещён' });
          const { cmd, error } = queryToCmd(q, 'action');
          if (error) return send(res, 400, { ok: false, error });
          const source = await fromBrainOrAutopilot(req, cmd);
          return send(res, 200, await dispatch(cmd, { source }));
        }
        case '/snapshot': return send(res, 200, snapshot(ctx));
        case '/autopilot': {
          // /autopilot?on=0|1 — выключить/включить; без параметров — состояние
          const ap = ctx.autopilot;
          if (!ap) return send(res, 200, { ok: false, error: 'автопилот ещё не запущен (бот не подключён)' });
          if (q.has('on')) { if (fromBrowser(req)) return send(res, 403, { ok: false, error: 'запрос из браузера запрещён' }); return send(res, 200, { ok: true, autopilot: await ap.setOn(!['0', 'false', 'off'].includes(String(q.get('on')).toLowerCase())) }); }
          return send(res, 200, { ok: true, autopilot: ap.status(), history: ap.history.slice(-10) });
        }
        case '/stats': return send(res, 200, { ...ctx.stats, ...ctx.statsBrief() });
        case '/task': return send(res, 200, { task: ctx.tasks.info(), history: ctx.tasks.history.slice(-10) });
        case '/chat': {
          const since = parseInt(q.get('since') || '0', 10) || 0;
          const limit = Math.min(parseInt(q.get('limit') || '20', 10) || 20, 100);
          const items = (ctx.chat ? ctx.chat.since(since) : []).slice(-limit);
          return send(res, 200, { chat: items, lastId: ctx.chat ? ctx.chat.seq : 0 });
        }
        case '/events': {
          const since = parseInt(q.get('since') || '0', 10) || 0;
          const limit = Math.min(parseInt(q.get('limit') || '50', 10) || 50, 200);
          return send(res, 200, { events: ctx.events.since(since, limit), lastId: ctx.events.seq });
        }
        case '/wait': {
          const timeout = Math.min(Math.max(parseFloat(q.get('timeout') || '60') || 60, 1), 300) * 1000;
          const since = q.has('since') ? (parseInt(q.get('since'), 10) || 0) : null;
          const r = await ctx.events.wait(since, timeout);
          let summary = null;
          try { if (ctx.ready && ctx.bot && ctx.bot.entity) summary = eyes(ctx).summary; } catch (e) {}
          return send(res, 200, { ok: true, ...r, task: ctx.tasks.info(), summary });
        }
      }
      return send(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/cmd') {
      // Защита от запросов со сторонних сайтов: только application/json (браузер не пошлёт такое без CORS-preflight)
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) { req.resume(); return send(res, 415, { ok: false, error: 'нужен Content-Type: application/json' }); }
      let body = ''; let size = 0; let tooBig = false;
      req.on('data', c => {
        if (tooBig) return;
        size += c.length;
        if (size > MAX_BODY) { tooBig = true; send(res, 413, { ok: false, error: 'тело больше 64КБ' }); req.resume(); }
        else body += c;
      });
      req.on('end', async () => {
        if (tooBig) return;
        let cmd;
        try { cmd = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { ok: false, error: 'bad json' }); }
        if (!cmd || typeof cmd !== 'object') return send(res, 400, { ok: false, error: 'bad json' });
        const source = await fromBrainOrAutopilot(req, cmd);
        const result = await dispatch(cmd, { source });
        send(res, 200, result);
      });
      return;
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});
server.requestTimeout = 0; // long-poll /wait
server.headersTimeout = 60000;

process.on('unhandledRejection', (e) => { console.log('[warn] unhandledRejection:', e && e.message ? e.message : e); });
process.on('uncaughtException', (e) => { console.log('[warn] uncaughtException:', e && e.stack ? e.stack : e); });
const shutdown = async () => { await saveStats(true); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

server.on('error', (e) => { console.log('[http] error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
server.listen(CONTROL, '127.0.0.1', () => {
  console.log(`[http] control API on http://127.0.0.1:${CONTROL}`);
  console.log('[http] GET /health /snapshot /stats /wait /events /task   POST /cmd');
  connect();
});
