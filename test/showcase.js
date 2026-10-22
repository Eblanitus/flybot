// Офлайн-проверка витрины навыков (этап H): формат /showcase, честная статистика на фальшивых данных, защита пути в /showcase/code,
// кэш, разбор настоящего репозитория, конфиг учителя (curl только на /showcase соседа), вкладка «Витрина» аудита. Без сервера Minecraft
// и без обращений к настоящим :3199/:3200/:3099: «соседи» здесь — фальшивые серверы на свободных портах. Запуск: node test/showcase.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const S = require('../lib/showcase');
const A = require('../audit/server');

const ROOT = path.join(__dirname, '..');
const w = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const jl = arr => arr.map(o => JSON.stringify(o)).join('\r\n') + '\r\n';

// ---------- фальшивый проект ----------
function fakeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
  w(root, 'lib/commands.js', [
    "'use strict';", "const gather = require('./skills/gather');", "const { recover } = require('./skills/recover');", '',
    'const SKILLS = {', '  collect: gather.collect,', '  // навыки ниже', '  recover,',
    '  follow: async (ctx, t, p) => {', '    const bot = ctx.bot;', '    return { followed: 1 };', '  }', '};', 'const SKILL_NAMES = Object.keys(SKILLS);'].join('\r\n'));
  w(root, 'lib/skills/gather.js', '// gather\nmodule.exports = { collect() {} };\n');
  w(root, 'lib/skills/recover.js', '// recover\nmodule.exports = { recover() {} };\n');
  w(root, 'SKILLS.md', ['## Навыки', '| action | params | что делает |', '|---|---|---|',
    '| `collect` | `block`, `count`=1 | добыть блок \\| предмет |', '| `recover` | — | вернуться к месту смерти |', '| `follow` | `name`? | следовать за игроком |'].join('\r\n'));
  w(root, 'brain/learned/mine_vein.js', "// mine_vein — копает жилу\nmodule.exports = {\n  name: 'mine_vein',\n  description: 'Находит жилу и выкапывает её.',\n  params: {\n    ore: 'iron | coal',\n    max: 'сколько блоков, по умолчанию 16'\n  },\n  async run(api, params) {}\n};\n");
  w(root, 'brain/learned/no_stats.js', "// no_stats — навык без записей\nmodule.exports = { name: 'no_stats', run() {} };\n");
  w(root, 'brain/learned/_hidden.js', 'module.exports = {};\n');
  w(root, 'brain/learned/.history/mine_vein.20261021000000-000.js', 'old\n');
  w(root, 'lib/variants/melee/kite.js', "module.exports = { name: 'kite', family: 'melee', desc: 'удар и отход', run() {} };\n");
  w(root, 'lib/variants/melee/crit_jump.js', "module.exports = { name: 'crit_jump', family: 'melee', desc: 'прыжок и удар', run() {} };\n");
  w(root, 'lib/variants/melee/_family.js', 'module.exports = {};\n');
  w(root, 'behavior/index.js', '// Поведение: вход\n// вторая строка\n\'use strict\';\nmodule.exports = {};\n');
  w(root, 'behavior/test.js', '// самопроверка\n');
  // то, что отдавать нельзя
  w(root, 'data/secret.txt', 'СЕКРЕТ');
  w(root, 'brain/notes.md', 'заметки мозга');
  w(root, 'bot.js', '// ядро\n');
  w(root, '.env', 'KEY=1');
  // данные для статистики
  const ev = [{ id: 1, t: '10:00:00', type: 'task_done', name: 'collect', result: {} }, { id: 2, t: '10:01:00', type: 'task_failed', name: 'collect', reason: 'не нашёл log' },
    { id: 3, t: '10:02:00', type: 'task_done', name: 'collect', result: {} }, { id: 4, t: '10:03:00', type: 'task_failed', name: 'recover', reason: 'не помню места' },
    { id: 5, t: '10:04:00', type: 'task_aborted', name: 'recover', reason: 'stop' }, { id: 6, t: '10:05:00', type: 'info', name: 'collect' }];
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'events.log'), jl(ev) + 'мусорная строка\r\n{"битый json\r\n');
  fs.writeFileSync(path.join(root, 'brain', 'runner.log'), jl([
    { id: 1, time: '2026-10-20T10:00:00.000Z', type: 'run_start', name: 'mine_vein' },
    { id: 2, time: '2026-10-20T10:01:00.000Z', type: 'run_end', name: 'mine_vein', ok: false, error: 'мало HP' },
    { id: 3, time: '2026-10-20T10:02:00.000Z', type: 'run_end', name: 'mine_vein', ok: false, error: 'мало HP' },
    { id: 4, time: '2026-10-20T10:03:00.000Z', type: 'run_end', name: 'mine_vein', ok: true },
    { id: 5, time: '2026-10-20T10:04:00.000Z', type: 'run_end', name: 'mine_vein', ok: false, error: 'нет кирки' }]));
  fs.writeFileSync(path.join(root, 'brain', 'skills_stats.json'), JSON.stringify({ mine_vein: { enabled: false, runs: 4, ok: 1, fail: 3, lastError: 'нет кирки' }, gone: { runs: 9, ok: 9, fail: 0 } }));
  fs.writeFileSync(path.join(root, 'data', 'variants.json'), JSON.stringify({ stats: { melee: { '*': { kite: { n: 4, ok: 1, sum: 1.5 } }, zombie: { kite: { n: 99, ok: 99, sum: 99 } } } }, recent: [] }));
  return root;
}
const find = (sc, name) => sc.skills.find(s => s.name === name);

