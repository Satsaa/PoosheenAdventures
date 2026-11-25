// Coarse space: a world is a grid of "screens"; a region is a connected set of screens.
// Space is partitioned FIRST, and the lock graph is then only allowed to use edges between
// regions that really touch. That is what makes the abstract graph embeddable without tricks.
import { valueNoise, type Rng } from '../core/rng';

export const SW = 12; // screen width in tiles
export const SH = 10; // screen height in tiles

export interface Partition {
  gw: number;
  gh: number;
  /** region index per screen, -1 = empty */
  cell: Int16Array;
  /** screens of each region */
  regions: number[][];
  /** pairs of touching regions, with the number of shared screen borders */
  adj: { a: number; b: number; len: number }[];
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function neighbours(gw: number, gh: number, s: number): number[] {
  const x = s % gw, y = (s / gw) | 0;
  const out: number[] = [];
  for (const [dx, dy] of N4) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) out.push(ny * gw + nx);
  }
  return out;
}

function finish(gw: number, gh: number, cell: Int16Array, n: number): Partition {
  const regions: number[][] = Array.from({ length: n }, () => []);
  const adjLen = new Map<string, number>();
  for (let s = 0; s < cell.length; s++) {
    const r = cell[s];
    if (r < 0) continue;
    regions[r].push(s);
    for (const t of neighbours(gw, gh, s)) {
      const q = cell[t];
      if (q > r) adjLen.set(r + ',' + q, (adjLen.get(r + ',' + q) ?? 0) + 1);
    }
  }
  const adj = [...adjLen].map(([k, len]) => {
    const [a, b] = k.split(',').map(Number);
    return { a, b, len };
  });
  return { gw, gh, cell, regions, adj };
}

/**
 * Grow `n` regions from seed screens until `budget` screens are used (or everything is).
 * `allowed` restricts growth, `seeds` pins the first screens of the first regions.
 */
export function growRegions(
  rng: Rng, gw: number, gh: number, n: number,
  opts: { budget?: number; seeds?: number[]; allowed?: (s: number) => boolean } = {},
): Partition {
  const total = gw * gh;
  const cell = new Int16Array(total).fill(-1);
  const allowed = opts.allowed ?? (() => true);
  const budget = Math.min(opts.budget ?? total, total);
  const seeds: number[] = (opts.seeds ?? []).slice(0, n);
  const dist = (a: number, b: number) => Math.abs((a % gw) - (b % gw)) + Math.abs(((a / gw) | 0) - ((b / gw) | 0));
  // remaining seeds: best of a few random candidates, far from existing ones
  while (seeds.length < n) {
    let best = -1, bestD = -1;
    for (let i = 0; i < 12; i++) {
      const s = rng.int(total);
      if (!allowed(s) || seeds.includes(s)) continue;
      const near = opts.budget !== undefined && seeds.length ? -Math.min(...seeds.map((t) => dist(s, t))) : 0;
      const d = opts.budget !== undefined ? near : seeds.length ? Math.min(...seeds.map((t) => dist(s, t))) : 99;
      if (d > bestD || best < 0) { best = s; bestD = d; }
    }
    if (best < 0) break;
    seeds.push(best);
  }
  seeds.forEach((s, i) => (cell[s] = i));
  const size = seeds.map(() => 1);
  let usedCount = seeds.length;
  while (usedCount < budget) {
    // the smallest region that can still grow takes one more screen
    const orderIdx = rng.shuffle(seeds.map((_, i) => i)).sort((a, b) => size[a] - size[b]);
    let grew = false;
    for (const r of orderIdx) {
      const frontier: number[] = [];
      for (let s = 0; s < total; s++) {
        if (cell[s] !== r) continue;
        for (const t of neighbours(gw, gh, s)) if (cell[t] < 0 && allowed(t)) frontier.push(t);
      }
      if (!frontier.length) continue;
      cell[rng.pick(frontier)] = r;
      size[r]++;
      usedCount++;
      grew = true;
      break;
    }
    if (!grew) break;
  }
  return finish(gw, gh, cell, seeds.length);
}

