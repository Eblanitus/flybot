// Учебник мозга (brain/lessons.md) поменялся -> событие lessons_updated (тихое: никого не будит, мозг увидит его в /events
// и вместе со следующим важным событием в /wait). Это факт про файл, а не решение: учебник пишет только учитель.
'use strict';
const fs = require('fs');

function lessonsWatch(file, push) {
  const stat = () => { try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch (e) { return null; } };
  let last = stat();                       // при старте тела только запоминаем — событие лишь на настоящую правку
  return {
    check() {
      const now = stat();
      const changed = (now && !last) || (now && last && (now.mtimeMs !== last.mtimeMs || now.size !== last.size));
      last = now;
      if (!changed) return null;
      let lines = null; try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch (e) {}
      return push('lessons_updated', { file: 'brain/lessons.md', lines, hint: 'учебник обновлён учителем — перечитай brain/lessons.md' });
    }
  };
}

module.exports = { lessonsWatch };
