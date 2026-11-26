// WebGL2 lit renderer.
//
// Static terrain is split into fixed 512x512 px chunks (32x32 tiles at 16 px/tile) of a per-dimension
// G-buffer (albedo / normal+height / emissive+material / tile id). Chunks are composed lazily from the
// sprite atlas when they first become visible (a few per frame), kept in a global LRU with a memory
// budget, and never evicted while the current frame references them. A low-res overview of the whole
// dimension (built from tile data in a few ms) is drawn below / instead of chunks when zoomed out and
// as the placeholder for chunks not composed yet; it is also the source of the stacked-world ghost.
//
// Per frame: screen G-buffer (overview + chunks + dynamic object sprites) -> toon-banded lighting with
// coloured point lights (culled by a spatial grid) and height-field shadows -> additive particles ->
// bloom -> grade/vignette composite.
import type { DimId, Dimension, MapObject, World } from '../../core/types';
import { D, T } from '../../core/types';
import { bakeAtlas, bakeStep, lastBakeMs } from '../bake/index';
import { groundMat } from '../bake/ground';
import { CRYSTAL_LIGHT } from '../bake/models';
import type { AssetSheet } from '../bake/sheet';
import { TILE_PX } from '../bake/sheet';
import type { Particles } from '../particles';
import { npcColor } from '../objects';
import { type Overview, type OverviewColors, type RGB, buildOverview, overviewPx } from '../overview';
import { hexRgb } from '../util';
import { computeWater } from '../water';
import { FLOATS, InstBuf, type Layout, buildStatic, layout, objectKey, standOf, staticFeatures, wallStyle } from './compose';
import type { WallPatterns } from '../terrain';
import { type Prog, delFramebuffer, delTexture, framebuffer, glStats, program, texture } from './gl';
import { type Light, LightGrid, type Mood, type Sun, moodFor, staticLights } from './lights';
import { CHAR_H, CHAR_W, charAtlas } from '../bake/charAtlas';
import { type Dir as CDir, FLYERS } from '../bake/creatures';
import { type PropGrid, buildPropGrid, forProps, propLook } from '../props';
import type { Gfx } from '../graphics';
import { defaultGraphics, gfx as toGfx } from '../graphics';
import {
  BLIT_FS, BLUR_FS, BRIGHT_FS, CASTER_FS, COMPOSITE_FS, FULL_VS, LIGHT_FS, MAX_LIGHTS, POINT_FS, POINT_VS, QUAD_VS, SPRITE_FS, SPRITE_VS, TERRAIN_H_FS,
} from './shaders';

export interface DimMetaIn {
  ve: Float32Array;
  voidElev: number;
}

export interface ObjDraw {
  o: MapObject;
  done: boolean;
  attach: boolean;
  /** 0..1 fade (hidden / done changes) */
  alpha: number;
}

export interface LitFrame {
  dim: Dimension;
  meta: DimMetaIn;
  cam: { x: number; y: number; s: number };
  cssW: number;
  cssH: number;
  dpr: number;
  t: number;
  /** seconds since the last frame */
  dt: number;
  motion: boolean;
  ghost: { dim: Dimension; meta: DimMetaIn } | null;
  /** objects near the view (already culled by the caller) */
  objs: ObjDraw[];
  lights: Light[];
  particles: Particles | null;
  fresh: number;
  /** animated characters (NPCs, enemies, the player marker) */
  actors: Actor[];
  gfx: Gfx;
  /** time-of-day sun; applied to outdoor moods only */
  sun: Sun | null;
  /** fixed internal resolution scale (integer zoom: device pixels / an integer) */
  rsFix?: number;
}

export interface Actor {
  /** creature kind (see bake/creatures.ts) */
  kind: string;
  /** world position in tiles (may be fractional while wandering) and the tile it stands on */
  x: number;
  y: number;
  tile: number;
  dir: CDir | 'w';
  clip: 'idle' | 'walk';
  /** animation time in seconds */
  at: number;
  tint: [number, number, number];
  /** emissive scale */
  e: number;
  /** 0..1 fade */
  alpha: number;
}

const CHUNK_TILES = 32;
const CPX = CHUNK_TILES * TILE_PX; // 512
/** px per tile (css) where chunks start to fade in over the overview, and where they are fully opaque */
const CHUNK_S0 = 9;
const CHUNK_S1 = 13;
/** never show more than this many chunks at once (big screens zoomed out use the overview) */
const MAX_VISIBLE_CHUNKS = 40;
/** LRU budget (each chunk = 4 x 512x512 RGBA8 = 4 MB) */
const CHUNK_BUDGET = 48;
const MAX_INTERNAL_PX = 1.6e6;

interface Chunk {
  dim: DimId;
  cx: number;
  cy: number;
  tex: WebGLTexture[];
  fbo: WebGLFramebuffer;
  lastUse: number;
}

interface DimGL {
  id: DimId;
  dim: Dimension;
  lay: Layout;
  cols: number;
  rows: number;
  ov: Overview;
  ovTex: WebGLTexture[];
  lights: LightGrid;
  nLights: number;
  mask: WebGLTexture;
  maskData: Uint8Array;
  liftTex: WebGLTexture;
  props: PropGrid;
  mood: Mood;
  chunks: Map<number, Chunk>;
  lastUse: number;
}

export const litStats = {
  atlasMs: 0, overviewMs: [] as number[], prepareMs: [] as number[], chunkMs: [] as number[], maskMs: 0, lastFrameMs: 0,
  worstFrameMs: 0, lightsActive: 0, counts: { props: 0, casters: 0, actors: 0, objects: 0 }, chunksLive: 0, chunksComposedLastFrame: 0, pendingChunks: 0,
};

const push = (a: number[], v: number) => { a.push(v); if (a.length > 200) a.shift(); };

