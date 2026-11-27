import { generateWorld } from './gen/index';
import { T } from './core/types';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();
const N = Number(process.argv[2] ?? 200);
let bad = 0, att = 0, rv = 0, shores = 0, falls = 0, ladders = 0, bridges = 0, split = 0, caves = 0, thrown = 0;
const why = new Map<string, number>();
for (let i = 0; i < N; i++) {
  try {
    const w = generateWorld('river' + i, JSON.parse(process.argv[3] ?? '{}'));
    att += w.stats.attempts;
    const d = w.dims[0];
    rv += w.graph.locs.filter((l) => l.id.includes('.rv')).length;
    shores += w.graph.edges.filter((e) => e.gate === 'shore').length;
    falls += d.objects.filter((o) => o.gate === 'waterfall').length;
    ladders += d.objects.filter((o) => o.style === 'ladder').length;
    split += d.regions.filter((r) => r.name.includes('bank')).length;
    caves += w.dims.filter((x) => x.objects.some((o) => o.label === 'Underground river')).length;
    for (let t = 0; t < d.ground.length; t++) if (d.ground[t] === T.PLANK) bridges++;
    if (!w.ok) { bad++; for (const l of w.lints.filter((x) => !x.ok)) { const k = l.id + ': ' + l.detail.replace(/[a-z]+\d+[\w.]*/g, '#').slice(0, 120); why.set(k, (why.get(k) ?? 0) + 1); } }
    if (i === Number(process.argv[4] ?? -1)) {
      const ch = (t: number) => { const o = d.objects.find((q) => q.y * d.w + q.x === t);
        if (o) return o.gate === 'waterfall' ? 'W' : o.kind === 'gate' ? 'G' : o.kind === 'entrance' ? 'E' : o.kind === 'ledge' ? 'L' : 'o';
        if (d.ground[t] === T.PLANK) return '='; if (d.ground[t] === T.WATER) return d.solid[t] ? String(d.elev[t]) : ','; if (d.ground[t] === T.DEEP) return '~';
        return d.solid[t] ? '#' : String.fromCharCode(97 + (d.region[t] % 26)); };
      for (let y = 0; y < d.h; y++) console.log(Array.from({ length: d.w }, (_, x) => ch(y * d.w + x)).join(''));
      console.log(d.regions.map((r) => `${r.name}(e${r.elev})`).join(' | '));
    }
  } catch (e) { thrown++; if (thrown < 4) console.log('THROW river' + i, (e as Error).stack?.split('\n').slice(0, 4).join(' | ')); }
}
console.log([...why].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => v + 'x ' + k).join('\n'));
const per = (x: number) => +(x / N).toFixed(2);
console.log('RIVERS', JSON.stringify({ N, bad, thrown, attempts: per(att), riverZones: per(rv), shoreEdges: per(shores), waterfalls: per(falls), ladders: per(ladders), bridgeTiles: per(bridges), bankRegions: per(split), riverCaves: per(caves) }));
if (bad > N * 0.02 || thrown) process.exitCode = 1;
