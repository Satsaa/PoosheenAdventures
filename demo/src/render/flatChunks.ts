// Chunked Canvas 2D terrain for the flat renderer: the bake of a dimension is split into
// 32x32-tile canvases painted lazily (each includes everything that pokes into it from
// neighbouring rows, painted in global row order, so there are no seams), kept in an LRU
// that never evicts what the current frame draws. Also builds the flat low-res overview.
import { D, T, type DimId, type Dimension } from '../core/types';
import { buildOverview, overviewPx, type Overview, type OverviewColors, type RGB } from './overview';
import { pal } from './palette';
import { type DimRender, footprint, paintRegion } from './terrain';
import { ctx2d, hexRgb, makeCanvas } from './util';

export const FLAT_CHUNK_TILES = 32;

export interface FChunk {
  dim: DimId;
  cx: number;
  cy: number;
  base: HTMLCanvasElement;
  view: HTMLCanvasElement | null;
  viewKey: number;
  lastUse: number;
}

export const flatStats = { chunkMs: [] as number[], overviewMs: 0, live: 0 };

const DECO_COL: Record<number, string> = {
  [D.TREE]: '#2f7a2c', [D.PINE]: '#1f5c3a', [D.PALM]: '#3aa244', [D.DEADTREE]: '#5b4a40', [D.ROCK]: '#8b8580', [D.TUFT]: '#3f8a35',
  [D.FLOWER]: '#ff7a9a', [D.CACTUS]: '#3f9a4a', [D.CRYSTAL]: '#5ff2ff', [D.MUSHROOM]: '#e0342e', [D.PILLAR]: '#c9c0b0',
  [D.REED]: '#6f8f3a', [D.HOUSE]: '#b5432e', [D.STALAG]: '#4a4058',
};

export const flatColors: OverviewColors = {
  ground: (g) => hexRgb(pal(g).top[1]),
  face: (g) => hexRgb(pal(g).face[0]),
  deco: (d) => (DECO_COL[d] ? hexRgb(DECO_COL[d]) : null),
  emit: (g, d) => (g === T.LAVA ? [120, 50, 0] : d === D.CRYSTAL ? [40, 120, 140] : null) as RGB | null,
  mat: () => 0,
};

export class FlatChunks {
  private map = new Map<string, FChunk>();
  budget = 28;
  private scratchA: HTMLCanvasElement | null = null;
  private scratchB: HTMLCanvasElement | null = null;

  cpx(dr: DimRender) { return FLAT_CHUNK_TILES * dr.S; }
  cols(dr: DimRender) { return Math.ceil((dr.dim.w * dr.S) / this.cpx(dr)); }
  rows(dr: DimRender) { return Math.ceil(dr.H_px / this.cpx(dr)); }

  get(dr: DimRender, cx: number, cy: number): FChunk | undefined {
    return this.map.get(`${dr.dim.id}:${cx}:${cy}`);
  }

  /** tile rows/cols whose paint can reach into chunk (cx,cy) */
  private rect(dr: DimRender, cx: number, cy: number) {
    const CP = this.cpx(dr), { S, H, top, maxVe, voidElev } = dr;
    return {
      x0: cx * FLAT_CHUNK_TILES - 1,
      x1: (cx + 1) * FLAT_CHUNK_TILES + 1,
      y0: Math.floor((cy * CP - top - S - (maxVe - voidElev) * H) / S) - 1,
      y1: Math.ceil(((cy + 1) * CP - top + maxVe * H + 1.3 * S) / S) + 1,
    };
  }

  compose(dr: DimRender, cx: number, cy: number): FChunk {
    const t0 = performance.now();
    const CP = this.cpx(dr);
    const base = makeCanvas(CP, CP);
    const c = ctx2d(base);
    c.translate(-cx * CP, -cy * CP);
    const r = this.rect(dr, cx, cy);
    paintRegion(dr, c, r.x0, r.x1, r.y0, r.y1);
    const ch: FChunk = { dim: dr.dim.id, cx, cy, base, view: null, viewKey: -1, lastUse: performance.now() };
    this.map.set(`${dr.dim.id}:${cx}:${cy}`, ch);
    flatStats.chunkMs.push(performance.now() - t0);
    if (flatStats.chunkMs.length > 200) flatStats.chunkMs.shift();
    flatStats.live = this.map.size;
    return ch;
  }

