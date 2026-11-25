// Static terrain bake: ground tops, cliff faces, shadows, rims and deco, painted row by row
// north -> south into one offscreen canvas per dimension. Also: fog variant, owner zones,
// ghost layers for stacked worlds.
import { D, T, type Dimension } from '../core/types';
import { valueNoise } from '../core/rng';
import { decoOverhang, drawDeco } from './deco';
import { pal, flatColor } from './palette';
import { ctx2d, hash2, hexRgb, makeCanvas, mixHex, prng, rgbStr, withAlpha } from './util';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

type C = CanvasRenderingContext2D;

export interface DimRender {
  dim: Dimension;
  /** bake px per tile */
  S: number;
  /** bake px per elevation step */
  H: number;
  /** elevation step in tile units (H / S) */
  hT: number;
  /** visual elevation per tile; VOID tiles hold voidElev */
  ve: Float32Array;
  voidElev: number;
  maxVe: number;
  /** bake px above row 0 */
  top: number;
  seed: number;
  /** total bake height in px (the bake itself is painted in chunks, see flatChunks.ts) */
  H_px: number;
  /** zone index owning each tile (solid tiles: majority of walkable neighbours), -1 none */
  owner: Int32Array;
  /** face height (elev units) below each tile */
  faceH: Float32Array;
  /** world-space vertical bounds (tile units) of the bake */
  y0: number;
  y1: number;
}

/** walls render this much taller than their data elev so rooms read as solid blocks */
const WALL_BOOST = 0.6;

export function isWallG(g: number) {
  return g === T.WALL || g === T.CAVEWALL;
}

/** Flat bake resolution: fixed, the bake is chunked so dimension size does not matter. */
function bakeSize(_dim: Dimension): number {
  return 20;
}

export function computeVe(dim: Dimension): { ve: Float32Array; voidElev: number; maxVe: number } {
  const { w, h, ground, elev } = dim;
  const n = w * h;
  const ve = new Float32Array(n);
  const known = new Uint8Array(n);
  const q: number[] = [];
  for (let i = 0; i < n; i++) ve[i] = elev[i];
  // walls must read as raised blocks: at least one step above adjacent floor
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isWallG(ground[i])) continue;
      let m = -999;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          const g = ground[j];
          if (g === T.VOID || isWallG(g)) continue;
          if (elev[j] > m) m = elev[j];
        }
      if (m > -999) {
        ve[i] = Math.max(elev[i], m + 1) + WALL_BOOST;
        known[i] = 1;
        q.push(i);
      }
    }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || known[j] || !isWallG(ground[j])) continue;
      known[j] = 1;
      ve[j] = Math.max(elev[j] + WALL_BOOST, ve[i]);
      q.push(j);
    }
  }
  let minE = 999, maxE = -999;
  for (let i = 0; i < n; i++) {
    if (ground[i] === T.VOID) continue;
    if (ve[i] < minE) minE = ve[i];
    if (ve[i] > maxE) maxE = ve[i];
  }
  if (minE === 999) minE = maxE = 0;
  const voidElev = minE - (dim.kind === 'sky' ? 2.4 : dim.kind === 'overworld' ? 0.7 : 0.9);
  for (let i = 0; i < n; i++) if (ground[i] === T.VOID) ve[i] = voidElev;
  return { ve, voidElev, maxVe: maxE };
}

export function computeOwner(dim: Dimension): Int32Array {
  const { w, h, zone, ground } = dim;
  const n = w * h;
  const owner = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (zone[i] >= 0) owner[i] = zone[i];
  const q: number[] = [];
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (owner[i] >= 0 || ground[i] === T.VOID) continue;
      counts.clear();
      let best = -1, bc = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const z = zone[yy * w + xx];
          if (z < 0) continue;
          const c = (counts.get(z) || 0) + 1;
          counts.set(z, c);
          if (c > bc) { bc = c; best = z; }
        }
      if (best >= 0) owner[i] = best;
    }
  for (let i = 0; i < n; i++) if (owner[i] >= 0) q.push(i);
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || owner[j] >= 0 || ground[j] === T.VOID) continue;
      owner[j] = owner[i];
      q.push(j);
    }
  }
  return owner;
}

// ------------------------------------------------------------------ tile tops

function dots(c: C, r: () => number, px: number, py: number, S: number, n: number, col: string, size: number) {
  c.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const s = Math.max(1, size * S * (0.6 + r() * 0.8));
    c.fillRect(px + r() * (S - s), py + r() * (S - s), s, s);
  }
}

