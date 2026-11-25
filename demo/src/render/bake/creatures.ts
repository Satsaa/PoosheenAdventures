// Articulated characters (enemies, NPCs, the player marker): tiny SDF models with a few pose
// parameters (phase of the walk cycle, breathing, wing beat), rendered into animation frames for
// 3 facings (s, e, n; west = east mirrored). This is the "model-based" half of the hybrid: a real
// skinned-mesh renderer can later replace `creatureModel` + the baker and fill the same clip/frame
// layout (see Clip in ./sheet.ts).
import { MAT } from './sheet';
import { type Mat, type Model, capsule, coneZ, ellip, noise3, smin, sph } from './sdf';

type F = (x: number, y: number, z: number) => number;
type Part = [F, number];

export type Dir = 's' | 'e' | 'n';
export const DIRS: Dir[] = ['s', 'e', 'n'];
export const CLIPS = { idle: { frames: 2, fps: 2.5 }, walk: { frames: 4, fps: 7 } } as const;

/** kinds with baked animation; unknown enemy ids fall back to 'generic' */
export const CREATURES = ['knoblin', 'snapjaw', 'frostmite', 'dustling', 'rockback', 'bat', 'wisp', 'puff', 'pinjata', 'generic', 'npc', 'hero'] as const;

const CX = 0.5, CY = 0.56;

interface Pose { walk: number; idle: number; moving: boolean }

function build(mats: Mat[], parts: Part[], dir: Dir, zMax: number, padX = 0.18): Model {
  // canonical models face +y (south, toward the camera); rotate the query point for other facings
  const rot = (x: number, y: number): [number, number] => {
    const dx = x - CX, dy = y - CY;
    if (dir === 'e') return [CX - dy, CY + dx];
    if (dir === 'n') return [CX - dx, CY - dy];
    return [x, y];
  };
  return {
    mats, zMax, padX, outline: 0.5, grain: 0.35,
    sdf: (x, y, z) => { const [u, v] = rot(x, y); let d = 1e9; for (const p of parts) { const q = p[0](u, v, z); if (q < d) d = q; } return d; },
    mat: (x, y, z) => { const [u, v] = rot(x, y); let d = 1e9, m = 0; for (const p of parts) { const q = p[0](u, v, z); if (q < d) { d = q; m = p[1]; } } return m; },
  };
}

const R = {
  goblin: ['#1f3a12', '#2f5a1a', '#467c26', '#62a034'],
  cloth: ['#3a2414', '#5a3820', '#7a5030'],
  eye: ['#ffd23a', '#fff0a0'],
  dark: ['#06040a', '#120c18'],
  shell: ['#1f2a12', '#38461a', '#566a24', '#7a9032'],
  skinT: ['#4a5a2a', '#6a7e3a', '#8ea24e'],
  ice: ['#3a5a8a', '#5a86c0', '#8ec0ee', '#d8f2ff'],
  sand: ['#6a4a2a', '#94703c', '#c09a56', '#e0c27a'],
  rock: ['#26222c', '#3c3644', '#58505f', '#776d80'],
  lava: ['#ff7a1a', '#ffc050'],
  batW: ['#1a1020', '#2e1c3a', '#4a2e5c'],
  wisp: ['#3a8ab0', '#7ad0f0', '#d8f8ff'],
  cloud: ['#8a98c8', '#b6c2ea', '#e4eaff', '#ffffff'],
  pink: ['#8a1a5a', '#d03a8a', '#ff7ac0'],
  yellow: ['#8a6a0a', '#d0a81a', '#ffe04a'],
  teal: ['#0a5a5a', '#1a9a9a', '#4ae0d0'],
  skin: ['#7a4a34', '#b07856', '#e0a882'],
  plain: ['#6a6a74', '#9a9aa6', '#cfcfda', '#f0f0f6'],
  hero: ['#0e3a1c', '#1a6430', '#2c8e44', '#48b05a'],
  hair: ['#3a2414', '#5a3a20'],
};

