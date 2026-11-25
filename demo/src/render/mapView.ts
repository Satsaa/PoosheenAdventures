// Map renderer: camera, input, per-frame composition of the baked terrain with fog,
// objects, particles, labels, ghost layers and a final colour grade.
import type { World, Dimension, DimId, MapObject, LocId } from '../core/types';
import { D, T } from '../core/types';
import { hashStr } from '../core/rng';
import {
  buildDimRender, buildFogMask, buildGhostFill, buildOutline, footprint, rockPattern, type DimRender,
} from './terrain';
import { drawObject, drawPin, pinRank, pinColor } from './objects';
import { Particles } from './particles';
import { FONT, clamp, ctx2d, hash2, makeCanvas, shade, smoothstep } from './util';

export interface MapState {
  /** logic zones the player can currently reach; tiles whose zone's LocId is not in here are fogged. null = no fog */
  reachable: Set<LocId> | null;
  /** zones that became reachable in the current step: give them a brief highlight pulse */
  fresh: Set<LocId>;
  /** object ids to not draw at all (e.g. NPC stages that are not active) */
  hidden: Set<string>;
  /** object ids drawn in their "done" look: opened chest, removed gate (bush cut, boulder lifted, door open) */
  done: Set<string>;
}
export interface MapViewOptions {
  onPick?: (obj: MapObject | null, tile: { x: number; y: number } | null) => void;
  onHover?: (obj: MapObject | null, tile: { x: number; y: number } | null) => void;
}
export interface MapView {
  setWorld(world: World): void;
  setDimension(id: DimId): void;
  setState(s: MapState): void;
  setGhost(on: boolean): void;
  focus(x: number, y: number, zoom?: number): void;
  fitAll(): void;
  resize(): void;
  destroy(): void;
}

const MAX_ZOOM = 48;
const SPRITE_MIN = 20; // below this px/tile objects become pins
const FRESH_SECS = 1.2;

interface Ghost {
  fill: HTMLCanvasElement | null;
  fillAlpha: number;
  outline: Path2D | null;
}

interface Hit {
  o: MapObject;
  x: number;
  y: number;
  r: number;
}

