// One small 3D model definition per asset. Each returns a Model (SDF + material ramps) that
// ./sdf.ts renders into a pixel sprite. To improve an asset, edit its definition here, or replace
// the whole sheet with real pre-rendered sprites (see ./sheet.ts).
import { D } from '../../core/types';
import { MAT } from './sheet';
import {
  type Mat, type Model, box, capsule, coneZ, cylZ, ellip, hashN, noise3, roofX, smin, sph, torusZ,
} from './sdf';

type F = (x: number, y: number, z: number) => number;
type Part = [F, number];

function model(mats: Mat[], parts: Part[], o: Partial<Model> & { zMax: number }): Model {
  return {
    ...o,
    mats,
    sdf: (x, y, z) => {
      let d = 1e9;
      for (let k = 0; k < parts.length; k++) { const v = parts[k][0](x, y, z); if (v < d) d = v; }
      return d;
    },
    mat: (x, y, z) => {
      let d = 1e9, m = 0;
      for (let k = 0; k < parts.length; k++) { const v = parts[k][0](x, y, z); if (v < d) { d = v; m = parts[k][1]; } }
      return m;
    },
  };
}

// ---------------------------------------------------------------- ramps
const R = {
  leaf: ['#10301e', '#19482a', '#276333', '#3b823e', '#5ea448'],
  leafDark: ['#0b2621', '#123a2f', '#1b5240', '#286a4c'],
  autumn: ['#3e130a', '#66240e', '#8f3a12', '#b45a1e', '#cc7e2e'],
  golden: ['#3a2a0b', '#614910', '#8a6e16', '#ad9224'],
  pine: ['#0a2220', '#103630', '#184e3f', '#25684f'],
  trunk: ['#20130b', '#352113', '#4d321c'],
  bark: ['#2c2622', '#433a33', '#5d5249', '#7a6d62'],
  rock: ['#211f28', '#33303c', '#4a4655', '#645f72'],
  rockWarm: ['#2a221e', '#40342c', '#5a4a3e', '#776352'],
  snow: ['#9fb6d8', '#cddcef', '#f2f7ff'],
  cactus: ['#103522', '#1a5532', '#297543', '#449a54'],
  cyan: ['#0a4566', '#167fae', '#43c9ef', '#c4f6ff'],
  magenta: ['#470a57', '#86199d', '#cc47de', '#f6c6ff'],
  capRed: ['#530d10', '#931c19', '#d13629', '#ef6a50'],
  capGlow: ['#08365a', '#16679a', '#35ace0', '#9ae2ff'],
  stem: ['#7a6c5c', '#b3a38c', '#e2d6c0'],
  stone: ['#3e3a46', '#615d6c', '#8b8797', '#b9b5c3'],
  reed: ['#253512', '#39541b', '#557528'],
  cattail: ['#331a0c', '#542d14'],
  stalag: ['#1b1626', '#2b233c', '#433856', '#5c4e75'],
  wall: ['#5c4c3c', '#8c765a', '#b8a17d', '#d8c39d'],
  timber: ['#241509', '#3a2412'],
  roof: ['#2a0c0c', '#461512', '#661f18', '#86301f'],
  glass: ['#ffb040', '#ffd27a'],
  wood: ['#2c190c', '#462a14', '#64401f', '#83582c'],
  woodLight: ['#4a2c14', '#6e4320', '#93602e', '#b47c3e'],
  gold: ['#6a4208', '#a8700e', '#e0aa22', '#ffe07a'],
  dark: ['#030205', '#08060c'],
  bone: ['#6e6456', '#a89c88', '#dcd2bf', '#f6efe0'],
  skin: ['#8a5a44', '#c08866', '#e8b892'],
  cloth: ['#7c7c84', '#a6a6ae', '#d0d0d8', '#f2f2f6'],
  helmet: ['#3a4050', '#626b80', '#9aa3b8', '#d4dae6'],
  clay: ['#4a2414', '#72381c', '#9a5228', '#c07038'],
  berry: ['#6a0a1c', '#c01a3a', '#ff4a6a'],
  petal: ['#7a1a5a', '#c43a8a', '#ff7ac8'],
  mint: ['#0e5a44', '#1a9a72', '#5ae0b0'],
  hero: ['#0e3a1c', '#1a6430', '#2c8e44', '#48b05a'],
  violet: ['#2a0a4a', '#5a1a8a', '#9a4ae0', '#d8a8ff'],
  red: ['#3a0610', '#6e0c1c', '#a8162a', '#d83040'],
  ember: ['#ff9a2a', '#ffd070'],
};

const n3 = noise3;

// ---------------------------------------------------------------- deco
export const CRYSTAL_LIGHT: [number, number, number][] = [[0.3, 0.85, 1.0], [0.95, 0.35, 1.0]];

