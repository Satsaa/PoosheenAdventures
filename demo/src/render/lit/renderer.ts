// WebGL2 lit renderer: per-dimension static G-buffer (composed once from the sprite atlas), then per
// frame: screen G-buffer (static blit + dynamic object sprites) -> toon-banded lighting with coloured
// point lights and height-field shadows -> additive particles -> bloom -> grade/vignette composite.
import type { DimId, Dimension, MapObject, World } from '../../core/types';
import { bakeAtlas, lastBakeMs } from '../bake/index';
import type { AssetSheet } from '../bake/sheet';
import { TILE_PX } from '../bake/sheet';
import type { Particles } from '../particles';
import { npcColor } from '../objects';
import { hexRgb } from '../util';
import { FLOATS, InstBuf, type Layout, buildStatic, layout, objectKey, wallStyle } from './compose';
import { type Prog, delFramebuffer, delTexture, framebuffer, glStats, program, texture } from './gl';
import { type Light, type Mood, moodFor, staticLights } from './lights';
import {
  BLIT_FS, BLUR_FS, BRIGHT_FS, COMPOSITE_FS, FULL_VS, LIGHT_FS, MAX_LIGHTS, POINT_FS, POINT_VS, SPRITE_FS, SPRITE_VS,
} from './shaders';

export interface DimMetaIn {
  ve: Float32Array;
  voidElev: number;
}

export interface ObjDraw {
  o: MapObject;
  done: boolean;
  attach: boolean;
}

export interface LitFrame {
  dim: Dimension;
  meta: DimMetaIn;
  cam: { x: number; y: number; s: number };
  cssW: number;
  cssH: number;
  dpr: number;
  t: number;
  motion: boolean;
  ghost: { dim: Dimension; meta: DimMetaIn } | null;
  objs: ObjDraw[];
  lights: Light[];
  particles: Particles | null;
  fresh: number;
}

interface DimGL {
  id: DimId;
  lay: Layout;
  tex: WebGLTexture[];
  fbo: WebGLFramebuffer;
  lights: Light[];
  mask: WebGLTexture;
  maskData: Uint8Array;
  mood: Mood;
  px: number;
  lastUse: number;
}

export const litStats = { atlasMs: 0, composeMs: [] as number[], maskMs: 0, lastFrameMs: 0 };

const MAX_INTERNAL_PX = 1.6e6;

export class LitRenderer {
  gl!: WebGL2RenderingContext;
  lost = false;
  onLost: (() => void) | null = null;
  onRestored: (() => void) | null = null;
  private sheet!: AssetSheet;
  private atlas: WebGLTexture[] = [];
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
  private lp = new Float32Array(MAX_LIGHTS * 4);
  private lc = new Float32Array(MAX_LIGHTS * 4);
  private colCache = new Map<string, [number, number, number]>();
  private onLostEv = (e: Event) => { e.preventDefault(); this.lost = true; this.dims.clear(); this.onLost?.(); };
  private onRestoredEv = () => {
    try { this.init(); this.lost = false; this.onRestored?.(); } catch (err) { console.error(err); }
  };

  static create(canvas: HTMLCanvasElement): LitRenderer | null {
    try {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) return null;
      const r = new LitRenderer(canvas, gl);
      return r;
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
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    const t0 = performance.now();
    this.sheet = bakeAtlas();
    litStats.atlasMs = lastBakeMs || performance.now() - t0;
    const s = this.sheet;
    this.atlas = [s.albedo, s.normal, s.emissive].map((d) => texture(gl, s.w, s.h, { data: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) }));
    this.pSprite = program(gl, SPRITE_VS, SPRITE_FS, 'sprite');
    this.pBlit = program(gl, FULL_VS, BLIT_FS, 'blit');
    this.pLight = program(gl, FULL_VS, LIGHT_FS, 'light');
    this.pPoint = program(gl, POINT_VS, POINT_FS, 'point');
    this.pBright = program(gl, FULL_VS, BRIGHT_FS, 'bright');
    this.pBlur = program(gl, FULL_VS, BLUR_FS, 'blur');
    this.pComp = program(gl, FULL_VS, COMPOSITE_FS, 'composite');
    // sprite VAO: unit quad + per-instance attributes
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

  get hdrSupported() { return this.hdr; }

  setWorld(world: World, seed: number) {
    this.world = world;
    this.seed = seed;
    this.freeDims();
  }

  private freeDims(keep?: Set<DimId>) {
    const gl = this.gl;
    for (const [id, d] of this.dims) {
      if (keep?.has(id)) continue;
      if (!this.lost) {
        d.tex.forEach((t) => delTexture(gl, t));
        delTexture(gl, d.mask);
        delFramebuffer(gl, d.fbo);
      }
      this.dims.delete(id);
    }
  }

