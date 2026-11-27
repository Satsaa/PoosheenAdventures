// Low-resolution overview of a whole dimension, built straight from tile data (no sprites):
// 1-4 px per tile with the same elevation lift and cliff faces as the full-res terrain.
// Used for zoomed-out views, as the placeholder for chunks not composed yet, and as the
// source of the stacked-world ghost layer. Shared by the lit (G-buffer layers) and flat
// (pre-shaded RGBA) paths.
import { D, T, type Dimension } from '../core/types';
import { hash2 } from './util';
import { KIND, surfacePx, type WallPatterns } from './terrain';

export type RGB = [number, number, number];

export interface OverviewColors {
  ground(g: number): RGB;
  face(g: number): RGB;
  /** colour a prop adds to its tile (null = none) */
  deco(d: number, g: number): RGB | null;
  /** emitted colour of a tile (lava, crystals, windows) */
  emit(g: number, d: number, x: number, y: number): RGB | null;
  /** material id of a ground (lit path) */
  mat(g: number): number;
}

export interface Overview {
  /** px per tile */
  opx: number;
  w: number;
  h: number;
  /** tiles above row 0 */
  topT: number;
  alb: Uint8Array;
  /** world normal + height (lit only) */
  nrm: Uint8Array | null;
  emi: Uint8Array | null;
  tid: Uint8Array | null;

  ms: number;
}

const TALL = new Set<number>([D.TREE, D.PINE, D.PALM, D.DEADTREE, D.PILLAR, D.HOUSE, D.CACTUS, D.STALAG]);

export function overviewPx(w: number, h: number, maxTex: number): number {
  const byMem = Math.floor(Math.sqrt(1.6e6 / Math.max(1, w * h)));
  const byTex = Math.floor((maxTex - 8) / Math.max(w, h + 8));
  return Math.max(1, Math.min(4, byMem, byTex));
}

/**
 * @param lift  per-tile lift in tiles (same as the full-res renderer uses)
 * @param voidLift lift of VOID / out-of-map (for faces at the map edge)
 * @param topT  tiles of margin above row 0 (must match the renderer's layout top / 16)
 * @param extraT tiles of margin below the last row
 */
export function buildOverview(
  dim: Dimension, lift: Float32Array, voidLift: number, topT: number, extraT: number, opx: number,
  col: OverviewColors, lit: boolean,
  /** the sloped sides of raised ground, as the full-detail terrain draws them */
  shape?: { liftPx: ArrayLike<number>; kind: Uint8Array; fits: Uint8Array; walls: WallPatterns },
): Overview {
  const t0 = performance.now();
  const { w, h, ground, deco } = dim;
  const OW = w * opx, OH = Math.ceil((topT + h + extraT) * opx);
  const n = OW * OH;
  const alb = new Uint8Array(n * 4);
  const nrm = lit ? new Uint8Array(n * 4) : null;
  const emi = lit ? new Uint8Array(n * 4) : null;
  const tid = lit ? new Uint8Array(n * 4) : null;

  const put = (px: number, py: number, c: RGB, top: boolean, hgt: number, e: RGB | null, mat: number, tx: number, ty: number, shade: number) => {
    if (px < 0 || py < 0 || px >= OW || py >= OH) return;
    const o = (py * OW + px) * 4;
    alb[o] = c[0]; alb[o + 1] = c[1]; alb[o + 2] = c[2]; alb[o + 3] = 255;
    if (nrm) {
      nrm[o] = 128; nrm[o + 1] = top ? 128 : 255; nrm[o + 2] = top ? 255 : 128;
      nrm[o + 3] = Math.max(0, Math.min(255, Math.round((hgt + 1) * 40)));
      emi![o] = e ? e[0] : 0; emi![o + 1] = e ? e[1] : 0; emi![o + 2] = e ? e[2] : 0; emi![o + 3] = mat;
      tid![o] = tx & 255; tid![o + 1] = ty & 255; tid![o + 2] = (tx >> 8) + (ty >> 8) * 16; tid![o + 3] = 0;
    }
  };
  const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mixCache = new Map<RGB, Map<RGB, RGB>>();
  const mixed = (a: RGB, b: RGB): RGB => { let m = mixCache.get(a); if (!m) mixCache.set(a, (m = new Map())); let c = m.get(b); if (!c) m.set(b, (c = mix(a, b, 0.75))); return c; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const g = ground[i];
      if (g === T.VOID) continue;
      const L = lift[i];
      const oy0 = Math.round((topT + y - L) * opx);
      const LS = y + 1 < h && ground[i + w] !== T.VOID ? lift[i + w] : voidLift;
      const oy1 = Math.round((topT + y + 1 - Math.min(L, LS)) * opx);
      const base = col.ground(g);
      const d = deco[i];
      const dc = d ? col.deco(d, g) : null;
      const e = col.emit(g, d, x, y);
      const mat = col.mat(g);
      const shadeTop = 1 + Math.max(-0.3, Math.min(0.25, L * 0.12));
      const jit = 0.94 + hash2(x, y, 5) * 0.12;
      const sloped = !!shape && (shape.kind[i] & KIND.SLOPED) !== 0;
      if (sloped) {
        // sample the surface north to south and put every sample where the projection takes it:
        // a face that leans toward the camera stretches, so there are three samples per pixel row
        const fc = col.face(g), rows = Math.max(3, opx * 3), Lpx = shape!.liftPx[i];
        for (let sy = 0; sy < rows; sy++)
          for (let px = 0; px < opx; px++) {
            const fx = ((px + 0.5) / opx) * 16, fy = ((sy + 0.5) / rows) * 16;
            const H = surfacePx(dim, shape!.liftPx, shape!.kind, shape!.fits, shape!.walls, x, y, fx, fy);
            const top = H >= Lpx - 0.3;
            const row = Math.floor((topT + y + fy / 16 - H / 16) * opx);
            let c = top ? base : fc;
            if (top && dc && (opx === 1 || (px + sy) % 2 === 0)) c = mixed(base, dc);
            put(x * opx + px, row, c, top, H / 16, top ? e : null, top ? mat : 0, x, y, top ? shadeTop * jit : 0.62);
          }
      } else
      for (let py = 0; py < opx; py++)
        for (let px = 0; px < opx; px++) {
          let c = base;
          if (dc && (opx === 1 || (px + py) % 2 === 0 || py === 0)) c = mixed(base, dc);
          put(x * opx + px, oy0 + py, c, true, L, e, mat, x, y, shadeTop * jit);
        }
      // cliff face below
      if (LS < L && (!sloped || y + 1 >= h || ground[i + w] === T.VOID) && !(dim.kind === 'overworld' && y + 1 >= h)) {
        const fc = col.face(g);
        for (let py = oy0 + opx; py < oy1; py++)
          for (let px = 0; px < opx; px++) put(x * opx + px, py, fc, false, L - (py - oy0 - opx) / opx, null, 0, x, y, 0.62);
      }
      // tall props poke above their tile
      if (dc && TALL.has(d)) {
        const up = d === D.HOUSE || d === D.PILLAR || d === D.PINE ? 0.6 : 0.4;
        const n2 = Math.max(1, Math.round(up * opx));
        for (let py = 1; py <= n2; py++)
          for (let px = 0; px < opx; px++)
            if (opx < 3 || (px > 0 && px < opx - 1)) put(x * opx + px, oy0 - py, dc, true, L + 0.5, e, 5, x, y, 1.05 * jit);
      }
    }
  }
  return { opx, w: OW, h: OH, topT, alb, nrm, emi, tid, ms: performance.now() - t0 };
}
