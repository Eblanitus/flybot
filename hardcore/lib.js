// Хардкор-стенд, этап 1а (docs/goal_path.md): чистые функции без игры и без файлов — их проверяет test/hardcore.js.
'use strict';
const path = require('path');

// Случайный сид: целое со знаком в пределах long Java (берём 48 бит — хватает и не теряется в Number).
function makeSeed(rand = Math.random) {
  const hi = Math.floor(rand() * 0x1000000), lo = Math.floor(rand() * 0x1000000);
  const v = hi * 0x1000000 + lo;            // 0 .. 2^48-1
  return String(rand() < 0.5 ? -v : v);
}

// server.properties: меняем только нужные ключи, остальные строки и комментарии — как были; нет ключа — дописываем в конец.
function patchProperties(text, kv) {
  const lines = String(text || '').split(/\r?\n/);
  const left = new Map(Object.entries(kv).map(([k, v]) => [k, String(v)]));
  const out = lines.map(l => {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]/.exec(l);
    if (!m || !left.has(m[1])) return l;
    const v = left.get(m[1]); left.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) out.push(`${k}=${v}`);
  return out.join('\n') + '\n';
}

// Ключи, которые стенд ставит каждому миру. Честный хардкор: сложность всегда hard, режим выживания, без командных блоков.
function worldProperties(cfg, seed) {
  return {
    'hardcore': 'true',
    'difficulty': 'hard',
    'gamemode': 'survival',
    'force-gamemode': 'true',
    'level-seed': seed,
    'level-name': cfg.levelName,
    'level-type': cfg.levelType || 'minecraft\\:large_biomes',   // большие биомы (хозяин 04.11); в .properties двоеточие экранируется
    'server-port': cfg.port,
    'server-ip': '127.0.0.1',     // только этот ПК, наружу не открыт
    'online-mode': 'false',       // боты входят без аккаунта — потому и server-ip только локальный
    'enable-command-block': 'false',
    'spawn-protection': '0',
    'white-list': 'false',
    'max-players': Math.max(10, cfg.bots + 2),
    'enable-rcon': 'false',
    'pvp': 'true',
    // баттл-рояль (1в): локатор мухи видит только тех, чья позиция дошла до бота, — дальность прорисовки на всю расстановку
    ...(cfg.battleRoyale && cfg.botMode !== '1a' ? { 'view-distance': cfg.brViewDistance || 20 } : {}),
    'motd': 'flybot hardcore stand'
  };
}

const pad = n => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const WORLD_ID_RE = /^w\d{8}-\d{6}-\d+$/;
const worldId = (d, n) => `w${stamp(d)}-${n}`;

// Какие папки архива удалить, чтобы осталось keep последних. Трогаем только папки стенда (по имени), чужие — никогда.
function pruneList(names, keep) {
  const own = names.filter(n => WORLD_ID_RE.test(n)).sort();
  return own.length > keep ? own.slice(0, own.length - keep) : [];
}

