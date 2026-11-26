// The premade set: items, the gates they open, biomes. Seeds pick order and variations.
import type { GateKind, ItemDef, ItemId, Req } from './types';
import { at, has, use } from './req';

const def = (id: string, name: string, kind: ItemDef['kind'], icon: string, color: string, extra: Partial<ItemDef> = {}): ItemDef =>
  ({ id, name, kind, icon, color, ...extra });

export const BASE_ITEMS: ItemDef[] = [
  def('sword', 'Sword', 'tool', '⚔', '#e8e4d8'),
  def('glove', 'Lifting Skill', 'skill', '✊', '#e0a35c'),
  def('bombBag', 'Bomb Bag', 'tool', '◉', '#6f8fd8'),
  def('bow', 'Bow', 'tool', '➶', '#c9a36a'),
  def('flippers', 'Swim Gear', 'tool', '≈', '#4fc4d8'),
  def('hookshot', 'Hookshot', 'tool', '⚓', '#b9c2cc'),
  def('lantern', 'Lantern', 'tool', '✦', '#ffcf5a'),
  def('sundial', 'Sun Dial', 'tool', '◐', '#ffd98a'),
  def('wallet', 'Big Wallet', 'tool', '▣', '#7ed87e'),
  def('bombs', 'Bombs', 'consumable', '●', '#6f8fd8', { container: 'bombBag', baseCap: 10 }),
  def('arrows', 'Arrows', 'consumable', '↟', '#c9a36a', { container: 'bow', baseCap: 30 }),
  def('rupees', 'Rupees', 'consumable', '◆', '#5fe08a', { baseCap: 99, upgrades: [{ item: 'wallet', cap: 300 }] }),
  def('medallion', 'Medallion', 'collectible', '✪', '#ffb347'),
  def('heart', 'Heart Piece', 'collectible', '♥', '#ff6b81'),
  def('flag:victory', 'Victory', 'flag', '★', '#fff2a8'),
];

/** Tools that can be shuffled into the progression order. */
export const PROGRESSION_TOOLS: ItemId[] = ['sword', 'glove', 'bombBag', 'bow', 'flippers', 'hookshot', 'lantern', 'sundial'];

/** Things that can beat an enemy, best first. */
export const WEAPONS: ItemId[] = ['sword', 'bow', 'bombBag'];

export interface GateSpec {
  gate: GateKind;
  req: Req;
  /** consumable spent by this gate, if any: a local source must be offered nearby */
  spends?: ItemId;
  label: string;
}

/** How an owned item can lock an edge. */
export const GATES: Record<ItemId, GateSpec> = {
  sword: { gate: 'bush', req: has('sword'), label: 'Thorn bushes' },
  glove: { gate: 'boulder', req: has('glove'), label: 'Heavy boulder' },
  bombBag: { gate: 'cracked', req: use('bombs'), spends: 'bombs', label: 'Cracked rock' },
  bow: { gate: 'eye', req: use('arrows'), spends: 'arrows', label: 'Eye switch gate' },
  flippers: { gate: 'water', req: has('flippers'), label: 'Deep water' },
  hookshot: { gate: 'chasm', req: has('hookshot'), label: 'Chasm' },
  lantern: { gate: 'dark', req: has('lantern'), label: 'Pitch-dark passage' },
  // free where time passes by itself (just wait for dusk); a real lock where it stands still
  sundial: { gate: 'moon', req: at('night'), label: 'Moon door' },
};

export function gateFor(item: ItemId): GateSpec | null {
  if (GATES[item]) return GATES[item];
  if (item.startsWith('bigkey:')) return { gate: 'bossdoor', req: has(item), label: 'Boss door' };
  if (item.startsWith('flag:favor')) return { gate: 'guard', req: has(item), label: 'Guard post' };
  return null;
}

export interface Biome {
  id: string;
  name: string[];
  elev: number[];
  color: string;
  /** gate kinds that feel at home here get a bonus when choosing how to lock an edge */
  likes: ItemId[];
}

export const BIOMES: Biome[] = [
  { id: 'plains', name: ['Pusheen Meadow', 'Whisker Fields', 'Sunny Commons'], elev: [1], color: '#7fc866', likes: ['sword'] },
  { id: 'forest', name: ['Mossback Woods', 'Gnawwood Thicket', 'Tangle Grove'], elev: [1, 2], color: '#3f8f52', likes: ['sword', 'lantern'] },
  { id: 'mountain', name: ['Stonepaw Crags', 'Knoblin Heights', 'Grumble Peaks'], elev: [3], color: '#9a8f86', likes: ['glove', 'bombBag', 'hookshot'] },
  { id: 'lake', name: ['Shellback Marsh', 'Glimmer Ponds', 'Reedwater'], elev: [0], color: '#4a9fb8', likes: ['flippers'] },
  { id: 'desert', name: ['Sunspill Dunes', 'Dry Crumb Flats', 'Sunbaked Reach'], elev: [1, 2], color: '#d9b96a', likes: ['bombBag', 'glove'] },
  { id: 'snow', name: ['Frostpaw Ridge', 'Cold Nap Tundra', 'Shiver Shelf'], elev: [2, 3], color: '#cfe3ee', likes: ['hookshot', 'bow'] },
  { id: 'badlands', name: ['Echo Canyon', 'Rustrock Gulch', 'Cracked Mesa'], elev: [2], color: '#b8694a', likes: ['hookshot', 'bombBag', 'bow'] },
  { id: 'beach', name: ['Saltwhisker Shore', 'Seashell Strand', 'Driftwood Cove'], elev: [0], color: '#e6d59a', likes: ['flippers', 'glove'] },
];

