// Stacked worlds (overworld / underworld / sky) share one tile grid, so a staircase is at the
// same x,y on both sides. This file: region shapes, borders, and the gated openings in them.
import { D, T, type Dimension, type LocId } from '../core/types';
import { Rng, childSeed, valueNoise } from '../core/rng';
import type { StackBP } from './blueprint';
import { FILL, SH, SW, lineKey } from './spatial';

export interface BiomeStyle {
  ground: number;
  /** what the solid rim of the region is made of */
  rim: number[];
  rimGround?: number;
  /** how far the rim stands above the region's ground (built walls) */
  rimRise?: number;
  solid: number[];
  soft: number[];
  density: number;
  pond?: number;
}

export const STYLES: Record<string, BiomeStyle> = {
  plains: { ground: T.GRASS, rim: [D.TREE], solid: [D.TREE, D.ROCK], soft: [D.TUFT, D.FLOWER, D.FLOWER], density: 0.025 },
  forest: { ground: T.GRASS, rim: [D.TREE, D.PINE], solid: [D.TREE, D.PINE], soft: [D.TUFT, D.MUSHROOM], density: 0.08 },
  mountain: { ground: T.STONE, rim: [D.ROCK], solid: [D.ROCK], soft: [D.TUFT], density: 0.05 },
  lake: { ground: T.SWAMP, rim: [], rimGround: T.DEEP, solid: [D.REED], soft: [D.REED, D.TUFT], density: 0.03, pond: T.WATER },
  desert: { ground: T.SAND, rim: [D.ROCK, D.CACTUS], solid: [D.CACTUS, D.ROCK], soft: [], density: 0.035 },
  snow: { ground: T.SNOW, rim: [D.PINE], solid: [D.PINE, D.ROCK], soft: [], density: 0.045 },
  badlands: { ground: T.DIRT, rim: [D.ROCK], solid: [D.DEADTREE, D.ROCK], soft: [D.TUFT], density: 0.045 },
  beach: { ground: T.SAND, rim: [], rimGround: T.DEEP, solid: [D.PALM, D.ROCK], soft: [D.TUFT], density: 0.03 },
  cavern: { ground: T.CAVE, rim: [], rimGround: T.CAVEWALL, solid: [D.STALAG], soft: [D.MUSHROOM], density: 0.04 },
  flooded: { ground: T.CAVE, rim: [], rimGround: T.CAVEWALL, solid: [D.STALAG], soft: [D.MUSHROOM], density: 0.02, pond: T.WATER },
  crystal: { ground: T.CAVE, rim: [], rimGround: T.CAVEWALL, solid: [D.CRYSTAL, D.STALAG], soft: [], density: 0.05 },
  magma: { ground: T.CAVE, rim: [], rimGround: T.CAVEWALL, solid: [D.STALAG], soft: [], density: 0.02, pond: T.LAVA },
  // built places: a castle stands on the screen grid inside straight stone walls; a town is a meadow with streets
  castle: { ground: T.STONE, rim: [], rimGround: T.WALL, rimRise: 2, solid: [D.PILLAR], soft: [D.TUFT], density: 0.01 },
  town: { ground: T.GRASS, rim: [D.TREE], solid: [D.TREE], soft: [D.FLOWER, D.FLOWER, D.TUFT], density: 0.012 },
  sky: { ground: T.CLOUD, rim: [], rimGround: T.VOID, solid: [D.PILLAR], soft: [], density: 0.015 },
};

