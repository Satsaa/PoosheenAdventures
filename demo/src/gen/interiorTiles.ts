// Interiors. Rooms sit on a grid of cells, but the grid is uneven (every column and row has its
// own size), neighbouring rooms share one wall, a room may be inset so its walls are thicker,
// doors become short tunnels, open doorways become wide arches, and rooms get features. The
// logic graph is unchanged: one zone per room, one gate per edge, all verified afterwards.
import { D, T, type Dimension, type LocId, type MapObject } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import type { InteriorBP, ObjTpl } from './blueprint';

const STYLE: Record<string, { floor: number; wall: number }> = {
  dungeon: { floor: T.FLOOR, wall: T.WALL },
  sanctum: { floor: T.STONE, wall: T.WALL },
  cave: { floor: T.CAVE, wall: T.CAVEWALL },
  shop: { floor: T.PLANK, wall: T.WALL },
  house: { floor: T.PLANK, wall: T.WALL },
};

export interface InteriorTiles {
  dim: Dimension;
  /** tile of the way out, inside the entry room */
  exit: { x: number; y: number };
  /** tiles that separate zones: door tile index -> edge id */
  barriers: Map<number, string>;
  /** anchor tile index -> zone, for the tile/graph consistency check */
  anchors: Map<number, LocId>;
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

export function realiseInterior(bp: InteriorBP, seed: number): InteriorTiles {
  const rng = new Rng(childSeed(seed, bp.id));
  const st = STYLE[bp.style] ?? STYLE.dungeon;
  const dungeon = bp.rooms.length > 1;

  // 1. the uneven grid: floor span of every column and row, with one shared wall line between
  const colW = Array.from({ length: bp.gw }, () => (dungeon ? rng.range(7, 12) : 10));
  const rowH = Array.from({ length: bp.gh }, () => (dungeon ? rng.range(6, 9) : 8));
  const colX: number[] = [], rowY: number[] = [];
  let w = 1, h = 1;
  for (const c of colW) { colX.push(w); w += c + 1; }
  for (const r of rowH) { rowY.push(h); h += r + 1; }
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
  const floor = (i: number) => { dim.ground[i] = st.floor; dim.elev[i] = 0; dim.solid[i] = 0; dim.deco[i] = D.NONE; };
  const wall = (i: number) => { dim.ground[i] = st.wall; dim.elev[i] = 1; dim.solid[i] = 1; dim.deco[i] = D.NONE; };

  // 2. every room: its cell becomes wall, then the room is cut out of it, sometimes inset so the
  //    walls on that side are two or three thick
  const rects: Rect[] = bp.rooms.map((room, ri) => {
    const cx = room.cell % bp.gw, cy = (room.cell / bp.gw) | 0;
    const X = colX[cx], Y = rowY[cy], cw = colW[cx], ch = rowH[cy];
    for (let y = Y - 1; y <= Y + ch; y++) for (let x = X - 1; x <= X + cw; x++) { wall(at(x, y)); dim.region[at(x, y)] = ri; }
    const inset = () => (dungeon && !room.far && rng.chance(0.35) ? rng.range(1, 2) : 0);
    let l = inset(), r = inset(), t = inset(), b = inset();
    if (cw - l - r < 5) { l = 0; r = 0; }
    if (ch - t - b < 4) { t = 0; b = 0; }
    if (ri === bp.entryRoom) b = 0; // the way out is in the bottom wall
    const rect = { x0: X + l, y0: Y + t, x1: X + cw - 1 - r, y1: Y + ch - 1 - b };
    for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) floor(at(x, y));
    dim.regions.push({ id: room.loc, name: '', biome: bp.style, elev: 0, x: (rect.x0 + rect.x1) >> 1, y: (rect.y0 + rect.y1) >> 1, color: '#888' });
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
    const width = d.gate === 'open' ? Math.min(rng.range(2, 3), hi - lo + 1) : 1;
    const first = rng.range(lo, hi - width + 1);
    // the shared wall line: the one tile row/column that belongs to neither cell's floor span
    const qc = bp.rooms[horizontal ? (A.x0 < B.x0 ? d.b : d.a) : (A.y0 < B.y0 ? d.b : d.a)].cell;
    const line = horizontal ? colX[qc % bp.gw] - 1 : rowY[(qc / bp.gw) | 0] - 1;
    for (let k = 0; k < width; k++) {
      const c = first + k;
      const from = horizontal ? P.x1 + 1 : P.y1 + 1, to = horizontal ? Q.x0 - 1 : Q.y0 - 1;
      for (let s = from; s <= to; s++) { const i = horizontal ? at(s, c) : at(c, s); floor(i); taken.add(i); }
      const gate = horizontal ? at(line, c) : at(c, line);
      barriers.set(gate, d.edgeId);
      // keep the mouths clear on both sides
      for (const m of [from - 1, from - 2, to + 1, to + 2]) taken.add(horizontal ? at(m, c) : at(c, m));
    }
    const mid = first + ((width - 1) >> 1);
    dim.objects.push({
      id: 'g.' + d.edgeId, kind: 'gate', x: horizontal ? line : mid, y: horizontal ? mid : line, label: d.label, gate: d.gate, req: d.req, edgeId: d.edgeId,
      dir: horizontal ? 'e' : 's',
    });
  }

  // 4. the way out: bottom middle of the entry room
  const E = rects[bp.entryRoom];
  const exit = { x: (E.x0 + E.x1) >> 1, y: E.y1 };
  taken.add(at(exit.x, exit.y));
  taken.add(at(exit.x, exit.y - 1));
  dim.ground[at(exit.x, exit.y + 1)] = T.PATH;

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
      const kind = rng.weighted(['plain', 'pillars', 'pool', 'pit', 'corners', 'rows'], (k) =>
        k === 'plain' ? 2 : k === 'pillars' ? 3 : k === 'rows' ? (rw >= 8 ? 2 : 0) : k === 'corners' ? 2 : rw >= 7 && rh >= 6 && dungeon ? 1.5 : 0);
      if (kind === 'pillars') {
        for (const [px, py] of [[R.x0 + 2, R.y0 + 1], [R.x1 - 2, R.y0 + 1], [R.x0 + 2, R.y1 - 1], [R.x1 - 2, R.y1 - 1]]) if (free(at(px, py))) block(at(px, py), prop);
      } else if (kind === 'rows') {
        for (let x = R.x0 + 2; x <= R.x1 - 2; x += 2) for (const y of [R.y0 + 1, R.y1 - 1]) if (free(at(x, y)) && rh >= 5) block(at(x, y), prop);
      } else if (kind === 'pool' || kind === 'pit') {
        // a pool or pit in the middle, with at least two tiles of floor all the way round
        for (let y = R.y0 + 2; y <= R.y1 - 2; y++) for (let x = R.x0 + 2; x <= R.x1 - 2; x++) {
          const i = at(x, y);
          dim.solid[i] = 1; taken.add(i);
          dim.ground[i] = kind === 'pool' ? T.WATER : T.VOID;
        }
      } else if (kind === 'corners') {
        // cut corners make an eight-sided room
        for (const [cx, cy, sx, sy] of [[R.x0, R.y0, 1, 1], [R.x1, R.y0, -1, 1], [R.x0, R.y1, 1, -1], [R.x1, R.y1, -1, -1]]) {
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1]]) { const i = at(cx + ox * sx, cy + oy * sy); if (free(i)) wall(i); }
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
          if (!free(i) || (!small && (taken.has(i - 1) || taken.has(i + 1)))) continue;
          taken.add(i);
          dim.objects.push({ ...tpl, x, y } as MapObject);
          placed = true;
        }
        if (!placed && !small) {
          // crowded room: take any free tile rather than lose a chest
          for (let y = y0; y <= y1 && !placed; y++) for (let x = R.x0; x <= R.x1 && !placed; x++) {
            if (!free(at(x, y))) continue;
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
  return { dim, exit, barriers, anchors };
}