function drawTop(c: C, g: number, x: number, y: number, px: number, py: number, S: number, seed: number, t: number) {
  const p = pal(g);
  const hsh = hash2(x, y, seed);
  const r = prng(hsh);
  const nz = clamp01((valueNoise(seed ^ (g * 7919), x * 0.13, y * 0.13) - 0.2) / 0.6 + (hsh - 0.5) * 0.12);
  c.fillStyle = nz < 0.5 ? mixHex(p.top[0], p.top[1], nz * 2) : mixHex(p.top[1], p.top[2], nz * 2 - 1);
  c.fillRect(px, py, S, S);
  if (g !== T.FLOOR && g !== T.PLANK && g !== T.WALL) {
    // soft blotches of neighbouring shades break up the grid (kept inside the tile)
    c.fillStyle = withAlpha(p.top[nz < 0.5 ? 2 : 0], 0.35);
    c.beginPath();
    for (let k = 0; k < 2; k++) {
      const rr = S * (0.12 + r() * 0.14);
      const bx = px + rr + r() * (S - 2 * rr), by = py + rr + r() * (S - 2 * rr);
      c.moveTo(bx + rr, by);
      c.arc(bx, by, rr, 0, Math.PI * 2);
    }
    c.fill();
  }
  switch (g) {
    case T.GRASS: {
      c.strokeStyle = p.dk;
      c.lineWidth = Math.max(1, S * 0.04);
      c.beginPath();
      const n = 3 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const bx = px + S * (0.1 + r() * 0.8), by = py + S * (0.2 + r() * 0.75);
        c.moveTo(bx - S * 0.05, by - S * 0.1);
        c.lineTo(bx, by);
        c.lineTo(bx + S * 0.05, by - S * 0.12);
      }
      c.stroke();
      c.strokeStyle = withAlpha(p.lt, 0.7);
      c.beginPath();
      for (let i = 0; i < 2; i++) {
        const bx = px + S * (0.1 + r() * 0.8), by = py + S * (0.2 + r() * 0.75);
        c.moveTo(bx, by);
        c.lineTo(bx + S * 0.03, by - S * 0.1);
      }
      c.stroke();
      break;
    }
    case T.SAND:
      dots(c, r, px, py, S, 7, p.dk, 0.05);
      dots(c, r, px, py, S, 4, p.lt, 0.05);
      if (r() < 0.35) {
        c.strokeStyle = withAlpha(p.dk, 0.5);
        c.lineWidth = Math.max(1, S * 0.03);
        c.beginPath();
        const yy = py + S * (0.3 + r() * 0.5);
        c.moveTo(px + S * 0.1, yy);
        c.quadraticCurveTo(px + S * 0.5, yy - S * 0.12, px + S * 0.9, yy);
        c.stroke();
      }
      break;
    case T.DIRT:
    case T.PATH:
      dots(c, r, px, py, S, 5, p.dk, 0.07);
      dots(c, r, px, py, S, 3, p.lt, 0.06);
      break;
    case T.STONE:
    case T.CAVE: {
      c.strokeStyle = withAlpha(p.dk, 0.9);
      c.lineWidth = Math.max(1, S * 0.035);
      c.beginPath();
      if (r() < 0.6) {
        let cx2 = px + r() * S, cy2 = py + r() * S;
        c.moveTo(cx2, cy2);
        for (let i = 0; i < 3; i++) {
          cx2 += (r() - 0.5) * S * 0.4;
          cy2 += (r() - 0.3) * S * 0.3;
          c.lineTo(cx2, cy2);
        }
      }
      c.stroke();
      dots(c, r, px, py, S, 4, p.lt, 0.05);
      dots(c, r, px, py, S, 3, p.dk, 0.06);
      break;
    }
    case T.SNOW:
      dots(c, r, px, py, S, 4, withAlpha(p.dk, 0.7), 0.07);
      dots(c, r, px, py, S, 2, '#ffffff', 0.05);
      break;
    case T.WATER:
    case T.DEEP: {
      c.strokeStyle = withAlpha(p.lt, g === T.WATER ? 0.45 : 0.3);
      c.lineWidth = Math.max(1, S * 0.04);
      c.beginPath();
      for (let i = 0; i < 2; i++) {
        const wx = px + S * (0.1 + r() * 0.55), wy = py + S * (0.2 + r() * 0.65);
        c.moveTo(wx, wy);
        c.quadraticCurveTo(wx + S * 0.12, wy - S * 0.08, wx + S * 0.24, wy);
      }
      c.stroke();
      break;
    }
    case T.FLOOR: {
      const h2 = S / 2;
      for (let j = 0; j < 4; j++) {
        const fx = px + (j & 1) * h2, fy = py + (j >> 1) * h2;
        c.fillStyle = p.top[Math.floor(r() * 3)];
        c.fillRect(fx + 1, fy + 1, h2 - 2, h2 - 2);
        c.fillStyle = withAlpha(p.lt, 0.35);
        c.fillRect(fx + 1, fy + 1, h2 - 2, Math.max(1, S * 0.03));
      }
      c.fillStyle = withAlpha(p.dk, 0.8);
      c.fillRect(px, py + h2 - 1, S, 2);
      c.fillRect(px + h2 - 1, py, 2, S);
      break;
    }
    case T.WALL:
    case T.CAVEWALL: {
      c.strokeStyle = withAlpha(p.dk, 0.6);
      c.lineWidth = Math.max(1, S * 0.04);
      c.beginPath();
      if (g === T.WALL) {
        const off = (y & 1) * S * 0.5;
        c.moveTo(px, py + S * 0.5);
        c.lineTo(px + S, py + S * 0.5);
        c.moveTo(px + ((off + S * 0.25) % S), py);
        c.lineTo(px + ((off + S * 0.25) % S), py + S * 0.5);
        c.moveTo(px + ((off + S * 0.75) % S), py + S * 0.5);
        c.lineTo(px + ((off + S * 0.75) % S), py + S);
      } else {
        let cx2 = px + r() * S, cy2 = py + r() * S;
        c.moveTo(cx2, cy2);
        for (let i = 0; i < 3; i++) {
          cx2 += (r() - 0.5) * S * 0.5;
          cy2 += (r() - 0.5) * S * 0.5;
          c.lineTo(cx2, cy2);
        }
      }
      c.stroke();
      dots(c, r, px, py, S, 3, withAlpha(p.lt, 0.5), 0.05);
      break;
    }
    case T.CLOUD: {
      for (let i = 0; i < 3; i++) {
        c.fillStyle = i < 2 ? withAlpha(p.lt, 0.9) : withAlpha(p.dk, 0.5);
        c.beginPath();
        c.arc(px + S * (0.2 + r() * 0.6), py + S * (0.2 + r() * 0.6), S * (0.12 + r() * 0.15), 0, Math.PI * 2);
        c.fill();
      }
      break;
    }
    case T.LAVA: {
      c.strokeStyle = withAlpha('#7a1a04', 0.75);
      c.lineWidth = Math.max(1, S * 0.06);
      c.beginPath();
      let cx2 = px + r() * S, cy2 = py + r() * S;
      c.moveTo(cx2, cy2);
      for (let i = 0; i < 3; i++) {
        cx2 += (r() - 0.5) * S * 0.6;
        cy2 += (r() - 0.5) * S * 0.6;
        c.lineTo(cx2, cy2);
      }
      c.stroke();
      dots(c, r, px, py, S, 3, '#ffe27a', 0.06);
      break;
    }
    case T.PLANK: {
      c.fillStyle = withAlpha(p.dk, 0.85);
      for (let i = 1; i < 3; i++) c.fillRect(px, py + (S * i) / 3 - 1, S, Math.max(1, S * 0.05));
      c.fillStyle = withAlpha(p.lt, 0.5);
      for (let i = 0; i < 3; i++) c.fillRect(px, py + (S * i) / 3 + 1, S, Math.max(1, S * 0.03));
      c.fillStyle = '#3a2410';
      for (let i = 0; i < 3; i++) {
        c.fillRect(px + S * 0.1, py + (S * i) / 3 + S * 0.13, 2, 2);
        c.fillRect(px + S * 0.85, py + (S * i) / 3 + S * 0.13, 2, 2);
      }
      break;
    }
    case T.SWAMP: {
      for (let i = 0; i < 2; i++) {
        c.fillStyle = withAlpha('#2c4a3e', 0.8);
        c.beginPath();
        c.ellipse(px + S * (0.2 + r() * 0.6), py + S * (0.2 + r() * 0.6), S * (0.12 + r() * 0.14), S * (0.08 + r() * 0.08), 0, 0, Math.PI * 2);
        c.fill();
      }
      if (r() < 0.4) {
        c.fillStyle = '#6fa84a';
        c.beginPath();
        c.arc(px + S * (0.25 + r() * 0.5), py + S * (0.25 + r() * 0.5), S * 0.08, 0.4, Math.PI * 2);
        c.fill();
      }
      dots(c, r, px, py, S, 3, p.lt, 0.05);
      break;
    }
  }
}

