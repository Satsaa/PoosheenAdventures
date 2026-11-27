// Interiors. Rooms sit on a grid of cells, but the grid is uneven (every column and row has its
// own size), neighbouring rooms share one wall, a room may be inset so its walls are thicker,
// doors become short tunnels, open doorways become wide arches, and rooms get features. The
// logic graph is unchanged: one zone per room, one gate per edge, all verified afterwards.
import { D, T, type Dimension, type LocId, type MapObject } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import type { InteriorBP, ObjTpl } from './blueprint';
import { canHold } from '../core/tileset';

const STYLE: Record<string, { floor: number; wall: number }> = {
  dungeon: { floor: T.FLOOR, wall: T.WALL },
  sanctum: { floor: T.STONE, wall: T.WALL },
  cave: { floor: T.CAVE, wall: T.CAVEWALL },
  shop: { floor: T.PLANK, wall: T.WALL },
  house: { floor: T.PLANK, wall: T.WALL },
};

export interface InteriorTiles {
  dim: Dimension;
  /** tile of the way out, inside the entry room (floors without a way out to the world: -1, -1) */
  exit: { x: number; y: number };
  /** further ways out (a tunnel's other mouth): edge id -> tile inside the room it is in */
  exits: Map<string, { x: number; y: number }>;
  /** tiles that separate zones: door tile index -> edge id */
  barriers: Map<number, string>;
  /** anchor tile index -> zone, for the tile/graph consistency check */
  anchors: Map<number, LocId>;
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** wall thickness in tiles */
const WT = 6;

export function realiseInterior(bp: InteriorBP, seed: number): InteriorTiles {
  const rng = new Rng(childSeed(seed, bp.id));
  const st = STYLE[bp.style] ?? STYLE.dungeon;
  const dungeon = bp.rooms.length > 1;

  // 1. the uneven grid: floor span of every column and row, with one shared wall line between.
  //    Floors of one building draw the same grid, so stairs come out at the same tile on both.
  const grid = new Rng(childSeed(seed, 'grid' + (bp.group ?? bp.id)));
  const colW = Array.from({ length: bp.gw }, () => (dungeon ? grid.range(7, 12) : 10));
  const rowH = Array.from({ length: bp.gh }, () => (dungeon ? grid.range(6, 9) : 8));
  //    Walls are WT tiles thick: every side of a room shows its wall as a face that leans away
  //    from the floor, and a wall needs the depth for a face on either side of it.
  const colX: number[] = [], rowY: number[] = [];
  let w = WT, h = WT;
  for (const c of colW) { colX.push(w); w += c + WT; }
  for (const r of rowH) { rowY.push(h); h += r + WT; }
  const n = w * h;
  const dim: Dimension = {
    id: bp.id, name: bp.name, kind: 'interior', w, h, sw: 12, sh: 10,
    ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n), solid: new Uint8Array(n).fill(1),
    region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [],
  };
  const anchors = new Map<number, LocId>();
  const barriers = new Map<number, string>();
  const taken = new Set<number>();
  const at = (x: number, y: number) => y * w + x;
  const floor = (i: number, e = 0) => { dim.ground[i] = st.floor; dim.elev[i] = e; dim.solid[i] = 0; dim.deco[i] = D.NONE; };
  const wall = (i: number, e = 0) => { dim.ground[i] = st.wall; dim.elev[i] = e + 1; dim.solid[i] = 1; dim.deco[i] = D.NONE; };
  const elevOf = (ri: number) => bp.rooms[ri].elev ?? 0;
  const stairRooms = new Set((bp.stairs ?? []).map((x) => x.room));
  const exitRooms = new Set([...(bp.floor ? [] : [bp.entryRoom]), ...(bp.exits ?? []).map((x) => x.room)]);
  if (bp.group) { dim.group = bp.group; dim.floor = bp.floorName; }

