// Put the blueprint's features onto the stacked tile maps: stairs between worlds, buildings,
// gated alcoves, loose objects; then footpaths and scenery that can never block anything.
import { D, T, type DimId, type MapObject } from '../core/types';
import type { Feature, RegionBP } from './blueprint';
import { STYLES, type ST } from './stackBase';
import { FILL } from './spatial';

export type DoorMap = Map<string, { dim: DimId; x: number; y: number; obj: MapObject }>;

function freeBlock(st: ST, r: number, x0: number, y0: number, x1: number, y1: number): boolean {
  if (x0 < 1 || y0 < 1 || x1 >= st.w - 1 || y1 >= st.h - 1) return false;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * st.w + x;
    if (st.owner[i] !== r || st.border[i] || st.reserved[i] || st.dim.solid[i]) return false;
  }
  return true;
}

function reserve(st: ST, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) st.reserved[y * st.w + x] = 1;
}

/** A spot in region r where the block fits, preferring spots far from what is already placed. */
function findBlock(
  st: ST, r: number, pts: { x: number; y: number }[], dx0: number, dy0: number, dx1: number, dy1: number,
  extra?: (x: number, y: number) => boolean,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null, bestD = -1, found = 0;
  for (const i of st.interior[r]) {
    const x = i % st.w, y = (i / st.w) | 0;
    if (!freeBlock(st, r, x + dx0, y + dy0, x + dx1, y + dy1) || (extra && !extra(x, y))) continue;
    let d = 1e9;
    for (const p of pts) d = Math.min(d, Math.abs(p.x - x) + Math.abs(p.y - y));
    if (d > bestD) { bestD = d; best = { x, y }; }
    if (++found >= 14) break;
  }
  if (best) pts.push(best);
  return best;
}

const ORDER: Record<Feature['f'], number> = { vertical: 0, entrance: 1, dock: 1.2, house: 1.5, pocket: 2, spot: 3 };

type Shape = [number, number][];
const rect = (x0: number, x1: number, y0: number, y1: number): Shape => {
  const out: Shape = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
};
/** Footprints as offsets from the tile in front of the door. Every one covers (0, -1), where the door is. */
const HOUSES: Shape[] = [
  rect(-1, 1, -2, -1), rect(0, 1, -2, -1), rect(-1, 2, -2, -1), rect(-1, 1, -3, -1),
  [...rect(-1, 2, -2, -1), ...rect(-1, 0, -3, -3)], // L
  [...rect(-2, 1, -2, -1), ...rect(0, 1, -3, -3)], // L, mirrored
  [...rect(-2, 2, -3, -2), ...rect(-1, 1, -1, -1)], // T
];
const HALLS: Record<string, Shape[]> = {
  dungeon: [rect(-2, 2, -3, -1), [...rect(-2, 2, -2, -1), ...rect(-1, 1, -3, -3)]],
  sanctum: [[...rect(-2, 2, -3, -1), ...rect(-1, 1, -4, -4)]],
  shop: [rect(-1, 2, -2, -1), rect(-1, 1, -2, -1)],
};
const LOOKS: Record<string, string[]> = {
  house: ['timber-red', 'timber-blue', 'thatch', 'timber-green'], shop: ['timber-gold'], dungeon: ['stone-moss', 'stone-dark'], sanctum: ['marble'],
};

export interface SeaOpts { boat: boolean; ferries: number; outcrops: number }