/** Working state of one stacked dimension while it is being realised. */
export interface ST {
  bp: StackBP;
  dim: Dimension;
  rng: Rng;
  w: number;
  h: number;
  /** region that owns each tile (rims included), -1 = nothing */
  owner: Int16Array;
  /** scenery density multiplier */
  scenery: number;
  /** how much lava the underworld holds (0 = none) */
  lava: number;
  /** 1 = rim tile (solid edge of a region) */
  border: Uint8Array;
  /** river stretch per tile (index into segs, +1), 0 = no river. Bridges keep it: water runs under them */
  river: Int16Array;
  /** 1 = bridge deck over river water */
  bridge: Uint8Array;
  /** downstream direction per river tile: 1 n, 2 e, 3 s, 4 w */
  flow: Uint8Array;
  /** filler region per tile outside the land (index into bp.fill.list), -1 on land */
  fillAt: Int16Array;
  /** piers that were built: where they end, which sea, whether a ferryman works there */
  docks: { region: number; filler: number; end: number; first: number; dir: 'n' | 'e' | 's' | 'w'; ferry: boolean; edgeId?: string }[];
  /** sandbars and cays out at sea that can be walked on: a tile to stand on, the zone id, and what was left there */
  outcrops: { filler: number; tile: number; loc: LocId; holds: 'chest' | 'pots' | 'nothing' }[];
  /** every stretch of every river: a new stretch starts at each waterfall */
  segs: { river: number; seg: number; level: number; lava?: boolean }[];
  /** 1 = something was placed here or wants this tile kept clear */
  reserved: Uint8Array;
  /** shuffled interior tiles per region */
  interior: number[][];
  /** tiles that separate two zones: tile -> edge id */
  barriers: Map<number, string>;
  anchors: Map<number, LocId>;
  /** tiles where paths should lead (openings, doors), per region */
  mouths: number[][];
  problems: string[];
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

export function initStack(bp: StackBP, gw: number, gh: number, seed: number, wobble: number, scenery: number, riverWidth = 1, lava = 0): ST {
  const w = gw * SW, h = gh * SH, n = w * h;
  const dim: Dimension = {
    id: bp.id, name: bp.name, kind: bp.kind, w, h, sw: SW, sh: SH, stack: bp.stack,
    ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n), solid: new Uint8Array(n).fill(1),
    region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [], lip: new Uint8Array(n),
  };
  const st: ST = {
    bp, dim, rng: new Rng(childSeed(seed, 'tiles' + bp.id)), w, h, scenery, lava, owner: new Int16Array(n).fill(-1),
    border: new Uint8Array(n), river: new Int16Array(n), bridge: new Uint8Array(n), flow: new Uint8Array(n), fillAt: new Int16Array(n).fill(-1), docks: [], outcrops: [], segs: [], reserved: new Uint8Array(n), interior: bp.regions.map(() => []),
    barriers: new Map(), anchors: new Map(), mouths: bp.regions.map(() => []), problems: [],
  };
  const reg = st.owner;

  // 1. organic region shapes: screens, warped by smooth noise. The warp is the same for every
  //    stacked world, so a cave really lies under the land that owns its entrance.
  //    A blocky region (a castle) is not warped: wherever the warp would give a tile to it or
  //    take one from it, the plain screen grid decides, so its border is made of straight lines.
  const A = wobble;
  const scr = new Int32Array(n);
  const blocky = bp.regions.map((r) => !!r.blocky), anyBlocky = blocky.some(Boolean);
  const isBlocky = (s: number) => bp.part.cell[s] >= 0 && blocky[bp.part.cell[s]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const wx = x + (valueNoise(seed, x / 9, y / 9) - 0.5) * 2 * A;
    const wy = y + (valueNoise(seed ^ 0x51ed, x / 9, y / 9) - 0.5) * 2 * A;
    const sx = Math.max(0, Math.min(gw - 1, Math.floor(wx / SW)));
    const sy = Math.max(0, Math.min(gh - 1, Math.floor(wy / SH)));
    let s = sy * gw + sx;
    if (anyBlocky) { const plain = ((y / SH) | 0) * gw + ((x / SW) | 0); if (isBlocky(plain) || isBlocky(s)) s = plain; }
    scr[y * w + x] = s;
    reg[y * w + x] = bp.part.cell[s];
  }
  markRivers(st, scr, gw, riverWidth);

