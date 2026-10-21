// Приказы хозяина без LLM: короткие русские фразы от игрока-хозяина выполняются телом сразу (мозг думает десятки секунд).
// Слушаем ТОЛЬКО сообщения, пришедшие в чат от хозяина: отправителя берём из пакета чата (uuid -> bot.players)
// или из структуры сообщения (translate chat.type.text, with[0]), а не разбором текста — иначе чужой «<eblanitus228> стой» обманет.
// Приказ вытесняет и мозга, и автопилот. Нераспознанное — молчим (это для мозга). В событиях: owner_cmd.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { goals } = require('mineflayer-pathfinder');
const A = require('./actions');
const { Vec3, SkillError } = require('./util');

const OWNER = process.env.OWNER_NAME || 'eblanitus228';
const FOLLOW_MS = 10 * 60 * 1000;     // «за мной» — не дольше 10 минут
const STOP_PAUSE_MS = 2 * 60 * 1000;  // после «стой» автопилот молчит 2 минуты
const SHORT_PAUSE_MS = 20 * 1000;     // на время запуска приказа автопилот не лезет
const OWNER_SEEN_MS = 120 * 1000;     // сколько помним позицию хозяина, если его не видно
const RUNNER = (process.env.RUNNER_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const NOTES = path.join(__dirname, '..', 'brain', 'notes.md');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Разбор фразы (чистые функции) ----------
const ADDR = new Set(['муха', 'мухи', 'мухе', 'муху', 'мух', 'мухаа']);
const FILLER = new Set(['пожалуйста', 'пж', 'плиз', 'быстро', 'быстрее', 'а', 'ну', 'же', 'эй', 'слышь', 'давай', 'давайте', 'теперь', 'сейчас', 'тогда', 'ка']);
const NEG = new Set(['не', 'нельзя', 'ненадо', 'нет', 'никуда', 'без']);
const NUMS = { один: 1, одну: 1, одного: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, пару: 2, пара: 2, дюжину: 12, стак: 64, стака: 64, стопку: 64 };
const ALLW = new Set(['все', 'всё', 'всю', 'всех', 'весь']);
const GIVE_VERBS = new Set(['дай', 'дайте', 'принеси', 'отдай', 'кинь', 'подкинь', 'подай']);

function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9_ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(text) {
  let toks = normalize(text).split(' ').filter(Boolean);
  const addressed = toks.some(t => ADDR.has(t));
  toks = toks.filter(t => !ADDR.has(t) && !FILLER.has(t));
  return { toks, addressed };
}

// Команды: регэксп по строке слов. Без обращения — только целиком (короткая однозначная фраза), с обращением — где угодно.
const CMDS = [
  ['mark', [
    '(?:строй|строим|стройся|построй|построим|ставь|ставим|строить) (?:тут|здесь)',
    '(?:база|базу|стройка|стройку) (?:тут|здесь)',
    '(?:тут|здесь) (?:строй|строим|база|базу|стройка|строить|будет база|будет дом|будем строить)'
  ]],
  ['home', ['(?:(?:иди|беги|вернись|возвращайся|топай|ступай|шуруй|лети) )?(?:домой|на базу|к базе)(?: иди| возвращайся)?']],
  ['follow', ['(?:(?:иди|беги|топай|пошли|пойдем|идем|ступай|лети) )?за мной(?: иди)?', 'следуй(?: за мной)?', '(?:иди|пойдем|идем) со мной', 'иди следом']],
  ['come', ['(?:(?:иди|беги|лети|ступай|топай|подойди|подходи|прилети) )?(?:ко мне|сюда)(?: иди| беги| лети)?', 'подойди', 'подходи']],
  ['sleep', ['(?:(?:иди|ложись|пора) )?спать', 'спи', 'ложись(?: спать)?', 'засыпай', 'на боковую']],
  ['status', ['что (?:ты )?делаешь', 'чем (?:ты )?(?:занят|занята|занимаешься)', 'статус', 'рапорт', 'отчет', 'доклад', 'как успехи']],
  ['stop', ['стой(?: на месте| тут| здесь)?', 'стоп', 'хватит', 'остановись', 'прекрати', 'замри', 'отставить', 'довольно', 'стоять']]
].map(([name, srcs]) => ({
  name,
  loose: new RegExp('(?:^| )(?:' + srcs.join('|') + ')(?= |$)'),
  strict: new RegExp('^(?:' + srcs.join('|') + ')$')
}));

// -> { cmd, ... } | null. addressed: был ли «муха». give: { item: [...слова], count, all }
function parsePhrase(text) {
  const { toks, addressed } = tokenize(text);
  if (!toks.length) return null;
  if (toks.some(t => NEG.has(t))) return null;            // «не стой», «не ходи за мной» — решает мозг
  if (toks.length > (addressed ? 9 : 5)) return null;
  // дай <предмет> [N]
  if (GIVE_VERBS.has(toks[0])) {
    if (!addressed && toks.length > 5) return null;
    let count = null, all = false; const item = [];
    for (const t of toks.slice(1)) {
      if (t === 'мне' || t === 'нам' || t === 'штук' || t === 'шт' || t === 'штуки' || t === 'штуку') continue;
      if (/^\d+$/.test(t)) { count = parseInt(t, 10); continue; }
      if (NUMS[t] != null) { count = NUMS[t]; continue; }
      if (ALLW.has(t)) { all = true; continue; }
      item.push(t);
    }
    if (!item.length) return null;
    return { cmd: 'give', item, count: count == null ? 1 : Math.max(1, Math.min(2304, count)), all, addressed };
  }
  if (!addressed && toks.length > 4) return null;
  const s = toks.join(' ');
  for (const c of CMDS) {
    if ((addressed ? c.loose : c.strict).test(s)) return { cmd: c.name, addressed };
  }
  return null;
}

// ---------- Предметы: русские слова -> имена из инвентаря ----------
const MATERIAL = { желез: 'iron', золот: 'golden', алмазн: 'diamond', каменн: 'stone', деревянн: 'wooden', медн: 'copper', незерит: 'netherite', кожан: 'leather', кольчужн: 'chainmail' };
const TOOLS = [[/^кирк/, 'pickaxe'], [/^меч/, 'sword'], [/^топор/, 'axe'], [/^лопат/, 'shovel'], [/^мотыг/, 'hoe'],
  [/^(шлем|каск)/, 'helmet'], [/^(нагрудник|кирас)/, 'chestplate'], [/^(штан|поножи)/, 'leggings'], [/^(ботинк|сапог)/, 'boots']];
// alts — по порядку предпочтения: строка = точное имя, RegExp = по имени; внутри — самая большая стопка
const NOUNS = [
  [/^(бревн|дерев|древесин)/, [/_log$/, /_stem$/]], [/^доск/, [/_planks$/]], [/^(палк|палоч)/, ['stick']],
  [/^(булыж|кобл)/, ['cobblestone', 'cobbled_deepslate']], [/^(камн|камен|камешк)/, ['cobblestone', 'stone', 'cobbled_deepslate']],
  [/^(земл|грязь|грунт)/, ['dirt']], [/^(песок|песк)/, ['sand']], [/^гравий/, ['gravel']], [/^(уголь|угл)/, ['coal', 'charcoal']],
  [/^желез/, ['iron_ingot', 'raw_iron', 'iron_ore']], [/^(медь|медн)/, ['copper_ingot', 'raw_copper']], [/^золот/, ['gold_ingot', 'raw_gold']],
  [/^(алмаз|брильянт)/, ['diamond']], [/^изумруд/, ['emerald']], [/^редстоун/, ['redstone']], [/^лазурит/, ['lapis_lazuli']],
  [/^хлеб/, ['bread']], [/^яблок/, ['apple']], [/^морков/, ['carrot']], [/^карто[фш]/, ['potato', 'baked_potato']],
  [/^(мясо|говядин|стейк)/, ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit']],
  [/^(еда|еду|еды|съестн|жратв|пожрать)/, 'FOOD'],
  [/^(семен|семечк)/, ['wheat_seeds']], [/^пшениц/, ['wheat']],
  [/^факел/, ['torch']], [/^верстак/, ['crafting_table']], [/^печь|^печк/, ['furnace']], [/^сундук/, ['chest']], [/^кроват/, [/_bed$/]],
  [/^щит/, ['shield']], [/^лук$/, ['bow']], [/^стрел/, ['arrow']], [/^стекл/, ['glass']], [/^шерст/, [/_wool$/]], [/^ведр/, ['bucket', 'water_bucket']]
];

// -> { name, have, label } | { name: null, label } (знаю предмет, но его нет) | null (слова не знаю — для мозга)
function resolveItem(bot, words) {
  const inv = A.invMap(bot);
  const label = words.join(' ');
  // английские id: iron_ingot, cobblestone
  const joined = words.join('_');
  for (const cand of [joined, ...words]) {
    if (/^[a-z][a-z_]+$/.test(cand) && (inv.has(cand) || (bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[cand])))
      return inv.has(cand) ? { name: cand, have: inv.get(cand), label: cand } : { name: null, label: cand };
  }
  const pick = alts => {
    for (const alt of alts) {
      const names = [...inv.keys()].filter(n => typeof alt === 'string' ? n === alt : alt.test(n)).sort((a, b) => inv.get(b) - inv.get(a));
      if (names.length) return { name: names[0], have: inv.get(names[0]), label };
    }
    return null;
  };
  // инструмент/броня (с материалом: «железная кирка»)
  let tool = null, mat = null;
  for (const t of words) {
    for (const [re, kind] of TOOLS) if (re.test(t)) tool = kind;
    for (const [stem, m] of Object.entries(MATERIAL)) if (t.startsWith(stem)) mat = m;
  }
  if (tool) {
    if (mat) { const n = `${mat}_${tool}`; return inv.has(n) ? { name: n, have: inv.get(n), label } : { name: null, label }; }
    const names = [...inv.keys()].filter(n => n.endsWith('_' + tool)).sort((a, b) => A.matRank(b) - A.matRank(a));
    return names.length ? { name: names[0], have: inv.get(names[0]), label } : { name: null, label };
  }
  let known = false;
  for (const w of words) {
    for (const [re, alts] of NOUNS) {
      if (!re.test(w)) continue;
      known = true;
      let list = alts;
      if (alts === 'FOOD') {
        const foods = (bot.registry && bot.registry.foodsByName) || {};
        list = [...inv.keys()].filter(n => foods[n] && !/^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)$/.test(n) && !n.endsWith('_bucket'))
          .sort((a, b) => inv.get(b) - inv.get(a));
      }
      const r = pick(list);
      if (r) return r;
    }
  }
  return known ? { name: null, label } : null;
}

// ---------- Отправитель: только из события mineflayer ----------
const bareUuid = u => String(u || '').replace(/-/g, '').toLowerCase();
const strOf = v => { try { return v == null ? '' : String(v.toString ? v.toString() : v); } catch (e) { return ''; } };
function senderName(bot, senderUuid, json) {
  if (senderUuid) {
    const u = bareUuid(senderUuid);
    for (const pl of Object.values(bot.players || {})) if (pl && pl.uuid && bareUuid(pl.uuid) === u) return pl.username;
    return null; // uuid есть, но игрока с таким uuid не знаем — не гадаем по тексту
  }
  if (json && json.translate === 'chat.type.text' && Array.isArray(json.with) && json.with[0] != null) return strOf(json.with[0]).trim() || null;
  return null;
}
function messageText(msg, json, who) {
  if (json && Array.isArray(json.with) && json.with[1] != null) return strOf(json.with[1]);
  let s = String(msg == null ? '' : msg);
  const pre = '<' + who + '>';
  if (s.startsWith(pre)) s = s.slice(pre.length);
  return s.trim();
}
const isOwner = name => !!name && String(name).toLowerCase() === OWNER.toLowerCase();

// ---------- Исполнение ----------
// deps можно подменять в тестах
const deps = {
  notes: () => { try { return fs.readFileSync(NOTES, 'utf8'); } catch (e) { return ''; } },
  runnerActive: () => httpJson('GET', RUNNER + '/health', undefined, 1500).then(h => (h && h.runner ? h.runner.active : null), () => null),
  runnerAbort: () => httpJson('POST', RUNNER + '/abort', {}, 4000).catch(() => null)
};
function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8'))); } catch (e) { reject(new Error('не JSON')); } });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('тайм-аут')));
    if (data) req.write(data);
    req.end();
  });
}

