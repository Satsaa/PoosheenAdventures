// Ground tiles (heightfields), cliff face strips and edge masks, rendered into 16 px sprites.
import { T } from '../../core/types';
import { MAT, Sprite, TILE_PX } from './sheet';
import { hashN, rgb } from './sdf';

const N = TILE_PX;

/** periodic value noise on the 16 px tile: cell = lattice spacing in px (divides 16) */
function pnoise(x: number, y: number, cell: number, seed: number): number {
  const p = N / cell;
  const fx = x / cell, fy = y / cell;
  const xi = Math.floor(fx), yi = Math.floor(fy);
  const tx = fx - xi, ty = fy - yi;
  const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
  const h = (a: number, b: number) => hashN(((a % p) + p) % p, ((b % p) + p) % p, seed);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** periodic Voronoi: [distance to nearest, distance to 2nd nearest, cell id] in px */
function voro(x: number, y: number, cells: number, seed: number): [number, number, number] {
  const cs = N / cells;
  const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
  let d1 = 1e9, d2 = 1e9, id = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
      const px = (gx + 0.2 + hashN(wx, wy, seed) * 0.6) * cs, py = (gy + 0.2 + hashN(wx, wy, seed + 7) * 0.6) * cs;
      const d = Math.hypot(x - px, y - py);
      if (d < d1) { d2 = d1; d1 = d; id = wx + wy * cells; } else if (d < d2) d2 = d;
    }
  return [d1, d2, id];
}

export const GROUND_RAMP: Record<number, string[]> = {
  [T.GRASS]: ['#1c3a2c', '#265238', '#336c40', '#478a44', '#69a84c'],
  [T.SAND]: ['#6a4c36', '#937046', '#ba955a', '#d8b975'],
  [T.DIRT]: ['#38241a', '#52341f', '#6c4729', '#875c36'],
  [T.STONE]: ['#2a2a36', '#3b3c4b', '#525465', '#6d7083'],
  [T.SNOW]: ['#6a80a6', '#94abc9', '#c2d3e7', '#e8f1fb'],
  [T.WATER]: ['#0e2c50', '#154471', '#1d5a8d', '#2c76ab'],
  [T.DEEP]: ['#071733', '#0b244a', '#10325f', '#163f72'],
  [T.FLOOR]: ['#36291f', '#4d3a2b', '#644c37', '#7b6046'],
  [T.WALL]: ['#2c2838', '#3f394d', '#554e67', '#6d6582'],
  [T.CAVE]: ['#16131d', '#1f1a28', '#2a2434', '#362e42'],
  [T.CAVEWALL]: ['#272035', '#372e4c', '#4a3f63', '#5e5279'],
  [T.CLOUD]: ['#8d9dd0', '#b5c2ea', '#d9e2fb', '#f3f6ff'],
  [T.PATH]: ['#57402f', '#77593c', '#97744e', '#b08c60'],
  [T.LAVA]: ['#3a0e06', '#771c08', '#c03a0b', '#ff7618'],
  [T.PLANK]: ['#382011', '#58351b', '#784b27', '#916033'],
  [T.SWAMP]: ['#18281d', '#233628', '#304731', '#425c3a'],
};

const FACE_RAMP = {
  earth: ['#3a2316', '#55331f', '#74482b', '#91603a', '#ad7a4c'],
  sandstone: ['#6a4a30', '#8a6440', '#aa8052', '#c89c66'],
  rock: ['#34343f', '#474856', '#5d5f70', '#76798c'],
  ice: ['#3c4a6c', '#52648a', '#6e84ac', '#94a8cc'],
  brick: ['#2a2433', '#3a3346', '#4b425a', '#5e546e'],
  cave: ['#221c2c', '#2e263b', '#3b304b', '#4a3d5d'],
  cloud: ['#7b8ac0', '#97a6d6', '#b8c5ec', '#dce4fb'],
  wood: ['#1e1209', '#2e1c0e', '#432a15'],
};

/** ground material id of a tile */
export function groundMat(g: number): number {
  return g === T.WATER || g === T.DEEP ? MAT.WATER : g === T.LAVA ? MAT.LAVA : g === T.CLOUD ? MAT.CLOUD : g === T.GRASS ? MAT.FOLIAGE : MAT.DIFFUSE;
}

