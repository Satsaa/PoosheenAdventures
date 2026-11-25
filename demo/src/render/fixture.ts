// Fixture world for developing / testing the renderer without the generator.
// Builds an overworld with biomes, plateaus and water, a sparse sky and underworld sharing its
// tile coordinates, and a 3-room interior. Non-render fields of World are minimal stubs.
import { D, T, type Dimension, type GateKind, type MapObject, type RegionInfo, type World } from '../core/types';
import { Rng, valueNoise } from '../core/rng';

type Biome = 'plains' | 'forest' | 'desert' | 'snow' | 'swamp' | 'volcano' | 'lake';

const SOLID_DECO = new Set<number>([D.TREE, D.PINE, D.PALM, D.DEADTREE, D.ROCK, D.CACTUS, D.PILLAR, D.HOUSE, D.STALAG, D.CRYSTAL]);

function blank(id: string, name: string, kind: Dimension['kind'], w: number, h: number): Dimension {
  const n = w * h;
  return {
    id, name, kind, w, h, sw: 16, sh: 11,
    ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n), solid: new Uint8Array(n),
    region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [],
  };
}

/** solid from ground/deco, then 4-connected walk components of equal elev -> zones. */
function finalize(d: Dimension) {
  const { w, h } = d;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const g = d.ground[i];
    d.solid[i] = g === T.VOID || g === T.WATER || g === T.DEEP || g === T.LAVA || g === T.WALL || g === T.CAVEWALL || SOLID_DECO.has(d.deco[i]) ? 1 : 0;
  }
  // gates / objects stand on walkable tiles
  for (const o of d.objects) {
    const i = o.y * w + o.x;
    if (o.kind !== 'gate' && o.kind !== 'entrance') d.deco[i] = 0;
    if (!(o.kind === 'gate' && (o.gate === 'water' || o.gate === 'chasm'))) d.solid[i] = 0;
    if (d.ground[i] === T.WATER || d.ground[i] === T.LAVA) d.solid[i] = 0;
  }
  d.zone.fill(-1);
  d.zoneLoc = [];
  for (let i = 0; i < n; i++) {
    if (d.solid[i] || d.zone[i] >= 0) continue;
    const z = d.zoneLoc.length;
    d.zoneLoc.push(`${d.id}:z${z}`);
    const q = [i];
    d.zone[i] = z;
    for (let k = 0; k < q.length; k++) {
      const j = q[k];
      const x = j % w, y = (j / w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const m = ny * w + nx;
        if (d.solid[m] || d.zone[m] >= 0 || d.elev[m] !== d.elev[j]) continue;
        d.zone[m] = z;
        q.push(m);
      }
    }
  }
}

function freeTile(d: Dimension, rng: Rng, pred: (x: number, y: number, i: number) => boolean, used: Set<number>): [number, number] | null {
  for (let k = 0; k < 4000; k++) {
    const x = 2 + rng.int(d.w - 4), y = 2 + rng.int(d.h - 4);
    const i = y * d.w + x;
    if (used.has(i)) continue;
    if (!pred(x, y, i)) continue;
    used.add(i);
    return [x, y];
  }
  return null;
}

const walkable = (d: Dimension) => (x: number, y: number, i: number) => {
  const g = d.ground[i];
  return g !== T.VOID && g !== T.WATER && g !== T.DEEP && g !== T.LAVA && g !== T.WALL && g !== T.CAVEWALL && !SOLID_DECO.has(d.deco[i]);
};

