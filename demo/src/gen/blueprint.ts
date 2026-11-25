// Blueprint = the logic graph plus a list of things the tile pass must realise.
// Nothing here knows about tiles yet.
import type {
  Check, DimId, DimKind, Edge, GateKind, HKind, HNode, ItemDef, ItemId, LocId, MapObject, Npc, Quest, Req, Source,
} from '../core/types';
import type { Partition, River } from './spatial';
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
  regions: RegionBP[];
  openings: OpeningBP[];
  hnode: HNode;
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