  // 2. every room: its cell becomes wall, then the room is cut out of it, sometimes inset so the
  //    walls on that side are two or three thick
  const rects: Rect[] = bp.rooms.map((room, ri) => {
    const cx = room.cell % bp.gw, cy = (room.cell / bp.gw) | 0;
    const X = colX[cx], Y = rowY[cy], cw = colW[cx], ch = rowH[cy];
    const E = elevOf(ri);
    // (a wall shared with a higher room keeps the higher top)
    for (let y = Y - WT; y < Y + ch + WT; y++) for (let x = X - WT; x < X + cw + WT; x++) { const i = at(x, y), was = dim.ground[i] === st.wall ? dim.elev[i] : 0; wall(i, E); dim.elev[i] = Math.max(dim.elev[i], was); dim.region[i] = ri; }
    const inset = () => (dungeon && !room.far && !stairRooms.has(ri) && rng.chance(0.35) ? rng.range(1, 2) : 0);
    let l = inset(), r = inset(), t = inset(), b = inset();
    if (cw - l - r < 5) { l = 0; r = 0; }
    if (ch - t - b < 4) { t = 0; b = 0; }
    if (exitRooms.has(ri)) b = 0; // the way out is in the bottom wall
    const rect = { x0: X + l, y0: Y + t, x1: X + cw - 1 - r, y1: Y + ch - 1 - b };
    for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) floor(at(x, y), E);
    dim.regions.push({ id: room.loc, name: '', biome: bp.style, elev: E, x: (rect.x0 + rect.x1) >> 1, y: (rect.y0 + rect.y1) >> 1, color: '#888' });
    return rect;
  });

  // 3. doors: a tunnel from room to room through whatever wall lies between. Open doorways are
  //    wide arches; anything gated is one tile wide so the gate fills it.
  for (const d of bp.doors) {
    const A = rects[d.a], B = rects[d.b];
    const ca = bp.rooms[d.a].cell, cb = bp.rooms[d.b].cell;
    const horizontal = ((ca / bp.gw) | 0) === ((cb / bp.gw) | 0);
    const [P, Q] = (horizontal ? A.x0 < B.x0 : A.y0 < B.y0) ? [A, B] : [B, A]; // P is left / above
    const lo = horizontal ? Math.max(P.y0, Q.y0) : Math.max(P.x0, Q.x0);
    const hi = horizontal ? Math.min(P.y1, Q.y1) : Math.min(P.x1, Q.x1);
    // (a passage that changes height is one flight of stairs wide)
    const level = elevOf(d.a) === elevOf(d.b);
    const width = d.gate === 'open' && level ? Math.min(rng.range(2, 3), hi - lo + 1) : 1;
    const first = rng.range(lo, hi - width + 1);
    // the shared wall line: the one tile row/column that belongs to neither cell's floor span
    const qc = bp.rooms[horizontal ? (A.x0 < B.x0 ? d.b : d.a) : (A.y0 < B.y0 ? d.b : d.a)].cell;
    const line = horizontal ? colX[qc % bp.gw] - 1 : rowY[(qc / bp.gw) | 0] - 1;
    // rooms at different heights: the passage stays level up to the gate, then steps up or down
    const eP = elevOf(P === A ? d.a : d.b), eQ = elevOf(P === A ? d.b : d.a);
    for (let k = 0; k < width; k++) {
      const c = first + k;
      const from = horizontal ? P.x1 + 1 : P.y1 + 1, to = horizontal ? Q.x0 - 1 : Q.y0 - 1;
      for (let s = from; s <= to; s++) {
        const i = horizontal ? at(s, c) : at(c, s);
        floor(i, s <= line ? eP : eQ);
        if (d.gate === 'water') dim.ground[i] = T.WATER; // a flooded passage: swim through
        taken.add(i);
      }
      const gate = horizontal ? at(line, c) : at(c, line);
      barriers.set(gate, d.edgeId);
      // keep the mouths clear on both sides
      for (const m of [from - 1, from - 2, to + 1, to + 2]) taken.add(horizontal ? at(m, c) : at(c, m));
      if (eP !== eQ) dim.objects.push({ id: `s.${d.edgeId}.${k}`, kind: 'stairs', x: horizontal ? line + 1 : c, y: horizontal ? c : line + 1, label: 'Stairs', dir: horizontal ? 'e' : 's' });
    }
    const mid = first + ((width - 1) >> 1);
    dim.objects.push({
      id: 'g.' + d.edgeId, kind: 'gate', x: horizontal ? line : mid, y: horizontal ? mid : line, label: d.label, gate: d.gate, req: d.req, edgeId: d.edgeId,
      dir: horizontal ? 'e' : 's',
    });
  }

  // 4. the ways out: bottom middle of the entry room, and of every other room that has a mouth
  const wayOut = (ri: number) => {
    const R = rects[ri], x = (R.x0 + R.x1) >> 1, y = R.y1;
    taken.add(at(x, y));
    taken.add(at(x, y - 1));
    // the doorway: a gap through the whole south wall, at floor level (not walkable: the door object leads out)
    for (let yy = y + 1; yy < h; yy++) { const i = at(x, yy); dim.ground[i] = T.PATH; dim.elev[i] = elevOf(ri); }
    return { x, y };
  };
  const exit = bp.floor ? { x: -1, y: -1 } : wayOut(bp.entryRoom);
  const exits = new Map((bp.exits ?? []).map((x) => [x.edgeId, wayOut(x.room)] as const));

  // 4b. stairs to the floor above or below: at the middle of the cell, which every floor shares
  for (const sb of bp.stairs ?? []) {
    const cell = bp.rooms[sb.room].cell, cx = cell % bp.gw, cy = (cell / bp.gw) | 0;
    const x = colX[cx] + (colW[cx] >> 1) + (sb.slot ? 1 : -1), y = rowY[cy] + (rowH[cy] >> 1);
    for (const i of [at(x, y), at(x, y - 1), at(x, y + 1), at(x + (sb.slot ? 1 : -1), y)]) taken.add(i);
    dim.objects.push({
      id: 'v.' + sb.edgeId, kind: 'entrance', x, y, label: sb.label, style: sb.up ? 'stairs-up' : 'stairs-down', edgeId: sb.edgeId,
      gate: sb.gate === 'open' ? undefined : sb.gate, req: sb.req, to: { dim: sb.to, x, y },
    });
    if (sb.home) dim.parent = { dim: sb.to, x, y };
  }

  // 5. what is inside each room
  bp.rooms.forEach((room, ri) => {
    const R = rects[ri];
    const rw = R.x1 - R.x0 + 1, rh = R.y1 - R.y0 + 1;
    const free = (i: number) => !dim.solid[i] && !taken.has(i);
    const block = (i: number, deco: number) => { dim.solid[i] = 1; dim.deco[i] = deco; taken.add(i); };
    const prop = bp.style === 'cave' ? (rng.chance(0.5) ? D.STALAG : D.CRYSTAL) : D.PILLAR;
    let riverRow = -1;

    if (room.far) {
      // an underground river crosses the room wall to wall; the whole band is the gate
      riverRow = R.y0 + ((rh - 2) >> 1);
      for (const y of [riverRow, riverRow + 1]) for (let x = R.x0; x <= R.x1; x++) {
        const i = at(x, y);
        dim.ground[i] = T.WATER; dim.solid[i] = 1;
        barriers.set(i, room.far.edgeId);
        taken.add(i);
      }
      dim.objects.push({ id: 'g.' + room.far.edgeId, kind: 'gate', x: (R.x0 + R.x1) >> 1, y: riverRow, label: 'Underground river', gate: 'water', req: room.far.req, edgeId: room.far.edgeId });
    } else if (bp.style !== 'shop' && bp.style !== 'house') {
      const cave = bp.style === 'cave', roomy = rw >= 7 && rh >= 6 && !stairRooms.has(ri);
      const kind = rng.weighted(['plain', 'pillars', 'pool', 'pit', 'corners', 'rows', 'ledge'], (k) =>
        k === 'plain' ? 2 : k === 'pillars' ? 3 : k === 'rows' ? (rw >= 8 ? 2 : 0) : k === 'corners' ? 2
        : k === 'ledge' ? (bp.heights && roomy ? (cave ? 3 : 1.5) : 0)
        : k === 'pool' ? (roomy && (dungeon || cave) ? (cave ? 2.5 : 1.5) : 0) : roomy && dungeon && !cave ? 1.5 : 0);
      if (kind === 'pillars') {
        for (const [px, py] of [[R.x0 + 2, R.y0 + 1], [R.x1 - 2, R.y0 + 1], [R.x0 + 2, R.y1 - 1], [R.x1 - 2, R.y1 - 1]]) if (free(at(px, py))) block(at(px, py), prop);
      } else if (kind === 'rows') {
        for (let x = R.x0 + 2; x <= R.x1 - 2; x += 2) for (const y of [R.y0 + 1, R.y1 - 1]) if (free(at(x, y)) && rh >= 5) block(at(x, y), prop);
      } else if (kind === 'pool' || kind === 'pit') {
        // a pool or pit in the middle, with at least two tiles of floor all the way round
        for (let y = R.y0 + 2; y <= R.y1 - 2; y++) for (let x = R.x0 + 2; x <= R.x1 - 2; x++) {
          const i = at(x, y);
          dim.solid[i] = 1; taken.add(i);
          dim.ground[i] = bp.lava ? T.LAVA : kind === 'pool' ? T.WATER : T.VOID;
        }
      } else if (kind === 'ledge') {
        // the back of the room is a ledge one step up. Its edge is a row that cannot be walked
        // (a height step never lies between two walkable tiles) with a gap for the stairs. Only
        // where no door or stair comes in at that height, so every passage still meets level floor.
        const rows = [R.y0, R.y0 + 1, R.y0 + 2, R.y0 + 3];
        let clear = true;
        for (const y of rows) for (let x = R.x0; x <= R.x1; x++) if (taken.has(at(x, y))) clear = false;
        if (clear) {
          const E = elevOf(ri), sx = rng.range(R.x0 + 1, R.x1 - 1), edge = R.y0 + 2;
          for (let y = R.y0; y <= edge; y++) for (let x = R.x0; x <= R.x1; x++) dim.elev[at(x, y)] = E + 1;
          for (let x = R.x0; x <= R.x1; x++) { dim.solid[at(x, edge)] = 1; taken.add(at(x, edge)); }
          // the stairs: a walkable gap in the edge, at the lower level
          dim.solid[at(sx, edge)] = 0;
          dim.elev[at(sx, edge)] = E;
          // the walls behind it rise with it
          for (let y = R.y0 - WT; y <= R.y0 + 2; y++) for (let x = R.x0 - WT; x <= R.x1 + WT; x++) { const i = at(x, y); if (dim.ground[i] === st.wall) dim.elev[i] = Math.max(dim.elev[i], E + 2); }
          dim.objects.push({ id: `s.ledge.${ri}`, kind: 'stairs', x: sx, y: edge, label: 'Stairs', dir: 'n' });
          taken.add(at(sx, edge - 1));
          taken.add(at(sx, edge + 1));
        }
      } else if (kind === 'corners') {
        // cut corners make an eight-sided room
        for (const [cx, cy, sx, sy] of [[R.x0, R.y0, 1, 1], [R.x1, R.y0, -1, 1], [R.x0, R.y1, 1, -1], [R.x1, R.y1, -1, -1]]) {
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) { const i = at(cx + ox * sx, cy + oy * sy); if (free(i)) wall(i, elevOf(ri)); }
        }
      }
    }

    // anchors name the zones: one on each bank if a river splits the room
    const anchor = (loc: LocId, y0: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = R.x0; x <= R.x1; x++) {
        const i = at(x, y);
        if (!dim.solid[i]) { anchors.set(i, loc); taken.add(i); return; }
      }
    };
    if (room.far) { anchor(room.far.loc, R.y0, riverRow - 1); anchor(room.loc, riverRow + 2, R.y1); }
    else anchor(room.loc, R.y0, R.y1);

    // objects on free floor, not shoulder to shoulder
    const drop = (tpls: ObjTpl[], y0: number, y1: number) => {
      for (const tpl of tpls) {
        const small = tpl.kind === 'enemy';
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const x = rng.range(R.x0 + (rw > 4 ? 1 : 0), R.x1 - (rw > 4 ? 1 : 0)), y = rng.range(y0, y1), i = at(x, y);
          if (!free(i) || !canHold(dim, i, tpl.kind) || (!small && (taken.has(i - 1) || taken.has(i + 1)))) continue;
          taken.add(i);
          dim.objects.push({ ...tpl, x, y } as MapObject);
          placed = true;
        }
        if (!placed && !small) {
          // crowded room: take any free tile rather than lose a chest
          for (let y = y0; y <= y1 && !placed; y++) for (let x = R.x0; x <= R.x1 && !placed; x++) {
            if (!free(at(x, y)) || !canHold(dim, at(x, y), tpl.kind)) continue;
            taken.add(at(x, y));
            dim.objects.push({ ...tpl, x, y } as MapObject);
            placed = true;
          }
        }
      }
    };
    if (room.far) { drop(room.objs, riverRow + 2, R.y1 - 1); drop(room.far.objs, R.y0, riverRow - 1); }
    else drop(room.objs, R.y0 + (rh > 3 ? 1 : 0), R.y1 - (rh > 3 ? 1 : 0));
  });
  return { dim, exit, exits, barriers, anchors };
}
