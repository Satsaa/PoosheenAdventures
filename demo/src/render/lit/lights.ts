// Point lights derived from the data, and per-dimension lighting moods.
import { D, T, type Dimension, type MapObject, type World } from '../../core/types';
import { CRYSTAL_LIGHT } from '../bake/models';
import type { AssetSheet } from '../bake/sheet';
import { TILE_PX } from '../bake/sheet';
import { type Layout, variant } from './compose';
import { npcColor } from '../objects';
import { hexRgb } from '../util';

export interface Light {
  x: number;
  y: number;
  z: number;
  r: number;
  c: [number, number, number];
  /** pulse speed (rad/s), 0 = steady */
  pulse: number;
  /** stable identity for fading in / out of the active set */
  id?: string;
}

/** Uniform grid over a dimension so huge worlds only look at the lights near the view. */
export class LightGrid {
  private cells = new Map<number, Light[]>();
  constructor(lights: Light[], readonly cell = 16) {
    for (const l of lights) {
      const k = Math.floor(l.x / cell) + Math.floor(l.y / cell) * 65536;
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(l);
    }
  }
  query(x0: number, y0: number, x1: number, y1: number, cb: (l: Light) => void) {
    const c = this.cell, m = 6; // lights reach a few tiles beyond their cell
    for (let cy = Math.floor((y0 - m) / c); cy <= Math.floor((y1 + m) / c); cy++)
      for (let cx = Math.floor((x0 - m) / c); cx <= Math.floor((x1 + m) / c); cx++) {
        const l = this.cells.get(cx + cy * 65536);
        if (l) for (const x of l) cb(x);
      }
  }
}

const L = (x: number, y: number, z: number, r: number, c: [number, number, number], pulse = 0): Light => ({ x, y, z, r, c, pulse });

export function staticLights(dim: Dimension, lay: Layout, st: { torches: [number, number, number][]; windows: [number, number, number][] }, sheet: AssetSheet, seed: number): Light[] {
  const out: Light[] = [];
  const { w, h, ground, deco } = dim;
  const under = dim.kind === 'underworld' || dim.kind === 'interior';
  const nCrystal = sheet.frames.get('d:' + D.CRYSTAL)?.length ?? 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z = lay.liftPx[i] / TILE_PX;
      if (deco[i] === D.CRYSTAL) {
        const c = CRYSTAL_LIGHT[variant(x, y, seed + D.CRYSTAL * 7, nCrystal) % CRYSTAL_LIGHT.length];
        out.push(L(x + 0.5, y + 0.55, z + 0.45, 3.4, [c[0] * 1.5, c[1] * 1.5, c[2] * 1.5], 1.1));
      } else if (deco[i] === D.MUSHROOM && under) out.push(L(x + 0.5, y + 0.6, z + 0.3, 2.2, [0.25, 0.6, 1.2], 0.8));
    }
  // lava: one light per 3x3 block with enough lava
  for (let by = 0; by < h; by += 3)
    for (let bx = 0; bx < w; bx += 3) {
      let n = 0, sx = 0, sy = 0, sz = 0;
      for (let y = by; y < Math.min(h, by + 3); y++)
        for (let x = bx; x < Math.min(w, bx + 3); x++)
          if (ground[y * w + x] === T.LAVA) { n++; sx += x; sy += y; sz += lay.liftPx[y * w + x]; }
      if (n >= 2) out.push(L(sx / n + 0.5, sy / n + 0.5, sz / n / TILE_PX + 0.5, 3 + n * 0.12, [1.6, 0.55, 0.15], 1.3));
    }
  for (const [x, y, z] of st.windows) out.push(L(x, y, z, 1.9, [0.95, 0.58, 0.26], 0));
  for (const [x, y, z] of st.torches) out.push(L(x, y, z - 0.1, 5, [1.7, 0.9, 0.38], 9));
  out.forEach((l, k) => (l.id = 's' + k));
  return out;
}

