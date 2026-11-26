// Generation settings. One flat record plus per-item settings, described by metadata so a UI
// (or a config file in the Rust port) can be generated from it. Same seed + same settings = same world.
import type { ItemId } from './types';

export type ItemOrder = 'start' | 'early' | 'any' | 'late';
export type ItemHome = 'any' | 'overworld' | 'dungeon';

export interface ItemSetting {
  /** tools/skills: part of this world at all */
  enabled?: boolean;
  /** tools/skills: when in the progression it tends to appear; 'start' = the Elder hands it over */
  order?: ItemOrder;
  /** tools/skills: loose in the world, or a dungeon's treasure */
  home?: ItemHome;
  /** consumables and capacity upgrades: how many can be carried */
  cap?: number;
}

export interface GenSettings {
  worldW: number; worldH: number; regions: number; borderWobble: number; cliffs: boolean; scenery: number; landCoverage: number; coastFromSeed: boolean; landlocked: number;
  oceanSize: number; islands: number; islandSize: number; docks: number; ferries: number; ferryFare: number; outcrops: number;
  rivers: number; riverWidth: number; riverCaves: number; caveRivers: number; caveHeights: boolean; tunnels: number; lava: number;
  castle: boolean; town: boolean; townHouses: number; dungeonFloors: number;
  underworld: boolean; underworldSize: number; underworldRegions: number; sky: boolean; skySize: number;
  dungeons: number; sealMedallions: number; lockDensity: number; linearity: number; secrets: number; everyToolUsed: boolean;
  dungeonRooms: number; smallKeys: number; dungeonLoops: number;
  shortcuts: number; ledges: boolean; extraStairs: number;
  favorQuest: boolean; tradeQuest: boolean; merchant: boolean;
  timeFlows: boolean; timeDoors: boolean; timeChests: number; timeCreatures: number; timeNpcs: number; timeShop: boolean;
  enemies: number; village: number;
  priceBombs: number; priceArrows: number; priceHeart: number; pricePeddlerHeart: number;
  maxAttempts: number;
  items: Record<ItemId, ItemSetting>;
}

export type SettingKey = Exclude<keyof GenSettings, 'items'>;

export interface SettingDef {
  key: SettingKey;
  label: string;
  group: string;
  type: 'int' | 'float' | 'bool';
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean;
  help: string;
  /** extra words the search should match */
  keywords?: string;
}

const num = (key: SettingKey, group: string, label: string, type: 'int' | 'float', min: number, max: number, step: number, def: number, help: string, keywords = ''): SettingDef =>
  ({ key, group, label, type, min, max, step, default: def, help, keywords });
const flag = (key: SettingKey, group: string, label: string, def: boolean, help: string, keywords = ''): SettingDef =>
  ({ key, group, label, type: 'bool', default: def, help, keywords });