// ------------------------------------------------------------------ blending between grounds

function edgeBlend(
  c: C, g: number, ng: number, dir: number, px: number, py: number, S: number, seedEdge: number,
) {
  const p = pal(g), q = pal(ng);
  const r = prng(seedEdge);
  // dir 0=N,1=E,2=S,3=W ; circle centres along the shared edge
  const pts: [number, number, number][] = [];
  const n = 4;
  for (let k = 0; k < n; k++) {
    const t = (k + 0.2 + r() * 0.6) / n;
    const depth = S * (0.02 + r() * 0.1);
    const rad = S * (0.14 + r() * 0.12);
    let cx = 0, cy = 0;
    if (dir === 0) { cx = px + t * S; cy = py + depth - rad * 0.4; }
    else if (dir === 2) { cx = px + t * S; cy = py + S - depth + rad * 0.4; }
    else if (dir === 3) { cx = px + depth - rad * 0.4; cy = py + t * S; }
    else { cx = px + S - depth + rad * 0.4; cy = py + t * S; }
    pts.push([cx, cy, rad]);
  }
  c.save();
  c.beginPath();
  c.rect(px, py, S, S);
  c.clip();
  if (p.liquid && !q.liquid) {
    // foam ring hugging the shore (lava: bright molten rim)
    c.fillStyle = g === T.LAVA ? 'rgba(255,225,120,0.9)' : 'rgba(225,245,255,0.75)';
    c.beginPath();
    for (const [x, y, rr] of pts) { c.moveTo(x + rr + S * 0.08, y); c.arc(x, y, rr + S * 0.08, 0, Math.PI * 2); }
    if (dir === 0) c.rect(px, py, S, S * 0.12);
    else if (dir === 2) c.rect(px, py + S * 0.88, S, S * 0.12);
    else if (dir === 3) c.rect(px, py, S * 0.12, S);
    else c.rect(px + S * 0.88, py, S * 0.12, S);
    c.fill();
  }
  c.fillStyle = q.top[1];
  c.beginPath();
  for (const [x, y, rr] of pts) { c.moveTo(x + rr, y); c.arc(x, y, rr, 0, Math.PI * 2); }
  c.fill();
  c.restore();
}

