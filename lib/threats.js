// Враги-игроки: кто меня убивал (помним в data/killers.json) или бил недавно (aggressors).
// Следим, не приближается ли такой игрок, и будим мозг событием danger kind:"enemy_player".
// Игроки видны как игроку: в пределах дальности прорисовки сущностей; наблюдатели (spectator) не в счёт.
'use strict';
const fs = require('fs');
const path = require('path');
const { dirName } = require('./util');

const FILE = path.join(__dirname, '..', 'data', 'killers.json');
const RANGE = 48;        // дальше сервер игроков обычно не присылает
const NEAR = 24;         // ближе — тревога, даже если стоит на месте
const COOLDOWN = 20000;  // одна тревога на врага раз в 20 с (если не подошёл заметно ближе)
const r1 = x => Math.round(x * 10) / 10;

function loadKillers() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }
function saveKillers(k) { fs.promises.writeFile(FILE, JSON.stringify(k, null, 2)).catch(() => {}); }

// Смерть: запомнить место (для recover) и убийцу-игрока
function onDeath(ctx, { message, at }) {
  ctx.lastDeath = { at, ts: Date.now() };
  const bot = ctx.bot;
  const m = /\bby (\S+)/.exec(message || '');
  if (!m || !bot) return;
  const name = m[1];
  if (!bot.players || !bot.players[name]) return; // убил моб, а не игрок
  const k = ctx.killers || (ctx.killers = loadKillers());
  k[name] = { kills: ((k[name] && k[name].kills) || 0) + 1, last: new Date().toISOString() };
  saveKillers(k);
}

function isThreat(ctx, name) {
  const k = ctx.killers || (ctx.killers = loadKillers());
  if (k[name]) return 'убивал меня ' + k[name].kills + ' р.';
  const a = ctx.aggressors && ctx.aggressors[String(name).toLowerCase()];
  if (a && Date.now() - a.lastHit < 120000) return 'бил меня';
  return null;
}

// Видимые враги-игроки сейчас: [{name, d, dir, why, approaching}]
function list(ctx) {
  const bot = ctx.bot;
  if (!bot || !bot.entity) return [];
  const me = bot.entity.position;
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e.type !== 'player' || e === bot.entity || !e.username || !e.position) continue;
    const pl = bot.players[e.username];
    if (pl && pl.gamemode === 3) continue; // наблюдатель
    const why = isThreat(ctx, e.username);
    if (!why) continue;
    const d = e.position.distanceTo(me);
    if (d > RANGE) continue;
    const prev = watch.get(e.username);
    out.push({ name: e.username, d: r1(d), dir: dirName(me, e.position), why, approaching: !!(prev && d < prev.d - 1) });
  }
  return out.sort((a, b) => a.d - b.d);
}

const watch = new Map(); // имя -> {d, alarmAt, alarmD}

function attach(ctx, session) {
  ctx.killers = loadKillers();
  const tick = setInterval(() => {
    const bot = ctx.bot;
    if (session.ended || !ctx.ready || !bot || !bot.entity) return;
    const seen = new Set();
    for (const th of list(ctx)) {
      seen.add(th.name);
      const w = watch.get(th.name) || { d: Infinity, alarmAt: 0, alarmD: Infinity };
      const firstSight = w.d === Infinity;
      const closer = th.d < w.alarmD - 8;
      if ((firstSight || (th.d <= NEAR && th.approaching) || closer) && (Date.now() - w.alarmAt > COOLDOWN || closer)) {
        w.alarmAt = Date.now(); w.alarmD = th.d;
        ctx.events.push('danger', { kind: 'enemy_player', name: th.name, d: th.d, dir: th.dir, why: th.why, approaching: th.approaching, hp: Math.round(bot.health) });
      }
      w.d = th.d;
      watch.set(th.name, w);
    }
    for (const n of [...watch.keys()]) if (!seen.has(n)) watch.delete(n); // ушёл из вида — при возвращении снова тревога
  }, 1000);
  if (session.timers) session.timers.push(tick);
  return tick;
}

module.exports = { attach, onDeath, list, isThreat };
