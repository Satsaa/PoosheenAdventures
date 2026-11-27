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
import { type AssetSheet, SPRITE_SCALE, Sprite, addToSheet, packSheet } from './sheet';

/** flat props that are composed into the terrain (the same set render/props.ts draws as decals) */
const DECAL = new Set<number>([D.TUFT, D.FLOWER]);

export { type AssetSheet, type Frame, MAT, TILE_PX, ELEV_PX, HEIGHT_OFF, HEIGHT_SCALE } from './sheet';
export { CRYSTAL_LIGHT } from './models';

/** model sprites that are composed into the terrain chunks, at the terrain's resolution */
const STATIC_KEYS = /^(torch|rail:)/;
let cached: AssetSheet | null = null;
export let lastBakeMs = 0;
/** total time spent in progressive bake steps */
export let deferredBakeMs = 0;
const deferred: [string, () => Sprite][] = [];

/** Bake queued sprites for up to `budgetMs` into the sheet's free space; true while work remains. */
export function bakeStep(budgetMs: number): boolean {
  if (!cached || !deferred.length) return false;
  const t0 = performance.now();
  while (deferred.length && performance.now() - t0 < budgetMs) {
    const [key, make] = deferred.shift()!;
    if (!addToSheet(cached, key, make())) { deferred.length = 0; console.warn('asset sheet full'); }
  }
  deferredBakeMs += performance.now() - t0;
  return deferred.length > 0;
}
export const bakePending = () => deferred.length;

export function bakeAtlas(): AssetSheet {
  if (cached) return cached;
  const t0 = performance.now();
  const sprites = new Map<string, Sprite[]>();
  const put = (k: string, s: Sprite) => {
    let l = sprites.get(k);
    if (!l) sprites.set(k, (l = []));
    l.push(s);
  };
  const grounds = Object.values(T).filter((g) => g !== T.VOID);
  for (const g of grounds) {
    for (let v = 0; v < 4; v++) put('g:' + g, groundTile(g, v));
    for (let v = 0; v < 2; v++) put('f:' + g, faceStrip(g, v));
  }
  for (let dir = 0; dir < 4; dir++)
    for (let v = 0; v < 3; v++) {
      put('m:' + dir, edgeMask(dir, v, false));
      put('fm:' + dir, edgeMask(dir, v, true));
      put('mc:' + dir, cornerMask(dir, v));
    }
  for (let c = 0; c < 4; c++) put('mi:' + c, innerMask(c));
  for (const shape of ['round', 'chamfer', 'rock'] as Shape[]) for (let bits = 0; bits < 16; bits++) put(`wm:${shape}:${bits}`, topMask(shape, bits));
  for (const g of EDGE_GROUNDS) {
    for (let i = 0; i < 4; i++) { put(`w:${g}:e${i}`, rimPiece(g, 'e', i)); put(`w:${g}:oc${i}`, rimPiece(g, 'oc', i)); put(`w:${g}:ic${i}`, rimPiece(g, 'ic', i)); }
    for (const L of ['p', 'o', 'i']) for (const R of ['p', 'o', 'i']) put(`wf:${g}:${L}${R}`, facePiece(g, 0, L, R));
  }
  for (let bits = 0; bits < 32; bits++) put('wb:' + bits, basePiece(bits));
  for (const [ds, n] of Object.entries(DECO_VARIANTS)) {
    const d = Number(ds);
    for (let v = 0; v < n; v++) {
      const m = decoModel(d, v);
      // flat decals are composed into the terrain at its own resolution; everything standing is baked finer
      if (m) put('d:' + d, renderModel(m, v + d * 7, DECAL.has(d) ? 1 : SPRITE_SCALE));
    }
  }
  for (let v = 0; v < 2; v++) put('d:' + D.PINE + ':snow', renderModel(decoModel(D.PINE, v, { snow: true })!, v + 3, SPRITE_SCALE));
  for (let v = 0; v < 3; v++) put('d:' + D.MUSHROOM + ':glow', renderModel(decoModel(D.MUSHROOM, v, { glow: true })!, v + 5, SPRITE_SCALE));
  // 1 px checkerboard test sprite (d:255): verifies that every source pixel is drawn the same size
  const chk = new Sprite(16, 16, 0, 0);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) chk.set(x, y, (x + y) & 1 ? [250, 250, 250] : [10, 10, 10], 0, 0, 1, 0, null, 0);
  put('d:255', chk);
  cached = packSheet(sprites, 2048, 2048);
  // objects and building pieces are baked progressively after the first frame (bakeStep)
  for (const o of objectModels()) deferred.push([o.key, () => renderModel(o.model, o.key.length, STATIC_KEYS.test(o.key) ? 1 : SPRITE_SCALE)]);
  for (const wall of WALL_KINDS) for (let floors = 1; floors <= 2; floors++) for (let mask = 0; mask < 16; mask++)
    deferred.push([`hp:${wall}:${floors}:${mask}`, () => renderModel(housePiece(mask, floors, wall), mask + floors * 16, SPRITE_SCALE)]);
  lastBakeMs = performance.now() - t0;
  return cached;
}

/** Replace the procedural sheet (e.g. with real pre-rendered sprites). Call before the first render. */
export function setAssetSheet(sheet: AssetSheet) {
  cached = sheet;
}
