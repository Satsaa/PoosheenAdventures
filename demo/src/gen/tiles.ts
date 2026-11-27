// Blueprint -> tile maps, then PROVE the maps say the same thing as the logic graph:
// flood-fill the walkable tiles into zones and check every edge, gate and object against it.
import type { Dimension, DimId, Edge, LocId, LogicGraph, MapObject } from '../core/types';
import { D } from '../core/types';
import type { Blueprint } from './logic';
import { finishTree } from './logic';
import { NONE, any, has, use } from '../core/req';
import { FERRY_NAMES } from '../core/content';
import { FILL } from './spatial';
import { hnode } from './blueprint';
import { oneWaySafe, requiredTable } from './validate';
import { realiseInterior } from './interiorTiles';
import { carveOpenings, initStack, type ST } from './stackBase';
import { placeFeatures } from './stackFeatures';
import { settleShape, settleTiles } from './settle';

export interface TileResult {
  dims: Dimension[];
  problems: string[];
}

interface Layer {
  dim: Dimension;
  barriers: Map<number, string>;
  anchors: Map<number, LocId>;
}

export function realiseTiles(bp: Blueprint, seed: number): TileResult {
  const problems: string[] = [];
  // loops the map has no room for are taken out of the graph again; they were never needed
  let dropped = 0;
  const drop = (edgeId: string) => {
    const k = bp.ctx.edges.findIndex((e) => e.id === edgeId);
    if (k < 0) return;
    const e = bp.ctx.edges[k];
    bp.ctx.edges.splice(k, 1);
    for (const w of bp.tree.children) w.edges = w.edges.filter((h) => !(h.a === e.a && h.b === e.b && h.gate === e.gate));
    dropped++;
  };
  const sts = new Map<DimId, ST>();
  for (const s of bp.ctx.stacks) {
    const S = bp.ctx.settings;
    const st = initStack(s, s.part.gw, s.part.gh, seed, S.borderWobble, S.scenery, S.riverWidth, S.lava);
    carveOpenings(st, drop);
    // the walls are settled now, on the bare terrain, before anything is placed: every building,
    // object and prop then goes onto ground that already has its final shape
    settleShape(st.dim, (i) => st.barriers.has(i));
    sts.set(s.id, st);
  }
  const S0 = bp.ctx.settings;
  const doors = placeFeatures(sts, drop, { boat: bp.plan.tools.includes('boat'), ferries: S0.ferries, outcrops: S0.outcrops });
  const layers: Layer[] = [...sts.values()].map((st) => ({ dim: st.dim, barriers: st.barriers, anchors: st.anchors }));
  for (const st of sts.values()) problems.push(...st.problems);

  // interiors, linked both ways to the door that leads to them
  for (const ib of bp.ctx.interiors) {
    const it = realiseInterior(ib, seed);
    layers.push({ dim: it.dim, barriers: it.barriers, anchors: it.anchors });
    if (ib.floor) continue; // an upper or lower floor: reached by stairs, which the interior placed itself
    const ways = [{ edgeId: ib.entranceEdge, at: it.exit }, ...(ib.exits ?? []).map((x) => ({ edgeId: x.edgeId, at: it.exits.get(x.edgeId)! }))];
    ways.forEach((way, k) => {
      const door = doors.get(way.edgeId);
      if (!door) { problems.push(`${ib.name} has no entrance on the map`); return; }
      door.obj.to = { dim: it.dim.id, x: way.at.x, y: way.at.y };
      if (k === 0) it.dim.parent = { dim: door.dim, x: door.x, y: door.y };
      it.dim.objects.push({ id: 'x.' + way.edgeId, kind: 'entrance', x: way.at.x, y: way.at.y, label: 'Way out', style: 'exit', dir: 's', edgeId: way.edgeId, to: { dim: door.dim, x: door.x, y: door.y } });
    });
  }

  for (const l of layers) zones(l, bp.graph, problems);
  const over = sts.get('over');
  const wet = new Set<string>();
  for (const st of sts.values()) for (const id of addRivers(bp, st, problems)) wet.add(id);
  if (over) for (const id of addSeas(bp, over)) wet.add(id);
  if (wet.size || dropped) {
    settleOneWays(bp, layers);
    finishTree(bp.tree, bp.ctx);
  }
  // props and walls get what the tile table says they need (the checker then confirms it)
  for (const l of layers) settleTiles(l.dim, (i) => l.barriers.has(i) || l.anchors.has(i));
  verify(layers, bp.graph, problems, wet);

  // coordinates the rest of the app wants
  const locAt = new Map<LocId, { x: number; y: number }>();
  for (const l of layers) for (const [i, loc] of l.anchors) locAt.set(loc, { x: i % l.dim.w, y: (i / l.dim.w) | 0 });
  for (const loc of bp.graph.locs) Object.assign(loc, locAt.get(loc.id) ?? {});
  for (const l of layers) for (const o of l.dim.objects) {
    if (o.npcId === undefined) continue;
    const stage = bp.ctx.npcs.find((n) => n.id === o.npcId)?.stages[o.stage ?? 0];
    if (stage) { stage.x = o.x; stage.y = o.y; }
  }
  return { dims: layers.map((l) => l.dim), problems };
}