const st = ctx => ctx.owner || (ctx.owner = { last: null, chain: Promise.resolve(), lastCmd: null });
function say(ctx, text) {
  const bot = ctx.bot; if (!bot || !ctx.ready) return;
  const line = String(text).replace(/[\r\n]+/g, ' ').replace(/^\/+/, '').trim().slice(0, 200);
  if (!line) return;
  try { bot.chat(line); } catch (e) {}
}
function ownerPlayer(bot) {
  for (const pl of Object.values(bot.players || {})) if (pl && isOwner(pl.username)) return pl;
  return null;
}
// позиция хозяина: сущность, иначе последняя замеченная не старше OWNER_SEEN_MS
function ownerPos(ctx) {
  const pl = ownerPlayer(ctx.bot), o = st(ctx);
  if (pl && pl.entity && pl.entity.position) { const p = pl.entity.position; o.last = { x: p.x, y: p.y, z: p.z, t: Date.now() }; return { pos: p, live: true }; }
  if (o.last && Date.now() - o.last.t <= OWNER_SEEN_MS) return { pos: new Vec3(o.last.x, o.last.y, o.last.z), live: false };
  return null;
}
const fmt = p => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;

// снять с тела всё, что мешает: мозг (в т.ч. выученный навык в исполнителе), автопилот, очередь
async function preempt(ctx, why, pauseMs) {
  const ap = ctx.autopilot;
  if (ap) {
    ap.pausedUntil = Date.now() + pauseMs;
    try { await ap.brainCommand('owner'); } catch (e) {}
  }
  let act = null; try { act = await deps.runnerActive(); } catch (e) {}
  if (act) {
    try { await deps.runnerAbort(); } catch (e) {}
    for (let i = 0; i < 25; i++) { // runner шлёт телу stop, пока гасит запуск: ждём, чтобы он не убил наш новый навык
      let a = null; try { a = await deps.runnerActive(); } catch (e) {}
      if (!a) break; await sleep(200);
    }
  }
  await ctx.tasks.stop(why);
}

