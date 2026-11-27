// The generator's tidy-up, driven by the tile table (core/tileset.ts): wherever a prop's need is
// not met it becomes what the table names, or goes. It asks exactly the questions the checker
// asks, so what is settled here cannot be reported there, and nothing here knows about trees or
// cliffs. (That raised ground always keeps a top is not settled here: the terrain model itself
// fits faces to the room they have, see core/shape.ts.)
import { D, T, type Dimension } from '../core/types';
import { NEEDS, PROPS, tileCtx } from '../core/tileset';
import { cornerAt, isWallG, liftAt, shortFace, thinAt, thinPairs, wallStyle } from '../core/shape';

/**
 * Would closing walkable tile c leave everything around it as connected as before? True when the
 * walkable tiles beside it stay joined to each other through the ring of eight around it, so no
 * path anywhere can have depended on c. (Steps of height are not walked without stairs, and
 * tiles with stairs are never offered here, so only equal heights count as joined.)
 */
function spare(dim: Dimension, c: number, keep: (i: number) => boolean): boolean {
  const { w, h } = dim, x = c % w, y = (c / w) | 0;
  const ring: number[] = []; // clockwise from north; -1 = not walkable
  for (const [dx, dy] of [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]) {
    const xx = x + dx, yy = y + dy, j = yy * w + xx;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false; // the map's edge: leave it alone
    ring.push(dim.solid[j] ? -1 : j);
  }
  const sides = [0, 2, 4, 6].filter((k) => ring[k] >= 0);
  if (sides.length <= 1) return true;
  // walk the ring from the first walkable side; every other walkable side must be reached
  const seen = new Set<number>([sides[0]]);
  const todo = [sides[0]];
  while (todo.length) {
    const k = todo.pop()!;
    for (const m of [(k + 1) % 8, (k + 7) % 8]) {
      if (ring[m] < 0 || seen.has(m) || dim.elev[ring[m]] !== dim.elev[ring[k]]) continue;
      seen.add(m); todo.push(m);
    }
  }
  return sides.every((k) => seen.has(k));
}

/**
 * Open water lies on the level of the land it meets, never a step below it: every sea tile takes
 * the level of the nearest region's ground. A shore is then a bank, not a wall. (Mountain ranges
 * that are only scenery do not count: they do rise out of the sea.)
 */
function seaLevel(dim: Dimension): void {
  if (dim.kind !== 'overworld') return;
  const { w, h } = dim, n = w * h;
  const sea = (i: number) => dim.region[i] < 0 && (dim.ground[i] === T.DEEP || dim.ground[i] === T.WATER);
  const level = new Int16Array(n).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sea(i) || dim.ground[i] === T.VOID || dim.ground[i] === T.LAVA) continue;
    const r = dim.region[i];
    if (r >= 0) level[i] = dim.regions[r]?.elev ?? dim.elev[i];
    else if (dim.elev[i] <= 1) level[i] = dim.elev[i];
    if (level[i] >= 0) front.push(i);
  }
  while (front.length) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || level[j] >= 0 || !sea(j)) continue;
        level[j] = level[i];
        dim.elev[j] = level[i];
        next.push(j);
      }
    }
    front = next;
  }
  void h;
}

/** Make tile c part of the raised ground of tile i. */
function raise(dim: Dimension, c: number, i: number): void {
  dim.ground[c] = dim.ground[i]; dim.elev[c] = dim.elev[i]; dim.solid[c] = 1; dim.deco[c] = D.NONE; dim.zone[c] = -1;
  if (dim.lip) dim.lip[c] = dim.lip[i];
}

/**
 * The shape of raised ground, before anything is checked:
 *  - raised ground is never one tile wide: where it is, the lower ground on one side of it is
 *    raised to match, if that changes nothing about where one can walk;
 *  - caves get inner corners at 45 degrees (a floor corner becomes cave wall, cut diagonally);
 *  - every outward corner of raised ground is cut at 45 degrees, so a raised place ends up
 *    eight-sided and a staircase of tiles becomes one diagonal wall. Built walls indoors
 *    (dungeons, houses) stay square.
 * `keep` names tiles that must stay as they are (gates, anchors of the logic, anything with an object).
 */
