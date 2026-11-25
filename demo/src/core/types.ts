// Shared contract between generator, solver, renderer and UI.
// Everything here is plain data so it ports 1:1 to Rust structs/enums later.

export type ItemId = string; // 'sword', 'bombs', 'key:d1', 'flag:favor', 'medallion'
export type LocId = string; // one logic node = one walkable zone
export type DimId = string;

// ---------------------------------------------------------------- requirements
export type Req =
  | { t: 'none' }
  /** owns >= n (default 1). Tools, skills, quest flags, counted collectibles. */
  | { t: 'has'; item: ItemId; n?: number }
  /** spends n of a renewable consumable: needs capacity >= n AND a reachable source. */
  | { t: 'use'; item: ItemId; n?: number }
  | { t: 'all'; of: Req[] }
  | { t: 'any'; of: Req[] };

// ---------------------------------------------------------------- items
export type ItemKind = 'tool' | 'skill' | 'consumable' | 'collectible' | 'key' | 'flag' | 'quest';

export interface ItemDef {
  id: ItemId;
  name: string;
  kind: ItemKind;
  /** single glyph used on the map and in lists */
  icon: string;
  color: string;
  /** consumables: item that must be owned before any can be carried (bombs -> bombBag) */
  container?: ItemId;
  /** consumables: capacity without upgrades */
  baseCap?: number;
  /** consumables: capacity upgrades, e.g. wallet */
  upgrades?: { item: ItemId; cap: number }[];
}

// ---------------------------------------------------------------- logic graph
export type GateKind =
  | 'open' | 'bush' | 'boulder' | 'cracked' | 'water' | 'chasm' | 'dark' | 'eye'
  | 'locked' | 'bossdoor' | 'seal' | 'guard' | 'stairs' | 'ledge' | 'portal';

export interface Loc {
  id: LocId;
  name: string;
  /** id of the hierarchy node (region / place / room) owning this zone */
  hnode: string;
  dim: DimId;
  /** representative tile, for camera focus */
  x: number;
  y: number;
}

export interface Edge {
  id: string;
  a: LocId;
  b: LocId;
  req: Req;
  gate: GateKind;
  /** traversable a -> b only (ledge drops) */
  oneWay?: boolean;
  /** small-key door of this dungeon scope; consumes one `key:<scope>` (worst-case key logic) */
  lock?: string;
}

export type CheckKind = 'chest' | 'npc' | 'boss' | 'shop' | 'ground';

export interface Check {
  id: string;
  loc: LocId;
  item: ItemId;
  req: Req;
  kind: CheckKind;
  label: string;
}

/** Renewable supply of a consumable (grass, pots, shop, merchant). */
export interface Source {
  id: string;
  loc: LocId;
  gives: ItemId;
  req: Req;
  label: string;
}

export interface LogicGraph {
  start: LocId;
  /** item id that ends the game when collected */
  goal: ItemId;
  locs: Loc[];
  edges: Edge[];
  checks: Check[];
  sources: Source[];
}

// ---------------------------------------------------------------- hierarchy
export type HKind = 'game' | 'world' | 'region' | 'place' | 'room';

/** One node of the World > Region > Place > Room tree. Same interface at every level. */
export interface HNode {
  id: string;
  kind: HKind;
  name: string;
  seed: number;
  /** items guaranteed to be owned when this node is first entered (passed down by parent) */
  entryCaps: ItemId[];
  /** items collectable anywhere inside (reported up) */
  provides: ItemId[];
  /** requirement of the cheapest way in (reported up) */
  needs: Req;
  /** connections between direct children */
  edges: { a: string; b: string; req: Req; gate: GateKind; oneWay?: boolean }[];
  children: HNode[];
  locs: LocId[];
  meta: { biome?: string; elev?: number; placeKind?: string; dim?: DimId; tier?: number };
}

// ---------------------------------------------------------------- tiles
export const T = {
  VOID: 0, GRASS: 1, SAND: 2, DIRT: 3, STONE: 4, SNOW: 5, WATER: 6, DEEP: 7,
  FLOOR: 8, WALL: 9, CAVE: 10, CAVEWALL: 11, CLOUD: 12, PATH: 13, LAVA: 14, PLANK: 15, SWAMP: 16,
} as const;

