// Ground blending rules and the colours of map pins.
import { T } from '../core/types';

/** How ground kinds meet: higher `prio` bleeds into lower neighbours (<0 never blends); liquids get shore foam. */
export interface GroundPal {
  prio: number;
  liquid?: boolean;
}

export const PAL: Record<number, GroundPal> = {
  [T.VOID]: { prio: -1 },
  [T.GRASS]: { prio: 6 },
  [T.SAND]: { prio: 3 },
  [T.DIRT]: { prio: 4 },
  [T.STONE]: { prio: 3.5 },
  [T.SNOW]: { prio: 7 },
  [T.WATER]: { prio: 1, liquid: true },
  [T.DEEP]: { prio: 0, liquid: true },
  [T.FLOOR]: { prio: -1 },
  [T.WALL]: { prio: -1 },
  [T.CAVE]: { prio: 3 },
  [T.CAVEWALL]: { prio: -1 },
  [T.CLOUD]: { prio: 2 },
  [T.PATH]: { prio: 2 },
  [T.LAVA]: { prio: 0, liquid: true },
  [T.PLANK]: { prio: -1 },
  [T.SWAMP]: { prio: 5 },
};

export function pal(g: number): GroundPal {
  return PAL[g] || PAL[T.STONE];
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
  sun: '#ffd45a',
  foes: '#ff6a6a',
};
