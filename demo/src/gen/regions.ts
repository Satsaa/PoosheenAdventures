// World level -> regions -> places. One routine for overworld, underworld and sky.
import type { DimId, DimKind, Edge, GateKind, HNode, ItemId, Req } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { BIOMES, DUNGEON_NAMES, GATES, NPC_NAMES } from '../core/content';
import { NONE, any, has, use } from '../core/req';
import { Ctx, hnode, type RegionBP, type StackBP } from './blueprint';
import { buildLockGraph, type Payload } from './lockgraph';
import { buildDungeon, singleRoom } from './dungeon';
import type { Partition } from './spatial';

export interface StackSpec {
  id: DimId;
  kind: DimKind;
  name: string;
  stack: number;
  part: Partition;
  seed: number;
  payloads: Payload[];
  entryRegion: number;
  entryCaps: ItemId[];
  entryPayloads: number;
  theme: (idx: number) => { biome: string; elev: number; name: string; color: string };
  rivers?: StackBP['rivers'];
  fill?: StackBP['fill'];
  /** islands: region pairs that can be joined over the water, with the ocean filler they share */
  sea?: { pairs: [number, number, number][]; needs: ItemId | null };
  /** a portal payload landed in `region`: build the sub-world and connect it */
  onPortal: (region: RegionBP, payload: Payload) => void;
}

const likesOf = (biome: string): ItemId[] => BIOMES.find((b) => b.id === biome)?.likes ?? [];

export function buildStack(ctx: Ctx, spec: StackSpec): StackBP {
  const rng = new Rng(spec.seed);
  const world = hnode(spec.id, 'world', spec.name, spec.seed, { dim: spec.id });
  const stack: StackBP = { id: spec.id, kind: spec.kind, name: spec.name, stack: spec.stack, part: spec.part, regions: [], openings: [], hnode: world };
  stack.rivers = spec.rivers;
  stack.fill = spec.fill;
  ctx.stacks.push(stack);

  spec.part.regions.forEach((_, idx) => {
    const th = spec.theme(idx);
    const id = `${spec.id}${idx}`;
    const node = hnode(id, 'region', th.name, childSeed(spec.seed, id), { biome: th.biome, elev: th.elev, dim: spec.id });
    node.locs.push(ctx.loc(id, th.name, id, spec.id));
    stack.regions.push({ id, idx, stack, hnode: node, feats: [], ...th, barren: spec.part.regions[idx].length <= 1 && spec.part.regions.length > 1 });
  });
  const byId = new Map(stack.regions.map((r) => [r.id, r]));
  const seaOf = new Map<string, number>();
  for (const [a, b, f] of spec.sea?.pairs ?? []) { seaOf.set(a + '|' + b, f); seaOf.set(b + '|' + a, f); }

  // region graph: only regions that touch may be connected
  const lg = buildLockGraph({
    rng,
    nodes: stack.regions.map((r) => r.id),
    entry: stack.regions[spec.entryRegion].id,
    candidates: spec.part.adj.map((a) => [stack.regions[a.a].id, stack.regions[a.b].id]),
    entryCaps: spec.entryCaps,
    payloads: spec.payloads,
    entryPayloads: spec.entryPayloads,
    noGate: ctx.settings.timeDoors ? undefined : new Set(['sundial']),
    freeChance: 1 - ctx.settings.lockDensity,
    depthBias: ctx.settings.linearity,
    likes: (a, b) => [...likesOf(byId.get(a)!.biome), ...likesOf(byId.get(b)!.biome)],
    barren: new Set(stack.regions.filter((r) => r.barren).map((r) => r.id)),
    seaCandidates: spec.sea?.pairs.map(([a, b]) => [stack.regions[a].id, stack.regions[b].id]),
    seaNeeds: spec.sea?.needs,
  });
  for (const le of lg.edges) {
    const a = byId.get(le.a)!, b = byId.get(le.b)!;
    if (le.sea) {
      // over the water: a pier on each shore, both on the same sea
      const f = seaOf.get(a.idx + '|' + b.idx)!;
      seaDock(ctx, a, f, rng);
      b.hnode.needs = seaDock(ctx, b, f, rng).req;
      continue;
    }
    const e = ctx.edge(a.id, b.id, le.req, le.gate);
    stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: le.gate, req: le.req, label: le.label });
    world.edges.push({ a: a.id, b: b.id, req: le.req, gate: le.gate });
    b.hnode.needs = le.req;
    if (le.spends) {
      // loops may let the player arrive from either side, so both sides get a refill
      localSource(ctx, a, le.spends);
      localSource(ctx, b, le.spends);
    }
  }
  stack.unused = lg.unused;

  // each region turns its payloads into places, in progression order
  for (const rid of lg.order) {
    const region = byId.get(rid)!;
    region.hnode.entryCaps = lg.capsAt.get(rid) ?? [];
    region.hnode.meta.tier = lg.tier.get(rid);
    world.children.push(region.hnode);
    const prng = new Rng(region.hnode.seed);
    for (const p of lg.assign.get(rid)!) realise(ctx, prng, region, p, spec.onPortal);
  }
  return stack;
}