export function placeFeatures(sts: Map<DimId, ST>, drop: (edgeId: string) => void, sea: SeaOpts = { boat: false, ferries: 0, outcrops: 0 }): DoorMap {
  const doors: DoorMap = new Map();
  const pts = new Map<RegionBP, { x: number; y: number }[]>();
  const ptsOf = (r: RegionBP) => pts.get(r) ?? pts.set(r, []).get(r)!;

  // region anchors first: they name the zone and give the camera something to look at
  for (const st of sts.values()) {
    for (const r of st.bp.regions) {
      const cx = st.interior[r.idx].reduce((a, i) => a + (i % st.w), 0) / Math.max(1, st.interior[r.idx].length);
      const cy = st.interior[r.idx].reduce((a, i) => a + ((i / st.w) | 0), 0) / Math.max(1, st.interior[r.idx].length);
      let best = -1, bestD = 1e9;
      for (const i of st.interior[r.idx]) {
        const d = Math.abs((i % st.w) - cx) + Math.abs(((i / st.w) | 0) - cy);
        if (d < bestD && !st.reserved[i]) { bestD = d; best = i; }
      }
      if (best < 0) { st.problems.push(`${r.name} has no walkable tile`); continue; }
      st.anchors.set(best, r.id);
      st.reserved[best] = 1;
      st.dim.regions[r.idx] = { id: r.id, name: r.name, biome: r.biome, elev: r.elev, x: best % st.w, y: (best / st.w) | 0, color: r.color };
    }
  }

  for (const st of sts.values()) {
    const { w, dim, rng } = st;
    for (const r of st.bp.regions) {
      const P = ptsOf(r);
      const fail = (what: string) => st.problems.push(`no room for ${what} in ${r.name}`);
      // a pier that carries the way to an island goes first: it has the fewest places it can be
      const rank = (f: Feature) => (f.f === 'dock' && f.edgeId ? 0.5 : ORDER[f.f]);
      for (const f of r.feats.slice().sort((a, b) => rank(a) - rank(b))) {
        if (f.f === 'vertical') {
          const st2 = sts.get(f.other.stack.id)!;
          const at = findBlock(st, r.idx, P, -1, -1, 1, 1, (x, y) => freeBlock(st2, f.other.idx, x - 1, y - 1, x + 1, y + 1));
          if (!at) { if (f.optional) drop(f.edgeId); else fail(f.label); continue; }
          reserve(st, at.x - 1, at.y - 1, at.x + 1, at.y + 1);
          reserve(st2, at.x - 1, at.y - 1, at.x + 1, at.y + 1);
          ptsOf(f.other).push(at);
          const here: MapObject = { id: 'v.' + f.edgeId, kind: 'entrance', x: at.x, y: at.y, label: f.label, style: f.style, req: f.req, edgeId: f.edgeId, to: { dim: st2.dim.id, x: at.x, y: at.y } };
          const there: MapObject = { id: 'w.' + f.edgeId, kind: 'entrance', x: at.x, y: at.y, label: `Back to ${r.name}`, style: st2.bp.stack < st.bp.stack ? 'stairs-up' : 'stairs-down', edgeId: f.edgeId, to: { dim: dim.id, x: at.x, y: at.y } };
          dim.objects.push(here);
          st2.dim.objects.push(there);
          st.mouths[r.idx].push(at.y * w + at.x);
          st2.mouths[f.other.idx].push(at.y * w + at.x);
          doors.set(f.edgeId, { dim: dim.id, x: at.x, y: at.y, obj: here });
        } else if (f.f === 'entrance' || f.f === 'house') {
          const kind = f.f === 'house' ? 'house' : f.style;
          // buildings are made of tiles and come in different shapes; caves, the underworld and the
          // sky use the local material instead (rock, stalagmites, pillars)
          const built = st.bp.kind === 'overworld' && kind !== 'cave';
          const plain = HOUSES[0];
          let shape = built ? rng.pick(HALLS[kind] ?? HOUSES) : plain;
          let at: { x: number; y: number } | null = null;
          for (const s of [shape, plain]) {
            const xs = s.map((o) => o[0]), ys = s.map((o) => o[1]);
            const x0 = Math.min(...xs) - 1, y0 = Math.min(...ys) - 1, x1 = Math.max(...xs) + 1;
            // a town is laid out: houses stand in rows along streets, on the lot nearest the square that is still free
            if (r.biome === 'town' && kind === 'house') at = lots(st, r).find((l) => freeBlock(st, r.idx, l.x + x0, l.y + y0, l.x + x1, l.y + 1)) ?? null;
            if (at) P.push(at);
            at ??= findBlock(st, r.idx, P, x0, y0, x1, 1);
            if (at) { shape = s; reserve(st, at.x + x0, at.y + y0, at.x + x1, at.y + 1); break; }
          }
          if (!at) {
            if (f.f !== 'entrance') continue;
            // no open ground for a free-standing mouth: a cave can just as well open in the region's own rim
            const m = built ? null : rimMouth(st, r.idx);
            if (!m) { fail(f.label); continue; }
            const obj: MapObject = { id: 'd.' + f.edgeId, kind: 'entrance', x: m.x, y: m.y, label: f.label, style: f.style, req: f.req, edgeId: f.edgeId, dir: m.dir };
            dim.objects.push(obj);
            st.mouths[r.idx].push(m.y * w + m.x);
            doors.set(f.edgeId, { dim: dim.id, x: m.x, y: m.y, obj });
            P.push(m);
            continue;
          }
          const deco = st.bp.kind === 'underworld' ? D.STALAG : st.bp.kind === 'sky' ? D.PILLAR : kind === 'cave' ? D.ROCK : D.HOUSE;
          const tiles = shape.map(([dx, dy]) => (at!.y + dy) * w + at!.x + dx);
          for (const t of tiles) { dim.solid[t] = 1; dim.deco[t] = deco; }
          if (built) {
            (dim.structures ??= []).push({
              id: 'b.' + dim.structures.length, kind, style: rng.pick(LOOKS[kind] ?? LOOKS.house), tiles, door: { x: at.x, y: at.y },
              floors: kind === 'house' ? rng.range(1, 2) : kind === 'shop' ? 1 : 2,
            });
          }
          if (r.biome === 'town') st.mouths[r.idx].push(at.y * w + at.x); // every door is on a street
          if (f.f === 'house') continue;
          const obj: MapObject = { id: 'd.' + f.edgeId, kind: 'entrance', x: at.x, y: at.y, label: f.label, style: f.style, req: f.req, edgeId: f.edgeId, dir: 'n' };
          dim.objects.push(obj);
          st.mouths[r.idx].push(at.y * w + at.x);
          doors.set(f.edgeId, { dim: dim.id, x: at.x, y: at.y, obj });
        } else if (f.f === 'dock') {
          if (f.edgeId) {
            if (!buildDock(st, r.idx, f.filler, !!f.ferry, f.edgeId)) fail('a dock');
            continue;
          }
          // a dock nobody could use is not built: it needs the Boat in the world, or a ferryman
          const ferry = rng.chance(sea.ferries);
          if (sea.boat || ferry) buildDock(st, r.idx, f.filler, ferry);
        } else if (f.f === 'pocket') {
          const at = findBlock(st, r.idx, P, -2, -2, 2, 2);
          if (!at) {
            // no open ground left for a free-standing alcove: cut one into the region's own rim
            if (!rimAlcove(st, r.idx, f)) fail(f.label);
            continue;
          }
          reserve(st, at.x - 2, at.y - 2, at.x + 2, at.y + 2);
          const style = STYLES[r.biome];
          const wall = st.bp.kind === 'underworld' ? D.STALAG : st.bp.kind === 'sky' ? D.PILLAR : style.rim[0] ?? D.ROCK;
          for (let y = at.y - 1; y <= at.y + 1; y++) for (let x = at.x - 1; x <= at.x + 1; x++) {
            if ((x === at.x && y === at.y) || (x === at.x && y === at.y + 1)) continue;
            dim.solid[y * w + x] = 1;
            dim.deco[y * w + x] = wall;
          }
          const gate = (at.y + 1) * w + at.x;
          st.barriers.set(gate, f.edgeId);
          st.anchors.set(at.y * w + at.x, f.loc);
          if (f.gate === 'water') dim.ground[gate] = T.WATER;
          dim.objects.push({ id: 'g.' + f.edgeId, kind: 'gate', x: at.x, y: at.y + 1, label: f.label, gate: f.gate, req: f.req, edgeId: f.edgeId, dir: 'n' });
          dim.objects.push({ ...f.obj, x: at.x, y: at.y } as MapObject);
          st.mouths[r.idx].push((at.y + 2) * w + at.x);
        } else if (f.obj.kind === 'enemy') {
          // creatures need one free tile; if the region is full they simply are not there
          const at = findBlock(st, r.idx, [], 0, 0, 0, 0);
          if (!at) continue;
          st.reserved[at.y * w + at.x] = 1;
          dim.objects.push({ ...f.obj, x: at.x, y: at.y } as MapObject);
        } else {
          const at = findBlock(st, r.idx, P, -1, -1, 1, 1) ?? findBlock(st, r.idx, P, 0, 0, 0, 0);
          if (!at) { fail(f.obj.label); continue; }
          reserve(st, at.x - 1, at.y - 1, at.x + 1, at.y + 1);
          dim.objects.push({ ...f.obj, x: at.x, y: at.y } as MapObject);
        }
      }
    }
  }
  for (const st of sts.values()) { stampOutcrops(st, sea.outcrops); paths(st); scenery(st); }
  return doors;
}