function event(ctx, text, cmd, did, extra) {
  ctx.events.push('owner_cmd', { text: String(text).slice(0, 200), cmd, did, ...(extra || {}) });
}

// запуск навыка-задачи; итог — в чат (только провал) и событие
function launch(ctx, text, cmd, name, params, fn, okReply) {
  const p = ctx.tasks.start(name, params, fn, { source: 'owner', wait: true, force: true });
  Promise.resolve(p).then(r => {
    if (!r) return;
    if (r.ok === false) {
      const why = String(r.error || 'не вышло').split('\n')[0];
      if (!/приказ хозяина|stop|прерван|команд/i.test(why)) say(ctx, 'Не вышло: ' + why.slice(0, 120));
      event(ctx, text, cmd, 'не вышло: ' + why.slice(0, 120), { phase: 'end', ok: false });
    } else {
      if (okReply) say(ctx, okReply(r.result || {}));
      event(ctx, text, cmd, 'выполнено', { phase: 'end', ok: true, result: r.result });
    }
  }).catch(() => {});
  return p;
}

async function walkToOwner(ctx, t, near, timeoutMs) {
  const bot = ctx.bot;
  for (let k = 0; k < 4; k++) {
    t.check();
    const o = ownerPos(ctx);
    if (!o) throw new SkillError('не вижу тебя');
    const me = bot.entity.position;
    if (Math.hypot(o.pos.x - me.x, o.pos.z - me.z) <= near + 1 && Math.abs(o.pos.y - me.y) <= 3) return o;
    t.progress('иду к хозяину (' + Math.round(me.distanceTo(o.pos)) + ' м)');
    try { await A.goto(ctx, t, new goals.GoalNear(Math.floor(o.pos.x), Math.floor(o.pos.y), Math.floor(o.pos.z), near), { timeout: timeoutMs, sprint: true }); }
    catch (e) { if (e.aborted) throw e; if (k >= 2) throw e; }
  }
  const o = ownerPos(ctx);
  if (!o) throw new SkillError('не вижу тебя');
  return o;
}