export function decoModel(d: number, v: number, opt: { snow?: boolean; glow?: boolean } = {}): Model | null {
  const s = v * 13 + d * 7;
  const j = (k: number) => (hashN(v, k, d) - 0.5);
  switch (d) {
    case D.TREE: {
      const ramp = v === 3 ? R.autumn : v === 4 ? R.golden : v === 2 ? R.leafDark : R.leaf;
      const ox = j(1) * 0.08, oy = j(2) * 0.06, sc = 0.9 + hashN(v, 3, d) * 0.2;
      const blobs: [number, number, number, number][] = [
        [0.5, 0.56, 0.78, 0.34], [0.3, 0.62, 0.64, 0.24], [0.7, 0.62, 0.66, 0.24], [0.48, 0.48, 1.0, 0.23], [0.62, 0.5, 0.86, 0.2],
      ];
      const fol: F = (x, y, z) => {
        let dd = 1e9;
        for (const [bx, by, bz, br] of blobs) dd = smin(dd, sph(x, y, z, bx + ox, by + oy, bz * sc, br * sc), 0.12);
        return dd + (n3(x * 9, y * 9, z * 9, s) - 0.5) * 0.07;
      };
      return model([{ ramp: R.trunk }, { ramp, id: MAT.FOLIAGE }], [
        [(x, y, z) => cylZ(x, y, z, 0.5, 0.62, 0, 0.6, 0.07), 0],
        [fol, 1],
      ], { zMax: 1.3 * sc, padX: 0.25 });
    }
    case D.PINE: {
      const sc = 0.9 + hashN(v, 4, d) * 0.25;
      const tiers: [number, number, number][] = [[0.18, 0.6, 0.38], [0.48, 0.52, 0.3], [0.76, 0.46, 0.21]];
      const fol: F = (x, y, z) => {
        let dd = 1e9;
        for (const [z0, h, r] of tiers) dd = Math.min(dd, coneZ(x, y, z, 0.5, 0.56, z0 * sc, h * sc, r));
        return dd + (n3(x * 12, y * 12, z * 12, s) - 0.5) * 0.04;
      };
      return model([{ ramp: R.trunk }, { ramp: R.pine, id: MAT.FOLIAGE }, { ramp: R.snow }], [
        [(x, y, z) => cylZ(x, y, z, 0.5, 0.58, 0, 0.3, 0.06), 0],
        [fol, 1],
        ...(opt.snow ? [[(x: number, y: number, z: number) => fol(x, y, z - 0.035) + (n3(x * 10, y * 10, z * 10, s + 1) > 0.5 ? 0 : 0.05), 2] as Part] : []),
      ], { zMax: 1.3 * sc, padX: 0.15 });
    }
    case D.PALM: {
      const tx = 0.5 + j(1) * 0.1, ty = 0.5, tz = 1.05;
      const parts: Part[] = [
        [(x, y, z) => smin(capsule(x, y, z, 0.42, 0.62, 0, 0.52, 0.58, 0.55, 0.065), capsule(x, y, z, 0.52, 0.58, 0.55, tx, ty, tz, 0.055), 0.05), 0],
      ];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + v;
        const ex = tx + Math.cos(a) * 0.42, ey = ty + Math.sin(a) * 0.34, ez = tz - 0.22;
        parts.push([(x, y, z) => smin(capsule(x, y, z, tx, ty, tz, (tx + ex) / 2, (ty + ey) / 2, tz + 0.04, 0.05), capsule(x, y, z, (tx + ex) / 2, (ty + ey) / 2, tz + 0.04, ex, ey, ez, 0.04), 0.03), 1]);
      }
      return model([{ ramp: R.bark }, { ramp: R.leaf, id: MAT.FOLIAGE, bias: 0.5 }], parts, { zMax: 1.25, padX: 0.4 });
    }
    case D.DEADTREE:
      return model([{ ramp: R.bark }], [
        [(x, y, z) => Math.min(
          capsule(x, y, z, 0.5, 0.6, 0, 0.52, 0.56, 0.75, 0.07),
          capsule(x, y, z, 0.51, 0.57, 0.45, 0.25, 0.55, 0.85, 0.035),
          capsule(x, y, z, 0.52, 0.56, 0.6, 0.78, 0.52, 0.95, 0.03),
          capsule(x, y, z, 0.52, 0.56, 0.75, 0.56, 0.5, 1.1, 0.025),
        ), 0],
      ], { zMax: 1.15, padX: 0.2 });
    case D.ROCK: {
      const sc = 0.8 + hashN(v, 5, d) * 0.35;
      return model([{ ramp: opt.glow ? R.stalag : R.rock }], [
        [(x, y, z) => ellip(x, y, z, 0.5, 0.58, 0.08, 0.36 * sc, 0.3 * sc, 0.28 * sc) + (n3(x * 7, y * 7, z * 7, s) - 0.5) * 0.12, 0],
      ], { zMax: 0.4 * sc, padX: 0.1, grain: 0.3 });
    }
    case D.TUFT: {
      const blades: [number, number, number][] = [];
      for (let k = 0; k < 7; k++) blades.push([0.3 + hashN(v, k, 1) * 0.4, 0.45 + hashN(v, k, 2) * 0.35, 0.16 + hashN(v, k, 3) * 0.14]);
      return model([{ ramp: R.leaf, id: MAT.FOLIAGE, bias: 0.6 }], [
        [(x, y, z) => { let dd = 1e9; for (const [bx, by, h] of blades) dd = Math.min(dd, coneZ(x, y, z, bx, by, 0, h, 0.035)); return dd; }, 0],
      ], { zMax: 0.32, padX: 0.05, outline: 0.75 });
    }
    case D.FLOWER: {
      const ramps = [R.petal, R.berry, R.gold, R.cloth, R.violet];
      const ramp = ramps[v % ramps.length];
      const fl: [number, number][] = [];
      for (let k = 0; k < 5; k++) fl.push([0.2 + hashN(v, k, 4) * 0.6, 0.3 + hashN(v, k, 5) * 0.55]);
      return model([{ ramp: R.leaf, id: MAT.FOLIAGE }, { ramp, bias: 0.6 }], [
        [(x, y, z) => { let dd = 1e9; for (const [fx, fy] of fl) dd = Math.min(dd, cylZ(x, y, z, fx, fy, 0, 0.1, 0.018)); return dd; }, 0],
        [(x, y, z) => { let dd = 1e9; for (const [fx, fy] of fl) dd = Math.min(dd, sph(x, y, z, fx, fy, 0.13, 0.065)); return dd; }, 1],
      ], { zMax: 0.22, padX: 0.05, outline: 0.7 });
    }
    case D.CACTUS:
      return model([{ ramp: R.cactus }, { ramp: R.petal }], [
        [(x, y, z) => Math.min(
          capsule(x, y, z, 0.5, 0.56, 0, 0.5, 0.56, 0.78, 0.11),
          smin(capsule(x, y, z, 0.5, 0.56, 0.38, 0.26, 0.56, 0.4, 0.065), capsule(x, y, z, 0.26, 0.56, 0.4, 0.26, 0.56, 0.62, 0.065), 0.05),
          smin(capsule(x, y, z, 0.5, 0.56, 0.5, 0.74, 0.56, 0.52, 0.06), capsule(x, y, z, 0.74, 0.56, 0.52, 0.74, 0.56, 0.7, 0.06), 0.05),
        ), 0],
        [(x, y, z) => sph(x, y, z, 0.5, 0.56, 0.9, 0.05), 1],
      ], { zMax: 0.98, padX: 0.1 });
    case D.CRYSTAL: {
      const ramp = v % 2 ? R.magenta : R.cyan;
      const em: [number, number, number] = v % 2 ? [150, 40, 170] : [30, 130, 180];
      const sh: [number, number, number, number][] = [[0.5, 0.56, 0.78, 0.15], [0.31, 0.62, 0.48, 0.1], [0.68, 0.5, 0.55, 0.11], [0.56, 0.7, 0.3, 0.08]];
      return model([{ ramp, id: MAT.GLOSS, emit: em, bias: 0.4 }], [
        [(x, y, z) => { let dd = 1e9; for (const [cx, cy, h, r] of sh) dd = Math.min(dd, coneZ(x, y, z, cx, cy, 0, h, r)); return dd; }, 0],
      ], { zMax: 0.8, padX: 0.1, grain: 0.2 });
    }
    case D.MUSHROOM: {
      const caps: [number, number, number][] = [[0.42, 0.55, 1], [0.66, 0.66, 0.65], [0.3, 0.72, 0.5]].slice(0, 1 + (v % 3)) as [number, number, number][];
      return model([{ ramp: R.stem }, opt.glow ? { ramp: R.capGlow, emit: [20, 110, 200], id: MAT.GLOSS } : { ramp: R.capRed }], [
        [(x, y, z) => { let dd = 1e9; for (const [cx, cy, k] of caps) dd = Math.min(dd, cylZ(x, y, z, cx, cy, 0, 0.22 * k, 0.045 * k)); return dd; }, 0],
        [(x, y, z) => { let dd = 1e9; for (const [cx, cy, k] of caps) dd = Math.min(dd, Math.max(ellip(x, y, z, cx, cy, 0.2 * k, 0.17 * k, 0.17 * k, 0.12 * k), 0.2 * k - z)); return dd; }, 1],
      ], { zMax: 0.36, padX: 0.1 });
    }
    case D.PILLAR:
      return model([{ ramp: R.stone }], [
        [(x, y, z) => Math.min(
          cylZ(x, y, z, 0.5, 0.56, 0, 1.25, 0.19) + Math.max(0, Math.cos(Math.atan2(y - 0.56, x - 0.5) * 8)) * 0.015,
          box(x, y, z, 0.5, 0.56, 0.06, 0.28, 0.28, 0.06, 0.01),
          box(x, y, z, 0.5, 0.56, 1.3, 0.28, 0.28, 0.07, 0.01),
        ), 0],
      ], { zMax: 1.4, padX: 0.1, grain: 0.3 });
    case D.REED: {
      const rs: [number, number, number][] = [];
      for (let k = 0; k < 6; k++) rs.push([0.2 + hashN(v, k, 6) * 0.6, 0.4 + hashN(v, k, 7) * 0.45, 0.3 + hashN(v, k, 8) * 0.35]);
      return model([{ ramp: R.reed, id: MAT.FOLIAGE }, { ramp: R.cattail }], [
        [(x, y, z) => { let dd = 1e9; for (const [rx, ry, h] of rs) dd = Math.min(dd, cylZ(x, y, z, rx, ry, 0, h, 0.018)); return dd; }, 0],
        [(x, y, z) => { let dd = 1e9; for (const [rx, ry, h] of rs) if (h > 0.45) dd = Math.min(dd, capsule(x, y, z, rx, ry, h - 0.12, rx, ry, h - 0.02, 0.035)); return dd; }, 1],
      ], { zMax: 0.7, padX: 0.05, outline: 0.7 });
    }
    case D.STALAG:
      return model([{ ramp: R.stalag }], [
        [(x, y, z) => Math.min(
          coneZ(x, y, z, 0.5, 0.58, 0, 0.95 + j(3) * 0.2, 0.22),
          coneZ(x, y, z, 0.3 + j(4) * 0.1, 0.7, 0, 0.45, 0.12),
        ) + (n3(x * 10, y * 10, z * 10, s) - 0.5) * 0.03, 0],
      ], { zMax: 1.1, padX: 0.1 });
  }
  return null;
}