  /** Compose (or fetch) the static G-buffer of a dimension. */
  prepare(dim: Dimension, meta: DimMetaIn): DimGL {
    let d = this.dims.get(dim.id);
    if (d) { d.lastUse = performance.now(); return d; }
    const gl = this.gl;
    const t0 = performance.now();
    const lay = layout(dim, meta.ve, meta.voidElev);
    const st = buildStatic(dim, lay, this.sheet, this.seed);
    const mip = { min: gl.LINEAR_MIPMAP_LINEAR, mag: gl.NEAREST };
    const tex = [texture(gl, lay.W, lay.H, mip), texture(gl, lay.W, lay.H, mip), texture(gl, lay.W, lay.H, mip), texture(gl, lay.W, lay.H)];
    const fbo = framebuffer(gl, tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, lay.W, lay.H);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawSprites(st.inst, 1, 0, 0, lay.W, lay.H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let k = 0; k < 3; k++) {
      gl.bindTexture(gl.TEXTURE_2D, tex[k]);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    const maskData = new Uint8Array(dim.w * dim.h * 4);
    const mask = texture(gl, dim.w, dim.h, { data: maskData });
    d = {
      id: dim.id, lay, tex, fbo, mask, maskData, lights: staticLights(dim, lay, st, this.sheet, this.seed),
      mood: moodFor(this.world, dim), px: lay.W * lay.H, lastUse: performance.now(),
    };
    this.dims.set(dim.id, d);
    litStats.composeMs.push(performance.now() - t0);
    if (litStats.composeMs.length > 50) litStats.composeMs.shift();
    // keep GPU memory bounded: evict least recently used dimensions
    let total = 0;
    for (const x of this.dims.values()) total += x.px;
    if (total > 14e6) {
      const old = [...this.dims.values()].filter((x) => x !== d).sort((a, b) => a.lastUse - b.lastUse);
      const keep = new Set(this.dims.keys());
      for (const o of old) { if (total <= 10e6) break; total -= o.px; keep.delete(o.id); }
      this.freeDims(keep);
    }
    return d;
  }

  layoutOf(dim: Dimension, meta: DimMetaIn): Layout {
    return this.dims.get(dim.id)?.lay ?? layout(dim, meta.ve, meta.voidElev);
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

  private drawSprites(inst: InstBuf, k: number, ox: number, oy: number, tw: number, th: number) {
    if (!inst.n) return;
    const gl = this.gl, p = this.pSprite;
    gl.useProgram(p.p);
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.atlas[i]);
    }
    gl.uniform1i(p.u.uA, 0);
    gl.uniform1i(p.u.uN, 1);
    gl.uniform1i(p.u.uE, 2);
    gl.uniform2f(p.u.uOff, ox, oy);
    gl.uniform1f(p.u.uK, k);
    gl.uniform2f(p.u.uTarget, tw, th);
    gl.bindVertexArray(this.vaoSprite);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.f.subarray(0, inst.n * FLOATS), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, inst.n);
    gl.bindVertexArray(null);
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

