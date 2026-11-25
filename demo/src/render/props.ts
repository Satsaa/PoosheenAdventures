// Ground-standing props as individual sprite instances (shared by the lit and flat renderers).
// A per-dimension grid in CSR form (typed arrays only: no per-prop objects) lists the tiles that
// carry a standing prop (trees, rocks, pillars, crystals, building pieces, ...). Each frame the
// renderers walk only the cells around the view.
import { D, T, type Dimension } from '../core/types';
import { ROOF_COLORS, ROOF_FALLBACK } from './bake/models';
import type { AssetSheet, Frame } from './bake/sheet';
import { hash2 } from './util';

export const CELL = 32;
/** flat ground decals that stay baked into the terrain chunks */
export const DECAL = new Set<number>([D.TUFT, D.FLOWER]);
export const isProp = (d: number) => d !== D.NONE && !DECAL.has(d);

export interface PropGrid {
  cols: number;
  rows: number;
  /** cell c lists idx[start[c] .. start[c+1]) */
  start: Uint32Array;
  idx: Uint32Array;
  count: number;
  /** per building tile: structure index (or -1), only for tiles listed in houseOf */
  houseOf: Map<number, number>;
}

export function buildPropGrid(dim: Dimension): PropGrid {
  const { w, h, deco, ground } = dim;
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  const cnt = new Uint32Array(cols * rows + 1);
  let total = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isProp(deco[i]) || ground[i] === T.VOID) continue;
      cnt[Math.floor(y / CELL) * cols + Math.floor(x / CELL) + 1]++;
      total++;
    }
  for (let c = 1; c <= cols * rows; c++) cnt[c] += cnt[c - 1];
  const start = cnt.slice();
  const fill = cnt.slice();
  const idx = new Uint32Array(total);
  // row-major within a cell keeps instances roughly sorted north -> south
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isProp(deco[i]) || ground[i] === T.VOID) continue;
      idx[fill[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++] = i;
    }
  const houseOf = new Map<number, number>();
  (dim.structures || []).forEach((s, k) => { for (const t of s.tiles) houseOf.set(t, k); });
  return { cols, rows, start, idx, count: total, houseOf };
}

/** call cb(tileIndex) for every prop in the tile rect (inclusive bounds) */
export function forProps(g: PropGrid, dim: Dimension, x0: number, y0: number, x1: number, y1: number, cb: (i: number) => void) {
  const cx0 = Math.max(0, Math.floor(x0 / CELL)), cx1 = Math.min(g.cols - 1, Math.floor(x1 / CELL));
  const cy0 = Math.max(0, Math.floor(y0 / CELL)), cy1 = Math.min(g.rows - 1, Math.floor(y1 / CELL));
  const w = dim.w;
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * g.cols + cx;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const i = g.idx[k];
        const x = i % w, y = (i / w) | 0;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) cb(i);
      }
    }
}

export interface PropLook {
  frame: Frame;
  /** tint (building roofs) */
  r: number; g: number; b: number;
  /** emissive scale class: 1 = lit windows (scaled by night) */
  windows: boolean;
}

function styleColor(style: string): [number, number, number] {
  const c = ROOF_COLORS[style];
  if (c) return c;
  let h = 0;
  for (let k = 0; k < style.length; k++) h = (h * 31 + style.charCodeAt(k)) | 0;
  return ROOF_FALLBACK[Math.abs(h) % ROOF_FALLBACK.length];
}

/** sprite for the prop on tile i (null if the sheet has none) */
export function propLook(dim: Dimension, g: PropGrid, i: number, sheet: AssetSheet, seed: number): PropLook | null {
  const d = dim.deco[i], w = dim.w;
  const x = i % w, y = (i / w) | 0;
  if (d === D.HOUSE) {
    const isH = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < dim.h && dim.deco[yy * w + xx] === D.HOUSE &&
      (g.houseOf.get(yy * w + xx) ?? -1) === (g.houseOf.get(i) ?? -1);
    const mask = (isH(x, y - 1) ? 1 : 0) | (isH(x + 1, y) ? 2 : 0) | (isH(x, y + 1) ? 4 : 0) | (isH(x - 1, y) ? 8 : 0);
    const st = dim.structures?.[g.houseOf.get(i) ?? -1];
    const style = st?.style ?? 'timber-red';
    const wall = /stone|marble/.test(style) ? 'stone' : 'plaster';
    const floors = Math.max(1, Math.min(2, st?.floors ?? 1));
    const f = sheet.frames.get(`hp:${wall}:${floors}:${mask}`)?.[0];
    if (!f) return null;
    const c = styleColor(style);
    return { frame: f, r: c[0], g: c[1], b: c[2], windows: true };
  }
  const under = dim.kind === 'underworld' || dim.kind === 'interior';
  let key = 'd:' + d;
  if (d === D.PINE && dim.ground[i] === T.SNOW) key += ':snow';
  if (d === D.MUSHROOM && under) key += ':glow';
  const list = sheet.frames.get(key);
  if (!list) return null;
  const v = Math.min(list.length - 1, Math.floor(hash2(x, y, seed + d * 7) * list.length));
  return { frame: list[v], r: 1, g: 1, b: 1, windows: false };
}
