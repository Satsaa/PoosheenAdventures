// Per-dimension terrain metadata shared by the renderer and the view: visual elevation (walls raised
// above their floor), cliff face heights, the zone that owns each tile (for fog) and the coastline
// outline used by the stacked-world ghost overlay.
import { T, type Dimension } from '../core/types';
import { WALL_MODE } from '../core/tileset';

export interface DimRender {
  dim: Dimension;
  /** bake px per tile */
  S: number;
  /** bake px per elevation step */
  H: number;
  /** elevation step in tile units (H / S) */
  hT: number;
  /** visual elevation per tile; VOID tiles hold voidElev */
  ve: Float32Array;
  voidElev: number;
  maxVe: number;
  /** bake px above row 0 */
  top: number;
  seed: number;
  /** total bake height in px (the bake itself is painted in chunks, see flatChunks.ts) */
  H_px: number;
  /** zone index owning each tile (solid tiles: majority of walkable neighbours), -1 none */
  owner: Int32Array;
  /** face height (elev units) below each tile */
  faceH: Float32Array;
  /** world-space vertical bounds (tile units) of the bake */
  y0: number;
  y1: number;
}

/** walls render this much taller than their data elev so rooms read as solid blocks */
const WALL_BOOST = 0.6;

export function isWallG(g: number) {
  return g === T.WALL || g === T.CAVEWALL;
}

/** Wooden rails + posts on a bridge plank tile spanning water. */
/** Flat bake resolution: fixed, the bake is chunked so dimension size does not matter. */
function bakeSize(_dim: Dimension): number {
  return 20;
}

export function computeVe(dim: Dimension): { ve: Float32Array; voidElev: number; maxVe: number } {
  const { w, h, ground, elev } = dim;
  const n = w * h;
  const ve = new Float32Array(n);
  const known = new Uint8Array(n);
  const q: number[] = [];
  for (let i = 0; i < n; i++) ve[i] = elev[i];
  // walls must read as raised blocks: at least one step above adjacent floor
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isWallG(ground[i])) continue;
      let m = -999;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          const g = ground[j];
          if (g === T.VOID || isWallG(g)) continue;
          if (elev[j] > m) m = elev[j];
        }
      if (m > -999) {
        ve[i] = Math.max(elev[i], m + 1) + WALL_BOOST;
        known[i] = 1;
        q.push(i);
      }
    }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || known[j] || !isWallG(ground[j])) continue;
      known[j] = 1;
      ve[j] = Math.max(elev[j] + WALL_BOOST, ve[i]);
      q.push(j);
    }
  }
  let minE = 999, maxE = -999;
  for (let i = 0; i < n; i++) {
    if (ground[i] === T.VOID) continue;
    if (ve[i] < minE) minE = ve[i];
    if (ve[i] > maxE) maxE = ve[i];
  }
  if (minE === 999) minE = maxE = 0;
  const voidElev = minE - (dim.kind === 'sky' ? 2.4 : dim.kind === 'overworld' ? 0.7 : 0.9);
  for (let i = 0; i < n; i++) if (ground[i] === T.VOID) ve[i] = voidElev;
  return { ve, voidElev, maxVe: maxE };
}

export function computeOwner(dim: Dimension): Int32Array {
  const { w, h, zone, ground } = dim;
  const n = w * h;
  const owner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (zone[i] >= 0) owner[i] = zone[i];
  const q: number[] = [];
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (owner[i] >= 0 || ground[i] === T.VOID) continue;
      counts.clear();
      let best = -1, bc = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const z = zone[yy * w + xx];
          if (z < 0) continue;
          const c = (counts.get(z) || 0) + 1;
          counts.set(z, c);
          if (c > bc) { bc = c; best = z; }
        }
      if (best >= 0) owner[i] = best;
    }
  for (let i = 0; i < n; i++) if (owner[i] >= 0) q.push(i);
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || owner[j] >= 0 || ground[j] === T.VOID) continue;
      owner[j] = owner[i];
      q.push(j);
    }
  }
  return owner;
}

// ------------------------------------------------------------------ bake

/** Metadata (elevation, faces, owner zones, bounds) without painting; paint lazily with paintDimRender. */
export function buildDimRender(dim: Dimension, seed: number): DimRender {
  const S = bakeSize(dim);
  const H = Math.round(S * 0.4);
  const { w, h } = dim;
  const { ve, voidElev, maxVe } = computeVe(dim);
  const top = Math.ceil(Math.max(0, maxVe) * H + S * 1.1);
  const bottom = Math.ceil((maxVe - voidElev) * H + S * 0.5);
  const faceH = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dim.ground[i] === T.VOID) continue;
      const eS = y + 1 < h ? ve[i + w] : voidElev;
      if (eS < ve[i]) faceH[i] = ve[i] - eS;
    }
  const ch = top + h * S + bottom;
  return {
    dim, S, H, hT: H / S, ve, voidElev, maxVe, top, seed, H_px: ch,
    owner: computeOwner(dim), faceH,
    y0: -top / S, y1: (ch - top) / S,
  };
}