// ------------------------------------------------------------------ cliff faces

function drawFace(
  c: C, g: number, x: number, y: number, px: number, fy: number, fh: number, S: number, H: number,
  litLeft: boolean, darkRight: boolean, overVoid: boolean, kind: string, seed: number,
) {
  const p = pal(g);
  const r = prng(hash2(x, y, seed + 17));
  if (g === T.WATER || g === T.DEEP) {
    const gr = c.createLinearGradient(0, fy, 0, fy + fh);
    gr.addColorStop(0, '#5ab4ea');
    gr.addColorStop(1, '#1a4f86');
    c.fillStyle = gr;
    c.fillRect(px, fy, S, fh);
    c.fillStyle = 'rgba(235,250,255,0.6)';
    for (let i = 0; i < 4; i++) c.fillRect(px + r() * S * 0.9, fy, Math.max(1, S * 0.05), fh * (0.5 + r() * 0.5));
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillRect(px, fy + fh - Math.max(2, S * 0.08), S, Math.max(2, S * 0.08));
    return;
  }
  if (g === T.LAVA) {
    const gr = c.createLinearGradient(0, fy, 0, fy + fh);
    gr.addColorStop(0, '#ffb23a');
    gr.addColorStop(1, '#c2280a');
    c.fillStyle = gr;
    c.fillRect(px, fy, S, fh);
    c.fillStyle = 'rgba(255,240,170,0.6)';
    for (let i = 0; i < 3; i++) c.fillRect(px + r() * S * 0.9, fy, Math.max(1, S * 0.05), fh * (0.4 + r() * 0.6));
    return;
  }
  const gr = c.createLinearGradient(0, fy, 0, fy + fh);
  gr.addColorStop(0, p.face[0]);
  gr.addColorStop(1, p.face[1]);
  c.fillStyle = gr;
  const jag = overVoid && kind !== 'interior' && g !== T.CLOUD;
  if (jag) {
    // floating-island underside: jagged taper
    c.beginPath();
    c.moveTo(px, fy);
    c.lineTo(px + S, fy);
    c.lineTo(px + S, fy + fh * 0.55);
    const n = 3;
    for (let k = n; k >= 0; k--) {
      const xx = px + (S * k) / n;
      const yy = fy + fh * (k % 2 ? 0.55 + r() * 0.15 : 0.8 + r() * 0.2);
      c.lineTo(xx, yy);
    }
    c.closePath();
    c.fill();
  } else if (g === T.CLOUD) {
    c.fillRect(px, fy, S, fh * 0.6);
    c.beginPath();
    for (let k = 0; k < 2; k++) {
      const cx = px + S * (0.25 + k * 0.5), rr = S * 0.28;
      c.moveTo(cx + rr, fy + fh * 0.6);
      c.arc(cx, fy + fh * 0.6, rr, 0, Math.PI * 2);
    }
    c.fill();
  } else {
    c.fillRect(px, fy, S, fh);
  }
  if (g === T.WALL || g === T.FLOOR) {
    // bricks
    c.fillStyle = withAlpha(p.face[2], 0.9);
    const bh = Math.max(3, H * 0.5);
    let row = 0;
    for (let yy = fy + bh; yy < fy + fh - 1; yy += bh, row++) c.fillRect(px, yy, S, Math.max(1, S * 0.035));
    row = 0;
    for (let yy = fy; yy < fy + fh - 1; yy += bh, row++) {
      const off = ((row + y) & 1) * S * 0.5;
      c.fillRect(px + ((off + S * 0.25) % S), yy, Math.max(1, S * 0.035), Math.min(bh, fy + fh - yy));
      c.fillRect(px + ((off + S * 0.75) % S), yy, Math.max(1, S * 0.035), Math.min(bh, fy + fh - yy));
    }
    c.fillStyle = 'rgba(255,255,255,0.08)';
    for (let yy = fy + 1; yy < fy + fh - 1; yy += bh) c.fillRect(px, yy + 1, S, Math.max(1, S * 0.03));
  } else if (g === T.PLANK) {
    c.fillStyle = '#2a170a';
    c.fillRect(px + S * 0.15, fy, S * 0.12, fh);
    c.fillRect(px + S * 0.73, fy, S * 0.12, fh);
  } else if (g !== T.CLOUD) {
    // strata + cracks
    c.fillStyle = withAlpha(p.face[2], 0.85);
    const band = Math.max(3, H * 0.55);
    for (let yy = fy + band * (0.6 + r() * 0.4); yy < fy + fh - 2; yy += band * (0.8 + r() * 0.4)) {
      const w0 = r() * S * 0.3;
      c.fillRect(px + w0, yy, S - w0 - r() * S * 0.2, Math.max(1, S * 0.04));
    }
    c.fillStyle = withAlpha(p.face[2], 0.7);
    const nc = 1 + Math.floor(r() * 2);
    for (let k = 0; k < nc; k++) {
      const cx = px + S * (0.15 + r() * 0.7);
      c.fillRect(cx, fy + fh * r() * 0.4, Math.max(1, S * 0.035), fh * (0.3 + r() * 0.4));
    }
    c.fillStyle = 'rgba(255,230,200,0.13)';
    for (let k = 0; k < 2; k++) c.fillRect(px + S * r(), fy + fh * (0.1 + r() * 0.6), S * 0.18, Math.max(1, S * 0.04));
  }
  // ambient occlusion toward the bottom
  if (!jag && g !== T.CLOUD) {
    const ao = c.createLinearGradient(0, fy + fh * 0.4, 0, fy + fh);
    ao.addColorStop(0, 'rgba(0,0,0,0)');
    ao.addColorStop(1, 'rgba(0,0,0,0.38)');
    c.fillStyle = ao;
    c.fillRect(px, fy + fh * 0.4, S, fh * 0.6);
  }
  if (litLeft) {
    c.fillStyle = 'rgba(255,235,200,0.22)';
    c.fillRect(px, fy, Math.max(1, S * 0.08), fh * (jag ? 0.55 : 1));
  }
  if (darkRight) {
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(px + S - Math.max(1, S * 0.1), fy, Math.max(1, S * 0.1), fh * (jag ? 0.55 : 1));
  }
  // lip: top material hanging over the edge
  if (p.lip) {
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(px, fy, S, Math.max(1, S * 0.1));
    c.fillStyle = p.lip;
    c.beginPath();
    c.rect(px, fy, S, Math.max(1, S * 0.06));
    const n = 3;
    for (let k = 0; k < n; k++) {
      const cx = px + (S * (k + 0.2 + r() * 0.6)) / n;
      const rr = S * (0.05 + r() * 0.06);
      c.moveTo(cx + rr, fy + S * 0.04);
      c.arc(cx, fy + S * 0.04, rr, 0, Math.PI);
    }
    c.fill();
  } else {
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(px, fy, S, Math.max(1, S * 0.04));
  }
}