  evict(pinned: Set<FChunk>, budget = this.budget) {
    if (this.map.size <= budget) return;
    const all = [...this.map.entries()].filter(([, c]) => !pinned.has(c)).sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [k, c] of all) {
      if (this.map.size <= budget) break;
      c.base.width = c.base.height = 0; // release backing store now
      if (c.view) c.view.width = c.view.height = 0;
      this.map.delete(k);
    }
    flatStats.live = this.map.size;
  }

  /** The chunk with unreachable tiles desaturated/darkened, rebuilt when `key` changes. */
  fogView(dr: DimRender, ch: FChunk, key: number, fogged: (i: number) => boolean): HTMLCanvasElement {
    if (ch.view && ch.viewKey === key) return ch.view;
    const CP = this.cpx(dr);
    if (!this.scratchA || this.scratchA.width !== CP) { this.scratchA = makeCanvas(CP, CP); this.scratchB = makeCanvas(CP, CP); }
    const fogC = this.scratchA, maskC = this.scratchB!;
    // desaturated, darkened, cool copy of the chunk
    const f = ctx2d(fogC);
    f.globalCompositeOperation = 'source-over';
    f.clearRect(0, 0, CP, CP);
    if (typeof (f as { filter?: unknown }).filter === 'string') {
      f.filter = 'grayscale(0.8) brightness(0.62) contrast(0.9)';
      f.drawImage(ch.base, 0, 0);
      f.filter = 'none';
    } else {
      f.drawImage(ch.base, 0, 0);
      f.globalCompositeOperation = 'saturation';
      f.globalAlpha = 0.8;
      f.fillStyle = 'rgb(128,128,128)';
      f.fillRect(0, 0, CP, CP);
      f.globalAlpha = 1;
      f.globalCompositeOperation = 'multiply';
      f.fillStyle = '#8a90aa';
      f.fillRect(0, 0, CP, CP);
    }
    f.globalCompositeOperation = 'source-atop';
    f.fillStyle = 'rgba(40,50,100,0.28)';
    f.fillRect(0, 0, CP, CP);
    f.globalCompositeOperation = 'destination-in';
    f.drawImage(ch.base, 0, 0);
    f.globalCompositeOperation = 'source-over';
    // mask: fogged footprints in painter order
    const m = ctx2d(maskC);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, CP, CP);
    m.translate(-ch.cx * CP, -ch.cy * CP);
    m.fillStyle = '#000';
    const r = this.rect(dr, ch.cx, ch.cy);
    const { dim } = dr;
    for (let y = Math.max(0, r.y0); y < Math.min(dim.h, r.y1); y++)
      for (let x = Math.max(0, r.x0); x < Math.min(dim.w, r.x1); x++) {
        const i = y * dim.w + x;
        if (dim.ground[i] === T.VOID) continue;
        const [fx, fy, fw, fh] = footprint(dr, i, true);
        if (fogged(i)) m.fillRect(fx, fy, fw, fh);
        else m.clearRect(fx, fy, fw, fh);
      }
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-in';
    m.drawImage(fogC, 0, 0);
    m.globalCompositeOperation = 'source-over';
    if (!ch.view) ch.view = makeCanvas(CP, CP);
    const v = ctx2d(ch.view);
    v.clearRect(0, 0, CP, CP);
    v.drawImage(ch.base, 0, 0);
    v.drawImage(maskC, 0, 0);
    ch.viewKey = key;
    return ch.view;
  }

  /** drop every chunk (new world) */
  clear() {
    for (const c of this.map.values()) {
      c.base.width = c.base.height = 0;
      if (c.view) c.view.width = c.view.height = 0;
    }
    this.map.clear();
    flatStats.live = 0;
  }

  size() { return this.map.size; }
}

export interface FlatOverview {
  ov: Overview;
  canvas: HTMLCanvasElement;
  fog: HTMLCanvasElement | null;
  fogKey: number;
}

/** Low-res, pre-shaded overview canvas of a dimension aligned with the flat bake (top margin = dr.top). */
export function buildFlatOverview(dr: DimRender): FlatOverview {
  const { dim } = dr;
  const n = dim.w * dim.h;
  const lift = new Float32Array(n);
  for (let i = 0; i < n; i++) lift[i] = dim.ground[i] === T.VOID ? dr.voidElev * dr.hT : dr.ve[i] * dr.hT;
  const opx = overviewPx(dim.w, Math.ceil(dr.H_px / dr.S), 4096);
  const ov = buildOverview(dim, lift, dr.voidElev * dr.hT, dr.top / dr.S, dr.H_px / dr.S - dr.top / dr.S - dim.h, opx, flatColors, false);
  flatStats.overviewMs = ov.ms;
  const canvas = makeCanvas(ov.w, ov.h);
  const img = new ImageData(new Uint8ClampedArray(ov.rgba!.buffer as ArrayBuffer), ov.w, ov.h);
  ctx2d(canvas).putImageData(img, 0, 0);
  return { ov, canvas, fog: null, fogKey: -1 };
}

export function flatOverviewFog(fo: FlatOverview, key: number, fogged: (i: number) => boolean): HTMLCanvasElement {
  if (fo.fog && fo.fogKey === key) return fo.fog;
  const { ov } = fo;
  const src = ov.rgba!, tix = ov.tix!;
  const out = new Uint8ClampedArray(src.length);
  const cache = new Map<number, boolean>();
  for (let p = 0, n = ov.w * ov.h; p < n; p++) {
    const o = p * 4;
    out[o + 3] = src[o + 3];
    const t = tix[p];
    let f = false;
    if (t >= 0) {
      const c = cache.get(t);
      if (c === undefined) { f = fogged(t); cache.set(t, f); } else f = c;
    }
    if (f) {
      const l = src[o] * 0.3 + src[o + 1] * 0.59 + src[o + 2] * 0.11;
      out[o] = l * 0.5 + 10; out[o + 1] = l * 0.53 + 12; out[o + 2] = l * 0.62 + 22;
    } else { out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; }
  }
  if (!fo.fog) fo.fog = makeCanvas(ov.w, ov.h);
  ctx2d(fo.fog).putImageData(new ImageData(out, ov.w, ov.h), 0, 0);
  fo.fogKey = key;
  return fo.fog;
}
