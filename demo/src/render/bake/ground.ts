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
  [T.WATER]: ['#17507a', '#1f6a96', '#2a85ae', '#3fa3c6'],
  [T.DEEP]: ['#050f26', '#081a3a', '#0c2550', '#123166'],
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
          // cave wall tops: one shared cell pattern for every variant, so a thick wall reads as one rock mass
          const [d1, d2] = voro(x, y, 2, g === T.CAVEWALL ? 11 : seed + 5);
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
          // clear and calm: two close shades in broad blotches (the shader adds slow swells)
          h = 0;
          st = top * 0.5 + (n1 - 0.5) * 0.7;
          break;
        case T.DEEP: {
          // rough: dark, choppy ridges with whitecaps
          const ridge = Math.sin((x * 0.8 + y * 1.3 + n1 * 6) * 1.4);
          h = ridge * 0.01;
          st = top * 0.4 + (n2 - 0.5) * 1.4 + ridge * 0.5;

          break;
        }
        case T.FLOOR: {
          const bx = Math.floor(x / 8), by = Math.floor(y / 8);
          const gx = x % 8, gy = y % 8;
          const grout = gx === 0 || gy === 0;
          h = grout ? 0 : 0.02 + (gx === 1 || gy === 1 ? 0.005 : 0);
          st = grout ? 0 : 1.6 + hashN(bx, by, seed) * 1.4 + (n2 - 0.5) * 0.7;
          break;
        }
        case T.WALL: {
          // flagstone wall top on an 8 px grid (2 x 2 per tile, rows offset by 4): seamless across tiles,
          // so thick walls read as one paved mass; the coping rim is added on exposed edges by the composer
          const row = Math.floor(y / 8);
          const off = (row & 1) * 4;
          const gx = (x + off) % 8, gy = y % 8;
          const grout = gx === 0 || gy === 0;
          h = grout ? 0 : 0.02;
          st = grout ? 0.6 : 1.6 + hashN(Math.floor((x + off) / 8) + v * 3, row, seed) * 1.1 + (n2 - 0.5) * 0.4;
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
  const pre = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) pre[i] = S[i] === -1 ? 1 : 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const hx = H[y * N + ((x + 1) % N)] - H[y * N + ((x + N - 1) % N)];
      const hy = H[((y + 1) % N) * N + x] - H[((y + N - 1) % N) * N + x];
      const k = 0.5 * N * 2.2;
      if (pre[i]) continue; // whitecap pixel already written
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
        const deep = g === T.DEEP;
        s.set(x, r, rgb(GROUND_RAMP[deep ? T.DEEP : T.WATER][Math.min(3, st)]), 0, 1, 0.15, 0, streak ? [40, 70, 90] : null, deep ? MAT.WATER : MAT.FALL);
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
        // between the posts: the dark gap under the bridge deck
        if (!post) { s.set(x, r, r < 3 ? [20, 12, 6] : [10, 18, 30], 0, 1, 0, 0, null, 0); continue; }
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

/** Corner blend mask: a rounded quarter blob in corner `c` (0 NW, 1 NE, 2 SE, 3 SW) where a diagonal neighbour bleeds in. */
export function cornerMask(c: number, v: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  const r = 4.5 + hashN(c, v, 95) * 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = c === 0 || c === 3 ? x + 0.5 : N - (x + 0.5);
      const w = c === 0 || c === 1 ? y + 0.5 : N - (y + 0.5);
      if (Math.hypot(u, w) < r) s.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
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
      let inside = w < (foam ? 1.9 : 0.6);
      for (const [px, py, r] of pts) if (Math.hypot(u - px, w - py) < r) inside = true;
      if (!inside) continue;
      if (foam) s.set(x, y, [178, 198, 208], 0, 0, 1, 0.01, null, MAT.FOAM);
      else s.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
    }
  return s;
}

// ---------------------------------------------------------------- autotile pieces for raised edges
// Every raised edge (dungeon wall, cave wall, cliff of any ground) is drawn from sheet pieces chosen by
// the composer from the 8 neighbours. All pieces are 16 px heightfield sprites like the ground tiles
// (albedo, normal, height, emissive), so lighting and shadows use them; real art can replace any key.

export type Shape = 'round' | 'chamfer' | 'rock';
/** outer-corner radius in px per shape */
export const SHAPE_R: Record<Shape, number> = { round: 3, chamfer: 3, rock: 5 };
export function shapeOf(g: number): Shape {
  return g === T.WALL || g === T.FLOOR || g === T.PLANK ? 'chamfer' : g === T.CAVEWALL || g === T.CAVE || g === T.CLOUD ? 'rock' : 'round';
}
/** grounds that get raised-edge pieces */
export const EDGE_GROUNDS = [T.GRASS, T.SAND, T.DIRT, T.STONE, T.SNOW, T.FLOOR, T.WALL, T.CAVE, T.CAVEWALL, T.CLOUD, T.PATH, T.PLANK, T.SWAMP];

