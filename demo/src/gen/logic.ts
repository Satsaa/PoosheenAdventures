// Seed -> blueprint (logic graph + features to realise). No tiles yet.
import type { HNode, ItemId, LogicGraph } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import { BASE_ITEMS, BIOMES, CASTLE_NAMES, ENEMIES, FILLER_NAMES, GATES, ISLAND_BIOMES, ISLAND_NAMES, NPC_NAMES, TOWN_LINES, TOWN_NAMES, UNDER_BIOMES, WEAPONS } from '../core/content';
import { NONE, all, any, at, has, reqItems, use } from '../core/req';
import { solve } from '../core/solver';
import { Ctx, hnode, type RegionBP, type StackBP } from './blueprint';
import { makePlan, type Plan } from './plan';
import { buildStack, localSource, placeItem, tunnel } from './regions';
import { singleRoom } from './dungeon';
import { addNpcs } from './npcs';
import { FILL, addRegions, carveIslands, fillers, growRegions, landMask, neighbours as neighboursOf, splitByRivers, traceRivers, type Partition, type Rect } from './spatial';
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
  //    open sea lies beyond the land on every sea side: the map is the land's rectangle plus that margin
  const M = Math.max(0, Math.round(S.oceanSize));
  const x0 = sea.w ? M : 0, y0 = sea.n ? M : 0;
  const rect: Rect = { x0, y0, x1: x0 + S.worldW - 1, y1: y0 + S.worldH - 1 };
  const GW = rect.x1 + 1 + (sea.e ? M : 0), GH = rect.y1 + 1 + (sea.s ? M : 0);
  const land = landMask(childSeed(seed, 'land'), GW, GH, landScreens(S), sea, rect);
  //    what is not land is a filler region: ocean toward sea sides, ranges, thicket or wastes elsewhere
  const fill = fillers(childSeed(seed, 'fill'), GW, GH, land, sea, rect);
  const nth = new Map<number, number>();
  fill.names = fill.list.map((f) => {
    const k = nth.get(f.kind) ?? 0, names = FILLER_NAMES[f.kind];
    nth.set(f.kind, k + 1);
    return names[k % names.length] + (k >= names.length ? ` ${1 + Math.floor(k / names.length)}` : '');
  });
  ctx.hasOcean = fill.list.some((f) => f.kind === FILL.OCEAN);
  const plan = makePlan(new Rng(childSeed(seed, 'plan')), ctx);
  ctx.hasBoat = plan.tools.includes('boat');

  // 1. worlds: partition space first
  const mainland = (s: number) => land[s] === 1;
  let landCount = 0;
  for (let s = 0; s < land.length; s++) landCount += land[s];
  const base = growRegions(new Rng(childSeed(seed, 'over')), GW, GH, Math.max(1, Math.min(S.regions, Math.floor(landCount / screensPerRegion(S)))), { allowed: mainland });
  // home is the land screen nearest the bottom middle
  let startScreen = 0, startDist = Infinity;
  for (let s = 0; s < land.length; s++) {
    const d = Math.abs((s % GW) - (((rect.x0 + rect.x1) >> 1))) + Math.abs(((s / GW) | 0) - (rect.y1 - 1));
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
  const roomyBanks = (whole: Partition) => (rs: Parameters<typeof splitByRivers>[1]) => {
    const cut = splitByRivers(whole, rs);
    return cut.part.regions.every((screens, i) => screens.length >= Math.min(minBank, whole.regions[cut.origin[i]].length));
  };
  const rivers = S.rivers > 0 ? traceRivers(new Rng(childSeed(seed, 'rivers')), base, (r) => baseThemes[r].elev, S.rivers, roomyBanks(base), (s) => fill.kind[s] === FILL.OCEAN) : [];
  const cut = splitByRivers(base, rivers);
  const origin = cut.origin;
  const entryRegion = cut.part.cell[startScreen];
  // a split region's parts are named after where they lie: "north bank", "east bank", ...
  const centre = (screens: number[]) => ({ x: screens.reduce((a, c) => a + (c % GW), 0) / screens.length, y: screens.reduce((a, c) => a + ((c / GW) | 0), 0) / screens.length });
  const taken = new Set<string>();
  type Theme = (typeof baseThemes)[number];
  const bankThemes = (whole: Partition, split: { part: Partition; origin: number[] }, of: Theme[], keep: number): Theme[] => split.origin.map((o, i) => {
    const t = of[o];
    const parts = split.origin.filter((x) => x === o).length;
    if (parts === 1 || i === keep) { taken.add(t.name); return t; }
    const all = centre(whole.regions[o]), mine = centre(split.part.regions[i]);
    const dx = mine.x - all.x, dy = mine.y - all.y;
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north';
    let name = `${t.name}, ${side} bank`;
    for (let k = 2; taken.has(name); k++) name = `${t.name}, ${side} bank ${k}`;
    taken.add(name);
    return { ...t, name };
  });
  const themes = bankThemes(base, cut, baseThemes, entryRegion);
  // 1b. islands: regions out at sea, with water on every side. Each is tied to the mainland over
  //     its sea, from a coastal region low enough for a pier (or from another island).
  let part = cut.part;
  const seaPairs: [number, number, number][] = [];
  const seaOf = (screens: number[]) => { for (const s of screens) for (const t of neighboursOf(GW, GH, s)) if (fill.kind[t] === FILL.OCEAN) return fill.of[t]; return -1; };
  const isIsle = new Uint8Array(GW * GH);
  // a ferry is the only way over when the world has no Boat, so the fare must fit in the pouch
  if (S.islands > 0 && ctx.hasOcean && (ctx.hasBoat || S.ferryFare <= (ctx.items.rupees.baseCap ?? 0))) {
    const coast = new Map<number, number[]>();
    part.regions.forEach((screens, r) => {
      if (themes[r].elev > 2 || (screens.length <= 1 && part.regions.length > 1)) return;
      const seas = new Set<number>();
      for (const s of screens) for (const t of neighboursOf(GW, GH, s)) if (fill.kind[t] === FILL.OCEAN) seas.add(fill.of[t]);
      for (const f of seas) (coast.get(f) ?? coast.set(f, []).get(f)!).push(r);
    });
    const irng = new Rng(childSeed(seed, 'isles'));
    const isles = carveIslands(irng, GW, GH, part.cell, fill, S.islands, S.islandSize).filter((screens) => coast.has(seaOf(screens)));
    const first = part.regions.length;
    const names = irng.shuffle(ISLAND_NAMES);
    isles.forEach((screens, k) => {
      const f = seaOf(screens);
      for (const r of coast.get(f)!) seaPairs.push([first + k, r, f]);
      for (let j = 0; j < k; j++) if (seaOf(isles[j]) === f) seaPairs.push([first + k, first + j, f]);
      const look = irng.pick(ISLAND_BIOMES);
      const b = BIOMES.find((x) => x.id === look)!;
      themes.push({ biome: b.id, elev: 1, name: names[k % names.length] + (k >= names.length ? ` ${1 + Math.floor(k / names.length)}` : ''), color: b.color });
    });
    for (const screens of isles) for (const s of screens) {
      isIsle[s] = 1;
      fill.list[fill.of[s]].screens = fill.list[fill.of[s]].screens.filter((x) => x !== s);
      fill.kind[s] = FILL.LAND;
      fill.of[s] = -1;
    }
    part = addRegions(part, isles);
  }
  const game = hnode('game', 'game', 'Poosheen Adventures', seed);

  // 2. a portal payload spawns a stacked world that lines up with the region it starts from
  const onPortal = (region: RegionBP, p: (typeof plan.over)[number]) => {
    const kind = p.data!.world as 'under' | 'sky';
    const prng = new Rng(childSeed(seed, kind));
    const seedScreen = prng.pick(part.regions[region.idx]);
    // an island is too small to carry a whole world on its back: what starts there runs on under (or over) the sea
    const isLand = isIsle[seedScreen] ? () => true : mainland;
    const size = kind === 'under' ? S.underworldSize : S.skySize;
    const maxRegions = Math.min(kind === 'under' ? S.underworldRegions : 2, Math.max(1, Math.floor(size / 3)));
    let sub = growRegions(prng, GW, GH, 1, { budget: size, seeds: [seedScreen], allowed: isLand });
    for (let i = 0; i < 6 && maxRegions > 1; i++) {
      const tryP = growRegions(prng, GW, GH, prng.range(Math.min(2, maxRegions), maxRegions), { budget: Math.max(2, prng.range(size - 1, size + 1)), seeds: [seedScreen], allowed: isLand });
      if (connected(tryP)) { sub = tryP; break; }
    }
    const theme = (idx: number): Theme => {
      if (kind === 'sky') return { biome: 'sky', elev: 0, name: ['Cloudnap Isle', 'Highpurr Terrace'][idx % 2], color: '#dfe9ff' };
      // what lies above decides what the cave is like: lakes flood it, mountains fill it with crystal
      const count = new Map<string, number>();
      for (const s of sub.regions[idx]) { const b = part.cell[s] < 0 ? 'beach' : themes[part.cell[s]].biome; count.set(b, (count.get(b) ?? 0) + 1); }
      const above = [...count].sort((a, b) => b[1] - a[1])[0][0];
      const u = UNDER_BIOMES[above];
      let name = u.name;
      for (let k = 2; usedNames.has(name); k++) name = k === 2 ? `Deep ${u.name}` : `${u.name} ${k}`;
      usedNames.add(name);
      // cave floors lie at different heights: stairs and drops between cave systems, and water runs downhill
      return { biome: u.id, elev: S.caveHeights && S.cliffs ? prng.pick(u.id === 'flooded' ? [0, 0, 1] : [0, 1, 1, 2]) : 0, name, color: u.color };
    };
    const whole = sub.regions.map((_, i) => theme(i));
    // rivers run through the underworld too; a cave system cut in two by one becomes two banks
    const under = kind === 'under' && S.caveRivers > 0;
    const subRivers = under ? traceRivers(new Rng(childSeed(seed, 'caverivers')), sub, (r) => whole[r].elev, S.caveRivers, roomyBanks(sub)) : [];
    const subCut = splitByRivers(sub, subRivers);
    const entry = subCut.part.cell[seedScreen];
    const subThemes = bankThemes(sub, subCut, whole, entry);
    const stack = buildStack(ctx, {
      id: kind, kind: kind === 'under' ? 'underworld' : 'sky', name: kind === 'under' ? 'Underworld' : 'Sky', stack: kind === 'under' ? -1 : 1,
      part: subCut.part, seed: childSeed(seed, kind + 'w'), payloads: p.data!.inner as typeof plan.over, entryRegion: entry, entryCaps: p.caps ?? [],
      entryPayloads: prng.chance(0.5) ? 1 : 0, theme: (i) => subThemes[i], onPortal: () => { throw new Error('nested portal'); }, rivers: subRivers,
    });
    stack.hnode.entryCaps = p.caps ?? [];
    stack.hnode.needs = region.hnode.needs;
    const first = stack.regions[entry];
    const e = ctx.edge(region.id, first.id, NONE, 'portal');
    const down = kind === 'under';
    region.feats.push({ f: 'vertical', edgeId: e.id, style: down ? 'stairs-down' : 'beanstalk', label: down ? 'Stairs to the Underworld' : 'Beanstalk to the Sky', req: NONE, other: first });
    game.edges.push({ a: 'over', b: kind, req: NONE, gate: 'portal' });
  };

  // 2a. built places. Once the graph says what goes where, one region becomes the castle (the one
  //     that holds the Sealed Sanctum if it can, else the deepest) and an early one becomes the town.
  let castle: RegionBP | null = null, town: RegionBP | null = null;
  const builtPlaces: NonNullable<Parameters<typeof buildStack>[1]['afterGraph']> = (stack, lg) => {
    const brng = new Rng(childSeed(seed, 'built'));
    const fits = (r: RegionBP, screens: number) => !r.barren && r.idx !== entryRegion && !isIsle[part.regions[r.idx][0]] && part.regions[r.idx].length >= screens;
    const become = (r: RegionBP, biome: string, name: string, color: string) => {
      Object.assign(r, { biome, name, color });
      r.hnode.name = name;
      r.hnode.meta.biome = biome;
      ctx.locs.get(r.id)!.name = name;
      themes[r.idx] = { ...themes[r.idx], biome, name, color };
    };
    const tier = (r: RegionBP) => lg.tier.get(r.id) ?? 0;
    if (S.castle) {
      // a castle's walls are three tiles thick at the sides and four above and below, on both sides
      // of the yard: it needs to be two screens deep everywhere, so every screen of the region must lie
      // in a block of 2 x 2 of its screens. A world with no region that has such a block has no castle.
      const fat = (r: RegionBP) => {
        const own = new Set(part.regions[r.idx]);
        const block = (s: number) => [0, -1, -GW, -GW - 1].some((o) => { const t = s + o, x = t % GW; return t >= 0 && x < GW - 1 && own.has(t) && own.has(t + 1) && own.has(t + GW) && own.has(t + GW + 1); });
        return { all: [...own].every(block), some: [...own].some(block) };
      };
      // (best a region that is such a block all over; else one that has such a block somewhere, whose
      // yard is there and whose narrower parts are mostly wall)
      let cands = stack.regions.filter((r) => fits(r, 4) && fat(r).all);
      if (!cands.length) cands = stack.regions.filter((r) => fits(r, 4) && fat(r).some);
      castle = cands.find((r) => lg.assign.get(r.id)!.some((p) => p.kind === 'sanctum')) ?? cands.sort((a, b) => tier(b) - tier(a))[0] ?? null;
      if (castle) { become(castle, 'castle', brng.pick(CASTLE_NAMES), '#b9b4c6'); castle.blocky = true; }
    }
    if (S.town) {
      // near the start, and of the regions that are, the roomiest
      const cands = stack.regions.filter((r) => fits(r, 4) && r !== castle && r.elev <= 2 && r.biome !== 'lake');
      const near = Math.min(...cands.map(tier)) + 1;
      town = cands.filter((r) => tier(r) <= near).sort((a, b) => part.regions[b.idx].length - part.regions[a.idx].length)[0] ?? null;
      if (town) become(town, 'town', brng.pick(TOWN_NAMES), '#e0b98a');
    }
  };

  const over = buildStack(ctx, {
    id: 'over', kind: 'overworld', name: 'Overworld', stack: 0, part, seed: childSeed(seed, 'overw'), payloads: plan.over, afterGraph: builtPlaces,
    entryRegion, entryCaps: [], entryPayloads: plan.gifts, theme: (i) => themes[i], onPortal, rivers, fill,
    sea: seaPairs.length ? { pairs: seaPairs, needs: ctx.hasBoat ? 'boat' : null } : undefined,
  });
  game.children = ctx.stacks.map((s) => s.hnode);
  for (const r of over.regions) if (isIsle[part.regions[r.idx][0]]) r.hnode.meta.island = true;
  const start = over.regions[entryRegion];
  ctx.start = start.id;
  const regions = ctx.stacks.flatMap((s) => s.regions);
  const roomy = regions.filter((r) => !r.barren);

  // 2b. the sea: regions on a coast may get a dock. With the Boat every dock on a sea is one
  //     hop from the others; a ferryman does the same for a fare. (Built by the tile pass, and
  //     only where a pier fits, so these are extra routes and never part of the tree.)
  if (ctx.hasBoat || S.ferries > 0) {
    const drng = new Rng(childSeed(seed, 'docks'));
    for (const r of over.regions) {
      if (r.barren) continue;
      const seas = new Set<number>();
      for (const s of part.regions[r.idx]) for (const t of neighboursOf(GW, GH, s)) if (fill.kind[t] === FILL.OCEAN) seas.add(fill.of[t]);
      // (a region whose pier already carries the way to an island needs no second one)
      for (const f of seas) if (drng.chance(S.docks) && !r.feats.some((x) => x.f === 'dock' && x.filler === f)) r.feats.push({ f: 'dock', filler: f });
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

  // 3b. the castle keep and the town's houses
  const lived = new Rng(childSeed(seed, 'lived'));
  const big = castle as RegionBP | null, burg = town as RegionBP | null;
  if (big && !big.feats.some((f) => f.f === 'entrance' && f.style === 'sanctum')) {
    // no sanctum to be its keep: the keep is a hall with the royal treasury in it
    const keep = singleRoom(ctx, `${big.id}.keep`, `Keep of ${big.name}`, 'dungeon', childSeed(seed, 'keep'));
    const e = ctx.edge(big.id, keep.entryLoc, NONE, 'portal');
    keep.interior.entranceEdge = e.id;
    const c = ctx.check(keep.entryLoc, 'heart', 'chest', 'Royal treasury (heart piece)');
    keep.room.objs.push({ id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id });
    keep.node.provides = ['heart'];
    big.feats.push({ f: 'entrance', edgeId: e.id, style: 'dungeon', label: keep.interior.name, req: NONE, interior: keep.interior });
    big.hnode.children.push(keep.node);
  }
  if (burg) {
    const names = lived.shuffle(NPC_NAMES.filter((n) => !ctx.npcs.some((p) => p.name === n)));
    const lines = lived.shuffle(TOWN_LINES);
    const homes = Math.min(3, S.townHouses, names.length, Math.floor(part.regions[burg.idx].length / 2));
    for (let k = 0; k < S.townHouses; k++) {
      if (k >= homes) { burg.feats.push({ f: 'house' }); continue; }
      // a few houses can be entered: somebody lives there, and keeps pots or a little treasure
      const who = names[k];
      const home = singleRoom(ctx, `${burg.id}.home${k}`, `${who}'s house`, 'house', childSeed(seed, 'home' + k));
      const e = ctx.edge(burg.id, home.entryLoc, NONE, 'portal');
      home.interior.entranceEdge = e.id;
      if (k === 0) {
        const c = ctx.check(home.entryLoc, 'heart', 'chest', `Chest in ${who}'s house (heart piece)`);
        home.room.objs.push({ id: 'o.' + c.id, kind: 'chest', label: c.label, checkId: c.id });
        home.node.provides = ['heart'];
      } else {
        const s = ctx.source(home.entryLoc, 'rupees', `${who}'s pots (rupees)`);
        home.room.objs.push({ id: 'o.' + s.id, kind: 'source', label: s.label, sourceId: s.id, style: 'pot', icon: '◆' });
      }
      burg.feats.push({ f: 'entrance', edgeId: e.id, style: 'house', label: home.interior.name, req: NONE, interior: home.interior });
      burg.hnode.children.push(home.node);
      ctx.npcs.push({ id: 'town' + k, name: who, role: 'Townsfolk', icon: '☺', color: '#e0b98a', stages: [{ when: NONE, loc: burg.id, dim: burg.stack.id, x: 0, y: 0, line: lines[k % lines.length], offers: [] }] });
    }
  }

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
        if (stack.kind !== 'sky' && !a.barren && !b.barren && rng.chance(S.tunnels)) {
          // the shortcut is a cave under the border
          tunnel(ctx, rng, a, b, g);
          stack.hnode.edges.push({ a: a.id, b: b.id, req: g.req, gate: g.gate });
          if (g.spends) { localSource(ctx, a, g.spends); localSource(ctx, b, g.spends); }
          continue;
        }
        const e = ctx.edge(a.id, b.id, g.req, g.gate);
        stack.openings.push({ edgeId: e.id, a: a.idx, b: b.idx, gate: g.gate, req: g.req, label: g.label + ' (shortcut)', optional: true });
        stack.hnode.edges.push({ a: a.id, b: b.id, req: g.req, gate: g.gate });
        if (g.spends) { localSource(ctx, a, g.spends); localSource(ctx, b, g.spends); }
      }
    }
    // extra stairs: every other region of a stacked world also connects to whatever is above/below it
    if (stack === over) continue;
    for (const r of stack.regions.filter((x) => x.idx !== stack.entry)) {
      if (!rng.chance(S.extraStairs)) continue;
      const screen = rng.pick(stack.part.regions[r.idx]);
      const top = over.regions[over.part.cell[screen]];
      if (!top || top.barren) continue; // nothing above but the sea
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