function overworld(rng: Rng, seed: number): Dimension {
  const W = 96, H = 64;
  const d = blank('ow', 'Hyrule-ish', 'overworld', W, H);
  d.stack = 0;
  const seeds: { x: number; y: number; biome: Biome; name: string; color: string }[] = [
    { x: 46, y: 30, biome: 'plains', name: 'Meadowmere', color: '#9be36b' },
    { x: 18, y: 26, biome: 'forest', name: 'Whisperwood', color: '#4fc46a' },
    { x: 48, y: 9, biome: 'snow', name: 'Frostpeak', color: '#bfe3ff' },
    { x: 76, y: 46, biome: 'desert', name: 'Sunscar Dunes', color: '#ffd27a' },
    { x: 82, y: 18, biome: 'volcano', name: 'Cinder Crown', color: '#ff7a4a' },
    { x: 20, y: 50, biome: 'swamp', name: 'Mirefen', color: '#a3c46a' },
    { x: 48, y: 52, biome: 'lake', name: 'Glasswater', color: '#7ad0ff' },
  ];
  for (const s of seeds) { s.x += rng.int(5) - 2; s.y += rng.int(5) - 2; }
  const regionOf = new Int16Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let best = 0, bd = 1e9;
      const jx = x + (valueNoise(seed + 5, x / 7, y / 7) - 0.5) * 14, jy = y + (valueNoise(seed + 6, x / 7, y / 7) - 0.5) * 14;
      seeds.forEach((s, k) => {
        const dd = (s.x - jx) ** 2 + (s.y - jy) ** 2;
        if (dd < bd) { bd = dd; best = k; }
      });
      regionOf[y * W + x] = best;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const reg = regionOf[i];
      const biome = seeds[reg].biome;
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      let e = valueNoise(seed, x / 13, y / 13) * 0.62 + valueNoise(seed + 1, x / 5, y / 5) * 0.38;
      e += Math.min(0, (edge - 7) * 0.06);
      if (biome === 'lake') e -= 0.13;
      if (biome === 'snow' || biome === 'volcano') e += 0.1;
      d.region[i] = reg;
      let g: number;
      let el = 0;
      if (e < 0.28) g = T.DEEP;
      else if (e < 0.36) g = T.WATER;
      else {
        let hN = valueNoise(seed + 11, x / 15, y / 15) * 0.85 + valueNoise(seed + 12, x / 5, y / 5) * 0.15;
        if (biome === 'snow' || biome === 'volcano') hN += 0.1;
        if (biome === 'lake' || biome === 'swamp') hN -= 0.1;
        el = hN > 0.74 ? 3 : hN > 0.64 ? 2 : hN > 0.54 ? 1 : 0;
        const n2 = valueNoise(seed + 2, x / 4, y / 4);
        switch (biome) {
          case 'desert': g = T.SAND; break;
          case 'snow': g = el >= 2 ? (n2 > 0.55 ? T.STONE : T.SNOW) : T.SNOW; break;
          case 'swamp': g = n2 > 0.62 ? T.WATER : T.SWAMP; el = Math.min(el, 1); break;
          case 'volcano': g = el === 0 && n2 > 0.6 ? T.LAVA : n2 > 0.45 ? T.STONE : T.DIRT; break;
          default: g = n2 > 0.78 ? T.DIRT : T.GRASS;
        }
        if (e < 0.39 && el === 0 && biome !== 'swamp' && biome !== 'snow' && biome !== 'volcano') g = T.SAND;
      }
      d.ground[i] = g;
      d.elev[i] = el;
      // deco
      const r = rng.next();
      const nd = valueNoise(seed + 3, x / 5, y / 5);
      if (g === T.GRASS) {
        if (biome === 'forest') d.deco[i] = nd > 0.4 && r < 0.6 ? (r < 0.15 ? D.PINE : D.TREE) : r > 0.93 ? D.MUSHROOM : r > 0.86 ? D.FLOWER : 0;
        else d.deco[i] = nd > 0.7 && r < 0.45 ? D.TREE : r > 0.95 ? D.FLOWER : r > 0.9 ? D.TUFT : r > 0.885 ? D.ROCK : 0;
      } else if (g === T.SAND) {
        d.deco[i] = biome === 'desert' ? (r < 0.03 ? D.CACTUS : r < 0.045 ? D.ROCK : r < 0.06 ? D.TUFT : 0) : r < 0.04 ? D.PALM : 0;
      } else if (g === T.SNOW) d.deco[i] = nd > 0.55 && r < 0.35 ? D.PINE : r < 0.02 ? D.ROCK : r < 0.03 ? D.CRYSTAL : 0;
      else if (g === T.STONE) d.deco[i] = r < 0.05 ? D.ROCK : r < 0.08 && biome === 'volcano' ? D.DEADTREE : 0;
      else if (g === T.DIRT) d.deco[i] = r < 0.04 ? D.DEADTREE : r < 0.07 ? D.ROCK : 0;
      else if (g === T.SWAMP) d.deco[i] = r < 0.12 ? D.REED : r < 0.17 ? D.DEADTREE : r < 0.21 ? D.MUSHROOM : 0;
      else if (g === T.WATER && r < 0.06 && biome !== 'lake') d.deco[i] = D.REED;
    }
  // a path from the village to the forest and the lake
  const village = seeds[0];
  const carve = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0, y = y0;
    while (x !== x1 || y !== y1) {
      if (x !== x1 && (y === y1 || rng.chance(0.6))) x += Math.sign(x1 - x); else y += Math.sign(y1 - y);
      const i = y * W + x;
      if (d.ground[i] === T.GRASS || d.ground[i] === T.DIRT || d.ground[i] === T.SAND) { d.ground[i] = T.PATH; d.deco[i] = 0; }
      else if (d.ground[i] === T.WATER || d.ground[i] === T.DEEP) { d.ground[i] = T.PLANK; d.deco[i] = 0; }
    }
  };
  carve(village.x, village.y + 2, seeds[1].x, seeds[1].y);
  carve(village.x, village.y + 2, seeds[6].x, seeds[6].y - 6);
  carve(village.x, village.y + 2, seeds[3].x - 4, seeds[3].y);
  // village: flatten an area and place houses (2 wide x 2 deep) with door entrances
  const used = new Set<number>();
  const objs: MapObject[] = [];
  let oid = 0;
  const add = (o: Omit<MapObject, 'id'>) => { const m = { id: `ow-${oid++}`, ...o } as MapObject; objs.push(m); used.add(m.y * W + m.x); return m; };
  for (let y = village.y - 6; y <= village.y + 6; y++)
    for (let x = village.x - 8; x <= village.x + 8; x++) {
      const i = y * W + x;
      d.elev[i] = 0;
      if (d.ground[i] !== T.PATH) d.ground[i] = T.GRASS;
      d.deco[i] = 0;
    }
  const houses: [number, number, string][] = [[village.x - 6, village.y - 4, 'house'], [village.x + 3, village.y - 4, 'shop'], [village.x - 6, village.y + 2, 'house'], [village.x + 3, village.y + 2, 'house']];
  for (const [hx, hy, style] of houses) {
    for (let y = hy; y < hy + 2; y++) for (let x = hx; x < hx + 3; x++) d.deco[y * W + x] = D.HOUSE;
    d.ground[(hy + 2) * W + hx + 1] = T.PATH;
    add({ kind: 'entrance', x: hx + 1, y: hy + 2, label: style === 'shop' ? 'General Store' : 'Cottage', style, to: { dim: 'house1', x: 15, y: 13 } });
  }
  // well-ish pillars ruin
  for (const [px, py] of [[village.x - 1, village.y - 1], [village.x + 1, village.y - 1]]) d.deco[py * W + px] = D.PILLAR;
  add({ kind: 'start', x: village.x, y: village.y + 1, label: 'Start' });
  add({ kind: 'npc', x: village.x - 2, y: village.y + 1, label: 'Elder Mabel', npcId: 'elder', icon: '!' , stage: 0 });

  const W_ = walkable(d);
  const inBiome = (b: Biome) => (x: number, y: number, i: number) => W_(x, y, i) && seeds[d.region[i]].biome === b;
  const cliffBase = (x: number, y: number, i: number) => W_(x, y, i) && y > 0 && d.elev[i - W] > d.elev[i] && d.ground[i - W] !== T.WATER;
  const put = (pred: (x: number, y: number, i: number) => boolean, o: Omit<MapObject, 'id' | 'x' | 'y'>) => {
    const p = freeTile(d, rng, pred, used);
    if (p) add({ ...o, x: p[0], y: p[1] } as Omit<MapObject, 'id'>);
    return p;
  };
  // chests across biomes
  for (const b of ['plains', 'forest', 'desert', 'snow', 'swamp', 'volcano', 'lake', 'forest', 'desert', 'snow'] as Biome[])
    put(inBiome(b), { kind: 'chest', label: `Chest (${b})`, checkId: `c-${b}` });
  // entrances
  put(cliffBase, { kind: 'entrance', label: 'Old Cave', style: 'cave', to: { dim: 'under', x: 0, y: 0 } });
  put(cliffBase, { kind: 'entrance', label: 'Hollow Cave', style: 'cave' });
  put(inBiome('swamp'), { kind: 'entrance', label: 'Sunken Dungeon', style: 'dungeon', to: { dim: 'house1', x: 2, y: 8 } });
  put(inBiome('snow'), { kind: 'entrance', label: 'Ice Shrine', style: 'shrine' });
  put(inBiome('volcano'), { kind: 'entrance', label: 'Ember Sanctum', style: 'sanctum' });
  const down = put(inBiome('forest'), { kind: 'entrance', label: 'Root Stairs', style: 'stairs-down', to: { dim: 'under', x: 0, y: 0 } });
  const bean = put(inBiome('plains'), { kind: 'entrance', label: 'Magic Beanstalk', style: 'beanstalk', to: { dim: 'sky', x: 0, y: 0 } });
  // gates: one of each kind
  const gates: [GateKind, Biome][] = [
    ['bush', 'forest'], ['bush', 'plains'], ['boulder', 'plains'], ['boulder', 'snow'], ['water', 'lake'], ['chasm', 'volcano'], ['dark', 'swamp'],
    ['eye', 'desert'], ['locked', 'desert'], ['bossdoor', 'volcano'], ['seal', 'snow'], ['guard', 'plains'], ['stairs', 'forest'], ['portal', 'desert'],
  ];
  for (const [g, b] of gates) put(inBiome(b), { kind: 'gate', gate: g, label: `${g[0].toUpperCase()}${g.slice(1)} gate`, edgeId: `e-${g}` });
  put(cliffBase, { kind: 'gate', gate: 'cracked', label: 'Cracked wall', edgeId: 'e-cracked' });
  // ledges along the south edges of plateaus (drop south)
  for (let k = 0; k < 4; k++) {
    const p = freeTile(d, rng, (x, y, i) => W_(x, y, i) && d.elev[i] > 0 && y + 1 < H && d.elev[i + W] < d.elev[i] && W_(x, y + 1, i + W), used);
    if (p) add({ kind: 'gate', gate: 'ledge', dir: 's', x: p[0], y: p[1], label: 'Ledge' });
  }
  for (const n of [['Wanderer Oona', '?', 'forest'], ['Smith Brann', '⚒', 'snow'], ['Nomad Kesh', '$', 'desert'], ['Fisher Lio', '~', 'lake']] as [string, string, Biome][])
    put(inBiome(n[2]), { kind: 'npc', label: n[0], icon: n[1], npcId: n[0] });
  put(inBiome('plains'), { kind: 'source', label: 'Tall grass', style: 'grass', sourceId: 's-grass' });
  put(inBiome('desert'), { kind: 'source', label: 'Clay pot', style: 'pot', sourceId: 's-pot' });
  put(inBiome('forest'), { kind: 'source', label: 'Fairy flower', style: 'flower', sourceId: 's-flower' });
  put(inBiome('volcano'), { kind: 'boss', label: 'Magma Wyrm', checkId: 'boss1' });
  d.objects = objs;
  d.regions = seeds.map((s, k): RegionInfo => {
    const reg = { id: `r${k}`, name: s.name, biome: s.biome, elev: 0, x: s.x, y: s.y, color: s.color };
    return reg;
  });
  finalize(d);
  (d as Dimension & { _links?: unknown })._links = { down, bean };
  return d;
}

