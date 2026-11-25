// Seed -> blueprint (logic graph + features to realise). No tiles yet.
import type { HNode, ItemId, LogicGraph } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { BASE_ITEMS, BIOMES, GATES, UNDER_BIOMES } from '../core/content';
import { NONE, use } from '../core/req';
import { solve } from '../core/solver';
import { Ctx, hnode, type RegionBP, type StackBP } from './blueprint';
import { makePlan, type Plan } from './plan';
import { buildStack, localSource, placeItem } from './regions';
import { singleRoom } from './dungeon';
import { addNpcs } from './npcs';
import { growRegions, type Partition } from './spatial';
import { oneWaySafe } from './validate';

export const GW = 8;
export const GH = 6;

export interface Blueprint {
  ctx: Ctx;
  plan: Plan;
  tree: HNode;
  graph: LogicGraph;
  start: RegionBP;
}

function connected(p: Partition): boolean {
  const seen = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const { a, b } of p.adj) {
      if (seen.has(a) !== seen.has(b)) { seen.add(a); seen.add(b); grew = true; }
    }
  }
  return seen.size === p.regions.length;
}

export function buildBlueprint(seed: number): Blueprint {
  const ctx = new Ctx();
  BASE_ITEMS.forEach((d) => ctx.item({ ...d }));
  const rng = new Rng(childSeed(seed, 'world'));
  const plan = makePlan(new Rng(childSeed(seed, 'plan')), ctx);
  plan.over[0].data = { gift: true };

  // 1. worlds: partition space first
  const part = growRegions(new Rng(childSeed(seed, 'over')), GW, GH, 7);
  const entryRegion = part.cell[4 * GW + 3];
  const others = rng.shuffle(BIOMES.filter((b) => b.id !== 'plains'));
  const themes = part.regions.map((_, i) => {
    const b = i === entryRegion ? BIOMES[0] : others.pop()!;
    return { biome: b.id, elev: rng.pick(b.elev), name: rng.pick(b.name), color: b.color };
  });
  const game = hnode('game', 'game', 'Poosheen Adventures', seed);

  // 2. a portal payload spawns a stacked world that lines up with the region it starts from
  const onPortal = (region: RegionBP, p: (typeof plan.over)[number]) => {
    const kind = p.data!.world as 'under' | 'sky';
    const prng = new Rng(childSeed(seed, kind));
    const seedScreen = prng.pick(part.regions[region.idx]);
    let sub = growRegions(prng, GW, GH, 1, { budget: kind === 'under' ? 9 : 5, seeds: [seedScreen] });
    for (let i = 0; i < 6; i++) {
      const tryP = growRegions(prng, GW, GH, kind === 'under' ? prng.range(2, 3) : 2, { budget: kind === 'under' ? prng.range(11, 15) : prng.range(6, 9), seeds: [seedScreen] });
      if (connected(tryP)) { sub = tryP; break; }
    }
    const theme = (idx: number) => {
      if (kind === 'sky') return { biome: 'sky', elev: 0, name: ['Cloudnap Isle', 'Highpurr Terrace'][idx % 2], color: '#dfe9ff' };
      // what lies above decides what the cave is like: lakes flood it, mountains fill it with crystal
      const count = new Map<string, number>();
      for (const s of sub.regions[idx]) count.set(themes[part.cell[s]].biome, (count.get(themes[part.cell[s]].biome) ?? 0) + 1);
      const above = [...count].sort((a, b) => b[1] - a[1])[0][0];
      const u = UNDER_BIOMES[above];
      return { biome: u.id, elev: 0, name: u.name, color: u.color };
    };
    const stack = buildStack(ctx, {
      id: kind, kind: kind === 'under' ? 'underworld' : 'sky', name: kind === 'under' ? 'Underworld' : 'Sky', stack: kind === 'under' ? -1 : 1,
      part: sub, seed: childSeed(seed, kind + 'w'), payloads: p.data!.inner as typeof plan.over, entryRegion: 0, entryCaps: p.caps ?? [],
      entryPayloads: prng.chance(0.5) ? 1 : 0, theme, onPortal: () => { throw new Error('nested portal'); },
    });
    stack.hnode.entryCaps = p.caps ?? [];
    stack.hnode.needs = region.hnode.needs;
    const e = ctx.edge(region.id, stack.regions[0].id, NONE, 'portal');
    const down = kind === 'under';
    region.feats.push({ f: 'vertical', edgeId: e.id, style: down ? 'stairs-down' : 'beanstalk', label: down ? 'Stairs to the Underworld' : 'Beanstalk to the Sky', req: NONE, other: stack.regions[0] });
    game.edges.push({ a: 'over', b: kind, req: NONE, gate: 'portal' });
  };

  const over = buildStack(ctx, {
    id: 'over', kind: 'overworld', name: 'Overworld', stack: 0, part, seed: childSeed(seed, 'overw'), payloads: plan.over,
    entryRegion, entryCaps: [], entryPayloads: 1, theme: (i) => themes[i], onPortal,
  });
  game.children = ctx.stacks.map((s) => s.hnode);
  const start = over.regions[entryRegion];
  const regions = ctx.stacks.flatMap((s) => s.regions);

  // 3. the village: spawn, shop, and a rupee source that needs nothing
  start.feats.push({ f: 'spot', obj: { id: 'o.start', kind: 'start', label: 'Home (start)' } });
  const pots = ctx.source(start.id, 'rupees', 'Village pots (rupees)');
  start.feats.push({ f: 'spot', obj: { id: 'o.' + pots.id, kind: 'source', label: pots.label, sourceId: pots.id, style: 'pot', icon: '◆' } });
  const shop = singleRoom(ctx, `${start.id}.shop`, 'Village Shop', 'shop', childSeed(seed, 'shop'));
  const se = ctx.edge(start.id, shop.entryLoc, NONE, 'portal');
  shop.interior.entranceEdge = se.id;
  for (const [ammo, price] of [['bombs', 20], ['arrows', 10]] as const) {
    const s = ctx.source(shop.entryLoc, ammo, `Shop shelf: ${ctx.items[ammo].name} (${price} rupees)`, use('rupees', price));
    shop.room.objs.push({ id: 'o.' + s.id, kind: 'source', label: s.label, sourceId: s.id, style: 'shelf', icon: ctx.items[ammo].icon });
  }
  const pricey = ctx.check(shop.entryLoc, 'heart', 'shop', 'Shop: heart piece (200 rupees, needs the big wallet)', use('rupees', 200));
  shop.room.objs.push({ id: 'o.' + pricey.id, kind: 'chest', label: pricey.label, checkId: pricey.id });
  shop.node.provides = ['heart'];
  start.feats.push({ f: 'entrance', edgeId: se.id, style: 'shop', label: 'Village Shop', req: NONE, interior: shop.interior });
  start.hnode.children.push(shop.node);

  // 4. optional secrets: heart pieces behind ANY tool, so later tools reward backtracking
  for (const r of regions) {
    const frng = new Rng(childSeed(r.hnode.seed, 'filler'));
    if (frng.chance(0.75)) placeItem(ctx, frng, r, 'heart', frng.shuffle(plan.tools).slice(0, 3), false);
    if (r !== start && frng.chance(0.4)) localSource(ctx, r, 'rupees');
  }
  addNpcs(ctx, new Rng(childSeed(seed, 'npc')), plan, regions, start);

  const graph: LogicGraph = {
    start: start.id, goal: 'flag:victory',
    locs: [...ctx.locs].map(([id, l]) => ({ id, ...l, x: 0, y: 0 })),
    edges: ctx.edges, checks: ctx.checks, sources: ctx.sources,
  };
  if (!solve(graph, ctx.items).ok) throw new Error('tree not solvable');
  addLoops(ctx, new Rng(childSeed(seed, 'loops')), graph, over);
  finishTree(game, ctx);
  return { ctx, plan, tree: game, graph, start };
}