/** Random connected set of `count` cells on a small grid, starting at `start` (dungeon rooms). */
export function growBlob(rng: Rng, gw: number, gh: number, start: number, count: number): number[] {
  const set = [start];
  while (set.length < count) {
    const frontier = new Set<number>();
    for (const s of set) for (const t of neighbours(gw, gh, s)) if (!set.includes(t)) frontier.add(t);
    if (!frontier.size) break;
    set.push(rng.pick([...frontier]));
  }
  return set;
}

// ---------------------------------------------------------------- land shape
/**
 * Which screens of the rectangle are land. Grown outward from the middle, always taking the
 * screen that is closest to the centre after a noise nudge, so the land is one piece with an
 * irregular coast. Everything else becomes sea or mountain range.
 */
export function landMask(seed: number, gw: number, gh: number, count: number): Uint8Array {
  const total = gw * gh;
  const mask = new Uint8Array(total);
  if (count >= total) return mask.fill(1);
  const score = (s: number) => {
    const x = ((s % gw) + 0.5) / gw - 0.5, y = (((s / gw) | 0) + 0.5) / gh - 0.5;
    return Math.hypot(x, y) * 2 + (valueNoise(seed, (s % gw) * 0.37, ((s / gw) | 0) * 0.37) - 0.5) * 0.9;
  };
  const start = (gh >> 1) * gw + (gw >> 1);
  mask[start] = 1;
  const frontier = new Set(neighbours(gw, gh, start));
  for (let n = 1; n < count && frontier.size; n++) {
    let best = -1, bestScore = Infinity;
    for (const s of frontier) { const v = score(s); if (v < bestScore) { bestScore = v; best = s; } }
    frontier.delete(best);
    mask[best] = 1;
    for (const t of neighbours(gw, gh, best)) if (!mask[t]) frontier.add(t);
  }
  return mask;
}

// ---------------------------------------------------------------- rivers
// A river runs along the lines BETWEEN screens (a path on the lattice of screen corners).
// That makes it a border by construction: where it follows a region border it replaces the
// rim, and where it cuts through a region the region is split into two banks.

export interface River {
  /** lattice corners in flow order; corner index = cy * (gw + 1) + cx */
  corners: number[];
  /** one line per step: the two screens it separates */
  lines: { a: number; b: number }[];
  /** water level per line, never rising downstream */
  level: number[];
  /** stretch index per line; a new stretch starts at every drop (waterfall) */
  seg: number[];
}

export const lineKey = (a: number, b: number): number => (a < b ? a * 65536 + b : b * 65536 + a);

