// Procedural deco sprites (D.*), baked into the terrain canvas in painter order.
// All coordinates: (px,py) = top-left of the tile's (elevated) top surface, S = tile size in px.
import { D, T } from '../core/types';
import { shade } from './util';

type C = CanvasRenderingContext2D;

/** How far (in tiles) a deco reaches above its own tile. Used for fog footprints and margins. */
export function decoOverhang(d: number): number {
  switch (d) {
    case D.TREE: return 0.55;
    case D.PINE: return 0.85;
    case D.PALM: return 0.75;
    case D.DEADTREE: return 0.6;
    case D.PILLAR: return 0.9;
    case D.HOUSE: return 0.55;
    case D.CACTUS: return 0.45;
    case D.CRYSTAL: return 0.35;
    case D.STALAG: return 0.5;
    default: return 0;
  }
}

function shadowEllipse(c: C, cx: number, cy: number, rx: number, ry: number, a = 0.32) {
  c.fillStyle = `rgba(10,8,20,${a})`;
  c.beginPath();
  c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  c.fill();
}

function blob(c: C, cx: number, cy: number, r: number, fill: string) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fill();
}

export interface DecoCtx {
  ground: number;
  /** deco of neighbours (for multi-tile houses) */
  decoW: number;
  decoE: number;
  decoS: number;
  decoN: number;
  underground: boolean;
  rnd: () => number;
}

