// Time of day, enemies, tile-built houses and irregular land: present, and worlds stay valid.
import { generateWorld } from './gen/index';
import { requiredFor } from './core/solver';
import { T } from './core/types';
const N = Number(process.argv[2] ?? 150);
const run = (name: string, settings: Record<string, unknown>, expect: (s: Record<string, number>) => string | null) => {
  let bad = 0; const sum: Record<string, number> = {};
  const add = (k: string, v: number) => (sum[k] = (sum[k] ?? 0) + v / N);
  for (let i = 0; i < N; i++) {
    const w = generateWorld('feat' + i, settings);
    if (!w.ok) bad++;
    const d = w.dims[0];
    const reqs = [...w.graph.edges.map((e) => e.req), ...w.graph.checks.map((c) => c.req), ...w.graph.sources.map((s) => s.req)];
    add('timeReqs', reqs.filter((r) => JSON.stringify(r).includes('"time"')).length);
    add('moonDoors', w.graph.edges.filter((e) => e.gate === 'moon' || e.gate === 'sun').length);
    add('foesDoors', w.graph.edges.filter((e) => e.gate === 'foes').length);
    add('enemies', w.dims.reduce((a, x) => a + x.objects.filter((o) => o.kind === 'enemy').length, 0));
    add('nightThings', w.dims.reduce((a, x) => a + x.objects.filter((o) => o.phase === 'night').length, 0));
    add('houses', d.structures?.length ?? 0);
    add('oddHouses', d.structures?.filter((s) => { const xs = s.tiles.map((t) => t % d.w), ys = s.tiles.map((t) => (t / d.w) | 0); return s.tiles.length !== (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1); }).length ?? 0);
    let sea = 0, peaks = 0;
    for (let t = 0; t < d.ground.length; t++) if (d.region[t] < 0) { if (d.ground[t] === T.DEEP) sea++; else peaks++; }
    add('seaShare', sea / d.ground.length); add('peakShare', peaks / d.ground.length);
    add('seaZones', w.graph.locs.filter((l) => l.id.includes('.fill')).length);
    add('docks', d.objects.filter((o) => o.style === 'dock').length);
    add('ferrymen', w.npcs.filter((x) => x.role === 'Ferry').length);
    add('islets', w.graph.locs.filter((l) => l.id.includes('.islet')).length);
    add('boat', w.graph.checks.some((c) => c.item === 'boat') ? 1 : 0);
    add('seaSides', w.shape ? Object.values(w.shape.sea).filter(Boolean).length : 0);
    add('fillers', d.regions.filter((r) => ['ocean', 'range', 'thicket', 'wastes'].includes(r.biome)).length);
    add('edgeLand', (() => { let n = 0; for (let x = 0; x < d.w; x++) { if (d.region[d.w + x] >= 0) n++; if (d.region[(d.h - 2) * d.w + x] >= 0) n++; } for (let y = 0; y < d.h; y++) { if (d.region[y * d.w + 1] >= 0) n++; if (d.region[y * d.w + d.w - 2] >= 0) n++; } return n / (2 * (d.w + d.h)); })());
    const goal = w.graph.checks.find((c) => c.item === w.graph.goal)!.loc;
    add('dialRequired', w.items.sundial && requiredFor(w.graph, w.items, goal, ['sundial']).length ? 1 : 0);
  }
  const why = expect(sum);
  console.log(`${name.padEnd(22)} bad ${bad}/${N}  ${Object.entries(sum).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}${why ? '  FAILED: ' + why : ''}`);
  if (bad > N * 0.02 || why) process.exitCode = 1;
};
run('default', {}, (s) => (s.enemies < 5 ? 'no enemies' : s.houses < 3 ? 'no houses' : s.oddHouses <= 0 ? 'no L/T houses' : s.timeReqs <= 0 ? 'no time content' : s.seaShare + s.peakShare < 0.03 ? 'land fills the rectangle' : s.dialRequired > 0 ? 'dial required although time flows' : null));
run('time stands still', { timeFlows: false, timeChests: 1, timeNpcs: 1, timeCreatures: 3 }, (s) => (s.moonDoors <= 0 ? 'no moon doors' : s.dialRequired <= 0.05 ? 'dial never required' : null));
run('no dial, frozen time', { timeFlows: false, items: { sundial: { enabled: false } } }, (s) => (s.timeReqs > 0 ? 'time content without any way to reach night' : null));
run('no time doors', { timeDoors: false }, (s) => (s.moonDoors > 0 ? 'doors although switched off' : null));
run('no weapons', { items: { sword: { enabled: false }, bow: { enabled: false }, bombBag: { enabled: false } } }, (s) => (s.foesDoors > 0 ? 'sealed rooms without weapons' : null));
run('rectangle, no enemies', { landCoverage: 1, enemies: 0, village: 0 }, (s) => (s.enemies > 0 ? 'enemies' : s.seaShare + s.peakShare > 0 ? 'not a rectangle' : null));
run('full island', { coastFromSeed: false, landlocked: 0 }, (s) => (s.seaSides < 3.99 ? 'not sea on every side' : s.edgeLand > 0.02 ? 'land touches the map edge' : s.docks <= 0 ? 'no docks' : s.boat <= 0.5 ? 'no boat' : null));
run('fully landlocked', { coastFromSeed: false, landlocked: 1 }, (s) => (s.seaSides > 0 ? 'has a sea side' : s.seaShare > 0 ? 'has ocean' : s.boat > 0 ? 'a boat with nothing to sail' : s.docks > 0 ? 'docks without sea' : null));
run('ferries, no boat', { coastFromSeed: false, landlocked: 0.2, ferries: 1, docks: 1, items: { boat: { enabled: false } } }, (s) => (s.boat > 0 ? 'boat present' : s.ferrymen <= 0 ? 'no ferrymen' : s.seaZones <= 0 ? 'no sea zone' : null));
run('boat, no ferries', { coastFromSeed: false, landlocked: 0.2, ferries: 0, docks: 1, islets: 6 }, (s) => (s.ferrymen > 0 ? 'ferrymen present' : s.islets <= 0 ? 'no islets' : null));
run('crowded', { enemies: 4, village: 12, rivers: 4, timeChests: 1, timeNpcs: 1, timeCreatures: 3, timeShop: true }, () => null);
