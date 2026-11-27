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
/**
 * Land stands this much (in levels; about 3 px) above water and lava of its own level, so every
 * shore has a bank: a short slope from the land down into the liquid.
 */
export const BANK_RISE = 0.5;
/** the run of a bank in px, on every side; short enough that the middle of the tile stays level */
export const BANK_RUN = 4;
/** steps down to liquid of at most this many px are banks on the south side too (taller ones are cliffs there) */
export const BANK_STEP = 4;
/** px of lift per level (a tile is 16 px) */
export const LIFT_PX = 6.4;

/** Height of a tile in levels as drawn: its level, plus the boost for wall material. */
export const veAt = (dim: Dimension, i: number): number =>
  dim.elev[i] + (isWallG(dim.ground[i]) ? WALL_BOOST : 0) + (dim.ground[i] === T.WATER || dim.ground[i] === T.DEEP || dim.ground[i] === T.LAVA ? 0 : BANK_RISE);
export const liftOf = (ve: number): number => Math.round(ve * LIFT_PX);
/** Lift of a tile's top in px. */
export const liftAt = (dim: Dimension, i: number): number => liftOf(veAt(dim, i));

// ---------------------------------------------------------------- wall patterns
/** How raised ground shows its sides on a kind of map. */
export type WallMode = 'room' | 'outdoor';
export const WALL_MODE: Record<DimKind, WallMode> = { overworld: 'outdoor', sky: 'outdoor', underworld: 'room', interior: 'room' };

/**
 * (south, unused, north, sideways): how far into the raised ground each face reaches, in px.
 * A footprint, not a size on screen: it is the same whatever the height of the step.
 */
export type WallPattern = [number, number, number, number];
export interface WallPatterns { main: WallPattern; lip: WallPattern }
/** Face sizes in px (a tile is 16). */
export interface WallShape { room: number; south: number; north: number; side: number; lip: number }
/**
 * THE WALL TABLE. One row per kind of wall; everything else follows from it: how the terrain is
 * shaped and drawn, how deep the generator closes the ground behind a face, how small a raised
 * place may be (its walls plus one tile of top), where corners are cut, and what the checker
 * reports. To add a kind of wall, add a row and name it in `wallStyle` below.
 *   north / south / side: how many tiles each face reaches into the raised ground
 *   corners: 'cut' = outward corners at 45 degrees (a raised place ends up eight-sided),
 *            'square' = left as they are
 * One limit: the depths belong to the kind of map (all walls of a map share them, the drawing
 * reads them once per map); corners can differ from ground to ground.
 */
export interface WallStyle { north: number; south: number; side: number; corners: 'cut' | 'square' }
export const WALL_STYLES = {
  /** cliffs, hills, ramparts under the open sky: one tile on three sides, two looking south */
  outdoor: { north: 1, south: 2, side: 1, corners: 'cut' },
  /** caves and the underworld: two tiles all round, rounded off */
  cave: { north: 2, south: 2, side: 2, corners: 'cut' },
  /** built rooms (dungeons, houses): two tiles all round, rectangular */
  built: { north: 2, south: 2, side: 2, corners: 'square' },
} as const satisfies Record<string, WallStyle>;
/** Which row of the wall table raised ground of this material follows on this kind of map. */
export function wallStyle(kind: DimKind, ground: number): WallStyle {
  if (WALL_MODE[kind] === 'outdoor') return WALL_STYLES.outdoor;
  return ground === T.WALL && kind === 'interior' ? WALL_STYLES.built : WALL_STYLES.cave;
}
export const DEFAULT_WALLS: WallShape = {
  room: WALL_STYLES.cave.south * 16, south: WALL_STYLES.outdoor.south * 16, north: WALL_STYLES.outdoor.north * 16, side: WALL_STYLES.outdoor.side * 16, lip: 1.5,
};

/**
 * Three ways a wall shows its sides:
 *  1 "room": all four faces about equally wide (dungeons, caves, the underworld);
 *  2 "outdoor": the face that looks south is tall, the other three are narrow;
 *  3 "lip": the face that looks south as in the map's own pattern, the others a thin bevel.
 * Every map has pattern 1 or 2; a tile can ask for the lip, and steps down to water use it.
 */