/** The lots of a town: door tiles on a lattice around the square, nearest first. The square's own column stays a street. */
const lotCache = new WeakMap<RegionBP, { x: number; y: number }[]>();
function lots(st: ST, r: RegionBP): { x: number; y: number }[] {
  let out = lotCache.get(r);
  if (out) return out;
  out = [];
  const a = [...st.anchors].find(([, loc]) => loc === r.id)?.[0];
  if (a !== undefined) {
    const ax = a % st.w, ay = (a / st.w) | 0;
    for (let j = -6; j <= 6; j++) for (let i = 0; i < 8; i++) for (const side of [-1, 1]) out.push({ x: ax + side * (4 + 6 * i), y: ay + 6 * j });
    out.sort((p, q) => Math.abs(p.x - ax) + 1.3 * Math.abs(p.y - ay) - (Math.abs(q.x - ax) + 1.3 * Math.abs(q.y - ay)));
  }
  lotCache.set(r, out);
  return out;
}

/** Footpaths from each region's centre to its openings and doors (overworld only). */
function paths(st: ST): void {
  if (st.bp.kind !== 'overworld') return;
  const { w, dim } = st;
  for (const r of st.bp.regions) {
    const start = [...st.anchors].find(([, loc]) => loc === r.id)?.[0];
    if (start === undefined) continue;
    if (r.biome === 'town' || r.biome === 'castle') {
      // the square (or the castle yard's paved middle)
      const sx = start % w, sy = (start / w) | 0, base = STYLES[r.biome].ground;
      for (let y = sy - 2; y <= sy + 2; y++) for (let x = sx - 2; x <= sx + 2; x++) {
        const i = y * w + x;
        if (st.owner[i] === r.idx && !dim.solid[i] && !st.border[i] && dim.ground[i] === base) dim.ground[i] = T.PATH;
      }
    }
    const prev = new Map<number, number>([[start, -1]]);
    const q = [start];
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      for (const j of [i - w, i + 1, i + w, i - 1]) {
        if (prev.has(j) || dim.solid[j] || st.owner[j] !== r.idx || st.barriers.has(j)) continue;
        prev.set(j, i);
        q.push(j);
      }
    }
    const base = STYLES[r.biome].ground;
    for (const m of st.mouths[r.idx]) {
      for (let i = prev.has(m) ? m : -1; i >= 0; i = prev.get(i)!) {
        if (dim.ground[i] === base) dim.ground[i] = T.PATH;
        st.reserved[i] = 1;
      }
    }
  }
}