function testFormat(root) {
  const sc = S.build({ root, bot: 'FlyBot_01', version: 'FlyBot 0.1', now: Date.parse('2026-10-21T20:00:00Z') });
  assert.strictEqual(sc.bot, 'FlyBot_01'); assert.strictEqual(sc.version, 'FlyBot 0.1'); assert.strictEqual(sc.format, S.FORMAT); assert.strictEqual(sc.updated, '2026-10-21T20:00:00.000Z');
  const names = sc.skills.map(s => s.name);
  assert.strictEqual(new Set(names).size, names.length, 'имена уникальны');
  assert.deepStrictEqual(names.sort(), ['behavior/index', 'collect', 'follow', 'melee/crit_jump', 'melee/kite', 'mine_vein', 'no_stats', 'recover'].sort(), names.join());
  for (const s of sc.skills) {
    assert(S.KINDS.includes(s.kind), s.name); assert(s.about === null || typeof s.about === 'string', s.name);
    for (const k of ['runs', 'ok', 'fail']) assert(s.stats[k] === null || Number.isInteger(s.stats[k]), s.name + '.' + k);
    assert(s.stats.lastErrors === null || Array.isArray(s.stats.lastErrors), s.name); assert(s.stats.since === null || typeof s.stats.since === 'string', s.name);
    if (s.kind === 'variant') assert.strictEqual(s.family, 'melee'); else assert(!('family' in s));
    assert(JSON.stringify(s).length < 5000, 'не раздуваем ' + s.name);
  }
  // навыки тела: только task_done / task_failed; прерванные и чужие события не считаются; since неизвестен (в журнале нет даты)
  const c = find(sc, 'collect');
  assert.deepStrictEqual(c.stats, { runs: 3, ok: 2, fail: 1, lastErrors: ['не нашёл log'], since: null });
  assert.strictEqual(c.about, 'добыть блок | предмет'); assert.strictEqual(c.params, '`block`, `count`=1');
  assert.deepStrictEqual(find(sc, 'recover').stats, { runs: 1, ok: 0, fail: 1, lastErrors: ['не помню места'], since: null });
  assert.deepStrictEqual(find(sc, 'follow').stats, { runs: 0, ok: 0, fail: 0, lastErrors: [], since: null }, 'данные есть, запусков не было — нули, не null');
  // выученные: цифры из skills_stats.json, ошибки — разные, свежая последней, since — первая запись runner.log; лишнее из статистики не выдумывается
  const m = find(sc, 'mine_vein');
  assert.deepStrictEqual(m.stats, { runs: 4, ok: 1, fail: 3, lastErrors: ['мало HP', 'нет кирки'], since: '2026-10-20T10:00:00.000Z' });
  assert.strictEqual(m.enabled, false); assert.strictEqual(m.about, 'Находит жилу и выкапывает её.');
  assert.deepStrictEqual(m.params, { ore: 'iron | coal', max: 'сколько блоков, по умолчанию 16' });
  assert.deepStrictEqual(find(sc, 'no_stats').stats, { runs: 0, ok: 0, fail: 0, lastErrors: [], since: null });
  assert.strictEqual(find(sc, 'no_stats').about, 'no_stats — навык без записей', 'описание из шапки файла');
  assert(!names.includes('gone') && !names.includes('_hidden') && !names.includes('behavior/test'));
  // варианты: уровень «*» (все обстановки), не сумма уровней; ошибок нет -> null
  assert.deepStrictEqual(find(sc, 'melee/kite').stats, { runs: 4, ok: 1, fail: 3, lastErrors: null, since: null, avg: 0.38 });
  assert.deepStrictEqual(find(sc, 'melee/crit_jump').stats, { runs: 0, ok: 0, fail: 0, lastErrors: null, since: null, avg: null });
  assert.strictEqual(find(sc, 'melee/kite').about, 'удар и отход');
  // поведение: запусков не считаем — null, а не выдумка
  assert.deepStrictEqual(find(sc, 'behavior/index').stats, { runs: null, ok: null, fail: null, lastErrors: null, since: null });
  assert.strictEqual(find(sc, 'behavior/index').about, 'Поведение: вход вторая строка');
  // нет ни одного журнала — везде null, ничего не падает
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-empty-'));
  const e = S.build({ root: empty, dataDir: path.join(empty, 'nodata'), brainDir: path.join(empty, 'nobrain') });
  assert.deepStrictEqual(e.skills, []); assert.strictEqual(e.bot, null);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-bare-'));
  w(bare, 'brain/learned/x_skill.js', "module.exports = { name: 'x_skill', description: 'x', run() {} };\n"); w(bare, 'lib/variants/melee/kite.js', "module.exports = { name: 'kite', desc: 'k', run() {} };\n");
  const b = S.build({ root: bare });
  assert.deepStrictEqual(find(b, 'x_skill').stats, { runs: null, ok: null, fail: null, lastErrors: null, since: null });
  assert.deepStrictEqual(find(b, 'melee/kite').stats, { runs: null, ok: null, fail: null, lastErrors: null, since: null });
  // битые файлы данных не роняют
  w(bare, 'brain/skills_stats.json', '{не json'); w(bare, 'data/variants.json', '[[[');
  assert.strictEqual(find(S.build({ root: bare }), 'x_skill').stats.runs, null);
  // разбор SKILLS.md: экранированный «|» внутри ячейки; повтор имени — берём первую строку
  const md = S.parseSkillsMd('| `a` | `x`\\|`y` | делает | ещё |\n| `a` | z | другое |\n| не навык | 1 | 2 |\n');
  assert.deepStrictEqual([...md.keys()], ['a']); assert.strictEqual(md.get('a').params, '`x`|`y`'); assert.strictEqual(md.get('a').about, 'делает | ещё');
  // ошибки: не больше 3 разных
  assert.deepStrictEqual(S.lastDistinct(['a', 'b', 'a', 'c', 'd', 'c'], 3), ['a', 'd', 'c']);
}