// ------------------------------------------------------------------ bake

/** Metadata (elevation, faces, owner zones, bounds) without painting; paint lazily with paintDimRender. */
export function buildDimRender(dim: Dimension, seed: number): DimRender {
  const S = bakeSize(dim);
  const H = Math.round(S * 0.4);
  const { w, h } = dim;
  const { ve, voidElev, maxVe } = computeVe(dim);
  const top = Math.ceil(Math.max(0, maxVe) * H + S * 1.1);
  const bottom = Math.ceil((maxVe - voidElev) * H + S * 0.5);
  const faceH = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dim.ground[i] === T.VOID) continue;
      const eS = y + 1 < h ? ve[i + w] : voidElev;
      if (eS < ve[i]) faceH[i] = ve[i] - eS;
    }
  const ch = top + h * S + bottom;
  return {
    dim, S, H, hT: H / S, ve, voidElev, maxVe, top, seed, H_px: ch,
    owner: computeOwner(dim), faceH,
    y0: -top / S, y1: (ch - top) / S,
  };
}

/**
 * Paint the tiles in [rx0,rx1) x [ry0,ry1) of the flat (Canvas 2D) terrain bake into `c`, whose transform
 * maps bake px (S per tile, `top` px of margin above row 0). Rows are painted in global painter order,
 * so a chunk that includes every tile poking into it reproduces the full bake exactly.
 */