/** Render one 16x16 ground tile variant. */
export function groundTile(g: number, v: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  const ramp = GROUND_RAMP[g] || GROUND_RAMP[T.STONE];
  const seed = g * 101 + v * 17 + 3;
  const H = new Float32Array(N * N); // height (tiles)
  const S = new Float32Array(N * N); // ramp step (float)
  const E: ([number, number, number] | null)[] = new Array(N * N).fill(null);
  const M = new Uint8Array(N * N).fill(groundMat(g));
  const top = ramp.length - 1;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const n1 = pnoise(x, y, 8, seed), n2 = pnoise(x, y, 4, seed + 1), r = hashN(x, y, seed + 2);
      let h = 0, st = top * 0.5 + (n1 - 0.5) * 1.4 + (n2 - 0.5) * 0.8;
      switch (g) {
        case T.GRASS: {
          h = n1 * 0.03;
          st = top * 0.5 + (n1 - 0.5) * 1.1 + (n2 - 0.5) * 0.5;
          if (r < 0.12) { h += 0.05; st += 1; }
          else if (r > 0.95) { st -= 1; }
          break;
        }
        case T.SAND: {
          const rip = Math.sin((x * 0.9 + y * 0.35 + n1 * 5) * 1.3);
          h = rip * 0.006 + n2 * 0.01;
          st = top * 0.55 + (n1 - 0.5) * 1.0 + rip * 0.22 + (r < 0.04 ? -1 : r > 0.97 ? 1 : 0);
          break;
        }
        case T.DIRT:
        case T.PATH: {
          const [d1] = voro(x, y, 4, seed + 4);
          const peb = d1 < 1.3 && hashN(Math.floor(x / 4), Math.floor(y / 4), seed) < 0.55;
          h = n1 * 0.02 + (peb ? 0.03 : 0);
          st += peb ? 1.3 : 0;
          if (r < 0.08) st -= 1.2;
          break;
        }
        case T.STONE:
        case T.CAVEWALL: {
          const [d1, d2] = voro(x, y, 2, seed + 5);
          const e = d2 - d1;
          h = Math.min(e, 2.5) * 0.015;
          st = top * 0.55 + Math.min(e, 3) * 0.2 - 0.3 + (n2 - 0.5) * 0.6;
          if (e < 0.7) st -= 0.8;
          break;
        }
        case T.SNOW:
          h = n1 * 0.03 + n2 * 0.01;
          st = top * 0.62 + (n1 - 0.5) * 1.0 + (n2 - 0.5) * 0.6 + (r > 0.97 ? 1 : 0);
          break;
        case T.WATER:
        case T.DEEP:
          h = 0;
          st = top * 0.45 + (n1 - 0.5) * 1.2;
          break;
        case T.FLOOR: {
          const bx = Math.floor(x / 8), by = Math.floor(y / 8);
          const gx = x % 8, gy = y % 8;
          const grout = gx === 0 || gy === 0;
          h = grout ? 0 : 0.02 + (gx === 1 || gy === 1 ? 0.005 : 0);
          st = grout ? 0 : 1.6 + hashN(bx, by, seed) * 1.4 + (n2 - 0.5) * 0.7;
          break;
        }
        case T.WALL: {
          const row = Math.floor(y / 6);
          const off = (row & 1) * 4;
          const gx = (x + off) % 8, gy = y % 6;
          const grout = gx === 0 || gy === 0;
          h = grout ? 0 : 0.03;
          st = grout ? 0.2 : 1.5 + hashN(Math.floor((x + off) / 8), row, seed) * 1.5 + (n2 - 0.5) * 0.6;
          break;
        }
        case T.CAVE: {
          const [d1, d2] = voro(x, y, 3, seed + 8);
          const e = d2 - d1;
          h = n1 * 0.02 + Math.min(e, 2) * 0.015;
          st = top * 0.5 + (n1 - 0.5) * 0.9 + Math.min(e, 2) * 0.35 - 0.35 + (r < 0.06 ? 1 : 0);
          if (e < 0.6) st -= 1;
          break;
        }
        case T.CLOUD: {
          const p = Math.max(0, 1 - Math.hypot((x % 8) - 4, (y % 8) - 4) / 5.2);
          h = p * 0.06 + n1 * 0.03;
          st = top * 0.55 + p * 1.6 + (n1 - 0.5) * 0.8;
          break;
        }
        case T.LAVA: {
          const [d1, d2] = voro(x, y, 3, seed + 6);
          const e = d2 - d1;
          const crust = e > 1.6 && n2 > 0.35;
          h = crust ? 0.03 : 0;
          st = crust ? 0.6 + (n1 - 0.5) : top - (e < 0.8 ? 0 : 1) + (n1 > 0.6 ? 0 : 0);
          if (!crust) {
            const k = e < 0.9 ? 1 : 0.6;
            E[i] = [255 * k, (110 + 80 * (1 - Math.min(1, e / 2))) * k, 20 * k];
          }
          M[i] = MAT.LAVA;
          break;
        }
        case T.PLANK: {
          const row = Math.floor(y / 4);
          const gap = y % 4 === 0;
          const seam = (x + row * 5) % 16 === 0;
          h = gap || seam ? 0 : 0.02;
          st = gap || seam ? 0 : 1.4 + hashN(row, Math.floor((x + row * 5) / 16), seed) * 1.2 + (n2 - 0.5) * 0.8;
          if (!gap && (x + row * 5) % 16 === 2 && y % 4 === 2) st = 3;
          break;
        }
        case T.SWAMP: {
          const pool = n1 < 0.38;
          h = pool ? 0 : 0.02 + n2 * 0.02;
          st = pool ? 0.5 : 1.5 + (n2 - 0.5) * 1.5 + (r < 0.12 ? 1 : 0);
          if (pool) M[i] = MAT.WATER;
          break;
        }
      }
      H[i] = h;
      S[i] = st;
    }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const hx = H[y * N + ((x + 1) % N)] - H[y * N + ((x + N - 1) % N)];
      const hy = H[((y + 1) % N) * N + x] - H[((y + N - 1) % N) * N + x];
      const k = 0.5 * N * 2.2;
      const st = Math.max(0, Math.min(top, Math.round(S[i])));
      s.set(x, y, rgb(ramp[st]), -hx * k, -hy * k, 1, H[i], E[i], M[i]);
    }
  return s;
}

