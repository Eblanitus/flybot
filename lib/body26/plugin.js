// Штатный внешний плагин mineflayer для сервера 26.1.
// Никаких подмен require.cache и перехватов client.write: mineflayer остаётся нетронутым из npm,
// физика лежит отдельным пакетом в vendor/, а здесь живёт только адаптация протокола.
// Подключается из bot.js: createBot({ plugins: { body26: require('./lib/body26/plugin') } }).
'use strict';

const DEFAULT_VERSION = '26.1';

function protocolInfo(version) {
  const out = { version, lpVec3: false, sprintStart: 3, sprintStop: 4, remapSprint: false, ok: false };
  try {
    const md = require('minecraft-data')(version);
    const ev = md.protocol.play.toClient.types.packet_entity_velocity;
    const vel = ev && ev[1] && ev[1].find(f => f.name === 'velocity');
    out.lpVec3 = !!(vel && vel.type === 'lpVec3');
    const action = md.protocol.play.toServer.types.packet_entity_action;
    const map = action && action[1] && action[1].find(f => f.name === 'actionId');
    const mappings = map && map.type && map.type[1] && map.type[1].mappings;
    if (mappings) {
      for (const [id, name] of Object.entries(mappings)) {
        if (name === 'start_sprinting') out.sprintStart = Number(id);
        if (name === 'stop_sprinting') out.sprintStop = Number(id);
      }
      out.remapSprint = out.sprintStart !== 3 || out.sprintStop !== 4;
    }
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

// Состояние ввода в формате player_input 26.1. Чистая функция для тестов.
function inputFlags(controlState) {
  const c = controlState || {};
  return {
    forward: !!c.forward, backward: !!c.back,
    left: !!c.left, right: !!c.right,
    jump: !!c.jump, shift: !!c.sneak, sprint: !!c.sprint
  };
}

module.exports = function body26Plugin(bot, options) {
  const version = String(bot && bot.version ? bot.version : (options && options.version) || process.env.MC_VERSION || DEFAULT_VERSION);
  const info = protocolInfo(version);
  if (!info.ok) {
    console.log('[body26] протокол не прочитан, плагин не активен:', info.error);
    return;
  }
  const client = bot && bot._client;
  if (!client || client.__body26) return;
  client.__body26 = true;

  console.log(`[body26] плагин ${version}: отдача=${info.lpVec3 ? 'lpVec3' : 'vec3i16'}, ` +
    `actionId спринта=${info.remapSprint ? info.sprintStart + '/' + info.sprintStop : '3/4'}, ` +
    `player_input=${process.env.BODY26_PLAYER_INPUT === '1' ? 'вкл' : 'выкл'}`);

  // 1) Отдача. Встроенный обработчик mineflayer делит lpVec3 на 8000; наш зарегистрирован
  //    позже и ставит уже правильную скорость в блок/тик.
  if (info.lpVec3) {
    client.on('entity_velocity', packet => {
      const v = packet && packet.velocity;
      if (!v) return;
      const e = (bot.entities && bot.entities[packet.entityId]) ||
        (bot.entity && packet.entityId === bot.entity.id ? bot.entity : null);
      if (e && e.velocity && typeof e.velocity.set === 'function') e.velocity.set(v.x, v.y, v.z);
    });
  }

  // 2) Спринт на сервер. mineflayer шлёт entity_action 3/4 (в 26.1 это riding_jump),
  //    поэтому пишем свои корректные 1/2 при смене состояния. Перехвата чужого write нет.
  if (info.remapSprint) {
    let last = null;
    bot.on('physicsTick', () => {
      const s = !!(bot.controlState && bot.controlState.sprint);
      if (s === last) return;
      last = s;
      if (!bot.entity || bot.entity.id == null) return;
      client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: s ? info.sprintStart : info.sprintStop,
        jumpBoost: 0
      });
    });
  }

  // 3) Полный поток ввода, как у ванильного клиента 1.21.6+. По умолчанию выключен:
  //    mineflayer сам шлёт player_input только для shift, и до живого замера не ясно,
  //    как сервер отреагирует на полный набор флагов каждый тик. Включается BODY26_PLAYER_INPUT=1.
  bot.on('physicsTick', () => {
    if (process.env.BODY26_PLAYER_INPUT !== '1') return;
    client.write('player_input', { inputs: inputFlags(bot.controlState) });
  });
};

module.exports.protocolInfo = protocolInfo;
module.exports.inputFlags = inputFlags;
