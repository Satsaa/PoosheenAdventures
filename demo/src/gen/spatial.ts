// Coarse space: a world is a grid of "screens"; a region is a connected set of screens.
// Space is partitioned FIRST, and the lock graph is then only allowed to use edges between
// regions that really touch. That is what makes the abstract graph embeddable without tricks.
import type { Rng } from '../core/rng';

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