async function doCome(ctx, t) {
  const o = await walkToOwner(ctx, t, 2, 60000);
  const d = ctx.bot.entity.position.distanceTo(o.pos);
  if (d > 5) throw new SkillError(`не дошла: осталось ${Math.round(d)} м`);
  return { arrived: true, d: Math.round(d) };
}

async function doFollow(ctx, t) {
  const bot = ctx.bot;
  let pl = ownerPlayer(bot);
  if (!pl || !pl.entity) { await walkToOwner(ctx, t, 3, 45000); pl = ownerPlayer(bot); }
  if (!pl || !pl.entity) throw new SkillError('не вижу тебя');
  t.progress('иду за ' + OWNER);
  bot.pathfinder.setGoal(new goals.GoalFollow(pl.entity, 2), true);
  const end = Date.now() + FOLLOW_MS; let lost = 0;
  while (Date.now() < end) {
    await t.sleep(1000);
    const cur = ownerPlayer(bot);
    if (cur && cur.entity) { lost = 0; if (cur.entity !== pl.entity) { pl = cur; bot.pathfinder.setGoal(new goals.GoalFollow(pl.entity, 2), true); } }
    else if (++lost >= 30) return { followed: OWNER, ended: 'потеряла тебя из виду' };
  }
  return { followed: OWNER, ended: '10 минут вышли' };
}