/**
 * The pier that joins `region` to the sea `filler`. Unlike a dock that is only built where it
 * happens to fit, this one is an edge of the graph: an island hangs on it, so the map must build it.
 * Without a Boat in the world a ferryman works every such pier.
 */
export function seaDock(ctx: Ctx, region: RegionBP, filler: number, rng: Rng): Edge {
  const built = region.feats.find((f) => f.f === 'dock' && f.filler === filler && f.edgeId);
  if (built && built.f === 'dock') return ctx.edges.find((e) => e.id === built.edgeId)!;
  const stack = region.stack, sea = `${stack.id}.fill${filler}`;
  const fare = use('rupees', ctx.settings.ferryFare);
  const ferry = !ctx.hasBoat || rng.chance(ctx.settings.ferries);
  const req = ctx.hasBoat ? (ferry ? any(has('boat'), fare) : has('boat')) : fare;
  if (!ctx.locs.has(sea)) {
    const name = stack.fill?.names?.[filler] ?? 'The Sea';
    const node = hnode(sea, 'region', name, 0, { biome: 'ocean', elev: 0, dim: stack.id });
    node.locs.push(ctx.loc(sea, name, sea, stack.id));
    node.needs = req;
    stack.hnode.children.push(node);
  }
  const e = ctx.edge(region.id, sea, req, 'dock');
  stack.hnode.edges.push({ a: region.id, b: sea, req, gate: 'dock' });
  region.feats.push({ f: 'dock', filler, edgeId: e.id, ferry });
  return e;
}

/** Whatever a gate makes the player spend, the near side of the gate gives back. */
export function localSource(ctx: Ctx, region: RegionBP, item: ItemId): void {
  const label = item === 'bombs' ? 'Bomb flowers' : item === 'arrows' ? 'Arrow reeds' : 'Tall grass';
  if (ctx.sources.some((s) => s.loc === region.id && s.gives === item && s.req.t === 'none')) return;
  const s = ctx.source(region.id, item, label);
  region.feats.push({ f: 'spot', obj: { id: 'o.' + s.id, kind: 'source', label, sourceId: s.id, style: 'flower', icon: ctx.items[item].icon } });
}

function place(ctx: Ctx, region: RegionBP, kind: string, name: string, provides: ItemId[], needs: Req = NONE): HNode {
  const id = `${region.id}.${ctx.uid(kind)}`;
  const n = hnode(id, 'place', name, childSeed(region.hnode.seed, id), { placeKind: kind, dim: region.stack.id });
  n.provides = provides.slice();
  n.needs = needs;
  region.hnode.children.push(n);
  return n;
}