/** legs swinging for walk cycles: returns the forward offset of leg k (0..n-1) */
const legSwing = (p: Pose, k: number, n: number, amp: number) => (p.moving ? Math.sin(p.walk * Math.PI * 2 + (k * Math.PI * 2) / n) * amp : 0);
const bob = (p: Pose, a: number) => (p.moving ? Math.abs(Math.sin(p.walk * Math.PI * 2)) * a : Math.sin(p.idle * Math.PI * 2) * a * 0.5);

function biped(p: Pose, body: Mat, head: Mat, opts: { ears?: boolean; club?: boolean; hat?: Mat; scale?: number; eye?: Mat }): [Mat[], Part[], number] {
  const k = opts.scale ?? 1;
  const b = bob(p, 0.03);
  const breathe = 1 + (p.moving ? 0 : Math.sin(p.idle * Math.PI * 2) * 0.04);
  const mats: Mat[] = [body, head, opts.eye ?? { ramp: R.dark }, { ramp: R.cloth }, opts.hat ?? { ramp: R.hair }];
  const parts: Part[] = [];
  const hz = 0.22 * k;
  for (let i = 0; i < 2; i++) {
    const sx = CX + (i ? 0.08 : -0.08) * k, sw = legSwing(p, i, 2, 0.08);
    parts.push([(x, y, z) => capsule(x, y, z, sx, CY, 0.03, sx, CY + sw, hz - 0.02, 0.045 * k), 3]);
  }
  parts.push([(x, y, z) => ellip(x, y, z, CX, CY, hz + 0.13 * k + b, 0.15 * k * breathe, 0.12 * k * breathe, 0.15 * k), 0]);
  for (let i = 0; i < 2; i++) {
    const sx = CX + (i ? 0.17 : -0.17) * k, sw = -legSwing(p, i, 2, 0.07);
    parts.push([(x, y, z) => capsule(x, y, z, sx, CY, hz + 0.2 * k + b, sx + (i ? 0.03 : -0.03), CY + sw, hz + 0.06 * k + b, 0.035 * k), 0]);
  }
  const hz2 = hz + 0.36 * k + b;
  parts.push([(x, y, z) => sph(x, y, z, CX, CY + 0.01, hz2, 0.14 * k), 1]);
  parts.push([(x, y, z) => Math.min(sph(x, y, z, CX - 0.05 * k, CY + 0.13 * k, hz2 + 0.02, 0.028 * k), sph(x, y, z, CX + 0.05 * k, CY + 0.13 * k, hz2 + 0.02, 0.028 * k)), 2]);
  if (opts.ears) parts.push([(x, y, z) => Math.min(capsule(x, y, z, CX - 0.12 * k, CY, hz2 + 0.03, CX - 0.27 * k, CY - 0.02, hz2 + 0.1, 0.03 * k), capsule(x, y, z, CX + 0.12 * k, CY, hz2 + 0.03, CX + 0.27 * k, CY - 0.02, hz2 + 0.1, 0.03 * k)), 1]);
  if (opts.club) parts.push([(x, y, z) => capsule(x, y, z, CX + 0.2 * k, CY + 0.02, hz + 0.08 * k + b, CX + 0.24 * k, CY + 0.08, hz + 0.38 * k + b, 0.04 * k), 3]);
  if (opts.hat) parts.push([(x, y, z) => coneZ(x, y, z, CX, CY - 0.01, hz2 + 0.07 * k, 0.26 * k, 0.15 * k), 4]);
  return [mats, parts, hz2 + 0.4 * k];
}

