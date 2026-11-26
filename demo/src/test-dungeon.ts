import { generateWorld } from './gen/index';
import { T, D } from './core/types';
const N = Number(process.argv[2] ?? 200); let bad = 0; const why = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const w = generateWorld('dng' + i, JSON.parse(process.argv[3] ?? '{}'));
  if (!w.ok) { bad++; for (const l of w.lints.filter((x) => !x.ok)) { const k = l.id + ': ' + l.detail.split(';')[0].replace(/[a-z]+\d+[\w.]*/g, '#').slice(0, 110); why.set(k, (why.get(k) ?? 0) + 1); } }
  if (i === Number(process.argv[4] ?? -1)) {
    const d = w.dims.find((x) => x.kind === 'interior' && x.zoneLoc.length > 4)!;
    const ch = (t: number) => { const o = d.objects.find((q) => q.y * d.w + q.x === t);
      if (o) return o.kind === 'gate' ? (o.gate === 'open' ? '_' : 'G') : o.kind === 'chest' ? 'C' : o.kind === 'enemy' ? 'e' : o.kind === 'boss' ? 'B' : o.kind === 'entrance' ? 'X' : 'o';
      if (d.ground[t] === T.WATER) return '~'; if (d.ground[t] === T.VOID) return d.region[t] >= 0 ? ':' : ' ';
      if (d.solid[t]) return d.deco[t] === D.PILLAR ? 'i' : '#'; return '.'; };
    console.log(d.name, d.w + 'x' + d.h);
    for (let y = 0; y < d.h; y++) console.log(Array.from({ length: d.w }, (_, x) => ch(y * d.w + x)).join(''));
  }
}
console.log([...why].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => v + 'x ' + k).join('\n'));
console.log('DUNGEONS', JSON.stringify({ N, bad }));
if (bad > N * 0.02) process.exitCode = 1;