function realise(ctx: Ctx, rng: Rng, region: RegionBP, p: Payload, onPortal: StackSpec['onPortal']): void {
  const caps = p.caps ?? [];
  switch (p.kind) {
    case 'item':
      return p.data?.gift ? elderGift(ctx, region, p) : placeItem(ctx, rng, region, p.provides[0], caps, true);
    case 'dungeon': {
      const nth = Number((p.data!.scope as string).slice(1)) - 1;
      const round = Math.floor(nth / DUNGEON_NAMES.length);
      const name = DUNGEON_NAMES[nth % DUNGEON_NAMES.length] + (round ? ' ' + ['II', 'III', 'IV', 'V', 'VI'][round - 1] : '');
      const d = buildDungeon(ctx, `${region.id}.${p.data!.scope}`, name, childSeed(region.hnode.seed, p.id), p);
      d.node.entryCaps = caps;
      const e = ctx.edge(region.id, d.entryLoc, NONE, 'portal');
      d.interior.entranceEdge = e.id;
      region.feats.push({ f: 'entrance', edgeId: e.id, style: 'dungeon', label: name, req: NONE, interior: d.interior });
      region.hnode.children.push(d.node);
      return;
    }
    case 'portal':
      return onPortal(region, p);
    case 'favor': {
      const who = NPC_NAMES[rng.int(NPC_NAMES.length)];
      const quest = Object.values(ctx.items).find((i) => i.id === 'quest:favor')!;
      const c = ctx.check(region.id, p.provides[0], 'npc', `${who}'s thanks`, p.needs);
      const node = place(ctx, region, 'npc', `${who}'s camp`, p.provides, p.needs);
      node.entryCaps = caps;
      const stage = (line: string, when: Req, offers: string[]) => ({ when, loc: region.id, dim: region.stack.id, x: 0, y: 0, line, offers });
      ctx.npcs.push({
        id: 'favor', name: who, role: 'Favor', icon: '☺', color: '#f0c674',
        stages: [
          stage(`I dropped my ${quest.name} somewhere out there. Bring it back and I'll talk to the guard for you.`, NONE, [c.id]),
          stage(`You found it! The guard owes me one. The pass is open to you now.`, has(p.provides[0]), []),
        ],
      });
      ctx.quests.push({
        id: 'q.favor', name: `A favor for ${who}`, main: false, reward: p.provides[0],
        steps: [
          { text: `Find the ${quest.name}`, req: NONE, check: ctx.checks.find((k) => k.item === quest.id)?.id },
          { text: `Return it to ${who} in ${region.name}`, req: p.needs ?? NONE, check: c.id },
          { text: 'The guard lets you through', req: has(p.provides[0]) },
        ],
      });
      return;
    }
    case 'sanctum': {
      const s = singleRoom(ctx, `${region.id}.sanctum`, 'Sealed Sanctum', 'sanctum', childSeed(region.hnode.seed, 'sanctum'));
      const e = ctx.edge(region.id, s.entryLoc, p.needs ?? NONE, 'seal');
      s.interior.entranceEdge = e.id;
      const c = ctx.check(s.entryLoc, p.provides[0], 'boss', 'Baddie, the big fat Poosheen');
      s.room.objs.push({ id: 'o.' + c.id, kind: 'boss', label: c.label, checkId: c.id });
      s.node.provides = p.provides.slice();
      s.node.needs = p.needs ?? NONE;
      s.node.entryCaps = caps;
      ctx.sanctumCaps = caps;
      region.feats.push({ f: 'entrance', edgeId: e.id, style: 'sanctum', label: 'Sealed Sanctum', req: p.needs ?? NONE, interior: s.interior });
      region.hnode.children.push(s.node);
      return;
    }
  }
}

function elderGift(ctx: Ctx, region: RegionBP, p: Payload): void {
  const c = ctx.check(region.id, p.provides[0], 'npc', "Elder's gift");
  let elder = ctx.npcs.find((n) => n.id === 'elder');
  if (!elder) {
    place(ctx, region, 'npc', "Elder's porch", []);
    elder = { id: 'elder', name: 'Elder Toud', role: 'Main quest', icon: '♔', color: '#c8a2ff', stages: [{ when: NONE, loc: region.id, dim: region.stack.id, x: 0, y: 0, line: '', offers: [] }] };
    ctx.npcs.push(elder);
  }
  region.hnode.children.find((n) => n.name === "Elder's porch")!.provides.push(p.provides[0]);
  elder.stages[0].offers.push(c.id);
  const names = elder.stages[0].offers.map((o) => ctx.items[ctx.checks.find((k) => k.id === o)!.item].name);
  elder.stages[0].line = `It is dangerous to nap alone. Take ${names.length > 1 ? 'these: ' : 'this '}${names.join(', ')}.`;
}

