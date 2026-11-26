// The shape of the terrain: how high every point of every tile is. ONE model, used by the
// renderer (which draws it, and has a GLSL twin of `surface` in render/lit/shaders.ts), by the
// tile checker, by the generator when it places things, and by the game. If the picture and the
// rules ever disagree about where a wall face is, it is a bug in whoever is not using this file.
//
// Raised ground is not a box. Toward lower ground it slopes, with a run that depends on the
// side; under the game's projection (a point at height z is drawn z further up the screen)
// that makes every wall of a room show a face. See "Walls seen from every side" in the README.
import { T, type Dimension, type DimKind } from './types';

export const isWallG = (g: number): boolean => g === T.WALL || g === T.CAVEWALL;
/** walls stand this much taller than their level says, so rooms read as solid blocks */
export const WALL_BOOST = 0.6;
/** px of lift per level (a tile is 16 px) */
export const LIFT_PX = 6.4;

/** Height of a tile in levels as drawn: its level, plus the boost for wall material. */
export const veAt = (dim: Dimension, i: number): number => dim.elev[i] + (isWallG(dim.ground[i]) ? WALL_BOOST : 0);
export const liftOf = (ve: number): number => Math.round(ve * LIFT_PX);
/** Lift of a tile's top in px. */
export const liftAt = (dim: Dimension, i: number): number => liftOf(veAt(dim, i));

// ---------------------------------------------------------------- wall patterns
/** How raised ground shows its sides on a kind of map. */
export type WallMode = 'room' | 'outdoor';
export const WALL_MODE: Record<DimKind, WallMode> = { overworld: 'outdoor', sky: 'outdoor', underworld: 'room', interior: 'room' };

/**
 * (sBase, sK, eN, eEW) in px. Toward lower ground to the south the run is max(0, sBase - sK * dL),
 * to the north eN + dL, sideways eEW, where dL is the height of the step in px.
 */
export type WallPattern = [number, number, number, number];
export interface WallPatterns { main: WallPattern; lip: WallPattern }
/** Face sizes in px (a tile is 16). */
export interface WallShape { room: number; south: number; north: number; side: number; lip: number }
export const DEFAULT_WALLS: WallShape = { room: 14, south: 10, north: 6, side: 7, lip: 1.5 };

/**
 * Three ways a wall shows its sides:
 *  1 "room": all four faces about equally wide (dungeons, caves, the underworld);
 *  2 "outdoor": the face that looks south is tall, the other three are narrow;
 *  3 "lip": the face that looks south as in the map's own pattern, the others a thin bevel.
 * Every map has pattern 1 or 2; a tile can ask for the lip, and steps down to water use it.
 */
export function patternsFor(kind: DimKind, s: WallShape = DEFAULT_WALLS): WallPatterns {
  const main: WallPattern = WALL_MODE[kind] === 'room' ? [s.room, 1, s.room, s.room] : [s.south, 0, s.north, s.side];
  return { main, lip: [main[0], main[1], s.lip, s.lip] };
}

// ---------------------------------------------------------------- tile kinds
export const KIND = { GROUND: 0, VOID: 1, LIQUID: 2, LIP: 4, SLOPED: 8 } as const;
export const isLiquidG = (g: number): boolean => g === T.WATER || g === T.DEEP || g === T.LAVA;
/** What a tile is for the shape: ground, nothing, liquid; plus the lip flag. */
export const kindAt = (dim: Dimension, i: number): number =>
  dim.ground[i] === T.VOID ? KIND.VOID : isLiquidG(dim.ground[i]) ? KIND.LIQUID : dim.lip?.[i] ? KIND.LIP : KIND.GROUND;

/** Per tile: its kind, and whether it has lower ground within reach of a slope (precomputed for drawing). */
export function tileKinds(dim: Dimension, liftPx: ArrayLike<number>): Uint8Array {
  const { w, h } = dim, n = w * h;
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) kind[i] = kindAt(dim, i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (kind[i] & 3) continue;
    let sloped = false;
    for (let dy = -2; dy <= 2 && !sloped; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if ((kind[j] & 3) !== KIND.VOID && liftPx[j] < liftPx[i]) { sloped = true; break; }
    }
    if (sloped) kind[i] |= KIND.SLOPED;
  }
  return kind;
}

