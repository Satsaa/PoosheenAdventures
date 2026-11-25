// Ambient particles: per-biome emitters sampled inside the visible area only, capped pool.
import { D, T } from '../core/types';
import type { DimRender } from './terrain';
import { makeCanvas, ctx2d, clamp } from './util';

export type PKind = 'firefly' | 'pollen' | 'leaf' | 'snow' | 'ember' | 'dust' | 'glint' | 'wisp' | 'sparkle' | 'mote';

interface P {
  k: PKind;
  x: number; // world tile units
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number; // px at 32 px/tile
  col: string;
  ph: number;
}

const ADDITIVE: Record<PKind, boolean> = {
  firefly: true, pollen: true, leaf: false, snow: false, ember: true, dust: true, glint: true, wisp: false, sparkle: true, mote: true,
};

const glowCache = new Map<string, HTMLCanvasElement>();
function glow(col: string): HTMLCanvasElement {
  let g = glowCache.get(col);
  if (g) return g;
  g = makeCanvas(32, 32);
  const c = ctx2d(g);
  const gr = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.18, col);
  gr.addColorStop(0.5, col.replace(/rgb\(([^)]+)\)/, 'rgba($1,0.35)'));
  gr.addColorStop(1, col.replace(/rgb\(([^)]+)\)/, 'rgba($1,0)'));
  c.fillStyle = gr;
  c.fillRect(0, 0, 32, 32);
  glowCache.set(col, g);
  return g;
}

export class Particles {
  list: P[] = [];
  cap = 300;

  clear() {
    this.list.length = 0;
  }

  add(k: PKind, x: number, y: number, o: Partial<P> = {}) {
    if (this.list.length >= this.cap) return;
    const base: P = { k, x, y, vx: 0, vy: 0, life: 0, max: 3, size: 4, col: 'rgb(255,255,255)', ph: Math.random() * 6.28, ...o };
    this.list.push(base);
  }

  /** Sample random visible tiles and spawn biome-appropriate particles. */
  emit(dr: DimRender, vx0: number, vy0: number, vx1: number, vy1: number, dt: number) {
    const { dim } = dr;
    const { w, h, ground, deco } = dim;
    const area = (vx1 - vx0) * (vy1 - vy0);
    // spawn density independent of zoom, with a ceiling
    const tries = Math.min(14, Math.max(1, Math.round(area * dt * 0.05)));
    for (let k = 0; k < tries && this.list.length < this.cap; k++) {
      const fx = vx0 + Math.random() * (vx1 - vx0);
      const fy = vy0 + Math.random() * (vy1 - vy0) + dr.maxVe * dr.hT * 0.5;
      const x = Math.floor(fx), y = Math.floor(fy);
      if (x < 0 || y < 0 || x >= w || y >= h) {
        if (dim.kind === 'sky' && Math.random() < 0.05) this.wisp(fx, fy);
        continue;
      }
      const i = y * w + x;
      const g = ground[i], d = deco[i];
      const sy = fy - dr.ve[i] * dr.hT; // surface y
      const r = Math.random();
      if (g === T.VOID) {
        if (dim.kind === 'sky' && r < 0.08) this.wisp(fx, fy);
        else if (dim.kind !== 'sky' && r < 0.01) this.add('mote', fx, sy, { vy: -0.05, max: 4, size: 3, col: 'rgb(150,130,200)' });
        continue;
      }
      if (d === D.CRYSTAL && r < 0.6) {
        this.add('glint', x + 0.2 + Math.random() * 0.6, sy - 0.2 + Math.random() * 0.4, { max: 0.7, size: 7, col: Math.random() < 0.5 ? 'rgb(120,240,255)' : 'rgb(255,130,240)' });
        continue;
      }
      switch (g) {
        case T.GRASS:
        case T.SWAMP: {
          const forest = d === D.TREE || d === D.PINE || hasTreeNear(dim, x, y);
          if (forest && r < 0.12) this.add('firefly', fx, sy, { vx: 0, vy: 0, max: 4 + Math.random() * 3, size: 5, col: g === T.SWAMP ? 'rgb(170,255,120)' : 'rgb(255,230,120)' });
          else if (forest && r < 0.17) this.add('leaf', fx, sy - 0.8, { vx: 0.25, vy: 0.35, max: 4, size: 4, col: Math.random() < 0.5 ? '#d9822b' : '#9bc23a' });
          else if (!forest && r < 0.05) this.add('pollen', fx, sy, { vx: 0.15, vy: -0.08, max: 4, size: 3, col: 'rgb(255,250,200)' });
          break;
        }
        case T.SNOW:
          if (r < 0.35) this.add('snow', fx, sy - 2, { vx: 0.2, vy: 0.7, max: 4, size: 3, col: '#ffffff' });
          break;
        case T.LAVA:
          if (r < 0.5) this.add('ember', fx, sy, { vx: (Math.random() - 0.5) * 0.3, vy: -0.6 - Math.random() * 0.6, max: 1.5 + Math.random(), size: 5, col: Math.random() < 0.5 ? 'rgb(255,140,40)' : 'rgb(255,210,80)' });
          break;
        case T.CAVE:
        case T.CAVEWALL:
        case T.FLOOR:
          if (r < 0.12) this.add('dust', fx, sy, { vx: 0.05, vy: -0.03, max: 5, size: 3, col: 'rgb(200,180,150)' });
          break;
        case T.CLOUD:
          if (r < 0.06) this.wisp(fx, sy);
          break;
        case T.WATER:
          if (r < 0.025) this.add('glint', fx, sy, { max: 0.5, size: 5, col: 'rgb(200,240,255)' });
          break;
        case T.SAND:
          if (r < 0.02) this.add('pollen', fx, sy, { vx: 0.5, vy: 0, max: 2, size: 2, col: 'rgb(255,230,170)' });
          break;
      }
    }
  }