/**
 * Modular building pieces: one per footprint tile, chosen by which of its 4 neighbours are also part
 * of the building (mask bits N=1 E=2 S=4 W=8). Walls stand on exposed sides; the roof is a hip roof
 * whose height grows with the distance from the nearest exposed edge, so rectangles, L and T shapes
 * all get continuous roofs with ridges, hips and valleys. The roof is MAT.TINT (style colour per
 * instance); `wall` picks plaster+timber or stone.
 */
export const WALL_KINDS = ['plaster', 'stone'] as const;
export function housePiece(mask: number, floors: number, wall: 'plaster' | 'stone'): Model {
  // Every dimension is a whole number of source pixels (1/16 tile) so edges land on pixel boundaries;
  // roof pitch 1:1 in ground units gives clean 1:2 / 2:1 steps in this projection.
  const px = 1 / 16;
  const exN = !(mask & 1), exE = !(mask & 2), exS = !(mask & 4), exW = !(mask & 8);
  const inset = px, over = px;
  const wallH = (floors >= 2 ? 16 : 10) * px;
  const maxRise = 7 * px;
  const x0 = exW ? inset : -px, x1 = exE ? 1 - inset : 1 + px, y0 = exN ? inset : -px, y1 = exS ? 1 - inset : 1 + px;
  const rx0 = exW ? 0 : -px, rx1 = exE ? 1 : 1 + px, ry0 = exN ? 0 : -px, ry1 = exS ? 1 : 1 + px;
  void over;
  const dEdge = (x: number, y: number) => Math.min(exW ? x - rx0 : 9, exE ? rx1 - x : 9, exN ? y - ry0 : 9, exS ? ry1 - y : 9);
  const roofH = (x: number, y: number) => wallH + Math.min(maxRise, dEdge(x, y));
  const rectD = (x: number, y: number, ax: number, bx: number, ay: number, by: number) => Math.max(ax - x, x - bx, ay - y, y - by);
  /** box given by pixel edges (ground x0..x1, y0..y1, height z0..z1, all in px) */
  const pbox = (x: number, y: number, z: number, ax: number, bx: number, ay: number, by: number, az: number, bz: number) =>
    Math.max(ax * px - x, x - bx * px, ay * px - y, y - by * px, az * px - z, z - bz * px);
  const wallM: Mat = wall === 'stone' ? { ramp: ['#3c3844', '#57525f', '#76707e', '#958e9c'], bias: 0.3 } : { ramp: ['#6a5a44', '#9a8466', '#c8b08a', '#e2cfa6'], bias: 0.3 };
  const parts: Part[] = [
    [(x, y, z) => Math.max(rectD(x, y, x0, x1, y0, y1), z - wallH, -z), 0],
    // hip roof as a height field; 0.7 keeps the SDF conservative on the 1:1 slopes
    [(x, y, z) => Math.max(rectD(x, y, rx0, rx1, ry0, ry1), (z - roofH(x, y)) * 0.7, wallH - px - z), 1],
  ];
  const W = Math.round(wallH * 16);
  if (wall === 'plaster' && exS) {
    // timber frame: eave beam and corner posts, each exactly 1 px
    parts.push([(x, y, z) => {
      let d = pbox(x, y, z, exW ? 1 : -1, exE ? 15 : 17, 14.5, 16, W - 2, W - 1);
      if (exW) d = Math.min(d, pbox(x, y, z, 1, 2, 14.5, 16, 0, W));
      if (exE) d = Math.min(d, pbox(x, y, z, 14, 15, 14.5, 16, 0, W));
      return d;
    }, 2]);
  }
  if (exS) {
    // windows on the south face (lit at night through the instance emissive scale)
    parts.push([(x, y, z) => {
      const zb = floors >= 2 ? 9 : 3;
      let d = Math.min(pbox(x, y, z, 3, 6, 14.5, 15.6, zb, zb + 3), pbox(x, y, z, 10, 13, 14.5, 15.6, zb, zb + 3));
      if (floors >= 2) d = Math.min(d, pbox(x, y, z, 3, 6, 14.5, 15.6, 3, 6), pbox(x, y, z, 10, 13, 14.5, 15.6, 3, 6));
      return d;
    }, 3]);
  }
  return model([
    wallM,
    { ramp: ['#5a5a5a', '#828282', '#ababab', '#d2d2d2'], id: MAT.TINT, bias: 0.2 },
    { ramp: ['#24160a', '#3a2412'] },
    { ramp: ['#ffb040', '#ffd27a'], emit: [255, 165, 60] },
  ], parts, { zMax: wallH + maxRise + px, padX: 1 / 16, outline: 0, grain: 0.25 });
}