export const SETTING_DEFS: SettingDef[] = [
  // Tested up to 64×48 screens (768×480 tiles): generation takes about 2 s there, and the map view draws it in chunks.
  num('worldW', 'World', 'World width', 'int', 3, 64, 1, 8, 'Overworld width in screens. One screen is 12×10 tiles. Very large worlds take a second or two to generate.', 'size map columns'),
  num('worldH', 'World', 'World height', 'int', 3, 48, 1, 6, 'Overworld height in screens.', 'size map rows'),
  num('regions', 'World', 'Regions', 'int', 1, 96, 1, 7, 'How many biomes the overworld is split into. Limited by the map size, the border wobble and the river width, so each region keeps room for its places.', 'biomes areas count'),
  num('borderWobble', 'World', 'Border wobble', 'float', 0, 8, 0.5, 4.5, 'How far region borders stray from the screen grid, in tiles. 0 gives straight, blocky borders. A screen is 12×10 tiles, so more than 8 would tear small regions apart.', 'warp noise organic shape'),
  num('landCoverage', 'World', 'Land coverage', 'float', 0.3, 1, 0.02, 0.8, 'Share of the map rectangle that is land. Below 1 the world gets an irregular outline, with open sea or mountain ranges filling the rest. 1 fills the whole rectangle.', 'shape island coast outline rectangle ocean'),
  flag('coastFromSeed', 'World', 'Coast from the seed', true, 'Each seed decides how landlocked its world is: a low value gives a full island, a high value a world whose land runs on past the map edge on every side. Off uses the value below instead.', 'island islandiness landlocked ocean edge'),
  num('landlocked', 'World', 'Landlocked', 'float', 0, 1, 0.05, 0.5, 'Used when the coast does not come from the seed. Each side of the map is sea with probability 1 minus this: 0 is always a full island, 1 is fully landlocked with no ocean at all.', 'island islandiness coast ocean edge'),
  flag('cliffs', 'World', 'Height differences', true, 'Regions sit at different heights, which makes cliffs, stairs and one-way ledges. Off puts everything on one level.', 'elevation layers cliffs flat'),
  num('scenery', 'World', 'Scenery density', 'float', 0, 5, 0.25, 1, 'Multiplier for trees, rocks and ponds inside regions. Scenery can never block a path.', 'trees rocks decoration props'),

  num('rivers', 'Rivers', 'Rivers', 'int', 0, 12, 1, 2, 'How many rivers cross the overworld. They flow downhill along the lines between screens, follow region borders or cut straight through a region, and drop over waterfalls where the land steps down.', 'water stream waterfall'),
  num('riverWidth', 'Rivers', 'River width', 'int', 1, 3, 1, 1, 'Half-width of the water band: 1 gives a river two tiles wide, 3 gives six.', 'water wide'),
  num('riverCaves', 'Caves', 'River caves', 'float', 0, 1, 0.05, 0.4, 'Chance that a cave has a river running through it, with its treasure on the far bank. Needs the Swim Gear in the world.', 'cave water place interior'),

  num('tunnels', 'Caves', 'Tunnels', 'float', 0, 1, 0.05, 0.3, 'Chance that the way between two regions is a cave with a mouth on either side instead of a gap in the border. The gate then stands inside the cave. Shortcuts can be tunnels too.', 'cave multi entrance passage two exits'),
  flag('caveHeights', 'Caves', 'Cave heights', true, 'Caves have floors at different heights: underworld regions sit on different levels with stairs and drops between them, tunnels climb from one mouth to the other, and cave rooms get raised ledges.', 'elevation cliffs ledge stairs underworld'),
  num('caveRivers', 'Caves', 'Underworld rivers', 'int', 0, 6, 1, 1, 'Rivers that run through the underworld. They follow the same rules as rivers above ground: bridges at borders, the Swim Gear to enter, waterfalls where the cave floor drops.', 'water stream cave underground'),

  num('lava', 'Caves', 'Lava', 'float', 0, 3, 0.1, 1, 'How much lava the underworld holds: pools of every shape in the magma caves and a few in ordinary ones, lava instead of water in the pools and pits of places entered from magma caves, and an underworld river that rises there runs molten. Lava can never be crossed and never cuts a cave in two.', 'magma molten fire underworld pool'),

  num('oceanSize', 'Ocean', 'Sea width', 'int', 0, 16, 1, 4, 'Screens of open sea added beyond the land on every side that is sea. The map grows by this much on those sides; the land keeps the size set under World.', 'ocean amount water margin size'),
  num('islands', 'Ocean', 'Island regions', 'int', 0, 10, 1, 2, 'Islands out at sea that are regions in their own right, with places and gates of their own. They can only be reached over the water, which makes the Boat (or a ferry) part of the progression. Needs a sea wide enough to hold them.', 'archipelago isle boat'),
  num('islandSize', 'Ocean', 'Island size', 'int', 2, 8, 1, 3, 'Typical size of an island region, in screens.', 'archipelago isle'),
  num('docks', 'Ocean', 'Docks', 'float', 0, 1, 0.05, 0.7, 'Chance that a region on the coast gets a dock. With the Boat, every dock on the same sea is connected.', 'boat pier harbour sailing port'),
  num('ferries', 'Ocean', 'Ferrymen', 'float', 0, 1, 0.05, 0.5, 'Chance that a dock has a ferryman, who sails you to any other ferry dock on that sea for a fare, no Boat needed.', 'boat merchant travel passage npc'),
  num('ferryFare', 'Ocean', 'Ferry fare', 'int', 0, 999, 1, 30, 'Rupees per crossing.', 'boat price cost rupees'),
  num('outcrops', 'Ocean', 'Outcrops', 'int', 0, 16, 1, 5, 'Reefs, sandbars and cays scattered over the open sea, per 50 screens of water. Each is grown tile by tile, so no two have the same outline. On a sea that can be sailed, some hold a chest or pots.', 'islet rock sandbar treasure secret boat'),

  flag('castle', 'Places', 'Castle', true, 'One region is a castle: straight walls on the screen grid instead of a wobbly border, towers on the corners, a paved yard, guards, and the Sealed Sanctum as its keep when the sanctum is above ground.', 'fortress walls blocky keep region'),
  flag('town', 'Places', 'Town', true, 'One region near the start is a town: houses in rows along streets, a square, townsfolk, and a few houses you can enter.', 'village city houses streets region'),
  num('townHouses', 'Places', 'Town houses', 'int', 0, 24, 1, 9, 'How many houses the town has. Built only where they fit.', 'village city buildings'),

  flag('underworld', 'Layers', 'Underworld', true, 'A cave layer under the overworld, reached by stairs. Its caves take their theme from the land above.', 'caves subworld below'),
  num('underworldSize', 'Layers', 'Underworld size', 'int', 1, 512, 1, 12, 'How many screens of cave exist.', 'caves'),
  num('underworldRegions', 'Layers', 'Underworld regions', 'int', 1, 16, 1, 3, 'Upper limit for separate cave systems.', 'caves'),
  flag('sky', 'Layers', 'Sky', true, 'Cloud islands above the overworld, reached by a beanstalk.', 'clouds islands subworld above'),
  num('skySize', 'Layers', 'Sky size', 'int', 1, 512, 1, 7, 'How many screens of cloud exist.', 'clouds islands'),

  num('dungeons', 'Progression', 'Dungeons', 'int', 0, 24, 1, 3, 'Each dungeon holds a medallion and, if a tool is left, a tool. With none, the sanctum has no seal.', 'temples castles count'),
  num('sealMedallions', 'Progression', 'Medallions for the seal', 'int', 0, 24, 1, 3, 'How many medallions open the final sanctum. Never more than there are dungeons.', 'goal ending requirement'),
  num('lockDensity', 'Progression', 'Lock density', 'float', 0, 1, 0.05, 0.75, 'Chance that a filler border between regions is gated. Borders on the critical path are always gated.', 'gates free open'),
  num('linearity', 'Progression', 'Linearity', 'float', 0, 5, 0.1, 0.7, 'Higher values attach new regions to the newest ones (one long chain). Lower values branch out from the start.', 'depth bias chain bushy tree'),
  num('secrets', 'Progression', 'Secrets', 'float', 0, 1, 0.05, 0.75, 'Chance per region of an optional heart piece hidden behind a tool from anywhere in the progression.', 'optional hidden hearts backtracking'),
  flag('everyToolUsed', 'Progression', 'Every tool opens something', true, 'A tool that no gate asks for gets its own secret alcove.', 'dead items unused'),

  num('dungeonRooms', 'Dungeons', 'Dungeon rooms', 'int', 2, 64, 1, 8, 'Typical room count; each dungeon varies by one. The room grid grows to fit.', 'size chambers'),
  num('smallKeys', 'Dungeons', 'Small keys', 'int', 0, 12, 1, 2, 'Upper limit of locked doors per dungeon. Doors always chain, so no order of opening can waste a key.', 'locked doors'),
  num('dungeonFloors', 'Dungeons', 'Dungeon floors', 'int', 1, 5, 1, 2, 'Upper limit of floors per dungeon. Floors lie exactly above one another and are joined by stairs; a dungeon either climbs (2F, 3F) or digs down (B1, B2).', 'layers levels storeys basement tower stairs'),
  num('dungeonLoops', 'Dungeons', 'Dungeon loops', 'float', 0, 1, 0.05, 0.3, 'Chance that two neighbouring rooms on the same side of every locked door get an extra doorway.', 'cycles shortcuts'),

  num('shortcuts', 'Loops', 'Shortcuts and ledges', 'float', 0, 1, 0.05, 0.75, 'Chance that two touching regions the tree did not connect get a gated shortcut, or a one-way ledge if heights differ.', 'cycles loops'),
  flag('ledges', 'Loops', 'One-way ledges', true, 'Allow drops from high ground. Each one is checked so it can never trap the player.', 'softlock drops jump'),
  num('extraStairs', 'Loops', 'Extra stairs', 'float', 0, 1, 0.05, 0.85, 'Chance that each further cave system or cloud island also connects straight to the land above or below it.', 'underworld sky shortcuts'),

  flag('favorQuest', 'Quests & NPCs', 'Guard favor quest', true, 'A required side quest: fetch an item, earn a flag, and a guard opens a border.', 'npc flag fetch'),
  flag('tradeQuest', 'Quests & NPCs', 'Trade chain', true, 'Three NPCs trade up to the Big Wallet. When off, the wallet becomes a hidden chest.', 'npc optional side quest wallet'),
  flag('merchant', 'Quests & NPCs', 'Travelling peddler', true, 'An NPC that follows the player\'s progress and is a moving ammo source. Needs at least one tool in the world to follow.', 'npc dynamic shop moving'),

  flag('timeFlows', 'Time', 'Time passes on its own', true, 'On: day and night alternate, so anything tied to the time of day only means waiting, and the Sun Dial just skips the wait. Off: it stays day until the Sun Dial is found, which makes night doors and night-only things real locks.', 'day night clock sundial'),
  flag('timeDoors', 'Time', 'Sun and moon doors', true, 'The Sun Dial can lock borders and dungeon rooms with doors that only open at night (moon doors) or only by day (sun doors).', 'day night gate lock'),
  num('timeChests', 'Time', 'Moonlit and sunlit chests', 'float', 0, 1, 0.05, 0.3, 'Chance that a secret chest only shows itself at night, or only by day.', 'day night secret treasure'),
  num('timeCreatures', 'Time', 'Day and night creatures', 'float', 0, 3, 0.25, 1, 'How common creatures are that only come out at night (wisps, frostmites) or only by day (dustlings). 0 removes them.', 'day night enemies wisps'),
  num('timeNpcs', 'Time', 'NPCs that keep hours', 'float', 0, 1, 0.05, 0.5, 'Chance that each NPC who can keep hours does: the peddler packs up at dusk, traders may be early birds or night owls.', 'day night schedule shop'),
  flag('timeShop', 'Time', 'Village shop closes at night', false, 'The shop only sells by day. Free refills elsewhere keep every ammo gate passable.', 'day night store hours'),

  num('enemies', 'Enemies', 'Enemy density', 'float', 0, 4, 0.25, 1, 'How many enemies roam regions and dungeon rooms. Beating them is a renewable source of rupees and ammo, and some dungeon doors stay sealed until their room is cleared.', 'monsters creatures foes combat'),

  num('village', 'Quests & NPCs', 'Village houses', 'int', 0, 12, 1, 3, 'Extra houses around the start, so home looks like a village. Houses are built from tiles in different shapes.', 'buildings town home'),

  num('priceBombs', 'Economy', 'Bomb price', 'int', 0, 999, 1, 20, 'Rupees per refill at shops. A price above the wallet capacity makes the shelf unusable, and the checks will say so.', 'shop cost rupees'),
  num('priceArrows', 'Economy', 'Arrow price', 'int', 0, 999, 1, 10, 'Rupees per refill at shops.', 'shop cost rupees'),
  num('priceHeart', 'Economy', 'Shop heart price', 'int', 0, 999, 1, 200, 'Above the base wallet (99) this needs the Big Wallet.', 'shop cost rupees wallet'),
  num('pricePeddlerHeart', 'Economy', 'Peddler heart price', 'int', 0, 999, 1, 80, 'The travelling peddler sells one heart piece.', 'shop cost rupees merchant'),

  num('maxAttempts', 'Advanced', 'Generation attempts', 'int', 1, 50, 1, 12, 'If the tile pass cannot fit a feature, the world is regenerated from a derived seed, up to this many times.', 'retry'),
];

