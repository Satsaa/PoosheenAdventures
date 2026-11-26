// The tile set as data, and the one checker that reads it.
//
// Every ground, prop and object says what it is, where it belongs, which wall patterns it has
// when it is raised, and what it needs around it. Nothing else in the code decides that:
//   - the checker (`checkTiles`) walks every tile of every map and reports each unmet need,
//     wording the report from this table, so a new tile or a new need is checked without
//     writing a new warning;
//   - the generator's tidy-up (`gen/settle.ts`) asks the same questions and applies the
//     fix the table names (remove the prop, swap it for a low one, use the lip pattern).
// The Rust port can load the same table.
import { D, T, type Dimension, type DimKind, type MapObject } from './types';

/** How raised ground shows its sides: see "Walls seen from every side" in the README. */
export type WallMode = 'room' | 'outdoor';
export const WALL_MODE: Record<DimKind, WallMode> = { overworld: 'outdoor', sky: 'outdoor', underworld: 'room', interior: 'room' };
/**
 * Tiles of raised ground needed behind a face that looks north, for the face to fit. In a room
 * that face is as wide as the others, which takes a run longer than one tile; a tile without
 * the depth uses the lip pattern instead.
 */
export const FACE_DEPTH: Record<WallMode, number> = { room: 2, outdoor: 1 };

// ---------------------------------------------------------------- needs
/** What a tile can ask of its surroundings. Each need is one question about one tile. */
export type NeedId = 'level' | 'view' | 'footing';

interface NeedDef {
  /** completes "<name> needs ..." */
  wants: string;
  holds: (c: TileCtx, i: number) => boolean;
}

export const NEEDS: Record<NeedId, NeedDef> = {
  level: { wants: 'level ground: it stands on the face of a height step', holds: (c, i) => !c.edge(i) },
  view: { wants: 'to stay clear of the wall face behind it: it is tall and hides the face', holds: (c, i) => !c.underFace(i) },
  footing: { wants: 'a tile that can be walked on', holds: (c, i) => !c.dim.solid[i] },
};

// ---------------------------------------------------------------- the table
export interface GroundSpec {
  name: string;
  /** floor: can be stood on; wall: built or natural wall; liquid: water, lava; none: nothing there */
  is: 'floor' | 'wall' | 'liquid' | 'none';
  /** the kinds of map it belongs on */
  on: DimKind[];
  /** wall patterns it has when it stands above its neighbours (every tile also has the lip) */
  faces: WallMode[];
}

export interface PropSpec {
  name: string;
  /** blocks the way */
  solid: boolean;
  /** stands well above its tile */
  tall?: boolean;
  on: DimKind[];
  needs: NeedId[];
  /** what it becomes where a need is not met (default: it is removed) */
  instead?: Partial<Record<NeedId, number>>;
}

const ANY: DimKind[] = ['overworld', 'underworld', 'sky', 'interior'];
const OUT: WallMode[] = ['outdoor'], IN: WallMode[] = ['room'], BOTH: WallMode[] = ['room', 'outdoor'];

export const GROUNDS: Record<number, GroundSpec> = {
  [T.VOID]: { name: 'Nothing', is: 'none', on: ANY, faces: BOTH },
  [T.GRASS]: { name: 'Grass', is: 'floor', on: ['overworld'], faces: OUT },
  [T.SAND]: { name: 'Sand', is: 'floor', on: ['overworld'], faces: OUT },
  [T.DIRT]: { name: 'Dirt', is: 'floor', on: ['overworld'], faces: OUT },
  [T.STONE]: { name: 'Stone', is: 'floor', on: ['overworld', 'interior'], faces: BOTH },
  [T.SNOW]: { name: 'Snow', is: 'floor', on: ['overworld'], faces: OUT },
  [T.WATER]: { name: 'Water', is: 'liquid', on: ANY, faces: BOTH },
  [T.DEEP]: { name: 'Deep water', is: 'liquid', on: ['overworld'], faces: OUT },
  [T.FLOOR]: { name: 'Dungeon floor', is: 'floor', on: ['interior'], faces: IN },
  [T.WALL]: { name: 'Built wall', is: 'wall', on: ['interior', 'overworld'], faces: BOTH },
  [T.CAVE]: { name: 'Cave floor', is: 'floor', on: ['underworld', 'interior'], faces: IN },
  [T.CAVEWALL]: { name: 'Cave wall', is: 'wall', on: ['underworld', 'interior'], faces: IN },
  [T.CLOUD]: { name: 'Cloud', is: 'floor', on: ['sky'], faces: OUT },
  [T.PATH]: { name: 'Path', is: 'floor', on: ['overworld', 'interior'], faces: BOTH },
  [T.LAVA]: { name: 'Lava', is: 'liquid', on: ['underworld', 'interior'], faces: IN },
  [T.PLANK]: { name: 'Planks', is: 'floor', on: ANY, faces: BOTH },
  [T.SWAMP]: { name: 'Marsh', is: 'floor', on: ['overworld'], faces: OUT },
};