const ENT_LIGHT: Record<string, [number, [number, number, number], number]> = {
  house: [2.4, [1.0, 0.65, 0.3], 0],
  shop: [2.6, [1.05, 0.7, 0.32], 0],
  dungeon: [2.6, [1.2, 0.5, 0.25], 4],
  cave: [2.0, [0.7, 0.45, 0.3], 0],
  shrine: [3.0, [1.4, 1.1, 0.45], 1.5],
  sanctum: [3.6, [0.45, 0.75, 1.8], 1.5],
  'stairs-down': [1.8, [0.6, 0.45, 0.8], 0],
  'stairs-up': [2.4, [1.0, 1.0, 0.8], 0],
  beanstalk: [3.0, [0.5, 1.3, 0.5], 1],
  exit: [2.6, [0.45, 1.3, 0.85], 1.2],
};

/** lights carried by objects, depending on their done state */
export function objectLights(objs: { o: MapObject; done: boolean; z: number; alpha?: number }[], night = 0): Light[] {
  const out: Light[] = [];
  for (const { o, done, z, alpha } of objs) {
    const n0 = out.length;
    const sideOn = o.dir === 'e' || o.dir === 'w';
    const x = o.x + 0.5, y = sideOn ? o.y + 0.3 : o.y + 0.55;
    switch (o.kind) {
      case 'entrance':
      case 'stairs': {
        const e = ENT_LIGHT[o.style || (o.kind === 'stairs' ? 'stairs-down' : 'house')] || ENT_LIGHT.house;
        out.push(L(x, y + 0.2, z + 0.6, e[0], e[1], e[2]));
        break;
      }
      case 'chest':
        if (!done) out.push(L(x, y + 0.3, z + 0.6, 2.4, [1.6, 1.15, 0.35], 3));
        break;
      case 'npc': {
        const c = hexRgb(npcColor(o));
        out.push(L(x, y + 0.3, z + 0.9, 2.2, [0.9 + c[0] / 600, 0.65 + c[1] / 700, 0.4 + c[2] / 900], 0));
        break;
      }
      case 'start':
        out.push(L(x, y + 0.2, z + 0.9, 3.6, [1.15, 1.05, 0.8], 1.2));
        break;
      case 'source':
        out.push(L(x, y, z + 0.3, 1.5, [0.35, 0.7, 0.4], 0));
        break;
      case 'enemy' as MapObject['kind']:
        if ((o as MapObject & { enemy?: string }).enemy === 'wisp') out.push(L(x, y, z + 0.7, 2.6, [0.4, 0.9, 1.4], 2));
        break;
      case 'boss':
        if (!done) out.push(L(x, y + 0.2, z + 0.6, 3.6, [1.8, 0.2, 0.25], 2));
        break;
      case 'gate': {
        if ((o.gate as string) === 'waterfall') { out.push(L(x, y - 0.3, z + 0.6, 3.0, [0.22, 0.4, 0.6], 0.7)); break; }
        if (done) break;
        const g = o.gate;
        if ((g as string) === 'moon') out.push(L(x, y + 0.2, z + 0.6, 2.4, [0.5 * night, 0.6 * night, 1.3 * night], 0.8));
        else if ((g as string) === 'sun') out.push(L(x, y + 0.2, z + 0.6, 2.4, [1.5 * (1 - night), 1.15 * (1 - night), 0.4 * (1 - night)], 0.8));
        else if (g === 'seal') out.push(L(x, y + 0.2, z + 0.5, 3.6, [1.7, 0.35, 1.6], 2.5));
        else if (g === 'portal') out.push(L(x, y + 0.2, z + 0.5, 3.6, [0.9, 0.4, 2.0], 2));
        else if (g === 'eye') out.push(L(x, y + 0.4, z + 0.4, 2.2, [1.5, 0.6, 0.15], 1.5));
        else if (g === 'dark') out.push(L(x, y + 0.3, z + 0.4, 1.8, [0.5, 0.2, 1.0], 1));
        else if (g === 'water') out.push(L(x, y, z + 0.2, 1.6, [0.3, 0.8, 1.1], 1));
        break;
      }
    }
    for (let k = n0; k < out.length; k++) {
      out[k].id = 'o:' + o.id;
      if (alpha !== undefined && alpha < 1) out[k].c = [out[k].c[0] * alpha, out[k].c[1] * alpha, out[k].c[2] * alpha];
    }
  }
  return out;
}