export function patternsFor(kind: DimKind, s: WallShape = DEFAULT_WALLS): WallPatterns {
  const main: WallPattern = WALL_MODE[kind] === 'room' ? [s.room, 0, s.room, s.room] : [s.south, 0, s.north, s.side];
  return { main, lip: [main[0], main[1], s.lip, s.lip] };
}

// ---------------------------------------------------------------- tile kinds
export const KIND = { GROUND: 0, VOID: 1, LIQUID: 2, LIP: 4, SLOPED: 8, WALK: 16, CUT: 32 } as const;
/**
 * Two guarantees of the model, so that no tile can lose its top however faces crowd it:
 *  - a tile that can be walked on is level where things stand on it: no face ever runs across it.
 *    Its only slopes are the banks into water or lava beside it, BANK_RUN wide along that edge;
 *  - where faces rise from both sides of raised ground (a hill, a ridge, a thin wall), their runs
 *    shrink together until at least this much level top is left between them.
 * Both are about shape only: they never change which tiles can be walked on.
 */
export const MIN_TOP = 4;
export const isLiquidG = (g: number): boolean => g === T.WATER || g === T.DEEP || g === T.LAVA;
/** What a tile is for the shape: ground, nothing, liquid; plus the lip flag. */
export const kindAt = (dim: Dimension, i: number): number =>
  dim.ground[i] === T.VOID ? KIND.VOID : isLiquidG(dim.ground[i]) ? KIND.LIQUID : (dim.lip?.[i] ? KIND.LIP : KIND.GROUND) | (dim.solid[i] ? (dim.cut?.[i] ? KIND.CUT : 0) : KIND.WALK);

/** Per tile: its kind, and whether it has lower ground within reach of a slope (precomputed for drawing). */
export function tileKinds(dim: Dimension, liftPx: ArrayLike<number>): Uint8Array {
  const { w, h } = dim, n = w * h;
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) kind[i] = kindAt(dim, i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (kind[i] & 3) continue; // liquid and nothing have no sloped sides
    const walk = (kind[i] & KIND.WALK) !== 0; // walkable ground only banks into liquid right beside it
    const R = walk ? 1 : 2;
    let sloped = false;
    for (let dy = -R; dy <= R && !sloped; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if ((walk ? (kind[j] & 3) === KIND.LIQUID : (kind[j] & 3) !== KIND.VOID) && liftPx[j] < liftPx[i]) { sloped = true; break; }
    }
    if (sloped) kind[i] |= KIND.SLOPED;
  }
  return kind;
}

// ---------------------------------------------------------------- the surface
/** What the model looks at: how high each tile's top is and what kind of tile it is. Nothing else. */
export interface Field {
  w: number;
  h: number;
  lift: (j: number) => number;
  kind: (j: number) => number;
  pat: WallPatterns;
}

/** The run in px of a face of this tile toward a neighbour `dL` px lower, before fitting. */
function runOf(F: Field, lip: boolean, sideways: boolean, south: boolean, kq: number, dL: number, walk = false): number {
  // into water or lava: a bank, except where a cliff of some height looks south over it
  if (kq === KIND.LIQUID && (walk || sideways || !south || dL <= BANK_STEP)) return BANK_RUN;
  const W = lip || kq === KIND.LIQUID ? F.pat.lip : F.pat.main;
  return Math.min(32, sideways ? W[3] : south ? W[0] : W[2]);
}

/** One lower neighbour of a tile, as far as the tile's surface is concerned. */
interface Low { ox: number; oy: number; Lq: number; dL: number; rx: number; ry: number; /** a 45 degree cut: the tile corner (px) it is measured from */ cx?: number; cy?: number }
/** the four corners of a tile: which way they point, and the corner point in px */
export const CORNERS: [number, number][] = [[1, -1], [1, 1], [-1, 1], [-1, -1]];

/** The lift of tile (x, y) if it is ground or liquid lower than L, as a cut sees it; -1 otherwise. */
function lowBeside(F: Field, x: number, y: number, L: number): number {
  if (x < 0 || y < 0 || x >= F.w || y >= F.h) return -1;
  const q = y * F.w + x;
  const k = F.kind(q) & 3;
  // (a bank into water or lava is not a wall: it is never cut)
  return k === KIND.VOID || F.lift(q) >= L - (k === KIND.LIQUID ? BANK_STEP : 0) ? -1 : F.lift(q);
}