const tree = (name: string): PropSpec => ({ name, solid: true, tall: true, on: ['overworld'], needs: ['level', 'view'], instead: { view: D.ROCK } });

export const PROPS: Record<number, PropSpec> = {
  [D.TREE]: tree('Tree'),
  [D.PINE]: tree('Pine'),
  [D.PALM]: tree('Palm'),
  [D.DEADTREE]: tree('Dead tree'),
  [D.CACTUS]: tree('Cactus'),
  [D.ROCK]: { name: 'Rock', solid: true, on: ANY, needs: ['level'] },
  [D.TUFT]: { name: 'Grass tuft', solid: false, on: ['overworld', 'underworld'], needs: ['level'] },
  [D.FLOWER]: { name: 'Flower', solid: false, on: ['overworld'], needs: ['level'] },
  [D.REED]: { name: 'Reeds', solid: false, on: ['overworld'], needs: ['level'] },
  [D.MUSHROOM]: { name: 'Mushroom', solid: false, on: ['overworld', 'underworld'], needs: ['level'] },
  [D.CRYSTAL]: { name: 'Crystal', solid: true, on: ['underworld', 'interior'], needs: ['level'] },
  [D.STALAG]: { name: 'Stalagmite', solid: true, on: ['underworld', 'interior'], needs: ['level'] },
  [D.PILLAR]: { name: 'Pillar', solid: true, tall: true, on: ['overworld', 'sky', 'interior'], needs: ['level'] },
  [D.HOUSE]: { name: 'Building', solid: true, tall: true, on: ['overworld'], needs: ['level'] },
};

/** Things placed on the map. Gates, ledges and stairs belong on a step, so they ask for nothing. */
export const OBJECTS: Partial<Record<MapObject['kind'], { name: string; needs: NeedId[] }>> = {
  chest: { name: 'Chest', needs: ['level', 'footing'] },
  npc: { name: 'Character', needs: ['level', 'footing'] },
  start: { name: 'Start', needs: ['level', 'footing'] },
  source: { name: 'Refill', needs: ['level', 'footing'] },
  boss: { name: 'Boss', needs: ['level', 'footing'] },
  enemy: { name: 'Creature', needs: ['level', 'footing'] },
  entrance: { name: 'Entrance', needs: ['footing'] },
};

/** Objects that join two heights: a step between walkable tiles is fine where one of them stands. */
const JOINS = new Set<MapObject['kind']>(['stairs', 'gate', 'ledge', 'entrance']);

// ---------------------------------------------------------------- what a tile can see of its surroundings
export interface TileCtx {
  dim: Dimension;
  mode: WallMode;
  /** ground that can be lower than something: not liquid, not nothing */
  land: (j: number) => boolean;
  /** stands above land beside it (so it shows a face) */
  edge: (i: number) => boolean;
  /** directly below a face that looks at the camera */
  underFace: (i: number) => boolean;
  /** tiles of ground at least this high, counted southward from i (i included) */
  depthSouth: (i: number) => number;
  joins: Set<number>;
}

const isLand = (dim: Dimension, j: number) => j >= 0 && j < dim.w * dim.h && GROUNDS[dim.ground[j]]?.is !== 'liquid' && dim.ground[j] !== T.VOID;

/** Would ground of height `e` on tile i stand above land beside it? (Asked while a map is still being built.) */
export function standsAbove(dim: Dimension, i: number, e: number = dim.elev[i]): boolean {
  const { w } = dim, x = i % w;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((!dx && !dy) || x + dx < 0 || x + dx >= w) continue;
    const j = i + dy * w + dx;
    if (isLand(dim, j) && dim.elev[j] < e) return true;
  }
  return false;
}

/** Can something of this kind be put on tile i, as far as the table's needs go? (Footing is the placer's own business.) */
export function canHold(dim: Dimension, i: number, kind: MapObject['kind']): boolean {
  return !(OBJECTS[kind]?.needs.includes('level') && isLand(dim, i) && standsAbove(dim, i));
}