/** is pixel (x, y) of a tile inside the cut-away part of corner c (0 NW, 1 NE, 2 SE, 3 SW)? */
export function inCut(shape: Shape, c: number, x: number, y: number): boolean {
  const r = SHAPE_R[shape];
  const u = c === 0 || c === 3 ? x : N - x, v = c <= 1 ? y : N - y;
  if (u >= r || v >= r) return false;
  return shape === 'chamfer' ? u + v < r : Math.hypot(r - u, r - v) > r;
}
/** distance from pixel (x, y) to the cut edge of corner c (only meaningful near the corner) */
function arcDist(shape: Shape, c: number, x: number, y: number): number {
  const r = SHAPE_R[shape];
  const u = c === 0 || c === 3 ? x : N - x, v = c <= 1 ? y : N - y;
  if (u >= r + 3 || v >= r + 3) return 99;
  return shape === 'chamfer' ? (u + v - r) * 0.7071 : r - Math.hypot(r - u, r - v);
}

/** top silhouette mask `wm:<shape>:<bits>` (bits: 1 NW, 2 NE, 4 SE, 8 SW corners cut away) */
export function topMask(shape: Shape, bits: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let cut = false;
      for (let c = 0; c < 4; c++) if (bits & (1 << c) && inCut(shape, c, x + 0.5, y + 0.5)) cut = true;
      if (!cut) s.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
    }
  return s;
}

const COPING: Record<number, string[]> = {
  [T.WALL]: ['#4a4458', '#6a6280', '#8a83a2', '#a8a2c0'],
  [T.FLOOR]: ['#4a4458', '#6a6280', '#8a83a2', '#a8a2c0'],
};

/**
 * Rim piece of a raised top: `w:<g>:e<0-3>` straight edge N E S W, `w:<g>:oc<0-3>` outer corner (rim
 * along the cut), `w:<g>:ic<0-3>` inner corner (the rim turning a concave corner). Corners 0 NW 1 NE 2 SE 3 SW.
 */
export function rimPiece(g: number, kind: 'e' | 'oc' | 'ic', i: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  const ramp = COPING[g] || GROUND_RAMP[g] || GROUND_RAMP[T.STONE];
  const top = ramp.length - 1;
  const shape = shapeOf(g);
  const wall = shape === 'chamfer';
  const rw = wall ? 3 : 2;
  const mat = groundMat(g) === MAT.FOLIAGE ? MAT.FOLIAGE : MAT.DIFFUSE;
  const put = (x: number, y: number, st: number, nx: number, ny: number, h: number) =>
    s.set(x, y, rgb(ramp[Math.max(0, Math.min(top, st))]), nx, ny, 1, h, null, mat);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;
      const j = hashN(x, y, g * 7 + i) < 0.2 ? -1 : 0;
      if (kind === 'e') {
        // lit lip on north / west, a dark seam on east, a thin highlight on the south lip
        if (i === 0 && py < rw) put(x, y, top + j, 0, -0.8, 0.04);
        else if (i === 0 && py < rw + 1) put(x, y, 0, 0, 0.3, 0.0);
        else if (i === 3 && px < rw) put(x, y, top - 1 + j, -0.8, 0, 0.04);
        else if (i === 3 && px < rw + 1) put(x, y, 0, 0.3, 0, 0.0);
        else if (i === 1 && px > N - 1.5) put(x, y, 0, 0.9, 0, 0.0);
        else if (i === 2 && py > N - 1.5) put(x, y, top - 1, 0, 0.8, 0.02);
      } else if (kind === 'oc') {
        if (inCut(shape, i, px, py)) continue;
        const d = arcDist(shape, i, px, py);
        const north = i <= 1;
        const nx = i === 0 || i === 3 ? -0.6 : 0.6, ny = north ? -0.6 : 0.6;
        if (d < (north ? rw : 1.2)) put(x, y, north ? top + j : top - 2, nx, ny, 0.03);
        else if (north && d < rw + 1) put(x, y, 0, 0, 0, 0);
      } else {
        const u = i === 0 || i === 3 ? px : N - px, v = i <= 1 ? py : N - py;
        if (u < rw && v < rw) put(x, y, i <= 1 ? top + j : top - 2, i === 0 || i === 3 ? -0.5 : 0.5, i <= 1 ? -0.5 : 0.5, 0.03);
      }
    }
  return s;
}