  // 2. rims: any tile touching another region (or the map edge) is solid
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (reg[i] < 0) continue;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || reg[ny * w + nx] !== reg[i]) { st.border[i] = 1; break; }
    }
    if (st.river[i]) st.border[i] = 1; // water is not land: it bounds the walkable area like a rim does
  }
  // built walls are two tiles thick, and every outward corner carries a tower
  const tower = new Uint8Array(anyBlocky ? n : 0);
  if (anyBlocky) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (reg[i] < 0 || !blocky[reg[i]] || st.border[i]) continue;
      for (let dy = -2; dy <= 2 && !st.border[i]; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || reg[ny * w + nx] !== reg[i]) { st.border[i] = 1; break; }
      }
    }
    const same = (s: number, dx: number, dy: number) => {
      const x = (s % gw) + dx, y = ((s / gw) | 0) + dy;
      return x >= 0 && y >= 0 && x < gw && y < gh && bp.part.cell[y * gw + x] === bp.part.cell[s];
    };
    bp.regions.forEach((r, k) => {
      if (!r.blocky) return;
      for (const s of bp.part.regions[k]) for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (same(s, cx, 0) || same(s, 0, cy)) continue;
        const x0 = (s % gw) * SW + (cx < 0 ? 0 : SW - 4), y0 = ((s / gw) | 0) * SH + (cy < 0 ? 0 : SH - 4);
        for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) if (reg[y * w + x] === k) { st.border[y * w + x] = 1; tower[y * w + x] = 1; }
      }
    });
  }

  // 3. each region keeps its largest walkable piece; slivers cut off by the warp become rim
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (reg[s] < 0 || st.border[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= n || comp[j] >= 0 || st.border[j] || reg[j] !== reg[s]) continue;
        if ((j === i - 1 || j === i + 1) && ((j / w) | 0) !== ((i / w) | 0)) continue;
        comp[j] = id;
        stack.push(j);
      }
    }
    sizes.push(size);
  }
  const best = bp.regions.map(() => -1);
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && (best[reg[i]] < 0 || sizes[comp[i]] > sizes[best[reg[i]]])) best[reg[i]] = comp[i];
  for (let i = 0; i < n; i++) {
    if (reg[i] < 0) continue;
    if (!st.border[i] && comp[i] !== best[reg[i]]) st.border[i] = 1;
    if (!st.border[i]) st.interior[reg[i]].push(i);
  }
  bp.regions.forEach((r, k) => {
    if (st.interior[k].length < (r.barren ? 6 : 90)) st.problems.push(`${r.name} is too small to hold anything`);
    st.interior[k] = st.rng.shuffle(st.interior[k]);
  });

  // 4. base paint
  for (let i = 0; i < n; i++) {
    const r = reg[i];
    dim.region[i] = r;
    if (r < 0) {
      dim.ground[i] = T.VOID;
      if (bp.kind !== 'overworld') continue;
      // outside the land: whatever filler region this screen belongs to
      const kind = bp.fill?.kind[scr[i]] ?? FILL.OCEAN;
      st.fillAt[i] = bp.fill?.of[scr[i]] ?? -1;
      if (kind === FILL.RANGE) {
        const peak = valueNoise(seed ^ 0x99, (i % w) / 5, ((i / w) | 0) / 5);
        dim.elev[i] = 4 + (peak > 0.55 ? 1 : 0) + (peak > 0.75 ? 1 : 0);
        dim.ground[i] = dim.elev[i] >= 5 ? T.SNOW : T.STONE;
        if (st.rng.chance(0.1)) dim.deco[i] = D.ROCK;
      } else if (kind === FILL.THICKET) {
        // a wall of trees nobody gets through
        dim.elev[i] = 1;
        dim.ground[i] = T.GRASS;
        dim.deco[i] = st.rng.chance(0.3) ? D.PINE : D.TREE;
      } else if (kind === FILL.WASTES) {
        dim.elev[i] = 1;
        dim.ground[i] = T.SAND;
        const roll = st.rng.next();
        if (roll < 0.14) dim.deco[i] = D.ROCK; else if (roll < 0.2) dim.deco[i] = D.CACTUS; else if (roll < 0.23) dim.deco[i] = D.DEADTREE;
      } else dim.ground[i] = T.DEEP;
      continue;
    }
    const region = bp.regions[r], style = STYLES[region.biome];
    dim.elev[i] = region.elev;
    dim.ground[i] = style.ground;
    if (st.river[i]) { const sg = st.segs[st.river[i] - 1]; dim.ground[i] = sg.lava ? T.LAVA : T.WATER; dim.elev[i] = sg.level; continue; }
    st.flow[i] = 0;
    if (!st.border[i]) { dim.solid[i] = 0; continue; }
    if (style.rimGround !== undefined) {
      dim.ground[i] = style.rimGround;
      if (style.rimGround === T.CAVEWALL) dim.elev[i] = region.elev + 1;
      if (style.rimRise) dim.elev[i] = region.elev + style.rimRise + (tower[i] ? 1 : 0);
      if (style.rimGround === T.VOID) dim.region[i] = -1; // sky islands simply end
    } else {
      // a rim of trees or rocks: its props stand on level ground, so its sides are only a bevel
      dim.deco[i] = st.rng.pick(style.rim);
      dim.lip![i] = 1;
    }
  }
  if (st.segs.length) dim.flow = st.flow;
  return st;
}