function sky(rng: Rng, seed: number, bean: [number, number] | null): Dimension {
  const W = 96, H = 64;
  const d = blank('sky', 'Cloudreach', 'sky', W, H);
  d.stack = 1;
  const isles = [[22, 16, 9], [52, 22, 12], [78, 14, 7], [70, 44, 10], [30, 46, 8]];
  if (bean) isles.push([bean[0], bean[1], 5]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = 0;
      for (const [cx, cy, r] of isles) v = Math.max(v, 1 - Math.hypot((x - cx) / (r * 1.3), (y - cy) / r));
      v += (valueNoise(seed + 9, x / 4, y / 4) - 0.5) * 0.5;
      if (v > 0.3) {
        d.ground[i] = v > 0.5 ? T.GRASS : T.CLOUD;
        d.elev[i] = v > 0.68 ? 1 : 0;
        const r = rng.next();
        if (d.ground[i] === T.GRASS) d.deco[i] = r < 0.08 ? D.TREE : r < 0.13 ? D.FLOWER : r < 0.15 ? D.PILLAR : r < 0.16 ? D.CRYSTAL : 0;
      }
    }
  // cloud bridges
  const bridge = (a: number[], b: number[]) => {
    let x = a[0], y = a[1];
    while (x !== b[0] || y !== b[1]) {
      if (x !== b[0]) x += Math.sign(b[0] - x); else y += Math.sign(b[1] - y);
      for (const dy of [0, 1]) {
        const i = (y + dy) * W + x;
        if (d.ground[i] === T.VOID) d.ground[i] = T.CLOUD;
      }
    }
  };
  bridge(isles[0], isles[1]);
  bridge(isles[1], isles[2]);
  bridge(isles[1], isles[3]);
  const used = new Set<number>();
  const objs: MapObject[] = [];
  let oid = 0;
  const W_ = walkable(d);
  const put = (o: Omit<MapObject, 'id' | 'x' | 'y'>, pred = W_) => {
    const p = freeTile(d, rng, pred, used);
    if (p) objs.push({ id: `sky-${oid++}`, ...o, x: p[0], y: p[1] } as MapObject);
  };
  if (bean) {
    const i = bean[1] * W + bean[0];
    d.ground[i] = T.CLOUD; d.deco[i] = 0;
    objs.push({ id: `sky-${oid++}`, kind: 'entrance', style: 'beanstalk', x: bean[0], y: bean[1], label: 'Beanstalk top', to: { dim: 'ow', x: bean[0], y: bean[1] } });
    used.add(i);
  }
  for (let k = 0; k < 4; k++) put({ kind: 'chest', label: 'Sky chest' });
  put({ kind: 'gate', gate: 'portal', label: 'Sky portal' });
  put({ kind: 'gate', gate: 'seal', label: 'Wind seal' });
  put({ kind: 'npc', label: 'Cloud sage', icon: '☁' });
  put({ kind: 'boss', label: 'Storm Roc' });
  d.objects = objs;
  d.regions = [
    { id: 'sky0', name: 'Cloudreach', biome: 'sky', elev: 0, x: 52, y: 22, color: '#dfe8ff' },
    { id: 'sky1', name: 'Gale Isles', biome: 'sky', elev: 0, x: 70, y: 44, color: '#bcd4ff' },
  ];
  d.region.fill(0);
  finalize(d);
  return d;
}

