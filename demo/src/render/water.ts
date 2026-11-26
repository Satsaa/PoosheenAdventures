// Water classification shared by both renderers: calm ponds/lakes, rough deep water, and flowing
// river bands with a per-tile flow direction derived from the water level gradient and waterfall
// objects (there is no flow field in the data).
import { T, type Dimension } from '../core/types';

/** per-tile water kind */
export const WK = { NONE: 0, CALM: 1, ROUGH: 2, RIVER: 3 } as const;
/** flow direction codes: 0 none, 1 n, 2 e, 3 s, 4 w */
export const FLOW_VEC: [number, number][] = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
const DIR_CODE: Record<string, number> = { n: 1, e: 2, s: 3, w: 4 };

export interface WaterInfo {
  kind: Uint8Array;
  flow: Uint8Array;
  /** deep water: tiles to the nearest land (capped at 15); open sea gets darker and calmer with it */
  dist: Uint8Array;
}

/** distance (in tiles, capped) from each DEEP tile to the nearest tile that is not water */
function seaDistance(dim: Dimension): Uint8Array {
  const { w, h, ground } = dim;
  const n = w * h;
  const dist = new Uint8Array(n).fill(255);
  const q: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = ground[i];
    if (g !== T.DEEP && g !== T.WATER && g !== T.VOID) { dist[i] = 0; q.push(i); }
  }
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w, y = (i / w) | 0, d = dist[i] + 1;
    if (d > 15) continue;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
      if (j >= 0 && dist[j] > d) { dist[j] = d; q.push(j); }
  }
  for (let i = 0; i < n; i++) if (dist[i] > 15) dist[i] = 15;
  return dist;
}

export function isWaterfall(o: { kind: string; gate?: string }): boolean {
  return o.kind === 'gate' && (o.gate as string) === 'waterfall';
}

export function computeWater(dim: Dimension, ve: Float32Array): WaterInfo {
  const { w, h, ground } = dim;
  const n = w * h;
  const kind = new Uint8Array(n);
  const flow = new Uint8Array(n);
  // the generator's per-tile downstream direction is the truth when present
  const given = (dim as Dimension & { flow?: Uint8Array }).flow;
  if (given && given.length === n) {
    for (let i = 0; i < n; i++) {
      const g = ground[i];
      if (g === T.DEEP) kind[i] = WK.ROUGH;
      else if (g === T.WATER || g === T.SWAMP) {
        const f = given[i];
        if (f >= 1 && f <= 4 && g === T.WATER) { kind[i] = WK.RIVER; flow[i] = f; } else if (g === T.WATER) kind[i] = WK.CALM;
      }
    }
    return { kind, flow, dist: seaDistance(dim) };
  }
  const isW = (i: number) => ground[i] === T.WATER;
  for (let i = 0; i < n; i++) if (ground[i] === T.DEEP) kind[i] = WK.ROUGH;
  // horizontal / vertical run lengths through each water tile (capped) -> local band axis and thickness
  const hr = new Uint8Array(n), vr = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!isW(y * w + x)) { x++; continue; }
      let e = x;
      while (e < w && isW(y * w + e)) e++;
      for (let k = x; k < e; k++) hr[y * w + k] = Math.min(255, e - x);
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!isW(y * w + x)) { y++; continue; }
      let e = y;
      while (e < h && isW(e * w + x)) e++;
      for (let k = y; k < e; k++) vr[k * w + x] = Math.min(255, e - y);
      y = e;
    }
  }
  // components: rivers are long thin bands (thickness <= ~4.5), ponds / lakes are not
  const comp = new Int32Array(n).fill(-1);
  const fallDir = new Map<number, number>();
  for (const o of dim.objects) if (isWaterfall(o) && o.x >= 0 && o.y >= 0 && o.x < w && o.y < h) fallDir.set(o.y * w + o.x, DIR_CODE[o.dir || 's'] || 3);
  const q: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!isW(s) || comp[s] >= 0) continue;
    const id = s;
    q.length = 0;
    q.push(s);
    comp[s] = id;
    let thick = 0, levels = new Set<number>(), falls = 0;
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      thick += Math.min(hr[i], vr[i]);
      levels.add(ve[i]);
      if (fallDir.has(i)) falls++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && isW(i - 1) && comp[i - 1] < 0) { comp[i - 1] = id; q.push(i - 1); }
      if (x < w - 1 && isW(i + 1) && comp[i + 1] < 0) { comp[i + 1] = id; q.push(i + 1); }
      if (y > 0 && isW(i - w) && comp[i - w] < 0) { comp[i - w] = id; q.push(i - w); }
      if (y < h - 1 && isW(i + w) && comp[i + w] < 0) { comp[i + w] = id; q.push(i + w); }
    }
    const avgThick = thick / q.length;
    const river = q.length >= 16 && (avgThick <= 4.5 || levels.size > 1 || falls > 0);
    for (const i of q) kind[i] = river ? WK.RIVER : WK.CALM;
    if (!river) continue;
    // default direction of the component: from the waterfalls, else from the overall level gradient, else east/south
    let fx = 0, fy = 0;
    for (const i of q) { const f = fallDir.get(i); if (f) { fx += FLOW_VEC[f][0]; fy += FLOW_VEC[f][1]; } }
    for (const i of q) {
      const x = i % w, y = (i / w) | 0;
      const along = hr[i] >= vr[i] ? 0 : 1; // 0: band runs east-west
      let d = 0;
      const f = fallDir.get(i);
      if (f) d = f;
      else {
        // level gradient along the band axis, sampled a few tiles away
        const sample = (dx: number, dy: number) => {
          for (let k = 6; k >= 1; k--) {
            const xx = x + dx * k, yy = y + dy * k;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && comp[yy * w + xx] === id) return ve[yy * w + xx];
          }
          return ve[i];
        };
        if (along === 0) {
          const a = sample(-1, 0), b = sample(1, 0);
          d = a > b ? 2 : b > a ? 4 : fx < 0 ? 4 : 2;
        } else {
          const a = sample(0, -1), b = sample(0, 1);
          d = a > b ? 3 : b > a ? 1 : fy < 0 ? 1 : 3;
        }
      }
      flow[i] = d;
    }
  }
  return { kind, flow, dist: seaDistance(dim) };
}
