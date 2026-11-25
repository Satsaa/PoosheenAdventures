// Tiny SDF toolkit + software ray marcher that renders a Model into a Sprite (albedo / normal /
// height / emissive) from the fixed cabinet camera described in ./sheet.ts.
// Units: tiles. Tile footprint = [0,1] x [0,1] in (x east, y south), z up.
import { Sprite, TILE_PX, hexToRgb } from './sheet';

export interface Mat {
  /** colour ramp dark -> light (3-5 steps); the baker picks a step, lighting does the rest */
  ramp: string[];
  /** emitted colour 0..255 (constant) */
  emit?: [number, number, number];
  /** MAT.* id */
  id?: number;
  /** ramp-step bias (+ = lighter) */
  bias?: number;
}

export interface Model {
  /** tiles of footprint covered (sprite width = (fw + 2*padX) * 16) */
  fw?: number;
  fh?: number;
  /** tile units of horizontal padding on each side for overhanging shapes */
  padX?: number;
  /** highest z reached (tiles) */
  zMax: number;
  /** lowest z (negative for pits) */
  zMin?: number;
  sdf(x: number, y: number, z: number): number;
  /** material index at a surface point */
  mat(x: number, y: number, z: number): number;
  mats: Mat[];
  outline?: number;
  /** extra per-pixel ramp noise amplitude (default 0.6) */
  grain?: number;
}

// ---------------------------------------------------------------- primitives (all return distance)
export const sph = (x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number) =>
  Math.hypot(x - cx, y - cy, z - cz) - r;

export function box(x: number, y: number, z: number, cx: number, cy: number, cz: number, bx: number, by: number, bz: number, r = 0) {
  const qx = Math.abs(x - cx) - bx + r, qy = Math.abs(y - cy) - by + r, qz = Math.abs(z - cz) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** vertical cylinder centred at (cx,cy) spanning z0..z1 */
export function cylZ(x: number, y: number, z: number, cx: number, cy: number, z0: number, z1: number, r: number) {
  const dr = Math.hypot(x - cx, y - cy) - r;
  const dz = Math.max(z0 - z, z - z1);
  return Math.min(Math.max(dr, dz), 0) + Math.hypot(Math.max(dr, 0), Math.max(dz, 0));
}

/** vertical cone: base radius r at z0, apex at z0+h */
export function coneZ(x: number, y: number, z: number, cx: number, cy: number, z0: number, h: number, r: number) {
  const q = Math.hypot(x - cx, y - cy);
  const t = (z - z0) / h;
  if (t < 0) return Math.max(z0 - z, q - r);
  const rr = r * (1 - Math.min(1, t));
  // approximate: scaled radial distance, conservative factor
  const s = h / Math.hypot(h, r);
  return Math.max((q - rr) * s, z - (z0 + h), z0 - z);
}

export function capsule(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) {
  const px = x - ax, py = y - ay, pz = z - az, dx = bx - ax, dy = by - ay, dz = bz - az;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz)));
  return Math.hypot(px - dx * h, py - dy * h, pz - dz * h) - r;
}

export function ellip(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz);
  const k1 = Math.hypot((x - cx) / (rx * rx), (y - cy) / (ry * ry), (z - cz) / (rz * rz));
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

export function torusZ(x: number, y: number, z: number, cx: number, cy: number, cz: number, R: number, r: number) {
  const q = Math.hypot(x - cx, y - cy) - R;
  return Math.hypot(q, z - cz) - r;
}

/** gable roof prism: ridge along x at y=cy, eaves at z0 spanning y in [cy-hy, cy+hy], ridge at z0+hz */
export function roofX(x: number, y: number, z: number, x0: number, x1: number, cy: number, hy: number, z0: number, hz: number) {
  const dx = Math.max(x0 - x, x - x1);
  const dy = Math.abs(y - cy);
  const slope = (dy / hy) * hz + (z - z0) - hz; // >0 above roof plane
  const n = Math.hypot(1, hz / hy);
  const dRoof = slope / n;
  return Math.max(dx, dRoof, z0 - z, dy - hy);
}

export const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

/** cheap 3D value noise in [0,1] */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1442695041) ^ Math.imul(seed, 0x27d4eb2d);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), ux), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), ux), uy),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), ux), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), ux), uy),
    uz,
  );
}

export function hashN(a: number, b: number, s = 0): number {
  let n = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s | 0, 0x27d4eb2d);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const rgbCache = new Map<string, [number, number, number]>();
export function rgb(hex: string) {
  let c = rgbCache.get(hex);
  if (!c) rgbCache.set(hex, (c = hexToRgb(hex)));
  return c;
}

// ---------------------------------------------------------------- ray marcher

const SQ = Math.SQRT1_2;

/** Render a model into a sprite. Sprite pivot = tile NW ground corner. */
export function renderModel(m: Model, seed = 1): Sprite {
  const fw = m.fw ?? 1, fh = m.fh ?? 1, pad = m.padX ?? 0.25;
  const zMin = m.zMin ?? 0;
  const ox = Math.round(pad * TILE_PX);
  const oy = Math.ceil(m.zMax * TILE_PX) + 1;
  const w = Math.round((fw + 2 * pad) * TILE_PX);
  const h = oy + Math.ceil((fh - zMin) * TILE_PX) + 1;
  const s = new Sprite(w, h, ox, oy);
  const grain = m.grain ?? 0.6;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = (i + 0.5 - ox) / TILE_PX;
      const sy = (j + 0.5 - oy) / TILE_PX;
      // ray: points (sx, sy + Z, Z), starting above the model and moving toward -z, -y
      let z = m.zMax + 0.05;
      let y = sy + z;
      let hit = false;
      for (let k = 0; k < 90; k++) {
        const d = m.sdf(sx, y, z);
        if (d < 0.003) { hit = true; break; }
        const st = Math.max(d, 0.004) * SQ;
        z -= st;
        y -= st;
        if (z < zMin - 0.02) break;
      }
      if (!hit) continue;
      const e = 0.006;
      let nx = m.sdf(sx + e, y, z) - m.sdf(sx - e, y, z);
      let ny = m.sdf(sx, y + e, z) - m.sdf(sx, y - e, z);
      let nz = m.sdf(sx, y, z + e) - m.sdf(sx, y, z - e);
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const mi = m.mat(sx, y, z);
      const mat = m.mats[mi] || m.mats[0];
      const ramp = mat.ramp;
      // flat ramp step: up-facing a bit lighter, plus pixel grain; lighting does the shading
      const g = (hashN(i, j, seed + mi * 31) - 0.5) * grain + (noise3(sx * 6, y * 6, z * 6, seed) - 0.5) * 0.8;
      let step = (ramp.length - 1) * 0.55 + nz * 0.9 + g + (mat.bias ?? 0);
      step = Math.max(0, Math.min(ramp.length - 1, Math.round(step)));
      s.set(i, j, rgb(ramp[step]), nx, ny, nz, z, mat.emit ?? null, mat.id ?? 0);
    }
  }
  if (m.outline !== 0) s.outline(m.outline ?? 0.6);
  return s;
}
