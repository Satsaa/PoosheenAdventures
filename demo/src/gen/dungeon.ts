// Place level -> rooms. A dungeon is the same lock-graph problem as the overworld, on a room
// grid, with small keys added. Interiors live in their own dimension, so they can be any size.
import type { HNode, ItemId, LocId, Req } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { ENEMIES, WEAPONS, gateFor } from '../core/content';
import { NONE, has, use } from '../core/req';
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
  const key = ctx.item({ id: 'key:' + scope, name: `Small Key (${name})`, kind: 'key', icon: '⚷', color: '#d8d8e8' });
  const big = ctx.item({ id: 'bigkey:' + scope, name: `Boss Key (${name})`, kind: 'key', icon: '♛', color: '#ffd24a' });

  // Floors: a dungeon either climbs or digs down. Every floor uses the same room grid, so a
  // staircase joins the room directly above to the room directly below.
  const count = Math.max(2, rng.range(S.dungeonRooms - 1, S.dungeonRooms + 1));
  const maxFloors = Math.max(1, Math.min(S.dungeonFloors, Math.floor(count / 3)));
  const F = maxFloors > 1 ? rng.range(Math.max(1, maxFloors - 1), maxFloors) : 1;
  const digs = rng.chance(0.6);
  const per = Math.ceil(count / F);
  // the room grid grows with the room count, leaving about a third of it empty for interesting shapes
  const GH = Math.max(2, Math.ceil(Math.sqrt(per * 1.2)));
  const GW = Math.max(2, Math.ceil((per * 1.5) / GH));
  const entryCell = (GH - 1) * GW + rng.range(GW >> 2, GW - 1 - (GW >> 2));
  const dimOf = (f: number) => (f === 0 ? id : `${id}.f${f}`);
  const rid = (f: number, c: number) => `${dimOf(f)}.r${c}`;
  const where = new Map<string, { f: number; c: number }>();
  const candidates: [string, string][] = [];
  const floorCells: number[][] = [];
  for (let f = 0, left = count; f < F; f++) {
    const want = f === F - 1 ? left : Math.min(left - (F - 1 - f), per);
    const start = f === 0 ? entryCell : rng.pick(floorCells[f - 1]);
    const cells = growBlob(rng, GW, GH, start, Math.max(1, want));
    left -= cells.length;
    floorCells.push(cells);
    for (const c of cells) where.set(rid(f, c), { f, c });
    for (const c of cells) for (const n of neighbours(GW, GH, c)) if (n > c && cells.includes(n)) candidates.push([rid(f, c), rid(f, n)]);
    if (f === 0) continue;
    // stairs: where the floor was started from, and sometimes a second flight elsewhere
    const shared = cells.filter((c) => c !== start && floorCells[f - 1].includes(c));
    for (const c of [start, ...(shared.length && rng.chance(0.5) ? [rng.pick(shared)] : [])]) candidates.push([rid(f - 1, c), rid(f, c)]);
  }
  const nodes = [...where.keys()];
  const floorName = (f: number) => (F === 1 ? '' : digs ? (f === 0 ? '1F' : `B${f}`) : `${f + 1}F`);

  // The brief for the rooms: order of what must be found. Keys come before the doors they open.
  const p = (it: ItemId, extra: Partial<Payload> = {}): Payload => ({ id: it, kind: 'item', provides: [it], ...extra });
  let keys = S.smallKeys === 0 ? 0 : rng.range(Math.max(1, S.smallKeys - 1), S.smallKeys);
  const payloads: Payload[] = [];
  if (keys-- > 0) payloads.push(p(key));
  if (tool) payloads.push(p(tool));
  while (keys-- > 0) payloads.push(p(key));
  payloads.push(p(big), { id: 'boss', kind: 'boss', provides: ['medallion'], terminal: true });

  const lg = buildLockGraph({
    rng, nodes, entry: rid(0, entryCell), candidates, entryCaps: caps, payloads,
    entryPayloads: 0, freeChance: 0.65, lockScope: scope, depthBias: 1.6,
    noGate: S.timeDoors ? undefined : new Set(['sundial']),
  });

  // some open doorways are sealed until the room behind them is cleared: a lock made of enemies
  const sealed = new Set<string>();
  for (const le of lg.edges) {
    if (le.gate !== 'open' || !rng.chance(0.45 * Math.min(1, S.enemies))) continue;
    const owned = [...caps, ...(lg.capsAt.get(le.b) ?? [])];
    const weapon = WEAPONS.find((x) => owned.includes(x));
    if (!weapon) continue;
    const ammo = weapon === 'bow' ? 'arrows' : weapon === 'bombBag' ? 'bombs' : null;
    le.gate = 'foes';
    le.req = ammo ? use(ammo) : has(weapon);
    le.spends = ammo ?? undefined;
    le.label = 'Sealed until the room is cleared';
    sealed.add(le.a); // the fight is on the near side of the door
  }
  const foes = ENEMIES.filter((e) => e.biomes.includes('dungeon'));

  const node = hnode(id, 'place', name, seed, { placeKind: 'dungeon', dim: id });
  const floors: InteriorBP[] = floorCells.map((_, f) => ({
    id: dimOf(f), name: F === 1 ? name : `${name}, ${floorName(f)}`, style: 'dungeon', gw: GW, gh: GH, rooms: [], doors: [], entryRoom: 0,
    entranceEdge: '', group: id, floor: f, floorName: floorName(f), stairs: [], heights: S.caveHeights,
  }));
  const roomIdx = new Map<string, number>();
  let entry: RoomBP | null = null;
  lg.order.forEach((r, i) => {
    const { f, c: cell } = where.get(r)!;
    const got = lg.assign.get(r)!;
    const isBoss = got.some((g) => g.kind === 'boss');
    const rname = i === 0 ? 'Entrance hall' : isBoss ? 'Boss lair' : `Chamber ${i}`;
    const loc = ctx.loc(r, `${name}${F > 1 ? ' ' + floorName(f) : ''}: ${rname}`, r, dimOf(f));
    const room: RoomBP = { cell, loc, objs: [] };
    entry ??= room;
    for (const g of got) {
      const it = g.provides[0];
      const c = ctx.check(loc, it, isBoss && g.kind === 'boss' ? 'boss' : 'chest', g.kind === 'boss' ? `Boss of ${name}` : `${name} chest`);
      room.objs.push({ id: 'o.' + c.id, kind: g.kind === 'boss' ? 'boss' : 'chest', label: c.label, checkId: c.id });
    }
    if (!isBoss) {
      const count = Math.max(sealed.has(r) ? 1 : 0, i === 0 ? 0 : Math.min(5, Math.round(rng.next() * 2 * S.enemies)));
      for (let k = 0; k < count; k++) {
        const e = rng.weighted(foes, (x) => x.weight);
        room.objs.push({ id: `o.en.${r}.${k}`, kind: 'enemy', enemy: e.id, label: e.name, icon: e.icon });
      }
    }
    if (!got.length && i > 0 && rng.chance(0.5)) {
      const c = ctx.check(loc, 'heart', 'chest', `${name} side chest`);
      room.objs.push({ id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id });
    }
    const rn = hnode(r, 'room', F > 1 ? `${floorName(f)}: ${rname}` : rname, childSeed(seed, r), { dim: dimOf(f), tier: lg.tier.get(r) });
    rn.locs.push(loc);
    rn.entryCaps = lg.capsAt.get(r) ?? [];
    rn.provides = got.map((g) => g.provides[0]);
    node.children.push(rn);
    roomIdx.set(r, floors[f].rooms.length);
    floors[f].rooms.push(room);
  });

  const spent = new Set<ItemId>();
  const reached = new Set<number>([0]);
  for (const le of lg.edges) {
    const e = ctx.edge(le.a, le.b, le.req, le.gate, le.lock ? { lock: le.lock } : {});
    const A = where.get(le.a)!, B = where.get(le.b)!;
    if (A.f === B.f) floors[A.f].doors.push({ edgeId: e.id, a: roomIdx.get(le.a)!, b: roomIdx.get(le.b)!, gate: le.gate, req: le.req, label: le.label });
    else {
      // a staircase: one flight, seen from both floors. Deeper means down in a dungeon that digs.
      const slot = Math.min(A.f, B.f) % 2;
      const label = le.gate === 'open' ? 'Stairs' : `Stairs (${le.label.charAt(0).toLowerCase()}${le.label.slice(1)})`;
      const flight = (from: typeof A, to: typeof B, r: string, home: boolean) =>
        floors[from.f].stairs!.push({ edgeId: e.id, room: roomIdx.get(r)!, to: dimOf(to.f), up: digs ? to.f < from.f : to.f > from.f, gate: le.gate, req: le.req, label, slot, home });
      flight(A, B, le.a, false);
      flight(B, A, le.b, !reached.has(B.f)); // the first flight to reach a floor is its way back out
      reached.add(B.f);
    }
    node.edges.push({ a: le.a, b: le.b, req: le.lock ? { t: 'has', item: key } : le.req, gate: le.gate });
    if (le.spends) spent.add(le.spends);
    node.children.find((c) => c.id === le.b)!.needs = le.lock ? { t: 'has', item: key } : le.req;
  }
  // No deadlock: whatever this dungeon makes you spend, its first room gives back for free.
  for (const it of spent) {
    const s = ctx.source(entry!.loc, it, `Pots (${ctx.items[it].name})`);
    entry!.objs.push({ id: 'o.' + s.id, kind: 'source', label: s.label, sourceId: s.id, style: 'pot', icon: ctx.items[it].icon });
  }
  // optional loops: unused room adjacencies on one floor become shortcut candidates, verified later
  // (only between rooms on the same side of every locked door, so key logic is untouched)
  for (const [a, b] of lg.unused) {
    const A = where.get(a)!, B = where.get(b)!;
    if (A.f === B.f && lg.lockDepth.get(a) === lg.lockDepth.get(b)) (floors[A.f].loops ??= []).push([roomIdx.get(a)!, roomIdx.get(b)!]);
  }
  ctx.interiors.push(...floors);
  return { interior: floors[0], node, entryLoc: entry!.loc };
}

export function describeGate(item: ItemId): { req: Req; label: string } {
  const g = gateFor(item);
  return g ? { req: g.req, label: g.label } : { req: NONE, label: 'Open' };
}
