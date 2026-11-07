// Офлайн-проверки переделки под 26.1: форк физики в vendor, штатный плагин mineflayer,
// приём отдачи, спринт на сервер, навык выхода на берег.
// Запуск: node test/body26.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const ROOT = path.join(__dirname, '..');
const plugin = require('../lib/body26/plugin');

// 1) Что видим в протоколе.
{
  const now = plugin.protocolInfo('26.1');
  assert.strictEqual(now.ok, true);
  assert.strictEqual(now.lpVec3, true, '26.1 шлёт lpVec3');
  assert.strictEqual(now.sprintStart, 1, 'start_sprinting = 1');
  assert.strictEqual(now.sprintStop, 2, 'stop_sprinting = 2');
  assert.strictEqual(now.remapSprint, true, '3/4 в 26.1 уже не спринт');
  const old = plugin.protocolInfo('1.21.4');
  assert.strictEqual(old.lpVec3, false, '1.21.4 ещё vec3i16');
  assert.strictEqual(old.sprintStart, 3, '1.21.4: спринт = 3');
  assert.strictEqual(old.remapSprint, false, 'старую версию не трогаем');
  console.log('протокол 26.1 против 1.21.4: OK');
}

// 2) Физика реально грузится из vendor и ускоряет спринт-плавание ровно в 1.6 раза.
{
  const resolved = require.resolve('prismarine-physics');
  assert(resolved.replace(/\\/g, '/').includes('/vendor/prismarine-physics/'), 'физика из vendor: ' + resolved);
  const pkg = require(path.join(ROOT, 'vendor/prismarine-physics/package.json'));
  assert.strictEqual(pkg.flybot26, true);
  assert.strictEqual(pkg.version, '1.11.1', 'версия совпадает с требованием mineflayer ^1.11.1');

  const { Physics, PlayerState } = require('prismarine-physics');
  const md = require('minecraft-data')('26.1');
  const waterId = md.blocksByName.water.id;
  const waterWorld = {
    getBlock(pos) {
      const p = pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z);
      return { type: waterId, metadata: 0, boundingBox: 'empty', name: 'water', position: p, shapes: [], isWaterlogged: false };
    }
  };
  const physics = Physics(md, waterWorld);
  assert.strictEqual(physics.sprintSwimming, true, 'режим спринт-плавания включён для 1.13+/26.1');
  assert.strictEqual(physics.liquidSprintAcceleration, 0.032);

  const state = (sprint, jump = false) => {
    const bot = {
      version: '26.1',
      entity: {
        position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), onGround: false,
        isInWater: true, isInLava: false, isInWeb: false,
        isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false,
        attributes: { movementSpeed: { value: 0.1 } }, yaw: 0, pitch: 0, effects: {}
      },
      jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] }
    };
    return new PlayerState(bot, { forward: true, back: false, left: false, right: false, jump, sprint, sneak: false });
  };
  const slow = state(false), fast = state(true);
  physics.simulatePlayer(slow, waterWorld);
  physics.simulatePlayer(fast, waterWorld);
  assert.strictEqual(slow.isInWater, true);
  assert(Math.abs(fast.vel.z) > Math.abs(slow.vel.z) * 1.5, 'спринт в воде быстрее: ' + slow.vel.z + ' -> ' + fast.vel.z);
  assert(Math.abs(Math.abs(fast.vel.z) - Math.abs(slow.vel.z) * 1.6) < 1e-6, 'ровно ×1.6');
  // Рефлекс утопления гребёт «прыжком»: ускорение должно сохраняться и при control.jump.
  const slowJump = state(false, true), fastJump = state(true, true);
  physics.simulatePlayer(slowJump, waterWorld);
  physics.simulatePlayer(fastJump, waterWorld);
  assert(Math.abs(Math.abs(fastJump.vel.z) - Math.abs(slowJump.vel.z) * 1.6) < 1e-6, 'при гребке прыжком тоже ×1.6');
  console.log('форк физики и спринт-плавание: OK (' + slow.vel.z.toFixed(6) + ' -> ' + fast.vel.z.toFixed(6) + ')');
}

// 3) Плагин: отдача, спринт на сервер, полный player_input по флагу.
{
  const handlers = {};
  const written = [];
  const client = {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    emit(name, packet) { for (const fn of handlers[name] || []) fn(packet); },
    write(name, params) { written.push({ name, params }); return true; }
  };
  const self = { id: 7, velocity: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } } };
  const bot = new EventEmitter();
  bot._client = client;
  bot.version = '26.1';
  bot.entity = self;
  bot.entities = { 7: self };
  bot.controlState = { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  plugin(bot, {});
  assert.strictEqual(client.__body26, true, 'плагин встал');

  client.emit('entity_velocity', { entityId: 7, velocity: { x: 0.4, y: 0.36, z: -0.2 } });
  assert.strictEqual(self.velocity.x, 0.4, 'толчок дошёл целиком, без деления на 8000');
  assert.strictEqual(self.velocity.y, 0.36);

  bot.controlState.sprint = true;
  bot.emit('physicsTick');
  const actions = written.filter(w => w.name === 'entity_action');
  assert.strictEqual(actions.length, 1, 'один пакет на смену спринта');
  assert.strictEqual(actions[0].params.actionId, 1, 'start_sprinting = 1');
  bot.emit('physicsTick');
  assert.strictEqual(written.filter(w => w.name === 'entity_action').length, 1, 'без смены состояния пакет не шлём');
  bot.controlState.sprint = false;
  bot.emit('physicsTick');
  assert.strictEqual(written.filter(w => w.name === 'entity_action')[1].params.actionId, 2, 'stop_sprinting = 2');
  assert.strictEqual(written.filter(w => w.name === 'player_input').length, 0, 'по умолчанию полный ввод выключен');

  process.env.BODY26_PLAYER_INPUT = '1';
  bot.emit('physicsTick');
  const inputs = written.filter(w => w.name === 'player_input');
  assert.strictEqual(inputs.length, 1);
  assert.deepStrictEqual(inputs[0].params.inputs, {
    forward: true, backward: false, left: false, right: false, jump: false, shift: false, sprint: false
  });
  delete process.env.BODY26_PLAYER_INPUT;
  console.log('плагин: отдача, actionId и player_input: OK');
}