function underworld(rng: Rng, seed: number, stairs: [number, number] | null): Dimension {
  const W = 96, H = 64;
  const d = blank('under', 'Deepdark', 'underworld', W, H);
  d.stack = -1;
  const cave = new Uint8Array(W * H);
  for (let y = 3; y < H - 3; y++)
    for (let x = 3; x < W - 3; x++) {
      const v = valueNoise(seed + 21, x / 7, y / 7) * 0.7 + valueNoise(seed + 22, x / 3, y / 3) * 0.3;
      if (v > 0.56) cave[y * W + x] = 1;
    }
  // tunnels between caverns
  const pts: [number, number][] = [[14, 12], [40, 18], [70, 14], [82, 40], [52, 44], [20, 46]];
  if (stairs) pts.push(stairs);
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    let x = a[0], y = a[1];
    while (x !== b[0] || y !== b[1]) {
      if (x !== b[0] && (y === b[1] || rng.chance(0.55))) x += Math.sign(b[0] - x); else y += Math.sign(b[1] - y);
      for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) cave[(y + dy) * W + x + dx] = 1;
    }
    for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx / 16 + dy * dy / 9 < 1) cave[(a[1] + dy) * W + a[0] + dx] = 1;
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (cave[i]) {
        const n = valueNoise(seed + 23, x / 5, y / 5);
        d.ground[i] = n > 0.72 ? T.LAVA : n < 0.2 ? T.WATER : T.CAVE;
        const r = rng.next();
        if (d.ground[i] === T.CAVE) d.deco[i] = r < 0.04 ? D.STALAG : r < 0.065 ? D.CRYSTAL : r < 0.09 ? D.MUSHROOM : r < 0.1 ? D.ROCK : 0;
      } else {
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && cave[yy * W + xx]) { near = true; break; }
          }
        if (near) { d.ground[i] = T.CAVEWALL; d.elev[i] = 1; }
      }
    }
  const used = new Set<number>();
  const objs: MapObject[] = [];
  let oid = 0;
  const W_ = walkable(d);
  const put = (o: Omit<MapObject, 'id' | 'x' | 'y'>) => {
    const p = freeTile(d, rng, W_, used);
    if (p) objs.push({ id: `un-${oid++}`, ...o, x: p[0], y: p[1] } as MapObject);
  };
  if (stairs) {
    const i = stairs[1] * W + stairs[0];
    d.ground[i] = T.CAVE; d.deco[i] = 0;
    objs.push({ id: `un-${oid++}`, kind: 'entrance', style: 'stairs-up', x: stairs[0], y: stairs[1], label: 'Up to the forest', to: { dim: 'ow', x: stairs[0], y: stairs[1] } });
    used.add(i);
  }
  for (let k = 0; k < 5; k++) put({ kind: 'chest', label: 'Buried chest' });
  for (const g of ['dark', 'cracked', 'eye', 'chasm', 'seal'] as GateKind[]) put({ kind: 'gate', gate: g, label: `${g} gate` });
  put({ kind: 'boss', label: 'Gloom Lurker' });
  put({ kind: 'source', label: 'Old pot', style: 'pot' });
  put({ kind: 'npc', label: 'Lost miner', icon: '⛏' });
  d.objects = objs;
  d.regions = [
    { id: 'u0', name: 'Deepdark', biome: 'cave', elev: 0, x: 40, y: 18, color: '#c39bff' },
    { id: 'u1', name: 'Magma Vault', biome: 'cave', elev: 0, x: 82, y: 40, color: '#ff9a6a' },
  ];
  d.region.fill(0);
  finalize(d);
  return d;
}

