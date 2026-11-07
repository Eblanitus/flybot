// Карточка состояния для текущего проекта-координатора в Claude Desktop.
//   node tools/coordinator_state.js
// Пишет docs/coordinator_state.md из git, кода и конфигов. Факты, не пересказы чатов.
// Новый проект и второй координатор не создаются. Ничего не запускает и не меняет в игре.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'coordinator_state.md');

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim(); }
  catch (e) { return ''; }
}
function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; } }
function json(p) { const s = read(p); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
function kb(p) { try { return Math.round(fs.statSync(path.join(ROOT, p)).size / 1024) + ' КБ'; } catch (e) { return 'нет'; } }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

// хвост jsonl без чтения всего файла
function lastJsonLine(p, maxRead = 65536) {
  let fd;
  try { fd = fs.openSync(path.join(ROOT, p), 'r'); } catch (e) { return null; }
  try {
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - maxRead);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch (e) { /* обрезанная строка */ }
    }
    return null;
  } finally { fs.closeSync(fd); }
}

let VER = 'нет';
try { VER = require(path.join(ROOT, 'hardcore', 'points.js')).VER; } catch (e) { /* модуль не прочитался */ }
const cfg = json('hardcore/config.json') || {};
const teacher = read('docs/teacher_stage2.md') || '';
const goal = read('docs/goal_path.md') || '';
const stand = read('hardcore/stand.js') || '';
const teachA = /const TEACH_A = (\d+)/.exec(stand);
const staleScheme = /А \(HC_1.HC_5\)/.test(goal);
const teacherOld = /controlBots: 2|А — HC_1/.test(teacher);
const staleSkill = exists('brain/learned/hc_night_mine_v1.js');
const branch = git(['branch', '--show-current']) || '(detached)';
const last = git(['log', '-1', '--format=%h|%ad|%s', '--date=iso']);
const [hash, when, msg] = (last || '||').split('|');
const total = git(['rev-list', '--count', 'HEAD']) || '?';
const status = git(['status', '--short']).split(/\r?\n/).filter(Boolean);
const modified = status.filter(s => /^ ?M|^M |^ ?A|^A /.test(s));
const untracked = status.filter(s => s.startsWith('?? '));
const backupBranch = /^backup-/.test(branch);
const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.js')).length;
const world = lastJsonLine('hardcore/data/worlds.jsonl');
const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).replace(' ', ' ');

const L = [];
L.push('# Состояние FlyBot / хардкор-стенд');
L.push('');
L.push(`Снимок: ${stamp}. Источник: git, код, конфиги. Не пересказ чатов и не проектная память.`);
L.push('Карточка старше суток — не источник. Обновление: `node tools/coordinator_state.js`.');
L.push('');
L.push('## Репозиторий');
L.push('');
L.push(`- Ветка: \`${branch}\``);
L.push(`- Последний коммит: \`${hash}\`, ${when}, «${msg}»`);
L.push(`- Коммитов всего: ${total}. Тестовых файлов: ${tests} (сколько зелёных — только после \`npm test\`).`);
L.push(`- Незакоммиченных правок отслеживаемого кода: ${modified.length ? modified.length + ' — ' + modified.join(', ') : 'нет'}.`);
L.push(`- Не отслеживается git: ${untracked.length ? untracked.map(s => s.slice(3)).join(', ') : 'нет'}.`);
if (backupBranch) L.push(`- Внимание: ветка \`${branch}\` — резервная. Перед обсуждением проверить, не переключились ли на рабочую ветку (PR #13).`);
L.push('');
L.push('## Что работает прямо сейчас');
L.push('');
L.push(`- Очки жизни: \`points.VER = ${VER}\` (\`hardcore/points.js\`). Штраф за смерть −(7 − прожито игровых дней), ночь больше не +1.`);
L.push('- Опыт решателя: `hardcore/data/shared/decider_v2.json`; база и учитель берут только миры `pointsVer 2`.');
if (teachA) {
  L.push(`- Учитель в коде ЭТОЙ ветки: \`TEACH_A = ${teachA[1]}\`, деление А/Б, вердикт «А против Б». Локальный \`config.json\` при этом \`controlBots: ${cfg.controlBots ?? 3}\`. Схемы из разных версий — перед обсуждением сверить ветку.`);
} else {
  L.push(`- Учитель: \`controlBots: ${cfg.controlBots ?? 3}\` при \`bots: ${cfg.bots ?? 10}\` — учащиеся HC_1–HC_${(cfg.bots ?? 10) - (cfg.controlBots ?? 3)} с правкой, остальные контроль. Второго деления нет, вердикт «до правки против после».`);
}
L.push(`- Стенд (локальный \`hardcore/config.json\`): stage2=${cfg.stage2 ?? '?'}, pool=${cfg.pool ?? '?'}, brViewDistance=${cfg.brViewDistance ?? '?'}, ботов ${cfg.bots ?? '?'}.`);
L.push(`- Последний мир в \`worlds.jsonl\`: ${world ? world.id : 'нет данных'}.`);
L.push('');
L.push('## Что устарело');
L.push('');
L.push(`- \`docs/goal_path.md\` (${kb('docs/goal_path.md')}): ${staleScheme ? 'всё ещё описывает группы А/Б и контроль HC_9–HC_10 — не цитировать как состояние' : 'схема групп обновлена, сверить с кодом'}.`);
L.push(`- \`docs/stage2_plan.md\` (${kb('docs/stage2_plan.md')}): пошаговый план для Haiku, в основном отработан. Не состояние.`);
L.push(`- \`brain/learned/hc_night_mine_v1.js\`: ${staleSkill ? 'мусорная копия «из истории», подменяет починенный навык, не в git' : 'удалён'}.`);
L.push(`- \`docs/teacher_stage2.md\`: ${teacherOld ? 'старая схема А/Б/контроль 5+3+2 — в этой ветке не соответствует локальному config.json' : (/второго деления нет/i.test(teacher) ? 'схема 7+3, до/после' : 'проверить схему групп')}.`);
L.push('');
L.push('## Правило');
L.push('');
L.push('Код важнее документа, документ важнее памяти, память важнее пересказа. Перед выводом — `git status` и `git log -1`.');
L.push('Один координатор, тот же чат. Карточка — снимок фактов, а не история переписки.');

const text = L.join('\n') + '\n';
const tmp = OUT + '.tmp' + process.pid;
fs.writeFileSync(tmp, text);
fs.renameSync(tmp, OUT);
console.log('STATE.md обновлён: ' + OUT + ' (' + Buffer.byteLength(text) + ' байт)');
console.log('ветка ' + branch + ', коммит ' + hash + ', незакоммиченных правок ' + modified.length + ', points.VER ' + VER);