export const D = {
  NONE: 0, TREE: 1, PINE: 2, ROCK: 3, TUFT: 4, FLOWER: 5, CACTUS: 6, CRYSTAL: 7,
  MUSHROOM: 8, PILLAR: 9, REED: 10, HOUSE: 11, STALAG: 12, PALM: 13, DEADTREE: 14,
} as const;

export type ObjKind =
  | 'gate' | 'chest' | 'entrance' | 'npc' | 'source' | 'ledge' | 'stairs' | 'boss' | 'start';

export interface MapObject {
  id: string;
  kind: ObjKind;
  x: number;
  y: number;
  label: string;
  gate?: GateKind;
  req?: Req;
  edgeId?: string;
  checkId?: string;
  sourceId?: string;
  /** entrance / stairs: where it leads */
  to?: { dim: DimId; x: number; y: number };
  /** ledge: direction of the allowed drop */
  dir?: 'n' | 's' | 'e' | 'w';
  /** npc: which npc and which stage stands here */
  npcId?: string;
  stage?: number;
  /** place kind for entrances: house, cave, dungeon, shop, shrine, sanctum */
  style?: string;
  icon?: string;
}

export interface RegionInfo {
  id: string; // hnode id
  name: string;
  biome: string;
  elev: number;
  /** label anchor in tile coords */
  x: number;
  y: number;
  color: string;
}

export type DimKind = 'overworld' | 'underworld' | 'sky' | 'interior';

export interface Dimension {
  id: DimId;
  name: string;
  kind: DimKind;
  /** size in tiles */
  w: number;
  h: number;
  /** screen size in tiles (rooms / Zelda screens) */
  sw: number;
  sh: number;
  ground: Uint8Array; // T.*
  deco: Uint8Array; // D.*
  elev: Int8Array; // height level; a tile renders elev steps higher, with wall faces below
  solid: Uint8Array; // 1 = not walkable
  region: Int16Array; // index into regions, -1 = none
  /** walk component -> logic node; -1 for solid tiles. zone[i] indexes zoneLoc */
  zone: Int32Array;
  zoneLoc: LocId[];
  regions: RegionInfo[];
  objects: MapObject[];
  /** stacked worlds share tile coordinates: -1 underworld, 0 overworld, 1 sky */
  stack?: number;
  /** interiors: the overworld entrance that leads here */
  parent?: { dim: DimId; x: number; y: number };
}

// ---------------------------------------------------------------- npcs & quests
/** NPCs are monotone stage machines: the active stage is the last one whose `when` holds. */
export interface NpcStage {
  when: Req;
  loc: LocId;
  dim: DimId;
  x: number;
  y: number;
  line: string;
  /** checks offered from this stage onward (carried to later stages) */
  offers: string[];
}

export interface Npc {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  stages: NpcStage[];
}

export interface Quest {
  id: string;
  name: string;
  main: boolean;
  steps: { text: string; check?: string; req: Req }[];
  reward: ItemId;
}

// ---------------------------------------------------------------- solver output
export interface Sphere {
  index: number;
  newLocs: LocId[];
  collected: { check: string; item: ItemId }[];
  opened: string[]; // edge ids of key doors opened
  inv: Record<ItemId, number>;
  renewable: ItemId[];
}

export interface Solution {
  ok: boolean;
  spheres: Sphere[];
  locSphere: Record<LocId, number>;
  checkSphere: Record<string, number>;
  unreachedChecks: string[];
}

export interface Lint {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface World {
  seed: string;
  items: Record<ItemId, ItemDef>;
  dims: Dimension[];
  tree: HNode;
  graph: LogicGraph;
  npcs: Npc[];
  quests: Quest[];
  solution: Solution;
  lints: Lint[];
  ok: boolean;
  /** generation attempts needed and ms spent */
  stats: { attempts: number; ms: number };
}
