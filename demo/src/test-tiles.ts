// The tile table's checker: silent on generated worlds, and not silent when something is wrong.
// Each case plants one violation in a fresh world and expects the checker to name it; where the
// generator has a fix for it, the tidy-up must make the report go away again.
import { generateWorld } from './gen/index';
import { checkTiles, summariseIssues, tileCtx } from './core/tileset';
import { facedAt, liftAt } from './core/shape';
import { settleTiles } from './gen/settle';
import { D, T, type Dimension } from './core/types';

declare const process: { argv: string[]; exitCode?: number };
const N = Number(process.argv[2] ?? 120);
let failed = 0;
const fail = (msg: string) => { failed++; console.log('FAILED:', msg); };

// 1. generated worlds raise no warnings
let warned = 0;
for (let i = 0; i < N; i++) {
  const w = generateWorld('tiles' + i);
  const issues = w.dims.flatMap((d) => checkTiles(d));
  if (issues.length && warned++ < 3) console.log('  tiles' + i, summariseIssues(issues).join('; '));
}
console.log(`generated worlds with warnings: ${warned}/${N}`);
if (warned) fail('the generator leaves tiles without what they need');

// 2. planted violations are found, and named from the table
const fresh = () => generateWorld('tiles-plant');
const over = (w: ReturnType<typeof fresh>) => w.dims.find((d) => d.kind === 'overworld')!;
const inside = (w: ReturnType<typeof fresh>) => w.dims.find((d) => d.kind === 'interior' && d.w > 30)!;
const find = (d: Dimension, ok: (i: number) => boolean) => { for (let i = d.w; i < d.w * d.h - d.w; i++) if (ok(i)) return i; throw new Error('no such tile'); };
const expect = (name: string, d: Dimension, wants: RegExp, fixable: boolean) => {
  const before = checkTiles(d).filter((x) => wants.test(`${x.what} needs ${x.lacks}`));
  if (!before.length) return fail(`${name}: not reported`);
  settleTiles(d);
  const after = checkTiles(d).filter((x) => wants.test(`${x.what} needs ${x.lacks}`));
  if (fixable && after.length) fail(`${name}: reported, but the tidy-up did not fix it`);
  if (!fixable && !after.length) fail(`${name}: the tidy-up hid a problem it cannot fix`);
  console.log(`  ${name.padEnd(34)} reported as "${before[0].what} needs ${before[0].lacks}"${fixable ? ', then fixed' : ''}`);
};
{
  const d = over(fresh()), c = tileCtx(d);
  const i = find(d, (k) => d.solid[k] === 1 && !d.deco[k] && c.edge(k) && d.ground[k] !== T.WALL);
  d.deco[i] = D.PINE;
  expect('a pine on a cliff edge', d, /^Pine needs level ground/, true);
}
{
  // the case a screenshot caught: water below a bank makes a face just as lower land does
  const d = over(fresh());
  const wet = (k: number) => d.ground[k] === T.WATER || d.ground[k] === T.DEEP;
  const i = find(d, (k) => d.solid[k] === 1 && !wet(k) && d.ground[k] !== T.VOID && wet(k + d.w) && liftAt(d, k + d.w) < liftAt(d, k) && !d.deco[k]);
  d.deco[i] = D.TREE;
  expect('a tree on a bank above water', d, /^Tree needs level ground/, true);
}
{
  const d = over(fresh()), c = tileCtx(d);
  const i = find(d, (k) => d.solid[k] === 1 && c.underFace(k) && !c.edge(k) && d.ground[k] === T.GRASS);
  d.deco[i] = D.TREE;
  expect('a tree hiding a cliff face', d, /^Tree needs to stay clear/, true);
  if (d.deco[i] !== D.ROCK) fail('a tree under a face should become a rock');
}
{
  const d = over(fresh());
  const i = find(d, (k) => !d.solid[k] && !d.solid[k + 1] && d.ground[k] === T.GRASS && d.ground[k + 1] === T.GRASS && !facedAt(d, k) && !facedAt(d, k + 1) && !d.objects.some((o) => Math.abs(o.x - (k % d.w)) < 2 && Math.abs(o.y - ((k / d.w) | 0)) < 2));
  d.elev[i]++;
  expect('a step between walkable tiles', d, /needs stairs/, false);
}
{
  const d = over(fresh());
  const i = find(d, (k) => !d.solid[k] && d.ground[k] === T.GRASS && !d.objects.some((o) => Math.abs(o.x - (k % d.w)) < 2 && Math.abs(o.y - ((k / d.w) | 0)) < 2));
  d.ground[i] = T.FLOOR; d.elev[i]++; d.solid[i] = 1;
  expect('a dungeon tile raised outdoors', d, /^Dungeon floor needs outdoor wall faces/, false);
  expect('a dungeon tile on the overworld', d, /^Dungeon floor needs to be on a map it belongs on/, false);
}
{
  const d = over(fresh()), c = tileCtx(d);
  const chest = d.objects.find((o) => o.kind === 'chest')!;
  const i = find(d, (k) => c.edge(k) && d.ground[k] !== T.WALL);
  chest.x = i % d.w; chest.y = (i / d.w) | 0;
  expect('a chest on a cliff edge', d, /^Chest .*needs level ground/, false);
}
{
  const d = inside(fresh());
  // a one-tile wall across a room: floor to its north, floor to its south
  const i = find(d, (k) => !d.solid[k] && !d.solid[k - d.w] && !d.solid[k + d.w] && d.elev[k] === d.elev[k - d.w] && d.elev[k] === d.elev[k + d.w] && !d.objects.some((o) => o.y * d.w + o.x === k));
  d.ground[i] = T.WALL; d.solid[i] = 1; d.elev[i]++;
  expect('a wall too thin for its north face', d, /tiles of depth behind its north face/, true);
  if (!d.lip?.[i]) fail('a wall without depth should take the lip pattern');
}
console.log(failed ? `TILES ${failed} failed` : 'TILES ok');
if (failed) process.exitCode = 1;