/** Everything lower than tile (x, y) within a face's reach, looked up once. */
function lowsOf(F: Field, x: number, y: number): Low[] {
  const { w, h } = F, i = y * w + x, L = F.lift(i), lip = (F.kind(i) & KIND.LIP) !== 0, walk = (F.kind(i) & KIND.WALK) !== 0;
  const out: Low[] = [];
  for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) {
    if (!j && !k) continue;
    const xx = x + k, yy = y + j;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const q = yy * w + xx, kq = F.kind(q) & 3;
    if (kq === KIND.VOID || (walk && kq !== KIND.LIQUID)) continue;
    const Lq = F.lift(q);
    if (Lq >= L) continue;
    out.push({ ox: k * 16, oy: j * 16, Lq, dL: L - Lq, rx: runOf(F, lip, true, false, kq, L - Lq, walk), ry: runOf(F, lip, false, j > 0, kq, L - Lq, walk) });
  }
  if (F.kind(i) & KIND.CUT) {
    // a corner cut at 45 degrees: where the ground beside it is lower on two sides that meet, the
    // wall runs along the tile's diagonal and its face falls from there to the corner point
    for (const [sx, sy] of CORNERS) {
      const a = lowBeside(F, x + sx, y, L), b = lowBeside(F, x, y + sy, L);
      if (a < 0 || b < 0) continue;
      const Lq = Math.max(a, b);
      out.push({ ox: 0, oy: 0, Lq, dL: L - Lq, rx: 0, ry: 0, cx: sx > 0 ? 16 : 0, cy: sy > 0 ? 16 : 0 });
    }
  }
  return out;
}

/** The surface at (px, py) of a tile whose top is at L, with its face runs scaled by (sx, sy). */
function over(L: number, lows: Low[], px: number, py: number, sx: number, sy: number): number {
  let out = L;
  for (const q of lows) {
    if (q.cx !== undefined) {
      const hq = q.Lq + q.dL * Math.min((Math.abs(px - q.cx) + Math.abs(py - q.cy!)) / 16, 1);
      if (hq < out) out = hq;
      continue;
    }
    const gx = Math.max(q.ox - px, px - (q.ox + 16), 0), gy = Math.max(q.oy - py, py - (q.oy + 16), 0);
    const rx = q.rx * sx, ry = q.ry * sy;
    const dx = gx <= 0 ? 0 : rx < 0.25 ? 9 : gx / rx, dy = gy <= 0 ? 0 : ry < 0.25 ? 9 : gy / ry;
    const hq = q.Lq + q.dL * Math.min(Math.max(dx, dy), 1);
    if (hq < out) out = hq;
  }
  return out;
}

/** Is any of the tile level top, with these scales? (A top of MIN_TOP px cannot slip between the samples.) */
function hasTop(L: number, lows: Low[], sx: number, sy: number): boolean {
  for (let py = 2; py < 16; py += 4) for (let px = 2; px < 16; px += 4) if (over(L, lows, px, py, sx, sy) >= L - 0.5) return true;
  return false;
}

/**
 * Faces along a row or a column share the room there is: where raised ground ends in a face on
 * both sides, the two runs shrink together until MIN_TOP of top is left between them.
 */
function axisFit(F: Field, x: number, y: number): [number, number] {
  const { w, h } = F, L = F.lift(y * w + x), lip = (F.kind(y * w + x) & KIND.LIP) !== 0;
  // how far the raised ground goes one way, and the run of the face at its end: lower ground ends
  // it with a face, nothing (the void, the map edge) without one; over two tiles away does not matter
  const end = (dx: number, dy: number): { k: number; run: number } | null => {
    for (let k = 1; k <= 2; k++) {
      const xx = x + dx * k, yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return { k, run: 0 };
      const q = yy * w + xx, kq = F.kind(q) & 3;
      if (kq === KIND.VOID) return { k, run: 0 };
      if (F.lift(q) < L) return { k, run: runOf(F, lip, dx !== 0, dy > 0, kq, L - F.lift(q)) };
    }
    return null;
  };
  const fit = (a: { k: number; run: number } | null, b: { k: number; run: number } | null): number => {
    if (!a || !b || a.run + b.run <= 0) return 1;
    // (ground that ends at the void or the map's edge needs no top there: the face may run right up to it)
    const room = (a.k + b.k - 1) * 16 - (a.run > 0 && b.run > 0 ? MIN_TOP : 0);
    return a.run + b.run > room ? Math.max(room, 0) / (a.run + b.run) : 1;
  };
  return [fit(end(-1, 0), end(1, 0)), fit(end(0, -1), end(0, 1))];
}