export function tileCtx(dim: Dimension): TileCtx {
  const { w, elev } = dim, n = w * dim.h;
  const land = (j: number) => isLand(dim, j);
  const edgeMemo = new Int8Array(n).fill(-1);
  const edge = (i: number) => {
    if (edgeMemo[i] < 0) edgeMemo[i] = land(i) && standsAbove(dim, i) ? 1 : 0;
    return edgeMemo[i] === 1;
  };
  return {
    dim, mode: WALL_MODE[dim.kind], land, edge,
    underFace: (i) => i - w >= 0 && land(i - w) && elev[i - w] > elev[i],
    depthSouth: (i) => { let d = 0; for (let j = i; j < n && land(j) && elev[j] >= elev[i]; j += w) d++; return d; },
    joins: new Set(dim.objects.filter((o) => JOINS.has(o.kind)).map((o) => o.y * w + o.x)),
  };
}

/** A raised tile whose face looks north but has too little raised ground behind it for that face. */
export const lacksDepth = (c: TileCtx, i: number): boolean => {
  const { dim } = c, north = i - dim.w;
  return c.land(i) && north >= 0 && c.land(north) && dim.elev[north] < dim.elev[i] && c.depthSouth(i) < FACE_DEPTH[c.mode];
};

// ---------------------------------------------------------------- the checker
export interface TileIssue {
  dim: string;
  x: number;
  y: number;
  /** the tile, prop or object concerned */
  what: string;
  /** what it lacks, worded from the table */
  lacks: string;
}

/** Every unmet need on one map. */
export function checkTiles(dim: Dimension): TileIssue[] {
  const c = tileCtx(dim);
  const { w, h, ground, deco, elev, solid } = dim;
  const out: TileIssue[] = [];
  const say = (i: number, what: string, lacks: string) => out.push({ dim: dim.name, x: i % w, y: (i / w) | 0, what, lacks });
  const where = dim.kind === 'interior' ? 'an interior' : dim.kind === 'overworld' ? 'the overworld' : dim.kind === 'underworld' ? 'the underworld' : 'the sky';
  for (let i = 0; i < w * h; i++) {
    const g = GROUNDS[ground[i]];
    if (!g) { say(i, `Ground ${ground[i]}`, 'an entry in the tile table'); continue; }
    if (g.is === 'none') continue;
    if (!g.on.includes(dim.kind)) say(i, g.name, `to be on a map it belongs on (not ${where})`);
    if (g.is !== 'liquid' && c.edge(i)) {
      // it shows faces: it must have this kind of map's pattern, and room for it
      if (!g.faces.includes(c.mode)) say(i, g.name, `${c.mode} wall faces: it stands above its neighbours in ${where}`);
      if (!dim.lip?.[i] && lacksDepth(c, i)) say(i, g.name, `${FACE_DEPTH[c.mode]} tiles of depth behind its north face, or the lip pattern`);
    }
    // a step between two walkable tiles is only passable, and only drawn right, with something that joins them
    if (!solid[i] && g.is === 'floor') {
      for (const j of [(i % w) + 1 < w ? i + 1 : -1, i + w < w * h ? i + w : -1]) {
        if (j < 0 || solid[j] || GROUNDS[ground[j]]?.is !== 'floor' || elev[j] === elev[i]) continue;
        if (!c.joins.has(i) && !c.joins.has(j)) say(i, g.name, 'stairs: a height step lies between two tiles that can be walked on');
      }
    }
    const p = deco[i] ? PROPS[deco[i]] : null;
    if (deco[i] && !p) say(i, `Prop ${deco[i]}`, 'an entry in the tile table');
    if (p) {
      if (!p.on.includes(dim.kind)) say(i, p.name, `to be on a map it belongs on (not ${where})`);
      for (const need of p.needs) if (!NEEDS[need].holds(c, i)) say(i, p.name, NEEDS[need].wants);
    }
  }
  for (const o of dim.objects) {
    const spec = OBJECTS[o.kind];
    if (!spec || o.x < 0 || o.y < 0 || o.x >= w || o.y >= h) continue;
    for (const need of spec.needs) if (!NEEDS[need].holds(c, o.y * w + o.x)) say(o.y * w + o.x, `${spec.name} (${o.label})`, NEEDS[need].wants);
  }
  void h;
  return out;
}

/** The issues of a whole world as a few lines: one per kind of problem, with a count and a place to look. */
export function summariseIssues(issues: TileIssue[], max = 4): string[] {
  const groups = new Map<string, { n: number; first: TileIssue }>();
  for (const it of issues) {
    const key = `${it.what.replace(/ \(.*\)$/, '')} needs ${it.lacks}`;
    const g = groups.get(key);
    if (g) g.n++; else groups.set(key, { n: 1, first: it });
  }
  return [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, max)
    .map(([key, g]) => `${key} (${g.n}×, e.g. ${g.first.dim} at ${g.first.x},${g.first.y})`);
}
