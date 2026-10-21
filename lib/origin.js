// «Кто отдал действие» (для чёрного ящика и учёта): brain (мозг по HTTP), autopilot, reflex, owner, skill:<имя> (выученный навык
// через исполнитель :3200). Источник навыка говорит сам исполнитель: worker.js кладёт в команду поле src: "skill:<имя>".
// Верим src только запросу без User-Agent (так ходит исполнитель; curl мозга присылает User-Agent) и только формату skill:<имя>.
// Запрос программы аудита (X-Observer: 1) источником действий не бывает: команды от него тело не принимает (см. bot.js).
'use strict';

const SKILL_RE = /^skill:[a-z][a-z0-9_]{1,39}$/;

// -> { source, by }. source — грубый (brain|autopilot): по нему работают очередь и вытеснение; by — подробный.
function resolve({ internal, autopilotOwnsRunner, src }) {
  if (internal && autopilotOwnsRunner) return { source: 'autopilot', by: 'autopilot' };
  if (internal && typeof src === 'string' && SKILL_RE.test(src)) return { source: 'brain', by: src };
  return { source: 'brain', by: 'brain' };
}

module.exports = { resolve, SKILL_RE };