export class LitRenderer {
  gl!: WebGL2RenderingContext;
  lost = false;
  onLost: (() => void) | null = null;
  onRestored: (() => void) | null = null;
  maxTex = 4096;
  private sheet!: AssetSheet;
  private atlas: WebGLTexture[] = [];
  private colors!: OverviewColors;
  private colorsUnder!: OverviewColors;
  private pSprite!: Prog;
  private pBlit!: Prog;
  private pLight!: Prog;
  private pPoint!: Prog;
  private pBright!: Prog;
  private pBlur!: Prog;
  private pComp!: Prog;
  private vaoSprite!: WebGLVertexArrayObject;
  private vaoPoint!: WebGLVertexArrayObject;
  private vaoEmpty!: WebGLVertexArrayObject;
  private instBuf!: WebGLBuffer;
  private pointBuf!: WebGLBuffer;
  private dims = new Map<DimId, DimGL>();
  private world: World | null = null;
  private iw = 0;
  private ih = 0;
  private gTex: WebGLTexture[] = [];
  private gFbo: WebGLFramebuffer | null = null;
  private litTex: WebGLTexture | null = null;
  private litFbo: WebGLFramebuffer | null = null;
  private bTex: WebGLTexture[] = [];
  private bFbo: WebGLFramebuffer[] = [];
  private hdr = false;
  private seed = 1;
  private errLogged = false;
  private pointData = new Float32Array(7 * 320);
  private objInst = new InstBuf();
  private chunkInst = new InstBuf();
  private propInst = new InstBuf();
  private castInst = new InstBuf();
  private castCharInst = new InstBuf();
  private charInst = new InstBuf();
  private topTex: WebGLTexture | null = null;
  private charTex: WebGLTexture[] = [];
  private charVersion = -1;
  private pCaster!: Prog;
  private pTerrH!: Prog;
  private castTex: WebGLTexture | null = null;
  private castFbo: WebGLFramebuffer | null = null;
  private occTex: WebGLTexture | null = null;
  private occFbo: WebGLFramebuffer | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  /** instance counts of the last frame (for tests) */
  lastCounts = { props: 0, casters: 0, actors: 0, objects: 0 };
  private outlineK = [0.35, 0.35, 0];
  private lightW = new Map<string, number>();
  private lightDim: DimId | null = null;
  /** set when a lost context does not come back */
  restoreFailed = false;
  private lostTimer = 0;
  private lp = new Float32Array(MAX_LIGHTS * 4);
  private lc = new Float32Array(MAX_LIGHTS * 4);
  private colCache = new Map<string, [number, number, number]>();
  private onLostEv = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.dims.clear();
    clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => { if (this.lost) { this.restoreFailed = true; this.onLost?.(); } }, 4000);
    this.onLost?.();
  };
  private onRestoredEv = () => {
    try { this.init(); this.lost = false; this.restoreFailed = false; clearTimeout(this.lostTimer); this.onRestored?.(); } catch (err) { console.error(err); this.restoreFailed = true; }
  };

  static create(canvas: HTMLCanvasElement): LitRenderer | null {
    try {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) return null;
      return new LitRenderer(canvas, gl);
    } catch (err) {
      console.warn('lit renderer unavailable:', err);
      return null;
    }
  }

  private constructor(readonly canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onLostEv);
    canvas.addEventListener('webglcontextrestored', this.onRestoredEv);
    this.init();
  }

  private init() {
    const gl = this.gl;
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 4) throw new Error('needs 4 draw buffers');
    this.maxTex = Math.min(16384, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    if (this.maxTex < 2048) throw new Error('MAX_TEXTURE_SIZE too small');
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    const t0 = performance.now();
    this.sheet = bakeAtlas();
    litStats.atlasMs = lastBakeMs || performance.now() - t0;
    const s = this.sheet;
    this.atlas = [s.albedo, s.normal, s.emissive].map((d) => texture(gl, s.w, s.h, { data: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) }));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.topTex = texture(gl, s.w, s.h, { internal: gl.R8, format: gl.RED, data: s.top });
    if (s.dirty) s.dirty.length = 0;
    this.charTex = [0, 1, 2].map(() => texture(gl, CHAR_W, CHAR_H));
    this.charTex.push(texture(gl, CHAR_W, CHAR_H, { internal: gl.R8, format: gl.RED }));
    this.charVersion = -1;
    charAtlas().markAll();
    this.castTex = texture(gl, 1024, 1024);
    this.castFbo = framebuffer(gl, [this.castTex]);
    this.pCaster = program(gl, SPRITE_VS, CASTER_FS, 'caster');
    this.pTerrH = program(gl, FULL_VS, TERRAIN_H_FS, 'terrainH');
    this.colors = this.atlasColors(false);
    this.colorsUnder = this.atlasColors(true);
    this.pSprite = program(gl, SPRITE_VS, SPRITE_FS, 'sprite');
    this.pBlit = program(gl, QUAD_VS, BLIT_FS, 'blit');
    this.pLight = program(gl, FULL_VS, LIGHT_FS, 'light');
    this.pPoint = program(gl, POINT_VS, POINT_FS, 'point');
    this.pBright = program(gl, FULL_VS, BRIGHT_FS, 'bright');
    this.pBlur = program(gl, FULL_VS, BLUR_FS, 'blur');
    this.pComp = program(gl, FULL_VS, COMPOSITE_FS, 'composite');
    this.vaoSprite = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoSprite);
    const quad = gl.createBuffer()!;
    glStats.buffers++;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    glStats.buffers++;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    this.vaoPoint = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoPoint);
    this.pointBuf = gl.createBuffer()!;
    glStats.buffers++;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    this.vaoEmpty = gl.createVertexArray()!;
    gl.bindVertexArray(null);
    this.iw = this.ih = 0;
    this.gTex = [];
    this.gFbo = this.litFbo = null;
    this.litTex = null;
    this.bTex = [];
    this.bFbo = [];
  }

  /** average sprite colours of the atlas, for the overview */
  private atlasColors(under: boolean): OverviewColors {
    const s = this.sheet;
    const cache = new Map<string, RGB | null>();
    const avg = (key: string, layer: 'alb' | 'emi', rows?: [number, number]): RGB | null => {
      const ck = key + layer + (rows ? rows.join() : '');
      if (cache.has(ck)) return cache.get(ck)!;
      const f = s.frames.get(key)?.[0];
      let r = 0, g = 0, b = 0, n = 0;
      if (f) {
        const src = layer === 'alb' ? s.albedo : s.emissive;
        for (let y = rows ? rows[0] : 0; y < (rows ? Math.min(f.h, rows[1]) : f.h); y++)
          for (let x = 0; x < f.w; x++) {
            const o = ((f.y + y) * s.w + f.x + x) * 4;
            if (!s.albedo[o + 3]) continue;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
          }
      }
      const c: RGB | null = n ? [r / n, g / n, b / n] : null;
      cache.set(ck, c);
      return c;
    };
    const gC: (RGB | null)[] = [], fC: (RGB | null)[] = [], dC = new Map<number, RGB | null>();
    const lavaE = avg('g:' + T.LAVA, 'emi');
    return {
      ground: (g) => (gC[g] !== undefined ? gC[g]! : (gC[g] = avg('g:' + g, 'alb') ?? [90, 90, 90])),
      face: (g) => (fC[g] !== undefined ? fC[g]! : (fC[g] = avg('f:' + g, 'alb', [3, 14]) ?? [40, 30, 30])),
      deco: (d, g) => {
        const ck = d * 32 + g;
        let c = dC.get(ck);
        if (c === undefined) {
          c = d === D.HOUSE ? [120, 36, 28] : avg('d:' + d + (d === D.PINE && g === T.SNOW ? ':snow' : d === D.MUSHROOM && under ? ':glow' : ''), 'alb');
          dC.set(ck, c);
        }
        return c;
      },
      emit: (g, d, x, y) => {
        if (g === T.LAVA) return lavaE;
        if (d === D.CRYSTAL) {
          const c = CRYSTAL_LIGHT[(x * 7 + y * 13) % CRYSTAL_LIGHT.length];
          return [c[0] * 140, c[1] * 140, c[2] * 140];
        }
        if (d === D.MUSHROOM && under) return [20, 90, 180];
        if (d === D.HOUSE) return [90, 55, 18];
        return null;
      },
      mat: (g) => groundMat(g),
    };
  }

  get hdrSupported() { return this.hdr; }

  setWorld(world: World, seed: number) {
    this.world = world;
    this.seed = seed;
    this.freeDims();
  }

  /** The shape of the terrain changed (wall face sizes): every composed chunk is stale. */
  resetTerrain() {
    this.freeDims();
  }

  private freeChunk(c: Chunk) {
    if (!this.lost) {
      c.tex.forEach((t) => delTexture(this.gl, t));
      delFramebuffer(this.gl, c.fbo);
    }
  }

  private freeDims(keep?: Set<DimId>) {
    const gl = this.gl;
    for (const [id, d] of this.dims) {
      if (keep?.has(id)) continue;
      for (const c of d.chunks.values()) this.freeChunk(c);
      d.chunks.clear();
      if (!this.lost) {
        d.ovTex.forEach((t) => delTexture(gl, t));
        delTexture(gl, d.mask);
        delTexture(gl, d.liftTex);
      }
      this.dims.delete(id);
    }
  }

  /** Per-dimension data: layout, overview textures, light grid, mask. O(tiles) CPU, no chunk is composed. */
  prepare(dim: Dimension, meta: DimMetaIn): DimGL {
    let d = this.dims.get(dim.id);
    if (d && d.dim === dim) { d.lastUse = performance.now(); return d; }
    if (d) this.freeDims(new Set([...this.dims.keys()].filter((k) => k !== dim.id)));
    const gl = this.gl;
    const t0 = performance.now();
    const lay = layout(dim, meta.ve, meta.voidElev);
    const n = dim.w * dim.h;
    const lift = new Float32Array(n);
    for (let i = 0; i < n; i++) lift[i] = lay.liftPx[i] / TILE_PX;
    const under = dim.kind === 'underworld' || dim.kind === 'interior';
    const opx = overviewPx(dim.w, Math.ceil(lay.H / TILE_PX), this.maxTex);
    const ov = buildOverview(dim, lift, lay.voidLiftPx / TILE_PX, lay.top / TILE_PX, (lay.H - lay.top) / TILE_PX - dim.h, opx,
      under ? this.colorsUnder : this.colors, true);
    push(litStats.overviewMs, ov.ms);
    const tex = (data: Uint8Array, mip: boolean, nearest = false) => {
      const t = texture(gl, ov.w, ov.h, { data, min: nearest ? gl.NEAREST : mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR, mag: gl.NEAREST });
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    };
    const ovTex = [tex(ov.alb, true), tex(ov.nrm!, false), tex(ov.emi!, false), tex(ov.tid!, false, true)];
    ov.nrm = ov.emi = ov.tid = null; // uploaded; keep albedo-free memory small
    const feats = staticFeatures(dim, lay);
    const lights = staticLights(dim, lay, feats, this.sheet, this.seed);
    const maskData = new Uint8Array(n * 4);
    // B = river flow direction, A = water kind (static; setMask only rewrites R/G)
    const wi = computeWater(dim, meta.ve);
    // B: river flow code 1..4, or 16 + distance to land for rough (deep) water
    for (let i = 0; i < n; i++) { maskData[i * 4 + 2] = wi.kind[i] === 2 ? 16 + wi.dist[i] : wi.flow[i]; maskData[i * 4 + 3] = wi.kind[i]; }
    const mask = texture(gl, dim.w, dim.h, { data: maskData });
    // R = lift in px, G = what the tile is for the height model (see TERRAIN_SHAPE)
    const liftData = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      liftData[i * 2] = dim.ground[i] === T.VOID ? 0 : Math.max(0, Math.min(255, lay.liftPx[i]));
      liftData[i * 2 + 1] = lay.kind![i];
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const liftTex = texture(gl, dim.w, dim.h, { internal: gl.RG8, format: gl.RG, data: liftData });
    d = {
      liftTex, props: buildPropGrid(dim),
      id: dim.id, dim, lay, cols: Math.ceil(lay.W / CPX), rows: Math.ceil(lay.H / CPX), ov, ovTex,
      lights: new LightGrid(lights), nLights: lights.length, mask, maskData, mood: moodFor(this.world, dim),
      chunks: new Map(), lastUse: performance.now(),
    };
    this.dims.set(dim.id, d);
    push(litStats.prepareMs, performance.now() - t0);
    return d;
  }

  /** Upload the per-tile fog / fresh mask (R = fogged, G = fresh). */
  setMask(dim: Dimension, meta: DimMetaIn, fogged: (i: number) => boolean, fresh: (i: number) => boolean) {
    if (this.lost) return;
    const t0 = performance.now();
    const d = this.prepare(dim, meta);
    const m = d.maskData;
    for (let i = 0, n = dim.w * dim.h; i < n; i++) {
      m[i * 4] = fogged(i) ? 255 : 0;
      m[i * 4 + 1] = fresh(i) ? 255 : 0;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, d.mask);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dim.w, dim.h, gl.RGBA, gl.UNSIGNED_BYTE, m);
    litStats.maskMs = performance.now() - t0;
  }

  private drawSprites(inst: InstBuf, k: number, ox: number, oy: number, tw: number, th: number,
    tex: WebGLTexture[] = this.atlas, occ: { lift: WebGLTexture } | null = null, fade = 1, shape: { lift: WebGLTexture; walls: WallPatterns } | null = null) {
    if (!inst.n) return;
    const gl = this.gl, p = this.pSprite;
    gl.useProgram(p.p);
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    }
    gl.uniform1i(p.u.uA, 0);
    gl.uniform1i(p.u.uN, 1);
    gl.uniform1i(p.u.uE, 2);
    gl.uniform1i(p.u.uOccOn, occ ? 1 : 0);
    gl.uniform1f(p.u.uDepthOn, occ ? 1 : 0);
    gl.uniform1f(p.u.uFade, fade);
    gl.uniform3f(p.u.uOutline, this.outlineK[0], this.outlineK[1], this.outlineK[2]);
    if (occ) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.occTex);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, occ.lift);
      gl.uniform1i(p.u.uOcc, 3);
      gl.uniform1i(p.u.uLift, 4);
    }
    if (shape) {
      // static terrain: the per-tile lifts and the wall pattern shape the sloped sides
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, shape.lift);
      gl.uniform1i(p.u.uLift, 4);
      gl.uniform4fv(p.u.uWallP, shape.walls.main);
      gl.uniform4fv(p.u.uWallL, shape.walls.lip);
    }
    gl.uniform2f(p.u.uOff, ox, oy);
    gl.uniform1f(p.u.uK, k);
    gl.uniform2f(p.u.uTarget, tw, th);
    gl.bindVertexArray(this.vaoSprite);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.f.subarray(0, inst.n * FLOATS), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, inst.n);
    gl.bindVertexArray(null);
  }

  private chunkCount() {
    let n = 0;
    for (const d of this.dims.values()) n += d.chunks.size;
    return n;
  }

  /** Compose one 512x512 chunk of a dimension's static G-buffer. */
  private composeChunk(d: DimGL, cx: number, cy: number): Chunk {
    const gl = this.gl;
    const t0 = performance.now();
    const { lay } = d;
    const lin = { min: gl.LINEAR, mag: gl.NEAREST };
    const tex = [texture(gl, CPX, CPX, lin), texture(gl, CPX, CPX, lin), texture(gl, CPX, CPX, lin), texture(gl, CPX, CPX)];
    const fbo = framebuffer(gl, tex);
    // every tile whose sprites can reach into this chunk: faces drop below their row, lifted tiles and
    // tall props rise above it, wide props overhang their column
    const y0px = cy * CPX, y1px = y0px + CPX;
    const rect = {
      x0: cx * CHUNK_TILES - 1,
      x1: (cx + 1) * CHUNK_TILES + 1,
      y0: Math.floor((y0px - lay.top - TILE_PX - (lay.maxLiftPx - lay.voidLiftPx)) / TILE_PX) - 1,
      y1: Math.ceil((y1px - lay.top + lay.maxLiftPx + 80) / TILE_PX) + 1,
    };
    buildStatic(d.dim, lay, this.sheet, this.seed, rect, this.chunkInst);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, CPX, CPX);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawSprites(this.chunkInst, 1, -cx * CPX, -cy * CPX, CPX, CPX, this.atlas, null, 1, { lift: d.liftTex, walls: lay.walls! });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const c: Chunk = { dim: d.id, cx, cy, tex, fbo, lastUse: performance.now() };
    d.chunks.set(cx + cy * 4096, c);
    push(litStats.chunkMs, performance.now() - t0);
    return c;
  }

  /** Evict least-recently-used chunks beyond the budget; chunks in `pinned` are never evicted. */
  private evict(pinned: Set<Chunk>, budget: number) {
    let n = this.chunkCount();
    if (n <= budget) return;
    const all: [DimGL, number, Chunk][] = [];
    for (const d of this.dims.values()) for (const [k, c] of d.chunks) if (!pinned.has(c)) all.push([d, k, c]);
    all.sort((a, b) => a[2].lastUse - b[2].lastUse);
    for (const [d, k, c] of all) {
      if (n <= budget) break;
      this.freeChunk(c);
      d.chunks.delete(k);
      n--;
    }
  }

  private ensureTargets(iw: number, ih: number) {
    if (iw === this.iw && ih === this.ih && this.gFbo) return;
    const gl = this.gl;
    this.gTex.forEach((t) => delTexture(gl, t));
    delTexture(gl, this.litTex);
    this.bTex.forEach((t) => delTexture(gl, t));
    delFramebuffer(gl, this.gFbo);
    delFramebuffer(gl, this.litFbo);
    this.bFbo.forEach((f) => delFramebuffer(gl, f));
    this.iw = iw; this.ih = ih;
    this.gTex = [0, 1, 2, 3].map(() => texture(gl, iw, ih));
    this.gFbo = framebuffer(gl, this.gTex);
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
    this.depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, iw, ih);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gFbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    delTexture(gl, this.occTex);
    delFramebuffer(gl, this.occFbo);
    this.occTex = texture(gl, iw, ih);
    this.occFbo = framebuffer(gl, [this.occTex]);
    const hdrOpt = this.hdr ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT, min: gl.LINEAR, mag: gl.LINEAR } : { min: gl.LINEAR, mag: gl.LINEAR };
    this.litTex = texture(gl, iw, ih, hdrOpt);
    this.litFbo = framebuffer(gl, [this.litTex]);
    const bw = Math.max(1, Math.ceil(iw / 4)), bh = Math.max(1, Math.ceil(ih / 4));
    this.bTex = [0, 1, 2].map(() => texture(gl, bw, bh, hdrOpt));
    this.bFbo = this.bTex.map((t) => framebuffer(gl, [t]));
  }

  private rgb(col: string): [number, number, number] {
    let c = this.colCache.get(col);
    if (!c) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(col);
      c = m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : (hexRgb(col).map((v) => v / 255) as [number, number, number]);
      this.colCache.set(col, c);
    }
    return c;
  }

  private blitLayer(tex: WebGLTexture[], offX: number, offY: number, k: number, tw: number, th: number, fade: number, iw: number, ih: number) {
    const gl = this.gl, pb = this.pBlit;
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    }
    gl.uniform2f(pb.u.uOff, offX, offY);
    gl.uniform1f(pb.u.uK, k);
    gl.uniform2f(pb.u.uTex, tw, th);
    gl.uniform2f(pb.u.uTarget, iw, ih);
    gl.uniform1f(pb.u.uFade, fade);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(f: LitFrame) {
    if (this.lost) return;
    const gl = this.gl;
    const t0 = performance.now();
    const G = f.gfx;
    const ok = (v: string) => (v === 'off' ? 0 : v === 'strong' ? 0.6 : 0.35);
    this.outlineK = [ok(G.outlineCreatures), ok(G.outlineObjects), ok(G.outlineProps)];
    const rs = f.rsFix ?? Math.max(0.2, Math.min(f.dpr * G.renderScale, Math.sqrt((G.maxPixels * 1e6) / Math.max(1, f.cssW * f.cssH)), 2 * G.renderScale));
    const iw = Math.max(1, Math.min(this.maxTex, Math.round(f.cssW * rs))), ih = Math.max(1, Math.min(this.maxTex, Math.round(f.cssH * rs)));
    if (this.canvas.width !== iw || this.canvas.height !== ih) { this.canvas.width = iw; this.canvas.height = ih; }
    this.ensureTargets(iw, ih);
    const d = this.prepare(f.dim, f.meta);
    const gd = f.ghost ? this.prepare(f.ghost.dim, f.ghost.meta) : null;
    const now = performance.now();
    d.lastUse = now;
    if (gd) gd.lastUse = now;
    // bound per-dimension memory between frames: keep the 6 most recently used, never the ones drawn now
    if (this.dims.size > 6) {
      const keep = new Set<DimId>([d.id]);
      if (gd) keep.add(gd.id);
      for (const o of [...this.dims.values()].sort((a, b) => b.lastUse - a.lastUse)) { if (keep.size >= 6) break; keep.add(o.id); }
      this.freeDims(keep);
    }
    const lay = d.lay, mood = d.mood;
    const s = f.cam.s;
    const k = (s * rs) / TILE_PX;
    // pixel-snapped camera: move in whole source pixels so sprites never shimmer
    // camera snapping: 'world' = whole source pixels, 'screen' = whole device (internal) pixels, 'none' = sub-pixel
    const world = G.pixelSnap === 'world' && k >= 1;
    const camX = world ? Math.round(f.cam.x * TILE_PX) / TILE_PX : f.cam.x;
    const camY = world ? Math.round(f.cam.y * TILE_PX) / TILE_PX : f.cam.y;
    const rnd = G.pixelSnap === 'none' ? (v: number) => v : Math.round;
    const offX = rnd((f.cssW / 2 - camX * s) * rs);
    const offY = rnd((f.cssH / 2 - camY * s) * rs - lay.top * k);
    const S0 = G.detailDistance, S1 = G.detailDistance + Math.max(0.01, G.detailFade);
    const sun = mood.outdoor ? f.sun : null;

    // ---- which chunks this frame needs; compose a few, evict only what this frame does not use
    const vx0 = -offX / k, vx1 = (iw - offX) / k, vy0 = -offY / k, vy1 = (ih - offY) / k; // dim px
    const cx0 = Math.max(0, Math.floor(vx0 / CPX)), cx1 = Math.min(d.cols - 1, Math.floor(vx1 / CPX));
    const cy0 = Math.max(0, Math.floor(vy0 / CPX)), cy1 = Math.min(d.rows - 1, Math.floor(vy1 / CPX));
    const nVis = Math.max(0, cx1 - cx0 + 1) * Math.max(0, cy1 - cy0 + 1);
    let fade = s <= S0 ? 0 : s >= S1 ? 1 : (s - S0) / (S1 - S0);
    if (!G.dither) fade = s >= S0 ? 1 : 0;
    if (nVis > MAX_VISIBLE_CHUNKS) fade = 0;
    const visible: Chunk[] = [];
    let missing: [number, number, number][] = [];
    if (fade > 0) {
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = d.chunks.get(cx + cy * 4096);
          if (c) { c.lastUse = now; visible.push(c); }
          else missing.push([cx, cy, Math.hypot((cx + 0.5) * CPX - (vx0 + vx1) / 2, (cy + 0.5) * CPX - (vy0 + vy1) / 2)]);
        }
      missing.sort((a, b) => a[2] - b[2]);
      // small dimensions compose everything at once (no placeholder flash); big ones a few per frame
      const budget = visible.length === 0 && missing.length <= 9 ? missing.length : 3;
      const pinned = new Set(visible);
      this.evict(pinned, Math.max(CHUNK_BUDGET - budget, pinned.size));
      for (const [cx, cy] of missing.slice(0, budget)) {
        const c = this.composeChunk(d, cx, cy);
        visible.push(c);
        pinned.add(c);
      }
      litStats.chunksComposedLastFrame = Math.min(budget, missing.length);
      missing = missing.slice(budget);
    } else litStats.chunksComposedLastFrame = 0;
    litStats.pendingChunks = missing.length;
    litStats.chunksLive = this.chunkCount();
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // ---- pass A: screen G-buffer (overview below, chunks dithered in over it, objects on top)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gFbo);
    gl.viewport(0, 0, iw, ih);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pb = this.pBlit;
    gl.useProgram(pb.p);
    gl.uniform1i(pb.u.uA, 0); gl.uniform1i(pb.u.uN, 1); gl.uniform1i(pb.u.uE, 2); gl.uniform1i(pb.u.uT, 3);
    gl.bindVertexArray(this.vaoEmpty);
    const ovK = k * TILE_PX / d.ov.opx;
    if (fade < 1 || missing.length) this.blitLayer(d.ovTex, offX, offY, ovK, d.ov.w, d.ov.h, 1, iw, ih);
    if (fade > 0) for (const c of visible) this.blitLayer(c.tex, offX + c.cx * CPX * k, offY + c.cy * CPX * k, k, CPX, CPX, fade, iw, ih);
    // copy the terrain tile ids: sprites test against them for occlusion by raised ground further south
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.gFbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT3);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.occFbo);
    gl.blitFramebuffer(0, 0, iw, ih, 0, 0, iw, ih, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gFbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    this.syncAtlas();
    this.syncChars();

    // standing sprites: props from the grid, objects, characters (depth = row order, occluded by terrain)
    const fr = this.sheet.frames;
    const wx0 = Math.floor(vx0 / TILE_PX) - 1, wx1 = Math.ceil(vx1 / TILE_PX) + 1;
    const wy0 = Math.floor((vy0 - lay.top) / TILE_PX) - 1, wy1 = Math.ceil((vy1 - lay.top + lay.maxLiftPx) / TILE_PX) + 3;
    // caster region (world tiles): the view plus the reach of shadows toward the sun
    const sdir = sun ? sun.dir : mood.keyDir;
    const tanE = Math.max(0.12, sdir[2] / Math.max(1e-3, Math.hypot(sdir[0], sdir[1])));
    const reach = Math.min(9, 3.4 / tanE + 1);
    const ux = sdir[0] / Math.max(1e-3, Math.hypot(sdir[0], sdir[1])), uy = sdir[1] / Math.max(1e-3, Math.hypot(sdir[0], sdir[1]));
    const cr = {
      x0: Math.floor(wx0 + Math.min(0, ux * reach)) - 2, x1: Math.ceil(wx1 + Math.max(0, ux * reach)) + 2,
      y0: Math.floor(wy0 + Math.min(0, uy * reach)) - 2, y1: Math.ceil(wy1 + Math.max(0, uy * reach)) + 2,
    };
    let castR = 16;
    while (castR > 1 && ((cr.x1 - cr.x0) * castR > 1024 || (cr.y1 - cr.y0) * castR > 1024)) castR /= 2;
    cr.x1 = Math.min(cr.x1, cr.x0 + Math.floor(1024 / castR));
    cr.y1 = Math.min(cr.y1, cr.y0 + Math.floor(1024 / castR));
    const shadowsOn = G.shadows !== 'off' && fade > 0;
    const card = G.shadows === 'flat';
    const pi = this.propInst, ci = this.castInst, ai = this.charInst, aci = this.castCharInst;
    pi.n = ci.n = ai.n = aci.n = 0;
    const night = sun ? sun.night : mood.outdoor ? 0 : 1;
    const pushCaster = (buf: InstBuf, frm: { x: number; y: number; w: number; h: number; ox: number; oy: number; ty: number }, gx: number, gy: number, L: number, flip: boolean) => {
      if (card) buf.push(gx * TILE_PX - frm.ox, gy * TILE_PX + 9, frm.w, 2, frm.x, frm.y, frm.oy, frm.h, L, 0, 0, 256 | (flip ? 128 : 0));
      else buf.push(gx * TILE_PX - frm.ox, gy * TILE_PX - frm.ty, frm.w, frm.h, frm.x, frm.y, -1, -1, L, 0, 0, flip ? 128 : 0);
    };
    if (fade > 0 || shadowsOn) {
      const px0 = shadowsOn ? Math.min(wx0, cr.x0) : wx0, px1 = shadowsOn ? Math.max(wx1, cr.x1) : wx1;
      const py0 = shadowsOn ? Math.min(wy0, cr.y0) : wy0, py1 = shadowsOn ? Math.max(wy1, cr.y1) : wy1;
      const W = f.dim.w;
      forProps(d.props, f.dim, px0, py0, px1, py1, (i) => {
        const look = propLook(f.dim, d.props, i, this.sheet, this.seed);
        if (!look) return;
        const x = i % W, y = (i / W) | 0, L = standOf(lay, i), fm = look.frame;
        if (fade > 0 && x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1)
          pi.push(x * TILE_PX - fm.ox, lay.top + y * TILE_PX - L - fm.oy, fm.w, fm.h, fm.x, fm.y, -1, -1, L / TILE_PX, x, y, 2048, look.r, look.g, look.b, look.windows ? night * 1.2 : 1);
        if (shadowsOn && x >= cr.x0 && x <= cr.x1 && y >= cr.y0 && y <= cr.y1) pushCaster(ci, fm, x, y, L / TILE_PX, false);
      });
    }
    let nObj = 0;
    if (s >= 4) {
      for (const { o, done, attach, alpha } of f.objs) {
        const key = objectKey(o, done, this.sheet, f.dim);
        if (!key) continue;
        const frm = fr.get(key)![0];
        const i = o.y * f.dim.w + o.x;
        const L = standOf(lay, i);
        const tint = o.kind === 'gate' && o.gate === 'guard' ? [0.85, 0.45, 0.2] : [1, 1, 1];
        const dy = attach && wallStyle(o, key) ? -13 : 0;
        const dx = o.kind === 'gate' && o.gate === 'guard' && done ? 9 : 0;
        const e = (o.gate as string) === 'moon' ? 0.3 + night * 1.4 : (o.gate as string) === 'sun' ? 0.3 + (1 - night) * 1.4 : 1;
        if (fade > 0) { pi.push(o.x * TILE_PX - frm.ox + dx, lay.top + o.y * TILE_PX - L - frm.oy + dy, frm.w, frm.h, frm.x, frm.y, -2, alpha, L / TILE_PX, o.x, o.y, 64 | 1024, tint[0], tint[1], tint[2], e); nObj++; }
        if (shadowsOn && !dy && alpha > 0.5) pushCaster(ci, frm, o.x + dx / TILE_PX, o.y, L / TILE_PX, false);
      }
      const ca = charAtlas();
      for (const a of f.actors) {
        const dir = a.dir === 'w' ? 'e' : a.dir;
        const cf = ca.get(a.kind, a.clip, dir) || ca.get(a.kind, 'idle', dir) || ca.get(a.kind, 'idle', 's');
        if (!cf) { ca.request(a.kind); continue; }
        const frm = cf.frames[Math.floor(a.at * cf.fps) % cf.frames.length];
        const flip = a.dir === 'w';
        const L = standOf(lay, a.tile);
        const tx = a.tile % f.dim.w, ty = (a.tile / f.dim.w) | 0;
        if (fade > 0) ai.push(Math.round(a.x * TILE_PX) - frm.ox, lay.top + Math.round(a.y * TILE_PX) - L - frm.oy, frm.w, frm.h, frm.x, frm.y, -2, a.alpha, L / TILE_PX, tx, ty, 64 | 512 | (flip ? 128 : 0), a.tint[0], a.tint[1], a.tint[2], a.e);
        if (shadowsOn && a.alpha > 0.5) pushCaster(aci, frm, a.x, a.y, L / TILE_PX, flip);
      }
    }
    this.lastCounts = { props: pi.n - nObj, casters: ci.n + aci.n, actors: ai.n, objects: nObj };
    litStats.counts = this.lastCounts;
    if (pi.n || ai.n) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      this.drawSprites(pi, k, offX, offY, iw, ih, this.atlas, { lift: d.liftTex }, fade);
      this.drawSprites(ai, k, offX, offY, iw, ih, this.charTex, { lift: d.liftTex }, fade);
      gl.disable(gl.DEPTH_TEST);
    }

    // ---- world-space shadow caster height map (R = props / characters, G = terrain)
    if (shadowsOn || G.terrainShadows) {
      const cw = (cr.x1 - cr.x0) * castR, ch = (cr.y1 - cr.y0) * castR;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.castFbo);
      gl.viewport(0, 0, cw, ch);
      const pt = this.pTerrH;
      gl.useProgram(pt.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, d.liftTex);
      gl.uniform1i(pt.u.uLift, 0);
      gl.uniform4fv(pt.u.uWallP, lay.walls!.main);
      gl.uniform4fv(pt.u.uWallL, lay.walls!.lip);
      gl.uniform2f(pt.u.uOrigin, cr.x0, cr.y0);
      gl.uniform1f(pt.u.uR, castR);
      gl.uniform2i(pt.u.uDim, f.dim.w, f.dim.h);
      gl.bindVertexArray(this.vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (shadowsOn && (ci.n || aci.n)) {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.blendFunc(gl.ONE, gl.ONE);
        const drawCast = (buf: InstBuf, top: WebGLTexture, alb: WebGLTexture) => {
          if (!buf.n) return;
          const pc = this.pCaster;
          gl.useProgram(pc.p);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, top);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, alb);
          gl.uniform1i(pc.u.uTop, 0);
          gl.uniform1i(pc.u.uA, 1);
          gl.uniform2f(pc.u.uOff, -cr.x0 * castR, -cr.y0 * castR);
          gl.uniform1f(pc.u.uK, castR / TILE_PX);
          gl.uniform2f(pc.u.uTarget, cw, ch);
          gl.bindVertexArray(this.vaoSprite);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
          gl.bufferData(gl.ARRAY_BUFFER, buf.f.subarray(0, buf.n * FLOATS), gl.DYNAMIC_DRAW);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, buf.n);
          gl.bindVertexArray(null);
        };
        drawCast(ci, this.topTex!, this.atlas[0]);
        drawCast(aci, this.charTex[3], this.charTex[0]);
        gl.blendEquation(gl.FUNC_ADD);
        gl.disable(gl.BLEND);
      }
    }

    // ---- pass B: lighting
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.litFbo);
    gl.viewport(0, 0, iw, ih);
    const pl = this.pLight;
    gl.useProgram(pl.p);
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.gTex[i]);
    }
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, d.mask);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, gd ? gd.ovTex[0] : d.ovTex[0]);
    gl.uniform1i(pl.u.gA, 0); gl.uniform1i(pl.u.gN, 1); gl.uniform1i(pl.u.gE, 2); gl.uniform1i(pl.u.gT, 3);
    gl.uniform1i(pl.u.uMask, 4); gl.uniform1i(pl.u.uGhost, 5);
    gl.uniform2f(pl.u.uOff, offX, offY);
    gl.uniform1f(pl.u.uK, k);
    gl.uniform1f(pl.u.uTop, lay.top);
    gl.uniform2f(pl.u.uIS, iw, ih);
    gl.uniform3fv(pl.u.uKeyDir, sdir);
    gl.uniform3fv(pl.u.uKeyCol, sun ? sun.keyCol : mood.keyCol);
    const at = sun ? sun.ambTint : [1, 1, 1], am = sun ? sun.amb : 1;
    gl.uniform3f(pl.u.uAmbTop, mood.ambTop[0] * at[0] * am, mood.ambTop[1] * at[1] * am, mood.ambTop[2] * at[2] * am);
    gl.uniform3f(pl.u.uAmbBot, mood.ambBot[0] * at[0] * am, mood.ambBot[1] * at[1] * am, mood.ambBot[2] * at[2] * am);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.castTex);
    gl.uniform1i(pl.u.uCast, 6);
    gl.uniform2f(pl.u.uCastO, cr.x0, cr.y0);
    gl.uniform1f(pl.u.uCastR, castR);
    gl.uniform2f(pl.u.uCastSize, (cr.x1 - cr.x0) * castR, (cr.y1 - cr.y0) * castR);
    gl.uniform3fv(pl.u.uSun, sdir);
    const shadowAny = (shadowsOn || G.terrainShadows) && s >= 3 && (mood.shadowLen > 0 || mood.outdoor);
    gl.uniform1f(pl.u.uShadowMode, shadowAny ? 1 : 0);
    gl.uniform1f(pl.u.uShadowStr, G.shadowStrength * (sun ? sun.shadowK : 1));
    gl.uniform1f(pl.u.uShadowSoft, Math.min(1, G.shadowSoftness + (sun ? sun.night * 0.6 : 0)));
    gl.uniform1f(pl.u.uTerrainSh, G.terrainShadows ? 1 : 0);
    gl.uniform1f(pl.u.uContact, G.contactShadows);
    gl.uniform1f(pl.u.uAmbK, G.ambient);
    gl.uniform1f(pl.u.uSunK, G.sunStrength);
    gl.uniform1f(pl.u.uPointK, G.pointLights * (0.5 + 0.7 * night));
    gl.uniform1f(pl.u.uSea, f.dim.kind === 'overworld' ? 1 : 0);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, d.ovTex[0]);
    gl.uniform1i(pl.u.uOvA, 7);
    gl.uniform1f(pl.u.uOvP, d.ov.opx);
    gl.uniform1f(pl.u.uOvTop, d.ov.topT);
    gl.uniform2f(pl.u.uOvSize, d.ov.w, d.ov.h);
    gl.uniform1f(pl.u.uFogDark, G.fogDarkness);
    gl.uniform1f(pl.u.uFogDesat, G.fogDesaturation);
    gl.uniform1f(pl.u.uWaterK, G.water);
    gl.uniform1f(pl.u.uFoamK, G.waterFoam);
    gl.uniform1f(pl.u.uGlintK, G.waterGlint);
    gl.uniform4f(pl.u.uGlintP, G.waterGlintDensity, 16 / Math.max(1, G.waterGlintSize), G.waterGlintCrest, G.waterGlintLowSun);
    gl.uniform1f(pl.u.uGlintPL, G.waterGlintLights);
    gl.uniform3fv(pl.u.uBg0, mood.bg0);
    gl.uniform3fv(pl.u.uBg1, mood.bg1);
    gl.uniform3fv(pl.u.uFogTint, mood.fogTint);
    gl.uniform3fv(pl.u.uGhostTint, mood.ghostTint);
    gl.uniform1f(pl.u.uTime, f.t);
    gl.uniform1f(pl.u.uMotion, f.motion ? 1 : 0);
    gl.uniform1f(pl.u.uFresh, f.fresh);
    gl.uniform1f(pl.u.uHdr, this.hdr ? 1 : 0.5);
    gl.uniform1f(pl.u.uRock, mood.rock);
    if (gd) {
      // blur level: about 2 css px of the ghost overview per screen px
      const gScale = gd.ov.opx / TILE_PX;
      const lod = Math.max(0, Math.log2(Math.max(1, (gd.ov.opx * 3) / Math.max(0.5, s / 4))));
      gl.uniform4f(pl.u.uGhost0, 1, gd.lay.top, gScale, lod);
      gl.uniform2f(pl.u.uGhostSize, gd.ov.w, gd.ov.h);
    } else {
      gl.uniform4f(pl.u.uGhost0, 0, 0, 1, 0);
      gl.uniform2f(pl.u.uGhostSize, 1, 1);
    }
    // lights: spatial-grid query around the view; the ones with the largest on-screen contribution win
    // (with hysteresis), and lights entering / leaving the active set fade over ~0.4 s. A light that
    // cannot reach any visible pixel (further outside the view than its radius) is dropped at once.
    let nl = 0;
    if (this.lightDim !== d.id) { this.lightW.clear(); this.lightDim = d.id; }
    if (s >= 5) {
      const wx0 = vx0 / TILE_PX, wx1 = vx1 / TILE_PX, wy0 = (vy0 - lay.top) / TILE_PX, wy1 = (vy1 - lay.top) / TILE_PX + 2;
      const cand: { l: Light; key: string; score: number }[] = [];
      const seen = new Set<string>();
      const consider = (l: Light) => {
        const ly = l.y - l.z;
        if (l.x + l.r < wx0 || l.x - l.r > wx1 || ly + l.r < wy0 || ly - l.r > wy1) return;
        const key = l.id ?? `${l.x},${l.y},${l.z}`;
        if (seen.has(key)) return;
        seen.add(key);
        const cov = ((Math.min(wx1, l.x + l.r) - Math.max(wx0, l.x - l.r)) * (Math.min(wy1, ly + l.r) - Math.max(wy0, ly - l.r))) / (4 * l.r * l.r);
        const prev = this.lightW.get(key) ?? 0;
        cand.push({ l, key, score: (l.c[0] + l.c[1] + l.c[2]) * l.r * l.r * Math.max(0.05, cov) * (prev > 0 ? 1.35 : 1) });
      };
      d.lights.query(wx0, wy0, wx1, wy1, consider);
      for (const l of f.lights) consider(l);
      cand.sort((a, b) => b.score - a.score);
      const maxN = Math.min(MAX_LIGHTS - 4, G.maxLights);
      const step = f.motion ? f.dt / 0.4 : 1;
      const act: { l: Light; w: number; score: number }[] = [];
      cand.forEach((c, k) => {
        const prev = this.lightW.get(c.key) ?? 0;
        const w = k < maxN ? Math.min(1, prev + step) : Math.max(0, prev - step);
        if (w > 0) { this.lightW.set(c.key, w); act.push({ l: c.l, w, score: c.score }); } else this.lightW.delete(c.key);
      });
      for (const key of [...this.lightW.keys()]) if (!seen.has(key)) this.lightW.delete(key); // off screen: gone at once
      act.sort((a, b) => b.score * b.w - a.score * a.w);
      nl = Math.min(MAX_LIGHTS, act.length);
      for (let i = 0; i < nl; i++) {
        const { l, w } = act[i];
        this.lp.set([l.x, l.y, l.z, l.r], i * 4);
        this.lc.set([l.c[0] * w, l.c[1] * w, l.c[2] * w, l.pulse], i * 4);
      }
      litStats.lightsActive = nl;
    }
    // point-light shadows for the strongest lights when zoomed in (faded in around the zoom threshold)
    const lsN = G.lightShadows === 'off' ? 0 : G.lightShadows === 'all' ? nl : Math.min(nl, Number(G.lightShadows));
    const lsK = lsN ? Math.min(1, Math.max(0, (s - G.lightShadowsZoom + 3) / 6)) : 0;
    gl.uniform1i(pl.u.uLSN, lsK > 0 ? lsN : 0);
    gl.uniform1f(pl.u.uLSK, lsK);
    gl.uniform1f(pl.u.uLSSoft, G.lightShadowsSoftness);
    gl.uniform4fv(pl.u.uLP, this.lp);
    gl.uniform4fv(pl.u.uLC, this.lc);
    gl.uniform1i(pl.u.uNL, nl);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- particles (additive, feed the bloom)
    if (f.particles && f.particles.list.length) {
      const L = f.particles.list;
      let n = 0;
      const pd = this.pointData;
      const zs = Math.max(0.6, Math.min(2.2, s / 22)) * rs;
      for (const p of L) {
        if (n >= 320) break;
        const u = p.life / p.max;
        let a = Math.min(1, u * 5, (1 - u) * 4);
        if (p.k === 'firefly') a *= 0.55 + 0.45 * Math.sin(f.t * 4 + p.ph * 5);
        if (p.k === 'glint' || p.k === 'sparkle') a *= Math.sin(u * Math.PI) * 1.4;
        if (p.k === 'wisp') a *= 0.12;
        const c = this.rgb(p.col);
        const o = n * 7;
        pd[o] = (p.x * TILE_PX) * k + offX;
        pd[o + 1] = (p.y * TILE_PX + lay.top) * k + offY;
        pd[o + 2] = Math.max(2, (p.k === 'wisp' ? p.size * 0.8 : p.size * 0.9) * zs);
        pd[o + 3] = Math.max(0, a) * (p.k === 'snow' || p.k === 'leaf' ? 0.7 : 1.3);
        pd[o + 4] = c[0]; pd[o + 5] = c[1]; pd[o + 6] = c[2];
        n++;
      }
      if (n) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const pp = this.pPoint;
        gl.useProgram(pp.p);
        gl.uniform2f(pp.u.uTarget, iw, ih);
        gl.uniform1f(pp.u.uHdr, this.hdr ? 1 : 0.5);
        gl.bindVertexArray(this.vaoPoint);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pd.subarray(0, n * 7), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.POINTS, 0, n);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
    }

    // ---- bloom (quarter res)
    const bw = Math.max(1, Math.ceil(iw / 4)), bh = Math.max(1, Math.ceil(ih / 4));
    gl.viewport(0, 0, bw, bh);
    gl.bindVertexArray(this.vaoEmpty);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[0]);
    gl.useProgram(this.pBright.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.litTex);
    gl.uniform1i(this.pBright.u.uSrc, 0);
    gl.uniform2f(this.pBright.u.uSrcSize, iw, ih);
    gl.uniform1f(this.pBright.u.uThr, mood.bloomThr * (G.bloomThreshold / 0.85));
    gl.uniform1f(this.pBright.u.uExp, mood.exposure * G.exposure);
    gl.uniform1f(this.pBright.u.uHdr, this.hdr ? 1 : 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const blur = (src: number, dst: number, dx: number, dy: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[dst]);
      gl.useProgram(this.pBlur.p);
      gl.bindTexture(gl.TEXTURE_2D, this.bTex[src]);
      gl.uniform1i(this.pBlur.u.uSrc, 0);
      gl.uniform2f(this.pBlur.u.uDir, dx * G.bloomRadius, dy * G.bloomRadius);
      gl.uniform2f(this.pBlur.u.uSize, bw, bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    blur(0, 1, 1, 0);
    blur(1, 0, 0, 1);
    blur(0, 1, 2.5, 0);
    blur(1, 2, 0, 2.5);

    // ---- composite to the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, iw, ih);
    const pc = this.pComp;
    gl.useProgram(pc.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.litTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bTex[0]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bTex[2]);
    gl.uniform1i(pc.u.uLit, 0); gl.uniform1i(pc.u.uB1, 1); gl.uniform1i(pc.u.uB2, 2);
    gl.uniform2f(pc.u.uOut, iw, ih);
    gl.uniform1f(pc.u.uHdr, this.hdr ? 1 : 0.5);
    gl.uniform1f(pc.u.uBloom, mood.bloom * G.bloom);
    gl.uniform1f(pc.u.uSat, mood.sat * G.saturation);
    gl.uniform1f(pc.u.uContrast, mood.contrast * G.contrast);
    gl.uniform1f(pc.u.uVig, mood.vig * G.vignette);
    gl.uniform1f(pc.u.uExp, mood.exposure * G.exposure);
    gl.uniform1i(pc.u.uTone, ({ filmic: 0, reinhard: 1, punchy: 2, none: 3 } as Record<string, number>)[G.toneMap] ?? 0);
    gl.uniform1f(pc.u.uTime, f.t);
    gl.uniform1f(pc.u.uMotion, f.motion ? 1 : 0);
    gl.uniform1f(pc.u.uHaze, mood.haze);
    gl.uniform3fv(pc.u.uShadowTint, mood.shadowTint);
    gl.uniform3fv(pc.u.uHighTint, mood.highTint);
    gl.uniform3fv(pc.u.uHazeCol, mood.hazeCol);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (!this.errLogged) {
      const e = gl.getError();
      if (e && !gl.isContextLost()) { console.warn('GL error 0x' + e.toString(16)); this.errLogged = true; }
    }
    litStats.lastFrameMs = performance.now() - t0;
    litStats.worstFrameMs = Math.max(litStats.worstFrameMs, litStats.lastFrameMs);
  }

  /** bake a few deferred sprites and upload what changed in the main atlas */
  private syncAtlas() {
    bakeStep(5);
    const sh = this.sheet;
    if (!sh.dirty || !sh.dirty.length) return;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sh.w);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const r of sh.dirty) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
      const layers = [sh.albedo, sh.normal, sh.emissive];
      for (let i = 0; i < 3; i++) {
        gl.bindTexture(gl.TEXTURE_2D, this.atlas[i]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(layers[i].buffer));
      }
      gl.bindTexture(gl.TEXTURE_2D, this.topTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RED, gl.UNSIGNED_BYTE, sh.top);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    sh.dirty.length = 0;
  }

  /** upload character frames baked since the last frame */
  private syncChars() {
    const ca = charAtlas();
    ca.step(6);
    if (!ca.dirty.length) return;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, CHAR_W);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const r of ca.dirty) {
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
      const layers = [ca.albedo, ca.normal, ca.emissive];
      for (let i = 0; i < 3; i++) {
        gl.bindTexture(gl.TEXTURE_2D, this.charTex[i]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(layers[i].buffer));
      }
      gl.bindTexture(gl.TEXTURE_2D, this.charTex[3]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RED, gl.UNSIGNED_BYTE, ca.top);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    ca.dirty.length = 0;
  }

  /** world-tile bounds of the static lights / tiles: for tests */
  stats() {
    return { dims: this.dims.size, chunks: this.chunkCount(), ...glStats };
  }

  destroy() {
    const gl = this.gl;
    this.freeDims();
    if (!this.lost) {
      this.atlas.forEach((t) => delTexture(gl, t));
      this.charTex.forEach((t) => delTexture(gl, t));
      delTexture(gl, this.topTex);
      delTexture(gl, this.castTex);
      delTexture(gl, this.occTex);
      delFramebuffer(gl, this.castFbo);
      delFramebuffer(gl, this.occFbo);
      this.gTex.forEach((t) => delTexture(gl, t));
      delTexture(gl, this.litTex);
      this.bTex.forEach((t) => delTexture(gl, t));
      delFramebuffer(gl, this.gFbo);
      delFramebuffer(gl, this.litFbo);
      this.bFbo.forEach((f) => delFramebuffer(gl, f));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.canvas.removeEventListener('webglcontextlost', this.onLostEv);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestoredEv);
  }
}
