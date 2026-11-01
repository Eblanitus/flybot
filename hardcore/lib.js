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
    'server-port': cfg.port,
    'server-ip': '127.0.0.1',     // только этот ПК, наружу не открыт
    'online-mode': 'false',       // боты входят без аккаунта — потому и server-ip только локальный
    'enable-command-block': 'false',
    'spawn-protection': '0',
    'white-list': 'false',
    'max-players': Math.max(10, cfg.bots + 2),
    'enable-rcon': 'false',
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
  let m = /(?:slain|shot|killed|blown up|fireballed|stung|impaled|squashed|skewered|pummeled) by (?:an? )?([A-Za-z_ ]+?)(?: using| whilst|$)/.exec(msg);
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
  const med = lens.length ? (lens.length % 2 ? lens[(lens.length - 1) / 2] : (lens[lens.length / 2 - 1] + lens[lens.length / 2]) / 2) : 0;
  return {
    bots: cards.length, deaths: by('death'), timeouts: by('timeout'), disconnects: by('disconnect'), crashes: by('crash'),
    alreadyDead: by('already_dead'), firstNight: cards.filter(c => c.firstNightSurvived).length, medianLifeSec: Math.round(med)
  };
}

module.exports = { makeSeed, patchProperties, worldProperties, worldId, WORLD_ID_RE, pruneList, isInside, countCheats, deathMessage, causeOf, firstNightEnd, summarizeWorld, stamp };
