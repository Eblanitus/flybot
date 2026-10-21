// Запретные зоны: где мухе нельзя копать (например, своя постройка). Ядро проверяет их в collect, лесенке/туннеле
// collect, dig_at, походе к известному месту (worldmem.approachKnown) и в пути pathfinder (не ломать блоки зоны).
// Зона — коробка { name, min:[x,y,z], max:[x,y,z] } (включительно) или шар { name, center:[x,y,z], r };
// необязательно dim: 'overworld' | 'the_nether' | 'the_end' (без dim — в любом измерении). По умолчанию зон нет.
'use strict';
module.exports = [];
