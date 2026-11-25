// Place level -> rooms. A dungeon is the same lock-graph problem as the overworld, on a room
// grid, with small keys added. Interiors live in their own dimension, so they can be any size.
import type { HNode, ItemId, LocId, Req } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { gateFor } from '../core/content';
import { NONE } from '../core/req';
import { Ctx, hnode, type InteriorBP, type RoomBP } from './blueprint';
import { buildLockGraph, type Payload } from './lockgraph';
import { growBlob, neighbours } from './spatial';

export interface PlaceResult {
  interior: InteriorBP;
  node: HNode;
  entryLoc: LocId;
}

/** A one-room interior: cave, house, shop, sanctum. */
export function singleRoom(ctx: Ctx, id: string, name: string, style: string, seed: number): PlaceResult & { room: RoomBP } {
  const node = hnode(id, 'place', name, seed, { placeKind: style, dim: id });
  const loc = ctx.loc(id + '.r0', name, id, id);
  const room: RoomBP = { cell: 0, loc, objs: [] };
  const rn = hnode(loc, 'room', name, childSeed(seed, 'r0'), { dim: id });
  rn.locs.push(loc);
  node.children.push(rn);
  const interior: InteriorBP = { id, name, style, gw: 1, gh: 1, rooms: [room], doors: [], entryRoom: 0, entranceEdge: '' };
  ctx.interiors.push(interior);
  return { interior, node, entryLoc: loc, room };
}

export function buildDungeon(ctx: Ctx, id: string, name: string, seed: number, payload: Payload): PlaceResult {
  const rng = new Rng(seed);
  const scope = payload.data!.scope as string;
  const tool = payload.data!.tool as ItemId | null;
  const S = ctx.settings;
  const caps = payload.caps ?? [];
  const GW = 4, GH = 3;
  const key = ctx.item({ id: 'key:' + scope, name: `Small Key (${name})`, kind: 'key', icon: '⚷', color: '#d8d8e8' });
  const big = ctx.item({ id: 'bigkey:' + scope, name: `Boss Key (${name})`, kind: 'key', icon: '♛', color: '#ffd24a' });

  const entryCell = (GH - 1) * GW + rng.range(1, 2);
  const cells = growBlob(rng, GW, GH, entryCell, Math.max(4, Math.min(GW * GH, rng.range(S.dungeonRooms - 1, S.dungeonRooms + 1))));
  const rid = (c: number) => `${id}.r${c}`;
  const candidates: [string, string][] = [];
  for (const c of cells) for (const n of neighbours(GW, GH, c)) if (n > c && cells.includes(n)) candidates.push([rid(c), rid(n)]);

  // The brief for the rooms: order of what must be found. Keys come before the doors they open.
  const p = (it: ItemId, extra: Partial<Payload> = {}): Payload => ({ id: it, kind: 'item', provides: [it], ...extra });
  let keys = S.smallKeys === 0 ? 0 : rng.range(Math.max(1, S.smallKeys - 1), S.smallKeys);
  const payloads: Payload[] = [];
  if (keys-- > 0) payloads.push(p(key));
  if (tool) payloads.push(p(tool));
  while (keys-- > 0) payloads.push(p(key));
  payloads.push(p(big), { id: 'boss', kind: 'boss', provides: ['medallion'], terminal: true });

  const lg = buildLockGraph({
    rng, nodes: cells.map(rid), entry: rid(entryCell), candidates, entryCaps: caps, payloads,
    entryPayloads: 0, freeChance: 0.65, lockScope: scope, depthBias: 1.6,
  });

  const node = hnode(id, 'place', name, seed, { placeKind: 'dungeon', dim: id });
  const rooms: RoomBP[] = [];
  const roomIdx = new Map<string, number>();
  lg.order.forEach((r, i) => {
    const cell = Number(r.slice(r.lastIndexOf('r') + 1));
    const got = lg.assign.get(r)!;
    const isBoss = got.some((g) => g.kind === 'boss');
    const rname = i === 0 ? 'Entrance hall' : isBoss ? 'Boss lair' : `Chamber ${i}`;
    const loc = ctx.loc(r, `${name}: ${rname}`, r, id);
    const room: RoomBP = { cell, loc, objs: [] };
    for (const g of got) {
      const it = g.provides[0];
      const c = ctx.check(loc, it, isBoss && g.kind === 'boss' ? 'boss' : 'chest', g.kind === 'boss' ? `Boss of ${name}` : `${name} chest`);
      room.objs.push({ id: 'o.' + c.id, kind: g.kind === 'boss' ? 'boss' : 'chest', label: c.label, checkId: c.id });
    }
    if (!got.length && i > 0 && rng.chance(0.5)) {
      const c = ctx.check(loc, 'heart', 'chest', `${name} side chest`);
      room.objs.push({ id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id });
    }
    const rn = hnode(r, 'room', rname, childSeed(seed, r), { dim: id, tier: lg.tier.get(r) });
    rn.locs.push(loc);
    rn.entryCaps = lg.capsAt.get(r) ?? [];
    rn.provides = got.map((g) => g.provides[0]);
    node.children.push(rn);
    roomIdx.set(r, rooms.length);
    rooms.push(room);
  });

  const interior: InteriorBP = { id, name, style: 'dungeon', gw: GW, gh: GH, rooms, doors: [], entryRoom: 0, entranceEdge: '' };
  const spent = new Set<ItemId>();
  for (const le of lg.edges) {
    const e = ctx.edge(le.a, le.b, le.req, le.gate, le.lock ? { lock: le.lock } : {});
    interior.doors.push({ edgeId: e.id, a: roomIdx.get(le.a)!, b: roomIdx.get(le.b)!, gate: le.gate, req: le.req, label: le.label });
    node.edges.push({ a: le.a, b: le.b, req: le.lock ? { t: 'has', item: key } : le.req, gate: le.gate });
    if (le.spends) spent.add(le.spends);
    node.children.find((c) => c.id === le.b)!.needs = le.lock ? { t: 'has', item: key } : le.req;
  }
  // No deadlock: whatever this dungeon makes you spend, its first room gives back for free.
  for (const it of spent) {
    const s = ctx.source(rooms[0].loc, it, `Pots (${ctx.items[it].name})`);
    rooms[0].objs.push({ id: 'o.' + s.id, kind: 'source', label: s.label, sourceId: s.id, style: 'pot', icon: ctx.items[it].icon });
  }
  // optional loops: unused room adjacencies become shortcut candidates, verified later
  // (only between rooms on the same side of every locked door, so key logic is untouched)
  interior.loops = lg.unused
    .filter(([a, b]) => lg.lockDepth.get(a) === lg.lockDepth.get(b))
    .map(([a, b]) => [roomIdx.get(a)!, roomIdx.get(b)!]);
  ctx.interiors.push(interior);
  return { interior, node, entryLoc: rooms[0].loc };
}

export function describeGate(item: ItemId): { req: Req; label: string } {
  const g = gateFor(item);
  return g ? { req: g.req, label: g.label } : { req: NONE, label: 'Open' };
}