/** Carve one gated opening per region edge: a straight, one-tile-wide cut through both rims. */
export function carveOpenings(st: ST, drop: (edgeId: string) => void): void {
  const { w, h, dim, border } = st;
  const regOf = st.owner;
  const carved = new Uint8Array(w * h);
  for (const op of st.bp.openings) {
    type Cand = { pa: number; pb: number; path: number[]; d: number; walls: number[] };
    let cands: Cand[] = [];
    // First look for a cut whose sides are already solid. If the border runs too diagonally for
    // that, accept a cut with open ground beside it and wall that ground up.
    for (const force of [false, true]) {
    if (cands.length) break;
    for (const i of st.interior[op.a]) {
      if (st.reserved[i]) continue;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const path: number[] = [];
        const walls: number[] = [];
        let cx = x + dx, cy = y + dy, ok = true, seenB = false;
        while (ok && path.length < 12) {
          if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) { ok = false; break; }
          const j = cy * w + cx, rj = regOf[j];
          if (!border[j]) { ok = rj === op.b && path.length >= 2 && seenB && !st.reserved[j]; break; }
          if (rj === op.b) seenB = true;
          else if (rj !== op.a || seenB) { ok = false; break; }
          // both sides of the cut must stay solid, or the gate could be walked around
          const l = (cy + dx) * w + cx + dy, r2 = (cy - dx) * w + cx - dy;
          if (carved[l] || carved[r2] || carved[j]) { ok = false; break; }
          for (const side of [l, r2]) {
            if (border[side]) continue;
            if (!force || st.reserved[side] || (regOf[side] !== op.a && regOf[side] !== op.b)) { ok = false; break; }
            walls.push(side);
          }
          if (!ok) break;
          path.push(j);
          cx += dx; cy += dy;
        }
        if (ok && path.length >= 2 && path.length < 12 && !border[cy * w + cx]) cands.push({ pa: i, pb: cy * w + cx, path, walls, d: dy !== 0 ? (dy > 0 ? 2 : 0) : dx > 0 ? 1 : 3 });
      }
    }
    }
    if (!cands.length && op.optional) { drop(op.edgeId); continue; }
    if (!cands.length) { st.problems.push(`no room for ${op.label} between ${st.bp.regions[op.a].name} and ${st.bp.regions[op.b].name}`); continue; }
    const min = Math.min(...cands.map((c) => c.path.length));
    cands = cands.filter((k) => k.path.length <= min + 1);
    const fewest = Math.min(...cands.map((k) => k.walls.length));
    const c = st.rng.pick(cands.filter((k) => k.walls.length === fewest));
    const ra = st.bp.regions[op.a], rb = st.bp.regions[op.b];
    for (const t of c.walls) {
      border[t] = 1;
      dim.solid[t] = 1;
      const owner = st.bp.regions[regOf[t]], style = STYLES[owner.biome];
      if (style.rimRise) { dim.ground[t] = style.rimGround!; dim.elev[t] = owner.elev + style.rimRise; }
      else dim.deco[t] = style.rim[0] ?? D.ROCK;
    }
    let lastA = 0;
    c.path.forEach((j, k) => {
      const side = regOf[j] === op.a ? ra : rb;
      if (regOf[j] === op.a) lastA = k;
      carved[j] = 1;
      dim.solid[j] = 0;
      dim.deco[j] = D.NONE;
      dim.region[j] = regOf[j];
      dim.elev[j] = side.elev;
      if (st.river[j]) st.bridge[j] = 1; // a bridge deck: walkers cross above, swimmers pass below
      dim.ground[j] = op.gate === 'water' ? T.WATER : st.river[j] || st.bp.kind === 'sky' ? T.PLANK : st.bp.kind === 'underworld' ? T.CAVE : T.PATH;
    });
    const gate = c.path[lastA];
    st.barriers.set(gate, op.edgeId);
    const dir = (['n', 'e', 's', 'w'] as const)[c.d];
    dim.objects.push({
      id: 'g.' + op.edgeId, kind: op.oneWay ? 'ledge' : 'gate', x: gate % w, y: (gate / w) | 0, label: op.label,
      gate: op.gate, req: op.req, edgeId: op.edgeId, dir,
    });
    if (ra.elev !== rb.elev && !op.oneWay && lastA + 1 < c.path.length) {
      const s = c.path[lastA + 1];
      dim.objects.push({ id: 's.' + op.edgeId, kind: 'stairs', x: s % w, y: (s / w) | 0, label: 'Stairs', dir });
    }
    for (const m of [c.pa, c.pb]) {
      const mx = m % w, my = (m / w) | 0;
      for (let yy = my - 1; yy <= my + 1; yy++) for (let xx = mx - 1; xx <= mx + 1; xx++) st.reserved[yy * w + xx] = 1;
    }
    st.mouths[op.a].push(c.pa);
    st.mouths[op.b].push(c.pb);
  }
}