/** Flood-fill walkable tiles into zones. Gate tiles separate zones; each zone must hold exactly one anchor. */
function zones(l: Layer, g: LogicGraph, problems: string[]): void {
  const { dim, barriers, anchors } = l;
  const { w, h } = dim, n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const objAt = new Map<number, MapObject>(dim.objects.map((o) => [o.y * w + o.x, o]));
  for (let s = 0; s < n; s++) {
    if (dim.solid[s] || barriers.has(s) || comp[s] >= 0) continue;
    const tiles = [s];
    comp[s] = s;
    const locs = new Set<LocId>();
    for (let k = 0; k < tiles.length; k++) {
      const i = tiles[k];
      const a = anchors.get(i);
      if (a) locs.add(a);
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || comp[j] >= 0 || dim.solid[j] || barriers.has(j)) continue;
        comp[j] = s;
        tiles.push(j);
      }
    }
    if (locs.size === 1) {
      const z = dim.zoneLoc.push([...locs][0]) - 1;
      for (const i of tiles) dim.zone[i] = z;
    } else if (locs.size === 0) {
      // a walkable scrap nobody owns: close it, unless something was placed in it
      for (const i of tiles) {
        if (objAt.has(i)) problems.push(`${objAt.get(i)!.label} sits in an unowned pocket of ${dim.name}`);
        dim.solid[i] = 1;
        if (!dim.deco[i] && dim.kind !== 'sky') dim.deco[i] = D.ROCK;
      }
    } else problems.push(`zones leak into each other in ${dim.name}: ${[...locs].join(' + ')}`);
  }
  // a gate tile is drawn with the zone on its near side
  const edge = new Map(g.edges.map((e) => [e.id, e]));
  for (const [i, id] of barriers) dim.zone[i] = dim.zoneLoc.indexOf(edge.get(id)?.a ?? '');
}

function verify(layers: Layer[], g: LogicGraph, problems: string[], realised: Set<string>): void {
  const edge = new Map(g.edges.map((e) => [e.id, e]));
  const check = new Map(g.checks.map((c) => [c.id, c]));
  const source = new Map(g.sources.map((s) => [s.id, s]));
  for (const { dim, barriers } of layers) {
    const { w } = dim;
    // land zones only: river water has a zone of its own, but a gate is judged by the ground on either side
    const locOf = (i: number) => (barriers.has(i) || dim.solid[i] || dim.zone[i] < 0 ? undefined : dim.zoneLoc[dim.zone[i]]);
    // every gate (one tile, or a whole band of water) has exactly the two zones of its edge on either side
    const sidesOf = new Map<string, Set<LocId>>();
    for (const [i, id] of barriers) {
      const sides = sidesOf.get(id) ?? sidesOf.set(id, new Set()).get(id)!;
      for (const j of [i - 1, i + 1, i - w, i + w]) { const l = locOf(j); if (l) sides.add(l); }
    }
    for (const [id, sides] of sidesOf) {
      const e = edge.get(id);
      if (!e) problems.push(`gate without an edge in ${dim.name}`);
      else if (sides.size !== 2 || !sides.has(e.a) || !sides.has(e.b)) problems.push(`gate ${id} in ${dim.name} joins [${[...sides].join(', ')}] instead of ${e.a} / ${e.b}`);
      realised.add(id);
    }
    // every object stands in the zone the logic says it is in
    for (const o of dim.objects) {
      const here = locOf(o.y * w + o.x);
      const want = o.checkId ? check.get(o.checkId)?.loc : o.sourceId ? source.get(o.sourceId)?.loc : undefined;
      if (want && here !== want) problems.push(`${o.label} is in ${here} but logic says ${want}`);
      if (o.kind === 'entrance' && o.edgeId) {
        const e = edge.get(o.edgeId)!;
        if (here !== e.a && here !== e.b) problems.push(`${o.label} stands in ${here}, not on its edge ${e.a} / ${e.b}`);
        realised.add(o.edgeId);
      }
    }
  }
  for (const e of g.edges) if (!realised.has(e.id)) problems.push(`edge ${e.a} — ${e.b} has no gate or door on any map`);
}