/** roof colour per structure style (unknown styles hash into ROOF_COLORS) */
export const ROOF_COLORS: Record<string, [number, number, number]> = {
  'timber-red': [0.86, 0.32, 0.24], 'timber-blue': [0.34, 0.5, 0.86], 'stone-moss': [0.42, 0.62, 0.36], marble: [0.88, 0.86, 0.8], thatch: [0.86, 0.7, 0.36],
};
export const ROOF_FALLBACK: [number, number, number][] = [[0.86, 0.32, 0.24], [0.34, 0.5, 0.86], [0.6, 0.36, 0.7], [0.86, 0.7, 0.36], [0.42, 0.62, 0.36]];

// ---------------------------------------------------------------- objects

function figure(body: Mat, extra: Part[] = [], hat?: Part): Model {
  return model([body, { ramp: R.skin }, { ramp: R.dark }, { ramp: R.helmet, id: MAT.GLOSS }, { ramp: R.woodLight }, { ramp: R.hero }, { ramp: R.mint, emit: [40, 200, 140] }], [
    [(x, y, z) => smin(capsule(x, y, z, 0.5, 0.56, 0.08, 0.5, 0.56, 0.34, 0.15), ellip(x, y, z, 0.5, 0.56, 0.05, 0.2, 0.16, 0.08), 0.06), 0],
    [(x, y, z) => sph(x, y, z, 0.5, 0.56, 0.58, 0.15), 1],
    [(x, y, z) => Math.min(sph(x, y, z, 0.45, 0.69, 0.6, 0.025), sph(x, y, z, 0.55, 0.69, 0.6, 0.025)), 2],
    ...(hat ? [hat] : []),
    ...extra,
  ], { zMax: 1.0, padX: 0.15 });
}

export interface ObjSpec { key: string; model: Model }

