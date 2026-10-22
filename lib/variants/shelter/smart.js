// smart: как было — враг рядом или блоков мало — закопаться, иначе стены; стены не сошлись — запасная яма.
'use strict';
module.exports = {
  name: 'smart', family: 'shelter',
  desc: 'сам выбирает: враг рядом/мало блоков — яма, иначе стены; стены не сошлись — яма',
  applies: () => true,
  run: (ctx, t, p) => require('../../skills/survival').shelterImpl(ctx, t, { ...p, mode: null })
};
