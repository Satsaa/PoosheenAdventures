// Map pins for the zoomed-out overlay (crisp 2D UI drawn over the lit map).
import type { MapObject } from '../core/types';
import { GATE_COL, OBJ_COL } from './palette';
import { FONT, shade } from './util';

type C = CanvasRenderingContext2D;

const TAU = Math.PI * 2;

function circle(c: C, x: number, y: number, r: number, fill: string) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}

function arch(c: C, x: number, y: number, w: number, h: number) {
  c.beginPath();
  c.moveTo(x - w / 2, y);
  c.lineTo(x - w / 2, y - h + w / 2);
  c.arc(x, y - h + w / 2, w / 2, Math.PI, 0);
  c.lineTo(x + w / 2, y);
  c.closePath();
}

export function npcColor(o: MapObject): string {
  const cols = ['#ff8a5c', '#5cc8ff', '#c38bff', '#ffd45c', '#6be08a', '#ff6fae'];
  const k = o.npcId || o.id;
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
  return cols[Math.abs(h) % cols.length];
}

// ------------------------------------------------------------------ pins (far zoom)

export function pinColor(o: MapObject): string {
  if (o.kind === 'gate') return GATE_COL[o.gate || 'open'] || OBJ_COL.gate;
  if (o.kind === 'npc') return npcColor(o);
  return OBJ_COL[o.kind] || '#ffffff';
}

/** Importance controls pin size: 0 = tiny dot, 1 = normal, 2 = big. */
export function pinRank(o: MapObject): number {
  switch (o.kind) {
    case 'boss':
    case 'start':
      return 2;
    case 'source':
    case 'ledge':
      return 0;
    case 'gate':
      return o.gate === 'ledge' || o.gate === 'open' ? 0 : 1;
    default:
      return 1;
  }
}

function pinGlyph(c: C, o: MapObject, x: number, y: number, r: number) {
  c.fillStyle = '#1a1424';
  c.strokeStyle = '#1a1424';
  c.lineWidth = Math.max(1, r * 0.22);
  switch (o.kind) {
    case 'chest':
      c.fillRect(x - r * 0.5, y - r * 0.3, r, r * 0.65);
      c.fillStyle = '#fff3c0';
      c.fillRect(x - r * 0.12, y - r * 0.12, r * 0.24, r * 0.24);
      return;
    case 'entrance':
    case 'stairs':
      arch(c, x, y + r * 0.5, r * 0.75, r * 1.0);
      c.fill();
      return;
    case 'boss':
      circle(c, x, y - r * 0.1, r * 0.55, '#fff');
      circle(c, x - r * 0.2, y - r * 0.12, r * 0.15, '#1a1424');
      circle(c, x + r * 0.2, y - r * 0.12, r * 0.15, '#1a1424');
      c.fillStyle = '#fff';
      c.fillRect(x - r * 0.28, y + r * 0.25, r * 0.56, r * 0.25);
      return;
    case 'start': {
      c.fillStyle = '#1a1424';
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 ? r * 0.3 : r * 0.7;
        c.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
      }
      c.closePath();
      c.fill();
      return;
    }
    case 'npc':
      if (o.icon) {
        c.font = `700 ${Math.round(r * 1.25)}px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(o.icon, x, y + r * 0.06);
      } else circle(c, x, y, r * 0.35, '#1a1424');
      return;
    case 'gate': {
      const g = o.gate;
      if (g === 'locked' || g === 'bossdoor') {
        circle(c, x, y - r * 0.15, r * 0.25, '#1a1424');
        c.fillRect(x - r * 0.1, y - r * 0.1, r * 0.2, r * 0.45);
      } else if (g === 'seal' || g === 'portal') {
        c.beginPath();
        c.arc(x, y, r * 0.45, 0, TAU);
        c.stroke();
      } else {
        c.beginPath();
        c.moveTo(x - r * 0.45, y);
        c.lineTo(x + r * 0.45, y);
        c.stroke();
      }
      return;
    }
  }
}

/** Teardrop pin pointing at (x,y). r = head radius in px. */
export function drawPin(c: C, o: MapObject, x: number, y: number, r: number, done: boolean) {
  const col = pinColor(o);
  const rank = pinRank(o);
  if (rank === 0) {
    circle(c, x, y, r * 0.5 + 1, 'rgba(10,8,20,0.7)');
    circle(c, x, y, r * 0.5, done ? 'rgba(180,180,180,0.6)' : col);
    return;
  }
  const hy = y - r * 1.55;
  c.fillStyle = 'rgba(6,4,14,0.45)';
  c.beginPath();
  c.ellipse(x + 1, y + 1, r * 0.55, r * 0.22, 0, 0, TAU);
  c.fill();
  c.beginPath();
  c.moveTo(x, y);
  c.arc(x, hy, r, Math.PI * 0.7, Math.PI * 2.3);
  c.closePath();
  c.fillStyle = 'rgba(10,8,20,0.85)';
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(10,8,20,0.85)';
  c.stroke();
  c.fillStyle = done ? shade(col, -0.45) : col;
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.beginPath();
  c.arc(x - r * 0.3, hy - r * 0.35, r * 0.3, 0, TAU);
  c.fill();
  if (r >= 5) pinGlyph(c, o, x, hy, r);
  if (done) {
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(x - r * 0.4, hy);
    c.lineTo(x - r * 0.1, hy + r * 0.3);
    c.lineTo(x + r * 0.45, hy - r * 0.35);
    c.stroke();
  }
}
