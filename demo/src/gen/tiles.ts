// Blueprint -> tile maps, then PROVE the maps say the same thing as the logic graph:
// flood-fill the walkable tiles into zones and check every edge, gate and object against it.
import type { Dimension, DimId, Edge, LocId, LogicGraph, MapObject } from '../core/types';
import { D } from '../core/types';
import type { Blueprint } from './logic';
import { finishTree } from './logic';
import { NONE, has } from '../core/req';
import { hnode } from './blueprint';
import { oneWaySafe, requiredTable } from './validate';
import { realiseInterior } from './interiorTiles';
import { carveOpenings, initStack, type ST } from './stackBase';
import { placeFeatures } from './stackFeatures';

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
    const st = initStack(s, S.worldW, S.worldH, seed, S.borderWobble, S.scenery, S.riverWidth);
    carveOpenings(st, drop);
    sts.set(s.id, st);
  }
  const doors = placeFeatures(sts, drop);
  const layers: Layer[] = [...sts.values()].map((st) => ({ dim: st.dim, barriers: st.barriers, anchors: st.anchors }));
  for (const st of sts.values()) problems.push(...st.problems);

  // interiors, linked both ways to the door that leads to them
  for (const ib of bp.ctx.interiors) {
    const it = realiseInterior(ib, seed);
    const door = doors.get(ib.entranceEdge);
    if (!door) { problems.push(`${ib.name} has no entrance on the map`); continue; }
    door.obj.to = { dim: it.dim.id, x: it.exit.x, y: it.exit.y };
    it.dim.parent = { dim: door.dim, x: door.x, y: door.y };
    it.dim.objects.push({ id: 'x.' + ib.entranceEdge, kind: 'entrance', x: it.exit.x, y: it.exit.y, label: 'Way out', style: 'exit', dir: 's', edgeId: ib.entranceEdge, to: { dim: door.dim, x: door.x, y: door.y } });
    layers.push({ dim: it.dim, barriers: it.barriers, anchors: it.anchors });
  }

  for (const l of layers) zones(l, bp.graph, problems);
  const over = sts.get('over');
  const wet = over ? addRivers(bp, over, problems) : new Set<string>();
  if (wet.size || dropped) {
    settleOneWays(bp, layers);
    finishTree(bp.tree, bp.ctx);
  }
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
    if (count !== all.length) problems.push(`a stretch of ${RIVER_NAMES[segs[k].river % RIVER_NAMES.length]} is broken into separate pools`);
  });

  const swim = bp.plan.tools.includes('flippers');
  const world = bp.tree.children.find((c) => c.id === dim.id)!;
  const kept: (LocId | null)[] = [];
  segs.forEach((sg, k) => {
    const up = k > 0 && segs[k - 1].river === sg.river ? k - 1 : -1;
    const fall = up >= 0 ? falls.get(`${up}>${k}`) : undefined;
    const upLoc = up >= 0 ? kept[up] : null;
    const all = tilesOf[k].filter((i) => !bridge[i]);
    if (!swim || !all.length || !(shores[k].size || (upLoc && fall))) {
      kept.push(null);
      // still a waterfall to look at, even when nobody can swim
      if (fall) dim.objects.push({ id: `wf.${k}`, kind: 'gate', gate: 'waterfall', x: fall.tile % w, y: (fall.tile / w) | 0, label: 'Waterfall', dir: fall.dir });
      return;
    }
    const stretches = segs.filter((o) => o.river === sg.river).length;
    const course = stretches === 1 ? '' : `, ${sg.seg === 0 ? 'upper' : sg.seg === stretches - 1 ? 'lower' : 'middle'} course`;
    const name = RIVER_NAMES[sg.river % RIVER_NAMES.length] + (stretches > 3 && sg.seg > 0 && sg.seg < stretches - 1 ? `${course} ${sg.seg}` : course);
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
