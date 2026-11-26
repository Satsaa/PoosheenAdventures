// Shared contract between generator, solver, renderer and UI.
import type { GenSettings } from './settings';
// Everything here is plain data so it ports 1:1 to Rust structs/enums later.

export type ItemId = string; // 'sword', 'bombs', 'key:d1', 'flag:favor', 'medallion'
export type LocId = string; // one logic node = one walkable zone
export type DimId = string;

// ---------------------------------------------------------------- requirements
export type Phase = 'day' | 'night';

export type Req =
  | { t: 'none' }
  /** owns >= n (default 1). Tools, skills, quest flags, counted collectibles. */
  | { t: 'has'; item: ItemId; n?: number }
  /** spends n of a renewable consumable: needs capacity >= n AND a reachable source. */
  | { t: 'use'; item: ItemId; n?: number }
  /** only at this time of day. Free where time passes on its own; otherwise needs the time-control item. */
  | { t: 'time'; phase: Phase }
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
  | 'locked' | 'bossdoor' | 'seal' | 'guard' | 'stairs' | 'ledge' | 'portal'
  /** river logic: wading in or out at a level bank, and going over a fall */
  | 'shore' | 'waterfall'
  /** a door that only opens at night; a room that opens once its enemies are beaten */
  | 'moon' | 'sun' | 'foes'
  /** sailing: a dock joins a region to the sea it lies on */
  | 'dock';

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
  /** set when the supply is what an enemy kind drops (see ENEMIES in core/content) */
  enemy?: string;
}

export interface LogicGraph {
  /** true: day and night alternate by themselves, so time requirements only mean waiting */
  timeFlows: boolean;
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
  meta: { biome?: string; elev?: number; placeKind?: string; dim?: DimId; tier?: number; /** a region out at sea, reached by boat or ferry */ island?: boolean };
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
  | 'gate' | 'chest' | 'entrance' | 'npc' | 'source' | 'ledge' | 'stairs' | 'boss' | 'start' | 'enemy';

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
  /**
   * Which way you walk to pass through. Ledges: the direction of the drop. Gates, doors and
   * entrances: the door stands ACROSS this direction, so 'n' and 's' mean a door seen face-on in
   * an east-west wall, 'e' and 'w' a door seen edge-on in a north-south wall.
   */
  dir?: 'n' | 's' | 'e' | 'w';
  /** npc: which npc and which stage stands here */
  npcId?: string;
  stage?: number;
  /** enemy: which kind (see ENEMIES in core/content), e.g. 'knoblin', 'bat', 'wisp' */
  enemy?: string;
  /** only present during this part of the day (night creatures, day-time stalls) */
  phase?: Phase;
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

/** A building: a footprint of tiles (not always a rectangle) with its door on the south side. */
export interface Structure {
  id: string;
  /** what it is: house, shop, dungeon, sanctum, cave */
  kind: string;
  /** look, e.g. 'timber-red', 'stone-moss', 'marble': the same style always looks the same */
  style: string;
  /** tile indices (y * w + x) the building stands on; all have deco D.HOUSE */
  tiles: number[];
  /** the walkable tile in front of the door; the door is in the wall just north of it */
  door: { x: number; y: number };
  /** floors above ground, 1 or 2: taller buildings have taller walls */
  floors: number;
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
  /**
   * 1 = this raised tile shows only a thin bevel on its west, east and north sides instead of a
   * wall face (low walls, parapets, kerbs). Its south face is drawn as usual.
   */
  lip?: Uint8Array;
  /** which way river water flows on each tile: 0 = still, 1 = north, 2 = east, 3 = south, 4 = west */
  flow?: Uint8Array;
  region: Int16Array; // index into regions, -1 = none
  /** walk component -> logic node; -1 for solid tiles. zone[i] indexes zoneLoc */
  zone: Int32Array;
  zoneLoc: LocId[];
  regions: RegionInfo[];
  objects: MapObject[];
  /** buildings standing in this dimension, built from tiles */
  structures?: Structure[];
  /** stacked worlds share tile coordinates: -1 underworld, 0 overworld, 1 sky */
  stack?: number;
  /** interiors: the entrance that leads here (for a deeper floor: the stairs back toward the entrance floor) */
  parent?: { dim: DimId; x: number; y: number };
  /** floors of one building: the id of its entrance floor, and this floor's short name ("1F", "B2") */
  group?: DimId;
  floor?: string;
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
  /** the NPC is only out during this part of the day */
  phase?: Phase;
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
  /** not ok, but only a warning: the world is still valid and is not generated again */
  warn?: boolean;
}

export interface World {
  seed: string;
  /** the (normalised) settings this world was generated with */
  settings: GenSettings;
  items: Record<ItemId, ItemDef>;
  dims: Dimension[];
  tree: HNode;
  graph: LogicGraph;
  npcs: Npc[];
  quests: Quest[];
  solution: Solution;
  lints: Lint[];
  ok: boolean;
  /** how this world meets the edge of the map: 0 = island, 1 = landlocked, and which sides are sea */
  shape?: { landlocked: number; sea: { n: boolean; e: boolean; s: boolean; w: boolean } };
  /** generation attempts needed and ms spent */
  stats: { attempts: number; ms: number };
}