export function paintRegion(dr: DimRender, c: CanvasRenderingContext2D, rx0: number, rx1: number, ry0: number, ry1: number): void {
  const { dim, S, H, ve, voidElev, top, seed } = dr;
  const { w, h, ground, deco } = dim;
  rx0 = Math.max(0, rx0); ry0 = Math.max(0, ry0); rx1 = Math.min(w, rx1); ry1 = Math.min(h, ry1);
  const veAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? voidElev : ve[y * w + x]);
  const gAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? T.VOID : ground[y * w + x]);
  const dAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : deco[y * w + x]);
  const underground = dim.kind === 'underworld' || dim.kind === 'interior';

  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      const i = y * w + x;
      const g = ground[i];
      if (g === T.VOID) continue;
      const e = ve[i];
      const px = x * S;
      const py = top + y * S - e * H;
      const puff = g === T.CLOUD && (gAt(x, y - 1) === T.VOID || gAt(x + 1, y) === T.VOID || gAt(x - 1, y) === T.VOID);
      if (puff) {
        // clouds get bumpy outlines against open sky
        const vN = gAt(x, y - 1) === T.VOID, vE = gAt(x + 1, y) === T.VOID, vW = gAt(x - 1, y) === T.VOID;
        const ins = S * 0.2;
        const x0 = px + (vW ? ins : 0), x1 = px + S - (vE ? ins : 0), y0 = py + (vN ? ins : 0);
        const pr = prng(hash2(x, y, seed + 41));
        const cp = new Path2D();
        cp.rect(x0, y0, x1 - x0, py + S - y0 + (e - veAt(x, y + 1)) * H + S * 0.5);
        const bump = (ax: number, ay: number, bx: number, by: number) => {
          for (let k = 0; k < 2; k++) {
            const tt = (k + 0.3 + pr() * 0.4) / 2;
            const rad = S * (0.17 + pr() * 0.07);
            const cx = ax + (bx - ax) * tt, cy = ay + (by - ay) * tt;
            cp.moveTo(cx + rad, cy);
            cp.arc(cx, cy, rad, 0, Math.PI * 2);
          }
        };
        if (vN) bump(x0, y0, x1, y0);
        if (vW) bump(x0, y0, x0, py + S);
        if (vE) bump(x1, y0, x1, py + S);
        c.save();
        c.clip(cp);
      }
      drawTop(c, g, x, y, px, py, S, seed, 0);
      const p = pal(g);
      // blend neighbours with higher priority on the same level
      if (p.prio >= 0) {
        const nbs: [number, number, number][] = [[x, y - 1, 0], [x + 1, y, 1], [x, y + 1, 2], [x - 1, y, 3]];
        for (const [nx, ny, dir] of nbs) {
          const ng = gAt(nx, ny);
          if (ng === g || ng === T.VOID) continue;
          const q = pal(ng);
          if (Math.abs(veAt(nx, ny) - e) > 0.01) continue;
          if (p.liquid && !q.liquid && q.prio < 0) {
            // liquid against built floor: straight foam edge
            const fw = Math.max(1, S * 0.08);
            c.fillStyle = g === T.LAVA ? 'rgba(255,225,120,0.9)' : 'rgba(225,245,255,0.7)';
            if (dir === 0) c.fillRect(px, py, S, fw);
            else if (dir === 2) c.fillRect(px, py + S - fw, S, fw);
            else if (dir === 3) c.fillRect(px, py, fw, S);
            else c.fillRect(px + S - fw, py, fw, S);
            continue;
          }
          if (q.prio <= p.prio) continue;
          if (p.liquid && q.liquid && ng === T.LAVA) continue;
          const es = dir === 0 || dir === 2 ? hash2(x, Math.min(y, ny), seed + 3) : hash2(Math.min(x, nx), y, seed + 5);
          edgeBlend(c, g, ng, dir, px, py, S, es);
        }
        // shore foam against higher land (cliff base)
        if (p.liquid) {
          const nn = gAt(x, y - 1);
          if (nn !== T.VOID && !pal(nn).liquid && veAt(x, y - 1) > e) {
            c.fillStyle = 'rgba(225,245,255,0.55)';
            c.fillRect(px, py, S, Math.max(1, S * 0.08));
          }
        }
      }
      // height tint: higher ground slightly brighter/warmer
      if (e !== 0 && !isWallG(g)) {
        c.fillStyle = e > 0 ? `rgba(255,240,205,${Math.min(0.2, 0.06 * e)})` : `rgba(10,10,30,${Math.min(0.3, -0.1 * e)})`;
        c.fillRect(px, py, S, S);
      }
      // drop shadows from higher neighbours (light from NW)
      const eN = veAt(x, y - 1), eW = veAt(x - 1, y), eNW = veAt(x - 1, y - 1);
      if (eN > e && gAt(x, y - 1) !== T.VOID) {
        const d = Math.min(1, (eN - e) * 0.5);
        const gr = c.createLinearGradient(0, py, 0, py + S * 0.55);
        gr.addColorStop(0, `rgba(8,6,20,${0.4 * d + 0.25})`);
        gr.addColorStop(1, 'rgba(8,6,20,0)');
        c.fillStyle = gr;
        c.fillRect(px, py, S, S * 0.55);
      }
      if (eW > e && gAt(x - 1, y) !== T.VOID) {
        const d = Math.min(1, (eW - e) * 0.5);
        const len = S * (0.3 + 0.25 * d);
        const gr = c.createLinearGradient(px, 0, px + len, 0);
        gr.addColorStop(0, `rgba(8,6,20,${0.4 * d + 0.1})`);
        gr.addColorStop(1, 'rgba(8,6,20,0)');
        c.fillStyle = gr;
        // shadow of the west block also covers where its face projects
        c.fillRect(px, py, len, S);
      } else if (eNW > e && eN <= e && gAt(x - 1, y - 1) !== T.VOID) {
        const gr = c.createRadialGradient(px, py, 0, px, py, S * 0.5);
        gr.addColorStop(0, 'rgba(8,6,20,0.35)');
        gr.addColorStop(1, 'rgba(8,6,20,0)');
        c.fillStyle = gr;
        c.fillRect(px, py, S * 0.5, S * 0.5);
      }
      // rims on upper edges
      if (!p.liquid) {
        const lw = Math.max(1, S * 0.06);
        if (eN < e) {
          c.fillStyle = 'rgba(255,250,225,0.55)';
          c.fillRect(px, py, S, lw);
        }
        if (eW < e) {
          c.fillStyle = 'rgba(255,250,225,0.35)';
          c.fillRect(px, py, lw, S);
        }
        if (veAt(x + 1, y) < e) {
          c.fillStyle = 'rgba(0,0,10,0.4)';
          c.fillRect(px + S - lw, py, lw, S);
        }
      }
      if (veAt(x + 1, y) > e + 0.01 && gAt(x + 1, y) !== T.VOID) {
        // base of the neighbouring plateau's west side
        c.fillStyle = 'rgba(10,6,20,0.45)';
        c.fillRect(px + S - Math.max(1, S * 0.05), py, Math.max(1, S * 0.05), S);
      }
      // cliff face below
      const eS = veAt(x, y + 1);
      if (eS < e) {
        const fh = (e - eS) * H;
        const litLeft = veAt(x - 1, y) < e - 0.01 || veAt(x - 1, y + 1) >= e;
        const darkRight = veAt(x + 1, y) < e - 0.01 || veAt(x + 1, y + 1) >= e;
        drawFace(c, g, x, y, px, py + S, fh, S, H, litLeft, darkRight, gAt(x, y + 1) === T.VOID, dim.kind, seed);
      }
      if (puff) c.restore();
    }
    // deco pass for this row (tall deco overlaps the row above)
    for (let x = rx0; x < rx1; x++) {
      const i = y * w + x;
      const d = deco[i];
      if (!d || ground[i] === T.VOID) continue;
      const px = x * S;
      const py = top + y * S - ve[i] * H;
      drawDeco(c, d, px, py, S, {
        ground: ground[i],
        decoW: dAt(x - 1, y),
        decoE: dAt(x + 1, y),
        decoS: dAt(x, y + 1),
        decoN: dAt(x, y - 1),
        underground,
        rnd: prng(hash2(x, y, seed + 99)),
      });
    }
  }
}

