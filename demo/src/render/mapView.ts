// Map view: camera, input, state (fog, fades, time of day, graphics settings) and the 2D overlay
// (labels, pins, hover ring, tooltip, NPC bubbles, coastline ghost). The map itself is drawn by the
// WebGL2 lit renderer (lit/renderer.ts) into its own canvas inserted beneath the given canvas.
import type { World, Dimension, DimId, MapObject, LocId } from '../core/types';
import { D, T } from '../core/types';
import { hashStr } from '../core/rng';
import { buildDimRender, buildOutline, type DimRender } from './terrain';
import { drawPin, npcColor, pinRank, pinColor } from './objects';
import { Particles } from './particles';
import { isWaterfall } from './water';
import { type Actor, LitRenderer, type ObjDraw } from './lit/renderer';
import { type Gfx, type GraphicsSettings, defaultGraphics, gfx as toGfx } from './graphics';
import { objectLights, sunAt } from './lit/lights';
import { FLYERS, creatureFor } from './bake/creatures';
import { type Layout, layout } from './lit/compose';
import { FONT, clamp, ctx2d, hexRgb, shade, smoothstep } from './util';

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
  /** apply graphics settings live (no regeneration); cheap enough for every slider tick */
  setGraphics(g: GraphicsSettings): void;
  /** time of day in hours (0..24): sun direction / colour, shadows, night lights */
  setTime(hours: number): void;
}

const MAX_ZOOM = 64;
const SPRITE_MIN = 20; // below this px/tile objects become pins
const FRESH_SECS = 1.2;
const FADE_SECS = 0.6;
const NO_GL_MSG = 'This map needs WebGL2, which this browser or device does not provide.';

interface Hit { o: MapObject; x: number; y: number; r: number }
interface Cam { x: number; y: number; s: number }
/** fade state of an object whose hidden / done state changed recently */
interface Fade { a: number; show: boolean; prevDone: boolean | null; mix: number }

