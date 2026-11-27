// The tile table's checker: silent on generated worlds, and not silent when something is wrong.
// Each case plants one violation in a fresh world and expects the checker to name it; where the
// generator has a fix for it, the tidy-up must make the report go away again.
import { generateWorld } from './gen/index';
import { checkTiles, summariseIssues, tileCtx } from './core/tileset';
import { facedAt, levelAt, liftAt, reachesTop } from './core/shape';
import { settleTiles } from './gen/settle';
import { D, T, type Dimension } from './core/types';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();

declare const process: { argv: string[]; exitCode?: number };
const N = Number(process.argv[2] ?? 120);
let failed = 0;
const fail = (msg: string) => { failed++; console.log('FAILED:', msg); };

// 1. generated worlds raise no warnings.
// One kind is known and counted instead: a walkway one tile wide that runs along a drop cannot be
// given a wall without closing the walkway. The generator still makes a few per world; the
// checker reports each of them, and this test holds the number down until the generator stops.
const WALKWAY = /a wall under its edge|deep behind its wall face/;
let warned = 0, walkways = 0;
for (let i = 0; i < N; i++) {
  const w = generateWorld('tiles' + i);
  const all = w.dims.flatMap((d) => checkTiles(d));
  walkways += all.filter((x) => WALKWAY.test(x.lacks)).length;
  const issues = all.filter((x) => !WALKWAY.test(x.lacks));
  if (issues.length && warned++ < 3) console.log('  tiles' + i, summariseIssues(issues).join('; '));
}
console.log(`generated worlds with warnings: ${warned}/${N}`);
console.log(`walkways along a drop that could not be given a wall: ${(walkways / N).toFixed(1)} per world`);
if (warned) fail('the generator leaves tiles without what they need');
if (walkways / N > 8) fail('too many edges without a wall');

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
  const i = find(d, (k) => d.solid[k] === 1 && !d.deco[k] && !c.level(k) && d.ground[k] !== T.WALL);
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
  // (the tidy-up closes a lone raised tile and brings it down: raised ground is never that small)
  expect('a step between walkable tiles', d, /needs stairs/, true);
}
{
  const d = over(fresh());
  // (a block of 3 by 4, the smallest raised place there may be: anything smaller is tidied away, which is another rule's business)
  const free = (k: number) => !d.solid[k] && d.ground[k] === T.GRASS && !d.objects.some((o) => Math.abs(o.x - (k % d.w)) < 3 && Math.abs(o.y - ((k / d.w) | 0)) < 3);
  const block = (k: number) => [0, 1, 2, 3].flatMap((r) => [0, 1, 2].map((c) => k + r * d.w + c));
  const around = (k: number) => [-1, 0, 1, 2, 3, 4].flatMap((r) => [-1, 0, 1, 2, 3].map((c) => k + r * d.w + c));
  const i = find(d, (k) => k > 2 * d.w && k < d.w * (d.h - 6) && around(k).every(free));
  for (const k of block(i)) { d.ground[k] = T.FLOOR; d.elev[k]++; d.solid[k] = 1; }
  expect('a dungeon tile raised outdoors', d, /^Dungeon floor needs outdoor wall faces/, false);
  expect('a dungeon tile on the overworld', d, /^Dungeon floor needs to be on a map it belongs on/, false);
}
{
  const d = over(fresh()), c = tileCtx(d);
  const chest = d.objects.find((o) => o.kind === 'chest')!;
  const i = find(d, (k) => !c.level(k) && d.ground[k] !== T.WALL);
  chest.x = i % d.w; chest.y = (i / d.w) | 0;
  expect('a chest on a cliff edge', d, /^Chest .*needs level ground/, false);
}

// 3. the terrain model: however faces crowd a tile, raised ground keeps a top and walkable ground stays level
const sketch = (rows: string[], kind: Dimension['kind'] = 'overworld'): Dimension => {
  // '.' low ground, '#' raised and solid, 'H' raised two levels and solid, '=' raised and walkable, '~' water (lower), ' ' nothing
  const h = rows.length, w = rows[0].length, n = w * h;
  const d: Dimension = {
    id: 't', name: 'sketch', kind, w, h, sw: 12, sh: 10, ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n),
    solid: new Uint8Array(n), region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [],
  };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const i = y * w + x;
    d.ground[i] = ch === ' ' ? T.VOID : ch === '~' ? T.WATER : T.STONE;
    d.elev[i] = ch === '#' || ch === '=' ? 2 : ch === 'H' ? 3 : ch === '~' ? 0 : 1;
    d.solid[i] = ch === '.' || ch === '=' ? 0 : 1;
  }));
  return d;
};
const shapes: [string, string[]][] = [
  ['a lone hill', ['.....', '.....', '..#..', '.....', '.....']],
  ['a ridge running east', ['......', '......', '.####.', '......', '......']],
  ['a ridge running south', ['.....', '..#..', '..#..', '..#..', '..#..', '.....']],
  ['a ridge running diagonally', ['.......', '.#.....', '.##....', '..##...', '...##..', '....#..', '.......']],
  ['a peak on a hill', ['.......', '.#####.', '.##H##.', '.#####.', '.......']],
  ['a wall two tiles thick', ['......', '......', '######', '######', '......', '......']],
  ['a wall with nothing behind it', ['......', '......', '######', '      ', '      ']],
  ['a causeway between two waters', ['~~~~~~', '~~~~~~', '======', '~~~~~~', '~~~~~~']],
  ['a bank above water', ['======', '======', '~~~~~~', '~~~~~~']],
];
for (const mode of ['overworld', 'interior'] as const) {
  for (const [name, rows] of shapes) {
    const d = sketch(rows, mode);
    let noTop = 0, tilted = 0;
    for (let i = 0; i < d.w * d.h; i++) {
      if (d.ground[i] === T.VOID || d.ground[i] === T.WATER) continue;
      if (!reachesTop(d, i)) noTop++;
      if (!d.solid[i] && !levelAt(d, i)) tilted++;
    }
    if (noTop) fail(`${name} (${mode}): ${noTop} raised tile(s) never reach their height`);
    if (tilted) fail(`${name} (${mode}): ${tilted} walkable tile(s) are not level`);
  }
}
console.log(`  shapes: ${shapes.length} sketches x 2 kinds of map keep their tops and their walkable ground level`);
console.log(failed ? `TILES ${failed} failed` : 'TILES ok');
if (failed) process.exitCode = 1;