export function objectModels(): ObjSpec[] {
  const L: ObjSpec[] = [];
  const add = (key: string, m: Model) => L.push({ key, model: m });
  const wood = { ramp: R.wood }, woodL = { ramp: R.woodLight }, gold = { ramp: R.gold, id: MAT.GLOSS }, dark = { ramp: R.dark };
  const chestWood = { ramp: ['#5a2e12', '#844a1c', '#ac6a2a', '#cc8a3c'], bias: 0.3 }, chestLid = { ramp: ['#6e3a16', '#9a5622', '#c27632', '#e09a4a'], bias: 0.6 };
  const chestGold = { ramp: R.gold, id: MAT.GLOSS, emit: [90, 60, 8] as [number, number, number], bias: 0.5 };
  // chests
  const chestBody: F = (x, y, z) => box(x, y, z, 0.5, 0.56, 0.15, 0.3, 0.2, 0.15, 0.025);
  add('o:chest', model([chestWood, chestLid, chestGold], [
    [chestBody, 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.56, 0.35, 0.31, 0.21, 0.07, 0.06), 1],
    [(x, y, z) => Math.min(box(x, y, z, 0.5, 0.56, 0.28, 0.315, 0.215, 0.02), box(x, y, z, 0.5, 0.77, 0.24, 0.05, 0.02, 0.06)), 2],
  ], { zMax: 0.5, padX: 0.1 }));
  add('o:chest:done', model([chestWood, chestLid, { ramp: R.gold, id: MAT.GLOSS }, dark], [
    [(x, y, z) => Math.max(chestBody(x, y, z), -box(x, y, z, 0.5, 0.56, 0.3, 0.26, 0.16, 0.1)), 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.33, 0.45, 0.31, 0.04, 0.17, 0.03), 1],
    [(x, y, z) => box(x, y, z, 0.5, 0.56, 0.22, 0.26, 0.16, 0.01), 3],
    [(x, y, z) => box(x, y, z, 0.5, 0.56, 0.29, 0.315, 0.215, 0.012), 2],
  ], { zMax: 0.65, padX: 0.1 }));
  // gates
  const bushF: F = (x, y, z) => smin(smin(sph(x, y, z, 0.5, 0.56, 0.3, 0.33), sph(x, y, z, 0.3, 0.6, 0.22, 0.22), 0.1), sph(x, y, z, 0.7, 0.6, 0.22, 0.22), 0.1) + (n3(x * 10, y * 10, z * 10, 5) - 0.5) * 0.08;
  add('o:gate:bush', model([{ ramp: R.leaf, id: MAT.FOLIAGE, bias: 0.7 }, { ramp: R.berry, bias: 1 }], [
    [bushF, 0],
    [(x, y, z) => Math.min(sph(x, y, z, 0.36, 0.78, 0.3, 0.045), sph(x, y, z, 0.64, 0.74, 0.42, 0.045), sph(x, y, z, 0.52, 0.66, 0.6, 0.04)), 1],
  ], { zMax: 0.7, padX: 0.1 }));
  add('o:gate:bush:done', model([{ ramp: R.trunk }, { ramp: R.leaf, id: MAT.FOLIAGE }], [
    [(x, y, z) => cylZ(x, y, z, 0.5, 0.58, 0, 0.08, 0.1), 0],
    [(x, y, z) => Math.min(sph(x, y, z, 0.3, 0.7, 0.02, 0.05), sph(x, y, z, 0.68, 0.45, 0.02, 0.05), sph(x, y, z, 0.62, 0.78, 0.02, 0.04)), 1],
  ], { zMax: 0.15, padX: 0.05 }));
  const boulderF: F = (x, y, z) => sph(x, y, z, 0.5, 0.56, 0.32, 0.4) + (n3(x * 6, y * 6, z * 6, 9) - 0.5) * 0.14;
  add('o:gate:boulder', model([{ ramp: R.rockWarm }], [[boulderF, 0]], { zMax: 0.8, padX: 0.15, grain: 0.3 }));
  add('o:gate:boulder:done', model([{ ramp: R.rockWarm }], [
    [(x, y, z) => Math.min(sph(x, y, z, 0.3, 0.65, 0.03, 0.08), sph(x, y, z, 0.65, 0.5, 0.03, 0.07), sph(x, y, z, 0.6, 0.78, 0.02, 0.06)), 0],
  ], { zMax: 0.15, padX: 0.05 }));
  // cracked: a rubble plate with a dark crack (drawn on the wall face when attached)
  add('o:gate:cracked', model([{ ramp: R.rock }, dark], [
    [(x, y, z) => box(x, y, z, 0.5, 0.55, 0.0, 0.38, 0.38, 0.02, 0.01), 0],
    [(x, y, z) => Math.min(
      capsule(x, y, z, 0.45, 0.2, 0.025, 0.55, 0.45, 0.025, 0.025), capsule(x, y, z, 0.55, 0.45, 0.025, 0.4, 0.65, 0.025, 0.025),
      capsule(x, y, z, 0.4, 0.65, 0.025, 0.52, 0.88, 0.025, 0.022), capsule(x, y, z, 0.55, 0.45, 0.025, 0.8, 0.5, 0.025, 0.02),
      capsule(x, y, z, 0.4, 0.65, 0.025, 0.2, 0.7, 0.025, 0.02)), 1],
  ], { zMax: 0.06, padX: 0 }));
  add('o:gate:cracked:done', model([dark, { ramp: R.rock }], [
    [(x, y, z) => ellip(x, y, z, 0.5, 0.55, 0.0, 0.32, 0.3, 0.02), 0],
    [(x, y, z) => Math.min(sph(x, y, z, 0.2, 0.85, 0.02, 0.06), sph(x, y, z, 0.8, 0.82, 0.02, 0.05)), 1],
  ], { zMax: 0.08, padX: 0.05 }));
  add('o:gate:water', model([{ ramp: R.cyan, emit: [30, 110, 150] }], [
    [(x, y, z) => Math.min(torusZ(x, y, z, 0.5, 0.55, 0.0, 0.32, 0.025), torusZ(x, y, z, 0.5, 0.55, 0.0, 0.16, 0.02)), 0],
  ], { zMax: 0.05, padX: 0, outline: 0 }));
  add('o:gate:chasm', model([dark, { ramp: R.rock }], [
    [(x, y, z) => box(x, y, z, 0.5, 0.5, -0.02, 0.48, 0.46, 0.02), 0],
    [(x, y, z) => Math.min(sph(x, y, z, 0.1, 0.1, 0.0, 0.07), sph(x, y, z, 0.9, 0.15, 0.0, 0.06), sph(x, y, z, 0.85, 0.9, 0.0, 0.07), sph(x, y, z, 0.12, 0.88, 0.0, 0.05)), 1],
  ], { zMax: 0.08, padX: 0 }));
  add('o:gate:chasm:done', model([dark, woodL, wood], [
    [(x, y, z) => box(x, y, z, 0.5, 0.5, -0.02, 0.48, 0.46, 0.02), 0],
    [(x, y, z) => { let dd = 1e9; for (let k = 0; k < 4; k++) dd = Math.min(dd, box(x, y, z, 0.5, 0.12 + k * 0.25, 0.03, 0.2, 0.09, 0.02, 0.01)); return dd; }, 1],
    [(x, y, z) => Math.min(box(x, y, z, 0.27, 0.5, 0.04, 0.025, 0.5, 0.025), box(x, y, z, 0.73, 0.5, 0.04, 0.025, 0.5, 0.025)), 2],
  ], { zMax: 0.1, padX: 0 }));
  const hole2 = (w: number, h: number) => (x: number, z: number) => {
    const r = w * 0.3;
    return Math.min(Math.max(Math.abs(x - 0.5) - r, Math.abs(z - (h - r) / 2) - (h - r) / 2), Math.hypot(x - 0.5, z - (h - r)) - r);
  };
  const archF = (w: number, h: number, t: number): F => {
    const hole = hole2(w, h);
    return (x, y, z) => Math.max(box(x, y, z, 0.5, 0.86, h / 2, w / 2, t, h / 2, 0.02), -Math.max(hole(x, z), Math.abs(y - 0.86) - t - 0.05));
  };
  const arch = (frame: Mat, inside: Mat, w = 0.86, h = 0.95) => {
    const hole = hole2(w, h);
    return model([frame, inside], [
      [archF(w, h, 0.1), 0],
      [(x, y, z) => Math.max(hole(x, z), Math.abs(y - 0.9) - 0.03), 1],
    ], { zMax: h + 0.05, padX: 0.1 });
  };
  add('o:gate:dark', arch({ ramp: R.stalag }, dark));
  add('o:gate:dark:done', arch({ ramp: R.stalag }, { ramp: R.ember, emit: [120, 70, 20] }));
  const eyeBlock: F = (x, y, z) => box(x, y, z, 0.5, 0.56, 0.3, 0.3, 0.3, 0.3, 0.05);
  add('o:gate:eye', model([{ ramp: R.stone }, { ramp: R.bone, bias: 1 }, { ramp: R.ember, emit: [255, 120, 20] }], [
    [eyeBlock, 0],
    [(x, y, z) => ellip(x, y, z, 0.5, 0.86, 0.34, 0.17, 0.04, 0.1), 1],
    [(x, y, z) => sph(x, y, z, 0.5, 0.89, 0.34, 0.06), 2],
  ], { zMax: 0.65, padX: 0.1 }));
  add('o:gate:eye:done', model([{ ramp: R.stone }, { ramp: R.mint, emit: [20, 160, 90] }], [
    [eyeBlock, 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.86, 0.32, 0.15, 0.03, 0.02), 1],
  ], { zMax: 0.65, padX: 0.1 }));
  const door = (slab: Mat, w: number, h: number, extra: Part[]) => model([{ ramp: R.stone }, slab, gold, { ramp: R.bone }, dark], [
    [archF(w + 0.12, h + 0.06, 0.08), 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.86, h * 0.45, w * 0.32, 0.05, h * 0.45, 0.01), 1],
    ...extra,
  ], { zMax: h + 0.1, padX: 0.1 });
  add('o:gate:locked', door(wood, 0.78, 0.86, [
    [(x, y, z) => Math.min(box(x, y, z, 0.5, 0.9, 0.42, 0.07, 0.02, 0.09, 0.02), box(x, y, z, 0.5, 0.9, 0.62, 0.26, 0.015, 0.025), box(x, y, z, 0.5, 0.9, 0.2, 0.26, 0.015, 0.025)), 2],
  ]));
  add('o:gate:locked:done', arch({ ramp: R.stone }, dark, 0.9, 0.92));
  add('o:gate:bossdoor', door({ ramp: R.red }, 0.92, 1.0, [
    [(x, y, z) => sph(x, y, z, 0.5, 0.9, 0.58, 0.11), 3],
    [(x, y, z) => Math.min(box(x, y, z, 0.5, 0.9, 0.3, 0.32, 0.015, 0.03), box(x, y, z, 0.5, 0.9, 0.8, 0.28, 0.015, 0.03)), 2],
  ]));
  add('o:gate:bossdoor:done', arch({ ramp: R.red }, dark, 0.98, 1.0));
  const ringV = (r: number, t: number, cz: number): F => (x, y, z) => Math.hypot(Math.hypot(x - 0.5, z - cz) - r, y - 0.6) - t;
  add('o:gate:seal', model([{ ramp: R.magenta, emit: [255, 70, 230] }, { ramp: R.stone }], [
    [(x, y, z) => Math.min(ringV(0.34, 0.035, 0.45)(x, y, z), box(x, y, z, 0.5, 0.6, 0.45, 0.25, 0.01, 0.025), box(x, y, z, 0.5, 0.6, 0.45, 0.025, 0.01, 0.25)), 0],
    [(x, y, z) => Math.min(box(x, y, z, 0.12, 0.6, 0.06, 0.08, 0.08, 0.06), box(x, y, z, 0.88, 0.6, 0.06, 0.08, 0.08, 0.06)), 1],
  ], { zMax: 0.85, padX: 0.1, outline: 0.8 }));
  add('o:gate:seal:done', model([{ ramp: R.stone }], [
    [(x, y, z) => Math.min(box(x, y, z, 0.12, 0.6, 0.06, 0.08, 0.08, 0.06), box(x, y, z, 0.88, 0.6, 0.06, 0.08, 0.08, 0.06)), 0],
  ], { zMax: 0.15, padX: 0.1 }));
  add('o:gate:portal', model([{ ramp: R.violet, emit: [180, 80, 255] }, { ramp: R.dark, emit: [40, 10, 70] }, { ramp: R.stone }], [
    [ringV(0.36, 0.06, 0.5), 0],
    [(x, y, z) => Math.hypot(x - 0.5, z - 0.5) < 0.31 ? Math.abs(y - 0.6) - 0.01 : 1e9, 1],
    [(x, y, z) => box(x, y, z, 0.5, 0.6, 0.04, 0.4, 0.12, 0.04, 0.01), 2],
  ], { zMax: 0.95, padX: 0.1 }));
  add('o:gate:portal:done', model([{ ramp: R.stone }, { ramp: R.violet }], [
    [(x, y, z) => box(x, y, z, 0.5, 0.6, 0.04, 0.4, 0.12, 0.04, 0.01), 0],
    [ringV(0.36, 0.05, 0.5), 1],
  ], { zMax: 0.95, padX: 0.1 }));
  const spear: Part = [(x, y, z) => Math.min(cylZ(x, y, z, 0.78, 0.6, 0, 0.95, 0.02), coneZ(x, y, z, 0.78, 0.6, 0.95, 0.15, 0.05)), 3];
  add('o:guard', figure({ ramp: R.cloth, id: MAT.TINT }, [spear], [(x, y, z) => Math.max(sph(x, y, z, 0.5, 0.56, 0.62, 0.17), 0.6 - z), 3]));
  add('o:gate:moon', door({ ramp: ['#1a2040', '#2a3260', '#3c4888', '#5a68b0'] }, 0.82, 0.92, [
    [(x, y, z) => Math.max(sph(x, y, z, 0.5, 0.9, 0.55, 0.13), -sph(x, y, z, 0.56, 0.86, 0.6, 0.11)), 2],
  ]));
  add('o:gate:moon:done', arch({ ramp: R.stone }, { ramp: ['#202a50', '#3a4a80'], emit: [40, 60, 120] }, 0.9, 0.92));
  add('o:gate:foes', door(wood, 0.82, 0.92, [
    [(x, y, z) => { let d = 1e9; for (let k = 0; k < 5; k++) d = Math.min(d, box(x, y, z, 0.22 + k * 0.14, 0.92, 0.42, 0.018, 0.02, 0.42)); return d; }, 2],
    [(x, y, z) => sph(x, y, z, 0.5, 0.95, 0.68, 0.1), 3],
  ]));
  add('o:gate:foes:done', arch({ ramp: R.stone }, dark, 0.9, 0.92));
  // ledge chevrons (flat, glowing) per direction
  for (const dir of ['n', 'e', 's', 'w'] as const) {
    const rot = (x: number, y: number): [number, number] => {
      const u = x - 0.5, v = y - 0.5;
      return dir === 's' ? [u, v] : dir === 'n' ? [-u, -v] : dir === 'e' ? [v, -u] : [-v, u];
    };
    add('o:ledge:' + dir, model([{ ramp: R.gold, emit: [200, 150, 30] }], [
      [(x, y, z) => {
        const [u, v] = rot(x, y);
        let dd = 1e9;
        for (const off of [-0.16, 0.12]) {
          const a = Math.abs(u) * 0.8 + (off - v);
          dd = Math.min(dd, Math.max(Math.abs(a) - 0.05, Math.abs(u) - 0.25, Math.abs(z) - 0.02));
        }
        return dd;
      }, 0],
    ], { zMax: 0.04, padX: 0, outline: 0 }));
  }
  // entrances
  add('o:ent:house', door(wood, 0.5, 0.62, [[(x, y, z) => sph(x, y, z, 0.6, 0.92, 0.3, 0.03), 2]]));
  add('o:ent:shop', model([{ ramp: R.stone }, { ramp: R.capGlow }, { ramp: R.cloth }, { ramp: R.capRed }, gold], [
    [archF(0.62, 0.7, 0.08), 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.86, 0.28, 0.2, 0.05, 0.28, 0.01), 1],
    [(x, y, z) => (Math.floor((x + 0.1) * 6) % 2 ? box(x, y, z, 0.5, 0.95, 0.78, 0.48, 0.12, 0.03) : 1e9), 2],
    [(x, y, z) => (Math.floor((x + 0.1) * 6) % 2 ? 1e9 : box(x, y, z, 0.5, 0.95, 0.78, 0.48, 0.12, 0.03)), 3],
    [(x, y, z) => sph(x, y, z, 0.62, 0.92, 0.3, 0.03), 4],
  ], { zMax: 0.85, padX: 0.1 }));
  add('o:ent:cave', model([{ ramp: R.rockWarm }, dark], [
    [(x, y, z) => {
      let dd = 1e9;
      for (let k = 0; k < 7; k++) {
        const a = Math.PI * (k / 6);
        dd = smin(dd, sph(x, y, z, 0.5 - Math.cos(a) * 0.4, 0.82, Math.sin(a) * 0.55 + 0.05, 0.15 + hashN(k, 1, 2) * 0.05), 0.08);
      }
      return dd + (n3(x * 9, y * 9, z * 9, 3) - 0.5) * 0.06;
    }, 0],
    [(x, y, z) => Math.max(ellip(x, y, z, 0.5, 0.9, 0.0, 0.3, 0.03, 0.55), -z), 1],
  ], { zMax: 0.85, padX: 0.15 }));
  add('o:ent:dungeon', arch({ ramp: R.stone }, dark, 0.96, 1.05));
  add('o:ent:shrine', model([{ ramp: R.wall }, dark, gold], [
    [archF(0.9, 0.9, 0.1), 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.9, 0.3, 0.22, 0.04, 0.3), 1],
    [(x, y, z) => roofX(x, y, z, 0.0, 1.0, 0.8, 0.2, 0.9, 0.3), 2],
  ], { zMax: 1.25, padX: 0.1 }));
  add('o:ent:sanctum', arch({ ramp: R.helmet }, { ramp: R.capGlow, emit: [60, 140, 255] }, 0.92, 1.0));
  const stairs = (up: boolean) => model([{ ramp: R.stone }, dark], [
    [(x, y, z) => {
      let dd = box(x, y, z, 0.5, 0.5, -0.02, 0.44, 0.44, 0.02);
      for (let k = 0; k < 4; k++) {
        const zz = up ? 0.06 + (3 - k) * 0.07 : -0.08 - k * 0.08;
        dd = up ? Math.min(dd, box(x, y, z, 0.5, 0.2 + k * 0.2, zz / 2, 0.36, 0.1, Math.abs(zz) / 2)) : Math.max(dd, -box(x, y, z, 0.5, 0.2 + k * 0.2, 0, 0.36, 0.1, -zz));
      }
      return dd;
    }, 0],
    [(x, y, z) => (up ? 1e9 : box(x, y, z, 0.5, 0.5, -0.45, 0.36, 0.42, 0.02)), 1],
  ], { zMax: up ? 0.3 : 0.05, zMin: up ? 0 : -0.45, padX: 0.05 });
  add('o:ent:stairs-down', stairs(false));
  add('o:ent:stairs-up', stairs(true));
  add('o:ent:beanstalk', model([{ ramp: R.leaf, id: MAT.FOLIAGE, bias: 0.4 }], [
    [(x, y, z) => {
      let dd = 1e9;
      for (let k = 0; k < 10; k++) {
        const t0 = k / 10, t1 = (k + 1) / 10;
        const p = (t: number): [number, number, number] => [0.5 + Math.cos(t * 9) * 0.18, 0.6 + Math.sin(t * 9) * 0.12, t * 2.0];
        const [ax, ay, az] = p(t0), [bx, by, bz] = p(t1);
        dd = Math.min(dd, capsule(x, y, z, ax, ay, az, bx, by, bz, 0.09 - t0 * 0.04));
      }
      for (let k = 1; k < 6; k++) {
        const t = k / 6;
        dd = Math.min(dd, ellip(x, y, z, 0.5 + Math.cos(t * 9 + 1) * 0.32, 0.6 + Math.sin(t * 9 + 1) * 0.2, t * 2 + 0.05, 0.14, 0.1, 0.04));
      }
      return dd;
    }, 0],
  ], { zMax: 2.1, padX: 0.3 }));
  add('o:ent:exit', model([{ ramp: R.mint, emit: [30, 140, 90] }, { ramp: R.stone }], [
    [(x, y, z) => box(x, y, z, 0.5, 0.55, 0.015, 0.34, 0.3, 0.015, 0.02), 1],
    [(x, y, z) => Math.max(box(x, y, z, 0.5, 0.55, 0.03, 0.26, 0.22, 0.01), -box(x, y, z, 0.5, 0.55, 0.03, 0.2, 0.16, 0.05)), 0],
  ], { zMax: 0.06, padX: 0.05 }));
  // npcs
  add('o:npc', figure({ ramp: R.cloth, id: MAT.TINT }, [], [(x, y, z) => Math.max(sph(x, y, z, 0.5, 0.54, 0.64, 0.16), 0.62 - z + (y - 0.54) * 0.6), 4]));
  add('o:start', figure({ ramp: R.hero }, [
    [(x, y, z) => torusZ(x, y, z, 0.5, 0.56, 0.01, 0.42, 0.025), 6],
  ], [(x, y, z) => coneZ(x, y, z, 0.53, 0.5, 0.66, 0.38, 0.15), 5]));
  // sources
  add('o:src:pot', model([{ ramp: R.clay }, dark], [
    [(x, y, z) => Math.max(smin(ellip(x, y, z, 0.5, 0.56, 0.2, 0.22, 0.22, 0.2), cylZ(x, y, z, 0.5, 0.56, 0.3, 0.46, 0.1), 0.05), -cylZ(x, y, z, 0.5, 0.56, 0.35, 0.6, 0.07)), 0],
    [(x, y, z) => cylZ(x, y, z, 0.5, 0.56, 0.3, 0.4, 0.07), 1],
  ], { zMax: 0.5, padX: 0.1 }));
  add('o:src:grass', model([{ ramp: R.leaf, id: MAT.FOLIAGE, bias: 1 }], [
    [(x, y, z) => { let dd = 1e9; for (let k = 0; k < 9; k++) dd = Math.min(dd, coneZ(x, y, z, 0.25 + (k % 3) * 0.25 + hashN(k, 1, 9) * 0.08, 0.4 + Math.floor(k / 3) * 0.2, 0, 0.3 + hashN(k, 2, 9) * 0.15, 0.05)); return dd; }, 0],
  ], { zMax: 0.5, padX: 0.05 }));
  add('o:src:flower', model([{ ramp: R.leaf, id: MAT.FOLIAGE }, { ramp: R.petal, emit: [90, 20, 60] }, { ramp: R.gold }], [
    [(x, y, z) => cylZ(x, y, z, 0.5, 0.58, 0, 0.32, 0.025), 0],
    [(x, y, z) => { let dd = 1e9; for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; dd = Math.min(dd, sph(x, y, z, 0.5 + Math.cos(a) * 0.1, 0.58 + Math.sin(a) * 0.1, 0.36, 0.075)); } return dd; }, 1],
    [(x, y, z) => sph(x, y, z, 0.5, 0.58, 0.39, 0.05), 2],
  ], { zMax: 0.48, padX: 0.05 }));
  // boss
  add('o:boss', model([{ ramp: R.bone }, dark, { ramp: R.red, emit: [255, 30, 40] }, { ramp: R.stalag }], [
    [(x, y, z) => Math.max(smin(sph(x, y, z, 0.5, 0.56, 0.5, 0.32), box(x, y, z, 0.5, 0.68, 0.2, 0.18, 0.12, 0.12, 0.04), 0.08), -Math.min(sph(x, y, z, 0.38, 0.86, 0.5, 0.09), sph(x, y, z, 0.62, 0.86, 0.5, 0.09))), 0],
    [(x, y, z) => box(x, y, z, 0.5, 0.8, 0.17, 0.12, 0.01, 0.04), 1],
    [(x, y, z) => Math.min(sph(x, y, z, 0.38, 0.8, 0.5, 0.045), sph(x, y, z, 0.62, 0.8, 0.5, 0.045)), 2],
    [(x, y, z) => Math.min(capsule(x, y, z, 0.25, 0.55, 0.65, 0.08, 0.5, 1.0, 0.05), capsule(x, y, z, 0.75, 0.55, 0.65, 0.92, 0.5, 1.0, 0.05)), 3],
  ], { zMax: 1.08, padX: 0.15 }));
  // waterfalls: foam at the base / lip, side cascades for east-west drops, optional ladder (vine) beside
  const foamM: Mat = { ramp: ['#8fb4c8', '#bcd8e6', '#e2f2fa'], emit: [10, 16, 20], bias: 0.3 };
  const sheet: Mat = { ramp: ['#2c7fae', '#5ab0d8', '#bfe8fa'], id: MAT.FALL, bias: 0.4 };
  const vine: Mat = { ramp: ['#1d4a1c', '#2f6e2a', '#4a9a3a'] };
  const foamRow = (y0: number): F => (x, y, z) => { let dd = 1e9; for (let k = 0; k < 6; k++) dd = Math.min(dd, sph(x, y, z, 0.08 + k * 0.17, y0 + (k % 2) * 0.06, 0.03, 0.09 + (k % 3) * 0.015)); return dd; };
  const ladder = (lx: number, ly: number, along: 'x' | 'y'): F => (x, y, z) => {
    const u = along === 'x' ? x - lx : y - ly, v = along === 'x' ? y - ly : x - lx;
    let dd = Math.min(Math.hypot(u - 0.09, v) - 0.025, Math.hypot(u + 0.09, v) - 0.025);
    dd = Math.max(dd, z - 0.62, -z);
    for (let k = 0; k < 4; k++) dd = Math.min(dd, Math.max(Math.abs(u) - 0.1, Math.abs(v) - 0.02, Math.abs(z - (0.08 + k * 0.14)) - 0.018));
    return dd;
  };
  for (const ld of [false, true]) {
    const sfx = ld ? ':ladder' : '';
    add('o:wf:s' + sfx, model([foamM, vine], [[foamRow(0.06), 0], ...(ld ? [[ladder(0.86, 0.03, 'x'), 1] as Part] : [])], { zMax: 0.65, padX: 0.1, outline: 0.85 }));
    add('o:wf:n' + sfx, model([foamM, vine], [[foamRow(0.9), 0], ...(ld ? [[ladder(0.86, 0.97, 'x'), 1] as Part] : [])], { zMax: 0.65, padX: 0.1, outline: 0.85 }));
    for (const dir of ['e', 'w'] as const) {
      const ex = dir === 'e' ? 0.04 : 0.96;
      add('o:wf:' + dir + sfx, model([sheet, foamM, vine], [
        [(x, y, z) => box(x, y, z, ex, 0.5, 0.24, 0.05, 0.42, 0.24, 0.02), 0],
        [(x, y, z) => { let dd = 1e9; for (let k = 0; k < 5; k++) dd = Math.min(dd, sph(x, y, z, ex + (dir === 'e' ? 0.14 : -0.14), 0.12 + k * 0.19, 0.03, 0.1)); return dd; }, 1],
        ...(ld ? [[ladder(ex, 0.9, 'y'), 2] as Part] : []),
      ], { zMax: 0.65, padX: 0.15, outline: 0.85 }));
    }
  }
  // bridge rails: along the long sides of a plank tile (ns = bridge runs north-south)
  const railM: Mat = { ramp: ['#2a170a', '#4a2c14', '#6e4420', '#8e5c2c'] };
  const rails = (ns: boolean): F => (x, y, z) => {
    let dd = 1e9;
    for (const side of [0.06, 0.94]) {
      const px = ns ? side : 0.5, py = ns ? 0.5 : side;
      dd = Math.min(dd, ns ? capsule(x, y, z, px, 0.0, 0.26, px, 1.0, 0.26, 0.03) : capsule(x, y, z, 0.0, py, 0.26, 1.0, py, 0.26, 0.03));
      for (const t of [0.15, 0.85]) dd = Math.min(dd, ns ? cylZ(x, y, z, px, t, 0, 0.28, 0.035) : cylZ(x, y, z, t, py, 0, 0.28, 0.035));
    }
    return dd;
  };
  add('rail:ns', model([railM], [[rails(true), 0]], { zMax: 0.32, padX: 0.05, outline: 0.7 }));
  add('rail:ew', model([railM], [[rails(false), 0]], { zMax: 0.32, padX: 0.05, outline: 0.7 }));
  // interior wall torch
  add('torch', model([{ ramp: R.wood }, { ramp: R.ember, emit: [255, 150, 40] }], [
    [(x, y, z) => capsule(x, y, z, 0.5, 0.92, 0.25, 0.5, 0.98, 0.45, 0.04), 0],
    [(x, y, z) => ellip(x, y, z, 0.5, 0.97, 0.56, 0.06, 0.05, 0.1), 1],
  ], { zMax: 0.7, padX: 0, outline: 0.8 }));
  return L;
}

export const DECO_VARIANTS: Record<number, number> = {
  [D.TREE]: 5, [D.PINE]: 3, [D.PALM]: 2, [D.DEADTREE]: 1, [D.ROCK]: 3, [D.TUFT]: 3, [D.FLOWER]: 5, [D.CACTUS]: 1,
  [D.CRYSTAL]: 2, [D.MUSHROOM]: 3, [D.PILLAR]: 1, [D.REED]: 2, [D.STALAG]: 2,
};
