// walls: стены и потолок из блоков вокруг себя на поверхности (9 блоков). Нужны блоки; на обрыве может не сойтись.
'use strict';
module.exports = {
  name: 'walls', family: 'shelter',
  desc: 'стены и потолок из блоков вокруг себя (до 9 блоков); копать не надо',
  applies: (ctx, sit) => (sit.blocks || 0) >= 5 && !sit.water,
  run: (ctx, t, p) => require('../../skills/survival').shelterImpl(ctx, t, { ...p, mode: 'walls' })
};
