// Ground palettes. Contrasty, saturated tops; dark, warm-shadowed cliff faces.
import { T } from '../core/types';

export interface GroundPal {
  /** 3 top shades (dark, mid, light) */
  top: [string, string, string];
  /** small detail colours: dark accent, light accent */
  dk: string;
  lt: string;
  /** cliff face: top colour, bottom colour, strata line colour */
  face: [string, string, string];
  /** lip drawn at the top of a cliff face (overhang of the top material) */
  lip?: string;
  /** blend priority: higher bleeds into lower neighbours; <0 = never blends */
  prio: number;
  /** liquid surfaces (shore foam, no rim) */
  liquid?: boolean;
}

const EARTH: [string, string, string] = ['#8a5a3a', '#4a2c1c', '#3a2216'];

export const PAL: Record<number, GroundPal> = {
  [T.VOID]: { top: ['#000000', '#000000', '#000000'], dk: '#000', lt: '#000', face: EARTH, prio: -1 },
  [T.GRASS]: { top: ['#3f8a35', '#4b9b3a', '#58ab42'], dk: '#2c6a2a', lt: '#86cf5c', face: EARTH, lip: '#3c8532', prio: 6 },
  [T.SAND]: { top: ['#dcbb72', '#e6c87f', '#efd592'], dk: '#b8954f', lt: '#fbe9b4', face: ['#c08c52', '#6e4628', '#8a5a34'], lip: '#d9b46c', prio: 3 },
  [T.DIRT]: { top: ['#8e5f3a', '#9a6a42', '#a6764b'], dk: '#6a4227', lt: '#bd8f60', face: EARTH, lip: '#8a5c38', prio: 4 },
  [T.STONE]: { top: ['#7f848e', '#8b909a', '#989ca5'], dk: '#5c606a', lt: '#b8bcc4', face: ['#6a6d78', '#2f2f3a', '#45464f'], prio: 3.5 },
  [T.SNOW]: { top: ['#dde8f4', '#e8f0f9', '#f5f9fd'], dk: '#b4c8e2', lt: '#ffffff', face: ['#8aa0c2', '#3c4a6a', '#5d7095'], lip: '#eef5fc', prio: 7 },
  [T.WATER]: { top: ['#3592c8', '#3c9fd2', '#45abda'], dk: '#2a7fb4', lt: '#a6e2fa', face: ['#2c78b4', '#123a66', '#1b5288'], prio: 1, liquid: true },
  [T.DEEP]: { top: ['#0e3466', '#113b72', '#14417a'], dk: '#0a2a55', lt: '#dbe9f5', face: ['#174a85', '#0a2140', '#0f3360'], prio: 0, liquid: true },
  [T.FLOOR]: { top: ['#9c8263', '#a68b6b', '#b09574'], dk: '#6e5a43', lt: '#c8ad89', face: ['#5c4838', '#231a14', '#3a2d22'], prio: -1 },
  [T.WALL]: { top: ['#857f9a', '#8e88a3', '#9791ac'], dk: '#5e5872', lt: '#c8c3da', face: ['#4e4860', '#15121c', '#25202f'], prio: -1 },
  [T.CAVE]: { top: ['#37313f', '#3e3747', '#463e50'], dk: '#29232f', lt: '#625a70', face: ['#2e2838', '#0e0b12', '#1c1724'], prio: 3 },
  [T.CAVEWALL]: { top: ['#6f6488', '#786d91', '#82769b'], dk: '#4c4262', lt: '#a99cc4', face: ['#43395a', '#0e0b14', '#211b2e'], prio: -1 },
  [T.CLOUD]: { top: ['#d9e1f7', '#e4eafb', '#eef2fe'], dk: '#b3c0e6', lt: '#ffffff', face: ['#b8c3ea', '#6c7bb3', '#97a4d6'], lip: '#f2f5ff', prio: 2 },
  [T.PATH]: { top: ['#c4a06c', '#cda975', '#d6b27e'], dk: '#a2804f', lt: '#e6c897', face: EARTH, lip: '#c29c68', prio: 2 },
  [T.LAVA]: { top: ['#f24d0c', '#ff6414', '#ff7d22'], dk: '#a52a06', lt: '#ffd25a', face: ['#4a2a26', '#140b0b', '#2a1817'], prio: 0, liquid: true },
  [T.PLANK]: { top: ['#a06a38', '#ad7640', '#b98248'], dk: '#6a431f', lt: '#d39f62', face: ['#6a4320', '#2a180a', '#4a2e14'], prio: -1 },
  [T.SWAMP]: { top: ['#466238', '#4e6b3d', '#577544'], dk: '#2f4a33', lt: '#7f9a55', face: ['#5a4630', '#24190f', '#3a2c1c'], lip: '#4b673b', prio: 5 },
};

export function pal(g: number): GroundPal {
  return PAL[g] || PAL[T.STONE];
}

/** Flat representative colour per ground, used for ghost/minimap renders. */
export function flatColor(g: number): string {
  return pal(g).top[1];
}

/** Colours used for object markers / pins. */
export const OBJ_COL = {
  chest: '#f2b632',
  entrance: '#e9d7b4',
  npc: '#7fd1ff',
  source: '#8fe36b',
  boss: '#ff3b4e',
  start: '#ffffff',
  gate: '#c9a3ff',
  ledge: '#ffe08a',
  stairs: '#d8d2c4',
  enemy: '#ff7a5c',
} as Record<string, string>;

export const GATE_COL: Record<string, string> = {
  bush: '#4fbf4a',
  boulder: '#a4927c',
  cracked: '#c7b8a0',
  water: '#59c3ff',
  chasm: '#6d5a8c',
  dark: '#7c5cc4',
  eye: '#ffcf4a',
  locked: '#ffb84a',
  bossdoor: '#ff4a5e',
  seal: '#ff5cf0',
  guard: '#ff8a4a',
  stairs: '#d8d2c4',
  ledge: '#ffe08a',
  portal: '#b06cff',
  open: '#ffffff',
  waterfall: '#8fd3f7',
  moon: '#9fb4ff',
  foes: '#ff6a6a',
};
