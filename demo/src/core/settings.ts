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
  worldW: number; worldH: number; regions: number; borderWobble: number; cliffs: boolean; scenery: number;
  underworld: boolean; underworldSize: number; underworldRegions: number; sky: boolean; skySize: number;
  dungeons: number; sealMedallions: number; lockDensity: number; linearity: number; secrets: number; everyToolUsed: boolean;
  dungeonRooms: number; smallKeys: number; dungeonLoops: number;
  shortcuts: number; ledges: boolean; extraStairs: number;
  favorQuest: boolean; tradeQuest: boolean; merchant: boolean;
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
  num('worldW', 'World', 'World width', 'int', 5, 10, 1, 8, 'Overworld width in screens. One screen is 12×10 tiles.', 'size map columns'),
  num('worldH', 'World', 'World height', 'int', 4, 7, 1, 6, 'Overworld height in screens.', 'size map rows'),
  num('regions', 'World', 'Regions', 'int', 3, 10, 1, 7, 'How many biomes the overworld is split into. Capped so each region keeps room for its places.', 'biomes areas count'),
  num('borderWobble', 'World', 'Border wobble', 'float', 0, 7, 0.5, 4.5, 'How far region borders stray from the screen grid, in tiles. 0 gives straight, blocky borders.', 'warp noise organic shape'),
  flag('cliffs', 'World', 'Height differences', true, 'Regions sit at different heights, which makes cliffs, stairs and one-way ledges. Off puts everything on one level.', 'elevation layers cliffs flat'),
  num('scenery', 'World', 'Scenery density', 'float', 0, 2.5, 0.25, 1, 'Multiplier for trees, rocks and ponds inside regions. Scenery can never block a path.', 'trees rocks decoration props'),

  flag('underworld', 'Layers', 'Underworld', true, 'A cave layer under the overworld, reached by stairs. Its caves take their theme from the land above.', 'caves subworld below'),
  num('underworldSize', 'Layers', 'Underworld size', 'int', 5, 20, 1, 12, 'How many screens of cave exist.', 'caves'),
  num('underworldRegions', 'Layers', 'Underworld regions', 'int', 1, 3, 1, 3, 'Upper limit for separate cave systems.', 'caves'),
  flag('sky', 'Layers', 'Sky', true, 'Cloud islands above the overworld, reached by a beanstalk.', 'clouds islands subworld above'),
  num('skySize', 'Layers', 'Sky size', 'int', 3, 12, 1, 7, 'How many screens of cloud exist.', 'clouds islands'),

  num('dungeons', 'Progression', 'Dungeons', 'int', 1, 5, 1, 3, 'Each dungeon holds a medallion and, if a tool is left, a tool.', 'temples castles count'),
  num('sealMedallions', 'Progression', 'Medallions for the seal', 'int', 1, 5, 1, 3, 'How many medallions open the final sanctum. Never more than there are dungeons.', 'goal ending requirement'),
  num('lockDensity', 'Progression', 'Lock density', 'float', 0, 1, 0.05, 0.75, 'Chance that a filler border between regions is gated. Borders on the critical path are always gated.', 'gates free open'),
  num('linearity', 'Progression', 'Linearity', 'float', 0, 2.5, 0.1, 0.7, 'Higher values attach new regions to the newest ones (one long chain). Lower values branch out from the start.', 'depth bias chain bushy tree'),
  num('secrets', 'Progression', 'Secrets', 'float', 0, 1, 0.05, 0.75, 'Chance per region of an optional heart piece hidden behind a tool from anywhere in the progression.', 'optional hidden hearts backtracking'),
  flag('everyToolUsed', 'Progression', 'Every tool opens something', true, 'A tool that no gate asks for gets its own secret alcove.', 'dead items unused'),

  num('dungeonRooms', 'Dungeons', 'Dungeon rooms', 'int', 5, 11, 1, 8, 'Typical room count; each dungeon varies by one.', 'size chambers'),
  num('smallKeys', 'Dungeons', 'Small keys', 'int', 0, 3, 1, 2, 'Upper limit of locked doors per dungeon. Doors always chain, so no order of opening can waste a key.', 'locked doors'),
  num('dungeonLoops', 'Dungeons', 'Dungeon loops', 'float', 0, 1, 0.05, 0.3, 'Chance that two neighbouring rooms on the same side of every locked door get an extra doorway.', 'cycles shortcuts'),

  num('shortcuts', 'Loops', 'Shortcuts and ledges', 'float', 0, 1, 0.05, 0.75, 'Chance that two touching regions the tree did not connect get a gated shortcut, or a one-way ledge if heights differ.', 'cycles loops'),
  flag('ledges', 'Loops', 'One-way ledges', true, 'Allow drops from high ground. Each one is checked so it can never trap the player.', 'softlock drops jump'),
  num('extraStairs', 'Loops', 'Extra stairs', 'float', 0, 1, 0.05, 0.85, 'Chance that each further cave system or cloud island also connects straight to the land above or below it.', 'underworld sky shortcuts'),

  flag('favorQuest', 'Quests & NPCs', 'Guard favor quest', true, 'A required side quest: fetch an item, earn a flag, and a guard opens a border.', 'npc flag fetch'),
  flag('tradeQuest', 'Quests & NPCs', 'Trade chain', true, 'Three NPCs trade up to the Big Wallet. When off, the wallet becomes a hidden chest.', 'npc optional side quest wallet'),
  flag('merchant', 'Quests & NPCs', 'Travelling peddler', true, 'An NPC that follows the player\'s progress and is a moving ammo source.', 'npc dynamic shop moving'),

  num('priceBombs', 'Economy', 'Bomb price', 'int', 1, 300, 1, 20, 'Rupees per refill at shops. A price above the wallet capacity makes the shelf unusable, and the checks will say so.', 'shop cost rupees'),
  num('priceArrows', 'Economy', 'Arrow price', 'int', 1, 300, 1, 10, 'Rupees per refill at shops.', 'shop cost rupees'),
  num('priceHeart', 'Economy', 'Shop heart price', 'int', 1, 300, 1, 200, 'Above the base wallet (99) this needs the Big Wallet.', 'shop cost rupees wallet'),
  num('pricePeddlerHeart', 'Economy', 'Peddler heart price', 'int', 1, 300, 1, 80, 'The travelling peddler sells one heart piece.', 'shop cost rupees merchant'),

  num('maxAttempts', 'Advanced', 'Generation attempts', 'int', 1, 20, 1, 12, 'If the tile pass cannot fit a feature, the world is regenerated from a derived seed, up to this many times.', 'retry'),
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
  tool('flippers', 'Crosses deep water.'),
  tool('hookshot', 'Crosses chasms.'),
  tool('lantern', 'Lights pitch-dark passages and caves.'),
  { id: 'bombs', fields: ['cap'], default: { cap: 10 }, capRange: [1, 99], help: 'Carried in the Bomb Bag. Never counted by the logic: renewable or unusable.' },
  { id: 'arrows', fields: ['cap'], default: { cap: 30 }, capRange: [1, 99], help: 'Carried with the Bow.' },
  { id: 'rupees', fields: ['cap'], default: { cap: 99 }, capRange: [10, 999], help: 'Base wallet capacity. Prices above it need the Big Wallet.' },
  { id: 'wallet', fields: ['cap'], default: { cap: 300 }, capRange: [10, 999], help: 'Rupee capacity once the Big Wallet is owned.' },
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
  s.regions = Math.max(2, Math.min(s.regions, Math.floor((s.worldW * s.worldH) / 5)));
  s.sealMedallions = Math.min(s.sealMedallions, s.dungeons);
  s.underworldSize = Math.min(s.underworldSize, s.worldW * s.worldH - 2);
  s.skySize = Math.min(s.skySize, s.worldW * s.worldH - 2);
  return s;
}

/** Number of values that differ from the defaults (for a "modified" badge). */
export function countChanges(s: GenSettings): number {
  const d = defaultSettings();
  let n = 0;
  for (const def of SETTING_DEFS) if (s[def.key] !== d[def.key]) n++;
  for (const def of ITEM_SETTING_DEFS) for (const f of def.fields) if (s.items[def.id]?.[f] !== d.items[def.id][f]) n++;
  return n;
}
