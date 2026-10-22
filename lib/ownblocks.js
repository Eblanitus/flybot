// Свои блоки: муха помнит, что сама поставила (data/own_blocks.json), и сообщает факт own_block_broken, когда такой блок пропал
// или стал другим. by — кто сломал: brain / autopilot / skill:<имя> (сама муха копала это место), player:<ник> (видели, как ломает
// игрок или моб), mob:enderman (эндермен рядом), взрыв (пакет взрыва рядом), неизвестно. placedBy — кто ставил.
// Смена только состояния (дверь открылась, вода в блоке) — не слом: сравниваем имя блока. Выгрузку чанка не считаем.
'use strict';
const fs = require('fs');
const path = require('path');
const dug = require('./dug');

const FILE = path.join(__dirname, '..', 'data', 'own_blocks.json');
const CAP = 5000;          // больше не помним: старые забываются первыми
const SAVE_MS = 30000;
const SEEN_MS = 3000;      // «видели, как ломает» — свежесть наблюдения
const BOOM_MS = 2000;      // пакет взрыва — свежесть
const BOOM_R = 8, MOB_R = 6;

const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// Кто сейчас двигает тело (как в чёрном ящике): задача или простая команда
function whoNow(ctx) {
  const tm = ctx.tasks;
  if (tm && tm.current) return tm.current.by || tm.current.source || 'brain';
  if (tm && tm.legacy) return tm.legacy.by || 'brain';
  return null;
}

function create(ctx, { file = FILE, now = () => Date.now() } = {}) {
  let blocks = new Map(); // key -> { name, t, by }
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); for (const [k, v] of Object.entries(j.blocks || {})) blocks.set(k, v); } catch (e) {}
  let dirty = false;
  const seen = new Map(); // key -> { by, t }: кто-то на глазах ломал этот блок
  let boom = null;        // { pos, t }: последний взрыв

  const self = {
    get size() { return blocks.size; },
    has: p => blocks.has(key(p)),
    get: p => blocks.get(key(p)) || null,
    onPlaced(name, pos) {
      if (!name || !pos || name === 'air') return;
      const k = key(pos);
      blocks.delete(k); blocks.set(k, { name, t: now(), by: whoNow(ctx) || 'неизвестно' });
      while (blocks.size > CAP) blocks.delete(blocks.keys().next().value);
      dirty = true;
    },
    onBreakSeen(pos, entity) {
      if (!pos || !entity) return;
      const by = entity.type === 'player' ? 'player:' + (entity.username || entity.name || '?') : 'mob:' + (entity.name || '?');
      seen.set(key(pos), { by, t: now() });
    },
    onExplosion(pos) { if (pos) boom = { pos, t: now() }; },
    // кто сломал блок в pos (вызывается в момент слома)
    blame(pos) {
      const k = key(pos), t = now(), bot = ctx.bot;
      const dig = bot && bot.__flyDigging; // bot.dig ещё не вернулся, когда сервер прислал слом (lib/dug.js)
      if (dig && dig.position && key(dig.position) === k) return whoNow(ctx) || 'муха';
      const s = seen.get(k); if (s && t - s.t < SEEN_MS) return s.by;
      const near = (name, r) => {
        const es = bot && bot.entities ? Object.values(bot.entities) : [];
        return es.find(e => e && e.position && e.name === name && e.position.distanceTo(pos) <= r);
      };
      if (boom && t - boom.t < BOOM_MS && boom.pos.distanceTo(pos) <= BOOM_R) return 'взрыв';
      const em = near('enderman', MOB_R); if (em) return 'mob:enderman';
      return 'неизвестно';
    },
    // блок в pos сменился: был свой и имя другое -> факт
    onUpdate(oldBlock, newBlock) {
      if (!newBlock || !newBlock.position) return null;
      const k = key(newBlock.position), own = blocks.get(k);
      if (!own || newBlock.name === own.name) return null;
      const by = self.blame(newBlock.position);
      blocks.delete(k); dirty = true; seen.delete(k);
      const p = newBlock.position;
      const fact = { at: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], block: own.name, now: newBlock.name, by, placedBy: own.by };
      const mine = by === 'brain' || by === 'autopilot' || by === 'муха' || /^skill:/.test(by);
      if (ctx.events) ctx.events.push('own_block_broken', mine ? { ...fact, sync: true } : fact); // сама сломала — в журнал, мозг не будим
      return fact;
    },
    save() {
      if (!dirty) return;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ blocks: Object.fromEntries(blocks) })); dirty = false; } catch (e) {}
    }
  };
  return self;
}

function attach(ctx, session) {
  const bot = session.bot || ctx.bot;
  const ob = ctx.ownBlocks || (ctx.ownBlocks = create(ctx));
  bot.on('blockPlaced', (oldBlock, newBlock) => { try { ob.onPlaced(newBlock && newBlock.name, newBlock && newBlock.position); } catch (e) {} });
  bot.on('blockUpdate', (oldBlock, newBlock) => { try { ob.onUpdate(oldBlock, newBlock); } catch (e) {} });
  bot.on('blockBreakProgressObserved', (block, stage, entity) => { try { ob.onBreakSeen(block && block.position, entity); } catch (e) {} });
  dug.install(bot); // bot.__flyDigging: что муха копает прямо сейчас
  if (bot._client && typeof bot._client.on === 'function') bot._client.on('explosion', pk => {
    try { const { Vec3 } = require('./util'); ob.onExplosion(new Vec3(pk.x, pk.y, pk.z)); } catch (e) {}
  });
  if (session.timers) session.timers.push(setInterval(() => { if (!session.ended) ob.save(); }, SAVE_MS));
  bot.on('end', () => ob.save());
  return ob;
}

module.exports = { create, attach, whoNow, key, CAP };