export const FACE_OFF = 3;
/**
 * South face piece `wf:<g>:<L><R>` with end types p (continues), o (outer corner: the face follows the
 * rounded / chamfered top corner, columns recede and shift up), i (inner corner: a darker crease).
 * FACE_OFF extra rows on top hold the shifted columns of 'o' ends; rows FACE_OFF.. match `f:<g>` rows.
 */
export function facePiece(g: number, v: number, L: string, R: string): Sprite {
  const base = faceStrip(g, v);
  const s = new Sprite(N, FACE_PX + FACE_OFF, 0, FACE_OFF);
  const shape = shapeOf(g), r = SHAPE_R[shape];
  const recede = (u: number) => (u >= r ? 0 : shape === 'chamfer' ? r - u : r - Math.sqrt(Math.max(0, r * r - (r - u) * (r - u))));
  for (let x = 0; x < N; x++) {
    const uL = x + 0.5, uR = N - x - 0.5;
    const d = Math.round(Math.max(L === 'o' ? recede(uL) : 0, R === 'o' ? recede(uR) : 0));
    const shadeL = L === 'o' && uL < r ? 1.25 : L === 'i' && x < 2 ? (x === 0 ? 0.5 : 0.72) : 1;
    const shadeR = R === 'o' && uR < r ? 0.6 : R === 'i' && x > N - 3 ? (x === N - 1 ? 0.5 : 0.72) : 1;
    const k = shadeL * shadeR;
    for (let row = 0; row < FACE_PX; row++) {
      const so = (row * N + x) * 4;
      if (!base.alb[so + 3]) continue;
      const dr = row + FACE_OFF - d;
      if (dr < 0 || dr >= FACE_PX + FACE_OFF - d) continue;
      const di = (dr * N + x) * 4;
      s.alb[di] = Math.min(255, base.alb[so] * k); s.alb[di + 1] = Math.min(255, base.alb[so + 1] * k); s.alb[di + 2] = Math.min(255, base.alb[so + 2] * k); s.alb[di + 3] = 255;
      let nx = base.nrm[so] / 127.5 - 1;
      if (L === 'o' && uL < r) nx -= 0.7; if (R === 'o' && uR < r) nx += 0.7;
      if (L === 'i' && x < 2) nx += 0.5; if (R === 'i' && x > N - 3) nx -= 0.5;
      const ny = base.nrm[so + 1] / 127.5 - 1, nz = base.nrm[so + 2] / 127.5 - 1, l = Math.hypot(nx, ny, nz) || 1;
      s.nrm[di] = (nx / l) * 127.5 + 127.5; s.nrm[di + 1] = (ny / l) * 127.5 + 127.5; s.nrm[di + 2] = (nz / l) * 127.5 + 127.5; s.nrm[di + 3] = base.nrm[so + 3];
      for (let c = 0; c < 4; c++) s.emi[di + c] = base.emi[so + c];
    }
  }
  return s;
}

/**
 * Wall-foot base `wb:<bits>` (bits 1 N, 2 E, 4 W, 8 NW, 16 NE: which neighbours are higher): an albedo
 * multiplier for the ground at the foot of a wall or cliff (white = unchanged), with matching inner and
 * outer corners.
 */
export function basePiece(bits: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;
      let k = 0;
      if (bits & 1) k = Math.max(k, 1 - py / 3.5);
      if (bits & 2) k = Math.max(k, 1 - (N - px) / 2.5);
      if (bits & 4) k = Math.max(k, 1 - px / 2.5);
      if (bits & 8) k = Math.max(k, 1 - Math.hypot(px, py) / 3.5);
      if (bits & 16) k = Math.max(k, 1 - Math.hypot(N - px, py) / 3.5);
      const m = Math.round(255 * (1 - Math.max(0, Math.min(1, k)) * 0.45));
      s.set(x, y, [m, m, Math.min(255, m + 6)], 0, 0, 1, 0, null, 0);
    }
  return s;
}

/** Inner-corner blend mask `mi:<c>`: fills the concave corner where two edges of the same neighbour meet. */
export function innerMask(c: number): Sprite {
  const s = new Sprite(N, N, 0, 0);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = c === 0 || c === 3 ? x + 0.5 : N - (x + 0.5), v = c <= 1 ? y + 0.5 : N - (y + 0.5);
      if (u < 7 && v < 7 && Math.hypot(7 - u, 7 - v) > 3.5) s.set(x, y, [255, 255, 255], 0, 0, 1, 0, null, 0);
    }
  return s;
}