export function createMapView(canvas: HTMLCanvasElement, opts: MapViewOptions = {}): MapView {
  const ctx = ctx2d(canvas);
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';

  let world: World | null = null;
  let dim: Dimension | null = null;
  let dr: DimRender | null = null;
  const renders = new Map<DimId, DimRender>();
  const ghosts = new Map<DimId, Ghost>();
  let ghostOn = false;
  let state: MapState = { reachable: null, fresh: new Set(), hidden: new Set(), done: new Set() };
  let fogDirty = true;
  let freshT0 = -1;
  let freshPath: Path2D | null = null;
  let sortedObjs: MapObject[] = [];

  let W = 1, Hh = 1, dpr = 1;
  const cam = { x: 0, y: 0, s: 16 };
  let target: { x: number; y: number; s: number } | null = null;
  let minS = 4;

  const particles = new Particles();
  const rm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!rm?.matches;
  const onRm = () => { reduced = !!rm?.matches; if (reduced) particles.clear(); };
  rm?.addEventListener?.('change', onRm);

  let rock: CanvasPattern | null = null;
  let vignette: HTMLCanvasElement | null = null;

  let hover: MapObject | null = null;
  let hoverTile: { x: number; y: number } | null = null;
  let mouse: { x: number; y: number } | null = null;
  let hits: Hit[] = [];

  let raf = 0;
  let running = false;
  let last = 0;
  let t = 0;
  let destroyed = false;

  // ------------------------------------------------------------ geometry
  const worldBounds = () => {
    if (!dim || !dr) return { x0: 0, x1: 1, y0: 0, y1: 1 };
    return { x0: 0, x1: dim.w, y0: dr.y0 + 0.4, y1: Math.min(dr.y1, dim.h + (dr.maxVe - dr.voidElev) * dr.hT * 0.6 + 0.2) };
  };
  const fitScale = () => {
    const b = worldBounds();
    const pad = 24;
    return Math.max(1, Math.min((W - pad * 2) / (b.x1 - b.x0), (Hh - pad * 2) / (b.y1 - b.y0)));
  };
  const maxS = () => Math.max(MAX_ZOOM, minS * 1.5);
  const sx = (wx: number) => (wx - cam.x) * cam.s + W / 2;
  const sy = (wy: number) => (wy - cam.y) * cam.s + Hh / 2;
  const toWorld = (px: number, py: number) => ({ x: (px - W / 2) / cam.s + cam.x, y: (py - Hh / 2) / cam.s + cam.y });

  function clampCam(c: { x: number; y: number; s: number }) {
    const b = worldBounds();
    c.s = clamp(c.s, minS, maxS());
    const hw = W / 2 / c.s, hh = Hh / 2 / c.s;
    const cx0 = b.x0 + hw, cx1 = b.x1 - hw, cy0 = b.y0 + hh, cy1 = b.y1 - hh;
    const m = 40 / c.s;
    c.x = cx0 > cx1 ? (b.x0 + b.x1) / 2 : clamp(c.x, cx0 - m, cx1 + m);
    c.y = cy0 > cy1 ? (b.y0 + b.y1) / 2 : clamp(c.y, cy0 - m, cy1 + m);
  }

  function tileElevY(x: number, y: number): number {
    if (!dim || !dr || x < 0 || y < 0 || x >= dim.w || y >= dim.h) return 0;
    const g = dim.ground[y * dim.w + x];
    return g === T.VOID ? 0 : dr.ve[y * dim.w + x] * dr.hT;
  }

  /** screen -> tile, accounting for elevation (southernmost covering tile wins). */
  function pickTile(px: number, py: number): { x: number; y: number } | null {
    if (!dim || !dr) return null;
    const wpt = toWorld(px, py);
    const tx = Math.floor(wpt.x);
    if (tx < 0 || tx >= dim.w) return null;
    const yHi = Math.min(dim.h - 1, Math.floor(wpt.y - dr.voidElev * dr.hT) + 1);
    const yLo = Math.max(0, Math.floor(wpt.y - dr.maxVe * dr.hT) - 1);
    for (let y = yHi; y >= yLo; y--) {
      const i = y * dim.w + tx;
      if (dim.ground[i] === T.VOID) continue;
      const top = y - dr.ve[i] * dr.hT;
      const bot = top + 1 + dr.faceH[i] * dr.hT;
      if (wpt.y >= top && wpt.y < bot) return { x: tx, y };
    }
    return null;
  }

  function pickObj(px: number, py: number): MapObject | null {
    let best: Hit | null = null, bd = Infinity;
    for (const h of hits) {
      const d = Math.hypot(px - h.x, py - h.y);
      if (d <= h.r && d < bd) { bd = d; best = h; }
    }
    return best ? best.o : null;
  }

  // ------------------------------------------------------------ fog
  function isFoggedZone(z: number): boolean {
    if (!state.reachable || !dim || z < 0) return false;
    const loc = dim.zoneLoc[z];
    return loc !== undefined && !state.reachable.has(loc);
  }
  function objFogged(o: MapObject): boolean {
    if (!state.reachable || !dim || !dr) return false;
    if (o.x < 0 || o.y < 0 || o.x >= dim.w || o.y >= dim.h) return false;
    return isFoggedZone(dr.owner[o.y * dim.w + o.x]);
  }
  function refreshFog() {
    fogDirty = false;
    if (!dr || !dim || !state.reachable) return;
    const owner = dr.owner;
    buildFogMask(dr, (i) => isFoggedZone(owner[i]));
  }
  function buildFresh() {
    freshPath = null;
    if (!dr || !dim || !state.fresh.size || reduced) return;
    const p = new Path2D();
    let any = false;
    for (let i = 0; i < dim.w * dim.h; i++) {
      if (dim.ground[i] === T.VOID) continue;
      const z = dr.owner[i];
      if (z < 0 || !state.fresh.has(dim.zoneLoc[z])) continue;
      const [x, y, w, h] = footprint(dr, i, false);
      p.rect(x, y, w, h);
      any = true;
    }
    if (any) { freshPath = p; freshT0 = t; }
  }

  // ------------------------------------------------------------ ghost
  function ghostFor(d: Dimension): Ghost | null {
    if (!world || d.stack === undefined) return null;
    let g = ghosts.get(d.id);
    if (g) return g;
    const stacked = world.dims.filter((x) => x.stack !== undefined && x.id !== d.id);
    const below = stacked.find((x) => x.stack === d.stack! - 1) || (d.stack! > 0 ? stacked.find((x) => x.stack === 0) : undefined);
    const above = stacked.find((x) => x.stack === d.stack! + 1) || (d.stack! < 0 ? stacked.find((x) => x.stack === 0) : undefined);
    g = { fill: null, fillAlpha: 0.5, outline: null };
    if (below) {
      const sky = d.kind === 'sky';
      g.fill = buildGhostFill(below, sky ? '#4a78d0' : '#6a4ab0', sky ? 0.55 : 0.6);
      g.fillAlpha = sky ? 0.5 : 0.35;
    }
    if (d.stack! < 0 && above) g.outline = buildOutline(above);
    ghosts.set(d.id, g);
    return g;
  }

  // ------------------------------------------------------------ public API
  function setWorld(w: World) {
    world = w;
    renders.clear();
    ghosts.clear();
    particles.clear();
    dim = null;
    dr = null;
    hover = null;
    hits = [];
    const first = w.dims.find((d) => d.kind === 'overworld') || w.dims[0];
    if (first) setDimension(first.id);
  }

  function setDimension(id: DimId) {
    if (!world) return;
    const d = world.dims.find((x) => x.id === id);
    if (!d) return;
    dim = d;
    let r = renders.get(id);
    if (!r) {
      r = buildDimRender(d, hashStr(world.seed + ':' + id));
      renders.set(id, r);
    }
    dr = r;
    sortedObjs = d.objects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    particles.clear();
    hover = null;
    hits = [];
    fogDirty = true;
    freshPath = null;
    minS = fitScale();
    const b = worldBounds();
    cam.x = (b.x0 + b.x1) / 2;
    cam.y = (b.y0 + b.y1) / 2;
    cam.s = minS;
    target = null;
    start();
  }

  function setState(s: MapState) {
    state = {
      reachable: s.reachable,
      fresh: s.fresh || new Set(),
      hidden: s.hidden || new Set(),
      done: s.done || new Set(),
    };
    fogDirty = true;
    buildFresh();
    start();
  }

  function setGhost(on: boolean) {
    ghostOn = on;
    start();
  }

  function focus(x: number, y: number, zoom?: number) {
    if (!dim) return;
    const tt = { x: x + 0.5, y: y + 0.5 - tileElevY(x, y), s: zoom ?? Math.max(cam.s, 32) };
    clampCam(tt);
    if (reduced) { Object.assign(cam, tt); target = null; } else target = tt;
    start();
  }

  function fitAll() {
    const b = worldBounds();
    const tt = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, s: fitScale() };
    if (reduced) { Object.assign(cam, tt); target = null; } else target = tt;
    start();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(rect.width || canvas.clientWidth || 300));
    const nh = Math.max(1, Math.round(rect.height || canvas.clientHeight || 150));
    const nd = Math.min(3, window.devicePixelRatio || 1);
    const wasFit = Math.abs(cam.s - minS) < 1e-3;
    W = nw; Hh = nh; dpr = nd;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(Hh * dpr);
    vignette = null;
    if (dim) {
      minS = fitScale();
      if (wasFit) { const b = worldBounds(); cam.x = (b.x0 + b.x1) / 2; cam.y = (b.y0 + b.y1) / 2; cam.s = minS; }
      clampCam(cam);
    }
    start();
  }

  // ------------------------------------------------------------ input
  const pointers = new Map<number, { x: number; y: number; type: string }>();
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  let pinch: { d: number; s: number; wx: number; wy: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function zoomAt(px: number, py: number, factor: number, animate: boolean) {
    const base = target && animate ? target : cam;
    const wpt = { x: (px - W / 2) / base.s + base.x, y: (py - Hh / 2) / base.s + base.y };
    const ns = clamp(base.s * factor, minS, maxS());
    const tt = { x: wpt.x - (px - W / 2) / ns, y: wpt.y - (py - Hh / 2) / ns, s: ns };
    clampCam(tt);
    if (animate && !reduced) target = tt;
    else { Object.assign(cam, tt); target = null; }
    start();
  }

  function beginPinch() {
    const ps = [...pointers.values()];
    const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) || 1;
    const mx = (ps[0].x + ps[1].x) / 2, my = (ps[0].y + ps[1].y) / 2;
    const wpt = toWorld(mx, my);
    pinch = { d, s: cam.s, wx: wpt.x, wy: wpt.y };
    drag = null;
  }

  function setHover(o: MapObject | null, tile: { x: number; y: number } | null) {
    const changed = o !== hover || (tile?.x !== hoverTile?.x || tile?.y !== hoverTile?.y);
    hover = o;
    hoverTile = tile;
    canvas.style.cursor = drag?.moved ? 'grabbing' : o ? 'pointer' : 'grab';
    if (changed) opts.onHover?.(o, tile);
  }

  function updateHover() {
    if (!mouse || drag?.moved || pinch) return;
    setHover(pickObj(mouse.x, mouse.y), pickTile(mouse.x, mouse.y));
  }

  const onDown = (e: PointerEvent) => {
    const p = local(e);
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { ...p, type: e.pointerType });
    target = null;
    if (pointers.size === 1) drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y, moved: false };
    else if (pointers.size === 2) beginPinch();
  };
  const onMove = (e: PointerEvent) => {
    const p = local(e);
    if (e.pointerType === 'mouse') mouse = p;
    if (!pointers.has(e.pointerId)) { updateHover(); return; }
    pointers.set(e.pointerId, { ...p, type: e.pointerType });
    if (pointers.size >= 2 && pinch) {
      const ps = [...pointers.values()];
      const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) || 1;
      const mx = (ps[0].x + ps[1].x) / 2, my = (ps[0].y + ps[1].y) / 2;
      cam.s = clamp(pinch.s * (d / pinch.d), minS, maxS());
      cam.x = pinch.wx - (mx - W / 2) / cam.s;
      cam.y = pinch.wy - (my - Hh / 2) / cam.s;
      clampCam(cam);
      start();
      return;
    }
    if (drag) {
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; canvas.style.cursor = 'grabbing'; }
      if (drag.moved) {
        cam.x = drag.cx - dx / cam.s;
        cam.y = drag.cy - dy / cam.s;
        clampCam(cam);
        start();
      }
    }
  };
  const onUp = (e: PointerEvent) => {
    const p = local(e);
    const had = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const q = [...pointers.values()][0];
        drag = { x: q.x, y: q.y, cx: cam.x, cy: cam.y, moved: true };
      }
      return;
    }
    if (drag && !drag.moved && had && e.type === 'pointerup') {
      const o = pickObj(p.x, p.y);
      const tile = pickTile(p.x, p.y);
      opts.onPick?.(o, tile);
      if (had.type !== 'mouse') {
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          zoomAt(p.x, p.y, 2, true);
          lastTap.t = 0;
        } else lastTap = { t: now, x: p.x, y: p.y };
      }
    }
    if (pointers.size === 0) drag = null;
    canvas.style.cursor = hover ? 'pointer' : 'grab';
  };
  const onLeave = () => {
    mouse = null;
    if (!drag) setHover(null, null);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const f = Math.exp(-clamp(e.deltaY * unit, -300, 300) * 0.0016);
    zoomAt(p.x, p.y, f, false);
  };
  const onDbl = (e: MouseEvent) => {
    const p = local(e);
    zoomAt(p.x, p.y, 2, true);
  };
  const onVis = () => {
    if (document.hidden) stop();
    else start();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDbl);
  document.addEventListener('visibilitychange', onVis);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  // ------------------------------------------------------------ loop
  function start() {
    if (running || destroyed || (typeof document !== 'undefined' && document.hidden)) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    t += dt;
    if (target) {
      const k = 1 - Math.exp(-dt * 9);
      cam.x += (target.x - cam.x) * k;
      cam.y += (target.y - cam.y) * k;
      cam.s = Math.exp(Math.log(cam.s) + (Math.log(target.s) - Math.log(cam.s)) * k);
      if (Math.abs(target.x - cam.x) * cam.s < 0.3 && Math.abs(target.y - cam.y) * cam.s < 0.3 && Math.abs(target.s - cam.s) < 0.02) {
        Object.assign(cam, target);
        target = null;
      }
    }
    try {
      render(dt);
    } catch (err) {
      console.error(err);
    }
    raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ render
  function bakeTransform(): [number, number, number] {
    // bake px -> css px : screen = b * k + (ox, oy)
    const k = cam.s / dr!.S;
    return [k, W / 2 - cam.x * cam.s, Hh / 2 - cam.y * cam.s - dr!.top * k];
  }

  function drawBackground() {
    const c = ctx;
    if (!dim) { c.fillStyle = '#0b0d14'; c.fillRect(0, 0, W, Hh); return; }
    if (dim.kind === 'sky') {
      const g = c.createLinearGradient(0, 0, 0, Hh);
      g.addColorStop(0, '#071436');
      g.addColorStop(0.55, '#16367a');
      g.addColorStop(1, '#3a6cb8');
      c.fillStyle = g;
      c.fillRect(0, 0, W, Hh);
      return;
    }
    if (dim.kind === 'underworld' || dim.kind === 'interior') {
      if (!rock) rock = c.createPattern(rockPattern(), 'repeat');
      c.save();
      const ox = (-cam.x * cam.s * 0.6) % 160, oy = (-cam.y * cam.s * 0.6) % 160;
      c.translate(ox - 160, oy - 160);
      c.fillStyle = rock || '#0d0b11';
      c.fillRect(0, 0, W + 320, Hh + 320);
      c.restore();
      return;
    }
    const g = c.createRadialGradient(W / 2, Hh / 2, 0, W / 2, Hh / 2, Math.max(W, Hh) * 0.7);
    g.addColorStop(0, '#102a44');
    g.addColorStop(1, '#060d18');
    c.fillStyle = g;
    c.fillRect(0, 0, W, Hh);
  }

  function blit(src: HTMLCanvasElement) {
    const [k, ox, oy] = bakeTransform();
    // visible part of the bake
    let bx0 = Math.max(0, Math.floor(-ox / k)), by0 = Math.max(0, Math.floor(-oy / k));
    let bx1 = Math.min(src.width, Math.ceil((W - ox) / k)), by1 = Math.min(src.height, Math.ceil((Hh - oy) / k));
    if (bx1 <= bx0 || by1 <= by0) return;
    ctx.drawImage(src, bx0, by0, bx1 - bx0, by1 - by0, bx0 * k + ox, by0 * k + oy, (bx1 - bx0) * k, (by1 - by0) * k);
  }

  function visibleTiles() {
    const a = toWorld(0, 0), b = toWorld(W, Hh);
    const d = dim!;
    return {
      x0: Math.max(0, Math.floor(a.x) - 1),
      x1: Math.min(d.w - 1, Math.ceil(b.x) + 1),
      y0: Math.max(0, Math.floor(a.y + dr!.voidElev * dr!.hT) - 1),
      y1: Math.min(d.h - 1, Math.ceil(b.y + dr!.maxVe * dr!.hT) + 2),
      wx0: a.x, wy0: a.y, wx1: b.x, wy1: b.y,
    };
  }

  function drawShimmer(v: ReturnType<typeof visibleTiles>) {
    const d = dim!, r = dr!;
    const s = cam.s;
    if (s < 7 || reduced) return;
    const water = new Path2D(), lava = new Path2D(), cloud = new Path2D();
    let nw = 0, nl = 0, nc = 0;
    for (let y = v.y0; y <= v.y1; y++) {
      for (let x = v.x0; x <= v.x1; x++) {
        const i = y * d.w + x;
        const g = d.ground[i];
        if (g !== T.WATER && g !== T.DEEP && g !== T.LAVA && g !== T.CLOUD) continue;
        if (y + 1 < d.h && r.ve[i + d.w] > r.ve[i] + 0.01) continue; // hidden behind a cliff
        const h = hash2(x, y, 77);
        const px = sx(x), py = sy(y - r.ve[i] * r.hT);
        if (g === T.WATER || g === T.DEEP) {
          const ph = t * 0.45 + h * 9;
          const k = Math.sin(ph * 2.1);
          if (k < 0.2) continue;
          const fx = px + s * (0.15 + 0.5 * ((h * 7.3 + t * 0.08) % 1)), fy = py + s * (0.25 + 0.5 * ((h * 3.1) % 1));
          water.moveTo(fx, fy);
          water.quadraticCurveTo(fx + s * 0.1, fy - s * 0.06 * k, fx + s * 0.22, fy);
          nw++;
        } else if (g === T.LAVA) {
          const k = Math.sin(t * 1.3 + h * 12);
          if (k < 0.2) continue;
          const bx = px + s * (0.25 + 0.5 * ((h * 5.7) % 1)), by = py + s * (0.25 + 0.5 * ((h * 9.1) % 1));
          lava.moveTo(bx + s * 0.3 * k, by);
          lava.arc(bx, by, s * 0.3 * k, 0, Math.PI * 2);
          nl++;
        } else {
          if (Math.sin(t * 0.6 + x * 0.35 + y * 0.22) < 0.55) continue;
          cloud.moveTo(px + s * 0.8, py + s * 0.5);
          cloud.arc(px + s * 0.5, py + s * 0.5, s * 0.3, 0, Math.PI * 2);
          nc++;
        }
      }
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (nw) {
      ctx.strokeStyle = 'rgba(170,225,255,0.55)';
      ctx.lineWidth = Math.max(1, s * 0.045);
      ctx.lineCap = 'round';
      ctx.stroke(water);
    }
    if (nl) {
      ctx.fillStyle = 'rgba(255,170,60,0.22)';
      ctx.fill(lava);
    }
    if (nc) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fill(cloud);
    }
    ctx.restore();
  }

  function glowAt(x: number, y: number, r: number, rgb: string, a: number) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.4, `rgba(${rgb},${a * 0.4})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /** door-like objects with a house or a cliff right behind them are drawn into that wall */
  function attachUp(o: MapObject): boolean {
    if (!dim || !dr || o.y <= 0) return false;
    const i = o.y * dim.w + o.x, j = i - dim.w;
    return dim.deco[j] === D.HOUSE || (dim.ground[j] !== T.VOID && dr.ve[j] > dr.ve[i] + 0.3);
  }

  function objScreen(o: MapObject): [number, number] {
    return [sx(o.x + 0.5), sy(o.y + 0.5 - tileElevY(o.x, o.y))];
  }

  function drawObjects(v: ReturnType<typeof visibleTiles>, dt: number) {
    const s = cam.s;
    const sprites = s >= SPRITE_MIN;
    hits = [];
    const vis: { o: MapObject; x: number; y: number; fog: boolean; done: boolean }[] = [];
    for (const o of sortedObjs) {
      if (state.hidden.has(o.id)) continue;
      if (o.kind === 'gate' && o.gate === 'open') continue;
      const [x, y] = objScreen(o);
      const m = Math.max(60, s * 2);
      if (x < -m || y < -m || x > W + m || y > Hh + m) continue;
      vis.push({ o, x, y, fog: objFogged(o), done: state.done.has(o.id) });
    }
    // lights / halos (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const v2 of vis) {
      const { o, x, y, done, fog } = v2;
      const k = fog ? 0.4 : 1;
      if (o.kind === 'start') glowAt(x, y, Math.max(40, s * 3), '255,240,190', (0.35 + (reduced ? 0 : 0.06 * Math.sin(t * 2))) * k);
      else if (o.kind === 'gate' && (o.gate === 'seal' || o.gate === 'portal') && !done)
        glowAt(x, y, Math.max(22, s * 1.6), o.gate === 'seal' ? '255,80,230' : '170,90,255', (0.45 + (reduced ? 0 : 0.15 * Math.sin(t * 3))) * k);
      else if (o.kind === 'chest' && !done) glowAt(x, y, Math.max(14, s * 0.9), '255,200,80', 0.22 * k);
    }
    ctx.restore();
    // emit object particles
    if (!reduced) {
      for (const { o, done, fog } of vis) {
        if (fog) continue;
        const wx = o.x + 0.5, wy = o.y + 0.5 - tileElevY(o.x, o.y);
        if (o.kind === 'chest' && !done && Math.random() < dt * 2.2)
          particles.add('sparkle', wx + (Math.random() - 0.5) * 0.7, wy - 0.2 - Math.random() * 0.4, { max: 0.8, size: 5, col: 'rgb(255,220,120)' });
        else if (o.kind === 'gate' && (o.gate === 'seal' || o.gate === 'portal') && !done && Math.random() < dt * 5) {
          const a = Math.random() * 6.283;
          particles.add('mote', wx + Math.cos(a) * 0.45, wy + Math.sin(a) * 0.45, { vx: -Math.cos(a) * 0.3, vy: -Math.sin(a) * 0.3 - 0.2, max: 1.2, size: 4, col: o.gate === 'seal' ? 'rgb(255,110,240)' : 'rgb(190,120,255)' });
        } else if (o.kind === 'start' && Math.random() < dt * 2)
          particles.add('mote', wx + (Math.random() - 0.5) * 0.8, wy, { vy: -0.5, max: 1.6, size: 4, col: 'rgb(160,255,200)' });
      }
    }
    for (const { o, x, y, fog, done } of vis) {
      ctx.globalAlpha = fog ? 0.55 : 1;
      if (sprites) {
        drawObject(ctx, o, x, y, s, { done, t: reduced ? 0 : t, attach: attachUp(o) });
        hits.push({ o, x, y: y - s * 0.1, r: s * 0.55 });
      } else {
        const rank = pinRank(o);
        if (rank === 0 && s < 9) continue;
        const r = rank === 2 ? 8 : rank === 1 ? 6.5 : 3.5;
        drawPin(ctx, o, x, y, r, done);
        hits.push({ o, x, y: rank === 0 ? y : y - r * 1.55, r: Math.max(r + 3, 8) });
      }
    }
    ctx.globalAlpha = 1;
    if (hover && !state.hidden.has(hover.id)) {
      const h = hits.find((q) => q.o === hover);
      if (h) {
        const pulse = reduced ? 0 : Math.sin(t * 5) * 1.5;
        ctx.strokeStyle = 'rgba(10,8,20,0.7)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r + 2 + pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#fff6d8';
        ctx.lineWidth = 2;
        ctx.stroke();
        drawTooltip(hover, h.x, h.y - h.r - 8);
      }
    }
  }

  function drawTooltip(o: MapObject, x: number, y: number) {
    const label = o.label || o.kind;
    const sub = o.kind === 'gate' ? `${o.gate}${state.done.has(o.id) ? ' · cleared' : ''}` : o.kind === 'entrance' ? o.style || 'entrance' : o.kind === 'chest' && state.done.has(o.id) ? 'opened' : o.kind;
    ctx.font = `600 12px ${FONT}`;
    const w1 = ctx.measureText(label).width;
    ctx.font = `500 10px ${FONT}`;
    const w2 = ctx.measureText(sub).width;
    const w = Math.max(w1, w2) + 18, h = 34;
    let bx = clamp(x - w / 2, 6, W - w - 6), by = y - h;
    if (by < 6) by = y + 40;
    ctx.fillStyle = 'rgba(14,12,24,0.9)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, w, h, 7) : ctx.rect(bx, by, w, h);
    ctx.fill();
    ctx.strokeStyle = pinColor(o);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(label, bx + 9, by + 15);
    ctx.fillStyle = 'rgba(220,210,255,0.7)';
    ctx.font = `500 10px ${FONT}`;
    ctx.fillText(sub, bx + 9, by + 28);
  }

  function drawLabels() {
    if (!dim || !dr) return;
    const a = 1 - smoothstep(16, 30, cam.s);
    if (a <= 0.01) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.round(clamp(cam.s * 0.95, 11, 15));
    ctx.font = `700 ${fs}px ${FONT}`;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = '1.5px';
    ctx.lineJoin = 'round';
    for (const r of dim.regions) {
      const x = sx(r.x + 0.5), y = sy(r.y + 0.5 - tileElevY(r.x, r.y));
      if (x < -200 || x > W + 200 || y < -50 || y > Hh + 50) continue;
      const txt = r.name.toUpperCase();
      ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(8,6,18,0.75)';
      ctx.lineWidth = 4;
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = shade(r.color || '#ffffff', 0.65);
      ctx.fillText(txt, x, y);
      const tw = ctx.measureText(txt).width;
      ctx.fillStyle = shade(r.color || '#ffffff', 0.2, 0.9);
      ctx.fillRect(x - tw * 0.25, y + fs * 0.75, tw * 0.5, 1.5);
    }
    ctx.restore();
  }

  function drawGrade() {
    if (!vignette || vignette.width !== canvas.width || vignette.height !== canvas.height) {
      vignette = makeCanvas(canvas.width, canvas.height);
      const c = ctx2d(vignette);
      const w = vignette.width, h = vignette.height;
      const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.58);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(4,2,12,0.55)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const kind = dim?.kind;
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = kind === 'underworld' ? 'rgba(120,60,200,0.35)' : kind === 'sky' ? 'rgba(120,170,255,0.3)' : kind === 'interior' ? 'rgba(255,170,90,0.3)' : 'rgba(255,190,120,0.28)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(vignette, 0, 0);
    ctx.restore();
  }

  function render(dt: number) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    drawBackground();
    if (!dim || !dr) return;
    if (fogDirty) refreshFog();
    const ghost = ghostOn ? ghostFor(dim) : null;

    // ghost of the layer below, seen through VOID
    if (ghost?.fill) {
      ctx.save();
      ctx.globalAlpha = ghost.fillAlpha;
      ctx.drawImage(ghost.fill, sx(0), sy(0), dim.w * cam.s, dim.h * cam.s);
      ctx.restore();
      if (dim.kind === 'sky') {
        ctx.fillStyle = 'rgba(30,70,150,0.25)';
        ctx.fillRect(0, 0, W, Hh);
      }
    }

    blit(dr.canvas);
    if (state.reachable && dr.fogMasked) blit(dr.fogMasked);

    const v = visibleTiles();
    drawShimmer(v);

    // fresh-zone pulse
    if (freshPath && !reduced) {
      const u = (t - freshT0) / FRESH_SECS;
      if (u >= 1) freshPath = null;
      else {
        const [k, ox, oy] = bakeTransform();
        ctx.save();
        ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,180,80,${0.42 * Math.sin(Math.PI * Math.min(1, u * 1.4)) * (1 - u * 0.5)})`;
        ctx.fill(freshPath);
        ctx.restore();
      }
    }

    if (ghost?.outline) {
      ctx.save();
      ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * (W / 2 - cam.x * cam.s), dpr * (Hh / 2 - cam.y * cam.s));
      ctx.lineWidth = 1.6 / cam.s;
      ctx.setLineDash([5 / cam.s, 4 / cam.s]);
      ctx.strokeStyle = 'rgba(150,215,255,0.5)';
      ctx.stroke(ghost.outline);
      ctx.restore();
    }

    if (!reduced) {
      particles.emit(dr, v.wx0, v.wy0, v.wx1, v.wy1, dt);
      particles.update(dt, t);
    }
    drawObjects(v, dt);
    if (!reduced) particles.draw(ctx, W / 2 - cam.x * cam.s, Hh / 2 - cam.y * cam.s, cam.s, t);
    drawLabels();
    drawGrade();
    if (mouse && !drag?.moved && !target) updateHover();
  }

  function destroy() {
    destroyed = true;
    stop();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDbl);
    document.removeEventListener('visibilitychange', onVis);
    rm?.removeEventListener?.('change', onRm);
    ro?.disconnect();
    renders.clear();
    ghosts.clear();
    particles.clear();
  }

  resize();
  return { setWorld, setDimension, setState, setGhost, focus, fitAll, resize, destroy };
}