function faceKind(g: number): keyof typeof FACE_RAMP | 'water' | 'lava' {
  switch (g) {
    case T.SAND: return 'sandstone';
    case T.STONE: return 'rock';
    case T.SNOW: return 'ice';
    case T.WATER: case T.DEEP: return 'water';
    case T.LAVA: return 'lava';
    case T.FLOOR: case T.WALL: return 'brick';
    case T.CAVE: case T.CAVEWALL: return 'cave';
    case T.CLOUD: return 'cloud';
    case T.PLANK: return 'wood';
    default: return 'earth';
  }
}

export const FACE_PX = 48;

/** Cliff face strip (16 x 48) below a tile of ground g: lip of the top material, then the wall. */
export function faceStrip(g: number, v: number): Sprite {
  const s = new Sprite(N, FACE_PX, 0, 0);
  const kind = faceKind(g);
  const seed = g * 73 + v * 11 + 5;
  const lipRamp = GROUND_RAMP[g] || GROUND_RAMP[T.STONE];
  const hasLip = g === T.GRASS || g === T.SNOW || g === T.SWAMP || g === T.SAND || g === T.CLOUD || g === T.DIRT || g === T.PATH;
  for (let r = 0; r < FACE_PX; r++)
    for (let x = 0; x < N; x++) {
      const n1 = pnoise(x, r % 16, 8, seed + Math.floor(r / 16)), rr = hashN(x, r, seed);
      // drips of the lip
      const lipLen = hasLip ? 1 + Math.floor(hashN(x >> 1, 0, seed) * 3) : 0;
      if (r < lipLen) {
        const st = Math.min(lipRamp.length - 1, 2 + (r === 0 ? 1 : 0));
        s.set(x, r, rgb(lipRamp[st]), 0, 0.5, 0.85, 0, null, groundMat(g) === MAT.WATER ? MAT.DIFFUSE : groundMat(g));
        continue;
      }
      if (kind === 'water') {
        const streak = hashN(x, 0, seed) < 0.3 || (rr < 0.08);
        const st = streak ? 3 : 1 + Math.round(n1);
        s.set(x, r, rgb(GROUND_RAMP[T.WATER][Math.min(3, st)]), 0, 1, 0.15, 0, streak ? [40, 70, 90] : null, MAT.WATER);
        continue;
      }
      if (kind === 'lava') {
        const streak = hashN(x, 0, seed) < 0.45;
        s.set(x, r, rgb(GROUND_RAMP[T.LAVA][streak ? 3 : 2]), 0, 1, 0, 0, streak ? [255, 150, 40] : [190, 60, 10], MAT.LAVA);
        continue;
      }
      const ramp = FACE_RAMP[kind];
      const top = ramp.length - 1;
      let st: number, nx = 0, nz = 0;
      if (kind === 'brick') {
        const row = Math.floor(r / 5), off = (row & 1) * 4;
        const gx = (x + off) % 8, gy = r % 5;
        const grout = gx === 0 || gy === 0;
        st = grout ? 0 : 1 + hashN(Math.floor((x + off) / 8), row, seed) * 2;
        if (gy === 1 && !grout) { nz = 0.6; st += 0.6; }
        if (gx === 1 && !grout) nx = -0.5;
      } else if (kind === 'wood') {
        const post = x >= 2 && x <= 4 || x >= 11 && x <= 13;
        st = post ? 2 : 0;
        if (!post) { s.set(x, r, [0, 0, 0], 0, 1, 0, 0, null, 0); s.alb[(r * N + x) * 4 + 3] = 0; continue; }
        nx = x === 2 || x === 11 ? -0.6 : x === 4 || x === 13 ? 0.6 : 0;
      } else if (kind === 'cloud') {
        st = 2 + (n1 - 0.5) * 2;
        nz = -0.3;
      } else {
        // rock strata with blocky ledges
        const band = Math.floor((r + hashN(x >> 2, 3, seed) * 3) / 5);
        const bandTop = (r + Math.floor(hashN(x >> 2, 3, seed) * 3)) % 5 === 0;
        st = top * 0.5 + (hashN(band, x >> 3, seed) - 0.5) * 1.6 + (n1 - 0.5) * 1.2;
        if (bandTop) { nz = 0.8; st += 1.2; }
        if (rr < 0.05) st -= 1.5;
        const crack = (x + band * 3) % 7 === 0 && hashN(band, x, seed) < 0.5;
        if (crack) { st -= 2; nx = 0.5; }
      }
      st = Math.max(0, Math.min(top, Math.round(st)));
      s.set(x, r, rgb(ramp[st]), nx, 1, nz, 0, null, kind === 'cloud' ? MAT.CLOUD : 0);
    }
  return s;
}

