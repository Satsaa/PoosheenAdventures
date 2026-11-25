// Blueprint -> tile maps, then PROVE the maps say the same thing as the logic graph:
// flood-fill the walkable tiles into zones and check every edge, gate and object against it.
import type { Dimension, DimId, LocId, LogicGraph, MapObject } from '../core/types';
import { D } from '../core/types';
import type { Blueprint } from './logic';
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
  const sts = new Map<DimId, ST>();
  for (const s of bp.ctx.stacks) {
    const S = bp.ctx.settings;
    const st = initStack(s, S.worldW, S.worldH, seed, S.borderWobble, S.scenery);
    carveOpenings(st);
    sts.set(s.id, st);
  }
  const doors = placeFeatures(sts);
  const layers: Layer[] = [...sts.values()].map((st) => ({ dim: st.dim, barriers: st.barriers, anchors: st.anchors }));
  for (const st of sts.values()) problems.push(...st.problems);

  // interiors, linked both ways to the door that leads to them
  for (const ib of bp.ctx.interiors) {
    const it = realiseInterior(ib, seed);
    const door = doors.get(ib.entranceEdge);
    if (!door) { problems.push(`${ib.name} has no entrance on the map`); continue; }
    door.obj.to = { dim: it.dim.id, x: it.exit.x, y: it.exit.y };
    it.dim.parent = { dim: door.dim, x: door.x, y: door.y };
    it.dim.objects.push({ id: 'x.' + ib.entranceEdge, kind: 'entrance', x: it.exit.x, y: it.exit.y, label: 'Way out', style: 'exit', edgeId: ib.entranceEdge, to: { dim: door.dim, x: door.x, y: door.y } });
    layers.push({ dim: it.dim, barriers: it.barriers, anchors: it.anchors });
  }

  for (const l of layers) zones(l, bp.graph, problems);
  verify(layers, bp.graph, problems);

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

function verify(layers: Layer[], g: LogicGraph, problems: string[]): void {
  const edge = new Map(g.edges.map((e) => [e.id, e]));
  const check = new Map(g.checks.map((c) => [c.id, c]));
  const source = new Map(g.sources.map((s) => [s.id, s]));
  const realised = new Set<string>();
  for (const { dim, barriers } of layers) {
    const { w } = dim;
    const locOf = (i: number) => (barriers.has(i) || dim.zone[i] < 0 ? undefined : dim.zoneLoc[dim.zone[i]]);
    // every gate tile has exactly the two zones of its edge on either side
    for (const [i, id] of barriers) {
      const e = edge.get(id);
      const sides = new Set([i - 1, i + 1, i - w, i + w].map(locOf).filter(Boolean));
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