const RIVER_NAMES = ['Purrling River', 'Whiskerwater', 'The Long Lap', 'Catnap Creek', 'Yarnwind River', 'Biscuit Brook'];
const CAVE_RIVER_NAMES = ['The Drip', 'Blindfish Run', 'Echo Stream', 'Coldwater Seep', 'The Sunless Lap', 'Gloomwater'];

/**
 * Rivers become logic only after they are painted, because where a bank is level with the water
 * is a fact of the finished map. Every stretch of river is a zone; a level bank is a two-way
 * "shore" edge that needs the Swim Gear; a drop to the next stretch is a one-way waterfall.
 * Extra two-way edges can never break a solvable world, and one-way ones are re-checked below.
 */
function addRivers(bp: Blueprint, st: ST, problems: string[]): Set<string> {
  const made = new Set<string>();
  const { dim, w, river, bridge, segs } = st;
  if (!segs.length) return made;
  const RIVERS = dim.kind === 'underworld' ? CAVE_RIVER_NAMES : RIVER_NAMES;
  const n = dim.ground.length;
  const tilesOf: number[][] = segs.map(() => []);
  const shores: Set<LocId>[] = segs.map(() => new Set());
  const falls = new Map<string, { tile: number; dir: 'n' | 'e' | 's' | 'w' }>();
  for (let i = 0; i < n; i++) {
    const g = river[i];
    if (!g) continue;
    tilesOf[g - 1].push(i);
    const level = segs[g - 1].level, x = i % w;
    const around: [number, 'n' | 'e' | 's' | 'w'][] = [[i - w, 'n'], [x < w - 1 ? i + 1 : -1, 'e'], [i + w, 's'], [x > 0 ? i - 1 : -1, 'w']];
    for (const [j, dir] of around) {
      if (j < 0 || j >= n) continue;
      if (river[j]) {
        if (river[j] !== g && segs[river[j] - 1].level < level && !falls.has(`${g - 1}>${river[j] - 1}`)) falls.set(`${g - 1}>${river[j] - 1}`, { tile: j, dir });
      } else if (!dim.solid[j] && !st.barriers.has(j) && dim.zone[j] >= 0 && dim.elev[j] === level) {
        shores[g - 1].add(dim.zoneLoc[dim.zone[j]]); // a level bank: wade in, wade out
      }
    }
  }
  // each stretch must be one body of water, or swimmers could not pass along it
  const mark = new Uint8Array(n);
  segs.forEach((_, k) => {
    const all = tilesOf[k];
    if (!all.length) return;
    let count = 0;
    const stack = [all[0]];
    mark[all[0]] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      const x = i % w;
      for (const j of [i - w, x < w - 1 ? i + 1 : -1, i + w, x > 0 ? i - 1 : -1]) {
        if (j < 0 || j >= n || mark[j] || river[j] !== k + 1) continue;
        mark[j] = 1;
        stack.push(j);
      }
    }
    if (count !== all.length) problems.push(`a stretch of ${RIVERS[segs[k].river % RIVERS.length]} is broken into separate pools`);
  });

  const swim = bp.plan.tools.includes('flippers');
  const world = bp.tree.children.find((c) => c.id === dim.id)!;
  const kept: (LocId | null)[] = [];
  segs.forEach((sg, k) => {
    const up = k > 0 && segs[k - 1].river === sg.river ? k - 1 : -1;
    const fall = up >= 0 ? falls.get(`${up}>${k}`) : undefined;
    const upLoc = up >= 0 ? kept[up] : null;
    const all = tilesOf[k].filter((i) => !bridge[i]);
    if (!swim || sg.lava || !all.length || !(shores[k].size || (upLoc && fall))) {
      kept.push(null);
      // still a waterfall to look at, even when nobody can swim (molten rock just pours over the edge)
      if (fall && !sg.lava) dim.objects.push({ id: `wf.${k}`, kind: 'gate', gate: 'waterfall', x: fall.tile % w, y: (fall.tile / w) | 0, label: 'Waterfall', dir: fall.dir });
      return;
    }
    const stretches = segs.filter((o) => o.river === sg.river).length;
    const course = stretches === 1 ? '' : `, ${sg.seg === 0 ? 'upper' : sg.seg === stretches - 1 ? 'lower' : 'middle'} course`;
    const name = RIVERS[sg.river % RIVERS.length] + (stretches > 3 && sg.seg > 0 && sg.seg < stretches - 1 ? `${course} ${sg.seg}` : course);
    const id = `${dim.id}.rv${sg.river}.${sg.seg}`;
    const mid = all[all.length >> 1];
    const node = hnode(id, 'region', name, 0, { biome: 'river', elev: sg.level, dim: dim.id });
    node.locs.push(bp.ctx.loc(id, name, id, dim.id));
    node.needs = has('flippers');
    world.children.push(node);
    bp.graph.locs.push({ id, name, hnode: id, dim: dim.id, x: mid % w, y: (mid / w) | 0 });
    dim.regions.push({ id, name, biome: 'river', elev: sg.level, x: mid % w, y: (mid / w) | 0, color: '#4fb6e8' });
    st.anchors.set(mid, id);
    const z = dim.zoneLoc.push(id) - 1;
    for (const i of all) dim.zone[i] = z;
    for (const land of shores[k]) {
      const e = bp.ctx.edge(land, id, has('flippers'), 'shore');
      world.edges.push({ a: land, b: id, req: e.req, gate: 'shore' });
      made.add(e.id);
    }
    if (fall) {
      const e: Edge | null = upLoc ? bp.ctx.edge(upLoc, id, NONE, 'waterfall', { oneWay: true }) : null;
      if (e) { world.edges.push({ a: e.a, b: e.b, req: NONE, gate: 'waterfall', oneWay: true }); made.add(e.id); }
      dim.objects.push({ id: e ? 'g.' + e.id : `wf.${k}`, kind: 'gate', gate: 'waterfall', x: fall.tile % w, y: (fall.tile / w) | 0, label: 'Waterfall', dir: fall.dir, edgeId: e?.id });
    }
    kept.push(id);
  });
  return made;
}