// 4) inputFlags — чистое преобразование controlState в формат 26.1.
{
  assert.deepStrictEqual(plugin.inputFlags({ forward: true, back: true, left: false, right: true, jump: true, sneak: true, sprint: true }), {
    forward: true, backward: true, left: false, right: true, jump: true, shift: true, sprint: true
  });
  assert.deepStrictEqual(plugin.inputFlags(null).sprint, false);
  console.log('inputFlags: OK');
}

// 5) Выход на берег остался нашим навыком, не частью библиотеки.
{
  const water = require('../lib/skills/water');
  assert.strictEqual(typeof water.shoreExit, 'function');
  assert.strictEqual(typeof water.findShore, 'function');
  const air = { name: 'air', boundingBox: 'empty' };
  const w = { name: 'water', boundingBox: 'empty' };
  const land = { name: 'stone', boundingBox: 'block' };
  const bot = {
    entity: { position: new Vec3(10.5, 62.5, 10.5) },
    blockAt(pos) {
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      if (x === 12 && z === 10 && y === 62) return land;
      if (y === 62 && x >= 9 && x <= 11 && z >= 9 && z <= 11) return w;
      return air;
    }
  };
  const edge = water.findShore(bot, 3);
  assert(edge, 'берег найден');
  assert.strictEqual(edge.water.x, 11.5, 'стать вплотную в соседней воде');
  console.log('shore_exit: OK');
}

// 6) Проводка и архив: monkey-patch уехал, а не удалён; mineflayer из npm нетронут.
{
  const body = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
  assert(body.includes('plugins: { body26: body26Plugin }'), 'плагин подключён через createBot');
  assert(!body.includes("require('./lib/body26').install") && !body.includes("require('./lib/body26').attach"), 'старый monkey-patch отключён');
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'lib/body26.js')), false, 'старого файла в lib нет');
  const archive = path.join(ROOT, 'hardcore/archive/code');
  const archived = fs.readdirSync(archive).filter(f => /^body26\..*\.js$/.test(f));
  assert(archived.length >= 1, 'старый модуль в архиве');
  const old = fs.readFileSync(path.join(archive, archived[0]), 'utf8');
  assert(old.includes('function install') && old.includes('swimPlan'), 'архивная копия целая');

  const pkg = require(path.join(ROOT, 'package.json'));
  assert.strictEqual(pkg.dependencies['prismarine-physics'], 'file:vendor/prismarine-physics');
  assert.strictEqual(pkg.dependencies.mineflayer, '^4.39.0', 'mineflayer остался из npm');
  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert.strictEqual(lock.packages['node_modules/prismarine-physics'].link, true, 'lock указывает на vendor');
  assert(lock.packages['vendor/prismarine-physics'], 'vendor описан в lock');
  const cmd = fs.readFileSync(path.join(ROOT, 'lib/commands.js'), 'utf8');
  assert(cmd.includes('shore_exit: water.shoreExit'), 'команда зарегистрирована');
  console.log('проводка, lock и архив: OK');
}

// 7) Мало уметь плавать в физике — надо ещё включать спринт там, где муха реально гребёт.
//    Рефлекс утопления и простая команда swim раньше жали только jump, shore_exit не был описан мозгу.
{
  const reflex = fs.readFileSync(path.join(ROOT, 'behavior/reflexes.js'), 'utf8');
  assert(reflex.includes("setControlState('sprint', swimForward)"), 'рефлекс утопления плывёт на спринте');
  assert(reflex.includes("plan.action !== 'swim') bot.setControlState('sprint', false)"), 'вне плавания спринт снимаем');
  const cmd = fs.readFileSync(path.join(ROOT, 'lib/commands.js'), 'utf8');
  const swim = /case 'swim':([\s\S]*?)\n      case 'flee':/.exec(cmd);
  assert(swim, 'команда swim на месте');
  assert(swim[1].includes("setControlState('sprint', sprint)"), 'swim жмёт спринт');
  assert(swim[1].includes('finally') && swim[1].includes('clearControlStates()'), 'контроль снимается и при ошибке');
  const skills = fs.readFileSync(path.join(ROOT, 'SKILLS.md'), 'utf8');
  assert(/^\| `shore_exit` \|/m.test(skills), 'shore_exit описан в SKILLS.md — мозг его видит');
  console.log('проводка спринта в воде и каталог навыков: OK');
}

console.log('body26: OK');