export interface Mood {
  /** scene exposure (multiplied by the graphics setting) */
  exposure: number;
  /** follows the time of day (outdoor dimensions) */
  outdoor: boolean;
  keyDir: [number, number, number];
  keyCol: [number, number, number];
  ambTop: [number, number, number];
  ambBot: [number, number, number];
  bg0: [number, number, number];
  bg1: [number, number, number];
  fogTint: [number, number, number];
  rock: number;
  shadowLen: number;
  bloom: number;
  bloomThr: number;
  sat: number;
  contrast: number;
  vig: number;
  shadowTint: [number, number, number];
  highTint: [number, number, number];
  haze: number;
  hazeCol: [number, number, number];
  ghostTint: [number, number, number];
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function interiorStyle(world: World, dim: Dimension): string {
  for (const d of world.dims) for (const o of d.objects) if (o.to?.dim === dim.id && o.kind === 'entrance' && o.style && o.style !== 'exit') return o.style;
  const id = dim.id.toLowerCase();
  return /shop/.test(id) ? 'shop' : /sanct/.test(id) ? 'sanctum' : /house|home/.test(id) ? 'house' : /cave/.test(id) ? 'cave' : 'dungeon';
}

export function moodFor(world: World | null, dim: Dimension): Mood {
  const base: Mood = {
    exposure: 1, outdoor: true,
    keyDir: norm([-0.72, 0.38, 0.46]), keyCol: [1.2, 0.8, 0.5], ambTop: [0.24, 0.28, 0.46], ambBot: [0.1, 0.08, 0.15],
    bg0: [0.02, 0.04, 0.08], bg1: [0.04, 0.08, 0.14], fogTint: [0.55, 0.62, 0.85], rock: 0, shadowLen: 3,
    bloom: 0.9, bloomThr: 1.12, sat: 1.15, contrast: 1.08, vig: 1.1, shadowTint: [0.1, 0.45, 0.55], highTint: [1.05, 1.0, 0.9],
    haze: 0.05, hazeCol: [1.0, 0.6, 0.3], ghostTint: [0.5, 0.65, 1.0],
  };
  switch (dim.kind) {
    case 'underworld':
      return { ...base, exposure: 1.2, outdoor: false, keyDir: norm([-0.3, -0.2, 0.9]), keyCol: [0.3, 0.24, 0.5], ambTop: [0.27, 0.22, 0.42], ambBot: [0.1, 0.07, 0.15],
        bg0: [0.015, 0.01, 0.025], bg1: [0.03, 0.02, 0.045], rock: 1, shadowLen: 0, bloom: 1.25, bloomThr: 0.55, sat: 1.25, shadowTint: [0.35, 0.1, 0.55], haze: 0, highTint: [1.05, 0.98, 1.0] };
    case 'sky':
      return { ...base, exposure: 0.72, keyDir: norm([-0.55, -0.15, 0.82]), keyCol: [0.85, 0.72, 0.56], ambTop: [0.3, 0.36, 0.52], ambBot: [0.14, 0.16, 0.26],
        bg0: [0.03, 0.07, 0.22], bg1: [0.2, 0.36, 0.7], shadowLen: 2, bloom: 0.55, bloomThr: 1.15, shadowTint: [0.1, 0.25, 0.6], haze: 0.06, hazeCol: [0.7, 0.8, 1.0], ghostTint: [0.45, 0.6, 1.1] };
    case 'interior': {
      const st = world ? interiorStyle(world, dim) : 'dungeon';
      const dark = { ...base, exposure: 1.15, outdoor: false, keyDir: norm([-0.3, 0.2, 0.9]), shadowLen: 0, rock: 1, haze: 0, bg0: [0.012, 0.01, 0.018] as [number, number, number], bg1: [0.025, 0.02, 0.03] as [number, number, number] };
      if (st === 'house' || st === 'shop')
        return { ...dark, keyCol: [0.45, 0.32, 0.2], ambTop: [0.42, 0.3, 0.2], ambBot: [0.16, 0.1, 0.08], bloom: 0.9, bloomThr: 0.7, shadowTint: [0.4, 0.2, 0.1], highTint: [1.08, 1.0, 0.86] };
      if (st === 'sanctum')
        return { ...dark, keyCol: [0.2, 0.12, 0.35], ambTop: [0.16, 0.08, 0.28], ambBot: [0.05, 0.02, 0.09], bloom: 1.3, bloomThr: 0.55, shadowTint: [0.45, 0.1, 0.6], highTint: [1.0, 0.95, 1.1] };
      if (st === 'cave')
        return { ...dark, keyCol: [0.2, 0.16, 0.3], ambTop: [0.2, 0.16, 0.3], ambBot: [0.06, 0.05, 0.1], bloom: 1.2, bloomThr: 0.55, shadowTint: [0.3, 0.1, 0.5] };
      return { ...dark, keyCol: [0.18, 0.16, 0.26], ambTop: [0.19, 0.17, 0.27], ambBot: [0.06, 0.05, 0.09], bloom: 1.2, bloomThr: 0.55, shadowTint: [0.15, 0.3, 0.5] };
    }
  }
  return base;
}

export interface Sun {
  /** direction toward the light (x east, y south, z up), normalized */
  dir: [number, number, number];
  keyCol: [number, number, number];
  /** ambient multiplier and tint */
  amb: number;
  ambTint: [number, number, number];
  /** 0 = full day, 1 = deep night */
  night: number;
  /** strength of the cast shadows (fades out at the sun/moon hand-over) */
  shadowK: number;
}

const lerp3 = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const sstep = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Sun and moon for a time of day in hours, continuous everywhere (also across 24 -> 0). The sun
 * rises in the east (6:00), stands high in the north at noon (shadows fall south, toward the
 * viewer) and sets in the west (18:00); the moon takes the opposite side of the same circle.
 * Key colour, strength and direction are weighted blends of both, so twilight (about 5-7 and
 * 17-19) cross-fades instead of switching; shadows fade out where sun and moon are equally weak.
 */
export function sunAt(hours: number): Sun {
  const ph = ((hours - 6) / 24) * Math.PI * 2;
  const se = Math.sin(ph); // sun height: 1 noon, -1 midnight
  const pos = (sign: number): [number, number, number] => {
    const v: [number, number, number] = [Math.cos(ph) * sign, (-0.8 * Math.sin(ph) - 0.15) * sign, 1.15 * Math.sin(ph) * sign];
    v[2] = Math.max(0.12, v[2] + 0.1);
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  // the sun fades out just below the horizon before the moon fades in: at the hand-over both weights
  // are zero, so the key light's direction can switch without any visible change
  const wS = sstep(-0.06, 0.32, se), wM = sstep(0.06, 0.4, -se) * 0.85;
  const sd = pos(1), md = pos(-1);
  const k: [number, number, number] = wS + wM > 1e-4 ? [sd[0] * wS + md[0] * wM, sd[1] * wS + md[1] * wM, sd[2] * wS + md[2] * wM] : [0, 0, 1];
  k[2] = Math.max(0.12, k[2]);
  const kl = Math.hypot(k[0], k[1], k[2]);
  const day = sstep(-0.22, 0.3, se);
  const low = 1 - sstep(0.02, 0.55, se); // warm near the horizon
  const sunCol = lerp3([1.2, 1.05, 0.88], [1.45, 0.66, 0.34], low);
  const moonCol = [0.26, 0.34, 0.6];
  return {
    dir: [k[0] / kl, k[1] / kl, k[2] / kl],
    keyCol: [sunCol[0] * wS + moonCol[0] * wM, sunCol[1] * wS + moonCol[1] * wM, sunCol[2] * wS + moonCol[2] * wM],
    amb: 0.35 + 0.75 * day,
    ambTint: lerp3([0.45, 0.6, 1.25], lerp3([1.0, 0.92, 0.95], [1.1, 0.85, 0.8], low), day),
    night: 1 - day,
    shadowK: Math.max(wS, wM * 0.6),
  };
}
