// Interiors: every room is one screen. Rooms sit on a grid, doors go through shared walls.
import { D, T, type Dimension, type LocId, type MapObject } from '../core/types';
import { Rng, childSeed } from '../core/rng';
import type { InteriorBP } from './blueprint';
import { SH, SW } from './spatial';

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

export function realiseInterior(bp: InteriorBP, seed: number): InteriorTiles {
  const rng = new Rng(childSeed(seed, bp.id));
  const w = bp.gw * SW, h = bp.gh * SH, n = w * h;
  const st = STYLE[bp.style] ?? STYLE.dungeon;
  const dim: Dimension = {
    id: bp.id, name: bp.name, kind: 'interior', w, h, sw: SW, sh: SH,
    ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n), solid: new Uint8Array(n).fill(1),
    region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [],
  };
  const anchors = new Map<number, LocId>();
  const barriers = new Map<number, string>();
  const taken = new Set<number>();
  const origin = (cell: number) => ({ x0: (cell % bp.gw) * SW, y0: ((cell / bp.gw) | 0) * SH });
  const floor = (i: number) => { dim.ground[i] = st.floor; dim.elev[i] = 0; dim.solid[i] = 0; dim.deco[i] = D.NONE; };

  bp.rooms.forEach((room, ri) => {
    const { x0, y0 } = origin(room.cell);
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const i = (y0 + y) * w + x0 + x;
      dim.region[i] = ri;
      if (x === 0 || y === 0 || x === SW - 1 || y === SH - 1) { dim.ground[i] = st.wall; dim.elev[i] = 1; }
      else floor(i);
    }
    anchors.set((y0 + 1) * w + x0 + 1, room.loc);
    taken.add((y0 + 1) * w + x0 + 1);
    dim.regions.push({ id: room.loc, name: '', biome: bp.style, elev: 0, x: x0 + SW / 2, y: y0 + SH / 2, color: '#888' });
  });

  // doors: carve both wall tiles; the gate sits on the first one and splits the two zones
  for (const d of bp.doors) {
    const A = origin(bp.rooms[d.a].cell), B = origin(bp.rooms[d.b].cell);
    const horizontal = A.y0 === B.y0;
    const L = horizontal ? (A.x0 < B.x0 ? A : B) : (A.y0 < B.y0 ? A : B);
    const off = horizontal ? rng.range(3, SH - 4) : rng.range(3, SW - 4);
    const t1 = horizontal ? (L.y0 + off) * w + L.x0 + SW - 1 : (L.y0 + SH - 1) * w + L.x0 + off;
    const t2 = horizontal ? t1 + 1 : t1 + w;
    floor(t1); floor(t2);
    barriers.set(t1, d.edgeId);
    for (const t of [t1, t2, horizontal ? t1 - 1 : t1 - w, horizontal ? t2 + 1 : t2 + w]) taken.add(t);
    dim.objects.push({ id: 'g.' + d.edgeId, kind: 'gate', x: t1 % w, y: (t1 / w) | 0, label: d.label, gate: d.gate, req: d.req, edgeId: d.edgeId });
  }

  // the way out: bottom middle of the entry room
  const E = origin(bp.rooms[bp.entryRoom].cell);
  const exit = { x: E.x0 + (SW >> 1), y: E.y0 + SH - 2 };
  taken.add(exit.y * w + exit.x);
  taken.add((exit.y - 1) * w + exit.x);
  dim.ground[(exit.y + 1) * w + exit.x] = T.PATH;

  // pillars give rooms some shape without ever blocking a door or cutting the floor in two
  bp.rooms.forEach((room) => {
    const { x0, y0 } = origin(room.cell);
    const bare = bp.style === 'shop' || bp.style === 'house';
    const deco = bp.style === 'cave' ? (rng.chance(0.5) ? D.STALAG : D.CRYSTAL) : D.PILLAR;
    for (const [px, py] of [[3, 3], [SW - 4, 3], [3, SH - 4], [SW - 4, SH - 4]]) {
      if (bare || !rng.chance(0.6)) continue;
      const i = (y0 + py) * w + x0 + px;
      if (taken.has(i)) continue;
      dim.solid[i] = 1; dim.deco[i] = deco; taken.add(i);
    }
    // objects on free floor, spaced out
    for (const tpl of room.objs) {
      for (let tries = 0; tries < 200; tries++) {
        const x = x0 + rng.range(2, SW - 3), y = y0 + rng.range(2, SH - 3), i = y * w + x;
        if (taken.has(i) || taken.has(i - 1) || taken.has(i + 1) || dim.solid[i]) continue;
        taken.add(i);
        dim.objects.push({ ...tpl, x, y } as MapObject);
        break;
      }
    }
  });
  return { dim, exit, barriers, anchors };
}
