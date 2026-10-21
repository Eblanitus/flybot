// gather_wood — идёт к известному лесу и добывает брёвна. У базы -393 деревьев нет,
// ближайший лес на западе (-472 69 37), поэтому сначала goto туда, потом collect.
// params: count (по умолчанию 8), x/y/z точки леса (по умолчанию -472/69/37).
const FOREST = { x: -472, y: 69, z: 37 };

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = {
  name: 'gather_wood',
  description: 'Дойти до леса (по умолчанию -472 69 37) и добыть count брёвен; при «не нашёл» делает explore и повторяет.',
  params: {
    count: 'сколько брёвен, по умолчанию 8',
    x: 'x точки леса, по умолчанию -472',
    y: 'y точки леса, по умолчанию 69',
    z: 'z точки леса, по умолчанию 37'
  },
  async run(api, params) {
    const want = Math.max(1, Number(params.count) || 8);
    const point = {
      x: Number.isFinite(Number(params.x)) ? Number(params.x) : FOREST.x,
      y: Number.isFinite(Number(params.y)) ? Number(params.y) : FOREST.y,
      z: Number.isFinite(Number(params.z)) ? Number(params.z) : FOREST.z
    };
    const start = await api.count('log');
    if (start >= want) return { ok: true, collected: start, note: 'уже было' };

    let pos = (await api.snapshot()).position;
    if (!pos || dist(pos, point) > 20) {
      api.log(`иду к лесу ${point.x} ${point.y} ${point.z}`);
      for (let i = 0; i < 2; i++) {
        try { await api.cmd('goto', { x: point.x, y: point.y, z: point.z }); break; }
        catch (e) { api.log('goto: ' + e.message); await api.sleep(400); }
      }
    }

    let got = start;
    for (let attempt = 0; attempt < 4 && got < want; attempt++) {
      const left = want - got;
      try {
        await api.cmd('collect', { block: 'log', count: left, radius: 48 });
      } catch (e) {
        api.log(`collect попытка ${attempt + 1}: ${e.message}`);
        // ушли из леса или деревья кончились — подойти/осмотреться
        try { await api.cmd('goto', { x: point.x, y: point.y, z: point.z }); }
        catch (_) { try { await api.cmd('explore', { distance: 24 }); } catch (_) {} }
        await api.sleep(300);
      }
      got = await api.count('log');
      api.log(`брёвна: ${got}/${want}`);
    }
    if (got < want) return { ok: false, error: `брёвен ${got}/${want}`, collected: got };
    return { ok: true, collected: got, gained: got - start };
  }
};
