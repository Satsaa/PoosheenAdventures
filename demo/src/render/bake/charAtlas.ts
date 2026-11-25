// Character atlas: animation frames of the articulated character models, baked progressively
// (a few frames per animation tick, kinds in view first) into fixed slots so the page never stalls.
// Same layer layout as the main AssetSheet (albedo / normal / emissive / top), its own texture.
// A real skinned-model renderer would replace `bakeOne` (render the posed mesh into the slot).
import { CLIPS, CREATURES, DIRS, creatureFor, creatureModel, type Dir } from './creatures';
import { renderModel } from './sdf';
import type { Frame } from './sheet';

const SW = 32, SH = 40, COLS = 32, ROWS = 12;
export const CHAR_W = SW * COLS, CHAR_H = 512;

export interface CharFrames { frames: Frame[]; fps: number }

interface Job { kind: string; clip: 'idle' | 'walk'; dir: Dir; f: number }

export class CharAtlas {
  readonly albedo = new Uint8ClampedArray(CHAR_W * CHAR_H * 4);
  readonly normal = new Uint8ClampedArray(CHAR_W * CHAR_H * 4);
  readonly emissive = new Uint8ClampedArray(CHAR_W * CHAR_H * 4);
  readonly top = new Uint8Array(CHAR_W * CHAR_H);
  /** slot rects written since the last upload */
  dirty: { x: number; y: number; w: number; h: number }[] = [];
  /** bumps whenever frames are added (flat path re-syncs its canvas) */
  version = 0;
  private next = 0;
  private clips = new Map<string, Frame[]>();
  private queue: Job[] = [];
  private queued = new Set<string>();
  bakeMs = 0;

  key(kind: string, clip: string, dir: Dir) { return `${kind}:${clip}:${dir}`; }

  /** frames of one clip/direction, or null while not baked yet */
  get(kind: string, clip: 'idle' | 'walk', dir: Dir): CharFrames | null {
    const f = this.clips.get(this.key(kind, clip, dir));
    return f && f.length === CLIPS[clip].frames && f.every(Boolean) ? { frames: f, fps: CLIPS[clip].fps } : null;
  }

  /** ask for a kind; its idle frames facing south are baked first */
  request(enemyOrKind: string) {
    const kind = (CREATURES as readonly string[]).includes(enemyOrKind) ? enemyOrKind : creatureFor(enemyOrKind);
    if (this.queued.has(kind)) return;
    this.queued.add(kind);
    const jobs: Job[] = [];
    const clipsFor: ('idle' | 'walk')[] = kind === 'npc' || kind === 'hero' ? ['idle'] : ['idle', 'walk'];
    for (const clip of clipsFor) for (const dir of DIRS) for (let f = 0; f < CLIPS[clip].frames; f++) jobs.push({ kind, clip, dir, f });
    jobs.sort((a, b) => (a.clip === 'idle' && a.dir === 's' ? 0 : 1) - (b.clip === 'idle' && b.dir === 's' ? 0 : 1));
    this.queue.push(...jobs);
  }

  pending() { return this.queue.length; }

  /** after a GL context restore: everything must be uploaded again */
  markAll() { this.dirty = [{ x: 0, y: 0, w: CHAR_W, h: CHAR_H }]; }

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
    const s = renderModel(creatureModel(j.kind, j.dir, j.clip, j.f), j.f + 1);
    const slot = this.next++;
    const x0 = (slot % COLS) * SW, y0 = Math.floor(slot / COLS) * SH;
    const w = Math.min(SW, s.w), h = Math.min(SH, s.h);
    for (let r = 0; r < h; r++) {
      const so = r * s.w * 4, d = ((y0 + r) * CHAR_W + x0) * 4;
      this.albedo.set(s.alb.subarray(so, so + w * 4), d);
      this.normal.set(s.nrm.subarray(so, so + w * 4), d);
      this.emissive.set(s.emi.subarray(so, so + w * 4), d);
      this.top.set(s.top.subarray(r * s.w, r * s.w + w), (y0 + r) * CHAR_W + x0);
    }
    const k = this.key(j.kind, j.clip, j.dir);
    let list = this.clips.get(k);
    if (!list) this.clips.set(k, (list = []));
    list[j.f] = { x: x0, y: y0, w, h, ox: s.ox, oy: s.oy, ty: s.ty };
    this.dirty.push({ x: x0, y: y0, w: SW, h: SH });
  }
}

let shared: CharAtlas | null = null;
export function charAtlas(): CharAtlas {
  return shared || (shared = new CharAtlas());
}
