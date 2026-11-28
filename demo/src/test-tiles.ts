// The tile table's checker: silent on generated worlds, and not silent when something is wrong.
// Each case plants one violation in a fresh world and expects the checker to name it; where the
// generator has a fix for it, the tidy-up must make the report go away again.
import { generateWorld } from './gen/index';
import { checkTiles, summariseIssues, tileCtx } from './core/tileset';
import { facedAt, fieldOf, kindAt, levelAt, liftAt, surface } from './core/shape';
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
let warned = 0, walkways = 0, docks = 0, badDocks = 0;
// every straight stretch of wall in every world, measured from the terrain model: how deep is its face?
const depth = new Map<string, Map<number, number>>();
const tally = (k: string, d: number) => { const m = depth.get(k) ?? depth.set(k, new Map()).get(k)!; m.set(d, (m.get(d) ?? 0) + 1); };
for (let i = 0; i < N; i++) {
  const w = generateWorld('tiles' + i);
  const all = w.dims.flatMap((d) => checkTiles(d));
  walkways += all.filter((x) => WALKWAY.test(x.lacks)).length;
  for (const d of w.dims) {
    const F = fieldOf(d), room = d.kind === 'interior' || d.kind === 'underworld';
    const low = (j: number, L: number) => { const k = kindAt(d, j) & 3; return k !== 1 && liftAt(d, j) < L - (k === 2 ? 4 : 0); };
    for (let y = 4; y < d.h - 4; y++) for (let x = 4; x < d.w - 4; x++) {
      const t = y * d.w + x;
      if (!d.solid[t] || (kindAt(d, t) & 3) || d.cut?.[t] || d.lip?.[t]) continue;
      const L = liftAt(d, t);
      for (const [dx, dy, name] of [[0, 1, 'south'], [0, -1, 'north'], [1, 0, 'east'], [-1, 0, 'west']] as const) {
        const f = t + dx + dy * d.w, sx = dy !== 0 ? 1 : 0, sy = dx !== 0 ? 1 : 0;
        if (!low(f, L)) continue;
        // a straight stretch: the tiles two to either side along the wall are the same wall, uncut
        let straight = true;
        for (const k of [-2, -1, 1, 2]) { const q = t + (sx + sy * d.w) * k; if (liftAt(d, q) !== L || !d.solid[q] || d.cut?.[q] || !low(q + dx + dy * d.w, L) || liftAt(d, q + dx + dy * d.w) !== liftAt(d, f)) straight = false; }
        if (!straight) continue;
        // walk in from the edge along the middle of the tile until the surface is at full height
        let px = 0;
        for (; px < 64; px++) {
          const k = Math.floor(px / 16), xx = x - dx * k, yy = y - dy * k, q = yy * d.w + xx;
          if (liftAt(d, q) !== L || (kindAt(d, q) & 3)) break;
          const u = px - k * 16 + 0.5, lx = dx > 0 ? 16 - u : dx < 0 ? u : 8, ly = dy > 0 ? 16 - u : dy < 0 ? u : 8;
          if (surface(F, xx, yy, lx, ly) >= L - 0.01) break;
        }
        tally((room ? 'rooms and caves' : 'outdoors') + ', facing ' + name, Math.round(px / 4) / 4);
      }
    }
  }
  // a jetty stands on the water's level or one above it, never on a cliff
  for (const d of w.dims) for (const o of d.objects.filter((q) => q.style === 'dock')) {
    let sea = -1;
    for (let r = 1; r <= 4 && sea < 0; r++) for (let dy = -r; dy <= r && sea < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = o.x + dx, y = o.y + dy;
      if (x < 0 || y < 0 || x >= d.w || y >= d.h) continue;
      const j = y * d.w + x;
      if (d.ground[j] === T.DEEP || d.ground[j] === T.WATER) { sea = d.elev[j]; break; }
    }
    const depth = sea < 0 ? 99 : d.elev[o.y * d.w + o.x] - sea;
    docks++;
    if (depth < 0 || depth > 1) badDocks++;
  }
  const issues = all.filter((x) => !WALKWAY.test(x.lacks));
  if (issues.length && warned++ < 3) console.log('  tiles' + i, summariseIssues(issues).join('; '));
}
console.log(`generated worlds with warnings: ${warned}/${N}`);
// what the wall table promises: outdoors two tiles facing south and one tile the other ways; two tiles all round in rooms and caves
console.log('wall face depth in tiles, every straight stretch of wall in these worlds (depth: how many):');
let offSize = 0, allFaces = 0;
for (const [k, m] of [...depth].sort()) {
  const want = k.startsWith('rooms') || k.endsWith('south') ? 2 : 1, total = [...m.values()].reduce((a, b) => a + b, 0), ok = m.get(want) ?? 0;
  allFaces += total; offSize += total - ok;
  console.log(`  ${k.padEnd(32)} wanted ${want}: ${ok} of ${total} (${((ok / total) * 100).toFixed(1)}%)` + (ok < total ? '  others: ' + [...m].filter(([q]) => q !== want).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([q, c]) => `${q} x${c}`).join(', ') : ''));
}
if (offSize / Math.max(1, allFaces) > 0.005) fail('wall faces are not the size the wall table gives');
console.log(`walkways along a drop that could not be given a wall: ${(walkways / N).toFixed(2)} per world (${walkways} in ${N} worlds)`);
console.log(`docks: ${docks}, of which more than one level above their water (or below it): ${badDocks}`);
if (badDocks) fail('a dock stands on a cliff');
if (warned) fail('the generator leaves tiles without what they need');
if (walkways / N > 6) fail('too many edges without a wall');

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
  // (such a tile is rare now that every step has a wall of closed ground: look through a few worlds for one)
  let d = over(fresh()), i = -1;
  for (let k = 0; k < 12 && i < 0; k++) {
    d = over(k ? generateWorld('tiles-plant' + k) : fresh());
    const c = tileCtx(d);
    try { i = find(d, (q) => d.solid[q] === 1 && c.underFace(q) && !c.edge(q) && d.ground[q] !== T.WALL && d.ground[q] !== T.WATER && d.ground[q] !== T.DEEP && !d.deco[q]); } catch { i = -1; }
  }
  if (i < 0) throw new Error('no closed ground under a wall face in 12 worlds');
  d.deco[i] = D.TREE;
  expect('a tree hiding a cliff face', d, /^Tree needs to stay clear/, true);
  // (it becomes a rock, unless the tidy-up rebuilt the ground there, which clears the tile)
  if (d.deco[i] === D.TREE) fail('a tree under a face should become a rock');
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
  const open = new Set<number>([T.GRASS, T.SAND, T.STONE, T.SNOW, T.DIRT]);
  const free = (k: number) => !d.solid[k] && open.has(d.ground[k]) && !d.objects.some((o) => Math.abs(o.x - (k % d.w)) < 2 && Math.abs(o.y - ((k / d.w) | 0)) < 2);
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

