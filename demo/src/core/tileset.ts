// The tile set as data, and the one checker that reads it.
//
// Every ground, prop and object says what it is, where it belongs, which wall patterns it has
// when it is raised, and what it needs around it. Nothing else in the code decides that:
//   - the checker (`checkTiles`) walks every tile of every map and reports each unmet need,
//     wording the report from this table, so a new tile or a new need is checked without
//     writing a new warning;
//   - the generator's tidy-up (`gen/settle.ts`) asks the same questions and applies the
//     fix the table names (remove the prop, or swap it for a low one).
// The Rust port can load the same table.
import { D, T, type Dimension, type DimKind, type MapObject } from './types';
import { WALL_MODE, wallStyle, faceDepth, shortFace, cornerAt, facedAt, kindAt, levelAt, liftAt, reachesTop, thinAt, type WallMode } from './shape';

export { WALL_MODE, type WallMode } from './shape';


// ---------------------------------------------------------------- needs
/** What a tile can ask of its surroundings. Each need is one question about one tile. */
export type NeedId = 'level' | 'view' | 'footing';

interface NeedDef {
  /** completes "<name> needs ..." */
  wants: string;
  holds: (c: TileCtx, i: number) => boolean;
}

export const NEEDS: Record<NeedId, NeedDef> = {
  level: { wants: 'level ground: it stands on the face of a height step', holds: (c, i) => c.level(i) },
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
  /** solid ground: not liquid, not nothing */
  land: (j: number) => boolean;
  /** something beside it is lower, so it shows a face */
  edge: (i: number) => boolean;
  /** level where a thing would stand on it: no face under its middle or its sides */
  level: (i: number) => boolean;
  /** directly below a face that looks at the camera */
  underFace: (i: number) => boolean;
  joins: Set<number>;
}

/**
 * Can something of this kind be put on tile i, as far as the table's needs go? Asked by the
 * generator while it places things. (Footing is the placer's own business: it knows what is free.)
 */
export function canHold(dim: Dimension, i: number, kind: MapObject['kind']): boolean {
  return !OBJECTS[kind]?.needs.includes('level') || levelAt(dim, i);
}

export function tileCtx(dim: Dimension): TileCtx {
  const { w } = dim, n = w * dim.h;
  // where faces are and how high things stand comes from the one terrain model (core/shape.ts),
  // the same one the renderer draws: water below a bank makes a face just as land does
  const solidGround = (j: number) => j >= 0 && j < n && !(kindAt(dim, j) & 3);
  const memo = (f: (i: number) => boolean) => { const m = new Int8Array(n).fill(-1); return (i: number) => (m[i] < 0 ? (m[i] = f(i) ? 1 : 0) : m[i]) === 1; };
  return {
    dim, mode: WALL_MODE[dim.kind], land: solidGround,
    edge: memo((i) => facedAt(dim, i)),
    level: memo((i) => levelAt(dim, i)),
    underFace: (i) => solidGround(i) && solidGround(i - w) && liftAt(dim, i - w) > liftAt(dim, i),
    joins: new Set(dim.objects.filter((o) => JOINS.has(o.kind)).map((o) => o.y * w + o.x)),
  };
}


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
  const held = new Set(dim.objects.map((o) => o.y * w + o.x));
  const where = dim.kind === 'interior' ? 'an interior' : dim.kind === 'overworld' ? 'the overworld' : dim.kind === 'underworld' ? 'the underworld' : 'the sky';
  for (let i = 0; i < w * h; i++) {
    const g = GROUNDS[ground[i]];
    if (!g) { say(i, `Ground ${ground[i]}`, 'an entry in the tile table'); continue; }
    if (g.is === 'none') continue;
    if (!g.on.includes(dim.kind)) say(i, g.name, `to be on a map it belongs on (not ${where})`);
    if (g.is !== 'liquid' && c.edge(i)) {
      // it shows faces: it must have this kind of map's pattern, and its faces must leave it a top
      // (the terrain model fits faces to the room they have, so the second can only fail if the model does)
      if (!g.faces.includes(c.mode)) say(i, g.name, `${c.mode} wall faces: it stands above its neighbours in ${where}`);
      if (!reachesTop(dim, i)) say(i, g.name, 'a top: it is marked higher than what is beside it, but its faces leave none of it at that height');
    }
    if (g.is !== 'liquid' && thinAt(dim, i)) say(i, g.name, 'to be a place of its own: raised ground is at least its walls plus one tile of top across, and up and down');
    if (g.is !== 'liquid' && solid[i]) for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      // (where something stands right behind the edge, stairs or a chest, the face gives way to it)
      const b = shortFace(dim, i, dx, dy);
      // (so does a gate's own tile: closed ground that belongs to a zone)
      if (b >= 0 && !held.has(b) && !held.has(i) && dim.zone[i] < 0) { say(i, g.name, `closed ground ${faceDepth(dim, dx, dy)} tiles deep behind its wall face: walkable ground begins before the face ends`); break; }
    }
    if (dim.cut?.[i] && wallStyle(dim.kind, ground[i]).corners !== 'cut') say(i, g.name, 'square corners: its kind of wall is not cut at 45 degrees');
    if (dim.cut?.[i] && !cornerAt(dim, i)) say(i, g.name, 'an outward corner to be cut at 45 degrees: lower ground on two sides that meet, and not on the other two');
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