/** Scenery. A solid prop is only placed where all 8 neighbours are open, so it can never cut a zone. */
function scenery(st: ST): void {
  const { w, dim, rng } = st;
  for (const r of st.bp.regions) {
    const style = STYLES[r.biome];
    for (const i of st.interior[r.idx]) {
      if (st.reserved[i] || dim.solid[i]) continue;
      const roll = rng.next();
      const density = style.density * st.scenery;
      if (roll < density) {
        let open = true;
        for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) if (dim.solid[j] || st.barriers.has(j)) open = false;
        if (!open) continue;
        dim.solid[i] = 1;
        if (style.pond !== undefined && rng.chance(0.6)) dim.ground[i] = style.pond;
        else if (style.solid.length) dim.deco[i] = rng.pick(style.solid);
      } else if (roll < density + 0.07 * Math.min(1.5, st.scenery) && style.soft.length && dim.ground[i] === style.ground) {
        dim.deco[i] = rng.pick(style.soft);
      }
    }
  }
}

/**
 * A cave mouth in the rim: open ground with this region's own solid rim straight to the north.
 * Nothing is carved, so nothing can be cut off; the door simply stands in the rock face.
 */
function rimMouth(st: ST, r: number): { x: number; y: number; dir: 'n' | 'e' | 's' | 'w' } | null {
  const { w, dim } = st;
  // a mouth in the north rim is seen face-on, so that is tried first; then the other three sides
  for (const [d, side, dir] of [[-w, 1, 'n'], [1, w, 'e'], [-1, w, 'w'], [w, 1, 's']] as const) {
    for (const g of st.interior[r]) {
      const c = g + d;
      if (st.reserved[g] || dim.solid[g] || st.barriers.has(g)) continue;
      if (st.owner[c] !== r || !st.border[c] || !dim.solid[c] || st.river[c] || st.reserved[c]) continue;
      if ([g - side, g + side, g - d].some((i) => st.barriers.has(i) || st.reserved[i])) continue;
      for (const i of [c, c - side, c + side]) {
        if (st.owner[i] !== r || !st.border[i] || !dim.solid[i] || st.river[i]) continue;
        st.reserved[i] = 1;
        if (dim.deco[i] && st.bp.kind === 'overworld') dim.deco[i] = D.ROCK; // a rock face among the trees
      }
      for (const i of [g, g - side, g + side, g - d]) st.reserved[i] = 1;
      return { x: g % w, y: (g / w) | 0, dir };
    }
  }
  return null;
}