/**
 * River tiles: every tile that looks across a river line (or a river corner) of the warped screen
 * grid. The same warp shapes regions, so a river on a region border replaces exactly its rim.
 */
function markRivers(st: ST, scr: Int32Array, gw: number, width: number): void {
  const rivers = st.bp.rivers ?? [];
  if (!rivers.length) return;
  const { w, h, river } = st;
  const cw = gw + 1;
  const lineAt = new Map<number, number>();
  const cornerAt = new Map<number, number>();
  // the course is known exactly, so every tile is told which way its water runs
  const lineDir = new Map<number, number>();
  const cornerDir = new Map<number, number>();
  const dirOf = (from: number, to: number) => (to - from === 1 ? 2 : to - from === -1 ? 4 : to > from ? 3 : 1);
  rivers.forEach((r, ri) => {
    const base = st.segs.length;
    const count = r.seg[r.seg.length - 1] + 1;
    // a river that rises in a magma cave runs molten all the way
    const lava = st.lava > 0 && st.bp.kind === 'underworld' && st.bp.regions[st.bp.part.cell[r.lines[0].a]]?.biome === 'magma';
    for (let k = 0; k < count; k++) st.segs.push({ river: ri, seg: k, level: r.level[r.seg.indexOf(k)], lava });
    r.lines.forEach((l, k) => { lineAt.set(lineKey(l.a, l.b), base + r.seg[k]); lineDir.set(lineKey(l.a, l.b), dirOf(r.corners[k], r.corners[k + 1])); });
    r.corners.forEach((c, k) => { const j = Math.min(Math.max(k - 1, 0), r.lines.length - 1); cornerDir.set(c, dirOf(r.corners[j], r.corners[j + 1])); });
    r.corners.forEach((c, k) => cornerAt.set(c, base + r.seg[Math.min(Math.max(k - 1, 0), r.seg.length - 1)]));
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, s = scr[i], sx = s % gw, sy = (s / gw) | 0;
    if (st.owner[i] < 0) continue; // the sea is not a river
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const t = scr[ny * w + nx];
      if (t === s) continue;
      const tx = t % gw, ty = (t / gw) | 0, ax = Math.abs(tx - sx), ay = Math.abs(ty - sy);
      const g = ax + ay === 1 ? lineAt.get(lineKey(s, t)) : ax === 1 && ay === 1 ? cornerAt.get(Math.max(sy, ty) * cw + Math.max(sx, tx)) : undefined;
      if (g !== undefined) {
        river[i] = g + 1;
        st.flow[i] = (ax + ay === 1 ? lineDir.get(lineKey(s, t)) : cornerDir.get(Math.max(sy, ty) * cw + Math.max(sx, tx))) ?? 0;
        break;
      }
    }
  }
  tidyRivers(st);
  // wider rivers: grow the band, but never up onto land that lies below the water level
  for (let grow = 1; grow < width; grow++) {
    const prev = river.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (prev[i] || st.owner[i] < 0) continue;
      for (const [dx, dy] of N8) {
        const g = prev[(y + dy) * w + x + dx];
        if (g && st.bp.regions[st.owner[i]].elev >= st.segs[g - 1].level) { river[i] = g; st.flow[i] = st.flow[(y + dy) * w + x + dx]; break; }
      }
    }
  }
}