// child лежит строго внутри parent (не равен ему) — проверка перед переносом папки мира.
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Чит-команды в журнале сервера. Консоль стенда команд не шлёт (кроме stop); игрок без оператора их выполнить не может,
// но попытку всё равно считаем — так видно, если кто-то полез.
const CHEAT_RE = /(issued server command: \/|\[(?:Server|[A-Za-z0-9_]{3,16}): (?:Set|Gave|Teleported|Changed|Game rule|Applied|Summoned|Killed)\b)/;
const CHEAT_CMD_RE = /\/(give|tp|teleport|gamemode|gamerule|effect|time|weather|kill|xp|experience|enchant|summon|setblock|fill|clone|op|spreadplayers|difficulty|defaultgamemode|item|attribute)\b/;
function countCheats(lines) {
  let n = 0;
  for (const l of lines) {
    if (/issued server command: \//.test(l)) { if (CHEAT_CMD_RE.test(l)) n++; }
    else if (CHEAT_RE.test(l)) n++;
  }
  return n;
}

// Сообщение о смерти из журнала сервера: «[..] [Server thread/INFO]: HC_1 was slain by Zombie».
const DEATH_WORDS = /\b(was |were |died|drowned|blew up|burned|fell|hit the ground|starved|suffocated|froze|withered|went up in flames|walked into|tried to swim|experienced kinetic|discovered the floor|left the confines|was killed|didn't want to live)/;
function deathMessage(lines, nick) {
  const re = new RegExp(`(?:^|\\]: )(${nick.replace(/[^A-Za-z0-9_]/g, '')} .+)$`);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m && DEATH_WORDS.test(m[1]) && !/ joined the game| left the game|issued server command/.test(m[1])) return m[1].trim();
  }
  return null;
}

// Короткая причина из сообщения о смерти: «Zombie», «fall», «starve»… Для сводки, полное сообщение тоже хранится.
function causeOf(msg) {
  if (!msg) return null;
  let m = /(?:slain|shot|killed|blown up|fireballed|stung|impaled|squashed|skewered|pummeled) by (?:an? )?([A-Za-z0-9_ ]+?)(?: using| whilst|$)/.exec(msg);
  if (m) return m[1].trim();
  const table = [[/fell|hit the ground|fell from/, 'fall'], [/drowned/, 'drown'], [/starved/, 'starve'], [/lava/, 'lava'],
    [/burned|flames|fire/, 'fire'], [/suffocated/, 'suffocate'], [/blew up/, 'explosion'], [/froze/, 'freeze'], [/cactus|pricked/, 'cactus']];
  for (const [re, c] of table) if (re.test(msg)) return c;
  return 'other';
}

// Конец первой полной ночи после появления (тики возраста мира). Ночь — 13000..23000 по времени суток.
// Появился днём (до 13000) — эта ночь и считается; появился ночью — считается следующая.
function firstNightEnd(age0, tod0) {
  const t = ((tod0 % 24000) + 24000) % 24000;
  return t <= 13000 ? age0 + (23000 - t) : age0 + (24000 - t) + 23000;
}

// Сводка мира по карточкам — одна строка worlds.jsonl.
function summarizeWorld(cards) {
  const by = r => cards.filter(c => c.result === r).length;
  const lens = cards.map(c => c.lifeSec || 0).sort((a, b) => a - b);
  const median = a => a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
  const med = median(lens);
  const steps = cards.map(c => c.topStep || 0).sort((a, b) => a - b);
  return {
    bots: cards.length, deaths: by('death'), timeouts: by('timeout'), disconnects: by('disconnect'), crashes: by('crash'),
    alreadyDead: by('already_dead'), firstNight: cards.filter(c => c.firstNightSurvived).length, medianLifeSec: Math.round(med),
    topStepMax: steps.length ? steps[steps.length - 1] : 0, medianTopStep: median(steps),
    stuck: cards.reduce((n, c) => n + (Array.isArray(c.stuck) ? c.stuck.length : 0), 0),
    deathsSoonAfterExit: cards.filter(c => c.deathSoonAfterExit).length,
    // баттл-рояль (1в): убийства муха → муха, сколько оружием, у кого больше всех
    ...(cards.some(c => c.br) ? (() => {
      const kills = cards.reduce((n, c) => n + (c.killCount || 0), 0);
      const top = cards.slice().sort((a, b) => (b.killCount || 0) - (a.killCount || 0))[0];
      return { kills, killsArmed: cards.reduce((n, c) => n + (c.killsArmed || 0), 0), killsByNick: Object.fromEntries(cards.map(c => [c.nick, c.killCount || 0])), topKiller: top && top.killCount ? top.nick : null };
    })() : {}),
    // этап 2: очки жизни — среднее по всем мухам и по группам (group: learn / control; до Б11 группы нет — 'all')
    ...(cards.some(c => c.pointsTotal != null) ? (() => {
      const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null;
      const pts = c => Number(c.pointsTotal) || 0;
      const groups = {};
      for (const c of cards) (groups[c.group || 'all'] = groups[c.group || 'all'] || []).push(pts(c));
      return { pointsAvg: avg(cards.map(pts)), pointsByNick: Object.fromEntries(cards.map(c => [c.nick, pts(c)])),
        pointsByGroup: Object.fromEntries(Object.entries(groups).map(([g, a]) => [g, avg(a)])) };
    })() : {})
  };
}

// Хроника жизни для ленты мира: события со временем мира (wt — полное время суток мира в тиках, у всех ботов одного мира общее).
// observe() раз в секунду сам замечает: HP упал до 4 и ниже (снова — только после HP > 8), началась ночь, ночь пережита, новый день.
// note() — события, которые знает бот: поел, бежит от врага, смерть. Не больше MAX событий, чтобы карточка не распухала.
function makeChronicle(max = 300) {
  const events = [];
  let lowArmed = true, lastTod = null, lastDay = null, inNight = false, nights = 0;
  const push = (wt, kind, text) => { if (events.length < max) events.push({ wt: wt == null ? null : Math.round(wt), kind, text }); };
  return {
    events,
    note: push,
    nights: () => nights,
    observe(f) {
      if (f.wt == null) return;
      const tod = ((f.wt % 24000) + 24000) % 24000, day = Math.floor(f.wt / 24000) + 1;
      if (lastDay != null && day > lastDay) push(f.wt, 'day', `день ${day}`);
      if (lastTod != null) {
        if (!inNight && tod >= 13000 && tod < 23000) { inNight = true; push(f.wt, 'night', 'ночь'); }
        if (inNight && (tod >= 23000 || tod < 13000)) { inNight = false; nights++; push(f.wt, 'night_survived', nights === 1 ? 'пережил первую ночь' : `пережил ночь ${nights}`); }
      } else inNight = tod >= 13000 && tod < 23000;
      if (f.hp != null) {
        if (lowArmed && f.hp <= 4 && f.hp > 0) { lowArmed = false; push(f.wt, 'lowhp', `HP ${f.hp}`); }
        else if (f.hp > 8) lowArmed = true;
      }
      lastTod = tod; lastDay = day;
    }
  };
}

// Ступени 1–6 лестницы (docs/goal_path.md, раздел 1) по инвентарю: s.inv — {имя: штук}; s.food — штук годной еды;
// s.tablePlaced — верстак был (ставил или держал); s.nightSurvived — пережил ночь. Взятая ступень не теряется — это помнит makeLadder.
const PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const SWORDS_STONE_UP = ['stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword'];
function stepsNow(s) {
  const inv = s.inv || {}, has = n => (inv[n] || 0) > 0;
  const logs = Object.keys(inv).filter(n => /_(log|stem)$/.test(n) && !n.startsWith('stripped_')).reduce((a, n) => a + inv[n], 0);
  const r = [];
  if (logs >= 4) r.push(1);
  if (has('crafting_table') || s.tablePlaced) r.push(2);
  if (PICKS.some(has)) r.push(3);
  if (PICKS.slice(1).some(has) && SWORDS_STONE_UP.some(has)) r.push(4);
  if ((s.food || 0) >= 5) r.push(5);
  if (s.nightSurvived) r.push(6);
  return r;
}
const STEP_TEXT = { 1: '4 бревна', 2: 'верстак', 3: 'деревянная кирка', 4: 'каменные кирка и меч', 5: 'запас еды 5', 6: 'пережил первую ночь' };
function makeLadder() {
  const reached = {};   // ступень → { lifeSec, wt }
  return {
    reached,
    update(s, lifeSec, wt) {   // новые ступени (их пишут в ленту)
      const fresh = [];
      for (const n of stepsNow(s)) if (!reached[n]) { reached[n] = { lifeSec, wt: wt == null ? null : Math.round(wt) }; fresh.push(n); }
      return fresh;
    },
    top() { const k = Object.keys(reached).map(Number); return k.length ? Math.max(...k) : 0; }
  };
}

// подпись группы мухи для ленты и логов (этап 2): учится / контроль; при проверке правки учителя (В2) — с правкой (А) / без правки (Б)
const GROUP_TEXT = { learn: 'учится', control: 'контроль' };
function groupLabel(c) {
  const g = c && GROUP_TEXT[c.group];
  const t = c && c.teachGroup ? (c.teachGroup === 'A' ? `правка ${c.teach} (А)` : `без правки ${c.teach} (Б)`) : null;
  return [g, t].filter(Boolean).join(', ');
}

module.exports = { DEATH_WORDS, stepsNow, makeLadder, STEP_TEXT, makeChronicle, makeSeed, patchProperties, worldProperties, worldId, WORLD_ID_RE, pruneList, isInside, countCheats, deathMessage, causeOf, firstNightEnd, summarizeWorld, stamp, GROUP_TEXT, groupLabel };