/**
 * An alcove set into the rim: the chest takes a rim tile whose other three sides stay solid,
 * and the gate stands on the open ground in front of it. Used when a region is too full for a
 * free-standing alcove.
 */
function rimAlcove(st: ST, r: number, f: Extract<Feature, { f: 'pocket' }>): boolean {
  const { w, dim } = st;
  const open = (i: number) => !dim.solid[i] && !st.barriers.has(i);
  const wall = (i: number) => dim.solid[i] === 1 && !st.river[i];
  for (const g of st.interior[r]) {
    if (st.reserved[g] || dim.solid[g]) continue;
    for (const [dx, dy] of [[0, -1], [1, 0], [-1, 0], [0, 1]]) {
      const d = dy * w + dx, side = dx !== 0 ? w : 1;
      const c = g + d;
      // the chest tile: this region's rim, walled on its three other sides
      if (st.owner[c] !== r || !st.border[c] || !wall(c) || st.reserved[c]) continue;
      if (!wall(c + d) || !wall(c + side) || !wall(c - side)) continue;
      // the gate tile must sit on a straight edge of open ground, so taking it cuts nothing off
      if (st.reserved[g - d] || ![g - d, g + side, g - side, g - d + side, g - d - side].every(open)) continue;
      dim.solid[c] = 0;
      dim.deco[c] = 0;
      dim.ground[c] = dim.ground[g];
      dim.elev[c] = dim.elev[g];
      st.reserved[c] = st.reserved[g] = 1;
      st.barriers.set(g, f.edgeId);
      st.anchors.set(c, f.loc);
      if (f.gate === 'water') dim.ground[g] = T.WATER;
      const dir = dy < 0 ? 'n' : dy > 0 ? 's' : dx > 0 ? 'e' : 'w';
      dim.objects.push({ id: 'g.' + f.edgeId, kind: 'gate', x: g % w, y: (g / w) | 0, label: f.label, gate: f.gate, req: f.req, edgeId: f.edgeId, dir });
      dim.objects.push({ ...f.obj, x: c % w, y: (c / w) | 0 } as MapObject);
      st.mouths[r].push(g - d);
      return true;
    }
  }
  return false;
}

/** A pier: a plank walk from open ground through the coastal rim and two tiles out over the sea. */
function buildDock(st: ST, r: number, filler: number, ferry: boolean, edgeId?: string): boolean {
  const { w, h, dim } = st;
  const region = st.bp.regions[r];
  if (region.elev > 2) return false; // no jetties off the top of a cliff
  const dirs: [number, number, 'n' | 'e' | 's' | 'w'][] = [[0, -1, 'n'], [1, 0, 'e'], [0, 1, 's'], [-1, 0, 'w']];
  for (const g of st.interior[r]) {
    if (st.reserved[g] || dim.solid[g]) continue;
    const gx = g % w, gy = (g / w) | 0;
    for (const [dx, dy, dir] of dirs) {
      const rim: number[] = [], pier: number[] = [];
      let x = gx + dx, y = gy + dy, ok = true;
      while (ok && rim.length <= 4) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) { ok = false; break; }
        const i = y * w + x;
        if (st.fillAt[i] === filler) break; // reached the sea
        if (st.owner[i] !== r || !st.border[i] || st.river[i] || !dim.solid[i]) { ok = false; break; }
        rim.push(i);
        x += dx; y += dy;
      }
      if (!ok || !rim.length || rim.length > 4) continue;
      // three tiles of this sea straight ahead: two for the pier, one of open water beyond it
      for (let k = 0; k < 3 && ok; k++) {
        const i = (y + dy * k) * w + x + dx * k;
        if (x + dx * k < 1 || y + dy * k < 1 || x + dx * k >= w - 1 || y + dy * k >= h - 1 || st.fillAt[i] !== filler || !dim.solid[i]) ok = false;
        else if (k < 2) pier.push(i);
      }
      if (!ok) continue;
      for (const i of [...rim, ...pier]) {
        dim.solid[i] = 0;
        dim.deco[i] = 0;
        dim.ground[i] = T.PLANK;
        dim.elev[i] = region.elev;
        st.reserved[i] = 1;
      }
      for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) st.reserved[yy * w + xx] = 1;
      st.docks.push({ region: r, filler, end: pier[1], first: rim[0], dir, ferry, edgeId });
      st.mouths[r].push(g);
      return true;
    }
  }
  return false;
}

