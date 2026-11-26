// Builds sprite instance lists: the static terrain of a dimension (composed once into a per-dimension
// G-buffer) and the dynamic objects (drawn each frame on top). Same painter order and elevation rules
// as the flat renderer: row by row north -> south, tile tops shifted up by their lift, cliff faces
// below where the south neighbour is lower, tall props overlapping the row above.
import { D, T, type Dimension, type MapObject } from '../../core/types';
import type { AssetSheet, Frame } from '../bake/sheet';
import { TILE_PX } from '../bake/sheet';
import { pal } from '../palette';
import { hash2 } from '../util';
import { KIND, isWallG, surfacePx, tileKinds, wallPatterns, type WallPatterns } from '../terrain';
import { DECAL } from '../props';
import { FACE_OFF, shapeOf } from '../bake/ground';

/** SLOPED: the top of a tile whose sides slope; the shader keeps only what is really at the top */
export const FLAG = { FACE: 1, BEV_N: 2, BEV_W: 4, BEV_E: 8, SLOPED: 16, TINTALL: 32 } as const;
/** autotile flags (see SPRITE_FS): face end returns, outer corner cuts, inner corners, contact skirting */
export const AUTO = {
  FACE_L: 4096, FACE_R: 8192, CUT_NW: 16384, CUT_NE: 32768, IN_NW: 65536, IN_NE: 131072,
  SK_N: 262144, SK_E: 524288, SK_W: 1048576, SK_NW: 2097152, SK_NE: 4194304,
  /** ground top: multiply albedo by the wall-foot base piece whose frame x, y travel in the tint */
  BASE: 8388608,
} as const;
/** outer-corner radius in px per ground (+16 = chamfer instead of round) */
function cornerR(g: number): number {
  return g === T.WALL ? 16 + 3 : g === T.CAVEWALL ? 5 : g === T.FLOOR || g === T.PLANK ? 0 : 3;
}
export const FLOATS = 16;
const P = TILE_PX;

export class InstBuf {
  f = new Float32Array(FLOATS * 1024);
  n = 0;
  push(dx: number, dy: number, w: number, h: number, sx: number, sy: number, mx: number, my: number,
    z: number, tx: number, ty: number, flags: number, r = 1, g = 1, b = 1, e = 1) {
    if ((this.n + 1) * FLOATS > this.f.length) {
      const nf = new Float32Array(this.f.length * 2);
      nf.set(this.f);
      this.f = nf;
    }
    const o = this.n++ * FLOATS, f = this.f;
    f[o] = dx; f[o + 1] = dy; f[o + 2] = w; f[o + 3] = h;
    f[o + 4] = sx; f[o + 5] = sy; f[o + 6] = mx; f[o + 7] = my;
    f[o + 8] = z; f[o + 9] = tx; f[o + 10] = ty; f[o + 11] = flags;
    f[o + 12] = r; f[o + 13] = g; f[o + 14] = b; f[o + 15] = e;
  }
  sprite(fr: Frame, tileX: number, tileY: number, x: number, y: number, liftPx: number, top: number, flags = 0, tint: readonly number[] = [1, 1, 1], e = 1, dyExtra = 0) {
    this.push(x * P - fr.ox, top + y * P - liftPx - fr.oy + dyExtra, fr.w, fr.h, fr.x, fr.y, -1, -1, liftPx / P, tileX, tileY, flags, tint[0], tint[1], tint[2], e);
  }
}

export interface Layout {
  /** G-buffer size in px */
  W: number;
  H: number;
  /** px above row 0 */
  top: number;
  /** per-tile lift in px (rounded elev * 6.4) */
  liftPx: Int16Array;
  voidLiftPx: number;
  maxLiftPx: number;
  /** what each tile is for the height model (KIND.*), set by the renderer */
  kind?: Uint8Array;
  walls?: WallPatterns;
  /** lift in px of whatever stands in the middle of each tile (lower than liftPx on a slope) */
  standPx?: Int16Array;
}

/** Lift of the ground under a prop, object or creature standing on tile i. */
export const standOf = (lay: Layout, i: number): number => (lay.standPx ? lay.standPx[i] : lay.liftPx[i]) ?? 0;