/** A loose item: cave, gated alcove, or chest in the open. `main` items never hide behind later tools. */
export function placeItem(ctx: Ctx, rng: Rng, region: RegionBP, item: ItemId, caps: ItemId[], main: boolean, forceAlcove = false): void {
  const gateable = caps.filter((c) => GATES[c] && (c !== 'sundial' || ctx.settings.timeDoors));
  const roll = forceAlcove ? 0.5 : rng.next();
  const what = ctx.items[item].name;
  if (roll < 0.34) {
    const dark = caps.includes('lantern') && rng.chance(0.4);
    const id = `${region.id}.${ctx.uid('cave')}`;
    // a river can run through a place too: the cave's treasure then sits on the far bank
    const wet = caps.includes('flippers') && rng.chance(ctx.settings.riverCaves);
    const s = singleRoom(ctx, id, wet ? 'River Cave' : dark ? 'Lightless Cave' : 'Cave', 'cave', childSeed(region.hnode.seed, id));
    const req = dark ? has('lantern') : NONE;
    const e = ctx.edge(region.id, s.entryLoc, req, dark ? 'dark' : 'portal');
    s.interior.entranceEdge = e.id;
    let chestLoc = s.entryLoc;
    if (wet) {
      const swim = has('flippers');
      chestLoc = ctx.loc(id + '.far', 'River Cave: far bank', id + '.far', id);
      const far = hnode(chestLoc, 'room', 'Far bank', childSeed(region.hnode.seed, id + 'far'), { dim: id });
      far.locs.push(chestLoc);
      far.needs = swim;
      far.provides = [item];
      s.node.children.push(far);
      const cross = ctx.edge(s.entryLoc, chestLoc, swim, 'water');
      s.node.edges.push({ a: s.entryLoc, b: chestLoc, req: swim, gate: 'water' });
      s.room.far = { loc: chestLoc, edgeId: cross.id, req: swim, objs: [] };
    }
    const c = ctx.check(chestLoc, item, 'chest', `${wet ? 'River cave' : 'Cave'} chest (${what})`);
    (s.room.far?.objs ?? s.room.objs).push({ id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id });
    s.node.provides = [item];
    s.node.needs = req;
    if (main) s.node.entryCaps = caps;
    region.feats.push({ f: 'entrance', edgeId: e.id, style: 'cave', label: s.interior.name, req, interior: s.interior });
    region.hnode.children.push(s.node);
  } else if (roll < 0.8 && gateable.length) {
    const g = GATES[rng.weighted(gateable, (c) => 1 + gateable.indexOf(c))];
    const node = place(ctx, region, 'alcove', `${g.label} alcove`, [item], g.req);
    if (main) node.entryCaps = caps;
    const loc = ctx.loc(node.id, `${g.label} alcove, ${region.name}`, node.id, region.stack.id);
    node.locs.push(loc);
    const e = ctx.edge(region.id, loc, g.req, g.gate);
    const c = ctx.check(loc, item, 'chest', `Alcove chest (${what})`);
    region.feats.push({ f: 'pocket', edgeId: e.id, gate: g.gate as GateKind, req: g.req, label: g.label, loc, obj: { id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id } });
    if (g.spends) localSource(ctx, region, g.spends);
  } else {
    const c = ctx.check(region.id, item, 'chest', `Chest in the open (${what})`);
    place(ctx, region, 'grove', main ? 'Clearing' : 'Hidden nook', [item]).entryCaps = main ? caps : [];
    region.feats.push({ f: 'spot', obj: { id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id } });
  }
}