/**
 * Rivers add routes, and more routes change what a player is sure to own at the top of a drop.
 * The map is already painted, so an unsafe drop is not removed: it gets a rope ladder or a
 * climbing vine and becomes two-way, which is always safe.
 */
function settleOneWays(bp: Blueprint, layers: Layer[]): void {
  const g = bp.graph, items = bp.ctx.items;
  for (let again = true; again; ) {
    again = false;
    const drops = g.edges.filter((e) => e.oneWay);
    if (!drops.length) return;
    const table = requiredTable(g, items);
    for (const e of drops) {
      if (oneWaySafe(g, items, e, table)) continue;
      delete e.oneWay;
      again = true;
      for (const l of layers) {
        const o = l.dim.objects.find((x) => x.id === 'g.' + e.id);
        if (!o) continue;
        if (o.gate === 'waterfall') { o.style = 'ladder'; o.label = 'Waterfall with a climbing vine'; }
        else { o.kind = 'gate'; o.gate = 'stairs'; o.label = 'Ledge with a rope ladder'; }
      }
      for (const w of bp.tree.children) for (const h of w.edges) if (h.oneWay && h.a === e.a && h.b === e.b) delete h.oneWay;
    }
  }
}

const FILLER_BIOME: Record<number, string> = { [FILL.OCEAN]: 'ocean', [FILL.RANGE]: 'range', [FILL.THICKET]: 'thicket', [FILL.WASTES]: 'wastes' };
const FILLER_COLOR: Record<number, string> = { [FILL.OCEAN]: '#3f7fd0', [FILL.RANGE]: '#9a8f86', [FILL.THICKET]: '#2f6f42', [FILL.WASTES]: '#c9a965' };

/**
 * Filler regions get names on the map, and a sea with a dock becomes a zone. A dock joins its
 * region to the sea for anyone with the Boat (or the fare, where a ferryman works). The piers
 * that lead to islands were planned with the graph; every other dock, and every sandbar and cay,
 * is an extra route read off the finished map, as rivers are.
 */
