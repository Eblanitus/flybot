// Порезка длинных навыков на короткие (хозяин 05.11). Для каждого навыка, который муха может выбрать на стенде, —
// по порядку шаги из steps.js, которые вместе дают его итог. Длинный навык не удаляется: решатель видит и его, и шаги.
// Шаги идут в том порядке, в каком их делает сам длинный навык; уже готовое (кирка есть, верстак рядом) длинный навык
// пропускает — шаг в таком случае просто не нужен.
// from: 'pool' — чужой навык (hardcore/pool/catalog.json), 'own' — свой выученный навык автопилота (brain/learned).
// note — чего шаги не повторяют.
'use strict';

const P = (delo, steps, note) => ({ from: 'pool', delo, steps, ...(note ? { note } : {}) });
const O = (title, steps, note) => ({ from: 'own', title, steps, ...(note ? { note } : {}) });
const TABLE = ['table', 'table_place'];

const SPLIT = {
  // --- чужие: дерево ---
  'v1.mineWoodLog': P('wood', ['log']),
  'v3.mineWoodLog': P('wood', ['log']),
  'v2.chopSpruceLogs': P('wood', ['log']),
  'v1.craftOakPlanksAndSticks': P('wood', ['planks', 'sticks']),
  'v2.craftWoodenPickaxe': P('wood', ['planks', 'sticks', 'table_place', 'wooden_pickaxe']),
  'v3.craftWoodenPickaxe': P('wood', ['log', 'table', 'table_place', 'planks', 'sticks', 'wooden_pickaxe']),
  'v3.craftWoodenSword': P('wood', ['planks', 'sticks', 'table_place', 'wooden_sword']),
  'o.craftWoodenAxe': P('wood', ['sticks', 'planks', ...TABLE, 'wooden_axe']),
  'o.equipPickaxeOrCraftOne': P('wood', ['planks', 'sticks', ...TABLE, 'wooden_pickaxe', 'equip_pickaxe']),
  'o.equipSwordOrCraftOne': P('wood', ['planks', 'sticks', ...TABLE, 'wooden_sword', 'equip_sword']),
  'o.equipAxeOrCraftOne': P('wood', ['planks', 'sticks', ...TABLE, 'wooden_axe', 'equip_axe']),
  // камень
  'v1.mineTenCobblestone': P('stone', ['wooden_pickaxe', 'equip_pickaxe', 'cobble']),
  'v3.mineEightCobblestone': P('stone', ['equip_pickaxe', 'cobble']),
  'v1.craftStonePickaxe': P('stone', ['cobble', 'sticks', 'table_place', 'stone_pickaxe']),
  'v3.craftStonePickaxe': P('stone', ['sticks', 'table_place', 'stone_pickaxe']),
  'v3.craftStoneTools': P('stone', ['cobble', 'sticks', 'table_place', 'stone_sword', 'stone_axe', 'stone_shovel']),
  'v3.craftStoneSword': P('stone', ['sticks', 'table_place', 'stone_sword']),
  'v3.craftStoneAxe': P('stone', ['sticks', 'table_place', 'stone_axe']),
  'o.mineCobblestone': P('stone', ['equip_pickaxe', 'cobble']),
  'o.collectCobblestone': P('stone', ['equip_pickaxe', 'cobble']),
  'o.craftStonePickaxe': P('stone', ['sticks', 'cobble', ...TABLE, 'stone_pickaxe']),
  // печь, уголь, свет
  'v1.craftFurnace': P('furnace', ['cobble', 'table_place', 'furnace']),
  'v3.craftFurnace': P('furnace', ['table_place', 'furnace']),
  'v2.mineFiveCoalOres': P('furnace', ['equip_pickaxe', 'coal']),
  'v3.mineFourCoalOre': P('furnace', ['equip_pickaxe', 'coal']),
  'v2.craftEightTorches': P('furnace', ['table_place', 'torches']),
  'v3.craftChest': P('furnace', ['log', 'planks', 'table_place', 'chest']),
  'o.craftTorches': P('furnace', ['coal', 'sticks', 'torches']),
  'o.craftCampfire': P('furnace', ['sticks', 'log', 'coal', ...TABLE, 'campfire']),
  'o.placeChest': P('furnace', ['planks', 'chest', 'chest_place']),
  // еда
  'v3.killThreeCows': P('food', ['equip_sword', 'hunt_cow']),
  'v3.killThreeChickens': P('food', ['equip_sword', 'hunt_chicken']),
  'v3.killThreeSheep': P('food', ['equip_sword', 'hunt_sheep']),
  'v3.cookRawBeef': P('food', ['furnace', 'furnace_place', 'cook']),
  'v3.cookChicken': P('food', ['furnace', 'furnace_place', 'cook']),
  'v3.cookRawMutton': P('food', ['furnace', 'furnace_place', 'cook']),
  'v3.eatCookedMuttonIfHungry': P('food', ['eat']),
  'v1.killTwoPigs': P('food', ['equip_sword', 'hunt_pig']),
  'v1.cookPorkchops': P('food', ['cobble', 'furnace', 'furnace_place', 'cook']),
  'o.cookBeef': P('food', ['furnace', 'coal', 'cook']),
  'o.cookPorkchop': P('food', ['furnace', 'coal', 'cook']),
  // поле и животные
  'v2.catchThreeFish': P('farm', ['fishing_rod', 'fish']),
  'v2.fishInNearbyWaterSafely': P('farm', ['fishing_rod', 'fight_zombie', 'fight_skeleton', 'fish']),
  'o.craftFishingRod': P('farm', ['sticks', ...TABLE, 'fishing_rod']),
  'o.collectWheatSeeds': P('farm', ['seeds']),
  'o.hoeFarmland': P('farm', ['till']),
  'o.plantWheatSeeds': P('farm', ['seeds', 'plant']),
  'o.collectWheat': P('farm', ['harvest_wheat']),
  'o.makeBread': P('farm', [...TABLE, 'bread']),
  'o.collectCarrots': P('farm', ['harvest_carrot']),
  'o.collectPotatoes': P('farm', ['harvest_potato']),
  'o.breedCow': P('farm', ['breed_cow']),
  'o.breedSheep': P('farm', ['breed_sheep']),
  'o.breedChicken': P('farm', ['breed_chicken']),
  'o.collectMilkWithBucket': P('farm', [], 'не режется: у тела нет команды «подоить корову» — остаётся только длинным'),
  // подземелье
  'v2.exploreCave': P('night', ['torches', 'cave', 'light_here', 'fight_zombie', 'fight_skeleton']),
  'v2.exploreCaveAndGatherResourcesV2': P('night', ['torches', 'cave', 'light_here', 'fight_zombie', 'fight_skeleton', 'coal', 'iron_ore', 'gold_ore', 'diamond_ore']),
  'v3.mineDeepslateOres': P('night', ['equip_pickaxe', 'redstone_ore', 'gold_ore']),
  'v3.mineTenCobbledDeepslateBelowY0': P('night', ['equip_pickaxe', 'go_down', 'deepslate']),
  'v3.mineThreeIronOre': P('night', ['equip_pickaxe', 'iron_ore']),
  'v1.mineFiveIronOres': P('night', ['equip_pickaxe', 'iron_ore']),
  'o.mineIronOre': P('night', ['stone_pickaxe', 'equip_pickaxe', 'iron_ore']),
  'o.mineFlint': P('night', ['wooden_shovel', 'gravel']),
  'o.mineDiamond': P('night', ['iron_pickaxe', 'equip_pickaxe', 'go_down', 'diamond_ore']),
  // железо
  'v3.smeltRawIron': P('iron', ['furnace_place', 'smelt_iron']),
  'v3.craftIronPickaxe': P('iron', ['sticks', 'table_place', 'iron_pickaxe']),
  'v3.craftIronSword': P('iron', ['sticks', 'table_place', 'iron_sword']),
  'v3.craftIronChestplate': P('iron', ['iron_ore', 'furnace_place', 'smelt_iron', ...TABLE, 'iron_chestplate']),
  'v3.craftIronHelmet': P('iron', ['iron_ore', 'furnace_place', 'smelt_iron', 'table_place', 'iron_helmet']),
  'v3.craftIronLeggingsAndBoots': P('iron', ['iron_ore', 'coal', 'furnace_place', 'smelt_iron', ...TABLE, 'iron_leggings', 'iron_boots']),
  'v3.craftShield': P('iron', ['planks', 'table_place', 'shield']),
  'v3.equipShield': P('iron', ['equip_shield']),
  'v1.smeltFiveRawIron': P('iron', ['furnace', 'furnace_place', 'smelt_iron']),
  'v2.equipIronArmor': P('iron', ['equip_armor']),
  'o.craftBucket': P('iron', ['iron_ore', 'smelt_iron', ...TABLE, 'bucket']),
  'o.collectWaterWithBucket': P('iron', ['water_bucket']),
  // бой
  'o.killOneZombie': P('combat', ['equip_sword', 'fight_zombie']),
  'o.killOneSkeleton': P('combat', ['equip_sword', 'fight_skeleton']),
  'o.killOneSpider': P('combat', ['equip_sword', 'fight_spider']),
  'o.killOneCreeper': P('combat', ['equip_sword', 'fight_creeper']),
  'o.craftBow': P('combat', ['sticks', ...TABLE, 'bow']),
  'o.craftArrow': P('combat', ['gravel', 'sticks', 'hunt_chicken', ...TABLE, 'arrows']),
  'o.equipArmor': P('combat', ['equip_armor']),
  // кровать
  'v1.craftWhiteBed': P('bed', ['planks', 'table_place', 'bed']),
  'v2.craftWhiteBedWithExploration': P('bed', ['hunt_sheep', 'planks', 'table_place', 'bed']),
  'o.shearOneSheep': P('bed', ['shears', 'shear']),
  'o.craftWhiteBed': P('bed', ['planks', 'hunt_sheep', ...TABLE, 'bed']),

  // --- свои навыки автопилота (brain/learned) ---
  'day_routine': O('Дневная работа 5–10 мин: от дерева до железной брони', ['log', 'planks', 'sticks', 'table', 'wooden_pickaxe', 'cobble', 'stone_pickaxe', 'stone_sword',
    'furnace', 'coal', 'iron_ore', 'smelt_iron', 'iron_pickaxe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'equip_armor',
    'hunt_cow', 'hunt_pig', 'hunt_chicken', 'hunt_sheep', 'cook'], 'медные кирка и броня (пока нет железа) шагами не повторены'),
  'hc_night_mine': O('Ночной туннель под землёй: камень и руда', ['shelter', 'planks', 'sticks', 'table', 'wooden_pickaxe', 'go_down', 'cobble', 'coal', 'iron_ore', 'dirt'],
    'сам туннель 1×2 с заделкой прорывов и проверкой лавы — одна большая логика безопасности; шагами он заменён на «спуститься» и «добыть камень/руду рядом»'),
  'farm_plot': O('Грядка у воды: вспахать, засеять, потом собрать', ['wooden_hoe', 'seeds', 'till', 'plant', 'harvest_wheat']),
  'farm_plot_v1': O('Грядка без воды: вспахать по числу семян и засеять', ['wooden_hoe', 'seeds', 'till', 'plant', 'harvest_wheat'],
    'пашня без воды: шаг «вспахать» ищет землю только у воды'),
  'make_bed': O('Кровать: шерсть с овец, доски, крафт', ['shears', 'shear', 'hunt_sheep', 'planks', 'bed']),
  'bring_bed_home': O('Добыть кровать и принести на базу', ['wool_from_string', 'shear', 'hunt_sheep', 'planks', 'bed', 'base_hop', 'shelter', 'wait_night', 'sleep'],
    'кровать у базы ставит шаг «лечь спать» (тело ставит кровать из сумки само); ломать чужую кровать в деревне шагами не повторено'),
  'light_base': O('Осветить базу факелами', ['coal', 'sticks', 'torches', 'light_here']),
  'gather_list': O('Добрать список предметов для цели', ['log', 'planks', 'sticks', 'cobble', 'coal', 'iron_ore']),
  'go_safe': O('Дойти до базы перебежками, прячась от мобов', ['base_hop', 'shelter', 'wait_night']),
  'climb_up': O('Выбраться наверх из ямы или пещеры', ['dirt', 'go_up']),
  'climb_stairs': O('Подняться ступенями из ямы', ['dirt', 'go_up'])
};

const isLong = e => e.steps.length >= 2;

module.exports = { SPLIT, isLong };
