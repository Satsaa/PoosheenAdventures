// Seed -> blueprint (logic graph + features to realise). No tiles yet.
import type { HNode, ItemId, LogicGraph } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { BASE_ITEMS, BIOMES, ENEMIES, GATES, UNDER_BIOMES, WEAPONS } from '../core/content';
import { NONE, all, any, at, has, reqItems, use } from '../core/req';
import { solve } from '../core/solver';
import { Ctx, hnode, type RegionBP, type StackBP } from './blueprint';
import { makePlan, type Plan } from './plan';
import { buildStack, localSource, placeItem } from './regions';
import { singleRoom } from './dungeon';
import { addNpcs } from './npcs';
import { FILL, fillers, growRegions, landMask, neighbours as neighboursOf, splitByRivers, traceRivers, type Partition } from './spatial';
import { oneWaySafe, requiredTable } from './validate';
import { landScreens, screensPerRegion, type GenSettings } from '../core/settings';

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

export function buildBlueprint(seed: number, S: GenSettings): Blueprint {
  const ctx = new Ctx(S);
  const GW = S.worldW, GH = S.worldH;
  BASE_ITEMS.forEach((d) => ctx.item({ ...d, upgrades: d.upgrades?.map((u) => ({ ...u })) }));
  // item settings: how much can be carried
  for (const id of ['bombs', 'arrows', 'rupees']) ctx.items[id].baseCap = S.items[id]?.cap ?? ctx.items[id].baseCap;
  ctx.items.rupees.upgrades![0].cap = S.items.wallet?.cap ?? 300;
  const rng = new Rng(childSeed(seed, 'world'));

  // 0. the shape of the world. Every seed has its own islandiness: each side of the map is sea
  //    with probability 1 - landlocked, so 0 is a full island and 1 has no ocean at all.
  const srng = new Rng(childSeed(seed, 'shape'));
  const landlocked = S.coastFromSeed ? srng.next() : S.landlocked;
  const sea = { n: srng.next() >= landlocked, e: srng.next() >= landlocked, s: srng.next() >= landlocked, w: srng.next() >= landlocked };
  ctx.shape = { landlocked, sea };
  const land = landMask(childSeed(seed, 'land'), GW, GH, landScreens(S), sea);
  //    what is not land is a filler region: ocean toward sea sides, ranges, thicket or wastes elsewhere
  const fill = fillers(childSeed(seed, 'fill'), GW, GH, land, sea);
  ctx.hasOcean = fill.list.some((f) => f.kind === FILL.OCEAN);
  const plan = makePlan(new Rng(childSeed(seed, 'plan')), ctx);

  // 1. worlds: partition space first
  const isLand = (s: number) => land[s] === 1;
  let landCount = 0;
  for (let s = 0; s < land.length; s++) landCount += land[s];
  const base = growRegions(new Rng(childSeed(seed, 'over')), GW, GH, Math.max(1, Math.min(S.regions, Math.floor(landCount / screensPerRegion(S)))), { allowed: isLand });
  // home is the land screen nearest the bottom middle
  let startScreen = 0, startDist = Infinity;
  for (let s = 0; s < land.length; s++) {
    const d = Math.abs((s % GW) - ((GW >> 1) - 1)) + Math.abs(((s / GW) | 0) - (GH - 2));
    if (land[s] && base.cell[s] >= 0 && d < startDist) { startDist = d; startScreen = s; }
  }
  const baseEntry = base.cell[startScreen];
  let others = rng.shuffle(BIOMES.filter((b) => b.id !== 'plains'));
  const usedNames = new Set<string>();
  const baseThemes = base.regions.map((_, i) => {
    if (!others.length) others = rng.shuffle(BIOMES.filter((b) => b.id !== 'plains'));
    const b = i === baseEntry ? BIOMES[0] : others.pop()!;
    const name = rng.shuffle(b.name).find((n) => !usedNames.has(n)) ?? `${b.name[0]} ${i}`;
    usedNames.add(name);
    return { biome: b.id, elev: S.cliffs ? rng.pick(b.elev) : 1, name, color: b.color };
  });
  // rivers flow downhill over this land; a region cut in two by one becomes two banks
  // (a course that would leave a bank too small to hold anything is not taken; wider rivers need wider banks)
  const minBank = 1 + S.riverWidth;
  const roomyBanks = (rs: Parameters<typeof splitByRivers>[1]) => {
    const cut = splitByRivers(base, rs);
    return cut.part.regions.every((screens, i) => screens.length >= Math.min(minBank, base.regions[cut.origin[i]].length));
  };
  const rivers = S.rivers > 0 ? traceRivers(new Rng(childSeed(seed, 'rivers')), base, (r) => baseThemes[r].elev, S.rivers, roomyBanks, (s) => fill.kind[s] === FILL.OCEAN) : [];
  const { part, origin } = splitByRivers(base, rivers);
  const entryRegion = part.cell[startScreen];
  // a split region's parts are named after where they lie: "north bank", "east bank", ...
  const centre = (screens: number[]) => ({ x: screens.reduce((a, c) => a + (c % GW), 0) / screens.length, y: screens.reduce((a, c) => a + ((c / GW) | 0), 0) / screens.length });
  const taken = new Set<string>();
  const themes = origin.map((o, i) => {
    const t = baseThemes[o];
    const parts = origin.filter((x) => x === o).length;
    if (parts === 1 || i === entryRegion) { taken.add(t.name); return t; }
    const whole = centre(base.regions[o]), mine = centre(part.regions[i]);
    const dx = mine.x - whole.x, dy = mine.y - whole.y;
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north';
    let name = `${t.name}, ${side} bank`;
    for (let k = 2; taken.has(name); k++) name = `${t.name}, ${side} bank ${k}`;
    taken.add(name);
    return { ...t, name };
  });
  const game = hnode('game', 'game', 'Poosheen Adventures', seed);

  // 2. a portal payload spawns a stacked world that lines up with the region it starts from
  const onPortal = (region: RegionBP, p: (typeof plan.over)[number]) => {
    const kind = p.data!.world as 'under' | 'sky';
    const prng = new Rng(childSeed(seed, kind));
    const seedScreen = prng.pick(part.regions[region.idx]);
    const size = kind === 'under' ? S.underworldSize : S.skySize;
    const maxRegions = Math.min(kind === 'under' ? S.underworldRegions : 2, Math.max(1, Math.floor(size / 3)));
    let sub = growRegions(prng, GW, GH, 1, { budget: size, seeds: [seedScreen], allowed: isLand });
    for (let i = 0; i < 6 && maxRegions > 1; i++) {
      const tryP = growRegions(prng, GW, GH, prng.range(Math.min(2, maxRegions), maxRegions), { budget: Math.max(2, prng.range(size - 1, size + 1)), seeds: [seedScreen], allowed: isLand });
      if (connected(tryP)) { sub = tryP; break; }
    }
    const theme = (idx: number) => {
      if (kind === 'sky') return { biome: 'sky', elev: 0, name: ['Cloudnap Isle', 'Highpurr Terrace'][idx % 2], color: '#dfe9ff' };
      // what lies above decides what the cave is like: lakes flood it, mountains fill it with crystal
      const count = new Map<string, number>();
      for (const s of sub.regions[idx]) count.set(themes[part.cell[s]].biome, (count.get(themes[part.cell[s]].biome) ?? 0) + 1);
      const above = [...count].sort((a, b) => b[1] - a[1])[0][0];
      const u = UNDER_BIOMES[above];
      let name = u.name;
      for (let k = 2; usedNames.has(name); k++) name = k === 2 ? `Deep ${u.name}` : `${u.name} ${k}`;
      usedNames.add(name);
      return { biome: u.id, elev: 0, name, color: u.color };
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
    entryRegion, entryCaps: [], entryPayloads: plan.gifts, theme: (i) => themes[i], onPortal, rivers, fill,
  });
  game.children = ctx.stacks.map((s) => s.hnode);
  const start = over.regions[entryRegion];
  ctx.start = start.id;
  const regions = ctx.stacks.flatMap((s) => s.regions);
  const roomy = regions.filter((r) => !r.barren);

  // 2b. the sea: regions on a coast may get a dock. With the Boat every dock on a sea is one
  //     hop from the others; a ferryman does the same for a fare. (Built by the tile pass, and
  //     only where a pier fits, so these are extra routes and never part of the tree.)
  if (plan.tools.includes('boat') || S.ferries > 0) {
    const drng = new Rng(childSeed(seed, 'docks'));
    for (const r of over.regions) {
      if (r.barren) continue;
      const seas = new Set<number>();
      for (const s of part.regions[r.idx]) for (const t of neighboursOf(GW, GH, s)) if (fill.kind[t] === FILL.OCEAN) seas.add(fill.of[t]);
      for (const f of seas) if (drng.chance(S.docks)) r.feats.push({ f: 'dock', filler: f });
    }
  }

  // 3. the village: spawn, shop, and a rupee source that needs nothing
  start.feats.push({ f: 'spot', obj: { id: 'o.start', kind: 'start', label: 'Home (start)' } });
  const pots = ctx.source(start.id, 'rupees', 'Village pots (rupees)');
  start.feats.push({ f: 'spot', obj: { id: 'o.' + pots.id, kind: 'source', label: pots.label, sourceId: pots.id, style: 'pot', icon: '◆' } });
  const shop = singleRoom(ctx, `${start.id}.shop`, 'Village Shop', 'shop', childSeed(seed, 'shop'));
  const se = ctx.edge(start.id, shop.entryLoc, NONE, 'portal');
  shop.interior.entranceEdge = se.id;
  for (const [ammo, price] of [['bombs', S.priceBombs], ['arrows', S.priceArrows]] as const) {
    const s = ctx.source(shop.entryLoc, ammo, `Shop shelf: ${ctx.items[ammo].name} (${price} rupees)`, use('rupees', price));
    shop.room.objs.push({ id: 'o.' + s.id, kind: 'source', label: s.label, sourceId: s.id, style: 'pot', icon: ctx.items[ammo].icon });
  }
  const pricey = ctx.check(shop.entryLoc, 'heart', 'shop', `Shop: heart piece (${S.priceHeart} rupees)`, use('rupees', S.priceHeart));
  shop.room.objs.push({ id: 'o.' + pricey.id, kind: 'chest', label: pricey.label, checkId: pricey.id });
  shop.node.provides = ['heart'];
  start.feats.push({ f: 'entrance', edgeId: se.id, style: 'shop', label: 'Village Shop', req: NONE, interior: shop.interior });
  start.hnode.children.push(shop.node);

  // 4. optional secrets: heart pieces behind ANY tool, so later tools reward backtracking
  for (const r of roomy) {
    const frng = new Rng(childSeed(r.hnode.seed, 'filler'));
    if (frng.chance(S.secrets)) placeItem(ctx, frng, r, 'heart', frng.shuffle(plan.tools).slice(0, 3), false);
    if (r !== start && frng.chance(0.4)) localSource(ctx, r, 'rupees');
  }
  // every tool should open something somewhere: a tool no edge asks for gets its own secret alcove
  const asked = new Set<ItemId>();
  for (const e of ctx.edges) reqItems(e.req, asked);
  const drng = new Rng(childSeed(seed, 'dead'));
  for (const t of S.everyToolUsed ? plan.tools : []) {
    if (!GATES[t] || (t === 'sundial' && !S.timeDoors)) continue;
    const spent = GATES[t].spends;
    if (asked.has(t) || (spent && asked.has(spent))) continue;
    placeItem(ctx, drng, drng.pick(roomy), 'heart', [t], false, true);
  }
  // time of day only matters if the player can ever reach the other half of it
  const timeOk = S.timeFlows || plan.tools.includes('sundial');
  const trng = new Rng(childSeed(seed, 'time'));
  if (timeOk) {
    // moonlit and sunlit chests: some secrets only show themselves at one time of day
    for (const r of roomy) for (const f of r.feats) {
      const obj = f.f === 'spot' || f.f === 'pocket' ? f.obj : null;
      const c = obj?.checkId ? ctx.checks.find((k) => k.id === obj.checkId) : undefined;
      if (!obj || !c || c.item !== 'heart' || c.kind !== 'chest' || !trng.chance(S.timeChests)) continue;
      const phase = trng.chance(0.7) ? 'night' : 'day';
      c.req = all(c.req, at(phase));
      c.label = `${phase === 'night' ? 'Moonlit' : 'Sunlit'} ${c.label.charAt(0).toLowerCase()}${c.label.slice(1)}`;
      obj.label = c.label;
      obj.phase = phase;
    }
    if (S.timeShop) {
      for (const src of ctx.sources) if (src.loc === shop.entryLoc) src.req = all(at('day'), src.req);
      pricey.req = all(at('day'), pricey.req);
      shop.interior.name = 'Village Shop (open by day)';
    }
  }
  // enemies: they roam regions, and beating them is a renewable source of what they drop
  const weapon = WEAPONS.find((x) => plan.tools.includes(x));
  const fight = weapon === 'sword' ? has('sword') : weapon === 'bow' ? use('arrows') : weapon === 'bombBag' ? use('bombs') : null;
  for (const r of roomy) {
    const erng = new Rng(childSeed(r.hnode.seed, 'enemies'));
    const pool = ENEMIES.filter((e) => (e.biomes.includes(r.biome) || e.biomes.includes('*')) && (!(e.night || e.day) || (timeOk && S.timeCreatures > 0)));
    const count = Math.min(16, Math.round(r.stack.part.regions[r.idx].length * 0.7 * S.enemies * (r === start ? 0.4 : 1)));
    const seen = new Set<string>();
    for (let k = 0; k < count && pool.length; k++) {
      const e = erng.weighted(pool, (x) => x.weight * (x.night || x.day ? S.timeCreatures : 1));
      const phase = e.night ? 'night' : e.day ? 'day' : undefined;
      r.feats.push({ f: 'spot', obj: { id: `o.en.${r.id}.${k}`, kind: 'enemy', enemy: e.id, label: e.name, icon: e.icon, phase } });
      if (!fight || seen.has(e.drops + (phase ?? ''))) continue;
      seen.add(e.drops + (phase ?? ''));
      ctx.source(r.id, e.drops, `${e.plural} (${ctx.items[e.drops].name.toLowerCase()})`, phase ? all(fight, at(phase)) : fight).enemy = e.id;
    }
  }
  // home should look like a village
  for (let k = 0; k < S.village; k++) start.feats.push({ f: 'house' });
  // without the trade chain the wallet would not exist; hide it in a chest instead
  if (!S.tradeQuest) placeItem(ctx, drng, drng.pick(roomy), 'wallet', drng.shuffle(plan.tools).slice(0, 2), false);
  addNpcs(ctx, new Rng(childSeed(seed, 'npc')), plan, regions, start);

  const graph: LogicGraph = {
    timeFlows: S.timeFlows, start: start.id, goal: 'flag:victory',
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
  const S = ctx.settings;
  const tools = (r: RegionBP, s: RegionBP): ItemId[] => {
    const late = (r.hnode.meta.tier ?? 0) >= (s.hnode.meta.tier ?? 0) ? r : s;
    return late.hnode.entryCaps.filter((c) => GATES[c] && (c !== 'sundial' || S.timeDoors));
  };
  for (const stack of ctx.stacks) {
    const byId = new Map(stack.regions.map((r) => [r.id, r]));
    for (const [ia, ib] of stack.unused ?? []) {
      if (!rng.chance(S.shortcuts)) continue;
      let a = byId.get(ia)!, b = byId.get(ib)!;
      if (a.elev !== b.elev && S.ledges) {
        if (a.elev < b.elev) [a, b] = [b, a];
        // proposed now, judged below once every other loop exists
        const e = ctx.edge(a.id, b.id, NONE, 'ledge', { oneWay: true });
        stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: 'ledge', req: NONE, label: 'Ledge (one-way drop)', oneWay: true, optional: true });
        stack.hnode.edges.push({ a: a.id, b: b.id, req: NONE, gate: 'ledge', oneWay: true });
      } else {
        const pool = tools(a, b);
        if (!pool.length) continue;
        const g = GATES[rng.pick(pool)];
        const e = ctx.edge(a.id, b.id, g.req, g.gate);
        stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: g.gate, req: g.req, label: g.label + ' (shortcut)', optional: true });
        stack.hnode.edges.push({ a: a.id, b: b.id, req: g.req, gate: g.gate });
        if (g.spends) { localSource(ctx, a, g.spends); localSource(ctx, b, g.spends); }
      }
    }
    // extra stairs: every other region of a stacked world also connects to whatever is above/below it
    if (stack === over) continue;
    for (const r of stack.regions.slice(1)) {
      if (!rng.chance(S.extraStairs)) continue;
      const screen = rng.pick(stack.part.regions[r.idx]);
      const top = over.regions[over.part.cell[screen]];
      if (top.barren) continue;
      const e = ctx.edge(top.id, r.id, NONE, 'portal');
      const down = stack.stack < 0;
      top.feats.push({ f: 'vertical', edgeId: e.id, style: down ? 'stairs-down' : 'beanstalk', label: down ? 'Stairs to the Underworld (shortcut)' : 'Beanstalk (shortcut)', req: NONE, other: r, optional: true });
    }
  }
  // dungeon shortcuts only join rooms on the same side of every locked door, so key logic should
  // be untouched; one solve confirms it, and if it ever disagrees they are all taken back
  const added: { d: (typeof ctx.interiors)[number]; id: string }[] = [];
  for (const d of ctx.interiors) {
    for (const [a, b] of d.loops ?? []) {
      if (!rng.chance(S.dungeonLoops)) continue;
      const e = ctx.edge(d.rooms[a].loc, d.rooms[b].loc, NONE, 'open');
      d.doors.push({ edgeId: e.id, a, b, gate: 'open', req: NONE, label: 'Open doorway (loop)' });
      added.push({ d, id: e.id });
    }
  }
  if (added.length) {
    const s = solve(graph, ctx.items);
    if (!s.ok || s.unreachedChecks.length) {
      const ids = new Set(added.map((x) => x.id));
      for (let i = ctx.edges.length - 1; i >= 0; i--) if (ids.has(ctx.edges[i].id)) ctx.edges.splice(i, 1);
      for (const { d } of added) d.doors = d.doors.filter((x) => !ids.has(x.edgeId));
    }
  }
  // More routes mean fewer items are unavoidable at the top of a ledge, so re-check every drop now.
  for (let again = true; again; ) {
    again = false;
    const drops = ctx.edges.filter((x) => x.oneWay);
    const table = drops.length ? requiredTable(graph, ctx.items) : new Map();
    for (const e of drops) {
      if (oneWaySafe(graph, ctx.items, e, table)) continue;
      ctx.edges.splice(ctx.edges.indexOf(e), 1);
      for (const st of ctx.stacks) {
        st.openings = st.openings.filter((o) => o.edgeId !== e.id);
        st.hnode.edges = st.hnode.edges.filter((h) => !(h.oneWay && h.a === e.a && h.b === e.b));
      }
      again = true;
    }
  }
}

