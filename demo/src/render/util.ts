// Small helpers shared by the renderer: hashing, colour maths, easing.

/** Deterministic hash of an integer pair (+ salt) to [0,1). */
export function hash2(x: number, y: number, s = 0): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 0x27d4eb2d);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/** Tiny seeded PRNG for per-tile detail placement. */
export function prng(seed: number): () => number {
  let s = (seed * 4294967296) >>> 0 || 1;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export type RGB = [number, number, number];

const rgbCache = new Map<string, RGB>();
export function hexRgb(hex: string): RGB {
  let c = rgbCache.get(hex);
  if (c) return c;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (!Number.isFinite(n)) c = [128, 128, 128];
  rgbCache.set(hex, c);
  return c;
}

export function rgbStr(c: RGB, a = 1): string {
  const r = clamp(Math.round(c[0]), 0, 255), g = clamp(Math.round(c[1]), 0, 255), b = clamp(Math.round(c[2]), 0, 255);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** Lighten (amt>0) or darken (amt<0) a hex colour; amt in [-1,1]. */
export function shade(hex: string, amt: number, a = 1): string {
  const c = hexRgb(hex);
  const t = amt < 0 ? 0 : 255;
  const k = Math.abs(amt);
  return rgbStr([c[0] + (t - c[0]) * k, c[1] + (t - c[1]) * k, c[2] + (t - c[2]) * k], a);
}

export function mixHex(a: string, b: string, t: number, alpha = 1): string {
  const x = hexRgb(a), y = hexRgb(b);
  return rgbStr([lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)], alpha);
}

export function withAlpha(hex: string, a: number): string {
  return rgbStr(hexRgb(hex), a);
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const x = c.getContext('2d');
  if (!x) throw new Error('2d context unavailable');
  return x;
}

export const FONT = "'Space Grotesk', 'Inter', system-ui, sans-serif";
