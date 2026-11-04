// Поддельное тело FlyBot для test/hardcore_fly.js: HTTP /snapshot и /events на порту из argv[5], как bot.js.
// Сценарий по секундам: брёвна → верстак и кирка → еда → смерть (зритель). Проверяет, что запрос пришёл как наблюдатель.
'use strict';
const http = require('http');
const port = +process.argv[5];
const t0 = Date.now();
let observerOnly = true;
const inv = [
  [],
  [{ name: 'oak_log', count: 5 }],
  [{ name: 'oak_log', count: 1 }, { name: 'wooden_pickaxe', count: 1 }, { name: 'crafting_table', count: 1 }],
  [{ name: 'wooden_pickaxe', count: 1 }, { name: 'bread', count: 5 }]
];
const BR = !!process.env.HC_BR_PREFIX;   // баттл-рояль (1в): локатор в снимке, команды охотника, сообщение об убийстве
const cmds = [];
const events = [{ id: 1, type: 'task_started', name: 'eat', by: 'autopilot' }, { id: 2, type: 'task_done', name: 'collect' },
  ...(BR ? [{ id: 4, type: 'chat', kind: 'system', text: `HC_9 was slain by ${process.argv[4]} using Stone Sword` },
    { id: 5, type: 'chat', kind: 'system', text: `HC_9 was slain by ${process.argv[4]} using Stone Sword` }] : []),
  { id: 3, type: 'chat', kind: 'system', text: `${process.argv[4]} was slain by ${BR ? 'HC_8' : 'Zombie'}` }].sort((a, b) => a.id - b.id);
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/cmd') {   // команда охотника: запомнить, отдать ok
    let b = ''; req.on('data', d => b += d);
    req.on('end', () => { try { cmds.push({ ...JSON.parse(b), ua: req.headers['user-agent'] || null }); } catch (e) {} res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    return;
  }
  if (req.headers['x-observer'] !== '1') observerOnly = false;
  const sec = Math.floor((Date.now() - t0) / 1000);
  const step = Math.min(sec, 5);
  const send = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/snapshot')) {
    if (sec < 1) return send({ ready: false });
    return send({ ready: true, health: step >= 5 ? 0 : 20, food: 18, position: { x: 1, y: 64, z: 2 }, time: 1000 + sec * 20, gameMode: step >= 5 ? 'spectator' : 'survival',
      inventory: (inv[Math.min(step - 1, 3)] || []).concat(BR ? [{ name: 'stone_sword', count: 1 }] : []), sheltered: { closed: step === 2 }, eyes: { time: { day: 0, tod: 1000 + sec * 20 }, enemies: [] }, autopilot: { on: true, observerOnly, cmds, runnerUrl: process.env.RUNNER_URL || null, mcVersion: process.env.MC_VERSION || null },
      ...(BR ? { heldItem: { name: 'stone_sword' }, locator: [{ name: 'HC_9', d: 8, at: [9, 64, 2], onBar: true, hidden: null, gamemode: 0 }, { name: 'HC_5', d: 50, at: [50, 64, 2], onBar: false, hidden: null, gamemode: 0 }] } : {}) });
  }
  // убийство HC_9 — не раньше 3-й секунды: сначала охотник должен её увидеть и начать бой (мёртвую он уже не преследует)
  if (req.url.startsWith('/events')) { const since = +(/since=(\d+)/.exec(req.url) || [0, 0])[1]; return send({ events: events.filter(e => e.id > since && (sec >= 3 || !/HC_9 was slain/.test(e.text || ''))), lastId: 3 }); }
  send({});
}).listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 20000);