/**
 * How much the faces of tile (x, y) are scaled, sideways and up-down, so that the raised ground
 * it belongs to always has a top. Rows and columns are fitted first. If neither this tile nor
 * the equally high ground within a face's reach ends up with any top (a ridge that runs
 * diagonally, a lone peak in a corner), the tile shrinks its own faces until it has one; with
 * the faces shrunk to nothing it is a plain block, so this always ends.
 */
export function fitOf(F: Field, x: number, y: number, lows: Low[] = lowsOf(F, x, y)): [number, number] {
  const { w, h } = F, i = y * w + x, L = F.lift(i);
  if ((F.kind(i) & (3 | KIND.WALK)) || !lows.length) return [1, 1];
  const [sx, sy] = axisFit(F, x, y);
  if (hasTop(L, lows, sx, sy)) return [sx, sy];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let k = 1; k <= 2; k++) {
      const xx = x + dx * k, yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return [sx, sy]; // it ends at the map's edge
      const j = yy * w + xx;
      if ((F.kind(j) & 3) === KIND.VOID) return [sx, sy];             // or at the void: no top needed
      if ((F.kind(j) & 3) || F.lift(j) < L) break;
      if (F.kind(j) & KIND.WALK) return [sx, sy];
      const [ax, ay] = axisFit(F, xx, yy);
      if (hasTop(F.lift(j), lowsOf(F, xx, yy), ax, ay)) return [sx, sy];
    }
  }
  for (const t of [0.7, 0.5, 0.3, 0.15]) if (hasTop(L, lows, sx * t, sy * t)) return [sx * t, sy * t];
  return [0, 0];
}

/** Lift in px of the surface at point (px, py) of tile (x, y), px and py in 0..16. */
export function surface(F: Field, x: number, y: number, px: number, py: number): number {
  const i = y * F.w + x;
  if (F.kind(i) & 3) return F.lift(i);
  const lows = lowsOf(F, x, y), [sx, sy] = fitOf(F, x, y, lows);
  return over(F.lift(i), lows, px, py, sx, sy);
}

/** A map as the model sees it at the game's own face sizes: for rules, placement and checks. */
const GAME_WALLS: Record<DimKind, WallPatterns> = {
  overworld: patternsFor('overworld'), sky: patternsFor('sky'), underworld: patternsFor('underworld'), interior: patternsFor('interior'),
};
export const fieldOf = (dim: Dimension): Field => ({ w: dim.w, h: dim.h, lift: (j) => liftAt(dim, j), kind: (j) => kindAt(dim, j), pat: GAME_WALLS[dim.kind] });

// ---- for drawing: everything per tile worked out once
/** Per tile, the two fit factors as bytes (255 = full run): what the shader reads instead of working them out. */
export function tileFits(dim: Dimension, liftPx: ArrayLike<number>, kind: Uint8Array, pat: WallPatterns): Uint8Array {
  const F: Field = { w: dim.w, h: dim.h, lift: (j) => liftPx[j], kind: (j) => kind[j], pat };
  const n = dim.w * dim.h, out = new Uint8Array(n * 2).fill(255);
  for (let i = 0; i < n; i++) {
    if (!(kind[i] & KIND.SLOPED)) continue;
    const [sx, sy] = fitOf(F, i % dim.w, (i / dim.w) | 0);
    out[i * 2] = Math.floor(sx * 255); out[i * 2 + 1] = Math.floor(sy * 255);
  }
  return out;
}

