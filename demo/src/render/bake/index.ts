// Builds the default AssetSheet by software-rendering every model once.
//
// ASSET KEYS (each maps to 1..n variants; a drop-in sheet must provide the same keys):
//   g:<T>          ground top, 16x16, pivot (0,0)                       e.g. g:1 = grass
//   f:<T>          cliff face strip below a tile of ground T, 16x48     (rows are used from the top)
//   m:<dir>        edge blend mask (albedo alpha), dir 0..3 = N E S W
//   fm:<dir>       shore foam mask (albedo = foam colour)
//   mi:<corner>    inner-corner blend mask: fills the concave corner where two edges of one neighbour meet
//   Raised edges (corner textures; the composer picks them from the 8 neighbours):
//   wm:<shape>:<bits>  top silhouette mask, shape round|chamfer|rock, bits 1 NW 2 NE 4 SE 8 SW = corner cut away
//   w:<T>:e<0-3>       rim along a straight exposed edge N E S W of a raised top of ground T
//   w:<T>:oc<0-3>      outer-corner rim following the cut corner (0 NW 1 NE 2 SE 3 SW)
//   w:<T>:ic<0-3>      inner-corner rim (the edge turning a concave corner)
//   wf:<T>:<L><R>      south face, 16 x 51, pivot oy 3; ends p = continues, o = outer corner (columns recede
//                      and rise to follow the cut top corner), i = inner corner crease
//   wb:<bits>          wall-foot base: albedo multiplier on the ground at the foot of higher ground,
//                      bits 1 N 2 E 4 W 8 NW 16 NE (white = unchanged)
//   A sheet without wm: keys falls back to shader-drawn rims.
//   mc:<corner>    corner blend mask (albedo alpha), corner 0..3 = NW NE SE SW: a diagonal neighbour of higher
//                  priority bleeds into this corner (outer corners of grass around a path, sand around a pond...)
//   Raised edges (wall / cave wall / cliff tops and faces) are autotiled in the sprite shader from per-instance
//   neighbour flags (see lit/compose.ts AUTO): rims and coping on exposed edges, rounded (cave, cliff) or
//   chamfered (wall) outer corners, lit inner corners, face end returns, and contact skirting on the ground at
//   a wall foot. A sheet with hand-drawn blob pieces could replace them by adding `w:<mat>:<mask47>` keys.
//   d:<D>          deco prop, pivot = tile NW ground corner             d:2:snow, d:8:glow variants
//   hp:<wall>:<floors>:<mask>  modular building piece (wall plaster|stone, floors 1|2, mask = N1 E2 S4 W8 neighbours in the footprint)
//   characters (enemies, NPCs, player) live in a second, progressively baked sheet: see charAtlas.ts
//   o:<...>        objects: o:chest, o:chest:done, o:gate:<kind>[:done], o:ent:<style>, o:npc,
//                  o:guard, o:start, o:boss, o:src:<pot|grass|flower>, o:ledge:<n|e|s|w>
//   torch          wall torch for interiors
import { D, T } from '../../core/types';
import { EDGE_GROUNDS, basePiece, cornerMask, edgeMask, facePiece, faceStrip, groundTile, innerMask, rimPiece, topMask, type Shape } from './ground';
import { DECO_VARIANTS, WALL_KINDS, decoModel, housePiece, objectModels } from './models';
import { renderModel } from './sdf';
import { type AssetSheet, type Frame, Sprite, packSheet } from './sheet';


export { type AssetSheet, type Frame, MAT, TILE_PX, ELEV_PX, HEIGHT_OFF, HEIGHT_SCALE } from './sheet';
export { CRYSTAL_LIGHT } from './models';

/** model sprites that are composed into the terrain chunks, at the terrain's resolution */
const STATIC_KEYS = /^(torch|rail:)/;
const DECAL_KEYS = new RegExp(`^d:(${D.TUFT}|${D.FLOWER})$`);
const cachedAt = new Map<number, AssetSheet>();
export let lastBakeMs = 0;
/** total time spent baking sprites on demand */
export let deferredBakeMs = 0;

/**
 * The terrain's own sheet: ground tiles, faces, masks, rims, flat decals, and the few model
 * sprites the terrain composes in (torches, bridge rails). Baked once, at the tile grid's
 * resolution. It also holds every prop once at that resolution: the far-zoom overview takes
 * its colours from there.
 */
