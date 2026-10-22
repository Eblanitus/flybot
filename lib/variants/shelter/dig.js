// dig: закопаться — 2 блока вниз и блок на голову (быстро, 1–3 блока). Не в воде.
'use strict';
module.exports = {
  name: 'dig', family: 'shelter',
  desc: 'закопаться: 2 блока вниз и закрыть голову (быстро, мало блоков)',
  applies: (ctx, sit) => !sit.water && !sit.ladder,
  run: (ctx, t, p) => require('../../skills/survival').shelterImpl(ctx, t, { ...p, mode: 'dig' })
};
