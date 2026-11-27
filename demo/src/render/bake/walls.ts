// Wall tiles as baked sprites.
//
// The map is a flat grid of tiles. A tile of raised ground that a wall face crosses gets a sprite
// of its own, baked here from the terrain model (core/shape.ts): for every texel the height of the
// surface there, the face it belongs to, and from those the face texture, its shading and its
// normal. Two tiles with the same surroundings share one sprite, so a straight wall is a handful
// of pieces repeated, and a hand-drawn sheet can replace them key for key.
//   key: wl:<ground>:<variant>:<shape of the surroundings>
// The top of the tile (where the surface is at full height) is left empty: the ground tile under
// it shows there.
import { type Field, type Low, KIND, lowsOf, overInfo, type WallPatterns } from '../../core/shape';
import type { Dimension } from '../../core/types';
import { type AssetSheet, type Frame, Sprite, addToSheet } from './sheet';

export interface WallShapeData { liftPx: ArrayLike<number>; kind: Uint8Array; fits: Uint8Array; walls: WallPatterns }

/**
 * Forget every wall piece baked so far and give their room back. Wall pieces belong to a world:
 * when another world is shown, the last one's pieces would only fill the sheet until none fit,
 * and walls without a piece are drawn the slow way.
 */
export function resetWallSprites(sheet: AssetSheet): void {
  if (!sheet.spareStart || !sheet.cursor) return;
  for (const k of [...sheet.frames.keys()]) if (k.startsWith('wl:')) sheet.frames.delete(k);
  sheet.cursor = { ...sheet.spareStart };
}

/** what `wallSprite` gives for a tile that turns out to have no wall face on it: nothing is drawn for it */
export const NO_FACE = 'none' as const;
const blank = new Set<string>();

/** how many wall tiles were baked, and how many found the sheet full (those are drawn the slow way) */
export const wallStats = { baked: 0, full: 0 };
const sig = (lows: Low[], L: number): string => lows.map((q) => `${q.ox / 16},${q.oy / 16},${L - q.Lq},${q.rx},${q.ry}${q.cx !== undefined ? `,${q.cx / 16},${q.cy! / 16}` : ''}`).join(';');

/**
 * Only the lower ground that shapes this tile: what is too far for its wall to reach the tile is
 * left out, and so is what lies behind other lower ground that is at least as low (a straight wall
 * is shaped by the row beside it, not by the tiles further along). What is left names the piece,
 * so every tile of a straight wall is the same sprite.
 */
function relevant(lows: Low[], sx: number, sy: number): Low[] {
  const near = lows.filter((q) => {
    const gx = Math.max(q.ox - 16, -q.ox - 16, 0), gy = Math.max(q.oy - 16, -q.oy - 16, 0);
    const rx = q.rx * sx, ry = q.ry * sy;
    let d = Math.max(gx <= 0 ? 0 : rx < 0.25 ? 9 : gx / rx, gy <= 0 ? 0 : ry < 0.25 ? 9 : gy / ry);
    if (q.cx !== undefined) {
      // the nearest the tile comes to the cut's diagonal
      const u = Math.max(q.cx - 16, -q.cx, 0), v = Math.max(q.cy! - 16, -q.cy!, 0), rd = (rx + ry) / 2, past = u + v - 16;
      d = Math.max(d, past <= 0 ? 0 : rd < 0.25 ? 9 : past / rd);
    }
    return d < 1;
  });
  return near.filter((q) => q.cx !== undefined || !near.some((o) => o !== q && o.cx === undefined && o.Lq <= q.Lq &&
    Math.abs(o.ox) <= Math.abs(q.ox) && Math.abs(o.oy) <= Math.abs(q.oy) && (o.ox === 0 || Math.sign(o.ox) === Math.sign(q.ox)) && (o.oy === 0 || Math.sign(o.oy) === Math.sign(q.oy)) &&
    (Math.abs(o.ox) < Math.abs(q.ox) || Math.abs(o.oy) < Math.abs(q.oy))));
}