function interior(): Dimension {
  const W = 30, H = 16;
  const d = blank('house1', 'Sunken Dungeon', 'interior', W, H);
  d.sw = 30; d.sh = 16;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const wall = x === 0 || y === 0 || x === W - 1 || y === H - 1 || x === 10 || x === 20 || (x > 20 && y === 7);
      d.ground[i] = wall ? T.WALL : T.FLOOR;
      d.elev[i] = wall ? 1 : 0;
    }
  // doors through the dividers + corner cut so the outline is not a plain box
  for (const [x, y] of [[10, 10], [20, 4], [25, 7], [15, 15]]) { d.ground[y * W + x] = T.FLOOR; d.elev[y * W + x] = 0; }
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x + y < 3) { d.ground[y * W + x] = T.VOID; d.elev[y * W + x] = 0; }
  // carpet + water channel in the first room
  for (let x = 3; x < 8; x++) { d.ground[11 * W + x] = T.WATER; d.ground[12 * W + x] = T.WATER; }
  for (let y = 2; y < 14; y++) d.ground[y * W + 15] = T.PLANK;
  for (const [x, y] of [[12, 3], [18, 3], [12, 12], [18, 12]]) d.deco[y * W + x] = D.PILLAR;
  d.deco[2 * W + 4] = D.CRYSTAL;
  d.deco[4 * W + 8] = D.ROCK;
  const o = (id: string, kind: MapObject['kind'], x: number, y: number, label: string, extra: Partial<MapObject> = {}): MapObject => ({ id, kind, x, y, label, ...extra });
  d.objects = [
    o('in-0', 'entrance', 15, 14, 'Exit', { style: 'stairs-up', to: { dim: 'ow', x: 20, y: 50 } }),
    o('in-1', 'chest', 4, 4, 'Small key chest'),
    o('in-2', 'chest', 7, 8, 'Map chest'),
    o('in-3', 'gate', 10, 10, 'Locked door', { gate: 'locked' }),
    o('in-4', 'source', 2, 13, 'Pot', { style: 'pot' }),
    o('in-5', 'source', 3, 13, 'Pot', { style: 'pot' }),
    o('in-6', 'gate', 14, 8, 'Eye switch', { gate: 'eye' }),
    o('in-7', 'npc', 17, 9, 'Trapped knight', { icon: '?' }),
    o('in-8', 'gate', 20, 4, 'Boss door', { gate: 'bossdoor' }),
    o('in-9', 'boss', 25, 3, 'Drowned King'),
    o('in-10', 'chest', 27, 12, 'Heart container'),
    o('in-11', 'gate', 25, 7, 'Rune seal', { gate: 'seal' }),
    o('in-12', 'gate', 23, 11, 'Cracked floor', { gate: 'cracked' }),
    o('in-13', 'gate', 6, 11, 'Shallows', { gate: 'water' }),
  ];
  d.regions = [
    { id: 'in0', name: 'Flooded Hall', biome: 'dungeon', elev: 0, x: 5, y: 7, color: '#8fd0ff' },
    { id: 'in1', name: 'Pillar Room', biome: 'dungeon', elev: 0, x: 15, y: 6, color: '#ffd08f' },
    { id: 'in2', name: 'Throne', biome: 'dungeon', elev: 0, x: 25, y: 4, color: '#ff8f9a' },
  ];
  d.region.fill(0);
  d.parent = { dim: 'ow', x: 20, y: 50 };
  finalize(d);
  return d;
}

