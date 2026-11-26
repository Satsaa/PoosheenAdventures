// Blueprint = the logic graph plus a list of things the tile pass must realise.
// Nothing here knows about tiles yet.
import type {
  Check, DimId, DimKind, Edge, GateKind, HKind, HNode, ItemDef, ItemId, LocId, MapObject, Npc, Quest, Req, Source,
} from '../core/types';
import type { Fill, Partition, River, WorldShape } from './spatial';
import { NONE } from '../core/req';
import type { GenSettings } from '../core/settings';

export type ObjTpl = Omit<MapObject, 'x' | 'y'>;

export type Feature =
  /** an object on any free tile of the region's main zone */
  | { f: 'spot'; obj: ObjTpl }
  /** a one-tile alcove closed by a gate, holding one object */
  | { f: 'pocket'; edgeId: string; gate: GateKind; req: Req; label: string; loc: LocId; obj: ObjTpl }
  /** a building / cave mouth leading to an interior dimension */
  | { f: 'entrance'; edgeId: string; style: string; label: string; req: Req; interior: InteriorBP }
  /**
   * a pier out into the sea this region lies on (index of the ocean filler). With an edge it is
   * part of the graph (the way to an island) and must be built; without, it is built where it fits.
   */
  | { f: 'dock'; filler: number; edgeId?: string; ferry?: boolean }
  /** a house nobody needs to enter: it makes the village a village */
  | { f: 'house' }
  /** stairs between stacked worlds; realised at the same tile in both */
  | { f: 'vertical'; edgeId: string; style: string; label: string; req: Req; other: RegionBP; optional?: boolean };

export interface RegionBP {
  id: string;
  idx: number;
  stack: StackBP;
  biome: string;
  elev: number;
  name: string;
  color: string;
  hnode: HNode;
  feats: Feature[];
  /** a sliver (one screen or less): connected, but nothing is placed in it */
  barren?: boolean;
  /** built, not grown: its border follows the screen grid in straight lines (a castle) */
  blocky?: boolean;
}

export interface OpeningBP {
  edgeId: string;
  a: number;
  b: number;
  gate: GateKind;
  req: Req;
  label: string;
  oneWay?: boolean;
  /** a loop, not part of the tree: if the map has no room for it, it is simply left out */
  optional?: boolean;
}

export interface StackBP {
  id: DimId;
  kind: DimKind;
  name: string;
  stack: number;
  part: Partition;
  /** index of the region the world is entered through */
  entry: number;
  regions: RegionBP[];
  openings: OpeningBP[];
  hnode: HNode;
  /** what lies outside the land: ocean, ranges, thicket, wastes (overworld only) */
  fill?: Fill;
  /** river courses on the screen lattice; realised as water bands by the tile pass */
  rivers?: River[];
  /** touching region pairs the tree did not use: candidates for loops and ledges */
  unused?: [string, string][];
}

export interface RoomBP {
  cell: number;
  loc: LocId;
  objs: ObjTpl[];
  /** an underground river crosses the room: this is the far bank */
  far?: { loc: LocId; edgeId: string; req: Req; objs: ObjTpl[] };
  /** height of the room's floor, relative to the lowest room of the interior */
  elev?: number;
}

/** Stairs to the room directly above or below, on another floor of the same building. */
export interface StairBP {
  edgeId: string;
  room: number;
  /** the interior (floor) they lead to */
  to: DimId;
  up: boolean;
  gate: GateKind;
  req: Req;
  label: string;
  /** which of the two stair spots of a room: a room can have stairs up and stairs down */
  slot: number;
  /** the way back toward the entrance floor */
  home?: boolean;
}

export interface DoorBP {
  edgeId: string;
  a: number;
  b: number;
  gate: GateKind;
  req: Req;
  label: string;
}

export interface InteriorBP {
  id: DimId;
  name: string;
  style: string;
  gw: number;
  gh: number;
  rooms: RoomBP[];
  doors: DoorBP[];
  entryRoom: number;
  entranceEdge: string;
  /** adjacent room pairs without a door: candidates for shortcuts */
  loops?: [number, number][];
  /** further ways out to the world, besides the entrance: a tunnel has a mouth at either end */
  exits?: { edgeId: string; room: number }[];
  /** floors of one building share a room grid: the entrance floor's id, and this floor's number (0 = entrance) */
  group?: DimId;
  floor?: number;
  /** short name of the floor, e.g. "B1" or "2F" */
  floorName?: string;
  stairs?: StairBP[];
  /** rooms may get raised ledges */
  heights?: boolean;
  /** entered from a magma cave: its pools and pits hold lava */
  lava?: boolean;
}

export class Ctx {
  constructor(public settings: GenSettings) {}
  items: Record<ItemId, ItemDef> = {};
  locs = new Map<LocId, { name: string; hnode: string; dim: DimId }>();
  edges: Edge[] = [];
  checks: Check[] = [];
  sources: Source[] = [];
  npcs: Npc[] = [];
  quests: Quest[] = [];
  stacks: StackBP[] = [];
  interiors: InteriorBP[] = [];
  /** item -> zone where it is obtained, for NPCs that follow the player's progress */
  itemHome = new Map<ItemId, LocId>();
  /** how the world meets the map edge */
  shape: WorldShape = { landlocked: 0, sea: { n: true, e: true, s: true, w: true } };
  /** false when no side of this world is sea: nothing to sail, so no boat */
  hasOcean = false;
  /** the Boat is one of this world's tools */
  hasBoat = false;
  /** the zone the player starts in */
  start: LocId = '';
  /** what the player is guaranteed to own when the sanctum is placed */
  sanctumCaps: ItemId[] = [];
  private seq = 0;

  uid(prefix: string): string {
    return prefix + (this.seq++).toString(36);
  }
  loc(id: LocId, name: string, hnode: string, dim: DimId): LocId {
    this.locs.set(id, { name, hnode, dim });
    return id;
  }
  edge(a: LocId, b: LocId, req: Req, gate: GateKind, extra: Partial<Edge> = {}): Edge {
    const e: Edge = { id: this.uid('e'), a, b, req, gate, ...extra };
    this.edges.push(e);
    return e;
  }
  check(loc: LocId, item: ItemId, kind: Check['kind'], label: string, req: Req = NONE): Check {
    const c: Check = { id: this.uid('c'), loc, item, req, kind, label };
    this.checks.push(c);
    if (!this.itemHome.has(item)) this.itemHome.set(item, loc);
    return c;
  }
  source(loc: LocId, gives: ItemId, label: string, req: Req = NONE): Source {
    const s: Source = { id: this.uid('s'), loc, gives, req, label };
    this.sources.push(s);
    return s;
  }
  item(def: ItemDef): ItemId {
    this.items[def.id] = def;
    return def.id;
  }
}

export function hnode(id: string, kind: HKind, name: string, seed: number, meta: HNode['meta'] = {}): HNode {
  return { id, kind, name, seed, entryCaps: [], provides: [], needs: NONE, edges: [], children: [], locs: [], meta };
}
