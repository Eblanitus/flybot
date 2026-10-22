// Цель и база мозга из brain/notes.md (только чтение) и руки «дойти до базы скачками».
// Это ядро: им пользуются и поведение (автопилот, behavior/autopilot.js), и приказы хозяина (lib/owner.js).
'use strict';
const { goals } = require('mineflayer-pathfinder');
const { SkillError } = require('./util');
const A = require('./actions');

// ---------- Цель мозга ----------
// В notes.md раздел «## Текущая цель» может содержать машинную строку «Автопилот: <навык> ключ=значение …»
// (например «Автопилот: collect block=stone count=60»). Днём автопилот продолжает её сам, пока мозг молчит.
function parseGoal(text) {
  const lines = String(text || '').split(/\r?\n/);
  let i = lines.findIndex(l => /^##\s*Текущая цель/.test(l));
  if (i < 0) return null;
  let line = null;
  for (i++; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = /^[\s>*_-]*Автопилот\s*:[\s*]*(.+)$/i.exec(lines[i]);
    if (m) { line = m[1]; break; }
  }
  if (!line) return null;
  const toks = line.replace(/[`*]/g, ' ').trim().split(/\s+/);
  const name = toks.shift();
  if (!name || !/^[A-Za-z_][\w-]*$/.test(name)) return null;
  const params = {};
  for (const t of toks) {
    const k = t.indexOf('=');
    if (k <= 0) continue;
    const v = t.slice(k + 1);
    let val = v; try { if (/^(-?\d|true$|false$|\[|\{)/.test(v)) val = JSON.parse(v); } catch (e) {}
    params[t.slice(0, k)] = val;
  }
  return { name, params, sig: name + ' ' + JSON.stringify(params) };
}

// ---------- База проекта ----------
// Машинная строка «База: x y z [радиус=N]» в любом месте notes.md (допустимы маркер списка и **жирный**), берётся первая
// найденная с тремя числами.
const BASE_R = 96;
function parseBase(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^[\s>*_-]*База\s*:[\s*]*(.+)$/i.exec(line);
    if (!m) continue;
    const rest = m[1].replace(/[`*]/g, ' ');
    const c = /(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)/.exec(rest);
    if (!c) continue;
    const rm = /радиус\s*=\s*(\d+(?:\.\d+)?)/i.exec(rest);
    const r = rm ? Number(rm[1]) : BASE_R;
    return { x: Number(c[1]), y: Number(c[2]), z: Number(c[3]), r: r > 0 ? r : BASE_R };
  }
  return null;
}

// Навык «goto»: дойти до базы. Как — вариант семейства home (lib/variants/home/*: hops — скачки по ~64 блока,
// short_hops — по ~24, direct — сразу): style=auto|<имя>, auto — лучший по счёту в этой обстановке.
// params: {x,y,z,r,timeout(с),style}. Бросает SkillError, если не дошла (нет продвижения / вышло время).
async function baseTravel(ctx, t, p) {
  const V = require('./variants'), bot = ctx.bot;
  const style = V.checkStyle('home', p.style);
  const trip = Math.round(Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z));
  const arrive = Math.min(12, Math.max(2, (p.r || BASE_R) * 0.5));
  return V.perform(ctx, t, 'home', { x: p.x, y: p.y, z: p.z, near: 3, arrive, timeout: p.timeout, label: 'на базу', fail: 'на базу не дошла' },
    V.situation(ctx, null, { trip }), { style });
}

module.exports = { parseGoal, parseBase, baseTravel, BASE_R };
