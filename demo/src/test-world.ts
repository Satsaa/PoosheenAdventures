import { generateWorld } from './gen/index';
import { T } from './core/types';

const N = Number(process.argv[2] ?? 100);
const t0 = Date.now();
let bad = 0, attempts = 0, first = 0, thrown = 0;
const why = new Map<string, number>();
for (let i = 0; i < N; i++) {
  try {
    const w = generateWorld('seed' + i, { maxAttempts: Number(process.argv[3] ?? 12) });
    attempts += w.stats.attempts;
    if (w.stats.attempts === 1 && w.ok) first++;
    if (!w.ok) {
      bad++;
      for (const l of w.lints.filter((x) => !x.ok)) {
        const k = l.id + ': ' + l.detail.replace(/[a-z]+\d+[\w.]*/g, '#').slice(0, 90);
        why.set(k, (why.get(k) ?? 0) + 1);
      }
    }
    if (i === 0 && process.argv[4]) {
      const d = w.dims[0];
      const ch = (i: number) => {
        const o = d.objects.find((q) => q.y * d.w + q.x === i);
        if (o) return o.kind === 'gate' ? 'G' : o.kind === 'entrance' ? 'E' : o.kind === 'chest' ? 'C' : o.kind === 'npc' ? 'N' : o.kind === 'ledge' ? 'L' : o.kind === 'stairs' ? 'S' : 'o';
        if (d.solid[i]) return d.ground[i] === T.WATER ? '~' : d.ground[i] === T.VOID ? ' ' : '#';
        return d.ground[i] === T.PATH ? ':' : String.fromCharCode(97 + d.region[i]);
      };
      for (let y = 0; y < d.h; y++) console.log(Array.from({ length: d.w }, (_, x) => ch(y * d.w + x)).join(''));
      console.log(w.dims.map((q) => `${q.id}:${q.w}x${q.h}:${q.objects.length}obj`).join(' '));
    }
  } catch (e) { thrown++; if (thrown < 4) console.log('seed' + i, 'THROW', (e as Error).stack?.split('\n').slice(0, 3).join(' | ')); }
}
console.log([...why].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => v + 'x ' + k).join('\n'));
console.log('SUMMARY', JSON.stringify({ N, bad, thrown, firstTry: first, avgAttempts: +(attempts / N).toFixed(2), msPer: +((Date.now() - t0) / N).toFixed(1) }));