/**
 * Outcrops: what sticks out of the open sea. Every one is grown tile by tile, so no two have the
 * same outline: reefs of bare rock, sandbars, and cays big enough for a palm and
 * maybe a chest. Only a sea somebody can sail gets ground to stand on; the rest get rocks.
 * `count` is per 50 screens of water.
 */
function stampOutcrops(st: ST, count: number): void {
  const fill = st.bp.fill;
  if (st.bp.kind !== 'overworld' || !fill || count <= 0) return;
  const { w, h, dim, rng } = st;
  const tilesOf = new Map<number, number[]>();
  fill.list.forEach((f, fi) => { if (f.kind === FILL.OCEAN) tilesOf.set(fi, []); });
  for (let i = 0; i < st.fillAt.length; i++) tilesOf.get(st.fillAt[i])?.push(i);
  const sailable = new Set(st.docks.map((d) => d.filler));
  const mine = new Uint8Array(w * h); // tiles of the outcrop being grown
  for (const [f, tiles] of tilesOf) {
    const want = Math.round((count * tiles.length) / (50 * 120));
    for (let k = 0, tries = 0; k < want && tries < want * 30; tries++) {
      const c = tiles[rng.int(tiles.length)];
      const roll = rng.next();
      const kind = !sailable.has(f) || roll < 0.45 ? 'reef' : roll < 0.75 ? 'bar' : 'cay';
      const size = kind === 'reef' ? rng.range(3, 12) : kind === 'bar' ? rng.range(6, 22) : rng.range(12, 40);
      // open water of this sea for two tiles around every tile, so an outcrop never touches a coast, a pier or another outcrop
      const clear = (i: number) => {
        const x = i % w, y = (i / w) | 0;
        if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) return false;
        for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) {
          const j = yy * w + xx;
          if (!mine[j] && (st.fillAt[j] !== f || !dim.solid[j] || st.reserved[j])) return false;
        }
        return true;
      };
      if (!clear(c)) continue;
      const blob = [c];
      mine[c] = 1;
      // long thin bars, rounder cays: a new tile likes to touch more of what is already there
      const round = kind === 'bar' ? 1 : 2.5;
      for (let grow = 0; grow < size * 6 && blob.length < size; grow++) {
        const from = blob[rng.int(blob.length)];
        const t = from + rng.pick([-1, 1, -w, w]);
        if (mine[t] || !clear(t)) continue;
        const touching = [t - 1, t + 1, t - w, t + w].filter((j) => mine[j]).length;
        if (rng.next() < (touching / 2) ** round) { mine[t] = 1; blob.push(t); }
      }
      const min = kind === 'reef' ? 2 : kind === 'bar' ? 4 : 7;
      if (blob.length < min) { for (const i of blob) mine[i] = 0; continue; }
      for (const i of blob) for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) st.reserved[i + yy * w + xx] = 1;
      if (kind === 'reef') {
        // rocks standing in the water, with gaps between them
        for (const i of blob) { if (rng.chance(0.7)) dim.deco[i] = D.ROCK; mine[i] = 0; }
        k++;
        continue;
      }
      for (const i of blob) { dim.ground[i] = T.SAND; dim.solid[i] = 0; dim.elev[i] = 0; }
      // where to stand (and where a chest would be): the tile deepest inside
      const inside = (i: number) => [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1].filter((j) => mine[j]).length;
      const heart = blob.reduce((a, b) => (inside(b) > inside(a) ? b : a));
      // a palm or a rock on tips of the outline only: taking a tip away can never cut the rest in two
      const tips = blob.filter((i) => i !== heart && [i - 1, i + 1, i - w, i + w].filter((j) => mine[j]).length === 1);
      for (const i of rng.shuffle(tips).slice(0, kind === 'cay' ? 2 : 1)) {
        if (!rng.chance(0.7)) continue;
        dim.solid[i] = 1;
        dim.deco[i] = kind === 'cay' && rng.chance(0.7) ? D.PALM : D.ROCK;
      }
      for (const i of blob) mine[i] = 0;
      const loc = `${dim.id}.outcrop${st.outcrops.length}`;
      st.anchors.set(heart, loc);
      st.outcrops.push({ filler: f, tile: heart, loc, holds: kind === 'cay' ? (rng.chance(0.6) ? 'chest' : 'pots') : rng.chance(0.3) ? 'pots' : 'nothing' });
      k++;
    }
  }
}
