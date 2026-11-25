// Point lights derived from the data, and per-dimension lighting moods.
import { D, T, type Dimension, type MapObject, type World } from '../../core/types';
import { CRYSTAL_LIGHT } from '../bake/models';
import type { AssetSheet } from '../bake/sheet';
import { TILE_PX } from '../bake/sheet';
import { type Layout, type StaticOut, variant } from './compose';
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
}

const L = (x: number, y: number, z: number, r: number, c: [number, number, number], pulse = 0): Light => ({ x, y, z, r, c, pulse });

export function staticLights(dim: Dimension, lay: Layout, st: StaticOut, sheet: AssetSheet, seed: number): Light[] {
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
  for (const [x, y, z] of st.windows) out.push(L(x, y, z, 2.4, [0.95, 0.58, 0.26], 0));
  for (const [x, y, z] of st.torches) out.push(L(x, y, z, 5, [1.7, 0.9, 0.38], 9));
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
export function objectLights(objs: { o: MapObject; done: boolean; z: number }[]): Light[] {
  const out: Light[] = [];
  for (const { o, done, z } of objs) {
    const x = o.x + 0.5, y = o.y + 0.55;
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
      case 'boss':
        if (!done) out.push(L(x, y + 0.2, z + 0.6, 3.6, [1.8, 0.2, 0.25], 2));
        break;
      case 'gate': {
        if (done) break;
        const g = o.gate;
        if (g === 'seal') out.push(L(x, y + 0.2, z + 0.5, 3.6, [1.7, 0.35, 1.6], 2.5));
        else if (g === 'portal') out.push(L(x, y + 0.2, z + 0.5, 3.6, [0.9, 0.4, 2.0], 2));
        else if (g === 'eye') out.push(L(x, y + 0.4, z + 0.4, 2.2, [1.5, 0.6, 0.15], 1.5));
        else if (g === 'dark') out.push(L(x, y + 0.3, z + 0.4, 1.8, [0.5, 0.2, 1.0], 1));
        else if (g === 'water') out.push(L(x, y, z + 0.2, 1.6, [0.3, 0.8, 1.1], 1));
        break;
      }
    }
  }
  return out;
}

export interface Mood {
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
    keyDir: norm([-0.72, 0.38, 0.46]), keyCol: [1.2, 0.8, 0.5], ambTop: [0.24, 0.28, 0.46], ambBot: [0.1, 0.08, 0.15],
    bg0: [0.02, 0.04, 0.08], bg1: [0.04, 0.08, 0.14], fogTint: [0.55, 0.62, 0.85], rock: 0, shadowLen: 3,
    bloom: 0.9, bloomThr: 0.95, sat: 1.15, contrast: 1.08, vig: 1.1, shadowTint: [0.1, 0.45, 0.55], highTint: [1.05, 1.0, 0.9],
    haze: 0.05, hazeCol: [1.0, 0.6, 0.3], ghostTint: [0.5, 0.65, 1.0],
  };
  switch (dim.kind) {
    case 'underworld':
      return { ...base, keyDir: norm([-0.3, -0.2, 0.9]), keyCol: [0.22, 0.18, 0.4], ambTop: [0.2, 0.16, 0.32], ambBot: [0.07, 0.05, 0.11],
        bg0: [0.015, 0.01, 0.025], bg1: [0.03, 0.02, 0.045], rock: 1, shadowLen: 0, bloom: 1.25, bloomThr: 0.55, sat: 1.25, shadowTint: [0.35, 0.1, 0.55], haze: 0, highTint: [1.05, 0.98, 1.0] };
    case 'sky':
      return { ...base, keyDir: norm([-0.55, -0.15, 0.82]), keyCol: [1.25, 1.02, 0.78], ambTop: [0.5, 0.6, 0.85], ambBot: [0.22, 0.26, 0.42],
        bg0: [0.03, 0.07, 0.22], bg1: [0.2, 0.36, 0.7], shadowLen: 2, bloom: 0.8, bloomThr: 0.85, shadowTint: [0.1, 0.25, 0.6], haze: 0.06, hazeCol: [0.7, 0.8, 1.0], ghostTint: [0.45, 0.6, 1.1] };
    case 'interior': {
      const st = world ? interiorStyle(world, dim) : 'dungeon';
      const dark = { ...base, keyDir: norm([-0.3, 0.2, 0.9]), shadowLen: 0, rock: 1, haze: 0, bg0: [0.012, 0.01, 0.018] as [number, number, number], bg1: [0.025, 0.02, 0.03] as [number, number, number] };
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