/** Cycles: shortcuts, one-way ledges, extra stairs between stacked worlds. Each is kept only if still valid. */
function addLoops(ctx: Ctx, rng: Rng, graph: LogicGraph, over: StackBP): void {
  const tools = (r: RegionBP, s: RegionBP): ItemId[] => {
    const late = (r.hnode.meta.tier ?? 0) >= (s.hnode.meta.tier ?? 0) ? r : s;
    return late.hnode.entryCaps.filter((c) => GATES[c]);
  };
  for (const stack of ctx.stacks) {
    const byId = new Map(stack.regions.map((r) => [r.id, r]));
    for (const [ia, ib] of stack.unused ?? []) {
      if (!rng.chance(0.75)) continue;
      let a = byId.get(ia)!, b = byId.get(ib)!;
      if (a.elev !== b.elev) {
        if (a.elev < b.elev) [a, b] = [b, a];
        const e = ctx.edge(a.id, b.id, NONE, 'ledge', { oneWay: true });
        if (oneWaySafe(graph, ctx.items, e)) {
          stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: 'ledge', req: NONE, label: 'Ledge (one-way drop)', oneWay: true });
          stack.hnode.edges.push({ a: a.id, b: b.id, req: NONE, gate: 'ledge', oneWay: true });
        } else ctx.edges.pop();
      } else {
        const pool = tools(a, b);
        if (!pool.length) continue;
        const g = GATES[rng.pick(pool)];
        const e = ctx.edge(a.id, b.id, g.req, g.gate);
        stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: g.gate, req: g.req, label: g.label + ' (shortcut)' });
        stack.hnode.edges.push({ a: a.id, b: b.id, req: g.req, gate: g.gate });
        if (g.spends) { localSource(ctx, a, g.spends); localSource(ctx, b, g.spends); }
      }
    }
    // extra stairs: every other region of a stacked world also connects to whatever is above/below it
    if (stack === over) continue;
    for (const r of stack.regions.slice(1)) {
      if (!rng.chance(0.85)) continue;
      const screen = rng.pick(stack.part.regions[r.idx]);
      const top = over.regions[over.part.cell[screen]];
      const e = ctx.edge(top.id, r.id, NONE, 'portal');
      const down = stack.stack < 0;
      top.feats.push({ f: 'vertical', edgeId: e.id, style: down ? 'stairs-down' : 'beanstalk', label: down ? 'Stairs to the Underworld (shortcut)' : 'Beanstalk (shortcut)', req: NONE, other: r });
    }
  }
  // dungeon shortcuts can disturb worst-case key logic, so each one is re-solved
  for (const d of ctx.interiors) {
    for (const [a, b] of d.loops ?? []) {
      if (!rng.chance(0.3)) continue;
      const e = ctx.edge(d.rooms[a].loc, d.rooms[b].loc, NONE, 'open');
      const s = solve(graph, ctx.items);
      if (s.ok && !s.unreachedChecks.length) d.doors.push({ edgeId: e.id, a, b, gate: 'open', req: NONE, label: 'Open doorway (loop)' });
      else ctx.edges.pop();
    }
  }
  // More routes mean fewer items are unavoidable at the top of a ledge, so re-check every drop now.
  for (let again = true; again; ) {
    again = false;
    for (const e of ctx.edges.filter((x) => x.oneWay)) {
      if (oneWaySafe(graph, ctx.items, e)) continue;
      ctx.edges.splice(ctx.edges.indexOf(e), 1);
      for (const st of ctx.stacks) {
        st.openings = st.openings.filter((o) => o.edgeId !== e.id);
        st.hnode.edges = st.hnode.edges.filter((h) => !(h.oneWay && h.a === e.a && h.b === e.b));
      }
      again = true;
    }
  }
}

/** Report upward: what each node provides is the union of its children's. */
function finishTree(n: HNode, ctx: Ctx): ItemId[] {
  const own = new Set(n.provides);
  for (const l of n.locs) for (const c of ctx.checks) if (c.loc === l) own.add(c.item);
  for (const c of n.children) for (const it of finishTree(c, ctx)) own.add(it);
  n.provides = [...own];
  return n.provides;
}
