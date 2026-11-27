// Character atlas: animation frames of the articulated character models, baked progressively
// (a few frames per animation tick, kinds in view first) into fixed slots so the page never stalls.
// Same layer layout as the main AssetSheet (albedo / normal / emissive / top), its own texture.
// A real skinned-model renderer would replace `bakeOne` (render the posed mesh into the slot).
import { CLIPS, CREATURES, DEFAULT_ANIM_FPS, DIRS, clipFrames, creatureFor, creatureModel, type Dir } from './creatures';
import { renderModel } from './sdf';
import type { Frame } from './sheet';

// slot size in design px (the tile grid's px); an atlas baked at `scale` has slots SW*scale x SH*scale texels
const SW = 32, SH = 40, COLS = 32, ROWS = 12;
/** atlas size at scale 1 (texels == design px); a scaled atlas is CHAR_W*scale x CHAR_H*scale
 *  (at scale 8 that is 8192 x 4096 texels) */
export const CHAR_W = SW * COLS, CHAR_H = 512;

export interface CharFrames { frames: Frame[]; fps: number }

interface Job { kind: string; clip: 'idle' | 'walk'; dir: Dir; f: number }

export class CharAtlas {
  /** atlas size in texels (CHAR_W * scale x CHAR_H * scale; 8192 x 4096 at scale 8) */
  readonly w: number;
  readonly h: number;
  readonly albedo: Uint8ClampedArray;
  readonly normal: Uint8ClampedArray;
  readonly emissive: Uint8ClampedArray;
  readonly top: Uint8Array;
  /** slot rects written since the last upload (texels) */
  dirty: { x: number; y: number; w: number; h: number }[] = [];
  /** bumps whenever frames are added (flat path re-syncs its canvas) */
  version = 0;
  private next = 0;
  private clips = new Map<string, Frame[]>();
  private queue: Job[] = [];
  private queued = new Set<string>();
  bakeMs = 0;

  /** @param scale texels per design px the frames are baked at */
  constructor(readonly scale = 1, readonly animFps = DEFAULT_ANIM_FPS) {
    this.w = CHAR_W * scale;
    this.h = CHAR_H * scale;
    this.albedo = new Uint8ClampedArray(this.w * this.h * 4);
    this.normal = new Uint8ClampedArray(this.w * this.h * 4);
    this.emissive = new Uint8ClampedArray(this.w * this.h * 4);
    this.top = new Uint8Array(this.w * this.h * 2);
  }

  key(kind: string, clip: string, dir: Dir) { return `${kind}:${clip}:${dir}`; }

  /** frames of one clip/direction, or null while not baked yet */
  get(kind: string, clip: 'idle' | 'walk', dir: Dir): CharFrames | null {
    const f = this.clips.get(this.key(kind, clip, dir));
    const nF = clipFrames(clip, this.animFps);
    return f && f.length === nF && f.every(Boolean) ? { frames: f, fps: nF / CLIPS[clip].cycle } : null;
  }

  /** ask for a kind; its idle frames facing south are baked first */
  request(enemyOrKind: string) {
    const kind = (CREATURES as readonly string[]).includes(enemyOrKind) ? enemyOrKind : creatureFor(enemyOrKind);
    if (this.queued.has(kind)) return;
    this.queued.add(kind);
    const jobs: Job[] = [];
    const clipsFor: ('idle' | 'walk')[] = kind === 'npc' || kind === 'hero' ? ['idle'] : ['idle', 'walk'];
    for (const clip of clipsFor) for (const dir of DIRS) for (let f = 0, nF = clipFrames(clip, this.animFps); f < nF; f++) jobs.push({ kind, clip, dir, f });
    jobs.sort((a, b) => (a.clip === 'idle' && a.dir === 's' ? 0 : 1) - (b.clip === 'idle' && b.dir === 's' ? 0 : 1));
    this.queue.push(...jobs);
  }

  pending() { return this.queue.length; }

  /** after a GL context restore: everything must be uploaded again */
  markAll() { this.dirty = [{ x: 0, y: 0, w: this.w, h: this.h }]; }

  /** bake queued frames for up to `budgetMs` */
  step(budgetMs: number): boolean {
    if (!this.queue.length) return false;
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) this.bakeOne(this.queue.shift()!);
    this.bakeMs += performance.now() - t0;
    this.version++;
    return true;
  }

  private bakeOne(j: Job) {
    if (this.next >= COLS * ROWS) return;
    const sc = this.scale, W = this.w;
    const s = renderModel(creatureModel(j.kind, j.dir, j.clip, j.f, clipFrames(j.clip, this.animFps)), j.f + 1, sc);
    const slot = this.next++;
    // slot origin and size in texels; the sprite's w/h are multiples of sc, so the clipped size is too
    const SWt = SW * sc, SHt = SH * sc;
    const x0 = (slot % COLS) * SWt, y0 = Math.floor(slot / COLS) * SHt;
    const w = Math.min(SWt, s.w), h = Math.min(SHt, s.h);
    for (let r = 0; r < h; r++) {
      const so = r * s.w * 4, d = ((y0 + r) * W + x0) * 4;
      this.albedo.set(s.alb.subarray(so, so + w * 4), d);
      this.normal.set(s.nrm.subarray(so, so + w * 4), d);
      this.emissive.set(s.emi.subarray(so, so + w * 4), d);
      this.top.set(s.top.subarray(r * s.w * 2, (r * s.w + w) * 2), ((y0 + r) * W + x0) * 2);
    }
    const k = this.key(j.kind, j.clip, j.dir);
    let list = this.clips.get(k);
    if (!list) this.clips.set(k, (list = []));
    // x, y in atlas texels; sizes and pivots in design px
    list[j.f] = { x: x0, y: y0, w: w / sc, h: h / sc, ox: s.ox / sc, oy: s.oy / sc, ty: s.ty / sc, s: sc };
    this.dirty.push({ x: x0, y: y0, w: SWt, h: SHt });
  }
}

let shared: CharAtlas | null = null;
/**
 * The current character atlas. Without `scale`: the current one (a scale-1 atlas is created if there is
 * none). With `scale`: the current one if it has that scale, else a fresh empty atlas at that scale,
 * which becomes current (kinds must be requested again).
 */
export function charAtlas(scale?: number, animFps?: number): CharAtlas {
  if (scale === undefined) return shared || (shared = new CharAtlas(1));
  const fps = animFps ?? shared?.animFps ?? DEFAULT_ANIM_FPS;
  if (!shared || shared.scale !== scale || shared.animFps !== fps) shared = new CharAtlas(scale, fps);
  return shared;
}