export interface ItemSettingDef {
  id: ItemId;
  /** which fields of ItemSetting apply */
  fields: ('enabled' | 'order' | 'home' | 'cap')[];
  default: ItemSetting;
  capRange?: [number, number];
  help: string;
}

const tool = (id: ItemId, help: string): ItemSettingDef => ({ id, fields: ['enabled', 'order', 'home'], default: { enabled: true, order: 'any', home: 'any' }, help });

export const ITEM_SETTING_DEFS: ItemSettingDef[] = [
  tool('sword', 'Cuts thorn bushes.'),
  tool('glove', 'Lifts heavy boulders.'),
  tool('bombBag', 'Lets you carry bombs, which blast cracked rock.'),
  tool('bow', 'Lets you carry arrows, which hit eye switches.'),
  tool('flippers', 'Lets you enter rivers and swim along them, wade through deep-water gates and cross underground rivers. Without it in the world, rivers are plain barriers.'),
  tool('hookshot', 'Crosses chasms.'),
  tool('lantern', 'Lights pitch-dark passages and caves.'),
  tool('boat', 'Sails the open sea from any dock: every dock on the same sea becomes one hop away. Islands and the sandbars and cays out at sea can only be reached with it (or by ferry). Left out of worlds that have no sea.'),
  { ...tool('sundial', 'Sets the time of day at will, so nothing tied to day or night means waiting. Where time stands still it is the only way to reach the night.'), default: { enabled: true, order: 'early', home: 'any' } },
  { id: 'bombs', fields: ['cap'], default: { cap: 10 }, capRange: [1, 999], help: 'Carried in the Bomb Bag. Never counted by the logic: renewable or unusable.' },
  { id: 'arrows', fields: ['cap'], default: { cap: 30 }, capRange: [1, 999], help: 'Carried with the Bow.' },
  { id: 'rupees', fields: ['cap'], default: { cap: 99 }, capRange: [1, 9999], help: 'Base wallet capacity. Prices above it need the Big Wallet.' },
  { id: 'wallet', fields: ['cap'], default: { cap: 300 }, capRange: [1, 9999], help: 'Rupee capacity once the Big Wallet is owned.' },
];