async function doGive(ctx, t, item, count) {
  const bot = ctx.bot;
  const o = await walkToOwner(ctx, t, 2, 60000);
  const have = A.invCount(bot, item), n = Math.min(count, have);
  if (n <= 0) throw new SkillError('нет ' + item);
  try { await bot.lookAt(o.pos.offset(0, 1.5, 0), true); } catch (e) {}
  const id = bot.registry.itemsByName[item] && bot.registry.itemsByName[item].id;
  if (id == null) throw new SkillError('неизвестный предмет: ' + item);
  try { await bot.toss(id, null, n); } catch (e) { throw new SkillError(`не смогла выбросить ${item}: ${e.message}`); }
  await t.sleep(200);
  try { bot.setControlState('back', true); await t.sleep(700); } finally { try { bot.clearControlStates(); } catch (e) {} } // отойти, чтобы не подобрать обратно
  return { gave: item, count: n };
}

function statusLine(ctx) {
  const bot = ctx.bot, cur = ctx.tasks.current;
  const ap = ctx.autopilot && ctx.autopilot.status ? ctx.autopilot.status() : null;
  let what;
  if (cur) what = `${cur.name}${cur.progressText ? ' (' + cur.progressText + ')' : ''}${cur.source === 'autopilot' ? ' [автопилот]' : ''}`;
  else if (ap && ap.active && ap.doing) what = ap.doing + ' [автопилот]';
  else what = 'стою, жду';
  return `Сейчас: ${what}. HP ${Math.round(bot.health)}/20, еда ${bot.food}/20.`.slice(0, 200);
}