// ---------------------------------------------------------------- the surface
/**
 * Lift in px of the surface at point (px, py) of tile (x, y), px and py in 0..16.
 * `lift` and `kind` say what each tile is; nothing else is looked at.
 */
export function surface(
  w: number, h: number, lift: (j: number) => number, kind: (j: number) => number, pat: WallPatterns,
  x: number, y: number, px: number, py: number,
): number {
  const i = y * w + x, L = lift(i), K = kind(i);
  if (K & 3) return L; // liquid and nothing have no sides
  const lip = (K & KIND.LIP) !== 0;
  let out = L;
  for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) {
    if (!j && !k) continue;
    const xx = x + k, yy = y + j;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const q = yy * w + xx, kq = kind(q) & 3;
    if (kq === KIND.VOID) continue;
    const Lq = lift(q);
    if (Lq >= L) continue;
    const dL = L - Lq;
    const W = lip || kq === KIND.LIQUID ? pat.lip : pat.main;
    const gx = Math.max(k * 16 - px, px - (k * 16 + 16), 0), gy = Math.max(j * 16 - py, py - (j * 16 + 16), 0);
    const rx = W[3], ry = Math.min(32, j > 0 ? Math.max(0, W[0] - W[1] * dL) : W[2] + dL);
    const dx = gx <= 0 ? 0 : rx < 0.25 ? 9 : gx / rx, dy = gy <= 0 ? 0 : ry < 0.25 ? 9 : gy / ry;
    out = Math.min(out, Lq + dL * Math.min(Math.max(dx, dy), 1));
  }
  return out;
}

/** The same from precomputed arrays (what the renderer has). */
export function surfacePx(dim: Dimension, liftPx: ArrayLike<number>, kind: Uint8Array, pat: WallPatterns, x: number, y: number, px: number, py: number): number {
  const i = y * dim.w + x;
  if (!(kind[i] & KIND.SLOPED)) return liftPx[i];
  return surface(dim.w, dim.h, (j) => liftPx[j], (j) => kind[j], pat, x, y, px, py);
}

/** The same straight from a map, at the game's own face sizes: for rules, placement and checks. */
export function surfaceAt(dim: Dimension, i: number, px: number, py: number): number {
  return surface(dim.w, dim.h, (j) => liftAt(dim, j), (j) => kindAt(dim, j), GAME_WALLS[dim.kind], i % dim.w, (i / dim.w) | 0, px, py);
}
const GAME_WALLS: Record<DimKind, WallPatterns> = {
  overworld: patternsFor('overworld'), sky: patternsFor('sky'), underworld: patternsFor('underworld'), interior: patternsFor('interior'),
};

/** Where things stand on a tile: its middle and halfway to each side. */
const FOOTPRINT: [number, number][] = [[8, 8], [4, 8], [12, 8], [8, 4], [8, 12]];
/** Is the tile level where something would stand on it: no face under its middle or its sides? */
export function levelAt(dim: Dimension, i: number): boolean {
  if (kindAt(dim, i) & 3) return true;
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  // most tiles have nothing lower within reach of a slope: those are level without looking closer
  let lower = false;
  for (let dy = -2; dy <= 2 && !lower; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const j = yy * w + xx;
    if (dim.ground[j] !== T.VOID && liftAt(dim, j) < L) { lower = true; break; }
  }
  return !lower || FOOTPRINT.every(([px, py]) => surfaceAt(dim, i, px, py) >= L - 0.5);
}

/** Does the tile show a face at all: is anything beside it lower? */
export function facedAt(dim: Dimension, i: number): boolean {
  if (kindAt(dim, i) & 3) return false;
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const j = yy * w + xx;
    if ((kindAt(dim, j) & 3) !== KIND.VOID && liftAt(dim, j) < L) return true;
  }
  return false;
}