export function settleShape(dim: Dimension, keepTile: (i: number) => boolean = () => false): void {
  const { w, h } = dim, n = w * h;
  const held = new Set(dim.objects.map((o) => o.y * w + o.x));
  const keep = (i: number) => held.has(i) || keepTile(i) || dim.deco[i] === D.HOUSE;
  const liquid = (j: number) => dim.ground[j] === T.WATER || dim.ground[j] === T.DEEP || dim.ground[j] === T.LAVA;
  seaLevel(dim);
  const lowered = new Set<number>(); // what came down is not raised again, so this always settles
  const widen = (): void => {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      for (const [pa, pb, missing] of thinPairs(dim, i)) {
        const pair = [pa, pb];
        // one tile short: it grows by one; shorter than that it is no place at all and comes down
        const c = missing > 1 && !keep(i) ? undefined : pair.find((j) => !keep(j) && !lowered.has(j) && !liquid(j) && (dim.solid[j] ? true : spare(dim, j, keep)));
        if (c !== undefined) {
          // widen it, unless the new tile would itself stand alone
          const was = [dim.ground[c], dim.elev[c], dim.solid[c], dim.deco[c], dim.zone[c], dim.lip ? dim.lip[c] : 0];
          raise(dim, c, i);
          if (keep(i) || !thinAt(dim, i)) { changed = true; continue; }
          dim.ground[c] = was[0]; dim.elev[c] = was[1]; dim.solid[c] = was[2]; dim.deco[c] = was[3]; dim.zone[c] = was[4];
          if (dim.lip) dim.lip[c] = was[5];
        }
        // no room to widen it: it comes down to the ground beside it and stays closed (a boulder
        // stands on it), so nothing about where one can walk changes
        if (!thinAt(dim, i) || keep(i)) continue;
        lowered.add(i);
        const d = pair.filter((j) => !liquid(j)).sort((a, b) => liftAt(dim, b) - liftAt(dim, a))[0];
        if (d === undefined) {
          // a sliver with water or lava on both sides: it comes down to the water's level, a bank on each side
          const q = liftAt(dim, pair[0]) >= liftAt(dim, pair[1]) ? pair[0] : pair[1];
          dim.elev[i] = dim.elev[q];
          if (isWallG(dim.ground[i])) dim.ground[i] = dim.kind === 'overworld' ? T.STONE : T.CAVE;
          if (dim.lip) dim.lip[i] = 0;
          changed = true;
          continue;
        }
        if (isWallG(dim.ground[d]) || dim.solid[d]) {
          // the ground beside it is closed too (a lower wall, a lower ledge): it joins that, as it is
          if (!isWallG(dim.ground[d])) dim.ground[i] = dim.ground[d];
          dim.elev[i] = dim.elev[d];
          if (dim.lip) dim.lip[i] = dim.lip[d];
          changed = true;
          continue;
        }
        dim.ground[i] = dim.ground[d];
        dim.elev[i] = dim.elev[d];
        if (dim.lip) dim.lip[i] = 0;
        if (dim.kind !== 'sky') dim.deco[i] = D.ROCK;
        changed = true;
      }
    }
    if (!changed) break;
  }
  };
  // every face gets the depth of closed ground it needs behind its edge (two tiles for a face
  // that looks south and for every face indoors, one otherwise): the walkable tile behind it is
  // closed, or failing that the wall moves a tile outward
  const DIRS4: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const deepen = (): boolean => {
    let any = false;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!dim.solid[i] || dim.ground[i] === T.VOID) continue;
      for (const [dx, dy] of DIRS4) {
        const b = shortFace(dim, i, dx, dy);
        if (b < 0) continue;
        if (!keep(b) && spare(dim, b, keep)) { raise(dim, b, i); changed = true; continue; }
        const f = i + dx + dy * w;
        if (!(keep(f) || liquid(f) || lowered.has(f) || !(dim.solid[f] || spare(dim, f, keep)))) { raise(dim, f, i); changed = true; continue; }
        // neither: the edge itself comes down to the ground in front of it and stays closed, so
        // the step is a plain upright drop at the walkable tile behind
        if (keep(i)) continue; // (coming down again is fine: each time it ends lower, so this stops)
        if (!liquid(f)) dim.ground[i] = dim.ground[f];
        else if (isWallG(dim.ground[i])) dim.ground[i] = dim.kind === 'overworld' ? T.STONE : T.CAVE;
        dim.elev[i] = dim.elev[f];
        if (dim.lip) dim.lip[i] = 0;
        if (dim.kind !== 'sky' && !liquid(f)) dim.deco[i] = D.ROCK;
        lowered.add(i);
        changed = true;
        break;
      }
    }
    if (!changed) break;
    any = true;
  }
    return any;
  };
  for (let round = 0; round < 10; round++) { widen(); if (!deepen()) break; }
  // (settling again keeps the cuts there are, where they still are corners)
  const was = dim.cut;
  const cut = (dim.cut = new Uint8Array(n));
  if (was) for (let i = 0; i < n; i++) if (was[i]) { dim.cut[i] = 0; if (cornerAt(dim, i)) cut[i] = 1; }
  if (dim.kind === 'interior' || dim.kind === 'underworld') {
    const fills: [number, number][] = [];
    // a floor tile in the corner of a room: wall on two sides that meet, floor on the other two
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (dim.solid[i] || dim.deco[i] || dim.zone[i] < 0 || keep(i)) continue;
      for (const [sx, sy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
        const a = i + sx, b = i + sy * w, c = i + sx + sy * w, oa = i - sx, ob = i - sy * w, oc = i - sx - sy * w;
        if (!isWallG(dim.ground[a]) || dim.ground[a] !== dim.ground[b] || dim.ground[a] !== dim.ground[c] || wallStyle(dim.kind, dim.ground[a]).corners !== 'cut') continue;
        if (dim.solid[oa] || dim.solid[ob] || dim.solid[oc] || dim.elev[oa] !== dim.elev[i] || dim.elev[ob] !== dim.elev[i] || dim.elev[oc] !== dim.elev[i]) continue;
        fills.push([i, a]);
        break;
      }
    }
    // found on the map as it was, so one filled corner cannot make the tile beside it a corner too
    const filled = new Set<number>();
    for (const [i, a] of fills) {
      if ([i - 1, i + 1, i - w, i + w].some((j) => filled.has(j)) || !spare(dim, i, keep)) continue;
      const g = dim.ground[i], e = dim.elev[i], z = dim.zone[i];
      raise(dim, i, a);
      if (cornerAt(dim, i) && !thinAt(dim, i)) { cut[i] = 1; filled.add(i); }
      else { dim.ground[i] = g; dim.elev[i] = e; dim.solid[i] = 0; dim.zone[i] = z; }
    }
  }
  for (let i = 0; i < n; i++) {
    // (which walls are cut is the wall table's business: core/shape.ts)
    if (keep(i) || !dim.solid[i] || wallStyle(dim.kind, dim.ground[i]).corners !== 'cut') continue;
    if (cornerAt(dim, i) && !thinAt(dim, i)) cut[i] = 1;
  }
}

export function settleTiles(dim: Dimension, keepTile?: (i: number) => boolean): void {
  settleShape(dim, keepTile);
  const c = tileCtx(dim);
  const n = dim.w * dim.h;
  for (let i = 0; i < n; i++) {
    // a replacement has needs of its own, so look again (a few times is plenty: chains are short)
    for (let pass = 0; pass < 3 && dim.deco[i]; pass++) {
      const spec = PROPS[dim.deco[i]];
      if (!spec || dim.deco[i] === D.HOUSE) break; // buildings are placed whole, never tidied away
      const unmet = spec.needs.find((need) => !NEEDS[need].holds(c, i));
      if (!unmet) break;
      dim.deco[i] = spec.instead?.[unmet] ?? D.NONE;
    }
  }
}
