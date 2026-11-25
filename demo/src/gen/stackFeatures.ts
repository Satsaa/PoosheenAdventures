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

const ORDER: Record<Feature['f'], number> = { vertical: 0, entrance: 1, pocket: 2, spot: 3 };

export function placeFeatures(sts: Map<DimId, ST>): DoorMap {
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
    const { w, dim } = st;
    for (const r of st.bp.regions) {
      const P = ptsOf(r);
      const fail = (what: string) => st.problems.push(`no room for ${what} in ${r.name}`);
      for (const f of r.feats.slice().sort((a, b) => ORDER[a.f] - ORDER[b.f])) {
        if (f.f === 'vertical') {
          const st2 = sts.get(f.other.stack.id)!;
          const at = findBlock(st, r.idx, P, -1, -1, 1, 1, (x, y) => freeBlock(st2, f.other.idx, x - 1, y - 1, x + 1, y + 1));
          if (!at) { fail(f.label); continue; }
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
        } else if (f.f === 'entrance') {
          const at = findBlock(st, r.idx, P, -2, -3, 2, 1);
          if (!at) { fail(f.label); continue; }
          reserve(st, at.x - 2, at.y - 3, at.x + 2, at.y + 1);
          // a red-roofed house would look odd in a cave or on a cloud: use the local building material there
          const deco = st.bp.kind === 'underworld' ? D.STALAG : st.bp.kind === 'sky' ? D.PILLAR : f.style === 'cave' ? D.ROCK : D.HOUSE;
          for (let y = at.y - 2; y <= at.y - 1; y++) for (let x = at.x - 1; x <= at.x + 1; x++) {
            dim.solid[y * w + x] = 1;
            dim.deco[y * w + x] = deco;
          }
          const obj: MapObject = { id: 'd.' + f.edgeId, kind: 'entrance', x: at.x, y: at.y, label: f.label, style: f.style, req: f.req, edgeId: f.edgeId };
          dim.objects.push(obj);
          st.mouths[r.idx].push(at.y * w + at.x);
          doors.set(f.edgeId, { dim: dim.id, x: at.x, y: at.y, obj });
        } else if (f.f === 'pocket') {
          const at = findBlock(st, r.idx, P, -2, -2, 2, 2);
          if (!at) { fail(f.label); continue; }
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
        } else {
          const at = findBlock(st, r.idx, P, -1, -1, 1, 1) ?? findBlock(st, r.idx, P, 0, 0, 0, 0);
          if (!at) { fail(f.obj.label); continue; }
          reserve(st, at.x - 1, at.y - 1, at.x + 1, at.y + 1);
          dim.objects.push({ ...f.obj, x: at.x, y: at.y } as MapObject);
        }
      }
    }
  }
  for (const st of sts.values()) { paths(st); scenery(st); }
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
      if (roll < style.density) {
        let open = true;
        for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) if (dim.solid[j] || st.barriers.has(j)) open = false;
        if (!open) continue;
        dim.solid[i] = 1;
        if (style.pond !== undefined && rng.chance(0.6)) dim.ground[i] = style.pond;
        else if (style.solid.length) dim.deco[i] = rng.pick(style.solid);
      } else if (roll < style.density + 0.07 && style.soft.length && dim.ground[i] === style.ground) {
        dim.deco[i] = rng.pick(style.soft);
      }
    }
  }
}