// Выполнить разобранный приказ. -> { cmd, did } | null
async function execute(ctx, text, c) {
  const bot = ctx.bot;
  const ev = (did, extra) => event(ctx, text, c.cmd, did, { phase: 'start', ...(extra || {}) });
  switch (c.cmd) {
    case 'status': {
      const line = statusLine(ctx); say(ctx, line); ev('ответила статусом: ' + line);
      return { cmd: 'status', did: line };
    }
    case 'mark': {
      const o = ownerPos(ctx);
      if (!o) { say(ctx, 'Не вижу тебя — не знаю, где отметить.'); ev('не вижу хозяина'); return { cmd: 'mark', did: 'нет позиции' }; }
      const q = { x: Math.floor(o.pos.x), y: Math.floor(o.pos.y), z: Math.floor(o.pos.z) };
      let saved = true;
      try { await require('./skills/basic').mark(ctx, null, { name: 'owner_mark', x: q.x, y: q.y, z: q.z, note: 'хозяин: строить тут (' + OWNER + ')' }); } catch (e) { saved = false; }
      say(ctx, `Запомнила место: ${fmt(o.pos)} (метка owner_mark). Что строить — решит мозг.`);
      ev(saved ? `метка owner_mark сохранена: ${fmt(o.pos)}. Решай ты (мозг): строить тут или нет` : 'метку сохранить не удалось', { at: [q.x, q.y, q.z] });
      return { cmd: 'mark', did: 'owner_mark ' + fmt(o.pos) };
    }
    case 'stop': {
      await preempt(ctx, 'приказ хозяина: стой', STOP_PAUSE_MS);
      try { bot.pathfinder.setGoal(null); bot.clearControlStates(); } catch (e) {}
      say(ctx, 'Стою. Автопилот на паузе 2 мин.');
      ev('остановила всё, автопилот на паузе 2 мин');
      return { cmd: 'stop', did: 'стоп' };
    }
    case 'come': {
      const o = ownerPos(ctx);
      if (!o) { say(ctx, 'Не вижу тебя — не знаю, куда идти.'); ev('не вижу хозяина'); return { cmd: 'come', did: 'нет позиции' }; }
      await preempt(ctx, 'приказ хозяина: ко мне', SHORT_PAUSE_MS);
      say(ctx, 'Иду к тебе.'); ev('иду к хозяину ' + fmt(o.pos) + (o.live ? '' : ' (по последней позиции)'));
      launch(ctx, text, 'come', 'owner_come', {}, t => doCome(ctx, t), () => 'Я здесь.');
      return { cmd: 'come', did: 'иду' };
    }
    case 'follow': {
      const o = ownerPos(ctx);
      if (!o) { say(ctx, 'Не вижу тебя — за кем идти?'); ev('не вижу хозяина'); return { cmd: 'follow', did: 'нет позиции' }; }
      await preempt(ctx, 'приказ хозяина: за мной', SHORT_PAUSE_MS);
      say(ctx, 'Иду за тобой (до 10 мин или пока не скажешь «стой»).'); ev('следую за хозяином до «стой» или 10 мин');
      launch(ctx, text, 'follow', 'owner_follow', {}, t => doFollow(ctx, t), r => r.ended ? 'Хватит следовать: ' + r.ended + '.' : null);
      return { cmd: 'follow', did: 'следую' };
    }
    case 'home': {
      const base = require('./autopilot').parseBase(deps.notes());
      if (!base) { say(ctx, 'Не знаю, где база: в заметках нет строки «База:».'); ev('нет строки «База:» в notes.md'); return { cmd: 'home', did: 'нет базы' }; }
      await preempt(ctx, 'приказ хозяина: домой', SHORT_PAUSE_MS);
      say(ctx, `Иду на базу (${Math.round(base.x)} ${Math.round(base.y)} ${Math.round(base.z)}).`); ev(`иду на базу ${Math.round(base.x)} ${Math.round(base.y)} ${Math.round(base.z)}`, { at: [base.x, base.y, base.z] });
      launch(ctx, text, 'home', 'goto', { x: base.x, y: base.y, z: base.z, r: base.r, timeout: 420, by: 'owner' },
        t => require('./autopilot').baseTravel(ctx, t, { x: base.x, y: base.y, z: base.z, r: Math.min(base.r, 8), timeout: 420 }), () => 'Я на базе.');
      return { cmd: 'home', did: 'иду на базу' };
    }
    case 'sleep': {
      await preempt(ctx, 'приказ хозяина: спать', SHORT_PAUSE_MS);
      say(ctx, 'Иду спать.'); ev('запустила навык sleep');
      launch(ctx, text, 'sleep', 'sleep', {}, t => require('./skills/survival').sleep(ctx, t, {}), null);
      return { cmd: 'sleep', did: 'sleep' };
    }
    case 'give': {
      const r = resolveItem(bot, c.item);
      if (!r) return null; // предмета не знаем — пусть решает мозг
      if (!r.name || !r.have) { say(ctx, `Нет у меня: ${r.label}.`); ev(`нет предмета: ${r.label}`); return { cmd: 'give', did: 'нет ' + r.label }; }
      if (!ownerPos(ctx)) { say(ctx, 'Не вижу тебя — некому отдать.'); ev('не вижу хозяина'); return { cmd: 'give', did: 'нет позиции' }; }
      const n = Math.min(c.all ? r.have : c.count, r.have);
      await preempt(ctx, 'приказ хозяина: дай ' + r.name, SHORT_PAUSE_MS);
      say(ctx, `Несу: ${r.name} x${n}${n < (c.all ? r.have : c.count) ? ' (больше нет)' : ''}.`); ev(`несу ${r.name} x${n}`, { item: r.name, count: n });
      launch(ctx, text, 'give', 'owner_give', { item: r.name, count: n }, t => doGive(ctx, t, r.name, n), null);
      return { cmd: 'give', did: `${r.name} x${n}` };
    }
  }
  return null;
}