export function makeFixtureWorld(seedStr = 'fixture'): World {
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) | 0;
  const rng = new Rng(seed);
  const ow = overworld(rng, seed);
  const links = (ow as Dimension & { _links?: { down: [number, number] | null; bean: [number, number] | null } })._links!;
  delete (ow as Dimension & { _links?: unknown })._links;
  const sk = sky(rng, seed, links.bean);
  const un = underworld(rng, seed, links.down);
  const inn = interior();
  const dims = [ow, sk, un, inn];
  const locs = dims.flatMap((d) => d.zoneLoc.map((id) => ({ id, name: id, hnode: d.id, dim: d.id, x: 0, y: 0 })));
  return {
    seed: seedStr,
    items: {},
    dims,
    tree: { id: 'game', kind: 'game', name: 'Fixture', seed, entryCaps: [], provides: [], needs: { t: 'none' }, edges: [], children: [], locs: [], meta: {} },
    graph: { start: ow.zoneLoc[0] || 'ow:z0', goal: 'triforce', locs, edges: [], checks: [], sources: [] },
    npcs: [],
    quests: [],
    solution: { ok: true, spheres: [], locSphere: {}, checkSphere: {}, unreachedChecks: [] },
    lints: [],
    ok: true,
    stats: { attempts: 1, ms: 0 },
  };
}