function testCode(root) {
  const ok = S.readCode('collect', { root });
  assert(ok.ok && ok.file === 'lib/skills/gather.js' && /collect/.test(ok.code) && ok.kind === 'body');
  assert.strictEqual(S.readCode('follow', { root }).file, 'lib/commands.js');
  assert.strictEqual(S.readCode('mine_vein', { root }).file, 'brain/learned/mine_vein.js');
  assert.strictEqual(S.readCode('melee/kite', { root }).family, 'melee');
  assert.strictEqual(S.readCode('behavior/index', { root }).file, 'behavior/index.js');
  assert.strictEqual(S.readCode('collect', { root, kind: 'learned' }).status, 404, 'kind сужает поиск');
  // чужое и опасное: ни путь, ни имя файла, ни кодировка не пропускают
  const bad = ['../data/secret.txt', '..\\data\\secret.txt', '../../etc/passwd', 'melee/../../data/secret', 'behavior/../../bot', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini',
    '%2e%2e/data/secret', '..%2fdata%2fsecret.txt', 'data/secret.txt', 'secret.txt', 'bot', 'bot.js', 'notes', 'brain/notes', 'brain/notes.md', '.env', 'mine_vein.js', 'brain/learned/mine_vein', 'lib/commands', 'lib/skills/gather',
    'behavior/test', 'melee/_family', '_hidden', '.history/mine_vein.20261021000000-000', 'x\0y', 'a'.repeat(300), ' collect', 'collect ', '', null, undefined, 5, {}, ['collect']];
  for (const n of bad) { const r = S.readCode(n, { root }); assert.strictEqual(r.ok, false, 'отказ: ' + JSON.stringify(n)); assert([400, 404].includes(r.status), JSON.stringify(n) + ' ' + r.status); assert(!('code' in r)); }
  // символьная ссылка наружу (если система разрешает её создать): отказ 403, содержимое не утекает
  try {
    fs.symlinkSync(path.join(root, 'data', 'secret.txt'), path.join(root, 'brain', 'learned', 'sneaky.js'));
    const r = S.readCode('sneaky', { root }); assert.strictEqual(r.ok, false); assert(!/СЕКРЕТ/.test(JSON.stringify(r)));
    fs.unlinkSync(path.join(root, 'brain', 'learned', 'sneaky.js'));
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'UNKNOWN') throw e; }
  // слишком большой файл
  w(root, 'brain/learned/huge.js', "module.exports = {name:'huge'};\n" + '//'.padEnd(S.MAX_CODE + 10, 'x'));
  assert.strictEqual(S.readCode('huge', { root }).status, 413);
  fs.unlinkSync(path.join(root, 'brain', 'learned', 'huge.js'));
}

