// The asset seam of the lit renderer.
//
// Every visual asset (ground tile, cliff face strip, prop, object) is a sprite with four aligned
// layers, packed into one AssetSheet (atlas). Today the sprites are software-rendered from tiny
// 3D model definitions (./models.ts, ./ground.ts). Later they can be replaced by real pre-rendered
// sprite sheets (e.g. from Blender) with the same layout: provide an AssetSheet with the same keys
// and the renderer does not change.
//
// Layer layout (all RGBA8, same size, same frame rectangles):
//   albedo   : RGB = flat base colour (sRGB), A = coverage (0 = empty, 255 = solid; no AA)
//   normal   : RGB = world-space normal * 0.5 + 0.5 (x = east, y = south, z = up),
//              A = surface height above the tile's ground in tiles, encoded (h + HEIGHT_OFF) * HEIGHT_SCALE
//   emissive : RGB = emitted colour (added after lighting, feeds bloom), A = material id (MAT.*)
//
// Projection: cabinet / 3-4 top-down. A world point (X, Y, Z) in tile units lands on sprite pixel
//   ( (X) * TILE_PX + ox ,  (Y - Z) * TILE_PX + oy )
// where (ox, oy) is the frame pivot = the pixel where the tile's north-west ground corner sits.
// So a 1x1 tile footprint covers pixels [ox, ox+16) x [oy, oy+16) and anything taller rises above it.

export const TILE_PX = 16;
/** pixels per elevation step (0.4 tile), rounded per level when composing */
export const ELEV_PX = TILE_PX * 0.4;
export const HEIGHT_SCALE = 40;
export const HEIGHT_OFF = 1;

export const MAT = {
  DIFFUSE: 0,
  WATER: 1,
  LAVA: 2,
  CLOUD: 3,
  /** crystal, gold, metal: banded specular */
  GLOSS: 4,
  /** leaves, grass: soft wrap lighting */
  FOLIAGE: 5,
  /** albedo is multiplied by the instance tint (NPC clothes) */
  TINT: 6,
  /** falling water: animated streaks scrolling down */
  FALL: 7,
} as const;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** pivot: tile north-west ground corner inside the frame */
  ox: number;
  oy: number;
  /** top-down height map origin row: ground point (gx, gy) tiles -> (x + ox + gx*16, y + ty + gy*16) in the `top` layer */
  ty: number;
}

/** One animation clip of a character: frames per facing direction. */
export interface Clip {
  fps: number;
  /** frame keys per direction, in order s, e, n (west = e mirrored when `mirrorW`) */
  s: string;
  e: string;
  n: string;
  mirrorW: boolean;
  frames: number;
}

export interface AssetSheet {
  w: number;
  h: number;
  albedo: Uint8ClampedArray;
  normal: Uint8ClampedArray;
  emissive: Uint8ClampedArray;
  /** top-down height map (1 byte/px, (height * 40) + 1, 0 = empty) used to cast world-space shadows */
  top: Uint8Array;
  /** key -> variants. Keys are listed in ./index.ts (ASSET_KEYS doc). */
  frames: Map<string, Frame[]>;
  /** character animations: anim key ('c:<kind>') -> clip name ('idle', 'walk') -> clip; each clip's
   *  direction key (e.g. 'c:bat:walk:s') maps in `frames` to its frame list */
  anims: Map<string, Record<string, Clip>>;
  /** progressive baking: shelf cursor for sprites added later, rects changed since the last upload, change counter */
  cursor?: { x: number; y: number; rowH: number };
  dirty?: { x: number; y: number; w: number; h: number }[];
  version?: number;
}

/** Place one more sprite into a sheet's free space (progressive baking). Returns false when full. */
export function addToSheet(sheet: AssetSheet, key: string, s: Sprite): boolean {
  const c = sheet.cursor!;
  if (c.x + s.w + 1 > sheet.w) { c.x = 0; c.y += c.rowH + 1; c.rowH = 0; }
  if (c.y + s.h > sheet.h) return false;
  const px = c.x, py = c.y, W = sheet.w;
  for (let r = 0; r < s.h; r++) {
    const so = r * s.w * 4, d = ((py + r) * W + px) * 4;
    sheet.albedo.set(s.alb.subarray(so, so + s.w * 4), d);
    sheet.normal.set(s.nrm.subarray(so, so + s.w * 4), d);
    sheet.emissive.set(s.emi.subarray(so, so + s.w * 4), d);
    sheet.top.set(s.top.subarray(r * s.w, r * s.w + s.w), (py + r) * W + px);
  }
  c.x += s.w + 1;
  c.rowH = Math.max(c.rowH, s.h);
  let list = sheet.frames.get(key);
  if (!list) sheet.frames.set(key, (list = []));
  list.push({ x: px, y: py, w: s.w, h: s.h, ox: s.ox, oy: s.oy, ty: s.ty });
  sheet.dirty!.push({ x: px, y: py, w: s.w, h: s.h });
  sheet.version = (sheet.version || 0) + 1;
  return true;
}