/**
 * Report upward, after loops exist: what each node provides is the union of its children's,
 * and `needs` is recomputed as "any of the ways in", so extra stairs and shortcuts show up.
 */
export function finishTree(n: HNode, ctx: Ctx): ItemId[] {
  const own = new Set(n.provides);
  for (const l of n.locs) for (const c of ctx.checks) if (c.loc === l) own.add(c.item);
  for (const c of n.children) for (const it of finishTree(c, ctx)) own.add(it);
  n.provides = [...own];
  n.entryCaps = [...new Set(n.entryCaps)];
  const inside = new Set<string>();
  const collect = (m: HNode) => { m.locs.forEach((l) => inside.add(l)); m.children.forEach(collect); };
  collect(n);
  if (inside.has(ctx.start)) n.needs = NONE; // you begin here: nothing is needed to get in
  else if (inside.size && n.kind !== 'game') {
    const ways = ctx.edges
      .filter((e) => (inside.has(e.b) && !inside.has(e.a)) || (inside.has(e.a) && !inside.has(e.b) && !e.oneWay))
      .map((e) => (e.lock ? has('key:' + e.lock) : e.req));
    if (ways.length) n.needs = any(...ways.filter((w, i) => ways.findIndex((x) => JSON.stringify(x) === JSON.stringify(w)) === i));
  }
  return n.provides;
}
