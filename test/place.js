// Офлайн-проверка установки блока (lib/actions.js placeBlockAt, команда place_at): ошибки сервера не глотаются, опора-сундук —
// только с sneak и в последнюю очередь, двери/кровати/напольное — проверки места, честная причина отказа. Запуск: node test/place.js
'use strict';
const assert = require('assert');
const { Vec3 } = require('../lib/util');
const A = require('../lib/actions');

// Фальшивый мир: map 'x,y,z' -> имя; всё ниже y=64 — камень
function fakeBot(blocks = {}, { pos = new Vec3(0.5, 64, 3.5), yaw = 0, inv = ['cobblestone'], place } = {}) {
  const set = Object.assign({}, blocks);
  const key = p => `${p.x},${p.y},${p.z}`;
  const bot = {
    entity: { position: pos, yaw, height: 1.8 },
    heldItem: null, sneak: false, log: [],
    blockAt: p => {
      p = p.floored ? p.floored() : p;
      const n = set[key(p)] || (p.y < 64 ? 'stone' : 'air');
      return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'air' || /_carpet$|torch|water/.test(n) ? 'empty' : 'block' };
    },
    inventory: { items: () => inv.map(n => ({ name: n, count: 5, type: n })) },
    equip: async it => { bot.heldItem = it; },
    lookAt: async () => {},
    setControlState: (c, v) => { if (c === 'sneak') bot.sneak = v; },
    placeBlock: async (ref, face) => {
      bot.log.push({ ref: ref.name, sneak: bot.sneak });
      if (place) return place(ref, face, bot, set);
      const p = ref.position.plus(face); set[key(p)] = bot.heldItem.name;
    }
  };
  return { bot, set, key };
}

module.exports = async () => {
  // обычная установка на камень
  {
    const { bot, set } = fakeBot();
    assert.strictEqual(await A.placeBlockAt(bot, new Vec3(0, 64, 0), 'cobblestone'), true);
    assert.strictEqual(set['0,64,0'], 'cobblestone');
    assert.strictEqual(bot.log[0].sneak, false);
  }
  // опора — сундук и камень: сперва камень; только сундук — с sneak (иначе клик открывает сундук)
  {
    const { bot } = fakeBot({ '0,64,-1': 'chest', '0,63,0': 'air' });
    await A.placeBlockAt(bot, new Vec3(0, 64, 0), 'cobblestone');
    assert.deepStrictEqual(bot.log, [{ ref: 'chest', sneak: true }], 'единственная опора — сундук, ставим с sneak');
    assert.strictEqual(bot.sneak, false, 'sneak отпущен');
    const w2 = fakeBot({ '1,64,0': 'crafting_table' });
    await A.placeBlockAt(w2.bot, new Vec3(0, 64, 0), 'cobblestone');
    assert.deepStrictEqual(w2.bot.log, [{ ref: 'stone', sneak: false }], 'камень раньше верстака');
    assert(A.isInteractive({ name: 'oak_door' }) && A.isInteractive({ name: 'furnace' }) && !A.isInteractive({ name: 'stone' }));
  }
  // ошибка сервера не глотается: блок не встал -> честная причина с текстом ошибки и опорами
  {
    const { bot } = fakeBot({}, { place: async () => { throw new Error('No block has been placed : the block is still air'); } });
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 64, 0), 'cobblestone'), e => /сервер не поставил cobblestone/.test(e.message) && /still air/.test(e.message) && /stone/.test(e.message));
    // ошибка подтверждения, но блок встал — успех
    const ok = fakeBot({}, { place: async (ref, face, b, set) => { set[`${ref.position.x + face.x},${ref.position.y + face.y},${ref.position.z + face.z}`] = 'cobblestone'; throw new Error('timeout'); } });
    assert.strictEqual(await A.placeBlockAt(ok.bot, new Vec3(0, 64, 0), 'cobblestone'), true);
  }
  // в воздухе без соседей — причина «рядом нет твёрдого блока»
  {
    const { bot } = fakeBot();
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 67, 0), 'cobblestone'), /не к чему прислонить блок .*рядом нет твёрдого/);
  }
  // дверь: нужен пол и 2 блока высоты
  {
    const { bot, set } = fakeBot({}, { inv: ['oak_door'] });
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 66, 0), 'oak_door'), /только на твёрдый пол/);
    set['0,65,0'] = 'stone';
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 64, 0), 'oak_door'), /дверь не влезет.*2 блока высоты/);
    delete set['0,65,0']; set['1,64,0'] = 'stone';
    await A.placeBlockAt(bot, new Vec3(0, 64, 0), 'oak_door');
    assert.deepStrictEqual(bot.log.map(l => l.ref), ['stone']); assert.strictEqual(set['0,64,0'], 'oak_door', 'дверь ставится на пол, не на стену');
  }
  // кровать: вторая клетка по взгляду (yaw=0 — смотрит на -z... в mineflayer yaw 0 = север, -z)
  {
    const { bot, set } = fakeBot({}, { inv: ['red_bed'], yaw: 0 });
    set['0,64,-1'] = 'stone';
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 64, 0), 'red_bed'), /кровать не влезет: вторая клетка/);
    delete set['0,64,-1']; set['0,63,-1'] = 'air';
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 64, 0), 'red_bed'), /под второй клеткой .* нет пола/);
    delete set['0,63,-1'];
    assert.strictEqual(await A.placeBlockAt(bot, new Vec3(0, 64, 0), 'red_bed'), true);
  }
  // ковёр — только на пол
  {
    const { bot, set } = fakeBot({ '1,65,0': 'stone' }, { inv: ['white_carpet'] });
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 65, 0), 'white_carpet'), /только на твёрдый пол/);
    assert.strictEqual(set['0,65,0'], undefined);
  }
  // далеко — честно «подойди»
  {
    const { bot } = fakeBot({}, { pos: new Vec3(0.5, 64, 20.5) });
    await assert.rejects(A.placeBlockAt(bot, new Vec3(0, 64, 0), 'cobblestone'), /не дотянуться/);
  }
  console.log('place: OK');
};

if (require.main === module) module.exports().then(() => {}, e => { console.error(e); process.exit(1); });