/** One sprite with its four layers, before packing. */
export class Sprite {
  readonly alb: Uint8ClampedArray;
  readonly nrm: Uint8ClampedArray;
  readonly emi: Uint8ClampedArray;
  readonly top: Uint8Array;
  /** top map ground origin row */
  ty = 0;
  constructor(readonly w: number, readonly h: number, readonly ox: number, readonly oy: number) {
    this.top = new Uint8Array(w * h);
    this.alb = new Uint8ClampedArray(w * h * 4);
    this.nrm = new Uint8ClampedArray(w * h * 4);
    this.emi = new Uint8ClampedArray(w * h * 4);
  }
  set(
    x: number, y: number, rgb: readonly number[], nx: number, ny: number, nz: number, height: number,
    emit: readonly number[] | null, mat: number,
  ) {
    const i = (y * this.w + x) * 4;
    this.alb[i] = rgb[0]; this.alb[i + 1] = rgb[1]; this.alb[i + 2] = rgb[2]; this.alb[i + 3] = 255;
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nrm[i] = (nx / l) * 127.5 + 127.5;
    this.nrm[i + 1] = (ny / l) * 127.5 + 127.5;
    this.nrm[i + 2] = (nz / l) * 127.5 + 127.5;
    this.nrm[i + 3] = Math.round((height + HEIGHT_OFF) * HEIGHT_SCALE);
    if (emit) { this.emi[i] = emit[0]; this.emi[i + 1] = emit[1]; this.emi[i + 2] = emit[2]; }
    else { this.emi[i] = this.emi[i + 1] = this.emi[i + 2] = 0; }
    this.emi[i + 3] = mat;
  }
  /** darken opaque pixels that touch empty ones: a 1 px inner outline that keeps props readable */
  outline(k = 0.55) {
    const { w, h, alb } = this;
    const edge: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!alb[i + 3]) continue;
        const e = (xx: number, yy: number) => xx < 0 || yy < 0 || xx >= w || yy >= h || !alb[(yy * w + xx) * 4 + 3];
        if (e(x - 1, y) || e(x + 1, y) || e(x, y - 1) || e(x, y + 1)) edge.push(i);
      }
    for (const i of edge) { alb[i] *= k; alb[i + 1] *= k; alb[i + 2] *= k * 1.05; }
    return this;
  }
}

/** Shelf-pack sprites into one sheet. */
export function packSheet(sprites: Map<string, Sprite[]>, width = 1024, minH = 1): AssetSheet {
  const items: { key: string; idx: number; s: Sprite }[] = [];
  for (const [key, list] of sprites) list.forEach((s, idx) => items.push({ key, idx, s }));
  items.sort((a, b) => b.s.h - a.s.h || b.s.w - a.s.w);
  let x = 0, y = 0, rowH = 0;
  const pos: [number, number][] = [];
  for (const it of items) {
    if (x + it.s.w + 1 > width) { x = 0; y += rowH + 1; rowH = 0; }
    pos.push([x, y]);
    x += it.s.w + 1;
    rowH = Math.max(rowH, it.s.h);
  }
  let h = 1;
  while (h < Math.max(minH, y + rowH + 1)) h *= 2;
  const albedo = new Uint8ClampedArray(width * h * 4), normal = new Uint8ClampedArray(width * h * 4), emissive = new Uint8ClampedArray(width * h * 4);
  const top = new Uint8Array(width * h);
  const frames = new Map<string, Frame[]>();
  items.forEach((it, k) => {
    const [px, py] = pos[k];
    const { s } = it;
    for (let r = 0; r < s.h; r++) {
      const so = r * s.w * 4, d = ((py + r) * width + px) * 4;
      albedo.set(s.alb.subarray(so, so + s.w * 4), d);
      top.set(s.top.subarray(r * s.w, r * s.w + s.w), (py + r) * width + px);
      normal.set(s.nrm.subarray(so, so + s.w * 4), d);
      emissive.set(s.emi.subarray(so, so + s.w * 4), d);
    }
    let list = frames.get(it.key);
    if (!list) frames.set(it.key, (list = []));
    list[it.idx] = { x: px, y: py, w: s.w, h: s.h, ox: s.ox, oy: s.oy, ty: s.ty };
  });
  return { w: width, h, albedo, normal, emissive, top, frames, anims: new Map(), cursor: { x: 0, y: y + rowH + 1, rowH: 0 }, dirty: [], version: 0 };
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