function addSeas(bp: Blueprint, st: ST): Set<string> {
  const made = new Set<string>();
  const fill = st.bp.fill;
  if (!fill) return made;
  const { dim, w } = st, S = bp.ctx.settings;
  const world = bp.tree.children.find((c) => c.id === dim.id)!;
  const boat = bp.plan.tools.includes('boat');
  const seaLoc = new Map<number, LocId>();
  const seaZone = new Map<number, number>();
  const seaWithDock = new Set(st.docks.map((d) => d.filler));
  const gw = st.bp.part.gw;

  fill.list.forEach((f, fi) => {
    const name = fill.names?.[fi] ?? 'The Sea';
    // label where the filler is thickest: the screen with the most filler around it
    let best = f.screens[0], bestN = -1;
    for (const s of f.screens) {
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = (s % gw) + dx, t = s + dy * gw + dx;
        if (x >= 0 && x < gw && fill.of[t] === fi) n++;
      }
      if (n > bestN) { bestN = n; best = s; }
    }
    const x = (best % gw) * 12 + 6, y = ((best / gw) | 0) * 10 + 5;
    const id = `${dim.id}.fill${fi}`;
    dim.regions.push({ id, name, biome: FILLER_BIOME[f.kind], elev: 0, x, y, color: FILLER_COLOR[f.kind] });
    const planned = bp.graph.locs.find((l) => l.id === id);
    if (planned) Object.assign(planned, { x, y });
    else {
      if (f.kind !== FILL.OCEAN || !seaWithDock.has(fi)) return;
      // a sea someone can sail: a zone of its own
      const node = hnode(id, 'region', name, 0, { biome: 'ocean', elev: 0, dim: dim.id });
      node.locs.push(bp.ctx.loc(id, name, id, dim.id));
      node.needs = boat ? has('boat') : use('rupees', S.ferryFare);
      world.children.push(node);
      bp.graph.locs.push({ id, name, hnode: id, dim: dim.id, x, y });
    }
    seaLoc.set(fi, id);
    seaZone.set(fi, dim.zoneLoc.push(id) - 1);
  });
  if (!seaLoc.size) return made;
  for (let i = 0; i < st.fillAt.length; i++) {
    const z = seaZone.get(st.fillAt[i]);
    if (z !== undefined && dim.solid[i]) dim.zone[i] = z;
  }

  const fare = use('rupees', S.ferryFare);
  st.docks.forEach((d, n) => {
    const sea = seaLoc.get(d.filler)!, region = st.bp.regions[d.region];
    let e = d.edgeId ? bp.ctx.edges.find((x) => x.id === d.edgeId) : undefined;
    if (!e) {
      const req = d.ferry ? (boat ? any(has('boat'), fare) : fare) : has('boat');
      e = bp.ctx.edge(region.id, sea, req, 'dock');
      world.edges.push({ a: region.id, b: sea, req, gate: 'dock' });
    }
    made.add(e.id);
    const label = d.ferry ? `Ferry dock (${S.ferryFare} rupees${boat ? ', or your own Boat' : ''})` : 'Dock';
    dim.objects.push({ id: 'k.' + e.id, kind: 'entrance', style: 'dock', x: d.end % w, y: (d.end / w) | 0, label, edgeId: e.id, req: e.req, dir: d.dir });
    if (!d.ferry) return;
    const who = `${FERRY_NAMES[n % FERRY_NAMES.length]} the Ferryman`;
    const id = `ferry${n}`;
    bp.ctx.npcs.push({
      id, name: who, role: 'Ferry', icon: '⚓', color: '#8fd0ff',
      stages: [{ when: NONE, loc: region.id, dim: dim.id, x: d.first % w, y: (d.first / w) | 0, line: `Any dock with a ferry, ${S.ferryFare} rupees a crossing.${boat ? ' Got your own boat? Then you do not need me.' : ''}`, offers: [] }],
    });
    dim.objects.push({ id: `o.${id}.0`, kind: 'npc', x: d.first % w, y: (d.first / w) | 0, label: `${who} (Ferry)`, npcId: id, stage: 0, icon: '⚓' });
  });

  for (const it of st.outcrops) {
    const sea = seaLoc.get(it.filler);
    if (!sea) continue;
    const seaName = bp.ctx.locs.get(sea)!.name;
    const what = it.holds === 'chest' ? 'Cay' : 'Sandbar';
    const name = `${what} in ${seaName}`;
    const x = it.tile % w, y = (it.tile / w) | 0;
    const node = hnode(it.loc, 'place', what, 0, { placeKind: 'outcrop', dim: dim.id });
    node.locs.push(bp.ctx.loc(it.loc, name, it.loc, dim.id));
    world.children.find((c) => c.id === sea)!.children.push(node);
    bp.graph.locs.push({ id: it.loc, name, hnode: it.loc, dim: dim.id, x, y });
    made.add(bp.ctx.edge(sea, it.loc, NONE, 'shore').id);
    if (it.holds === 'chest') {
      node.provides = ['heart'];
      const c = bp.ctx.check(it.loc, 'heart', 'chest', `Cay chest, ${seaName}`);
      dim.objects.push({ id: 'o.' + c.id, kind: 'chest', x, y, label: c.label, checkId: c.id });
    } else if (it.holds === 'pots') {
      const s = bp.ctx.source(it.loc, 'rupees', 'Washed-up pots (rupees)');
      dim.objects.push({ id: 'o.' + s.id, kind: 'source', x, y, label: s.label, sourceId: s.id, style: 'pot', icon: '◆' });
    }
  }
  return made;
}
