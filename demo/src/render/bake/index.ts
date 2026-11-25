// Builds the default AssetSheet by software-rendering every model once.
//
// ASSET KEYS (each maps to 1..n variants; a drop-in sheet must provide the same keys):
//   g:<T>          ground top, 16x16, pivot (0,0)                       e.g. g:1 = grass
//   f:<T>          cliff face strip below a tile of ground T, 16x48     (rows are used from the top)
//   m:<dir>        edge blend mask (albedo alpha), dir 0..3 = N E S W
//   fm:<dir>       shore foam mask (albedo = foam colour)
//   d:<D>          deco prop, pivot = tile NW ground corner             d:2:snow, d:8:glow variants
//   h:<depth>:<c>  house column (depth 1..3 tiles, c 0 west,1 mid,2 east,3 single)
//   o:<...>        objects: o:chest, o:chest:done, o:gate:<kind>[:done], o:ent:<style>, o:npc,
//                  o:guard, o:start, o:boss, o:src:<pot|grass|flower>, o:ledge:<n|e|s|w>
//   torch          wall torch for interiors
import { D, T } from '../../core/types';
import { edgeMask, faceStrip, groundTile } from './ground';
import { DECO_VARIANTS, decoModel, houseModel, objectModels } from './models';
import { renderModel } from './sdf';
import { type AssetSheet, Sprite, packSheet } from './sheet';

export { type AssetSheet, type Frame, MAT, TILE_PX, ELEV_PX, HEIGHT_OFF, HEIGHT_SCALE } from './sheet';
export { CRYSTAL_LIGHT } from './models';

let cached: AssetSheet | null = null;
export let lastBakeMs = 0;

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
    }
  for (const [ds, n] of Object.entries(DECO_VARIANTS)) {
    const d = Number(ds);
    for (let v = 0; v < n; v++) {
      const m = decoModel(d, v);
      if (m) put('d:' + d, renderModel(m, v + d * 7));
    }
  }
  for (let v = 0; v < 2; v++) put('d:' + D.PINE + ':snow', renderModel(decoModel(D.PINE, v, { snow: true })!, v + 3));
  for (let v = 0; v < 3; v++) put('d:' + D.MUSHROOM + ':glow', renderModel(decoModel(D.MUSHROOM, v, { glow: true })!, v + 5));
  for (let depth = 1; depth <= 3; depth++) for (let c = 0; c < 4; c++) put(`h:${depth}:${c}`, renderModel(houseModel(depth, c), depth * 4 + c));
  for (const o of objectModels()) put(o.key, renderModel(o.model, o.key.length));
  cached = packSheet(sprites);
  lastBakeMs = performance.now() - t0;
  return cached;
}

/** Replace the procedural sheet (e.g. with real pre-rendered sprites). Call before the first render. */
export function setAssetSheet(sheet: AssetSheet) {
  cached = sheet;
}