export function bakeAtlas(scale = 1): AssetSheet {
  const had = cachedAt.get(scale);
  if (had) return had;
  const t0 = performance.now();
  const sprites = new Map<string, Sprite[]>();
  const put = (k: string, s: Sprite) => {
    let l = sprites.get(k);
    if (!l) sprites.set(k, (l = []));
    l.push(s);
  };
  const grounds = Object.values(T).filter((g) => g !== T.VOID);
  for (const g of grounds) {
    for (let v = 0; v < 4; v++) put('g:' + g, groundTile(g, v, scale));
    for (let v = 0; v < 2; v++) put('f:' + g, faceStrip(g, v, scale));
  }
  for (let dir = 0; dir < 4; dir++)
    for (let v = 0; v < 3; v++) {
      put('m:' + dir, edgeMask(dir, v, false, scale));
      put('fm:' + dir, edgeMask(dir, v, true, scale));
      put('mc:' + dir, cornerMask(dir, v, scale));
    }
  for (let c = 0; c < 4; c++) put('mi:' + c, innerMask(c, scale));
  // dg:<corner>  the half of a tile toward a corner (0 NE, 1 SE, 2 SW, 3 NW): where ground of one
  //              kind ends in a 45 degree line against another kind on the same level
  for (let c = 0; c < 4; c++) {
    const N = 16 * scale, m = new Sprite(N, N, 0, 0);
    m.scale = scale;
    const cx = c < 2 ? N : 0, cy = c === 1 || c === 2 ? N : 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.abs(x + 0.5 - cx) + Math.abs(y + 0.5 - cy) < N) m.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
    put('dg:' + c, m);
  }
  for (const shape of ['round', 'chamfer', 'rock'] as Shape[]) for (let bits = 0; bits < 16; bits++) put(`wm:${shape}:${bits}`, topMask(shape, bits, scale));
  for (const g of EDGE_GROUNDS) {
    for (let i = 0; i < 4; i++) { put(`w:${g}:e${i}`, rimPiece(g, 'e', i, scale)); put(`w:${g}:oc${i}`, rimPiece(g, 'oc', i, scale)); put(`w:${g}:ic${i}`, rimPiece(g, 'ic', i, scale)); }
    for (const L of ['p', 'o', 'i']) for (const R of ['p', 'o', 'i']) put(`wf:${g}:${L}${R}`, facePiece(g, 0, L, R, scale));
  }
  for (let bits = 0; bits < 32; bits++) put('wb:' + bits, basePiece(bits, scale));
  // flat decals and the terrain's own model pieces are drawn into it, so they share its resolution;
  // the standing props are only here for their colours
  for (const [key, list] of propMakers()) list.forEach((make) => put(key, make(DECAL_KEYS.test(key) ? scale : 1)));
  for (const o of objectModels()) if (STATIC_KEYS.test(o.key)) put(o.key, renderModel(o.model, o.key.length, scale));
  // 1 px checkerboard test sprite (d:255): verifies that every source pixel is drawn the same size
  const chk = new Sprite(16, 16, 0, 0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) chk.set(x, y, (x + y) & 1 ? [250, 250, 250] : [10, 10, 10], 0, 0, 1, 0, null, 0);
  put('d:255', chk);
  // room is kept for the wall tiles, which are baked as the map shows them (bake/walls.ts)
  const sheet = packSheet(sprites, Math.min(8192, 1024 * scale), 1024, 12 * 16 * scale);
  cachedAt.set(scale, sheet);
  lastBakeMs = performance.now() - t0;
  return sheet;
}

// ---------------------------------------------------------------- standing sprites, on demand
// Trees, props, objects and buildings live in a sheet of their own, at whatever resolution is
// asked for, and each is baked the first time something on screen needs it. Nothing is baked
// that is not used, so the resolution can be as high as the models are worth.