/** The baked sprite of the wall faces on tile (x, y), or null when the tile has none or the sheet is full. */
export function wallSprite(sheet: AssetSheet, dim: Dimension, sh: WallShapeData, x: number, y: number, face: Frame, faceKey: string): Frame | null | typeof NO_FACE {
  if (!sheet.cursor) return null;
  const i = y * dim.w + x, L = sh.liftPx[i];
  const F: Field = { w: dim.w, h: dim.h, lift: (j) => sh.liftPx[j], kind: (j) => sh.kind[j], pat: sh.walls };
  const sx = sh.fits[i * 2] / 255, sy = sh.fits[i * 2 + 1] / 255;
  const lows = relevant(lowsOf(F, x, y), sx, sy);
  if (!lows.length) return NO_FACE;
  const key = `wl:${faceKey}:${(sh.kind[i] & KIND.LIP) ? 1 : 0}:${sh.fits[i * 2]},${sh.fits[i * 2 + 1]}:${sig(lows, L)}`;
  const had = sheet.frames.get(key);
  if (had) return had[0];
  if (blank.has(key)) return NO_FACE;
  const S = face.s, N = 16 * S, W = sheet.w;
  const s = new Sprite(N, N, 0, 0);
  s.scale = S;
  let any = false;
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
    const px = (tx + 0.5) / S, py = (ty + 0.5) / S;
    const o = overInfo(L, lows, px, py, sx, sy);
    if (o.h >= L - 0.3) continue;                    // the top: the ground tile shows
    const dL = Math.max(L - o.lowL, 0.01), frac = Math.min(1, Math.max(0, (o.h - o.lowL) / dL));
    if (o.dir >= 5 && frac < 0.02) continue;         // the cut half of a diagonal tile: the lower ground shows (drawn under this)
    const cut = o.dir, dir = o.dir >= 5 ? (o.dir === 6 || o.dir === 7 ? 1 : 2) : o.dir;
    const ext = Math.max(o.run, 2), down = (1 - frac) * ext;
    // lay the face texture down the face at an even scale: across it along the wall, down it from the top edge
    const uF = Math.min(15.999, Math.max(0, dir <= 2 ? px : py));
    let vF = down;
    if (vF >= 48) vF = 4 + ((vF - 4) % 44);
    const at = ((face.y + Math.floor(vF * S)) * W + face.x + Math.floor(uF * S)) * 4;
    let k = 1, add = 0;
    if (down < 1.5) { k = 1.35; add = 15; }             // the coping along the top edge
    else if (down < 2.5 && ext > 6) k = 0.7;
    if (frac * ext < 1.5) k *= 0.72;                    // where it meets the ground
    const rgb = [Math.min(255, sheet.albedo[at] * k + add), Math.min(255, sheet.albedo[at + 1] * k + add), Math.min(255, sheet.albedo[at + 2] * k + add)];
    // the face's own slope, with the texture's relief turned to lie on it
    let pn: [number, number, number] = dir === 1 ? [0, dL, o.run] : dir === 2 ? [0, -dL, o.run] : dir === 3 ? [-dL, 0, o.run] : [dL, 0, o.run];
    if (cut >= 5) pn = [(cut <= 6 ? 0.707 : -0.707) * dL, (cut === 6 || cut === 7 ? 0.707 : -0.707) * dL, o.run];
    const pl = Math.hypot(pn[0], pn[1], pn[2]) || 1;
    const dx0 = sheet.normal[at] / 127.5 - 1, dy0 = sheet.normal[at + 1] / 127.5 - 1 - 1, dz0 = sheet.normal[at + 2] / 127.5 - 1;
    const det: [number, number, number] = dir === 1 ? [dx0, dy0, dz0] : dir === 2 ? [-dx0, -dy0, dz0] : dir === 3 ? [-dy0, dx0, dz0] : [dy0, -dx0, dz0];
    const er = sheet.emissive[at], eg = sheet.emissive[at + 1], eb = sheet.emissive[at + 2];
    s.set(tx, ty, rgb, pn[0] / pl + det[0] * 0.6, pn[1] / pl + det[1] * 0.6, pn[2] / pl + det[2] * 0.6, (o.h - L) / 16, er || eg || eb ? [er, eg, eb] : null, sheet.emissive[at + 3]);
    any = true;
  }
  if (!any) { blank.add(key); return NO_FACE; }
  if (!addToSheet(sheet, key, s)) { wallStats.full++; return null; }
  wallStats.baked++;
  return sheet.frames.get(key)![0];
}