function testCache(root) {
  const sh = S.create({ root, bot: 'B', version: '1' });
  const a = sh.get(); assert.strictEqual(sh.get(), a, 'в пределах минуты — тот же объект');
  w(root, 'brain/learned/late.js', "module.exports = { name: 'late', description: 'позже', run() {} };\n");
  assert(!find(sh.get(), 'late'), 'не пересчитывается чаще раза в минуту');
  assert(find(S.create({ root, ttlMs: 0 }).get(), 'late'), 'новый пересчёт видит файл');
  const fresh = S.create({ root, ttlMs: 0 }); assert.notStrictEqual(fresh.get(), fresh.get(), 'ttl=0 — каждый раз заново');
  assert.strictEqual(S.TTL_MS, 60000);
  fs.unlinkSync(path.join(root, 'brain', 'learned', 'late.js'));
  assert.strictEqual(S.create({ root, bot: () => 'Лазурь' }).get().bot, 'Лазурь', 'ник можно задать функцией');
}

// настоящий репозиторий: разбор не врёт о составе навыков
function testRealRepo() {
  const sc = S.build({ root: ROOT, bot: 'FlyBot_01', version: 'FlyBot 0.1' });
  const names = sc.skills.map(s => s.name);
  assert.strictEqual(new Set(names).size, names.length, 'имена в настоящей витрине уникальны');
  const body = sc.skills.filter(s => s.kind === 'body').map(s => s.name).sort();
  const real = Object.keys(require('../lib/commands').SKILLS).sort();
  assert.deepStrictEqual(body, real, 'навыки тела из витрины = таблица SKILLS');
  const learned = fs.readdirSync(path.join(ROOT, 'brain', 'learned')).filter(f => /^[a-z].*\.js$/.test(f)).map(f => f.slice(0, -3)).map(n => real.includes(n) ? 'learned/' + n : n).sort();
  assert.deepStrictEqual(sc.skills.filter(s => s.kind === 'learned').map(s => s.name).sort(), learned);
  const V = require('../lib/variants'); const reg = V.load();
  const vn = []; for (const [fn, f] of reg.families) for (const n of f.variants.keys()) vn.push(fn + '/' + n);
  assert.deepStrictEqual(sc.skills.filter(s => s.kind === 'variant').map(s => s.name).sort(), vn.sort(), 'варианты = реестр lib/variants');
  assert(sc.skills.some(s => s.kind === 'behavior'));
  for (const s of sc.skills) { const r = S.readCode(s.name, { root: ROOT }); assert(r.ok && r.code.length > 0, 'код ' + s.name + ': ' + r.error); assert(!/\.\.|^[A-Za-z]:|^\//.test(r.file), r.file); }
  assert(JSON.stringify(sc).length < 200 * 1024, 'витрина не раздута');
}

// ---------- конфиг учителя ----------
// opencode: правила сверху вниз, побеждает последнее подошедшее; * — любые знаки
function perm(rules, cmd) {
  let res = null;
  for (const [pat, act] of Object.entries(rules)) {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
    if (re.test(cmd)) res = act;
  }
  return res;
}
function testTeacherConfig() {
  const tc = JSON.parse(fs.readFileSync(path.join(ROOT, 'brain', 'opencode.teacher.json'), 'utf8'));
  const bash = tc.permission.bash;
  const ok = ['curl.exe -s http://127.0.0.1:3099/showcase', 'curl.exe -s http://127.0.0.1:3099/showcase/code?name=mine_vein', 'curl.exe -s "http://127.0.0.1:3099/showcase/code?name=melee/kite"',
    'curl -s http://127.0.0.1:3099/showcase', 'curl -s http://127.0.0.1:3099/showcase/code?name=behavior/autopilot',
    'curl.exe -s http://127.0.0.1:3199/showcase', 'curl.exe -s http://127.0.0.1:3199/snapshot', 'curl.exe -s http://127.0.0.1:3200/skills', 'curl.exe -s http://127.0.0.1:3199/events?limit=200'];
  for (const c of ok) assert.strictEqual(perm(bash, c), 'allow', 'должно быть можно: ' + c);
  const no = ['curl.exe -s http://127.0.0.1:3099/', 'curl.exe -s http://127.0.0.1:3099/snapshot', 'curl.exe -s http://127.0.0.1:3099/health', 'curl.exe -s http://127.0.0.1:3099/do?action=chat', 'curl.exe -s http://127.0.0.1:3099/cmd',
    'curl.exe -s http://127.0.0.1:3099/wait', 'curl.exe -s http://127.0.0.1:3099/showcasex', 'curl.exe -s http://127.0.0.1:3099/showcase/../do', 'curl.exe -s http://127.0.0.1:3099/showcase/code?name=../../snapshot',
    'curl.exe -s http://127.0.0.1:3099/showcase/do', 'curl.exe -s http://127.0.0.1:3099/showcase -X POST', 'curl.exe -s http://127.0.0.1:3099/showcase -d x=1', 'curl.exe -s http://127.0.0.1:3099/showcase -o f.txt',
    'curl.exe -s http://127.0.0.1:3099/showcase > f.txt', 'curl.exe -s http://127.0.0.1:3099/showcase | more', 'curl.exe -s http://127.0.0.1:3099/showcase & calc', 'curl.exe -s http://127.0.0.1:3099/showcase; calc',
    'curl.exe -s http://127.0.0.1:3099/showcase/code?name=x -T f', 'curl.exe -s http://127.0.0.1:3099/showcase/code?name=$(calc)', 'curl.exe -s http://127.0.0.1:3098/showcase', 'curl.exe -s http://example.com:3099/showcase',
    'curl.exe -s http://127.0.0.1:3199/do?action=chat', 'curl.exe -s http://127.0.0.1:3200/run', 'curl.exe -s http://127.0.0.1:3199/behavior/reload', 'curl.exe http://127.0.0.1:3099/showcase', 'node x.js'];
  for (const c of no) assert.notStrictEqual(perm(bash, c), 'allow', 'должно быть нельзя: ' + c);
  assert.strictEqual(perm(bash, 'rm -rf x'), 'deny');
  // всё остальное в конфиге по-прежнему закрыто
  assert.strictEqual(tc.permission.edit['*'], 'deny'); assert.strictEqual(tc.permission.webfetch, 'deny'); assert.strictEqual(tc.permission.bash['*'], 'deny');
  assert(!Object.keys(tc.permission.edit).some(k => tc.permission.edit[k] === 'allow' && /showcase|lib\/|bot\.js|behavior/.test(k)), 'правок кода учителю нельзя');
  // инженер: конфиг прежний (curl ему и так открыт, сеть не расширяли)
  const ec = JSON.parse(fs.readFileSync(path.join(ROOT, 'brain', 'opencode.engineer.json'), 'utf8')); assert.strictEqual(ec.permission.edit['*'], 'deny');
  // тексты
  const tp = fs.readFileSync(path.join(ROOT, 'brain', 'TEACHER_PROMPT.md'), 'utf8');
  assert(/## Соседи/.test(tp) && /127\.0\.0\.1:3099\/showcase/.test(tp) && /skill_requests\/<имя>\.md/.test(tp) && /молча/.test(tp) && /адаптировать навык соседа/.test(tp));
  const ep = fs.readFileSync(path.join(ROOT, 'brain', 'ENGINEER_PROMPT.md'), 'utf8');
  assert(/адаптировать навык соседа/.test(ep) && /3099\/showcase\/code/.test(ep));
  const doc = fs.readFileSync(path.join(ROOT, 'SHOWCASE.md'), 'utf8');
  assert(/GET \/showcase`/.test(doc) && /\/showcase\/code\?name=/.test(doc) && /lastErrors/.test(doc) && /null/.test(doc));
}

// ---------- тело: маршруты ----------
function testBodyRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
  assert(/case '\/showcase':/.test(src) && /case '\/showcase\/code':/.test(src) && /showcase\.get\(\)/.test(src), 'bot.js: маршруты витрины');
  const line = src.split(/\r?\n/).find(l => /ctx\.lastBrainContact = Date\.now\(\);/.test(l) && /pathname/.test(l));
  assert(line && /startsWith\('\/showcase'\)/.test(line), 'запросы к витрине не считаются признаком «мозг жив»');
  const get = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("req.method === 'POST' && url.pathname === '/cmd'"));
  assert(/case '\/showcase'/.test(get), 'витрина — только GET');
}

// ---------- аудит ----------
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const request = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, text: s, json: (() => { try { return JSON.parse(s); } catch (e) { return null; } })() })); }).on('error', reject));
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }

async function testAudit(root) {
  const seen = [];
  const mk = (handler) => http.createServer((req, res) => { seen.push({ port: req.socket.localPort, method: req.method, url: req.url, observer: req.headers['x-observer'] }); res.setHeader('Content-Type', 'application/json'); handler(req, res); });
  const nsc = { bot: 'Ассасин', version: '1', skills: [{ name: 'strike', kind: 'learned', about: '<b>бой</b>', stats: { runs: 20, ok: 18, fail: 2, lastErrors: ['x'], since: null } }, 42, null] };
  const cfgOf = (b, n) => ({ port: 0, dataDir: path.join(root, 'data'), brainDir: path.join(root, 'brain'), root, bodyUrl: 'http://127.0.0.1:' + b, runnerUrl: 'http://127.0.0.1:' + b, neighborUrl: 'http://127.0.0.1:' + n });
  // 1) тело старое (404), сосед отвечает: наша таблица из файлов, чужая — как есть
  const oldBody = mk((req, res) => { res.statusCode = 404; res.end('{"ok":false}'); });
  const neighbor = mk((req, res) => { if (req.url === '/showcase') return res.end(JSON.stringify(nsc)); res.statusCode = 404; res.end('{}'); });
  const bp = await listen(oldBody), np = await listen(neighbor);
  let r = await A.loadShowcase(cfgOf(bp, np));
  assert(r.ours.ok && r.ours.from === 'диск' && /не перезапущено/.test(r.ours.note) && find(r.ours.data, 'collect').stats.runs === 3, 'со старым телом — из файлов');
  assert(r.neighbor.ok && r.neighbor.data.bot === 'Ассасин');
  // 2) тело новое: берём у него
  const newBody = mk((req, res) => { if (req.url === '/showcase') return res.end(JSON.stringify({ bot: 'FlyBot_01', version: 'v', skills: [] })); res.statusCode = 404; res.end('{}'); });
  const bp2 = await listen(newBody);
  r = await A.loadShowcase(cfgOf(bp2, np)); assert(r.ours.ok && r.ours.from === 'тело' && r.ours.data.bot === 'FlyBot_01');
  // 3) сосед без эндпоинта и сосед в другом виде
  const n404 = mk((req, res) => { res.statusCode = 404; res.end('{"ok":false}'); }), np404 = await listen(n404);
  r = await A.loadShowcase(cfgOf(bp, np404)); assert(!r.neighbor.ok && /нет витрины/.test(r.neighbor.error));
  const nodd = mk((req, res) => res.end('{"skills":"нет"}')), npodd = await listen(nodd);
  r = await A.loadShowcase(cfgOf(bp, npodd)); assert(!r.neighbor.ok && /другом виде/.test(r.neighbor.error));
  // 4) сосед не отвечает: наши данные на месте
  const dead = await freePort();
  r = await A.loadShowcase(cfgOf(bp, dead)); assert(!r.neighbor.ok && /не отвечает/.test(r.neighbor.error) && r.ours.ok);
  // 5) тело не отвечает вовсе — всё равно таблица из файлов
  const deadBody = await freePort();
  r = await A.loadShowcase(cfgOf(deadBody, np)); assert(r.ours.ok && r.ours.from === 'диск' && /не отвечает/.test(r.ours.note));
  // 6) по HTTP аудита, и вкладка в странице
  const audit = A.createServer(cfgOf(bp2, np)); const ap = await listen(audit);
  try {
    const res = await request(ap, '/api/showcase'); assert.strictEqual(res.status, 200); assert(res.json.ours && res.json.neighbor && res.json.now);
    // запросы аудита — только GET /showcase, с X-Observer
    const mine = seen.filter(s => s.url && s.url.startsWith('/showcase')); assert(mine.length > 0);
    for (const s of seen) { assert.strictEqual(s.method, 'GET', s.url); assert.strictEqual(s.observer, '1', 'X-Observer: ' + s.url); assert(/^\/showcase$/.test(s.url), 'только /showcase: ' + s.url); }
  } finally { for (const s of [oldBody, neighbor, newBody, n404, nodd, audit]) s.close(); }
  const html = fs.readFileSync(path.join(ROOT, 'audit', 'index.html'), 'utf8');
  assert(/\['showcase', 'Витрина'\]/.test(html) && /id="p-showcase"/.test(html) && /\/api\/showcase/.test(html) && /Наши навыки/.test(html) && /Навыки соседа/.test(html));
  new (require('vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]); // скрипт страницы разбирается (нет повторных const и т. п.)
  // чужие данные выводятся через esc(), а не как разметка
  const m = /function showcaseTable[\s\S]*?\n}\n/.exec(html); assert(m && /esc\(clipS\(x\.s\.name/.test(m[0]) && /esc\(clipS\(x\.s\.about/.test(m[0]) && /esc\(clipS\(x\.err/.test(m[0]));
  assert(!seen.some(s => s.port === 3099), 'на настоящий :3099 не стучимся');
}

module.exports = async function () {
  const root = fakeProject();
  try {
    testFormat(root); console.log('showcase format: OK');
    testCode(root); console.log('showcase code: OK');
    testCache(root); console.log('showcase cache: OK');
    testRealRepo(); console.log('showcase repo: OK');
    testTeacherConfig(); console.log('showcase teacher: OK');
    testBodyRoutes();
    await testAudit(root); console.log('showcase audit: OK');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} }
};
if (require.main === module) module.exports().then(() => console.log('showcase: all OK'), e => { console.error(e); process.exit(1); });