export const ORDER_OPTIONS: { value: ItemOrder; label: string; help: string }[] = [
  { value: 'start', label: 'Start', help: 'The Elder hands it over at the start' },
  { value: 'early', label: 'Early', help: 'Tends to come first' },
  { value: 'any', label: 'Any', help: 'Shuffled freely' },
  { value: 'late', label: 'Late', help: 'Tends to come last' },
];
export const HOME_OPTIONS: { value: ItemHome; label: string; help: string }[] = [
  { value: 'any', label: 'Anywhere', help: 'Loose or in a dungeon' },
  { value: 'overworld', label: 'Loose', help: 'A chest, cave or alcove, never a dungeon treasure' },
  { value: 'dungeon', label: 'Dungeon', help: 'A dungeon treasure when a dungeon is free' },
];

/** How many screens of the rectangle are land. Small maps are all land. */
export function landScreens(s: GenSettings): number {
  const total = s.worldW * s.worldH;
  return Math.min(total, Math.max(Math.round(total * s.landCoverage), 8));
}

/** Screens a region needs so its places fit: more with wobbly borders and wide rivers. */
export function screensPerRegion(s: GenSettings): number {
  return 3 + s.borderWobble / 2 + (s.rivers > 0 ? (s.riverWidth - 1) * 1.5 : 0);
}