/** Fill in the per-tile kinds and standing heights once the layout and wall patterns are known. */
export function shapeLayout(dim: Dimension, lay: Layout, kind: Uint8Array, walls: WallPatterns): void {
  lay.kind = kind;
  lay.walls = walls;
  const n = dim.w * dim.h;
  const stand = new Int16Array(n);
  for (let i = 0; i < n; i++) stand[i] = kind[i] & KIND.SLOPED ? Math.round(surfacePx(dim, lay.liftPx, kind, walls, i % dim.w, (i / dim.w) | 0, 8, 8)) : lay.liftPx[i];
  lay.standPx = stand;
}

export const liftOf = (ve: number) => Math.round(ve * TILE_PX * 0.4);

export function layout(dim: Dimension, ve: Float32Array, voidElev: number): Layout {
  const n = dim.w * dim.h;
  const liftPx = new Int16Array(n);
  let maxL = 0;
  for (let i = 0; i < n; i++) {
    liftPx[i] = dim.ground[i] === T.VOID ? liftOf(voidElev) : liftOf(ve[i]);
    if (dim.ground[i] !== T.VOID && liftPx[i] > maxL) maxL = liftPx[i];
  }
  const voidLiftPx = liftOf(voidElev);
  const top = maxL + 36;
  const lay: Layout = { W: dim.w * P, H: top + dim.h * P + (maxL - voidLiftPx) + 8, top, liftPx, voidLiftPx, maxLiftPx: maxL };
  shapeLayout(dim, lay, tileKinds(dim, liftPx), wallPatterns(dim));
  return lay;
}

export function variant(x: number, y: number, salt: number, n: number) {
  return Math.min(n - 1, Math.floor(hash2(x, y, salt) * n));
}

export interface StaticOut {
  inst: InstBuf;
  /** world positions (tiles; z = height) of wall torches and lit house windows */
  torches: [number, number, number][];
  windows: [number, number, number][];
}

export interface TileRect { x0: number; y0: number; x1: number; y1: number }

