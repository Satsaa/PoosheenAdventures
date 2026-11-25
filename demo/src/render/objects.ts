// Procedural object sprites (MapObject) drawn every frame, plus compact pins for far zoom.
import type { MapObject } from '../core/types';
import { GATE_COL, OBJ_COL } from './palette';
import { FONT, hash2, shade, withAlpha } from './util';

type C = CanvasRenderingContext2D;

const TAU = Math.PI * 2;

function circle(c: C, x: number, y: number, r: number, fill: string) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}

function rr(c: C, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function shadow(c: C, x: number, y: number, rx: number, ry: number, a = 0.35) {
  c.fillStyle = `rgba(6,4,16,${a})`;
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, TAU);
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

export function sourceKind(o: MapObject): 'pot' | 'grass' | 'flower' {
  const s = `${o.style || ''} ${o.icon || ''} ${o.label || ''} ${o.sourceId || ''}`.toLowerCase();
  if (/pot|jar|urn|vase/.test(s)) return 'pot';
  if (/grass|bush|tuft/.test(s)) return 'grass';
  return 'flower';
}

export function entranceStyle(o: MapObject): string {
  if (o.kind === 'stairs') return o.style && o.style.startsWith('stairs') ? o.style : 'stairs-down';
  return o.style || 'house';
}

function drawFigure(c: C, x: number, y: number, s: number, body: string, t: number, guard = false) {
  const bob = Math.sin(t * 3 + x * 0.1) * s * 0.02;
  shadow(c, x, y + s * 0.34, s * 0.26, s * 0.09);
  // body
  c.fillStyle = shade(body, -0.35);
  rr(c, x - s * 0.2, y - s * 0.06 + bob, s * 0.4, s * 0.4, s * 0.12);
  c.fill();
  c.fillStyle = body;
  rr(c, x - s * 0.2, y - s * 0.08 + bob, s * 0.36, s * 0.36, s * 0.12);
  c.fill();
  // head
  circle(c, x, y - s * 0.2 + bob, s * 0.17, '#f3d2b0');
  circle(c, x - s * 0.06, y - s * 0.2 + bob, s * 0.025, '#2a1a12');
  circle(c, x + s * 0.06, y - s * 0.2 + bob, s * 0.025, '#2a1a12');
  if (guard) {
    c.fillStyle = '#9aa3b4';
    c.beginPath();
    c.arc(x, y - s * 0.24 + bob, s * 0.19, Math.PI, 0);
    c.fill();
    c.fillStyle = '#cfd6e2';
    c.fillRect(x - s * 0.2, y - s * 0.26 + bob, s * 0.4, s * 0.04);
    c.strokeStyle = '#6b4a2a';
    c.lineWidth = Math.max(1, s * 0.04);
    c.beginPath();
    c.moveTo(x + s * 0.27, y + s * 0.3);
    c.lineTo(x + s * 0.27, y - s * 0.5);
    c.stroke();
    c.fillStyle = '#dfe6f0';
    c.beginPath();
    c.moveTo(x + s * 0.27, y - s * 0.62);
    c.lineTo(x + s * 0.33, y - s * 0.48);
    c.lineTo(x + s * 0.21, y - s * 0.48);
    c.closePath();
    c.fill();
  } else {
    c.fillStyle = shade(body, -0.2);
    c.beginPath();
    c.arc(x, y - s * 0.25 + bob, s * 0.17, Math.PI * 1.05, Math.PI * 1.95);
    c.fill();
  }
}

export interface ObjLook {
  done: boolean;
  t: number;
  /** a wall (house / cliff face) is directly north: doors and cracks are drawn into it */
  attach?: boolean;
}

/** Draw an object sprite centred on its tile. (x,y) = screen centre of the tile surface, s = tile px. */
export function drawObject(c: C, o: MapObject, x: number, y: number, s: number, look: ObjLook) {
  const { done, t } = look;
  switch (o.kind) {
    case 'chest': {
      shadow(c, x + s * 0.06, y + s * 0.3, s * 0.36, s * 0.1);
      const w = s * 0.62, h = s * 0.4, bx = x - w / 2, by = y - h * 0.35;
      c.fillStyle = '#5a3216';
      rr(c, bx, by, w, h, s * 0.05);
      c.fill();
      c.fillStyle = '#8c5426';
      c.fillRect(bx + s * 0.03, by + s * 0.03, w - s * 0.06, h - s * 0.08);
      if (done) {
        c.fillStyle = '#1a0e08';
        c.fillRect(bx + s * 0.04, by - s * 0.02, w - s * 0.08, s * 0.1);
        c.fillStyle = '#6e3f1a';
        rr(c, bx, by - s * 0.24, w, s * 0.2, s * 0.05);
        c.fill();
        c.fillStyle = '#b08a3a';
        c.fillRect(bx, by - s * 0.07, w, s * 0.04);
      } else {
        c.fillStyle = '#a3632c';
        rr(c, bx - s * 0.02, by - s * 0.16, w + s * 0.04, s * 0.2, s * 0.08);
        c.fill();
        c.fillStyle = '#f2c14a';
        c.fillRect(bx - s * 0.02, by + s * 0.02, w + s * 0.04, s * 0.05);
        c.fillRect(x - s * 0.06, by - s * 0.02, s * 0.12, s * 0.14);
        c.fillStyle = '#5a3216';
        c.fillRect(x - s * 0.02, by + s * 0.03, s * 0.04, s * 0.05);
        c.fillStyle = 'rgba(255,255,255,0.35)';
        c.fillRect(bx + s * 0.02, by - s * 0.13, w * 0.5, s * 0.03);
      }
      break;
    }
    case 'npc': {
      drawFigure(c, x, y, s, npcColor(o), t);
      if (o.icon && s >= 22) {
        const by = y - s * 0.66;
        c.fillStyle = 'rgba(255,255,255,0.92)';
        rr(c, x - s * 0.17, by - s * 0.16, s * 0.34, s * 0.3, s * 0.08);
        c.fill();
        c.beginPath();
        c.moveTo(x - s * 0.05, by + s * 0.13);
        c.lineTo(x + s * 0.05, by + s * 0.13);
        c.lineTo(x, by + s * 0.2);
        c.fill();
        c.fillStyle = '#20202a';
        c.font = `700 ${Math.round(s * 0.22)}px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(o.icon, x, by);
      }
      break;
    }
    case 'boss': {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.5);
      c.save();
      c.globalCompositeOperation = 'lighter';
      const g = c.createRadialGradient(x, y, 0, x, y, s * 0.9);
      g.addColorStop(0, `rgba(255,40,60,${done ? 0.08 : 0.35 + 0.15 * pulse})`);
      g.addColorStop(1, 'rgba(255,40,60,0)');
      c.fillStyle = g;
      c.fillRect(x - s, y - s, s * 2, s * 2);
      c.restore();
      c.globalAlpha *= done ? 0.45 : 1;
      shadow(c, x, y + s * 0.32, s * 0.32, s * 0.1);
      circle(c, x, y - s * 0.08, s * 0.32, '#efe6d6');
      c.fillStyle = '#efe6d6';
      c.fillRect(x - s * 0.18, y + s * 0.1, s * 0.36, s * 0.18);
      circle(c, x - s * 0.12, y - s * 0.06, s * 0.09, '#2a0a10');
      circle(c, x + s * 0.12, y - s * 0.06, s * 0.09, '#2a0a10');
      if (!done) {
        circle(c, x - s * 0.12, y - s * 0.06, s * 0.035, '#ff3b4e');
        circle(c, x + s * 0.12, y - s * 0.06, s * 0.035, '#ff3b4e');
      }
      c.fillStyle = '#2a0a10';
      for (let i = -1; i <= 1; i++) c.fillRect(x + i * s * 0.09 - s * 0.02, y + s * 0.14, s * 0.04, s * 0.12);
      c.fillStyle = '#b8a888';
      c.beginPath();
      c.moveTo(x - s * 0.28, y - s * 0.28);
      c.lineTo(x - s * 0.42, y - s * 0.5);
      c.lineTo(x - s * 0.18, y - s * 0.36);
      c.moveTo(x + s * 0.28, y - s * 0.28);
      c.lineTo(x + s * 0.42, y - s * 0.5);
      c.lineTo(x + s * 0.18, y - s * 0.36);
      c.fill();
      c.globalAlpha /= done ? 0.45 : 1;
      break;
    }
    case 'start': {
      const k = 0.5 + 0.5 * Math.sin(t * 2);
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = Math.max(1.5, s * 0.06);
      c.beginPath();
      c.ellipse(x, y + s * 0.1, s * (0.36 + 0.04 * k), s * (0.2 + 0.02 * k), 0, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(120,255,200,0.8)';
      c.lineWidth = Math.max(1, s * 0.03);
      c.beginPath();
      c.ellipse(x, y + s * 0.1, s * 0.46, s * 0.26, 0, 0, TAU);
      c.stroke();
      drawFigure(c, x, y - s * 0.05, s * 0.9, '#3fbf6a', t);
      c.fillStyle = '#2e8f4d';
      c.beginPath();
      c.moveTo(x - s * 0.17, y - s * 0.3);
      c.lineTo(x + s * 0.06, y - s * 0.62);
      c.lineTo(x + s * 0.17, y - s * 0.3);
      c.closePath();
      c.fill();
      break;
    }
    case 'source': {
      const k = sourceKind(o);
      if (k === 'pot') {
        shadow(c, x + s * 0.04, y + s * 0.26, s * 0.2, s * 0.07);
        c.fillStyle = '#8a4f2a';
        c.beginPath();
        c.ellipse(x, y + s * 0.06, s * 0.2, s * 0.22, 0, 0, TAU);
        c.fill();
        c.fillStyle = '#b8703a';
        c.beginPath();
        c.ellipse(x - s * 0.04, y + s * 0.02, s * 0.13, s * 0.16, 0, 0, TAU);
        c.fill();
        c.fillStyle = '#5a3016';
        c.fillRect(x - s * 0.1, y - s * 0.18, s * 0.2, s * 0.06);
        c.fillStyle = '#e0a36a';
        c.fillRect(x - s * 0.12, y - s * 0.03, s * 0.04, s * 0.06);
      } else if (k === 'grass') {
        c.strokeStyle = '#3fae3a';
        c.lineWidth = Math.max(1, s * 0.06);
        c.beginPath();
        for (let i = -3; i <= 3; i++) {
          c.moveTo(x + i * s * 0.07, y + s * 0.25);
          c.lineTo(x + i * s * 0.1 + Math.sin(t * 2 + i) * s * 0.02, y - s * 0.05 - (3 - Math.abs(i)) * s * 0.05);
        }
        c.stroke();
        c.strokeStyle = '#9ff07a';
        c.lineWidth = Math.max(1, s * 0.03);
        c.stroke();
      } else {
        c.strokeStyle = '#2e7a2a';
        c.lineWidth = Math.max(1, s * 0.05);
        c.beginPath();
        c.moveTo(x, y + s * 0.25);
        c.lineTo(x, y - s * 0.05);
        c.stroke();
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * TAU + t * 0.4;
          circle(c, x + Math.cos(a) * s * 0.1, y - s * 0.12 + Math.sin(a) * s * 0.1, s * 0.08, '#ff7ad0');
        }
        circle(c, x, y - s * 0.12, s * 0.06, '#ffe45a');
      }
      break;
    }
    case 'entrance':
    case 'stairs':
      drawEntrance(c, o, entranceStyle(o), x, y, s, t, done, !!look.attach);
      break;
    case 'ledge':
      drawLedge(c, o.dir || 's', x, y, s, t);
      break;
    case 'gate':
      drawGate(c, o, x, look.attach && o.gate === 'cracked' ? y - s * 0.45 : y, s, t, done);
      break;
  }
}

function drawWaterfall(c: C, o: MapObject, x: number, y: number, s: number, t: number) {
  const dir = o.dir || 's';
  const foam = (fx: number, fy: number, n: number, horiz: boolean) => {
    for (let k = 0; k < n; k++) {
      const ph = Math.sin(t * 4 + k * 1.7) * s * 0.02;
      const px = horiz ? fx - s * 0.42 + (k * s * 0.84) / (n - 1) : fx + ph;
      const py = horiz ? fy + ph : fy - s * 0.42 + (k * s * 0.84) / (n - 1);
      circle(c, px, py, s * (0.09 + (k % 2) * 0.03), k % 2 ? 'rgba(235,248,255,0.9)' : 'rgba(200,230,245,0.85)');
    }
  };
  if (dir === 'e' || dir === 'w') {
    // side-on cascade over the step on the upstream edge
    const ex = x + (dir === 'e' ? -s * 0.45 : s * 0.45);
    const g = c.createLinearGradient(0, y - s * 0.55, 0, y + s * 0.3);
    g.addColorStop(0, '#7cc8ee');
    g.addColorStop(1, '#2a78b0');
    c.fillStyle = g;
    c.fillRect(ex - s * 0.07, y - s * 0.5, s * 0.14, s * 0.9);
    c.fillStyle = 'rgba(255,255,255,0.7)';
    for (let k = 0; k < 3; k++) {
      const v = ((t * 1.4 + k / 3) % 1);
      c.fillRect(ex - s * 0.05 + k * s * 0.04, y - s * 0.5 + v * s * 0.8, Math.max(1, s * 0.03), s * 0.12);
    }
    foam(ex + (dir === 'e' ? s * 0.12 : -s * 0.12), y, 4, false);
  } else foam(x, y + (dir === 'n' ? s * 0.42 : -s * 0.42), 5, true);
  if (o.style === 'ladder') {
    const lx = dir === 'e' || dir === 'w' ? x : x + s * 0.36;
    const ly0 = dir === 's' ? y - s * 0.95 : y - s * 0.5, ly1 = dir === 's' ? y - s * 0.4 : y + s * 0.1;
    c.strokeStyle = '#2f6e2a';
    c.lineWidth = Math.max(1.5, s * 0.05);
    c.beginPath();
    c.moveTo(lx - s * 0.09, ly0); c.lineTo(lx - s * 0.09, ly1);
    c.moveTo(lx + s * 0.09, ly0); c.lineTo(lx + s * 0.09, ly1);
    for (let k = 0; k < 4; k++) { const yy = ly0 + ((k + 0.5) * (ly1 - ly0)) / 4; c.moveTo(lx - s * 0.09, yy); c.lineTo(lx + s * 0.09, yy); }
    c.stroke();
  }
}

function drawLedge(c: C, dir: string, x: number, y: number, s: number, t: number) {
  const a = dir === 'n' ? -Math.PI / 2 : dir === 'e' ? 0 : dir === 'w' ? Math.PI : Math.PI / 2;
  const k = (t * 1.2) % 1;
  c.save();
  c.translate(x, y);
  c.rotate(a);
  c.lineWidth = Math.max(1.5, s * 0.08);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (let i = 0; i < 2; i++) {
    const off = (i - 0.5) * s * 0.26 + k * s * 0.08;
    c.strokeStyle = `rgba(255,224,138,${0.95 - i * 0.3})`;
    c.beginPath();
    c.moveTo(off - s * 0.1, -s * 0.16);
    c.lineTo(off + s * 0.06, 0);
    c.lineTo(off - s * 0.1, s * 0.16);
    c.stroke();
  }
  c.restore();
}

function drawEntrance(c: C, o: MapObject, style: string, x: number, y: number, s: number, t: number, done: boolean, attach = false) {
  void done; void o;
  const wallStyle = style !== 'beanstalk' && !style.startsWith('stairs');
  const base = attach && wallStyle ? y - s * 0.42 : y + s * 0.42;
  switch (style) {
    case 'cave': {
      c.fillStyle = '#4a4040';
      c.beginPath();
      c.ellipse(x, base - s * 0.2, s * 0.5, s * 0.46, 0, Math.PI, 0);
      c.fill();
      c.fillStyle = '#6c625e';
      for (let i = 0; i < 5; i++) circle(c, x - s * 0.42 + i * s * 0.21, base - s * 0.3 - Math.sin((i / 4) * Math.PI) * s * 0.28, s * 0.12, i % 2 ? '#7a706a' : '#5e5450');
      c.fillStyle = '#050307';
      c.beginPath();
      c.ellipse(x, base, s * 0.32, s * 0.5, 0, Math.PI, 0);
      c.fill();
      break;
    }
    case 'dungeon':
    case 'sanctum':
    case 'shrine': {
      const sanct = style === 'sanctum', shrine = style === 'shrine';
      const stone = shrine ? '#d8c89a' : sanct ? '#b8c0e8' : '#8f8a96';
      shadow(c, x + s * 0.08, base, s * 0.55, s * 0.12);
      c.fillStyle = shade(stone, -0.4);
      arch(c, x, base, s * 0.96, s * 1.05);
      c.fill();
      c.fillStyle = stone;
      arch(c, x, base - s * 0.02, s * 0.88, s * 1.0);
      c.fill();
      if (sanct || shrine) {
        c.save();
        c.globalCompositeOperation = 'lighter';
        const g = c.createRadialGradient(x, base - s * 0.3, 0, x, base - s * 0.3, s * 0.7);
        const col = sanct ? '120,170,255' : '255,210,120';
        g.addColorStop(0, `rgba(${col},${0.45 + 0.15 * Math.sin(t * 2)})`);
        g.addColorStop(1, `rgba(${col},0)`);
        c.fillStyle = g;
        c.fillRect(x - s, base - s * 1.1, s * 2, s * 1.4);
        c.restore();
      }
      c.fillStyle = sanct ? '#1a1f4a' : '#0a070c';
      arch(c, x, base, s * 0.5, s * 0.66);
      c.fill();
      c.fillStyle = shade(stone, 0.3);
      c.fillRect(x - s * 0.44, base - s * 0.62, s * 0.08, s * 0.6);
      if (shrine) {
        c.fillStyle = '#e0a42a';
        c.beginPath();
        c.moveTo(x - s * 0.55, base - s * 0.92);
        c.lineTo(x, base - s * 1.2);
        c.lineTo(x + s * 0.55, base - s * 0.92);
        c.closePath();
        c.fill();
      } else {
        circle(c, x, base - s * 0.82, s * 0.07, sanct ? '#8fd0ff' : '#ff5a5a');
      }
      break;
    }
    case 'stairs-down':
    case 'stairs-up': {
      const up = style === 'stairs-up';
      c.fillStyle = up ? '#cfc6b4' : '#141018';
      c.fillRect(x - s * 0.4, y - s * 0.4, s * 0.8, s * 0.8);
      for (let i = 0; i < 4; i++) {
        const k = up ? 1 - i / 4 : i / 4;
        c.fillStyle = up ? shade('#cfc6b4', -0.12 * i) : `rgba(${150 - k * 120},${140 - k * 115},${130 - k * 100},1)`;
        c.fillRect(x - s * 0.36, y - s * 0.36 + i * s * 0.18, s * 0.72, s * 0.13);
      }
      c.strokeStyle = '#3a3040';
      c.lineWidth = Math.max(1, s * 0.05);
      c.strokeRect(x - s * 0.4, y - s * 0.4, s * 0.8, s * 0.8);
      c.fillStyle = up ? '#ffffff' : '#ffe08a';
      c.beginPath();
      const ay = up ? y - s * 0.58 : y + s * 0.58;
      const d = up ? -1 : 1;
      c.moveTo(x - s * 0.1, ay - d * s * 0.08);
      c.lineTo(x + s * 0.1, ay - d * s * 0.08);
      c.lineTo(x, ay + d * s * 0.05);
      c.closePath();
      c.fill();
      break;
    }
    case 'beanstalk': {
      const sway = Math.sin(t * 1.5) * s * 0.04;
      c.strokeStyle = '#2e7a2a';
      c.lineWidth = Math.max(2, s * 0.14);
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x, base);
      c.bezierCurveTo(x - s * 0.4, base - s * 0.5, x + s * 0.4 + sway, base - s * 0.9, x + sway, base - s * 1.6);
      c.stroke();
      c.strokeStyle = '#5fc14a';
      c.lineWidth = Math.max(1, s * 0.05);
      c.stroke();
      c.lineCap = 'butt';
      for (let i = 0; i < 4; i++) {
        const ly = base - s * (0.3 + i * 0.32);
        const lx = x + (i % 2 ? s * 0.18 : -s * 0.18) + sway * (i / 4);
        c.fillStyle = i % 2 ? '#4fb83f' : '#3a9a30';
        c.beginPath();
        c.ellipse(lx, ly, s * 0.16, s * 0.08, i % 2 ? -0.5 : 0.5, 0, TAU);
        c.fill();
      }
      break;
    }
    default: {
      // house / shop: door set into a facade
      const shop = style === 'shop';
      c.fillStyle = '#3a2412';
      rr(c, x - s * 0.26, base - s * 0.66, s * 0.52, s * 0.66, s * 0.06);
      c.fill();
      c.fillStyle = shop ? '#4a7ab0' : '#8a5424';
      rr(c, x - s * 0.2, base - s * 0.6, s * 0.4, s * 0.6, s * 0.05);
      c.fill();
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(x - s * 0.01, base - s * 0.58, s * 0.02, s * 0.58);
      circle(c, x + s * 0.1, base - s * 0.3, s * 0.035, '#f2c14a');
      if (shop) {
        for (let i = 0; i < 5; i++) {
          c.fillStyle = i % 2 ? '#ffffff' : '#e0453a';
          c.fillRect(x - s * 0.45 + i * s * 0.18, base - s * 0.86, s * 0.18, s * 0.16);
        }
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(x - s * 0.45, base - s * 0.72, s * 0.9, s * 0.04);
      }
      c.fillStyle = '#c9b48a';
      c.fillRect(x - s * 0.3, base - s * 0.02, s * 0.6, s * 0.06);
    }
  }
}

function drawGate(c: C, o: MapObject, x: number, y: number, s: number, t: number, done: boolean) {
  const g = o.gate || 'open';
  if ((g as string) === 'waterfall') { drawWaterfall(c, o, x, y, s, t); return; }
  switch (g) {
    case 'open':
      return;
    case 'bush': {
      if (done) {
        c.fillStyle = '#5a3a1e';
        c.fillRect(x - s * 0.06, y + s * 0.05, s * 0.12, s * 0.12);
        for (let i = 0; i < 4; i++) circle(c, x + (hash2(i, 1) - 0.5) * s * 0.6, y + (hash2(i, 2) - 0.3) * s * 0.4, s * 0.05, '#4fae3a');
        return;
      }
      shadow(c, x + s * 0.06, y + s * 0.3, s * 0.4, s * 0.12);
      circle(c, x, y, s * 0.4, '#1f5a24');
      circle(c, x - s * 0.15, y - s * 0.05, s * 0.25, '#2f8a32');
      circle(c, x + s * 0.15, y - s * 0.02, s * 0.24, '#2a7a2e');
      circle(c, x, y - s * 0.18, s * 0.22, '#3aa23c');
      circle(c, x - s * 0.08, y - s * 0.26, s * 0.08, '#8ae06a');
      circle(c, x + s * 0.18, y + s * 0.1, s * 0.05, '#ff5a7a');
      return;
    }
    case 'boulder': {
      if (done) {
        for (let i = 0; i < 4; i++) circle(c, x + (hash2(i, 3) - 0.5) * s * 0.6, y + (hash2(i, 4) - 0.3) * s * 0.4, s * 0.07, '#8a7a68');
        return;
      }
      shadow(c, x + s * 0.08, y + s * 0.32, s * 0.42, s * 0.12);
      circle(c, x, y, s * 0.42, '#5e5248');
      circle(c, x - s * 0.04, y - s * 0.05, s * 0.36, '#8a7c6c');
      circle(c, x - s * 0.13, y - s * 0.16, s * 0.15, '#b2a592');
      c.strokeStyle = '#4a3f36';
      c.lineWidth = Math.max(1, s * 0.04);
      c.beginPath();
      c.moveTo(x + s * 0.1, y - s * 0.3);
      c.lineTo(x + s * 0.04, y - s * 0.1);
      c.lineTo(x + s * 0.16, y + s * 0.05);
      c.stroke();
      return;
    }
    case 'cracked': {
      if (done) {
        c.fillStyle = '#07050a';
        c.beginPath();
        c.ellipse(x, y + s * 0.1, s * 0.3, s * 0.36, 0, 0, TAU);
        c.fill();
        for (let i = 0; i < 4; i++) circle(c, x + (hash2(i, 5) - 0.5) * s * 0.8, y + s * 0.38, s * 0.06, '#8a8090');
        return;
      }
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(x - s * 0.4, y - s * 0.4, s * 0.8, s * 0.8);
      c.strokeStyle = '#1a1420';
      c.lineWidth = Math.max(1.5, s * 0.06);
      c.beginPath();
      c.moveTo(x - s * 0.05, y - s * 0.4);
      c.lineTo(x + s * 0.05, y - s * 0.15);
      c.lineTo(x - s * 0.12, y + s * 0.05);
      c.lineTo(x + s * 0.06, y + s * 0.38);
      c.moveTo(x + s * 0.05, y - s * 0.15);
      c.lineTo(x + s * 0.3, y - s * 0.05);
      c.moveTo(x - s * 0.12, y + s * 0.05);
      c.lineTo(x - s * 0.32, y + s * 0.15);
      c.stroke();
      c.strokeStyle = 'rgba(255,240,220,0.35)';
      c.lineWidth = Math.max(1, s * 0.02);
      c.stroke();
      return;
    }
    case 'water': {
      const k = (t * 0.6) % 1;
      c.strokeStyle = `rgba(160,230,255,${done ? 0.25 : 0.8})`;
      c.lineWidth = Math.max(1, s * 0.04);
      for (let i = 0; i < 2; i++) {
        const rr2 = s * (0.15 + ((k + i * 0.5) % 1) * 0.3);
        c.globalAlpha *= 1 - ((k + i * 0.5) % 1) * 0.6;
        c.beginPath();
        c.ellipse(x, y, rr2, rr2 * 0.55, 0, 0, TAU);
        c.stroke();
        c.globalAlpha /= 1 - ((k + i * 0.5) % 1) * 0.6;
      }
      c.strokeStyle = '#e8f8ff';
      c.lineWidth = Math.max(1.5, s * 0.06);
      c.beginPath();
      c.moveTo(x - s * 0.2, y);
      c.quadraticCurveTo(x - s * 0.1, y - s * 0.1, x, y);
      c.quadraticCurveTo(x + s * 0.1, y + s * 0.1, x + s * 0.2, y);
      c.stroke();
      return;
    }
    case 'chasm': {
      c.fillStyle = '#05030a';
      c.beginPath();
      c.moveTo(x - s * 0.48, y - s * 0.3);
      c.lineTo(x - s * 0.2, y - s * 0.42);
      c.lineTo(x + s * 0.1, y - s * 0.34);
      c.lineTo(x + s * 0.46, y - s * 0.4);
      c.lineTo(x + s * 0.48, y + s * 0.36);
      c.lineTo(x + s * 0.1, y + s * 0.44);
      c.lineTo(x - s * 0.2, y + s * 0.34);
      c.lineTo(x - s * 0.48, y + s * 0.42);
      c.closePath();
      c.fill();
      c.fillStyle = 'rgba(110,80,160,0.35)';
      c.fillRect(x - s * 0.44, y - s * 0.32, s * 0.88, s * 0.08);
      if (done) {
        c.fillStyle = '#a06a38';
        for (let i = 0; i < 4; i++) c.fillRect(x - s * 0.2, y - s * 0.4 + i * s * 0.21, s * 0.4, s * 0.15);
        c.fillStyle = '#5a3a1c';
        c.fillRect(x - s * 0.24, y - s * 0.42, s * 0.04, s * 0.84);
        c.fillRect(x + s * 0.2, y - s * 0.42, s * 0.04, s * 0.84);
      }
      return;
    }
    case 'dark': {
      c.fillStyle = '#2a2234';
      arch(c, x, y + s * 0.42, s * 0.86, s * 0.95);
      c.fill();
      c.fillStyle = done ? '#3a2a1a' : '#000000';
      arch(c, x, y + s * 0.42, s * 0.6, s * 0.78);
      c.fill();
      if (done) {
        c.save();
        c.globalCompositeOperation = 'lighter';
        const g = c.createRadialGradient(x, y, 0, x, y, s * 0.5);
        g.addColorStop(0, 'rgba(255,180,90,0.6)');
        g.addColorStop(1, 'rgba(255,180,90,0)');
        c.fillStyle = g;
        c.fillRect(x - s * 0.5, y - s * 0.5, s, s);
        c.restore();
      } else {
        circle(c, x - s * 0.1, y + s * 0.02, s * 0.04, '#b07cff');
        circle(c, x + s * 0.1, y + s * 0.02, s * 0.04, '#b07cff');
      }
      return;
    }
    case 'eye': {
      c.fillStyle = '#5a5468';
      rr(c, x - s * 0.32, y - s * 0.32, s * 0.64, s * 0.64, s * 0.08);
      c.fill();
      c.fillStyle = '#7a748a';
      rr(c, x - s * 0.28, y - s * 0.32, s * 0.56, s * 0.52, s * 0.07);
      c.fill();
      if (done) {
        c.strokeStyle = '#3fd07a';
        c.lineWidth = Math.max(1.5, s * 0.06);
        c.beginPath();
        c.moveTo(x - s * 0.18, y - s * 0.06);
        c.quadraticCurveTo(x, y + s * 0.06, x + s * 0.18, y - s * 0.06);
        c.stroke();
      } else {
        c.fillStyle = '#fff6d0';
        c.beginPath();
        c.ellipse(x, y - s * 0.06, s * 0.2, s * 0.12, 0, 0, TAU);
        c.fill();
        const lx = Math.sin(t * 1.3) * s * 0.06;
        circle(c, x + lx, y - s * 0.06, s * 0.08, '#ff9a1a');
        circle(c, x + lx, y - s * 0.06, s * 0.035, '#1a0a00');
      }
      return;
    }
    case 'locked':
    case 'bossdoor': {
      const boss = g === 'bossdoor';
      const w = s * (boss ? 0.92 : 0.72), h = s * (boss ? 0.95 : 0.82);
      const base = y + s * 0.42;
      c.fillStyle = boss ? '#3a1018' : '#2e2218';
      arch(c, x, base, w + s * 0.1, h + s * 0.06);
      c.fill();
      if (done) {
        c.fillStyle = '#0a0608';
        arch(c, x, base, w * 0.8, h * 0.85);
        c.fill();
        return;
      }
      c.fillStyle = boss ? '#9a2030' : '#8a5a2a';
      arch(c, x, base, w, h);
      c.fill();
      c.fillStyle = boss ? '#c8a040' : '#5a3a1a';
      c.fillRect(x - w / 2, base - h * 0.35, w, s * 0.05);
      c.fillRect(x - w / 2, base - h * 0.7, w, s * 0.05);
      if (boss) {
        circle(c, x, base - h * 0.52, s * 0.14, '#efe6d6');
        circle(c, x - s * 0.05, base - h * 0.53, s * 0.035, '#3a1018');
        circle(c, x + s * 0.05, base - h * 0.53, s * 0.035, '#3a1018');
      } else {
        circle(c, x, base - h * 0.5, s * 0.1, '#f2c14a');
        c.fillStyle = '#1a1008';
        circle(c, x, base - h * 0.53, s * 0.035, '#1a1008');
        c.fillRect(x - s * 0.015, base - h * 0.52, s * 0.03, s * 0.07);
      }
      return;
    }
    case 'seal':
    case 'portal': {
      const portal = g === 'portal';
      const col = portal ? GATE_COL.portal : GATE_COL.seal;
      const a = done ? 0.25 : 1;
      c.save();
      c.globalAlpha *= a;
      c.translate(x, y);
      if (portal) {
        for (let i = 0; i < 3; i++) {
          c.strokeStyle = withAlpha(i === 1 ? '#e8c8ff' : col, 0.9 - i * 0.2);
          c.lineWidth = Math.max(1.5, s * (0.08 - i * 0.02));
          c.beginPath();
          c.ellipse(0, 0, s * (0.38 - i * 0.1), s * (0.42 - i * 0.1), 0, t * (1 + i) + i, t * (1 + i) + i + Math.PI * 1.5);
          c.stroke();
        }
        circle(c, 0, 0, s * 0.12, '#1a0630');
      } else {
        c.strokeStyle = col;
        c.lineWidth = Math.max(1.5, s * 0.06);
        c.beginPath();
        c.arc(0, 0, s * 0.38, 0, TAU);
        c.stroke();
        c.rotate(t * 0.6);
        c.beginPath();
        for (let i = 0; i < 6; i++) {
          const an = (i / 6) * TAU;
          c.moveTo(Math.cos(an) * s * 0.3, Math.sin(an) * s * 0.3);
          c.lineTo(Math.cos(an + 2.1) * s * 0.3, Math.sin(an + 2.1) * s * 0.3);
        }
        c.lineWidth = Math.max(1, s * 0.035);
        c.strokeStyle = '#ffd0fa';
        c.stroke();
      }
      c.restore();
      return;
    }
    case 'guard': {
      if (done) {
        c.globalAlpha *= 0.3;
        drawFigure(c, x + s * 0.3, y, s * 0.9, '#c06a2a', t, true);
        c.globalAlpha /= 0.3;
        return;
      }
      drawFigure(c, x, y, s, '#c06a2a', t, true);
      return;
    }
    case 'stairs':
      drawEntrance(c, o, o.style && o.style.startsWith('stairs') ? o.style : 'stairs-down', x, y, s, t, done, false);
      return;
    case 'ledge':
      drawLedge(c, o.dir || 's', x, y, s, t);
      return;
  }
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