export function traceRivers(
  rng: Rng, part: Partition, elevOf: (region: number) => number, count: number,
  /** a course is kept only if the world still works with it, e.g. it cuts off no bank too small to use */
  accept: (rivers: River[]) => boolean = () => true,
): River[] {
  const { gw, gh } = part;
  const cw = gw + 1;
  const taken = new Set<number>(); // corners used by any river, plus their neighbours, so rivers never touch
  const rivers: River[] = [];
  // the river ends where it meets the sea: the map edge, or a corner that touches a screen outside the land
  const edge = (cx: number, cy: number) => {
    if (cx === 0 || cy === 0 || cx === gw || cy === gh) return true;
    for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) if (part.cell[(cy + oy) * gw + cx + ox] < 0) return true;
    return false;
  };
  /** a river bed needs land on both sides */
  const land = (l: { a: number; b: number }) => (part.cell[l.a] < 0 || part.cell[l.b] < 0 ? null : l);
  /** the two screens separated by the lattice step from (cx,cy) in direction d, or null if it is not an inner line */
  const sides = (cx: number, cy: number, dx: number, dy: number): { a: number; b: number } | null => {
    if (dx !== 0) {
      const x = dx > 0 ? cx : cx - 1;
      if (cy < 1 || cy > gh - 1 || x < 0 || x >= gw) return null;
      return land({ a: (cy - 1) * gw + x, b: cy * gw + x });
    }
    const y = dy > 0 ? cy : cy - 1;
    if (cx < 1 || cx > gw - 1 || y < 0 || y >= gh) return null;
    return land({ a: y * gw + cx - 1, b: y * gw + cx });
  };
  const levelOf = (l: { a: number; b: number }) => Math.min(elevOf(part.cell[l.a]), elevOf(part.cell[l.b]));

  for (let tries = 0; tries < count * 12 && rivers.length < count; tries++) {
    if (gw < 3 || gh < 3) break;
    // spring: a free inner corner, the highest of a few samples
    let start = -1, startLevel = -1;
    for (let i = 0; i < 8; i++) {
      const cx = rng.range(1, gw - 1), cy = rng.range(1, gh - 1), c = cy * cw + cx;
      if (taken.has(c) || edge(cx, cy)) continue;
      let best = -1;
      for (const [dx, dy] of N4) { const s = sides(cx, cy, dx, dy); if (s) best = Math.max(best, levelOf(s)); }
      if (best > startLevel) { startLevel = best; start = c; }
    }
    if (start < 0) continue;
    const r: River = { corners: [start], lines: [], level: [], seg: [] };
    const seen = new Set([start]);
    let cx = start % cw, cy = (start / cw) | 0, level = 99, pdx = 0, pdy = 0;
    for (let step = 0; step < gw + gh + 8; step++) {
      const opts: { dx: number; dy: number; l: { a: number; b: number }; lv: number; w: number }[] = [];
      for (const [dx, dy] of N4) {
        const nx = cx + dx, ny = cy + dy, n = ny * cw + nx;
        const l = sides(cx, cy, dx, dy);
        if (!l || seen.has(n) || taken.has(n)) continue;
        const lv = levelOf(l);
        if (lv > level) continue; // water does not flow uphill
        const toEdge = Math.min(nx, ny, gw - nx, gh - ny), nowEdge = Math.min(cx, cy, gw - cx, gh - cy);
        let w = 1;
        if (dx === pdx && dy === pdy) w *= 1.6; // keeps courses from zig-zagging
        if (toEdge < nowEdge) w *= 1.8; // rivers head for the sea
        if (part.cell[l.a] !== part.cell[l.b]) w *= 1.3; // existing borders are natural beds, but not the only ones
        opts.push({ dx, dy, l, lv, w });
      }
      if (!opts.length) break;
      const o = rng.weighted(opts, (x) => x.w);
      cx += o.dx; cy += o.dy; pdx = o.dx; pdy = o.dy;
      r.seg.push(r.level.length && o.lv < level ? r.seg[r.seg.length - 1] + 1 : r.seg.length ? r.seg[r.seg.length - 1] : 0);
      level = o.lv;
      r.lines.push(o.l); r.level.push(o.lv);
      r.corners.push(cy * cw + cx);
      seen.add(cy * cw + cx);
      if (edge(cx, cy)) break; // flows off the map
    }
    if (r.lines.length < 3 || !accept([...rivers, r])) continue;
    rivers.push(r);
    for (const c of r.corners) {
      const x = c % cw, y = (c / cw) | 0;
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) taken.add(yy * cw + xx);
    }
  }
  return rivers;
}

/**
 * Regions that a river cuts in two become two regions (two banks). Returns the refined
 * partition and, for each new region, the region it came from.
 */
export function splitByRivers(part: Partition, rivers: River[]): { part: Partition; origin: number[] } {
  const { gw, gh } = part;
  const wet = new Set<number>();
  for (const r of rivers) for (const l of r.lines) wet.add(lineKey(l.a, l.b));
  const cell = new Int16Array(part.cell.length).fill(-1);
  const origin: number[] = [];
  for (let s = 0; s < cell.length; s++) {
    if (part.cell[s] < 0 || cell[s] >= 0) continue;
    const id = origin.length;
    origin.push(part.cell[s]);
    const stack = [s];
    cell[s] = id;
    while (stack.length) {
      const u = stack.pop()!;
      for (const v of neighbours(gw, gh, u)) {
        if (cell[v] >= 0 || part.cell[v] !== part.cell[s] || wet.has(lineKey(u, v))) continue;
        cell[v] = id;
        stack.push(v);
      }
    }
  }
  return { part: finish(gw, gh, cell, origin.length), origin };
}