/** Sprite instances for the tiles in `rect` (inclusive-exclusive), in global painter order. */
export function buildStatic(dim: Dimension, lay: Layout, sheet: AssetSheet, seed: number, rect?: TileRect, out?: InstBuf): StaticOut {
  const { w, h, ground, deco } = dim;
  const rx0 = Math.max(0, rect?.x0 ?? 0), ry0 = Math.max(0, rect?.y0 ?? 0);
  const rx1 = Math.min(w, rect?.x1 ?? w), ry1 = Math.min(h, rect?.y1 ?? h);
  const { liftPx, top, voidLiftPx } = lay;
  const inst = out ?? new InstBuf();
  inst.n = 0;
  const torches: [number, number, number][] = [];
  const windows: [number, number, number][] = [];
  const fr = sheet.frames;
  const gAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? T.VOID : ground[y * w + x]);
  const lAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? voidLiftPx : liftPx[y * w + x]);
  const dAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : deco[y * w + x]);
  const under = dim.kind === 'underworld' || dim.kind === 'interior';
  const get = (k: string) => fr.get(k);
  const lavaTint = [1.0, 0.55, 0.2];
  // corner textures in the sheet win; a sheet without them falls back to shader-drawn rims
  const art = fr.has('wm:round:0');
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      const i = y * w + x;
      const g = ground[i];
      if (g === T.VOID) continue;
      const L = liftPx[i];
      const px = x * P, py = top + y * P - L;
      const gl = get('g:' + g);
      if (!gl) continue;
      const p = pal(g);
      // sides that slope down to lower ground are drawn by one "slope" instance; the top keeps
      // only what is really at the top, and loses the rims and corner cuts of a box-shaped tile
      const sloped = !!lay.kind && (lay.kind[i] & KIND.SLOPED) !== 0 && !!get('f:' + g);
      let flags = sloped ? FLAG.SLOPED : 0;
      const lN = lAt(x, y - 1), lW = lAt(x - 1, y), lE = lAt(x + 1, y), lNW = lAt(x - 1, y - 1), lNE = lAt(x + 1, y - 1);
      if (!p.liquid && !sloped) {
        // raised edges: rims, outer corner cuts and inner corners from the 8-neighbourhood
        if (lN < L) flags |= FLAG.BEV_N;
        if (lW < L) flags |= FLAG.BEV_W;
        if (lE < L) flags |= FLAG.BEV_E;
        if (lN < L && lW < L && lNW < L) flags |= AUTO.CUT_NW;
        if (lN < L && lE < L && lNE < L) flags |= AUTO.CUT_NE;
        if (lN >= L && lW >= L && lNW < L) flags |= AUTO.IN_NW;
        if (lN >= L && lE >= L && lNE < L) flags |= AUTO.IN_NE;
        // contact skirting at the foot of higher ground (south faces of the row above, sides, corners)
        if (lN > L) flags |= AUTO.SK_N;
        if (lW > L) flags |= AUTO.SK_W;
        if (lE > L) flags |= AUTO.SK_E;
        if (lN <= L && lW <= L && lNW > L) flags |= AUTO.SK_NW;
        if (lN <= L && lE <= L && lNE > L) flags |= AUTO.SK_NE;
      }
      const f0 = gl[variant(x, y, seed + g, gl.length)];
      let flip = g !== T.FLOOR && g !== T.WALL && g !== T.PLANK && g !== T.CAVEWALL && hash2(x, y, seed + 13) < 0.5 ? 128 : 0;
      // corner textures from the sheet (fallback: shader rims from the flags above)
      const lS = lAt(x, y + 1), lSW = lAt(x - 1, y + 1), lSE = lAt(x + 1, y + 1);
      let topMaskF: Frame | null = null;
      const rims: Frame[] = [];
      if (art && !p.liquid && !sloped) {
        const cut = (lN < L && lW < L && lNW < L ? 1 : 0) | (lN < L && lE < L && lNE < L ? 2 : 0) |
          (lS < L && lE < L && lSE < L ? 4 : 0) | (lS < L && lW < L && lSW < L ? 8 : 0);
        topMaskF = cut ? get(`wm:${shapeOf(g)}:${cut}`)?.[0] ?? null : null;
        if (topMaskF) flip = 0;
        const r = (k: string) => { const f = get(`w:${g}:${k}`)?.[0]; if (f) rims.push(f); };
        if (lN < L) r('e0');
        if (lE < L) r('e1');
        if (lS < L) r('e2');
        if (lW < L) r('e3');
        for (let c = 0; c < 4; c++) if (cut & (1 << c)) r('oc' + c);
        if (lN >= L && lW >= L && lNW < L) r('ic0');
        if (lN >= L && lE >= L && lNE < L) r('ic1');
        if (lS >= L && lE >= L && lSE < L) r('ic2');
        if (lS >= L && lW >= L && lSW < L) r('ic3');
        // wall-foot base piece instead of shader skirting
        const bb = (lN > L ? 1 : 0) | (lE > L ? 2 : 0) | (lW > L ? 4 : 0) | (lN <= L && lW <= L && lNW > L ? 8 : 0) | (lN <= L && lE <= L && lNE > L ? 16 : 0);
        const bf = bb ? get('wb:' + bb)?.[0] : null;
        flags &= ~(FLAG.BEV_N | FLAG.BEV_W | FLAG.BEV_E | AUTO.CUT_NW | AUTO.CUT_NE | AUTO.IN_NW | AUTO.IN_NE | AUTO.SK_N | AUTO.SK_E | AUTO.SK_W | AUTO.SK_NW | AUTO.SK_NE);
        if (bf) inst.push(px, py, P, P, f0.x, f0.y, topMaskF ? topMaskF.x : -1, topMaskF ? topMaskF.y : 0, L / P, x, y, flags | flip | AUTO.BASE, bf.x, bf.y, 1, 1);
        else inst.push(px, py, P, P, f0.x, f0.y, topMaskF ? topMaskF.x : -1, topMaskF ? topMaskF.y : 0, L / P, x, y, flags | flip);
      } else
      inst.push(px, py, P, P, f0.x, f0.y, -1, flags & (FLAG.BEV_N | FLAG.BEV_W | FLAG.BEV_E | AUTO.IN_NW | AUTO.IN_NE) ? cornerR(g) : 0, L / P, x, y, flags | flip);
      // edge blends with higher-priority neighbours on the same level
      if (p.prio >= 0) {
        const nbs: [number, number, number][] = [[x, y - 1, 0], [x + 1, y, 1], [x, y + 1, 2], [x - 1, y, 3]];
        for (const [nx, ny, dir] of nbs) {
          const ng = gAt(nx, ny);
          if (ng === g || ng === T.VOID) continue;
          const q = pal(ng);
          if (lAt(nx, ny) !== L) {
            // surf at the foot of higher land (coasts sit a step below the beach)
            if (p.liquid && !q.liquid && lAt(nx, ny) > L && dir !== 2) {
              const fm = get('fm:' + dir)!;
              const mv = fm[variant(Math.min(x, nx), Math.min(y, ny), seed + 7 + dir, fm.length)];
              inst.push(px, py, P, P, mv.x, mv.y, -1, -1, L / P, x, y, FLAG.TINTALL, g === T.LAVA ? 1 : 1, g === T.LAVA ? 0.55 : 1, g === T.LAVA ? 0.2 : 1, 1);
            }
            continue;
          }
          if (p.liquid && !q.liquid) {
            const fm = get('fm:' + dir)!;
            const mv = fm[variant(Math.min(x, nx), Math.min(y, ny), seed + 7 + dir, fm.length)];
            const tint = g === T.LAVA ? lavaTint : [1, 1, 1];
            inst.push(px, py, P, P, mv.x, mv.y, -1, -1, L / P, x, y, FLAG.TINTALL, tint[0], tint[1], tint[2], 1);
            if (q.prio < 0) continue;
          }
          if (q.prio <= p.prio) continue;
          if (p.liquid && q.liquid) continue;
          const ngl = get('g:' + ng);
          const mk = get('m:' + dir);
          if (!ngl || !mk) continue;
          const nf = ngl[variant(nx, ny, seed + ng, ngl.length)];
          const mv = mk[variant(Math.min(x, nx), Math.min(y, ny), seed + 3 + dir, mk.length)];
          inst.push(px, py, P, P, nf.x, nf.y, mv.x, mv.y, L / P, x, y, flags & ~(AUTO.CUT_NW | AUTO.CUT_NE));
        }
        // outer corners: a diagonal neighbour of higher priority whose two orthogonal neighbours are not it
        const cns: [number, number, number][] = [[-1, -1, 0], [1, -1, 1], [1, 1, 2], [-1, 1, 3]];
        for (const [dx, dy, c] of cns) {
          const ng = gAt(x + dx, y + dy);
          const og = gAt(x + dx, y);
          if (og !== g && og !== T.VOID && og === gAt(x, y + dy) && pal(og).prio > p.prio && !(p.liquid && pal(og).liquid) && lAt(x + dx, y) === L && lAt(x, y + dy) === L) {
            // inner corner: two edges of the same neighbour meet; fill the concave corner
            const ngl = get('g:' + og), mk = get('mi:' + c);
            if (ngl && mk) inst.push(px, py, P, P, ngl[variant(x + dx, y, seed + og, ngl.length)].x, ngl[variant(x + dx, y, seed + og, ngl.length)].y, mk[0].x, mk[0].y, L / P, x, y, 0);
          }
          if (ng === g || ng === T.VOID || gAt(x + dx, y) === ng || gAt(x, y + dy) === ng) continue;
          const q = pal(ng);
          if (q.prio <= p.prio || (p.liquid && q.liquid) || lAt(x + dx, y + dy) !== L || lAt(x + dx, y) !== L || lAt(x, y + dy) !== L) continue;
          const ngl = get('g:' + ng), mk = get('mc:' + c);
          if (!ngl || !mk) continue;
          const nf = ngl[variant(x + dx, y + dy, seed + ng, ngl.length)];
          const mv = mk[variant(x, y, seed + 5 + c, mk.length)];
          inst.push(px, py, P, P, nf.x, nf.y, mv.x, mv.y, L / P, x, y, flags & ~(AUTO.CUT_NW | AUTO.CUT_NE));
        }
      }
      for (const rf of rims) inst.push(px, py, P, P, rf.x, rf.y, topMaskF ? topMaskF.x : -1, topMaskF ? topMaskF.y : 0, L / P, x, y, 0);
      // foam where a waterfall lands (the water tile north of this one is higher)
      if (g === T.WATER && gAt(x, y - 1) === T.WATER && lAt(x, y - 1) > L) {
        const fm = get('fm:0');
        if (fm) {
          const mv = fm[variant(x, y, seed + 21, fm.length)];
          inst.push(px, py, P, P, mv.x, mv.y, -1, -1, L / P, x, y, FLAG.TINTALL, 1, 1, 1, 1);
        }
      }
      // cliff face below
      const LS = lAt(x, y + 1);
      if (sloped) {
        // everything this tile's sloped sides can project to: from its top row at full lift down
        // to its bottom row at the lift of the lowest ground around it
        let low = L;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || (lay.kind![yy * w + xx] & 3) === KIND.VOID) continue;
          low = Math.min(low, liftPx[yy * w + xx]);
        }
        const fl = get('f:' + g)!;
        const ff = fl[variant(x, y, seed + 11, fl.length)];
        inst.push(px, py, P, P + L - low, ff.x, ff.y, -3, 1, L / P, x, y, 0, low, 1, 1, 1);
      }
      const southVoid = gAt(x, y + 1) === T.VOID;
      // open sea at the map's bottom edge continues past it (no cut face)
      if (LS < L && (!sloped || southVoid) && !(dim.kind === 'overworld' && y + 1 >= h)) {
        const fl = get('f:' + g);
        if (art && !p.liquid && get(`wf:${g}:pp`)) {
          const end = (side: number) => {
            const lx = lAt(x + side, y), ld = lAt(x + side, y + 1);
            if (lx < L && ld < L) return 'o';
            if (lx >= L && ld >= L) return 'i';
            return 'p';
          };
          const eL = end(-1), eR = end(1);
          if (eL === 'o' || eR === 'o') {
            // ground behind the receding corner columns: the lower ground in front of the face
            const gs = gAt(x, y + 1) !== T.VOID ? gAt(x, y + 1) : g, gls = get('g:' + gs);
            if (gls) {
              const gf = gls[variant(x, y + 1, seed + gs, gls.length)];
              for (let o = 0; o < L - LS; o += P) inst.push(px, py + P + o, P, Math.min(P, L - LS - o), gf.x, gf.y, -1, 0, LS / P, x, y + 1, 0);
            }
          }
          const wf = get(`wf:${g}:${eL}${eR}`)![0];
          inst.push(px, py + P - FACE_OFF, P, L - LS + FACE_OFF, wf.x, wf.y, -1, -1, (L + FACE_OFF) / P, x, y, FLAG.FACE);
        } else if (fl) {
          const ff = fl[variant(x, y, seed + 11, fl.length)];
          // face end returns: lit west end, dark east end where the neighbouring face is not as tall
          const ff2 = FLAG.FACE | (lW < L && !(lAt(x - 1, y + 1) >= L) ? AUTO.FACE_L : 0) | (lE < L && !(lAt(x + 1, y + 1) >= L) ? AUTO.FACE_R : 0);
          inst.push(px, py + P, P, L - LS, ff.x, ff.y, -1, -1, L / P, x, y, ff2);
        }
      }
    }
    // props of this row
    for (let x = rx0; x < rx1; x++) {
      const i = y * w + x;
      const d = deco[i];
      if (ground[i] === T.VOID) continue;
      const L = liftPx[i];
      // standing props are per-frame sprite instances (props.ts); only flat decals stay in the chunk
      if (d && DECAL.has(d)) {
        const dl = get('d:' + d);
        if (dl) inst.sprite(dl[variant(x, y, seed + d * 7, dl.length)], x, y, x, y, L, top);
      }
      // bridge rails on plank tiles spanning water
      if (ground[i] === T.PLANK && dim.kind !== 'interior') {
        const wet = (xx: number, yy: number) => { const gg = gAt(xx, yy); return gg === T.WATER || gg === T.DEEP || gg === T.VOID; };
        const ns = wet(x - 1, y) && wet(x + 1, y), ew = wet(x, y - 1) && wet(x, y + 1);
        const rl = ns || ew ? get(ns ? 'rail:ns' : 'rail:ew') : null;
        if (rl) inst.sprite(rl[0], x, y, x, y, L, top);
      }
      // wall torches on south-facing interior walls
      if (dim.kind === 'interior' && isWallG(ground[i]) && y + 1 < h && !isWallG(ground[i + w]) && ground[i + w] !== T.VOID && (x * 7 + y * 3) % 5 === 0) {
        const tl = get('torch');
        const LS = liftPx[i + w];
        if (tl) {
          const f = tl[0];
          inst.push(x * P - f.ox, top + y * P - LS - f.oy, f.w, f.h, f.x, f.y, -1, -1, LS / P, x, y, 0);
          torches.push([x + 0.5, y + 1.05, LS / P + 0.6]);
        }
      }
    }
  }
  return { inst, torches, windows };
}