export function creatureModel(kind: string, dir: Dir, clip: 'idle' | 'walk', frame: number): Model {
  const nF = CLIPS[clip].frames;
  const p: Pose = { walk: frame / nF, idle: frame / nF, moving: clip === 'walk' };
  switch (kind) {
    case 'knoblin': {
      const [m, parts, z] = biped(p, { ramp: R.goblin }, { ramp: R.goblin, bias: 0.3 }, { ears: true, club: true, eye: { ramp: R.eye, emit: [140, 110, 20] }, scale: 0.9 });
      return build(m, parts, dir, z);
    }
    case 'npc': {
      const [m, parts, z] = biped(p, { ramp: R.plain, id: MAT.TINT }, { ramp: R.skin }, { hat: { ramp: R.hair } });
      return build(m, parts, dir, z);
    }
    case 'hero': {
      const [m, parts, z] = biped(p, { ramp: R.hero }, { ramp: R.skin }, { hat: { ramp: R.hero, bias: 0.4 } });
      return build(m, parts, dir, z);
    }
    case 'snapjaw': {
      const jaw = p.moving ? 0 : Math.max(0, Math.sin(p.idle * Math.PI * 2)) * 0.06;
      const parts: Part[] = [
        [(x, y, z) => ellip(x, y, z, CX, CY - 0.04, 0.17 + bob(p, 0.02), 0.3, 0.27, 0.15) + (noise3(x * 14, y * 14, z * 14, 3) - 0.5) * 0.03, 0],
        [(x, y, z) => ellip(x, y, z, CX, CY + 0.26, 0.14, 0.13, 0.11, 0.07 + jaw * 0.3), 1],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.06, CY + 0.31, 0.2, 0.03), sph(x, y, z, CX + 0.06, CY + 0.31, 0.2, 0.03)), 2],
      ];
      for (let i = 0; i < 4; i++) {
        const lx = CX + (i % 2 ? 0.22 : -0.22), ly = CY + (i < 2 ? -0.14 : 0.1), sw = legSwing(p, i, 4, 0.06);
        parts.push([(x, y, z) => capsule(x, y, z, lx, ly, 0.1, lx + (i % 2 ? 0.06 : -0.06), ly + sw, 0.02, 0.045), 1]);
      }
      return build([{ ramp: R.shell }, { ramp: R.skinT }, { ramp: R.eye, emit: [120, 100, 10] }], parts, dir, 0.4, 0.2);
    }
    case 'frostmite': {
      const parts: Part[] = [
        [(x, y, z) => ellip(x, y, z, CX, CY, 0.16 + bob(p, 0.02), 0.22, 0.26, 0.13), 0],
        [(x, y, z) => { let d = 1e9; for (let i = 0; i < 3; i++) d = Math.min(d, coneZ(x, y, z, CX + (i - 1) * 0.1, CY - 0.05 + (i % 2) * 0.08, 0.22, 0.22 + (i % 2) * 0.08, 0.05)); return d; }, 1],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.06, CY + 0.24, 0.17, 0.03), sph(x, y, z, CX + 0.06, CY + 0.24, 0.17, 0.03)), 2],
      ];
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? 1 : -1, ly = CY - 0.15 + Math.floor(i / 2) * 0.15, sw = legSwing(p, i, 3, 0.05);
        parts.push([(x, y, z) => capsule(x, y, z, CX + side * 0.16, ly, 0.13, CX + side * 0.3, ly + sw, 0.0, 0.025), 0]);
      }
      return build([{ ramp: R.ice }, { ramp: R.ice, id: MAT.GLOSS, emit: [30, 70, 110], bias: 0.6 }, { ramp: R.dark }], parts, dir, 0.55, 0.22);
    }
    case 'dustling': {
      const tw = p.walk * Math.PI * 2 + p.idle;
      return build([{ ramp: R.sand }, { ramp: R.eye, emit: [160, 110, 20] }], [
        [(x, y, z) => {
          const r = 0.06 + z * 0.32;
          const cx = CX + Math.sin(z * 9 + tw) * 0.05, cy = CY + Math.cos(z * 9 + tw) * 0.03;
          return Math.max(Math.hypot(x - cx, y - cy) - r + (noise3(x * 10, y * 10, z * 10 + tw, 5) - 0.5) * 0.05, z - 0.62, -z);
        }, 0],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.06, CY + 0.17, 0.46, 0.035), sph(x, y, z, CX + 0.06, CY + 0.17, 0.46, 0.035)), 1],
      ], dir, 0.66, 0.2);
    }
    case 'rockback': {
      const parts: Part[] = [
        [(x, y, z) => { let d = 1e9; for (let i = 0; i < 3; i++) d = smin(d, sph(x, y, z, CX, CY - 0.18 + i * 0.16, 0.2 + bob(p, 0.02) + (i === 1 ? 0.04 : 0), 0.2), 0.04); return d + (noise3(x * 9, y * 9, z * 9, 7) - 0.5) * 0.08; }, 0],
        [(x, y, z) => ellip(x, y, z, CX, CY + 0.28, 0.12, 0.1, 0.09, 0.07), 1],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.05, CY + 0.35, 0.14, 0.022), sph(x, y, z, CX + 0.05, CY + 0.35, 0.14, 0.022)), 2],
      ];
      for (let i = 0; i < 4; i++) {
        const side = i % 2 ? 1 : -1, ly = CY - 0.12 + (i < 2 ? 0 : 0.22), sw = legSwing(p, i, 4, 0.06);
        parts.push([(x, y, z) => capsule(x, y, z, CX + side * 0.16, ly, 0.1, CX + side * 0.26, ly + sw, 0.0, 0.04), 1]);
      }
      return build([{ ramp: R.rock }, { ramp: R.rock, bias: 0.6 }, { ramp: R.lava, emit: [255, 120, 20] }], parts, dir, 0.5, 0.15);
    }
    case 'bat': {
      const flap = Math.sin((p.moving ? p.walk : p.idle) * Math.PI * 2) * 0.12;
      const zc = 0.55 + flap * 0.3;
      const wing = (side: number): F => (x, y, z) => {
        const tipX = CX + side * 0.34, tipZ = zc + flap * 1.4;
        const d = capsule(x, y, z, CX + side * 0.06, CY, zc, tipX, CY - 0.02, tipZ, 0.02);
        const memb = Math.max(Math.abs(y - CY) - 0.01, side * (CX - x), Math.abs(x - CX) - 0.34, z - Math.max(zc, tipZ) - 0.02, zc - 0.13 - z + Math.abs(x - CX) * 0.2);
        return Math.min(d, memb);
      };
      return build([{ ramp: R.batW }, { ramp: R.pink, emit: [200, 30, 60] }], [
        [(x, y, z) => ellip(x, y, z, CX, CY, zc, 0.07, 0.07, 0.09), 0],
        [wing(1), 0], [wing(-1), 0],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.03, CY + 0.065, zc + 0.03, 0.02), sph(x, y, z, CX + 0.03, CY + 0.065, zc + 0.03, 0.02)), 1],
      ], dir, 0.95, 0.25);
    }
    case 'wisp': {
      const pulse = 1 + Math.sin((p.moving ? p.walk : p.idle) * Math.PI * 2) * 0.12;
      return build([{ ramp: R.wisp, emit: [90, 200, 255], bias: 1 }, { ramp: R.wisp, emit: [40, 120, 180] }], [
        [(x, y, z) => sph(x, y, z, CX, CY, 0.55, 0.12 * pulse), 0],
        [(x, y, z) => capsule(x, y, z, CX, CY - 0.02, 0.5, CX + Math.sin(p.walk * 6.28) * 0.06, CY - 0.18, 0.32, 0.04), 1],
      ], dir, 0.72, 0.2);
    }
    case 'puff': {
      const s = 1 + Math.sin((p.moving ? p.walk : p.idle) * Math.PI * 2) * 0.05;
      return build([{ ramp: R.cloud, bias: 0.4 }, { ramp: R.dark }, { ramp: R.pink }], [
        [(x, y, z) => smin(smin(sph(x, y, z, CX, CY, 0.4, 0.2 * s), sph(x, y, z, CX - 0.17, CY, 0.34, 0.12 * s), 0.08), sph(x, y, z, CX + 0.17, CY, 0.36, 0.13 * s), 0.08), 0],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.07, CY + 0.18, 0.44, 0.03), sph(x, y, z, CX + 0.07, CY + 0.18, 0.44, 0.03)), 1],
        [(x, y, z) => Math.min(sph(x, y, z, CX - 0.13, CY + 0.15, 0.37, 0.03), sph(x, y, z, CX + 0.13, CY + 0.15, 0.37, 0.03)), 2],
      ], dir, 0.66, 0.2);
    }
    case 'pinjata': {
      const b = bob(p, 0.03);
      const stripe = (z: number) => (Math.floor(z * 18) % 3);
      const parts: Part[] = [
        [(x, y, z) => { const d = ellip(x, y, z, CX, CY - 0.02, 0.3 + b, 0.13, 0.24, 0.12); return stripe(z) === 0 ? d : 1e9; }, 0],
        [(x, y, z) => { const d = ellip(x, y, z, CX, CY - 0.02, 0.3 + b, 0.13, 0.24, 0.12); return stripe(z) === 1 ? d : 1e9; }, 1],
        [(x, y, z) => { const d = ellip(x, y, z, CX, CY - 0.02, 0.3 + b, 0.13, 0.24, 0.12); return stripe(z) === 2 ? d : 1e9; }, 2],
        [(x, y, z) => capsule(x, y, z, CX, CY + 0.17, 0.33 + b, CX, CY + 0.22, 0.56 + b, 0.06), 0],
        [(x, y, z) => ellip(x, y, z, CX, CY + 0.28, 0.58 + b, 0.07, 0.1, 0.06), 1],
        [(x, y, z) => Math.min(capsule(x, y, z, CX - 0.04, CY + 0.2, 0.62 + b, CX - 0.05, CY + 0.18, 0.72 + b, 0.02), capsule(x, y, z, CX + 0.04, CY + 0.2, 0.62 + b, CX + 0.05, CY + 0.18, 0.72 + b, 0.02)), 2],
      ];
      for (let i = 0; i < 4; i++) {
        const lx = CX + (i % 2 ? 0.07 : -0.07), ly = CY + (i < 2 ? -0.15 : 0.1), sw = legSwing(p, i, 4, 0.05);
        parts.push([(x, y, z) => capsule(x, y, z, lx, ly, 0.2 + b, lx, ly + sw, 0.02, 0.03), i % 3]);
      }
      return build([{ ramp: R.pink }, { ramp: R.yellow }, { ramp: R.teal }], parts, dir, 0.8, 0.18);
    }
  }
  // generic fallback: a hopping blob with eyes
  const hop = p.moving ? Math.abs(Math.sin(p.walk * Math.PI * 2)) * 0.08 : 0;
  return build([{ ramp: R.pink, bias: 0.3 }, { ramp: R.eye, emit: [120, 90, 10] }], [
    [(x, y, z) => ellip(x, y, z, CX, CY, 0.16 + hop, 0.2, 0.18, 0.16 - hop * 0.3), 0],
    [(x, y, z) => Math.min(sph(x, y, z, CX - 0.07, CY + 0.15, 0.22 + hop, 0.035), sph(x, y, z, CX + 0.07, CY + 0.15, 0.22 + hop, 0.035)), 1],
  ], dir, 0.48, 0.15);
}

/** the creature kind used for an enemy id */
export function creatureFor(enemy: string | undefined): string {
  return enemy && (CREATURES as readonly string[]).includes(enemy) ? enemy : 'generic';
}

/** enemies that hover (no ground contact: their shadow is offset) */
export const FLYERS = new Set(['bat', 'wisp', 'puff']);