// ------------------------------------------------------------------ ghost layers

/** Coastline / land outline of a dimension as a Path2D in tile units. */
export function buildOutline(src: Dimension): Path2D {
  const { w, h, ground } = src;
  const land = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const g = ground[y * w + x];
    return g !== T.VOID && g !== T.WATER && g !== T.DEEP && g !== T.LAVA;
  };
  const p = new Path2D();
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && land(x, y - 1) !== land(x, y);
      if (edge && run < 0) run = x;
      if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && land(x - 1, y) !== land(x, y);
      if (edge && run < 0) run = y;
      if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
    }
  }
  return p;
}


// ------------------------------------------------------------------ the shape of raised ground
// (the CPU twin of TERRAIN_SHAPE in lit/shaders.ts: keep the two in step)

/** (sBase, sK, eN, eEW) in px: see TERRAIN_SHAPE. */
export type WallPattern = [number, number, number, number];
export interface WallPatterns { main: WallPattern; lip: WallPattern }

/**
 * Three ways a wall shows its sides:
 *  1 "room": all four faces about equally wide (dungeons, caves, the underworld);
 *  2 "outdoor": the face that looks south is tall, the other three are narrow;
 *  3 "lip": the face that looks south as in the dimension's own pattern, the others a thin bevel.
 * Every dimension has pattern 1 or 2, and any tile can ask for the lip variant instead.
 */
export function wallPatterns(dim: Dimension): WallPatterns {
  const room = WALL_MODE[dim.kind] === 'room'; // which pattern a kind of map uses is the tile table's call
  const s = wallShape;
  const main: WallPattern = room ? [s.room, 1, s.room, s.room] : [s.south, 0, s.north, s.side];
  return { main, lip: [main[0], main[1], s.lip, s.lip] };
}

/** Face sizes in px (a tile is 16); set from the graphics settings. */
export interface WallShape { room: number; south: number; north: number; side: number; lip: number }
let wallShape: WallShape = { room: 14, south: 10, north: 6, side: 7, lip: 1.5 };
/** Returns true if the shape changed, in which case layouts and terrain chunks must be rebuilt. */
export function setWallShape(next: WallShape): boolean {
  const same = (Object.keys(next) as (keyof WallShape)[]).every((k) => wallShape[k] === next[k]);
  wallShape = { ...next };
  return !same;
}

export const KIND = { GROUND: 0, VOID: 1, LIQUID: 2, LIP: 4, SLOPED: 8 } as const;

/** Per tile: what it is for the height model, and whether it has lower ground within reach. */
export function tileKinds(dim: Dimension, liftPx: ArrayLike<number>): Uint8Array {
  const { w, h, ground } = dim, n = w * h;
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const g = ground[i];
    kind[i] = g === T.VOID ? KIND.VOID : g === T.WATER || g === T.DEEP || g === T.LAVA ? KIND.LIQUID : dim.lip?.[i] ? KIND.LIP : KIND.GROUND;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (kind[i] & 3) continue;
    let sloped = false;
    for (let dy = -2; dy <= 2 && !sloped; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if ((kind[j] & 3) !== KIND.VOID && liftPx[j] < liftPx[i]) { sloped = true; break; }
    }
    if (sloped) kind[i] |= KIND.SLOPED;
  }
  return kind;
}

/** Surface lift in px at point (px, py) (px within the tile, 0..16) of tile (x, y). */
export function surfacePx(dim: Dimension, liftPx: ArrayLike<number>, kind: Uint8Array, pat: WallPatterns, x: number, y: number, px: number, py: number): number {
  const { w, h } = dim, i = y * w + x;
  const L = liftPx[i];
  if (!(kind[i] & KIND.SLOPED)) return L;
  const lip = (kind[i] & KIND.LIP) !== 0;
  let out = L;
  for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) {
    if (!j && !k) continue;
    const xx = x + k, yy = y + j;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const q = yy * w + xx, kq = kind[q] & 3;
    if (kq === KIND.VOID || liftPx[q] >= L) continue;
    const dL = L - liftPx[q];
    const W = lip || kq === KIND.LIQUID ? pat.lip : pat.main;
    const gx = Math.max(k * 16 - px, px - (k * 16 + 16), 0), gy = Math.max(j * 16 - py, py - (j * 16 + 16), 0);
    const rx = W[3], ry = Math.min(32, j > 0 ? Math.max(0, W[0] - W[1] * dL) : W[2] + dL);
    const dx = gx <= 0 ? 0 : rx < 0.25 ? 9 : gx / rx, dy = gy <= 0 ? 0 : ry < 0.25 ? 9 : gy / ry;
    out = Math.min(out, liftPx[q] + dL * Math.min(Math.max(dx, dy), 1));
  }
  return out;
}