/** Bake-space rectangle a tile occupies (top surface + its cliff face + tall deco). */
export function footprint(dr: DimRender, i: number, withDeco: boolean): [number, number, number, number] {
  const { dim, S, H, top, ve, faceH } = dr;
  const x = i % dim.w, y = (i / dim.w) | 0;
  const oh = withDeco ? decoOverhang(dim.deco[i]) * S * 0.85 : 0;
  const py = top + y * S - ve[i] * H;
  return [x * S, py - oh, S, S + faceH[i] * H + oh];
}

// ------------------------------------------------------------------ ghost layers

/** 1 px per tile silhouette of a dimension's terrain, tinted (smoothly upscaled = blurry far-below look). */
export function buildGhostFill(src: Dimension, tint: string, tintA: number): HTMLCanvasElement {
  const cv = makeCanvas(src.w, src.h);
  const c = ctx2d(cv);
  const img = c.createImageData(src.w, src.h);
  for (let i = 0; i < src.w * src.h; i++) {
    const g = src.ground[i];
    if (g === T.VOID) continue;
    const col = hexRgb(flatColor(g));
    const e = src.elev[i];
    const k = 1 + e * 0.12;
    img.data[i * 4] = col[0] * k;
    img.data[i * 4 + 1] = col[1] * k;
    img.data[i * 4 + 2] = col[2] * k;
    img.data[i * 4 + 3] = src.deco[i] === D.TREE || src.deco[i] === D.PINE ? 255 : 235;
  }
  c.putImageData(img, 0, 0);
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = rgbStr(hexRgb(tint), tintA);
  c.fillRect(0, 0, cv.width, cv.height);
  return cv;
}