export function defaultSettings(): GenSettings {
  const s = { items: {} } as GenSettings;
  for (const d of SETTING_DEFS) (s as unknown as Record<string, number | boolean>)[d.key] = d.default;
  for (const d of ITEM_SETTING_DEFS) s.items[d.id] = { ...d.default };
  return s;
}

/** Fill in missing fields and clamp everything into range, so any partial or stale object is safe to use. */
export function normalizeSettings(partial?: Partial<GenSettings> | null): GenSettings {
  const s = defaultSettings();
  const out = s as unknown as Record<string, number | boolean>;
  const src = (partial ?? {}) as Record<string, unknown>;
  for (const d of SETTING_DEFS) {
    const v = src[d.key];
    if (d.type === 'bool') { if (typeof v === 'boolean') out[d.key] = v; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const c = Math.max(d.min!, Math.min(d.max!, v));
    out[d.key] = d.type === 'int' ? Math.round(c) : c;
  }
  for (const d of ITEM_SETTING_DEFS) {
    const it = partial?.items?.[d.id];
    if (!it) continue;
    const t = s.items[d.id];
    if (d.fields.includes('enabled') && typeof it.enabled === 'boolean') t.enabled = it.enabled;
    if (d.fields.includes('order') && ORDER_OPTIONS.some((o) => o.value === it.order)) t.order = it.order;
    if (d.fields.includes('home') && HOME_OPTIONS.some((o) => o.value === it.home)) t.home = it.home;
    if (d.fields.includes('cap') && typeof it.cap === 'number' && Number.isFinite(it.cap)) t.cap = Math.round(Math.max(d.capRange![0], Math.min(d.capRange![1], it.cap)));
  }
  // structural limits that depend on each other
  // a region needs room for its places. Measured: three screens each is enough with straight
  // borders, and wobblier borders eat into small regions, so they need more
  // (and wide rivers take a strip off every region they touch)
  s.regions = Math.max(1, Math.min(s.regions, Math.floor(landScreens(s) / screensPerRegion(s))));
  // the Big Wallet is an upgrade: it can never hold less than the base wallet
  s.items.wallet.cap = Math.max(s.items.wallet.cap ?? 0, s.items.rupees.cap ?? 0);
  s.sealMedallions = Math.min(s.sealMedallions, s.dungeons);
  s.underworldSize = Math.min(s.underworldSize, landScreens(s));
  s.skySize = Math.min(s.skySize, landScreens(s));
  return s;
}

/** Number of values that differ from the defaults (for a "modified" badge). */
export function countChanges(s: GenSettings): number {
  const d = defaultSettings();
  let n = 0;
  // a value only counts as changed if putting the default back would actually alter it
  // (a default that other settings clamp, like 7 regions on a small map, is not a change)
  for (const def of SETTING_DEFS) {
    if (s[def.key] === d[def.key]) continue;
    if (normalizeSettings({ ...s, [def.key]: d[def.key] })[def.key] !== s[def.key]) n++;
  }
  for (const def of ITEM_SETTING_DEFS) {
    for (const f of def.fields) {
      if (s.items[def.id]?.[f] === d.items[def.id][f]) continue;
      const probe = normalizeSettings({ ...s, items: { ...s.items, [def.id]: { ...s.items[def.id], [f]: d.items[def.id][f] } } });
      if (probe.items[def.id][f] !== s.items[def.id]?.[f]) n++;
    }
  }
  return n;
}
