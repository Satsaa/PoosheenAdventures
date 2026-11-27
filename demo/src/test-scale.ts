import { generateWorld } from './gen/index';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();
const cases: [string, Record<string, number | boolean>][] = [
  ['default 8x6', {}],
  ['16x12, 20 regions', { worldW: 16, worldH: 12, regions: 20, underworldSize: 40, skySize: 20, dungeons: 5 }],
  ['32x24, 48 regions', { worldW: 32, worldH: 24, regions: 48, underworldSize: 150, underworldRegions: 8, skySize: 60, dungeons: 10, sealMedallions: 10, dungeonRooms: 16, smallKeys: 4 }],
  ['64x48, 96 regions', { worldW: 64, worldH: 48, regions: 96, underworldSize: 512, underworldRegions: 16, skySize: 300, dungeons: 24, sealMedallions: 24, dungeonRooms: 30, smallKeys: 6 }],
  ['64x48 max rooms', { worldW: 64, worldH: 48, regions: 96, dungeons: 24, sealMedallions: 24, dungeonRooms: 64, smallKeys: 12 }],
  ['tiny 3x3', { worldW: 3, worldH: 3, regions: 4, underworldSize: 4, skySize: 2, dungeons: 1 }],
  ['no dungeons', { dungeons: 0 }],
  ['1 region', { regions: 1 }],
  ['dense 8x6 12 regions', { regions: 12 }],
];
for (const [name, s] of cases) {
  let ok = 0, ms = 0, att = 0; const N = 3; let detail = '';
  for (let i = 0; i < N; i++) {
    try { const w = generateWorld('scale' + i, s, { anySize: true }); if (w.ok) ok++; else detail = w.lints.filter((l) => !l.ok).map((l) => l.id + ': ' + l.detail.slice(0, 110)).join(' | '); ms += w.stats.ms; att += w.stats.attempts;
      if (i === 0) detail ||= `${w.dims[0].w}x${w.dims[0].h} tiles, ${w.graph.locs.length} zones, ${w.graph.edges.length} edges, ${w.dims.length} maps, ${w.solution.spheres.length} spheres`; }
    catch (e) { detail = 'THROW ' + (e as Error).stack?.split('\n').slice(0, 3).join(' | '); }
  }
  if (ok < N) process.exitCode = 1;
  console.log(`${name.padEnd(24)} ok ${ok}/${N}  ${(ms / N).toFixed(0).padStart(6)} ms  attempts ${(att / N).toFixed(1)}  ${detail}`);
}