export const UNDER_BIOMES: Record<string, { id: string; name: string; color: string }> = {
  lake: { id: 'flooded', name: 'Drowned Hollows', color: '#3d6f8a' },
  beach: { id: 'flooded', name: 'Tidal Grotto', color: '#3d6f8a' },
  mountain: { id: 'crystal', name: 'Crystal Deeps', color: '#7a6fc0' },
  snow: { id: 'crystal', name: 'Glacier Vault', color: '#7a6fc0' },
  desert: { id: 'magma', name: 'Ember Tunnels', color: '#b4543a' },
  badlands: { id: 'magma', name: 'Cinder Warrens', color: '#b4543a' },
  forest: { id: 'cavern', name: 'Root Cellars', color: '#6b5a48' },
  plains: { id: 'cavern', name: 'Burrow Network', color: '#6b5a48' },
};

export const DUNGEON_NAMES = ['Temple of Naps', 'Baddie Keep', 'Hollow Bellows', 'Catacomb of Crumbs', 'Yarnspire'];
// (Toud is the Elder, so the name is not in the pool)
export const NPC_NAMES = ['Bober', 'Nibbles', 'Tutel', 'Monke', 'Hanko', 'Mimsy', 'Old Purrl', 'Biscuit'];
export const QUEST_ITEMS = [
  ['Lost Mitten', '🧤'], ['Honey Jar', '🍯'], ['Polished Shell', '🐚'], ['Lucky Acorn', '🌰'], ['Warm Scarf', '🧣'], ['Brass Bell', '🔔'],
] as const;

export interface EnemyKind {
  id: string;
  name: string;
  plural: string;
  icon: string;
  /** biomes it lives in; '*' = anywhere */
  biomes: string[];
  /** what beating it tends to drop (a renewable source) */
  drops: ItemId;
  /** only out at night */
  night?: boolean;
  /** only out by day */
  day?: boolean;
  /** how common, relative to the others in its biome */
  weight: number;
}

export const ENEMIES: EnemyKind[] = [
  { id: 'knoblin', name: 'Knoblin', plural: 'Knoblins', icon: '♞', biomes: ['plains', 'forest', 'badlands', 'dungeon'], drops: 'rupees', weight: 5 },
  { id: 'snapjaw', name: 'Snapjaw', plural: 'Snapjaws', icon: '≋', biomes: ['lake', 'beach', 'flooded'], drops: 'rupees', weight: 4 },
  { id: 'frostmite', name: 'Frostmite', plural: 'Frostmites', icon: '❄', biomes: ['snow'], drops: 'arrows', night: true, weight: 2 },
  { id: 'knoblin', name: 'Snow Knoblin', plural: 'Snow Knoblins', icon: '♞', biomes: ['snow'], drops: 'rupees', weight: 3 },
  { id: 'dustling', name: 'Dustling', plural: 'Dustlings', icon: '☼', biomes: ['desert', 'badlands'], drops: 'bombs', day: true, weight: 3 },
  { id: 'rockback', name: 'Sand Rockback', plural: 'Sand Rockbacks', icon: '◭', biomes: ['desert'], drops: 'bombs', weight: 2 },
  { id: 'rockback', name: 'Rockback', plural: 'Rockbacks', icon: '◭', biomes: ['mountain', 'crystal', 'magma'], drops: 'bombs', weight: 4 },
  { id: 'bat', name: 'Cave Bat', plural: 'Cave Bats', icon: '⌄', biomes: ['cavern', 'flooded', 'crystal', 'magma', 'cave', 'dungeon'], drops: 'rupees', weight: 4 },
  { id: 'puff', name: 'Cloud Puff', plural: 'Cloud Puffs', icon: '☁', biomes: ['sky'], drops: 'arrows', weight: 4 },
  { id: 'wisp', name: 'Wisp', plural: 'Wisps', icon: '✧', biomes: ['*'], drops: 'rupees', night: true, weight: 1.5 },
  { id: 'pinjata', name: 'Pinjata Poosheen', plural: 'Pinjata Poosheens', icon: '♛', biomes: ['*'], drops: 'rupees', weight: 0.3 },
];