// Сообщение игрока: обрабатываем, если оно от хозяина и распознано. Последовательно (по цепочке).
function handleText(ctx, text) {
  if (!ctx.ready || !ctx.bot || !ctx.bot.entity) return Promise.resolve(null);
  const c = parsePhrase(text);
  if (!c) return Promise.resolve(null);
  const o = st(ctx);
  const run = o.chain.then(() => execute(ctx, text, c)).catch(e => { console.log('[owner] ошибка:', e && e.message); return null; });
  o.chain = run.catch(() => {});
  return run;
}

// Событие mineflayer 'messagestr': (msg, position, jsonMsg, senderUuid)
function onMessage(ctx, msg, position, json, senderUuid) {
  const bot = ctx.bot; if (!bot) return Promise.resolve(null);
  if (position !== 'chat') return Promise.resolve(null);             // системные строки/экшн-бар — не чат игрока
  const who = senderName(bot, senderUuid, json);
  if (!isOwner(who) || who === bot.username) return Promise.resolve(null);
  return handleText(ctx, messageText(msg, json, who));
}

function attach(ctx, session) {
  const bot = session.bot || ctx.bot;
  st(ctx);
  bot.on('messagestr', (msg, position, json, senderUuid) => { onMessage(ctx, msg, position, json, senderUuid).catch(() => {}); });
  session.timers.push(setInterval(() => { if (!session.ended && ctx.bot === bot) { try { ownerPos(ctx); } catch (e) {} } }, 1000));
}

module.exports = { attach, onMessage, handleText, parsePhrase, normalize, resolveItem, senderName, messageText, statusLine, deps, OWNER, ownerPos };