  wisp(x: number, y: number) {
    this.add('wisp', x, y, { vx: 0.18 + Math.random() * 0.15, vy: 0, max: 7, size: 26 + Math.random() * 20, col: '#ffffff' });
  }

  update(dt: number, t: number) {
    const L = this.list;
    let j = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      switch (p.k) {
        case 'firefly':
          p.vx += (Math.sin(t * 1.3 + p.ph * 3) * 0.6 - p.vx) * dt;
          p.vy += (Math.cos(t * 1.1 + p.ph * 2) * 0.5 - p.vy) * dt;
          break;
        case 'leaf':
          p.vx = 0.3 + Math.sin(t * 2 + p.ph) * 0.4;
          break;
        case 'snow':
          p.vx = 0.2 + Math.sin(t + p.ph) * 0.2;
          break;
        case 'dust':
        case 'mote':
          p.vx = Math.sin(t * 0.5 + p.ph) * 0.08;
          break;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      L[j++] = p;
    }
    L.length = j;
  }

  draw(c: CanvasRenderingContext2D, ox: number, oy: number, scale: number, t: number) {
    const zs = clamp(scale / 32, 0.45, 1.6);
    // non-additive first
    for (let pass = 0; pass < 2; pass++) {
      c.globalCompositeOperation = pass ? 'lighter' : 'source-over';
      for (const p of this.list) {
        if (ADDITIVE[p.k] !== !!pass) continue;
        const u = p.life / p.max;
        const fade = Math.min(1, u * 5, (1 - u) * 4);
        const sx = ox + p.x * scale, sy = oy + p.y * scale;
        switch (p.k) {
          case 'leaf': {
            c.globalAlpha = fade * 0.9;
            c.fillStyle = p.col;
            c.save();
            c.translate(sx, sy);
            c.rotate(t * 2 + p.ph);
            c.fillRect(-p.size * zs, -p.size * zs * 0.4, p.size * zs * 2, p.size * zs * 0.8);
            c.restore();
            break;
          }
          case 'snow':
            c.globalAlpha = fade * 0.9;
            c.fillStyle = '#ffffff';
            c.beginPath();
            c.arc(sx, sy, Math.max(1, p.size * zs * 0.6), 0, 6.283);
            c.fill();
            break;
          case 'wisp': {
            c.globalAlpha = fade * 0.18;
            c.fillStyle = '#ffffff';
            const r = p.size * zs;
            c.beginPath();
            c.ellipse(sx, sy, r * 1.6, r * 0.45, 0, 0, 6.283);
            c.ellipse(sx + r * 0.6, sy - r * 0.2, r, r * 0.35, 0, 0, 6.283);
            c.fill();
            break;
          }
          default: {
            let a = fade;
            if (p.k === 'firefly') a *= 0.55 + 0.45 * Math.sin(t * 4 + p.ph * 5);
            if (p.k === 'glint' || p.k === 'sparkle') a *= Math.sin(u * Math.PI);
            const s = p.size * zs * (p.k === 'glint' || p.k === 'sparkle' ? 1 + Math.sin(u * Math.PI) : 1);
            c.globalAlpha = clamp(a, 0, 1);
            c.drawImage(glow(p.col), sx - s * 2, sy - s * 2, s * 4, s * 4);
            if (p.k === 'glint' || p.k === 'sparkle') {
              c.fillStyle = '#ffffff';
              c.fillRect(sx - s * 1.6, sy - 0.5, s * 3.2, 1);
              c.fillRect(sx - 0.5, sy - s * 1.6, 1, s * 3.2);
            }
          }
        }
      }
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
}

function hasTreeNear(dim: { w: number; h: number; deco: Uint8Array }, x: number, y: number): boolean {
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= dim.w || yy >= dim.h) continue;
      const d = dim.deco[yy * dim.w + xx];
      if (d === D.TREE || d === D.PINE) return true;
    }
  return false;
}