// 3. the size rule: a raised place has room for its walls and a tile of top, or the checker says so;
//    and ground one can walk on is level whatever stands beside it
const sketch = (rows: string[], kind: Dimension['kind'] = 'overworld'): Dimension => {
  // '.' low ground, '#' raised and solid, '=' raised and walkable, '~' water (lower), ' ' nothing
  const h = rows.length, w = rows[0].length, n = w * h;
  const d: Dimension = {
    id: 't', name: 'sketch', kind, w, h, sw: 12, sh: 10, ground: new Uint8Array(n), deco: new Uint8Array(n), elev: new Int8Array(n),
    solid: new Uint8Array(n), region: new Int16Array(n).fill(-1), zone: new Int32Array(n).fill(-1), zoneLoc: [], regions: [], objects: [],
  };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const i = y * w + x;
    d.ground[i] = ch === ' ' ? T.VOID : ch === '~' ? T.WATER : T.STONE;
    d.elev[i] = ch === '#' || ch === '=' ? 2 : ch === '~' ? 0 : 1;
    d.solid[i] = ch === '.' || ch === '=' ? 0 : 1;
  }));
  return d;
};
const block = (bw: number, bh: number): string[] => { const pad = '.'.repeat(bw + 4); return [pad, pad, ...Array.from({ length: bh }, () => '..' + '#'.repeat(bw) + '..'), pad, pad, pad]; };
// [name, map, too small outdoors (walls 1 + 1 top + 1 across, 1 + 1 + 2 down), too small in rooms (2 + 1 + 2 both ways)]
const shapes: [string, string[], boolean, boolean][] = [
  ['a lone hill', block(1, 1), true, true],
  ['a ridge running east', block(6, 1), true, true],
  ['a ridge running south', block(1, 6), true, true],
  ['a wall two tiles thick', block(6, 2), true, true],
  ['a block of 3 x 3', block(3, 3), true, true],
  ['a block of 3 x 4', block(3, 4), false, true],
  ['a block of 4 x 4', block(4, 4), false, true],
  ['a block of 5 x 5', block(5, 5), false, false],
  ['a wall with nothing behind it', ['......', '......', '######', '      ', '      '], false, false],
  ['a causeway between two waters', ['~~~~~~', '~~~~~~', '======', '~~~~~~', '~~~~~~'], false, false],
  ['a bank above water', ['======', '======', '~~~~~~', '~~~~~~'], false, false],
];
for (const mode of ['overworld', 'interior'] as const) {
  for (const [name, rows, smallOut, smallIn] of shapes) {
    const d = sketch(rows, mode);
    const said = checkTiles(d).some((x) => /a place of its own/.test(x.lacks)), want = mode === 'overworld' ? smallOut : smallIn;
    if (said !== want) fail(`${name} (${mode}): ${want ? 'too small for its walls, but not reported' : 'reported as too small, though it has room'}`);
    let tilted = 0;
    for (let i = 0; i < d.w * d.h; i++) if (d.ground[i] !== T.VOID && d.ground[i] !== T.WATER && !d.solid[i] && !levelAt(d, i)) tilted++;
    if (tilted) fail(`${name} (${mode}): ${tilted} walkable tile(s) are not level`);
  }
}
console.log(`  sizes: ${shapes.length} sketches x 2 kinds of map are reported exactly when they are too small for their walls`);
console.log(failed ? `TILES ${failed} failed` : 'TILES ok');
if (failed) process.exitCode = 1;