type Maker = (scale: number) => Sprite;
let makersCache: Map<string, Maker[]> | null = null;
function propMakers(): Map<string, Maker[]> {
  const m = new Map<string, Maker[]>();
  const add = (k: string, f: Maker) => { const l = m.get(k); if (l) l.push(f); else m.set(k, [f]); };
  for (const [ds, n] of Object.entries(DECO_VARIANTS)) {
    const d = Number(ds);
    for (let v = 0; v < n; v++) { const model = decoModel(d, v); if (model) add('d:' + d, (sc) => renderModel(model, v + d * 7, sc)); }
  }
  for (let v = 0; v < 2; v++) add('d:' + D.PINE + ':snow', (sc) => renderModel(decoModel(D.PINE, v, { snow: true })!, v + 3, sc));
  for (let v = 0; v < 3; v++) add('d:' + D.MUSHROOM + ':glow', (sc) => renderModel(decoModel(D.MUSHROOM, v, { glow: true })!, v + 5, sc));
  return m;
}
function makers(): Map<string, Maker[]> {
  if (makersCache) return makersCache;
  const m = propMakers();
  for (const o of objectModels()) if (!STATIC_KEYS.test(o.key)) m.set(o.key, [(sc) => renderModel(o.model, o.key.length, sc)]);
  for (const wall of WALL_KINDS) for (let floors = 1; floors <= 2; floors++) for (let mask = 0; mask < 16; mask++)
    m.set(`hp:${wall}:${floors}:${mask}`, [(sc) => renderModel(housePiece(mask, floors, wall), mask + floors * 16, sc)]);
  return (makersCache = m);
}

/** Bake scales on offer: texels per px of the tile grid (1 = 16 texels per tile, 8 = 128). */
export const SPRITE_SCALES = [1, 2, 4, 8];
export interface SpriteUpload { x: number; y: number; sprite: Sprite }
export interface SpriteSheet {
  w: number;
  h: number;
  /** texels per px every sprite in this sheet is baked at */
  scale: number;
  /** frames of the sprites baked so far (a key appears once all its variants are in) */
  frames: Map<string, Frame[]>;
  /** what `frames` will hold once asked for */
  has: (key: string) => boolean;
  /** the frames of a sprite if it is baked; otherwise it is queued and null comes back */
  want: (key: string) => Frame[] | null;
  /** sprites baked since the last look, to be uploaded */
  uploads: SpriteUpload[];
  cursor: { x: number; y: number; rowH: number };
  queue: string[];
  full: boolean;
}

let sprites: SpriteSheet | null = null;
/** The sheet of standing sprites at `pxPerTile` (rounded up to a scale on offer), made anew when that changes. */
export function spriteSheet(pxPerTile: number, maxTex: number): SpriteSheet {
  const scale = SPRITE_SCALES.find((v) => v * 16 >= pxPerTile) ?? SPRITE_SCALES[SPRITE_SCALES.length - 1];
  if (sprites && sprites.scale === scale) return sprites;
  // room for a world's worth of sprites at this scale, within what the GPU takes
  const side = Math.min(maxTex, scale <= 1 ? 2048 : scale <= 2 ? 4096 : 8192);
  const all = makers();
  const sh: SpriteSheet = {
    w: side, h: side, scale, frames: new Map(), uploads: [], cursor: { x: 0, y: 0, rowH: 0 }, queue: [], full: false,
    has: (key) => all.has(key),
    want: (key) => {
      const got = sh.frames.get(key);
      if (got) return got;
      if (all.has(key) && !sh.queue.includes(key)) sh.queue.push(key);
      return null;
    },
  };
  return (sprites = sh);
}

/** Bake queued sprites for up to `budgetMs` (always at least one); true while work remains. */
export function bakeStep(budgetMs: number): boolean {
  const sh = sprites;
  if (!sh || !sh.queue.length || sh.full) return false;
  const t0 = performance.now();
  do {
    const key = sh.queue.shift()!;
    const list: Frame[] = [];
    for (const make of makers().get(key)!) {
      const s = make(sh.scale), c = sh.cursor;
      if (c.x + s.w + 1 > sh.w) { c.x = 0; c.y += c.rowH + 1; c.rowH = 0; }
      if (c.y + s.h > sh.h) { sh.full = true; console.warn('sprite sheet full at', sh.scale * 16, 'px per tile'); break; }
      list.push({ x: c.x, y: c.y, w: s.w / s.scale, h: s.h / s.scale, ox: s.ox / s.scale, oy: s.oy / s.scale, ty: s.ty / s.scale, s: s.scale });
      sh.uploads.push({ x: c.x, y: c.y, sprite: s });
      c.x += s.w + 1;
      c.rowH = Math.max(c.rowH, s.h);
    }
    if (!sh.full) sh.frames.set(key, list);
  } while (sh.queue.length && !sh.full && performance.now() - t0 < budgetMs);
  deferredBakeMs += performance.now() - t0;
  return sh.queue.length > 0;
}
export const bakePending = () => sprites?.queue.length ?? 0;

/** Replace the procedural sheet (e.g. with real pre-rendered sprites). Call before the first render. */
export function setAssetSheet(sheet: AssetSheet) {
  cachedAt.set(1, sheet);
}
