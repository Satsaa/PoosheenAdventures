// Per-dimension terrain metadata shared by the renderer and the view: visual elevation (walls raised
// above their floor), cliff face heights, the zone that owns each tile (for fog) and the coastline
// outline used by the stacked-world ghost overlay.
import { T, type Dimension } from '../core/types';
import { DEFAULT_WALLS, isWallG, patternsFor, veAt, type WallPatterns, type WallShape } from '../core/shape';

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

/** Flat bake resolution: fixed, the bake is chunked so dimension size does not matter. */
function bakeSize(_dim: Dimension): number {
  return 20;
}

export function computeVe(dim: Dimension): { ve: Float32Array; voidElev: number; maxVe: number } {
  const { w, h, ground } = dim;
  const n = w * h;
  const ve = new Float32Array(n);
  // one rule for how high a tile is drawn, shared with everything that reasons about the terrain
  for (let i = 0; i < n; i++) ve[i] = veAt(dim, i);
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
// The model itself lives in core/shape.ts, shared with the tile checker and the generator.
// Here: the face sizes the graphics settings choose (the picture may differ from the rules'
// defaults, the model never does).
export { KIND, isWallG, surfacePx, tileKinds, type WallPattern, type WallPatterns, type WallShape } from '../core/shape';

let wallShape: WallShape = { ...DEFAULT_WALLS };
export function wallPatterns(dim: Dimension): WallPatterns {
  return patternsFor(dim.kind, wallShape);
}
/** Returns true if the shape changed, in which case layouts and terrain chunks must be rebuilt. */
export function setWallShape(next: WallShape): boolean {
  const same = (Object.keys(next) as (keyof WallShape)[]).every((k) => wallShape[k] === next[k]);
  wallShape = { ...next };
  return !same;
}