  render(f: LitFrame) {
    if (this.lost) return;
    const gl = this.gl;
    const t0 = performance.now();
    const rs = Math.min(f.dpr, Math.sqrt(MAX_INTERNAL_PX / Math.max(1, f.cssW * f.cssH)), 2);
    const iw = Math.max(1, Math.round(f.cssW * rs)), ih = Math.max(1, Math.round(f.cssH * rs));
    if (this.canvas.width !== iw || this.canvas.height !== ih) { this.canvas.width = iw; this.canvas.height = ih; }
    this.ensureTargets(iw, ih);
    const d = this.prepare(f.dim, f.meta);
    const gd = f.ghost ? this.prepare(f.ghost.dim, f.ghost.meta) : null;
    d.lastUse = performance.now();
    const lay = d.lay, mood = d.mood;
    const s = f.cam.s;
    const k = (s * rs) / TILE_PX;
    const offX = Math.round((f.cssW / 2 - f.cam.x * s) * rs);
    const offY = Math.round((f.cssH / 2 - f.cam.y * s) * rs - lay.top * k);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // ---- pass A: screen G-buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gFbo);
    gl.viewport(0, 0, iw, ih);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pb = this.pBlit;
    gl.useProgram(pb.p);
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, d.tex[i]);
    }
    gl.uniform1i(pb.u.uA, 0); gl.uniform1i(pb.u.uN, 1); gl.uniform1i(pb.u.uE, 2); gl.uniform1i(pb.u.uT, 3);
    gl.uniform2f(pb.u.uOff, offX, offY);
    gl.uniform1f(pb.u.uK, k);
    gl.uniform2f(pb.u.uTex, lay.W, lay.H);
    gl.bindVertexArray(this.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // dynamic objects
    const oi = this.objInst;
    oi.n = 0;
    const fr = this.sheet.frames;
    for (const { o, done, attach } of f.objs) {
      const key = objectKey(o, done, this.sheet);
      if (!key) continue;
      const fl = fr.get(key)!;
      const frm = fl[0];
      const i = o.y * f.dim.w + o.x;
      const L = lay.liftPx[i] ?? 0;
      const tint = o.kind === 'npc' ? hexRgb(npcColor(o)).map((v) => v / 255) : o.kind === 'gate' && o.gate === 'guard' ? [0.85, 0.45, 0.2] : [1, 1, 1];
      const dy = attach && wallStyle(o, key) ? -13 : 0;
      const dx = o.kind === 'gate' && o.gate === 'guard' && done ? 9 : 0;
      oi.push(o.x * TILE_PX - frm.ox + dx, lay.top + o.y * TILE_PX - L - frm.oy + dy, frm.w, frm.h, frm.x, frm.y, -1, -1, L / TILE_PX, o.x, o.y, 64, tint[0], tint[1], tint[2], 1);
    }
    this.drawSprites(oi, k, offX, offY, iw, ih);

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
    gl.bindTexture(gl.TEXTURE_2D, gd ? gd.tex[0] : d.tex[0]);
    gl.uniform1i(pl.u.gA, 0); gl.uniform1i(pl.u.gN, 1); gl.uniform1i(pl.u.gE, 2); gl.uniform1i(pl.u.gT, 3);
    gl.uniform1i(pl.u.uMask, 4); gl.uniform1i(pl.u.uGhost, 5);
    gl.uniform2f(pl.u.uOff, offX, offY);
    gl.uniform1f(pl.u.uK, k);
    gl.uniform1f(pl.u.uTop, lay.top);
    gl.uniform2f(pl.u.uIS, iw, ih);
    gl.uniform3fv(pl.u.uKeyDir, mood.keyDir);
    gl.uniform3fv(pl.u.uKeyCol, mood.keyCol);
    gl.uniform3fv(pl.u.uAmbTop, mood.ambTop);
    gl.uniform3fv(pl.u.uAmbBot, mood.ambBot);
    gl.uniform3fv(pl.u.uBg0, mood.bg0);
    gl.uniform3fv(pl.u.uBg1, mood.bg1);
    gl.uniform3fv(pl.u.uFogTint, mood.fogTint);
    gl.uniform3fv(pl.u.uGhostTint, mood.ghostTint);
    gl.uniform1f(pl.u.uTime, f.t);
    gl.uniform1f(pl.u.uMotion, f.motion ? 1 : 0);
    gl.uniform1f(pl.u.uFresh, f.fresh);
    gl.uniform1f(pl.u.uHdr, this.hdr ? 1 : 0.5);
    gl.uniform1f(pl.u.uRock, mood.rock);
    gl.uniform1f(pl.u.uShadowLen, mood.shadowLen);
    gl.uniform4f(pl.u.uGhost0, gd ? 1 : 0, gd ? gd.lay.top : 0, gd ? gd.lay.W : 1, gd ? gd.lay.H : 1);
    // lights: cull to view, keep the strongest MAX_LIGHTS
    const vx0 = f.cam.x - f.cssW / 2 / s, vx1 = f.cam.x + f.cssW / 2 / s;
    const vy0 = f.cam.y - f.cssH / 2 / s, vy1 = f.cam.y + f.cssH / 2 / s + 2;
    const cand: [Light, number][] = [];
    const consider = (l: Light) => {
      if (l.x + l.r < vx0 || l.x - l.r > vx1 || l.y - l.z + l.r < vy0 || l.y - l.z - l.r > vy1) return;
      const dc = Math.hypot(l.x - f.cam.x, l.y - f.cam.y) / Math.max(4, (vx1 - vx0) * 0.5);
      cand.push([l, (l.c[0] + l.c[1] + l.c[2]) * l.r / (1 + dc * dc)]);
    };
    for (const l of d.lights) consider(l);
    for (const l of f.lights) consider(l);
    cand.sort((a, b) => b[1] - a[1]);
    const nl = Math.min(MAX_LIGHTS, cand.length);
    for (let i = 0; i < nl; i++) {
      const l = cand[i][0];
      this.lp.set([l.x, l.y, l.z, l.r], i * 4);
      this.lc.set([l.c[0], l.c[1], l.c[2], l.pulse], i * 4);
    }
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
    gl.uniform1f(this.pBright.u.uThr, mood.bloomThr);
    gl.uniform1f(this.pBright.u.uHdr, this.hdr ? 1 : 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const blur = (src: number, dst: number, dx: number, dy: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bFbo[dst]);
      gl.useProgram(this.pBlur.p);
      gl.bindTexture(gl.TEXTURE_2D, this.bTex[src]);
      gl.uniform1i(this.pBlur.u.uSrc, 0);
      gl.uniform2f(this.pBlur.u.uDir, dx, dy);
      gl.uniform2f(this.pBlur.u.uSize, bw, bh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    blur(0, 1, 1, 0);
    blur(1, 0, 0, 1); // tight glow in 0
    blur(0, 1, 2.5, 0);
    blur(1, 2, 0, 2.5); // wide glow in 2

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
    gl.uniform1f(pc.u.uBloom, mood.bloom);
    gl.uniform1f(pc.u.uSat, mood.sat);
    gl.uniform1f(pc.u.uContrast, mood.contrast);
    gl.uniform1f(pc.u.uVig, mood.vig);
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
  }

  destroy() {
    const gl = this.gl;
    this.freeDims();
    if (!this.lost) {
      this.atlas.forEach((t) => delTexture(gl, t));
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