/** The surface from precomputed arrays (what the renderer has). */
export function surfacePx(dim: Dimension, liftPx: ArrayLike<number>, kind: Uint8Array, fits: Uint8Array, pat: WallPatterns, x: number, y: number, px: number, py: number): number {
  const i = y * dim.w + x;
  if (!(kind[i] & KIND.SLOPED)) return liftPx[i];
  const F: Field = { w: dim.w, h: dim.h, lift: (j) => liftPx[j], kind: (j) => kind[j], pat };
  return over(liftPx[i], lowsOf(F, x, y), px, py, fits[i * 2] / 255, fits[i * 2 + 1] / 255);
}

// ---- for rules: straight from a map
/**
 * Where a thing stands on a tile: down its middle. A face along the tile's west or east side
 * is beside it, not under it, so a side face never stops something standing there; a face that
 * comes across from the north or south does.
 */
const FOOTPRINT: [number, number][] = [[8, 8], [8, 4], [8, 12]];
/** Is anything within a face's reach of the tile lower than it? Most tiles: no, and then they are simply flat. */
function lowerNear(dim: Dimension, i: number): boolean {
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const j = yy * w + xx;
    if (dim.ground[j] !== T.VOID && liftAt(dim, j) < L) return true;
  }
  return false;
}

/** Is the tile level where something would stand on it: no face under the line down its middle? */
export function levelAt(dim: Dimension, i: number): boolean {
  if ((kindAt(dim, i) & (3 | KIND.WALK)) || !lowerNear(dim, i)) return true;
  const F = fieldOf(dim), x = i % dim.w, y = (i / dim.w) | 0, L = liftAt(dim, i);
  const lows = lowsOf(F, x, y), [sx, sy] = fitOf(F, x, y, lows);
  return FOOTPRINT.every(([px, py]) => over(L, lows, px, py, sx, sy) >= L - 0.5);
}

/**
 * A raised place is never smaller than its walls plus one tile of top: across, the west face,
 * a tile of top and the east face; up and down, the north face, a tile of top and the south
 * face. Outdoors that is 3 by 4 tiles (the south face is two tiles), indoors 5 by 5.
 * For the raised ground tile i is part of, this gives each direction in which it falls short:
 * the two lower tiles just beyond its ends, and how many tiles are missing. Ground that ends at
 * the void or the map's edge on one side has no face there and is not measured. Water or lava a
 * bank's height below is not "lower": a bank is not a wall.
 */
export function thinPairs(dim: Dimension, i: number): [number, number, number][] {
  if (kindAt(dim, i) & (3 | KIND.WALK)) return [];
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  const out: [number, number, number][] = [];
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    // walk to both ends of the ground that is at least this high; -1: it ends at nothing
    const end = (s: number): [number, number] => {
      for (let k = 1; ; k++) {
        const xx = x + dx * k * s, yy = y + dy * k * s;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return [-1, k - 1];
        const j = yy * w + xx, kj = kindAt(dim, j) & 3;
        if (kj === KIND.VOID) return [-1, k - 1];
        if (liftAt(dim, j) < L - (kj === KIND.LIQUID ? BANK_STEP : 0)) return [j, k - 1];
        if (k > 6) return [-1, k]; // plenty
      }
    };
    const [a, na] = end(-1), [b, nb] = end(1);
    if (a < 0 || b < 0) continue;
    const need = faceDepth(dim, -dx, -dy) + 1 + faceDepth(dim, dx, dy);
    if (na + nb + 1 < need) out.push([b, a, need - (na + nb + 1)]);
  }
  return out;
}
export const thinAt = (dim: Dimension, i: number): boolean => thinPairs(dim, i).length > 0;

/** How many tiles of closed raised ground a face needs behind its edge: its footprint in whole tiles. */
export function faceDepth(dim: Dimension, dx: number, dy: number): number {
  const W = GAME_WALLS[dim.kind].main;
  return Math.ceil(Math.min(32, dx !== 0 ? W[3] : dy > 0 ? W[0] : W[2]) / 16 - 1e-6);
}

/**
 * Is the face that tile i shows toward (dx, dy) cut short: does walkable ground begin behind the
 * edge before the face has the depth it needs? (Raised ground that is simply thin is `thinAt`'s
 * business; the void and the map's edge end a wall without spoiling its face.)
 * Returns the tile that would have to be closed for the face to fit, or -1.
 */