export function createMapView(canvas: HTMLCanvasElement, opts: MapViewOptions = {}): MapView {
  const ctx = ctx2d(canvas);
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';

  let world: World | null = null;
  let dim: Dimension | null = null;
  let dr: DimRender | null = null;
  let lay: Layout | null = null;
  const renders = new Map<DimId, DimRender>();
  const outlines = new Map<DimId, Path2D | null>();
  /** last camera of each dimension (restored when coming back from an interior) */
  const camMem = new Map<DimId, Cam>();
  let ghostOn = false;
  let state: MapState = { reachable: null, fresh: new Set(), hidden: new Set(), done: new Set() };
  let fogDirty = true;
  let zoneFog: Uint8Array | null = null;
  let regionSize: Int32Array | null = null;
  let freshT0 = -1;
  let sortedObjs: MapObject[] = [];
  const fades = new Map<string, Fade>();
  let G: Gfx = toGfx(defaultGraphics());
  let sun = sunAt(10);

  let lit: LitRenderer | null = null;
  let glFailed = false;
  let glCanvas: HTMLCanvasElement | null = null;
  let maskDirty = true;

  let W = 1, Hh = 1, dpr = 1;
  const cam: Cam = { x: 0, y: 0, s: 16 };
  let target: Cam | null = null;
  let minS = 4;

  const particles = new Particles();
  const rm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!rm?.matches;
  const onRm = () => { reduced = !!rm?.matches; if (reduced) particles.clear(); };
  rm?.addEventListener?.('change', onRm);

  let hover: MapObject | null = null;
  let hoverTile: { x: number; y: number } | null = null;
  let mouse: { x: number; y: number } | null = null;
  let hits: Hit[] = [];

  let raf = 0;
  let running = false;
  let last = 0;
  let t = 0;
  let destroyed = false;

  // ------------------------------------------------------------ geometry (tile lift = whole 16 px-per-tile pixels)
  const liftT = (i: number) => lay!.liftPx[i] / 16;
  const voidLiftT = () => lay!.voidLiftPx / 16;
  const maxLiftT = () => lay!.maxLiftPx / 16;
  function faceT(i: number): number {
    const below = i + dim!.w < dim!.w * dim!.h ? lay!.liftPx[i + dim!.w] : lay!.voidLiftPx;
    return Math.max(0, (lay!.liftPx[i] - below) / 16);
  }
  const worldBounds = () => {
    if (!dim || !lay) return { x0: 0, x1: 1, y0: 0, y1: 1 };
    return { x0: 0, x1: dim.w, y0: -lay.top / 16 + 0.4, y1: dim.h + (maxLiftT() - voidLiftT()) * 0.6 + 0.2 };
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

  function clampCam(c: Cam) {
    const b = worldBounds();
    c.s = clamp(c.s, minS, maxS());
    // the world may cover as little as ~10% of the view: the centre can go 80% of a half-view past each edge
    const hw = W / 2 / c.s, hh = Hh / 2 / c.s;
    c.x = clamp(c.x, b.x0 - hw * 0.8, b.x1 + hw * 0.8);
    c.y = clamp(c.y, b.y0 - hh * 0.8, b.y1 + hh * 0.8);
  }

  function tileElevY(x: number, y: number): number {
    if (!dim || !lay || x < 0 || y < 0 || x >= dim.w || y >= dim.h) return 0;
    return dim.ground[y * dim.w + x] === T.VOID ? 0 : liftT(y * dim.w + x);
  }

  /** screen -> tile, accounting for elevation (southernmost covering tile wins). */
  function pickTile(px: number, py: number): { x: number; y: number } | null {
    if (!dim || !lay) return null;
    const wpt = toWorld(px, py);
    const tx = Math.floor(wpt.x);
    if (tx < 0 || tx >= dim.w) return null;
    const yHi = Math.min(dim.h - 1, Math.floor(wpt.y - voidLiftT()) + 1);
    const yLo = Math.max(0, Math.floor(wpt.y - maxLiftT()) - 1);
    for (let y = yHi; y >= yLo; y--) {
      const i = y * dim.w + tx;
      if (dim.ground[i] === T.VOID) continue;
      const top = y - liftT(i);
      if (wpt.y >= top && wpt.y < top + 1 + faceT(i)) return { x: tx, y };
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
    if (!state.reachable || !dim || !dr || o.x < 0 || o.y < 0 || o.x >= dim.w || o.y >= dim.h) return false;
    return isFoggedZone(dr.owner[o.y * dim.w + o.x]);
  }
  function refreshFog() {
    fogDirty = false;
    if (!dim || !state.reachable) { zoneFog = null; return; }
    const zl = dim.zoneLoc;
    zoneFog = new Uint8Array(zl.length);
    for (let z = 0; z < zl.length; z++) zoneFog[z] = state.reachable.has(zl[z]) ? 0 : 1;
  }

  function outlineFor(d: Dimension): Path2D | null {
    if (!world || d.stack === undefined || d.stack >= 0) return null;
    if (!outlines.has(d.id)) {
      const above = world.dims.find((x) => x.stack === d.stack! + 1) || world.dims.find((x) => x.stack === 0);
      outlines.set(d.id, above ? buildOutline(above) : null);
    }
    return outlines.get(d.id)!;
  }

  // ------------------------------------------------------------ public API
  function setWorld(w: World) {
    const prev = dim ? { id: dim.id, w: dim.w, h: dim.h } : null;
    world = w;
    renders.clear();
    outlines.clear();
    particles.clear();
    fades.clear();
    for (const [id] of camMem) if (!w.dims.some((d) => d.id === id)) camMem.delete(id);
    lit?.setWorld(w, hashStr(w.seed));
    dim = null;
    dr = null;
    lay = null;
    hover = null;
    hits = [];
    const same = prev && w.dims.find((d) => d.id === prev.id && d.w === prev.w && d.h === prev.h);
    const first = same || w.dims.find((d) => d.kind === 'overworld') || w.dims[0];
    if (first) showDim(first, same ? 'keep' : 'fit');
  }

  function getDr(d: Dimension): DimRender {
    let r = renders.get(d.id);
    if (!r) renders.set(d.id, (r = buildDimRender(d, hashStr(world!.seed + ':' + d.id))));
    return r;
  }

  function setDimension(id: DimId) {
    if (!world) return;
    const d = world.dims.find((x) => x.id === id);
    if (!d) return;
    if (d === dim) { start(); return; }
    // stacked layers share tile coordinates: keep the exact camera; otherwise restore this dimension's last camera
    const stackedSwap = !!dim && dim.stack !== undefined && d.stack !== undefined && dim.w === d.w && dim.h === d.h;
    showDim(d, stackedSwap ? 'keep' : camMem.has(d.id) ? 'restore' : 'fit');
  }

  function showDim(d: Dimension, how: 'keep' | 'restore' | 'fit') {
    if (dim) camMem.set(dim.id, target ? { ...target } : { ...cam });
    dim = d;
    dr = getDr(d);
    lay = layout(d, dr.ve, dr.voidElev);
    sortedObjs = d.objects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    regionSize = new Int32Array(d.regions.length);
    for (let i = 0; i < d.w * d.h; i++) { const r = d.region[i]; if (r >= 0 && r < regionSize.length) regionSize[r]++; }
    particles.clear();
    hover = null;
    hits = [];
    fogDirty = true;
    maskDirty = true;
    minS = fitScale() * 0.3;
    if (how === 'keep') {
      if (target) Object.assign(cam, target);
      target = null;
      clampCam(cam);
    } else if (how === 'restore') {
      Object.assign(cam, camMem.get(d.id)!);
      target = null;
      clampCam(cam);
    } else {
      const b = worldBounds();
      Object.assign(cam, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, s: fitScale() });
      target = null;
    }
    start();
  }

  function initGL() {
    if (lit || glFailed || !canvas.parentNode) return;
    const gc = document.createElement('canvas');
    gc.setAttribute('aria-hidden', 'true');
    gc.style.position = 'absolute';
    gc.style.pointerEvents = 'none';
    gc.style.imageRendering = 'pixelated';
    canvas.parentNode.insertBefore(gc, canvas);
    const r = LitRenderer.create(gc);
    if (!r) { gc.remove(); glFailed = true; return; }
    lit = r;
    glCanvas = gc;
    r.onLost = () => start();
    r.onRestored = () => { maskDirty = true; start(); };
    if (world) r.setWorld(world, hashStr(world.seed));
    syncGlCanvas();
  }

  function syncGlCanvas() {
    if (!glCanvas) return;
    glCanvas.style.left = canvas.offsetLeft + 'px';
    glCanvas.style.top = canvas.offsetTop + 'px';
    glCanvas.style.width = canvas.offsetWidth + 'px';
    glCanvas.style.height = canvas.offsetHeight + 'px';
  }

  /** internal-resolution divisor under integer zoom (device px per internal px) */
  function intDiv(): number {
    const byPx = Math.ceil(Math.sqrt((W * dpr * Hh * dpr) / (G.maxPixels * 1e6)) - 1e-6);
    return Math.max(1, byPx, Math.round(1 / G.renderScale));
  }
  /** integer zoom: whole device pixels (and whole internal pixels) per source pixel once >= 1 */
  function snapScale(sc: number): number {
    if (!G.integerZoom) return sc;
    const n = (sc * dpr) / 16;
    if (n < 1) return sc;
    const m = intDiv();
    const n2 = Math.max(m, Math.round(n / m) * m);
    return clamp((n2 * 16) / dpr, minS, Math.max(maxS(), (m * 16) / dpr));
  }

  function setGraphics(g: GraphicsSettings) {
    G = toGfx(g);
    particles.density = G.particles;
    particles.cap = Math.round(300 * Math.min(1.5, G.particles));
    start();
  }

  function setTime(h: number) {
    sun = sunAt(h);
    start();
  }

  function setState(s: MapState) {
    const next: MapState = { reachable: s.reachable, fresh: s.fresh || new Set(), hidden: s.hidden || new Set(), done: s.done || new Set() };
    // objects whose visibility or done look changes fade instead of popping
    if (world && !reduced) {
      for (const d of world.dims)
        for (const o of d.objects) {
          const wasShown = !state.hidden.has(o.id), isShown = !next.hidden.has(o.id);
          const wasDone = state.done.has(o.id), isDone = next.done.has(o.id);
          if (wasShown === isShown && wasDone === isDone) continue;
          const f = fades.get(o.id) ?? { a: wasShown ? 1 : 0, show: wasShown, prevDone: null, mix: 1 };
          f.show = isShown;
          if (wasDone !== isDone) { f.prevDone = wasDone; f.mix = 0; }
          fades.set(o.id, f);
        }
    }
    state = next;
    fogDirty = true;
    maskDirty = true;
    if (state.fresh.size) freshT0 = t;
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
    const wasFit = dim ? Math.abs(cam.s - fitScale()) < 1e-3 : false;
    W = nw; Hh = nh; dpr = nd;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(Hh * dpr);
    syncGlCanvas();
    if (dim) {
      minS = fitScale() * 0.3;
      if (wasFit) { const b = worldBounds(); cam.x = (b.x0 + b.x1) / 2; cam.y = (b.y0 + b.y1) / 2; cam.s = fitScale(); }
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
    const wpt = toWorld((ps[0].x + ps[1].x) / 2, (ps[0].y + ps[1].y) / 2);
    pinch = { d, s: cam.s, wx: wpt.x, wy: wpt.y };
    drag = null;
  }

  function setHover(o: MapObject | null, tile: { x: number; y: number } | null) {
    const changed = o !== hover || tile?.x !== hoverTile?.x || tile?.y !== hoverTile?.y;
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
      opts.onPick?.(pickObj(p.x, p.y), pickTile(p.x, p.y));
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
  const onLeave = () => { mouse = null; if (!drag) setHover(null, null); };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(p.x, p.y, Math.exp(-clamp(e.deltaY * unit, -300, 300) * 0.0016), false);
  };
  const onDbl = (e: MouseEvent) => { const p = local(e); zoomAt(p.x, p.y, 2, true); };
  const onVis = () => { if (document.hidden) stop(); else start(); };

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
    if (G.integerZoom && !pinch && !target && dim) {
      const sn = snapScale(cam.s);
      if (Math.abs(sn - cam.s) > 1e-4) { if (reduced) cam.s = sn; else target = { x: cam.x, y: cam.y, s: sn }; }
    }
    try {
      render(dt);
    } catch (err) {
      console.error(err);
    }
    raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ objects, actors, fades
  const isActorObj = (o: MapObject) => o.kind === 'npc' || o.kind === 'start' || (o.kind as string) === 'enemy';

  /** animated character for an NPC / enemy / start object; enemies wander a tile or so (visual only) */
  function actorFor(o: MapObject, alpha: number): Actor {
    const d = dim!;
    const kind = o.kind === 'npc' ? 'npc' : o.kind === 'start' ? 'hero' : creatureFor((o as MapObject & { enemy?: string }).enemy);
    const ph = (hashStr(o.id) % 1000) / 1000 * 6.283;
    const moving = !reduced && G.animation;
    let dx = 0, dy = 0, dir: Actor['dir'] = 's', clip: Actor['clip'] = 'idle';
    if (moving && (o.kind as string) === 'enemy') {
      const fly = FLYERS.has(kind);
      const T0 = t * (kind === 'wisp' ? 0.25 : 0.45) + ph;
      // stop-and-go path: u advances fast, then slowly (an idle pause)
      const u = T0 - 0.85 * Math.sin(T0), du = 1 - 0.85 * Math.cos(T0);
      const ax = fly ? 1.1 : 0.7, ay = fly ? 0.7 : 0.45;
      dx = ax * Math.sin(u);
      dy = ay * Math.sin(u * 0.7 + 1);
      const vx = ax * Math.cos(u) * du, vy = ay * 0.7 * Math.cos(u * 0.7 + 1) * du;
      if (du > 0.35) { clip = 'walk'; dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'e' : 'w') : vy > 0 ? 's' : 'n'; }
    }
    const x = o.x + dx, y = o.y + dy;
    const tx = clamp(Math.round(x), 0, d.w - 1), ty = clamp(Math.round(y), 0, d.h - 1);
    const tint = o.kind === 'npc' ? (hexRgb(npcColor(o)).map((v) => v / 255) as [number, number, number]) : [1, 1, 1] as [number, number, number];
    return { kind, x, y, tile: ty * d.w + tx, dir, clip, at: moving ? t + ph : 0, tint, e: kind === 'wisp' ? 1 + sun.night : 1, alpha };
  }

  /** current fade of an object: alpha (0 = gone) and the done look it is fading from */
  function fadeOf(o: MapObject, dt: number): { a: number; prevDone: boolean | null; mix: number } {
    const f = fades.get(o.id);
    if (!f) return { a: state.hidden.has(o.id) ? 0 : 1, prevDone: null, mix: 1 };
    const step = dt / FADE_SECS;
    f.a = f.show ? Math.min(1, f.a + step) : Math.max(0, f.a - step);
    f.mix = Math.min(1, f.mix + step);
    if ((f.show ? f.a >= 1 : f.a <= 0) && f.mix >= 1) fades.delete(o.id);
    return { a: f.a, prevDone: f.mix < 1 ? f.prevDone : null, mix: f.mix };
  }

  function objScreen(o: MapObject): [number, number] {
    return [sx(o.x + 0.5), sy(o.y + 0.5 - tileElevY(o.x, o.y))];
  }

  /** door-like objects with a house or a cliff right behind them are drawn into that wall */
  function attachUp(o: MapObject): boolean {
    if (!dim || !lay || o.y <= 0) return false;
    const i = o.y * dim.w + o.x, j = i - dim.w;
    return dim.deco[j] === D.HOUSE || (dim.ground[j] !== T.VOID && liftT(j) > liftT(i) + 0.12);
  }

  // ------------------------------------------------------------ overlay
  function pinPriority(o: MapObject): number {
    switch (o.kind) {
      case 'start': return 5;
      case 'boss': return 4;
      case 'entrance':
      case 'stairs': return /dungeon|sanctum|shrine|beanstalk|stairs/.test(o.style || 'stairs') ? 4 : 3;
      case 'npc': return 2;
      case 'gate': return o.gate === 'ledge' || o.gate === 'open' ? 0 : 2;
      case 'chest': return 1;
      case 'enemy' as MapObject['kind']: return 1;
      default: return 0;
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

  function drawTooltip(o: MapObject, x: number, y: number) {
    const label = o.label || o.kind;
    const sub = o.kind === 'gate' ? `${o.gate}${state.done.has(o.id) ? ' · cleared' : ''}` : o.kind === 'entrance' ? o.style || 'entrance' : o.kind === 'chest' && state.done.has(o.id) ? 'opened' : o.kind;
    ctx.font = `600 12px ${FONT}`;
    const w1 = ctx.measureText(label).width;
    ctx.font = `500 10px ${FONT}`;
    const w = Math.max(w1, ctx.measureText(sub).width) + 18, h = 34;
    const bx = clamp(x - w / 2, 6, W - w - 6);
    let by = y - h;
    if (by < 6) by = y + 40;
    ctx.fillStyle = 'rgba(14,12,24,0.9)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 7); else ctx.rect(bx, by, w, h);
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
    if (!dim || !G.labels) return;
    const a = 1 - smoothstep(16, 30, cam.s);
    if (a <= 0.01) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.round(clamp(cam.s * 0.95, 11, 15) * G.labelSize);
    ctx.lineJoin = 'round';
    // biggest regions first; small regions fade out first; no overlapping labels
    const order = dim.regions.map((r, i) => [r, regionSize?.[i] ?? 0] as const).sort((p, q) => q[1] - p[1]);
    const placed: [number, number, number, number][] = [];
    for (const [r, size] of order) {
      const x = sx(r.x + 0.5), y = sy(r.y + 0.5 - tileElevY(r.x, r.y));
      if (x < -200 || x > W + 200 || y < -50 || y > Hh + 50) continue;
      const sa = size ? smoothstep(2500, 6500, size * cam.s * cam.s) : 1;
      if (sa <= 0.02) continue;
      const river = r.biome === 'river';
      ctx.font = river ? `italic 600 ${Math.max(10, fs - 2)}px ${FONT}` : `700 ${fs}px ${FONT}`;
      (ctx as unknown as { letterSpacing: string }).letterSpacing = river ? '0.5px' : '1.5px';
      const txt = river ? r.name : r.name.toUpperCase();
      const tw = ctx.measureText(txt).width;
      const rc: [number, number, number, number] = [x - tw / 2 - 4, y - fs, x + tw / 2 + 4, y + fs];
      if (placed.some((p) => p[0] < rc[2] && rc[0] < p[2] && p[1] < rc[3] && rc[1] < p[3])) continue;
      placed.push(rc);
      ctx.globalAlpha = a * sa;
      ctx.strokeStyle = 'rgba(8,6,18,0.75)';
      ctx.lineWidth = 4;
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = shade(r.color || '#ffffff', 0.65);
      ctx.fillText(txt, x, y);
      ctx.fillStyle = shade(r.color || '#ffffff', 0.2, 0.9);
      if (!river) ctx.fillRect(x - tw * 0.25, y + fs * 0.75, tw * 0.5, 1.5);
    }
    ctx.restore();
  }

  function drawMessage(msg: string) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0c12';
    ctx.fillRect(0, 0, W, Hh);
    ctx.fillStyle = '#c9c6d6';
    ctx.font = `500 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, W / 2, Hh / 2, W - 32);
  }

  // ------------------------------------------------------------ frame
  function render(dt: number) {
    if (!lit && !glFailed) initGL();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!lit || lit.lost) {
      if (glFailed || (lit && lit.lost && lit.restoreFailed)) drawMessage(NO_GL_MSG);
      return;
    }
    if (!dim || !dr || !lay) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const d = dim, r = dr;
    const a0 = toWorld(0, 0), a1 = toWorld(W, Hh);
    if (!reduced) {
      particles.emit(r, a0.x, a0.y, a1.x, a1.y, dt);
      particles.update(dt, t);
    }
    if (maskDirty) {
      maskDirty = false;
      const fresh = state.fresh;
      lit.setMask(d, r,
        (i) => !!state.reachable && isFoggedZone(r.owner[i]),
        (i) => fresh.size > 0 && r.owner[i] >= 0 && fresh.has(d.zoneLoc[r.owner[i]]));
    }
    // objects near the view, with fades; characters become actors
    const s = cam.s;
    const objs: ObjDraw[] = [];
    const actors: Actor[] = [];
    const lz: { o: MapObject; done: boolean; z: number; alpha: number }[] = [];
    const vis: { o: MapObject; x: number; y: number; fog: boolean; done: boolean; a: number; act: Actor | null }[] = [];
    const mx = 4 * s + 60;
    for (const o of sortedObjs) {
      let [x, y] = objScreen(o);
      if (x < -mx || y < -mx || x > W + mx || y > Hh + mx * 1.5) continue;
      const f = fadeOf(o, dt);
      if (f.a <= 0) continue;
      const done = state.done.has(o.id);
      const z = o.x >= 0 && o.y >= 0 && o.x < d.w && o.y < d.h ? liftT(o.y * d.w + o.x) : 0;
      let act: Actor | null = null;
      if (isActorObj(o)) {
        act = actorFor(o, f.a);
        actors.push(act);
        x = sx(act.x + 0.5);
        y = sy(act.y + 0.5 - z);
      } else {
        objs.push({ o, done, attach: attachUp(o), alpha: f.a * (f.prevDone !== null ? f.mix : 1) });
        if (f.prevDone !== null) objs.push({ o, done: f.prevDone, attach: attachUp(o), alpha: f.a * (1 - f.mix) });
      }
      lz.push({ o, done, z, alpha: f.a });
      vis.push({ o, x, y, fog: objFogged(o), done, a: f.a, act });
    }
    let fresh = 0;
    if (!reduced && freshT0 >= 0) {
      const u = (t - freshT0) / FRESH_SECS;
      if (u < 1) fresh = Math.sin(Math.PI * Math.min(1, u * 1.4)) * (1 - u * 0.5);
    }
    let gd: Dimension | null = null;
    if (ghostOn && world && d.stack !== undefined) {
      const stacked = world.dims.filter((x) => x.stack !== undefined && x.id !== d.id);
      gd = stacked.find((x) => x.stack === d.stack! - 1) || (d.stack > 0 ? stacked.find((x) => x.stack === 0) || null : null);
    }
    lit.render({
      dim: d, meta: r, cam, cssW: W, cssH: Hh, dpr, t, dt, motion: !reduced,
      ghost: gd ? { dim: gd, meta: getDr(gd) } : null,
      objs, lights: objectLights(lz, sun.night), particles: reduced ? null : particles, fresh, actors, gfx: G, sun,
      rsFix: G.integerZoom && (s * dpr) / 16 >= 1 ? dpr / intDiv() : undefined,
    });
    // coastline of the layer above (underworld) as a faint dashed overlay
    const outline = ghostOn ? outlineFor(d) : null;
    if (outline) {
      ctx.save();
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (W / 2 - cam.x * s), dpr * (Hh / 2 - cam.y * s));
      ctx.lineWidth = 1.6 / s;
      ctx.setLineDash([5 / s, 4 / s]);
      ctx.strokeStyle = 'rgba(150,215,255,0.5)';
      ctx.stroke(outline);
      ctx.restore();
    }
    drawOverlayObjects(vis, dt);
    drawLabels();
    if (mouse && !drag?.moved && !target) updateHover();
  }

  function drawOverlayObjects(vis: { o: MapObject; x: number; y: number; fog: boolean; done: boolean; a: number; act: Actor | null }[], dt: number) {
    const s = cam.s;
    const sprites = s >= SPRITE_MIN;
    hits = [];
    // object particles (sparkles, motes, mist)
    if (!reduced) {
      for (const { o, done, fog, act } of vis) {
        if (fog) continue;
        const wx = (act ? act.x : o.x) + 0.5, wy = (act ? act.y : o.y) + 0.5 - tileElevY(o.x, o.y);
        if (o.kind === 'chest' && !done && Math.random() < dt * 2.2)
          particles.add('sparkle', wx + (Math.random() - 0.5) * 0.7, wy - 0.2 - Math.random() * 0.4, { max: 0.8, size: 5, col: 'rgb(255,220,120)' });
        else if (o.kind === 'gate' && (o.gate === 'seal' || o.gate === 'portal') && !done && Math.random() < dt * 5) {
          const a = Math.random() * 6.283;
          particles.add('mote', wx + Math.cos(a) * 0.45, wy + Math.sin(a) * 0.45, { vx: -Math.cos(a) * 0.3, vy: -Math.sin(a) * 0.3 - 0.2, max: 1.2, size: 4, col: o.gate === 'seal' ? 'rgb(255,110,240)' : 'rgb(190,120,255)' });
        } else if (isWaterfall(o) && Math.random() < dt * 7)
          particles.add('mote', wx + (Math.random() - 0.5) * 0.9, wy - 0.1 - Math.random() * 0.3, { vx: (Math.random() - 0.5) * 0.3, vy: -0.3 - Math.random() * 0.3, max: 1.4, size: 7, col: 'rgb(190,225,250)' });
        else if (o.kind === 'start' && Math.random() < dt * 2)
          particles.add('mote', wx + (Math.random() - 0.5) * 0.8, wy, { vy: -0.5, max: 1.6, size: 4, col: 'rgb(160,255,200)' });
      }
    }
    // zoomed out: thin pins by importance and declutter in screen space
    const showPins = !sprites && G.pins && G.pinDensity > 0;
    const pinSel = new Set<MapObject>();
    if (showPins) {
      const minPri = Math.max(0, (s < 3 ? 4 : s < 6 ? 3 : s < 10 ? 2 : s < 16 ? 1 : 0) + (G.pinDensity < 0.5 ? 1 : G.pinDensity > 1.5 ? -1 : 0));
      const cell = (15 * G.pinSize) / Math.max(0.25, G.pinDensity);
      const occ = new Set<number>();
      for (const q of vis.filter((v) => v.a > 0.5 && v.o.gate !== 'open' && pinPriority(v.o) >= minPri).sort((p, q) => pinPriority(q.o) - pinPriority(p.o))) {
        const key = Math.floor(q.x / cell) * 100003 + Math.floor(q.y / cell);
        if (occ.has(key)) continue;
        occ.add(key);
        pinSel.add(q.o);
      }
    }
    for (const { o, x, y, fog, done, a } of vis) {
      ctx.globalAlpha = (fog ? 0.55 : 1) * a;
      if (sprites) {
        if (o.kind === 'npc' && o.icon && s >= 22) drawBubble(o.icon, x, y - s * 1.15, s);
        hits.push({ o, x, y: y - s * 0.1, r: s * 0.55 });
      } else if (pinSel.has(o)) {
        const rank = pinRank(o);
        const r = (rank === 2 ? 8 : rank === 1 ? 6.5 : 3.5) * G.pinSize;
        drawPin(ctx, o, x, y, r, done);
        hits.push({ o, x, y: rank === 0 ? y : y - r * 1.55, r: Math.max(r + 3, 8) });
      } else if (!sprites) hits.push({ o, x, y, r: 6 });
    }
    ctx.globalAlpha = 1;
    if (hover && !state.hidden.has(hover.id)) {
      const h = hits.find((q) => q.o === hover);
      if (h && (sprites || pinSel.has(hover))) {
        const pulse = reduced ? 0 : Math.sin(t * 5) * 1.5;
        ctx.strokeStyle = 'rgba(10,8,20,0.7)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r + 2 + pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = '#fff6d8';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (h) drawTooltip(hover, h.x, h.y - h.r - 8);
    }
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
    particles.clear();
  }

  resize();
  initGL();
  return { setWorld, setDimension, setState, setGhost, focus, fitAll, resize, destroy, setGraphics, setTime };
}