/** Wall torches and lit house windows of a whole dimension (world tiles), without building sprites. */
export function staticFeatures(dim: Dimension, lay: Layout): { torches: [number, number, number][]; windows: [number, number, number][] } {
  const { w, h, ground, deco } = dim;
  const torches: [number, number, number][] = [];
  const windows: [number, number, number][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ground[i] === T.VOID) continue;
      if (deco[i] === D.HOUSE) {
        if (y + 1 < h && deco[i + w] === D.HOUSE) continue;
        if (x % 2 === 0) windows.push([x + 0.5, y + 1.1, lay.liftPx[i] / P + 0.4]);
      } else if (dim.kind === 'interior' && isWallG(ground[i]) && y + 1 < h && !isWallG(ground[i + w]) && ground[i + w] !== T.VOID && (x * 7 + y * 3) % 5 === 0) {
        torches.push([x + 0.5, y + 1.05, lay.liftPx[i + w] / P + 0.6]);
      }
    }
  return { torches, windows };
}

// ---------------------------------------------------------------- objects

export function objectKey(o: MapObject, done: boolean, sheet: AssetSheet, dim?: Dimension): string | null {
  const side = o.dir === 'e' || o.dir === 'w';
  let k: string | null = null;
  switch (o.kind) {
    case 'chest': k = 'o:chest'; break;
    case 'npc': k = 'o:npc'; break;
    case 'boss': k = 'o:boss'; break;
    case 'start': k = 'o:start'; break;
    case 'ledge': k = 'o:ledge:' + (o.dir || 's'); break;
    case 'source': {
      const s = `${o.style || ''} ${o.icon || ''} ${o.label || ''} ${o.sourceId || ''}`.toLowerCase();
      k = /pot|jar|urn|vase/.test(s) ? 'o:src:pot' : /grass|bush|tuft/.test(s) ? 'o:src:grass' : 'o:src:flower';
      break;
    }
    case 'stairs':
    case 'entrance': {
      const st = o.kind === 'stairs' && !(o.style || '').startsWith('stairs') ? 'stairs-down' : o.style || 'house';
      k = 'o:ent:' + st;
      if (st === 'dock') k += ':' + (o.dir || 's');
      if (!sheet.frames.has(k)) k = 'o:ent:house';
      break;
    }
    case 'gate': {
      const g = o.gate || 'open';
      if (g === 'open') {
        // open archway: lintel, with jambs where the wall continues beside it
        if (!dim) return null;
        const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < dim.w && y < dim.h && isWallG(dim.ground[y * dim.w + x]);
        const a = side ? wall(o.x, o.y - 1) : wall(o.x - 1, o.y), b = side ? wall(o.x, o.y + 1) : wall(o.x + 1, o.y);
        k = 'o:arch:' + ((a ? 1 : 0) | (b ? 2 : 0));
        if (side && sheet.frames.has(k + ':side')) k += ':side';
        return sheet.frames.has(k) ? k : null;
      }
      if ((g as string) === 'waterfall') k = 'o:wf:' + (o.dir || 's') + (o.style === 'ladder' ? ':ladder' : '');
      else if (g === 'ledge') k = 'o:ledge:' + (o.dir || 's');
      else if (g === 'guard') k = 'o:guard';
      else if (g === 'stairs') k = 'o:ent:stairs-down';
      else k = 'o:gate:' + g;
      break;
    }
  }
  if (!k) return null;
  if (done && sheet.frames.has(k + ':done')) k += ':done';
  if (side && sheet.frames.has(k + ':side')) k += ':side';
  return sheet.frames.has(k) ? k : null;
}

/** Entrance styles drawn into the wall behind them (house front / cliff face). */
export function wallStyle(o: MapObject, key: string): boolean {
  if (key.endsWith(':side') || key.startsWith('o:arch:')) return false;
  if (o.kind === 'gate') return o.gate === 'cracked';
  return key.startsWith('o:ent:') && !/stairs|beanstalk|exit/.test(key);
}