export function drawDeco(c: C, d: number, px: number, py: number, S: number, k: DecoCtx) {
  const r = k.rnd;
  const cx = px + S / 2;
  switch (d) {
    case D.TREE: {
      const ox = (r() - 0.5) * S * 0.12;
      const baseY = py + S * 0.86;
      shadowEllipse(c, cx + S * 0.12 + ox, baseY + S * 0.02, S * 0.42, S * 0.17);
      c.fillStyle = '#4a2e1a';
      c.fillRect(cx - S * 0.07 + ox, py + S * 0.45, S * 0.14, S * 0.42);
      const hue = r();
      const base = hue < 0.12 ? '#c46a24' : hue < 0.2 ? '#b8a02a' : hue < 0.6 ? '#2f7a2c' : '#26692a';
      const ccy = py + S * 0.22;
      const R = S * 0.42;
      blob(c, cx + ox, ccy + S * 0.06, R * 1.02, shade(base, -0.45));
      blob(c, cx - R * 0.42 + ox, ccy + S * 0.04, R * 0.66, base);
      blob(c, cx + R * 0.4 + ox, ccy + S * 0.06, R * 0.64, shade(base, -0.08));
      blob(c, cx + ox, ccy - R * 0.28, R * 0.7, shade(base, 0.08));
      blob(c, cx - R * 0.22 + ox, ccy - R * 0.42, R * 0.36, shade(base, 0.28));
      blob(c, cx - R * 0.35 + ox, ccy - R * 0.5, R * 0.14, shade(base, 0.5, 0.8));
      break;
    }
    case D.PINE: {
      const snowy = k.ground === T.SNOW;
      const baseY = py + S * 0.88;
      shadowEllipse(c, cx + S * 0.12, baseY, S * 0.34, S * 0.13);
      c.fillStyle = '#3d2616';
      c.fillRect(cx - S * 0.05, py + S * 0.66, S * 0.1, S * 0.24);
      const col = snowy ? '#2a5f55' : '#1f5c3a';
      const layers = 3;
      for (let i = 0; i < layers; i++) {
        const t = i / layers;
        const w = S * (0.46 - t * 0.12);
        const yb = py + S * (0.74 - t * 0.4);
        const yt = yb - S * 0.55;
        c.fillStyle = shade(col, -0.3);
        c.beginPath();
        c.moveTo(cx, yt);
        c.lineTo(cx + w, yb);
        c.lineTo(cx - w, yb);
        c.closePath();
        c.fill();
        c.fillStyle = shade(col, 0.12 + t * 0.1);
        c.beginPath();
        c.moveTo(cx, yt);
        c.lineTo(cx - w * 0.1, yb - S * 0.04);
        c.lineTo(cx - w, yb);
        c.closePath();
        c.fill();
        if (snowy) {
          c.fillStyle = '#f2f7ff';
          c.beginPath();
          c.moveTo(cx, yt);
          c.lineTo(cx + w * 0.35, yt + S * 0.2);
          c.lineTo(cx - w * 0.4, yt + S * 0.22);
          c.closePath();
          c.fill();
        }
      }
      break;
    }
    case D.PALM: {
      shadowEllipse(c, cx + S * 0.2, py + S * 0.88, S * 0.36, S * 0.12);
      c.strokeStyle = '#8a6236';
      c.lineWidth = S * 0.09;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - S * 0.05, py + S * 0.86);
      c.quadraticCurveTo(cx + S * 0.16, py + S * 0.4, cx + S * 0.04, py - S * 0.1);
      c.stroke();
      const tx = cx + S * 0.04, ty = py - S * 0.12;
      c.lineWidth = S * 0.1;
      const leaf = ['#2e8a3a', '#3aa244', '#257a33'];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i - 2.5) * 0.62 + (r() - 0.5) * 0.2;
        c.strokeStyle = leaf[i % 3];
        c.beginPath();
        c.moveTo(tx, ty);
        c.quadraticCurveTo(tx + Math.cos(a) * S * 0.3, ty + Math.sin(a) * S * 0.3 - S * 0.08, tx + Math.cos(a) * S * 0.48, ty + Math.sin(a) * S * 0.3 + S * 0.12);
        c.stroke();
      }
      blob(c, tx, ty + S * 0.04, S * 0.06, '#6a4220');
      c.lineCap = 'butt';
      break;
    }
    case D.DEADTREE: {
      shadowEllipse(c, cx + S * 0.12, py + S * 0.88, S * 0.28, S * 0.1);
      c.strokeStyle = '#5b4a40';
      c.lineCap = 'round';
      c.lineWidth = S * 0.1;
      c.beginPath();
      c.moveTo(cx, py + S * 0.88);
      c.lineTo(cx + S * 0.02, py + S * 0.2);
      c.stroke();
      c.lineWidth = S * 0.05;
      c.beginPath();
      c.moveTo(cx + S * 0.01, py + S * 0.45);
      c.lineTo(cx - S * 0.28, py + S * 0.05);
      c.moveTo(cx + S * 0.02, py + S * 0.3);
      c.lineTo(cx + S * 0.3, py - S * 0.05);
      c.moveTo(cx - S * 0.16, py + S * 0.22);
      c.lineTo(cx - S * 0.3, py + S * 0.22);
      c.moveTo(cx + S * 0.02, py + S * 0.22);
      c.lineTo(cx + S * 0.05, py - S * 0.25);
      c.stroke();
      c.strokeStyle = '#8a7768';
      c.lineWidth = S * 0.025;
      c.beginPath();
      c.moveTo(cx - S * 0.03, py + S * 0.85);
      c.lineTo(cx - S * 0.02, py + S * 0.25);
      c.stroke();
      c.lineCap = 'butt';
      break;
    }
    case D.ROCK: {
      const s = 0.75 + r() * 0.35;
      const by = py + S * 0.78;
      shadowEllipse(c, cx + S * 0.08, by + S * 0.04, S * 0.36 * s, S * 0.14 * s);
      const base = k.underground ? '#6b6178' : '#8b8580';
      c.fillStyle = shade(base, -0.4);
      c.beginPath();
      c.moveTo(cx - S * 0.34 * s, by);
      c.lineTo(cx - S * 0.26 * s, by - S * 0.32 * s);
      c.lineTo(cx - S * 0.02 * s, by - S * 0.46 * s);
      c.lineTo(cx + S * 0.26 * s, by - S * 0.34 * s);
      c.lineTo(cx + S * 0.36 * s, by - S * 0.04 * s);
      c.lineTo(cx + S * 0.2 * s, by + S * 0.06 * s);
      c.lineTo(cx - S * 0.2 * s, by + S * 0.06 * s);
      c.closePath();
      c.fill();
      c.fillStyle = base;
      c.beginPath();
      c.moveTo(cx - S * 0.26 * s, by - S * 0.3 * s);
      c.lineTo(cx - S * 0.02 * s, by - S * 0.44 * s);
      c.lineTo(cx + S * 0.24 * s, by - S * 0.32 * s);
      c.lineTo(cx + S * 0.08 * s, by - S * 0.12 * s);
      c.lineTo(cx - S * 0.24 * s, by - S * 0.1 * s);
      c.closePath();
      c.fill();
      c.fillStyle = shade(base, 0.35);
      c.beginPath();
      c.moveTo(cx - S * 0.22 * s, by - S * 0.3 * s);
      c.lineTo(cx - S * 0.02 * s, by - S * 0.42 * s);
      c.lineTo(cx + S * 0.02 * s, by - S * 0.3 * s);
      c.closePath();
      c.fill();
      break;
    }
    case D.TUFT: {
      c.strokeStyle = k.ground === T.SAND ? '#9aa24a' : k.ground === T.SNOW ? '#7f9a7a' : '#2f7a2a';
      c.lineWidth = Math.max(1, S * 0.045);
      const n = 2 + Math.floor(r() * 2);
      for (let j = 0; j < n; j++) {
        const bx = px + S * (0.2 + r() * 0.6), by = py + S * (0.35 + r() * 0.5);
        c.beginPath();
        for (let i = -2; i <= 2; i++) {
          c.moveTo(bx + i * S * 0.03, by);
          c.lineTo(bx + i * S * 0.07, by - S * (0.14 + Math.abs(2 - Math.abs(i)) * 0.04));
        }
        c.stroke();
        c.strokeStyle = '#7fc95a';
        c.beginPath();
        c.moveTo(bx, by);
        c.lineTo(bx + S * 0.01, by - S * 0.2);
        c.stroke();
        c.strokeStyle = k.ground === T.SAND ? '#9aa24a' : '#2f7a2a';
      }
      break;
    }
    case D.FLOWER: {
      const cols = ['#ff5d7a', '#ffd84a', '#ffffff', '#c58bff', '#ff9a3c', '#6fd3ff'];
      const col = cols[Math.floor(r() * cols.length)];
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const fx = px + S * (0.15 + r() * 0.7), fy = py + S * (0.2 + r() * 0.65);
        c.strokeStyle = '#2b6a28';
        c.lineWidth = Math.max(1, S * 0.03);
        c.beginPath();
        c.moveTo(fx, fy);
        c.lineTo(fx, fy + S * 0.08);
        c.stroke();
        blob(c, fx, fy, S * 0.065, col);
        blob(c, fx, fy, S * 0.025, i % 2 ? '#fff6c0' : '#6a3a12');
      }
      break;
    }
    case D.CACTUS: {
      shadowEllipse(c, cx + S * 0.12, py + S * 0.88, S * 0.24, S * 0.09);
      const g = '#3f9a4a', gd = '#25693a', gl = '#7fd07a';
      c.lineCap = 'round';
      c.strokeStyle = gd;
      c.lineWidth = S * 0.2;
      c.beginPath();
      c.moveTo(cx, py + S * 0.84);
      c.lineTo(cx, py + S * 0.0);
      c.moveTo(cx - S * 0.02, py + S * 0.5);
      c.lineTo(cx - S * 0.24, py + S * 0.5);
      c.lineTo(cx - S * 0.24, py + S * 0.22);
      c.moveTo(cx + S * 0.02, py + S * 0.38);
      c.lineTo(cx + S * 0.22, py + S * 0.38);
      c.lineTo(cx + S * 0.22, py + S * 0.16);
      c.stroke();
      c.strokeStyle = g;
      c.lineWidth = S * 0.13;
      c.stroke();
      c.strokeStyle = gl;
      c.lineWidth = S * 0.035;
      c.beginPath();
      c.moveTo(cx - S * 0.04, py + S * 0.78);
      c.lineTo(cx - S * 0.04, py + S * 0.04);
      c.stroke();
      c.lineCap = 'butt';
      blob(c, cx, py + S * -0.04, S * 0.05, '#ff6ab0');
      break;
    }
    case D.CRYSTAL: {
      const hue = r() < 0.5 ? ['#5ff2ff', '#2aa3d6', '#d8fcff'] : ['#ff7cf2', '#b23ad6', '#ffe0fb'];
      // baked glow
      const gx = cx, gy = py + S * 0.5;
      const gr = c.createRadialGradient(gx, gy, 0, gx, gy, S * 0.9);
      gr.addColorStop(0, shade(hue[0], 0, 0.45));
      gr.addColorStop(1, shade(hue[0], 0, 0));
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = gr;
      c.fillRect(gx - S, gy - S, S * 2, S * 2);
      c.restore();
      const shards: [number, number, number][] = [[-0.2, 0.42, 0.13], [0.16, 0.5, 0.12], [0, 0.72, 0.16]];
      for (const [ox, hh, ww] of shards) {
        const bx = cx + ox * S, by = py + S * 0.82;
        c.fillStyle = hue[1];
        c.beginPath();
        c.moveTo(bx - ww * S, by);
        c.lineTo(bx - ww * S * 0.7, by - hh * S * 0.75);
        c.lineTo(bx, by - hh * S);
        c.lineTo(bx + ww * S * 0.7, by - hh * S * 0.75);
        c.lineTo(bx + ww * S, by);
        c.closePath();
        c.fill();
        c.fillStyle = hue[0];
        c.beginPath();
        c.moveTo(bx - ww * S * 0.7, by - hh * S * 0.75);
        c.lineTo(bx, by - hh * S);
        c.lineTo(bx, by);
        c.lineTo(bx - ww * S, by);
        c.closePath();
        c.fill();
        c.fillStyle = hue[2];
        c.fillRect(bx - ww * S * 0.45, by - hh * S * 0.7, Math.max(1, S * 0.03), hh * S * 0.5);
      }
      break;
    }
    case D.MUSHROOM: {
      const glow = k.underground;
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const mx = px + S * (0.25 + r() * 0.5), my = py + S * (0.45 + r() * 0.4), ms = S * (0.12 + r() * 0.1);
        shadowEllipse(c, mx + ms * 0.4, my + ms * 0.2, ms * 0.9, ms * 0.35, 0.25);
        c.fillStyle = '#efe2c8';
        c.fillRect(mx - ms * 0.25, my - ms * 0.6, ms * 0.5, ms * 0.7);
        const cap = glow ? '#4ad8ff' : '#e0342e';
        if (glow) {
          c.save();
          c.globalCompositeOperation = 'lighter';
          const g = c.createRadialGradient(mx, my - ms * 0.6, 0, mx, my - ms * 0.6, ms * 2.6);
          g.addColorStop(0, 'rgba(80,220,255,0.45)');
          g.addColorStop(1, 'rgba(80,220,255,0)');
          c.fillStyle = g;
          c.fillRect(mx - ms * 3, my - ms * 3.6, ms * 6, ms * 6);
          c.restore();
        }
        c.fillStyle = shade(cap, -0.35);
        c.beginPath();
        c.ellipse(mx, my - ms * 0.55, ms, ms * 0.62, 0, Math.PI, 0);
        c.fill();
        c.fillStyle = cap;
        c.beginPath();
        c.ellipse(mx - ms * 0.05, my - ms * 0.62, ms * 0.88, ms * 0.55, 0, Math.PI, 0);
        c.fill();
        blob(c, mx - ms * 0.35, my - ms * 0.85, ms * 0.14, '#fff');
        blob(c, mx + ms * 0.25, my - ms * 0.95, ms * 0.1, '#fff');
      }
      break;
    }
    case D.PILLAR: {
      shadowEllipse(c, cx + S * 0.18, py + S * 0.84, S * 0.34, S * 0.12, 0.38);
      const top = py - S * 0.55, bot = py + S * 0.82, w = S * 0.4;
      const g = c.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
      g.addColorStop(0, '#d9d2c2');
      g.addColorStop(0.45, '#b9b0a0');
      g.addColorStop(1, '#6d6558');
      c.fillStyle = g;
      c.fillRect(cx - w / 2, top + S * 0.12, w, bot - top - S * 0.18);
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let i = 1; i < 4; i++) c.fillRect(cx - w / 2 + (w * i) / 4, top + S * 0.14, Math.max(1, S * 0.02), bot - top - S * 0.24);
      c.fillStyle = '#e8e2d4';
      c.fillRect(cx - w * 0.68, top, w * 1.36, S * 0.14);
      c.fillStyle = '#8c8475';
      c.fillRect(cx - w * 0.68, top + S * 0.11, w * 1.36, S * 0.04);
      c.fillStyle = '#a49b8b';
      c.fillRect(cx - w * 0.64, bot - S * 0.1, w * 1.28, S * 0.12);
      break;
    }
    case D.REED: {
      const n = 4 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const rx = px + S * (0.15 + r() * 0.7), ry = py + S * (0.5 + r() * 0.4), rh = S * (0.3 + r() * 0.3);
        c.strokeStyle = i % 2 ? '#6f8f3a' : '#4f7a2e';
        c.lineWidth = Math.max(1, S * 0.035);
        c.beginPath();
        c.moveTo(rx, ry);
        c.quadraticCurveTo(rx + S * 0.04, ry - rh * 0.5, rx + (r() - 0.5) * S * 0.1, ry - rh);
        c.stroke();
        if (i % 2 === 0) {
          c.fillStyle = '#6a3f1e';
          c.fillRect(rx - S * 0.025, ry - rh * 0.75, S * 0.05, rh * 0.25);
        }
      }
      break;
    }
    case D.STALAG: {
      shadowEllipse(c, cx + S * 0.12, py + S * 0.86, S * 0.3, S * 0.1, 0.35);
      const n = 1 + Math.floor(r() * 2);
      for (let i = 0; i < n; i++) {
        const sx = cx + (i ? (r() - 0.5) * S * 0.5 : 0), sh = S * (i ? 0.6 : 1.1), sw = S * (i ? 0.16 : 0.24);
        const by = py + S * 0.86;
        c.fillStyle = '#3a3346';
        c.beginPath();
        c.moveTo(sx - sw, by);
        c.lineTo(sx, by - sh);
        c.lineTo(sx + sw, by);
        c.closePath();
        c.fill();
        c.fillStyle = '#7a6e8e';
        c.beginPath();
        c.moveTo(sx - sw, by);
        c.lineTo(sx, by - sh);
        c.lineTo(sx - sw * 0.1, by);
        c.closePath();
        c.fill();
        c.fillStyle = 'rgba(255,255,255,0.12)';
        c.fillRect(sx - sw * 0.5, by - sh * 0.45, Math.max(1, S * 0.03), sh * 0.3);
      }
      break;
    }
    case D.HOUSE: {
      const front = k.decoS !== D.HOUSE;
      const wl = k.decoW !== D.HOUSE, wr = k.decoE !== D.HOUSE;
      const back = k.decoN !== D.HOUSE;
      const roofTop = back ? py - S * 0.45 : py - S * 0.05;
      const roofBot = front ? py + S * 0.38 : py + S * 1.0;
      if (front) {
        shadowEllipse(c, cx + S * 0.15, py + S * 0.98, S * 0.6, S * 0.12, 0.3);
        // wall
        c.fillStyle = '#e8d6b0';
        c.fillRect(px, py + S * 0.3, S, S * 0.66);
        c.fillStyle = '#c4ab80';
        c.fillRect(px, py + S * 0.86, S, S * 0.1);
        c.fillStyle = '#6a4424';
        if (wl) c.fillRect(px, py + S * 0.3, S * 0.08, S * 0.66);
        if (wr) c.fillRect(px + S * 0.92, py + S * 0.3, S * 0.08, S * 0.66);
        // window
        c.fillStyle = '#3a2a1c';
        c.fillRect(cx - S * 0.16, py + S * 0.5, S * 0.32, S * 0.24);
        c.fillStyle = '#ffd36a';
        c.fillRect(cx - S * 0.12, py + S * 0.53, S * 0.24, S * 0.18);
        c.fillStyle = '#3a2a1c';
        c.fillRect(cx - S * 0.015, py + S * 0.53, S * 0.03, S * 0.18);
      }
      // roof
      const x0 = px - (wl ? S * 0.08 : 0), x1 = px + S + (wr ? S * 0.08 : 0);
      c.fillStyle = '#8a2e22';
      c.fillRect(x0, roofTop, x1 - x0, roofBot - roofTop);
      c.fillStyle = '#b5432e';
      c.fillRect(x0, roofTop, x1 - x0, (roofBot - roofTop) * 0.55);
      c.fillStyle = 'rgba(0,0,0,0.2)';
      for (let yy = roofTop + S * 0.14; yy < roofBot - 2; yy += S * 0.16) c.fillRect(x0, yy, x1 - x0, Math.max(1, S * 0.03));
      if (back) {
        c.fillStyle = '#e0674a';
        c.fillRect(x0, roofTop, x1 - x0, S * 0.07);
      }
      if (front) {
        c.fillStyle = '#5e1c14';
        c.fillRect(x0, roofBot - S * 0.06, x1 - x0, S * 0.06);
      }
      if (wl) {
        c.fillStyle = 'rgba(255,220,180,0.25)';
        c.fillRect(x0, roofTop, S * 0.06, roofBot - roofTop);
      }
      if (wr) {
        c.fillStyle = 'rgba(0,0,0,0.3)';
        c.fillRect(x1 - S * 0.06, roofTop, S * 0.06, roofBot - roofTop);
        if (back) {
          // chimney
          c.fillStyle = '#6b5a52';
          c.fillRect(x1 - S * 0.36, roofTop - S * 0.16, S * 0.16, S * 0.26);
          c.fillStyle = '#3a302c';
          c.fillRect(x1 - S * 0.38, roofTop - S * 0.18, S * 0.2, S * 0.05);
        }
      }
      break;
    }
  }
}
