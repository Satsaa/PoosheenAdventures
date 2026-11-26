// Put the blueprint's features onto the stacked tile maps: stairs between worlds, buildings,
// gated alcoves, loose objects; then footpaths and scenery that can never block anything.
import { D, T, type DimId, type MapObject } from '../core/types';
import type { Feature, RegionBP } from './blueprint';
import { STYLES, type ST } from './stackBase';

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

export interface SeaOpts { boat: boolean; ferries: number; islets: number }

export function placeFeatures(sts: Map<DimId, ST>, drop: (edgeId: string) => void, sea: SeaOpts = { boat: false, ferries: 0, islets: 0 }): DoorMap {
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
      for (const f of r.feats.slice().sort((a, b) => ORDER[a.f] - ORDER[b.f])) {
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
            at = findBlock(st, r.idx, P, Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, 1);
            if (at) { shape = s; reserve(st, at.x + Math.min(...xs) - 1, at.y + Math.min(...ys) - 1, at.x + Math.max(...xs) + 1, at.y + 1); break; }
          }
          if (!at) { if (f.f === 'entrance') fail(f.label); continue; }
          const deco = st.bp.kind === 'underworld' ? D.STALAG : st.bp.kind === 'sky' ? D.PILLAR : kind === 'cave' ? D.ROCK : D.HOUSE;
          const tiles = shape.map(([dx, dy]) => (at!.y + dy) * w + at!.x + dx);
          for (const t of tiles) { dim.solid[t] = 1; dim.deco[t] = deco; }
          if (built) {
            (dim.structures ??= []).push({
              id: 'b.' + dim.structures.length, kind, style: rng.pick(LOOKS[kind] ?? LOOKS.house), tiles, door: { x: at.x, y: at.y },
              floors: kind === 'house' ? rng.range(1, 2) : kind === 'shop' ? 1 : 2,
            });
          }
          if (f.f === 'house') continue;
          const obj: MapObject = { id: 'd.' + f.edgeId, kind: 'entrance', x: at.x, y: at.y, label: f.label, style: f.style, req: f.req, edgeId: f.edgeId, dir: 'n' };
          dim.objects.push(obj);
          st.mouths[r.idx].push(at.y * w + at.x);
          doors.set(f.edgeId, { dim: dim.id, x: at.x, y: at.y, obj });
        } else if (f.f === 'dock') {
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
  for (const st of sts.values()) { stampIslets(st, sea.islets); paths(st); scenery(st); }
  return doors;
}

/** Footpaths from each region's centre to its openings and doors (overworld only). */
function paths(st: ST): void {
  if (st.bp.kind !== 'overworld') return;
  const { w, dim } = st;
  for (const r of st.bp.regions) {
    const start = [...st.anchors].find(([, loc]) => loc === r.id)?.[0];
    if (start === undefined) continue;
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
function buildDock(st: ST, r: number, filler: number, ferry: boolean): boolean {
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
      st.docks.push({ region: r, filler, end: pier[1], first: rim[0], dir, ferry });
      st.mouths[r].push(g);
      return true;
    }
  }
  return false;
}

/** Small islands out on every sea that has a dock: sand, a palm, and a tile for a chest. */
function stampIslets(st: ST, count: number): void {
  const { w, h, dim, rng } = st;
  const seas = [...new Set(st.docks.map((d) => d.filler))];
  if (!seas.length || count <= 0) return;
  const tilesOf = new Map<number, number[]>(seas.map((f) => [f, []]));
  for (let i = 0; i < st.fillAt.length; i++) tilesOf.get(st.fillAt[i])?.push(i);
  for (const f of seas) {
    const tiles = tilesOf.get(f)!;
    for (let k = 0, tries = 0; k < count && tries < count * 40 && tiles.length; tries++) {
      const c = tiles[rng.int(tiles.length)], cx = c % w, cy = (c / w) | 0;
      if (cx < 4 || cy < 4 || cx >= w - 4 || cy >= h - 4) continue;
      // open water for three tiles all around, so an islet never touches a coast, a pier or another islet
      let clear = true;
      for (let y = cy - 3; y <= cy + 3 && clear; y++) for (let x = cx - 3; x <= cx + 3; x++) {
        const i = y * w + x;
        if (st.fillAt[i] !== f || !dim.solid[i] || st.reserved[i]) { clear = false; break; }
      }
      if (!clear) continue;
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        const i = y * w + x;
        dim.ground[i] = T.SAND; dim.solid[i] = 0; dim.elev[i] = 0;
      }
      for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) st.reserved[y * w + x] = 1;
      const palm = (cy - 1) * w + cx + 1;
      dim.solid[palm] = 1; dim.deco[palm] = D.PALM;
      const loc = `${dim.id}.islet${st.islets.length}`;
      st.anchors.set(c, loc);
      st.islets.push({ filler: f, tile: c, loc });
      k++;
    }
  }
}