export function shortFace(dim: Dimension, i: number, dx: number, dy: number): number {
  if (kindAt(dim, i) & (3 | KIND.WALK)) return -1;
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  const fx = x + dx, fy = y + dy;
  if (fx < 0 || fy < 0 || fx >= w || fy >= h) return -1;
  const f = fy * w + fx, kf = kindAt(dim, f) & 3;
  if (kf === KIND.VOID || liftAt(dim, f) >= L - (kf === KIND.LIQUID ? BANK_STEP : 0)) return -1; // no face this way
  for (let k = 1; k < faceDepth(dim, dx, dy); k++) {
    const bx = x - dx * k, by = y - dy * k;
    if (bx < 0 || by < 0 || bx >= w || by >= h) return -1;
    const b = by * w + bx, kb = kindAt(dim, b);
    if ((kb & 3) === KIND.VOID) return -1;
    if ((kb & KIND.WALK) && liftAt(dim, b) >= L - 0.5) return b;
    if ((kb & 3) || liftAt(dim, b) < L) return -1;
  }
  return -1;
}

/**
 * Can this tile be cut at 45 degrees: solid raised ground with lower ground on exactly two sides
 * that meet, and ground at least as high on the other two (so the half that stays joins the rest)?
 */
export function cornerAt(dim: Dimension, i: number): boolean {
  if (kindAt(dim, i) & (3 | KIND.WALK)) return false;
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  const side = (xx: number, yy: number): number => {   // 1 lower, 0 as high or higher, -1 nothing
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) return -1;
    const j = yy * w + xx;
    const k = kindAt(dim, j) & 3;
    // (a bank into water or lava is not a wall: it is never cut)
    return k === KIND.VOID ? -1 : liftAt(dim, j) < L - (k === KIND.LIQUID ? BANK_STEP : 0) ? 1 : 0;
  };
  const n = side(x, y - 1), e = side(x + 1, y), s = side(x, y + 1), wst = side(x - 1, y);
  return (n === 1 && e === 1 && s === 0 && wst === 0) || (e === 1 && s === 1 && wst === 0 && n === 0) ||
    (s === 1 && wst === 1 && n === 0 && e === 0) || (wst === 1 && n === 1 && e === 0 && s === 0);
}

/** Does the tile show a face at all: is anything beside it lower? (Walkable ground and liquid never do.) */
export function facedAt(dim: Dimension, i: number): boolean {
  if (kindAt(dim, i) & (3 | KIND.WALK)) return false;
  const { w, h } = dim, x = i % w, y = (i / w) | 0, L = liftAt(dim, i);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const j = yy * w + xx;
    if ((kindAt(dim, j) & 3) !== KIND.VOID && liftAt(dim, j) < L) return true;
  }
  return false;
}

/**
 * Does raised ground reach its full height here: is some of this tile, or of the equally high
 * ground within a face's reach of it (two tiles, along either axis), level top? A tile may be
 * all face when the ground behind it carries the top; what may not happen is ground that is
 * marked high and never gets there.
 */
export function reachesTop(dim: Dimension, i: number): boolean {
  if ((kindAt(dim, i) & (3 | KIND.WALK)) || !lowerNear(dim, i)) return true;
  const F = fieldOf(dim), { w, h } = dim, L = liftAt(dim, i), x = i % w, y = (i / w) | 0;
  const topOn = (xx: number, yy: number): boolean => {
    if (F.kind(yy * w + xx) & KIND.WALK) return true;
    const lows = lowsOf(F, xx, yy), [sx, sy] = fitOf(F, xx, yy, lows);
    return hasTop(F.lift(yy * w + xx), lows, sx, sy);
  };
  if (topOn(x, y)) return true;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let k = 1; k <= 2; k++) {
      const xx = x + dx * k, yy = y + dy * k;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return true;
      const j = yy * w + xx;
      if ((kindAt(dim, j) & 3) === KIND.VOID) return true;
      if ((kindAt(dim, j) & 3) || liftAt(dim, j) < L) break;
      if (topOn(xx, yy)) return true;
    }
  }
  return false;
}
