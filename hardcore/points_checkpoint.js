// Контрольная точка очков. Хозяин 06.11: «чтобы другие анализы не читали старые минус баллы
// и не делали по ним вывод». До VER 3 провалы считались неверно: мгновенные отказы навыка
// до старта шли как провалы, и штраф за ключ капал бесконечно (до −84 за жизнь).
// Поэтому все очки версий 1 и 2 считаются невалидными для любых выводов, сравнений и графиков.
// Единственный источник правды — этот модуль. Подключать его, а не хардкодить номер версии.
'use strict';

const { VER } = require('./points');

const MIN_VER = VER;
const NOTE = `Очки версии ${VER}+ только. Раньше (v1, v2) штраф за провалы считался неверно, эти минусы не источник выводов.`;
const SHORT_NOTE = `очки только с v${VER}`;

// Карточка жизни годится для анализа очков?
function cardUsable(card) {
  return !!(card && card.points && Number(card.points.ver) >= MIN_VER);
}

// Очки карточки: null вместо старых минусов.
function pointsOf(card) {
  if (!cardUsable(card)) return null;
  return Number.isFinite(card.points.total) ? card.points.total : null;
}

// Мир годится, если явно помечен новой версией, либо (стенд не пишет pointsVer)
// все его карточки уже новой версии. Пустой мир без карточек не годится.
function worldUsable(world, cards) {
  if (!world) return false;
  if (world.pointsVer != null) return Number(world.pointsVer) >= MIN_VER;
  const own = (cards || []).filter(c => c && c.world === world.id);
  return own.length > 0 && own.every(cardUsable);
}

// Для отчётов: сколько старых карточек отброшено.
function coverage(cards) {
  const list = cards || [];
  const usable = list.filter(cardUsable).length;
  return { total: list.length, usable, skipped: list.length - usable, ver: MIN_VER };
}

module.exports = { VER, MIN_VER, NOTE, SHORT_NOTE, cardUsable, pointsOf, worldUsable, coverage };
