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
    add('moonDoors', w.graph.edges.filter((e) => e.gate === 'moon').length);
    add('foesDoors', w.graph.edges.filter((e) => e.gate === 'foes').length);
    add('enemies', w.dims.reduce((a, x) => a + x.objects.filter((o) => o.kind === 'enemy').length, 0));
    add('nightThings', w.dims.reduce((a, x) => a + x.objects.filter((o) => o.phase === 'night').length, 0));
    add('houses', d.structures?.length ?? 0);
    add('oddHouses', d.structures?.filter((s) => { const xs = s.tiles.map((t) => t % d.w), ys = s.tiles.map((t) => (t / d.w) | 0); return s.tiles.length !== (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1); }).length ?? 0);
    let sea = 0, peaks = 0;
    for (let t = 0; t < d.ground.length; t++) if (d.region[t] < 0) { if (d.ground[t] === T.DEEP) sea++; else peaks++; }
    add('seaShare', sea / d.ground.length); add('peakShare', peaks / d.ground.length);
    const goal = w.graph.checks.find((c) => c.item === w.graph.goal)!.loc;
    add('dialRequired', w.items.sundial && requiredFor(w.graph, w.items, goal, ['sundial']).length ? 1 : 0);
  }
  const why = expect(sum);
  console.log(`${name.padEnd(22)} bad ${bad}/${N}  ${Object.entries(sum).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}${why ? '  FAILED: ' + why : ''}`);
  if (bad > N * 0.02 || why) process.exitCode = 1;
};
run('default', {}, (s) => (s.enemies < 5 ? 'no enemies' : s.houses < 3 ? 'no houses' : s.oddHouses <= 0 ? 'no L/T houses' : s.timeReqs <= 0 ? 'no time content' : s.seaShare + s.peakShare < 0.05 ? 'land fills the rectangle' : s.dialRequired > 0 ? 'dial required although time flows' : null));
run('time stands still', { timeFlows: false, timeGates: 1 }, (s) => (s.moonDoors <= 0 ? 'no moon doors' : s.dialRequired <= 0.05 ? 'dial never required' : null));
run('no dial, frozen time', { timeFlows: false, items: { sundial: { enabled: false } } }, (s) => (s.timeReqs > 0 ? 'time content without any way to reach night' : null));
run('no weapons', { items: { sword: { enabled: false }, bow: { enabled: false }, bombBag: { enabled: false } } }, (s) => (s.foesDoors > 0 ? 'sealed rooms without weapons' : null));
run('rectangle, no enemies', { landCoverage: 1, enemies: 0, village: 0 }, (s) => (s.enemies > 0 ? 'enemies' : s.seaShare + s.peakShare > 0 ? 'not a rectangle' : null));
run('crowded', { enemies: 4, village: 12, rivers: 4, timeGates: 1 }, () => null);