/** Edge blend mask: alpha = where the neighbour on side `dir` (0 N, 1 E, 2 S, 3 W) bleeds in. foam=true -> wider foam ring. */
export function edgeMask(dir: number, v: number, foam: boolean): Sprite {
  const s = new Sprite(N, N, 0, 0);
  const pts: [number, number, number][] = [];
  for (let k = 0; k < 4; k++) {
    const t = (k + 0.2 + hashN(k, v, 91) * 0.6) / 4;
    const depth = 0.5 + hashN(k, v, 92) * 1.8;
    const rad = 2.4 + hashN(k, v, 93) * 2.0 + (foam ? 1.3 : 0);
    pts.push([t * N, depth - rad * 0.35, rad]);
  }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      // rotate so dir 0 is the north edge
      let u = x + 0.5, w = y + 0.5;
      if (dir === 1) { u = y + 0.5; w = N - (x + 0.5); }
      else if (dir === 2) { u = N - (x + 0.5); w = N - (y + 0.5); }
      else if (dir === 3) { u = N - (y + 0.5); w = x + 0.5; }
      let inside = w < (foam ? 1.6 : 0.6);
      for (const [px, py, r] of pts) if (Math.hypot(u - px, w - py) < r) inside = true;
      if (!inside) continue;
      if (foam) s.set(x, y, hashN(x, y, 7) < 0.25 ? [200, 230, 245] : [232, 246, 255], 0, 0, 1, 0.01, null, MAT.DIFFUSE);
      else s.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
    }
  return s;
}
