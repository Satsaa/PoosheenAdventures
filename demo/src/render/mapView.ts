// Map renderer: camera, input, per-frame composition of the baked terrain with fog,
// objects, particles, labels, ghost layers and a final colour grade.
import type { World, Dimension, DimId, MapObject, LocId } from '../core/types';
import { D, T } from '../core/types';
import { hashStr } from '../core/rng';
import {
  buildDimRender, buildGhostFill, buildOutline, footprint, rockPattern, type DimRender,
} from './terrain';
import { drawObject, drawPin, pinRank, pinColor } from './objects';
import { Particles } from './particles';
import { FlatChunks, type FChunk, type FlatOverview, buildFlatOverview, flatOverviewFog } from './flatChunks';
import { LitRenderer, type ObjDraw } from './lit/renderer';
import { type Layout, layout } from './lit/compose';
import { objectLights } from './lit/lights';
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
  /** 'lit' = WebGL2 normal-mapped pipeline, 'flat' = the existing Canvas 2D renderer */
  setRenderer(mode: 'lit' | 'flat'): void;
  readonly renderer: 'lit' | 'flat';
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
  /** per zone: 1 = fogged under the current state */
  let zoneFog: Uint8Array | null = null;
  let fogKey = 0;
  const flat = new FlatChunks();
  const flatOv = new Map<DimId, FlatOverview>();
  let regionSize: Int32Array | null = null;
  let freshT0 = -1;
  let freshPath: Path2D | null = null;
  let sortedObjs: MapObject[] = [];

  // lit (WebGL2) pipeline: draws into its own canvas inserted beneath `canvas`, which becomes the 2D overlay
  let wantMode: 'lit' | 'flat' = 'lit';
  let mode: 'lit' | 'flat' = 'flat';
  let lit: LitRenderer | null = null;
  let litFailed = false;
  let glCanvas: HTMLCanvasElement | null = null;
  let litLay: Layout | null = null;
  let maskDirty = true;

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
  // Tile lift (how far a tile is drawn shifted up, in tiles) depends on the active renderer:
  // flat uses its bake's elevation step, lit rounds each level to whole 16 px-per-tile pixels.
  const litOn = () => mode === 'lit' && !!lit && !lit.lost && !!litLay;
  const liftT = (i: number) => (litOn() ? litLay!.liftPx[i] / 16 : dr!.ve[i] * dr!.hT);
  const voidLiftT = () => (litOn() ? litLay!.voidLiftPx / 16 : dr!.voidElev * dr!.hT);
  const maxLiftT = () => (litOn() ? litLay!.maxLiftPx / 16 : dr!.maxVe * dr!.hT);
  function faceT(i: number): number {
    if (!litOn()) return dr!.faceH[i] * dr!.hT;
    const w = dim!.w;
    const below = i + w < dim!.w * dim!.h ? litLay!.liftPx[i + w] : litLay!.voidLiftPx;
    return Math.max(0, (litLay!.liftPx[i] - below) / 16);
  }
  const worldBounds = () => {
    if (!dim || !dr) return { x0: 0, x1: 1, y0: 0, y1: 1 };
    const y0 = litOn() ? -litLay!.top / 16 + 0.4 : dr.y0 + 0.4;
    return { x0: 0, x1: dim.w, y0, y1: dim.h + (maxLiftT() - voidLiftT()) * 0.6 + 0.2 };
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
    return g === T.VOID ? 0 : liftT(y * dim.w + x);
  }

  /** screen -> tile, accounting for elevation (southernmost covering tile wins). */
  function pickTile(px: number, py: number): { x: number; y: number } | null {
    if (!dim || !dr) return null;
    const wpt = toWorld(px, py);
    const tx = Math.floor(wpt.x);
    if (tx < 0 || tx >= dim.w) return null;
    const yHi = Math.min(dim.h - 1, Math.floor(wpt.y - voidLiftT()) + 1);
    const yLo = Math.max(0, Math.floor(wpt.y - maxLiftT()) - 1);
    for (let y = yHi; y >= yLo; y--) {
      const i = y * dim.w + tx;
      if (dim.ground[i] === T.VOID) continue;
      const top = y - liftT(i);
      const bot = top + 1 + faceT(i);
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
    if (fogDirty) refreshFog();
    return !!zoneFog && zoneFog[z] === 1;
  }
  function objFogged(o: MapObject): boolean {
    if (!state.reachable || !dim || !dr) return false;
    if (o.x < 0 || o.y < 0 || o.x >= dim.w || o.y >= dim.h) return false;
    return isFoggedZone(dr.owner[o.y * dim.w + o.x]);
  }
  /** per-zone fog flags; tiles look up their owner zone (O(zones) per state change) */
  function refreshFog() {
    fogDirty = false;
    fogKey++;
    if (!dim || !state.reachable) { zoneFog = null; return; }
    const zl = dim.zoneLoc;
    zoneFog = new Uint8Array(zl.length);
    for (let z = 0; z < zl.length; z++) zoneFog[z] = state.reachable.has(zl[z]) ? 0 : 1;
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
    const prev = dim ? { id: dim.id, w: dim.w, h: dim.h } : null;
    world = w;
    renders.clear();
    ghosts.clear();
    particles.clear();
    lit?.setWorld(w, hashStr(w.seed));
    flat.clear();
    flatOv.clear();
    dim = null;
    dr = null;
    hover = null;
    hits = [];
    const same = prev && w.dims.find((d) => d.id === prev.id && d.w === prev.w && d.h === prev.h);
    const first = same || w.dims.find((d) => d.kind === 'overworld') || w.dims[0];
    if (first) showDim(first, !!same);
  }

  function getDr(d: Dimension): DimRender {
    let r = renders.get(d.id);
    if (!r) {
      r = buildDimRender(d, hashStr(world!.seed + ':' + d.id));
      renders.set(d.id, r);
    }
    return r;
  }

  function setDimension(id: DimId) {
    if (!world) return;
    const d = world.dims.find((x) => x.id === id);
    if (!d) return;
    if (d === dim) { start(); return; }
    showDim(d, false);
  }

  function showDim(d: Dimension, keepCam: boolean) {
    dim = d;
    dr = getDr(d);
    litLay = layout(d, dr.ve, dr.voidElev);
    sortedObjs = d.objects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    regionSize = new Int32Array(d.regions.length);
    for (let i = 0; i < d.w * d.h; i++) { const r = d.region[i]; if (r >= 0 && r < regionSize.length) regionSize[r]++; }
    particles.clear();
    hover = null;
    hits = [];
    fogDirty = true;
    maskDirty = true;
    freshPath = null;
    minS = fitScale();
    if (keepCam) clampCam(cam);
    else {
      const b = worldBounds();
      cam.x = (b.x0 + b.x1) / 2;
      cam.y = (b.y0 + b.y1) / 2;
      cam.s = minS;
      target = null;
    }
    start();
  }

  // ------------------------------------------------------------ renderer selection
  function initLit(): boolean {
    if (lit) return !lit.lost;
    if (litFailed || !canvas.parentNode || typeof document === 'undefined') return false;
    const gc = document.createElement('canvas');
    gc.setAttribute('aria-hidden', 'true');
    gc.style.position = 'absolute';
    gc.style.pointerEvents = 'none';
    canvas.parentNode.insertBefore(gc, canvas);
    const r = LitRenderer.create(gc);
    if (!r) { gc.remove(); litFailed = true; return false; }
    lit = r;
    glCanvas = gc;
    r.onLost = () => { applyMode(); start(); };
    r.onRestored = () => { maskDirty = true; applyMode(); start(); };
    if (world) r.setWorld(world, hashStr(world.seed));
    syncGlCanvas();
    return true;
  }

  function syncGlCanvas() {
    if (!glCanvas) return;
    glCanvas.style.left = canvas.offsetLeft + 'px';
    glCanvas.style.top = canvas.offsetTop + 'px';
    glCanvas.style.width = canvas.offsetWidth + 'px';
    glCanvas.style.height = canvas.offsetHeight + 'px';
  }

  function applyMode() {
    const ok = wantMode === 'lit' && initLit() && !!lit && !lit.lost;
    mode = ok ? 'lit' : 'flat';
    if (glCanvas) glCanvas.style.display = mode === 'lit' ? '' : 'none';
    maskDirty = true;
    fogDirty = true;
    if (dim && dr) {
      litLay = layout(dim, dr.ve, dr.voidElev);
      const wasFit = Math.abs(cam.s - minS) < 1e-3;
      minS = fitScale();
      if (wasFit) cam.s = minS;
      clampCam(cam);
      if (mode === 'flat' && state.fresh.size) buildFresh();
    }
    start();
  }

  function setRenderer(m: 'lit' | 'flat') {
    wantMode = m;
    applyMode();
  }

  function setState(s: MapState) {
    state = {
      reachable: s.reachable,
      fresh: s.fresh || new Set(),
      hidden: s.hidden || new Set(),
      done: s.done || new Set(),
    };
    fogDirty = true;
    maskDirty = true;
    if (state.fresh.size) freshT0 = t;
    if (!litOn()) buildFresh();
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
    syncGlCanvas();
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

  /** flat terrain: low-res overview below, lazily painted 32x32-tile chunks over it */
  function drawFlatTerrain() {
    const r = dr!, d = dim!;
    const [k, ox, oy] = bakeTransform();
    const CP = flat.cpx(r);
    const s = cam.s;
    let fade = s <= 12 ? 0 : s >= 16 ? 1 : (s - 12) / 4;
    const bx0 = -ox / k, bx1 = (W - ox) / k, by0 = -oy / k, by1 = (Hh - oy) / k;
    const cx0 = Math.max(0, Math.floor(bx0 / CP)), cx1 = Math.min(flat.cols(r) - 1, Math.floor(bx1 / CP));
    const cy0 = Math.max(0, Math.floor(by0 / CP)), cy1 = Math.min(flat.rows(r) - 1, Math.floor(by1 / CP));
    const nVis = Math.max(0, cx1 - cx0 + 1) * Math.max(0, cy1 - cy0 + 1);
    if (nVis > 30) fade = 0;
    const vis: FChunk[] = [];
    let missing: [number, number, number][] = [];
    if (fade > 0) {
      const now = performance.now();
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const ch = flat.get(r, cx, cy);
          if (ch) { ch.lastUse = now; vis.push(ch); }
          else missing.push([cx, cy, Math.hypot((cx + 0.5) * CP - (bx0 + bx1) / 2, (cy + 0.5) * CP - (by0 + by1) / 2)]);
        }
      missing.sort((a, b) => a[2] - b[2]);
      const budget = vis.length === 0 && missing.length <= 6 ? missing.length : 1;
      flat.evict(new Set(vis), Math.max(flat.budget - budget, vis.length));
      for (const [cx, cy] of missing.slice(0, budget)) vis.push(flat.compose(r, cx, cy));
      missing = missing.slice(budget);
    }
    const fogOn = !!state.reachable;
    const fogged = (i: number) => isFoggedZone(r.owner[i]);
    if (fade < 1 || missing.length) {
      let fo = flatOv.get(d.id);
      if (!fo) flatOv.set(d.id, (fo = buildFlatOverview(r)));
      const img = fogOn ? flatOverviewFog(fo, fogKey, fogged) : fo.canvas;
      const sc = (k * r.S) / fo.ov.opx;
      ctx.drawImage(img, ox, oy, fo.ov.w * sc, fo.ov.h * sc);
    }
    if (!vis.length) return;
    ctx.globalAlpha = fade;
    let viewBudget = 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    for (const ch of vis) {
      let img = ch.base;
      if (fogOn) {
        if (ch.viewKey === fogKey || viewBudget-- > 0) img = flat.fogView(r, ch, fogKey, fogged);
        else if (ch.view) img = ch.view;
      }
      const x0 = snap(ox + ch.cx * CP * k), y0 = snap(oy + ch.cy * CP * k);
      const x1 = snap(ox + (ch.cx + 1) * CP * k), y1 = snap(oy + (ch.cy + 1) * CP * k);
      ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;
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
      y0: Math.max(0, Math.floor(a.y + voidLiftT()) - 1),
      y1: Math.min(d.h - 1, Math.ceil(b.y + maxLiftT()) + 2),
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
    return dim.deco[j] === D.HOUSE || (dim.ground[j] !== T.VOID && liftT(j) > liftT(i) + 0.12);
  }

  function objScreen(o: MapObject): [number, number] {
    return [sx(o.x + 0.5), sy(o.y + 0.5 - tileElevY(o.x, o.y))];
  }

  function drawObjects(v: ReturnType<typeof visibleTiles>, dt: number, litMode = false) {
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
    // lights / halos (additive; the lit pipeline has real lights instead)
    if (!litMode) ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const v2 of litMode ? [] : vis) {
      const { o, x, y, done, fog } = v2;
      const k = fog ? 0.4 : 1;
      if (o.kind === 'start') glowAt(x, y, Math.max(40, s * 3), '255,240,190', (0.35 + (reduced ? 0 : 0.06 * Math.sin(t * 2))) * k);
      else if (o.kind === 'gate' && (o.gate === 'seal' || o.gate === 'portal') && !done)
        glowAt(x, y, Math.max(22, s * 1.6), o.gate === 'seal' ? '255,80,230' : '170,90,255', (0.45 + (reduced ? 0 : 0.15 * Math.sin(t * 3))) * k);
      else if (o.kind === 'chest' && !done) glowAt(x, y, Math.max(14, s * 0.9), '255,200,80', 0.22 * k);
    }
    if (!litMode) ctx.restore();
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
    // zoomed out: thin pins by importance and declutter in screen space (huge worlds have thousands)
    const pinSel = new Set<MapObject>();
    if (!sprites) {
      const minPri = s < 3 ? 4 : s < 6 ? 3 : s < 10 ? 2 : s < 16 ? 1 : 0;
      const cand = vis.filter((q) => pinPriority(q.o) >= minPri).sort((a, b) => pinPriority(b.o) - pinPriority(a.o));
      const occ = new Set<number>();
      const cell = 15;
      for (const q of cand) {
        const key = Math.floor(q.x / cell) * 100003 + Math.floor(q.y / cell);
        if (occ.has(key)) continue;
        occ.add(key);
        pinSel.add(q.o);
      }
    }
    for (const { o, x, y, fog, done } of vis) {
      ctx.globalAlpha = fog ? 0.55 : 1;
      if (sprites) {
        if (!litMode) drawObject(ctx, o, x, y, s, { done, t: reduced ? 0 : t, attach: attachUp(o) });
        else if (o.kind === 'npc' && o.icon && s >= 22) drawBubble(o.icon, x, y - s * 1.15, s);
        hits.push({ o, x, y: y - s * 0.1, r: s * 0.55 });
      } else {
        if (!pinSel.has(o)) continue;
        const rank = pinRank(o);
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

  function drawBubble(icon: string, x: number, y: number, s: number) {
    const r = clamp(s * 0.2, 7, 12);
    ctx.fillStyle = 'rgba(255,250,235,0.95)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x - r * 0.35, y + r * 0.8);
    ctx.lineTo(x, y + r * 1.45);
    ctx.lineTo(x + r * 0.35, y + r * 0.8);
    ctx.fill();
    ctx.fillStyle = '#1c1626';
    ctx.font = `700 ${Math.round(r * 1.2)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, x, y + 0.5);
  }

  function pinPriority(o: MapObject): number {
    switch (o.kind) {
      case 'start': return 5;
      case 'boss': return 4;
      case 'entrance':
      case 'stairs': return /dungeon|sanctum|shrine|beanstalk|stairs/.test(o.style || 'stairs') ? 4 : 3;
      case 'npc': return 2;
      case 'gate': return o.gate === 'ledge' || o.gate === 'open' ? 0 : 2;
      case 'chest': return 1;
      default: return 0;
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
    // biggest regions first; small regions fade out first; no overlapping labels
    const order = dim.regions.map((r, i) => [r, regionSize?.[i] ?? 0] as const).sort((p, q) => q[1] - p[1]);
    const placed: [number, number, number, number][] = [];
    for (const [r, size] of order) {
      const x = sx(r.x + 0.5), y = sy(r.y + 0.5 - tileElevY(r.x, r.y));
      if (x < -200 || x > W + 200 || y < -50 || y > Hh + 50) continue;
      const sa = size ? smoothstep(6000, 16000, size * cam.s * cam.s) : 1;
      if (sa <= 0.02) continue;
      const txt = r.name.toUpperCase();
      const tw0 = ctx.measureText(txt).width;
      const rc: [number, number, number, number] = [x - tw0 / 2 - 4, y - fs, x + tw0 / 2 + 4, y + fs];
      if (placed.some((p) => p[0] < rc[2] && rc[0] < p[2] && p[1] < rc[3] && rc[1] < p[3])) continue;
      placed.push(rc);
      ctx.globalAlpha = a * sa;
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

  function ghostDimFor(d: Dimension): Dimension | null {
    if (!world || d.stack === undefined) return null;
    const stacked = world.dims.filter((x) => x.stack !== undefined && x.id !== d.id);
    return stacked.find((x) => x.stack === d.stack! - 1) || (d.stack! > 0 ? stacked.find((x) => x.stack === 0) || null : null);
  }

  function renderLit(dt: number): boolean {
    if (!lit || !dim || !dr) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const d = dim, r = dr;
    const v = visibleTiles();
    if (!reduced) {
      particles.emit(r, v.wx0, v.wy0, v.wx1, v.wy1, dt);
      particles.update(dt, t);
    }
    if (maskDirty) {
      maskDirty = false;
      const fresh = state.fresh;
      lit.setMask(d, r,
        (i) => !!state.reachable && isFoggedZone(r.owner[i]),
        (i) => fresh.size > 0 && r.owner[i] >= 0 && fresh.has(d.zoneLoc[r.owner[i]]));
    }
    const objs: ObjDraw[] = [];
    const lz: { o: MapObject; done: boolean; z: number }[] = [];
    const mx = 4 * cam.s + 60;
    for (const o of sortedObjs) {
      if (state.hidden.has(o.id)) continue;
      const [ox2, oy2] = objScreen(o);
      if (ox2 < -mx || oy2 < -mx || ox2 > W + mx || oy2 > Hh + mx * 1.5) continue;
      if (o.kind === 'gate' && o.gate === 'open') continue;
      const done = state.done.has(o.id);
      objs.push({ o, done, attach: attachUp(o) });
      lz.push({ o, done, z: o.x >= 0 && o.y >= 0 && o.x < d.w && o.y < d.h ? liftT(o.y * d.w + o.x) : 0 });
    }
    let fresh = 0;
    if (!reduced && freshT0 >= 0) {
      const u = (t - freshT0) / FRESH_SECS;
      if (u < 1) fresh = Math.sin(Math.PI * Math.min(1, u * 1.4)) * (1 - u * 0.5);
    }
    const gd = ghostOn ? ghostDimFor(d) : null;
    lit.render({
      dim: d, meta: r, cam, cssW: W, cssH: Hh, dpr, t, motion: !reduced,
      ghost: gd ? { dim: gd, meta: getDr(gd) } : null,
      objs, lights: objectLights(lz), particles: reduced ? null : particles, fresh,
    });
    const ghost = ghostOn ? ghostFor(d) : null;
    if (ghost?.outline) {
      ctx.save();
      ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * (W / 2 - cam.x * cam.s), dpr * (Hh / 2 - cam.y * cam.s));
      ctx.lineWidth = 1.6 / cam.s;
      ctx.setLineDash([5 / cam.s, 4 / cam.s]);
      ctx.strokeStyle = 'rgba(150,215,255,0.5)';
      ctx.stroke(ghost.outline);
      ctx.restore();
    }
    drawObjects(v, dt, true);
    drawLabels();
    if (mouse && !drag?.moved && !target) updateHover();
    return true;
  }

  function render(dt: number) {
    if (litOn()) {
      try {
        if (renderLit(dt)) return;
      } catch (err) {
        console.error('lit renderer failed, falling back to flat:', err);
        litFailed = true;
        lit?.destroy();
        glCanvas?.remove();
        lit = null;
        glCanvas = null;
        applyMode();
      }
    }
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

    drawFlatTerrain();

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
    lit?.destroy();
    glCanvas?.remove();
    lit = null;
    glCanvas = null;
    renders.clear();
    ghosts.clear();
    particles.clear();
  }

  resize();
  applyMode();
  return {
    setWorld, setDimension, setState, setGhost, focus, fitAll, resize, destroy, setRenderer,
    get renderer() { return mode; },
  };
}