/** Coastline / land outline of a dimension as a Path2D in tile units. */
export function buildOutline(src: Dimension): Path2D {
  const { w, h, ground } = src;
  const land = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const g = ground[y * w + x];
    return g !== T.VOID && g !== T.WATER && g !== T.DEEP && g !== T.LAVA;
  };
  const p = new Path2D();
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && land(x, y - 1) !== land(x, y);
      if (edge && run < 0) run = x;
      if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && land(x - 1, y) !== land(x, y);
      if (edge && run < 0) run = y;
      if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
    }
  }
  return p;
}

/** Tiled near-black rock texture for underground backgrounds. */
export function rockPattern(): HTMLCanvasElement {
  const cv = makeCanvas(160, 160);
  const c = ctx2d(cv);
  c.fillStyle = '#0d0b11';
  c.fillRect(0, 0, 160, 160);
  const r = prng(0.4242);
  for (let i = 0; i < 70; i++) {
    const x = r() * 160, y = r() * 160, rr = 4 + r() * 16;
    c.fillStyle = r() < 0.5 ? 'rgba(40,34,50,0.45)' : 'rgba(0,0,0,0.5)';
    for (const [ox, oy] of [[0, 0], [160, 0], [-160, 0], [0, 160], [0, -160]]) {
      c.beginPath();
      c.ellipse(x + ox, y + oy, rr, rr * 0.7, r() * 3, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.strokeStyle = 'rgba(70,60,85,0.25)';
  c.lineWidth = 1;
  for (let i = 0; i < 18; i++) {
    let x = r() * 160, y = r() * 160;
    c.beginPath();
    c.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; c.lineTo(x, y); }
    c.stroke();
  }
  return cv;
}