/**
 * Each stretch of river must be one body of water. Stray tiles that the warp cut off join the
 * neighbouring stretch they touch; water that touches no stretch at all stops being river
 * (it stays on the map as a still pool).
 */
function tidyRivers(st: ST): void {
  const { w, h, river } = st, n = w * h;
  for (let pass = 0; pass < 4; pass++) {
    const comp = new Int32Array(n).fill(-1);
    const size: number[] = [], seg: number[] = [];
    for (let s = 0; s < n; s++) {
      if (!river[s] || comp[s] >= 0) continue;
      const id = size.length, stack = [s];
      comp[s] = id;
      let count = 0;
      while (stack.length) {
        const i = stack.pop()!, x = i % w;
        count++;
        for (const j of [i - w, x < w - 1 ? i + 1 : -1, i + w, x > 0 ? i - 1 : -1]) {
          if (j < 0 || j >= n || comp[j] >= 0 || river[j] !== river[s]) continue;
          comp[j] = id;
          stack.push(j);
        }
      }
      size.push(count);
      seg.push(river[s]);
    }
    const main = new Map<number, number>();
    size.forEach((c, id) => { if (!main.has(seg[id]) || c > size[main.get(seg[id])!]) main.set(seg[id], id); });
    let changed = false;
    const adopt = new Map<number, number>(); // stray component -> stretch it touches
    for (let i = 0; i < n; i++) {
      const c = comp[i];
      if (c < 0 || main.get(seg[c]) === c || adopt.has(c)) continue;
      const x = i % w;
      for (const j of [i - w, x < w - 1 ? i + 1 : -1, i + w, x > 0 ? i - 1 : -1]) {
        if (j >= 0 && j < n && river[j] && river[j] !== river[i] && main.get(river[j]) === comp[j]) { adopt.set(c, river[j]); break; }
      }
    }
    for (let i = 0; i < n; i++) {
      const c = comp[i];
      if (c < 0 || main.get(seg[c]) === c) continue;
      river[i] = adopt.get(c) ?? 0;
      changed = true;
    }
    if (!changed) break;
  }
  void h;
}
