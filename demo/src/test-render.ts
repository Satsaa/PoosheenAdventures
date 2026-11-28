// What is drawn, checked without a screen: the terrain of generated worlds is composed exactly as
// the renderer composes it (same code, in Node), and the list of pieces it would draw is checked
// against the rules for walls, diagonals, fog and water.
//   node build.mjs --test   (or: esbuild src/test-render.ts ... && node dist/test-render.cjs [worlds])
import { generateWorld } from './gen/index';
import { useSmallDefaults } from './core/settings';
import { T, type Dimension } from './core/types';
import { KIND, cornerAt, fieldOf, kindAt, liftAt, surface, wallStyle } from './core/shape';
import { bakeAtlas } from './render/bake';
import { buildStatic, layout, FLOATS } from './render/lit/compose';
import { resetWallSprites, wallStats } from './render/bake/walls';
import { computeVe } from './render/terrain';
useSmallDefaults();

const N = Number(process.argv[2] || 30);
let failed = 0;
const fail = (m: string) => { failed++; console.log('FAILED:', m); };
const sheet = bakeAtlas(1);
const framesOf = (prefix: string) => { const s = new Set<number>(); for (const [k, fs] of sheet.frames) if (k.startsWith(prefix)) for (const f of fs) s.add(f.y * 65536 + f.x); return s; };
const liquid = (g: number) => g === T.WATER || g === T.DEEP || g === T.LAVA;

const uncut = new Map<string, number>(), all = new Map<string, number>();
const tot = { wallTiles: 0, wallBaked: 0, wallLive: 0, faceFogOwn: 0, faceFogLower: 0, cutTiles: 0, cutWithHalf: 0, corners: 0, cornersCut: 0, shoreCorners: 0, shoreDiag: 0, jambs: 0, jambsCut: 0, specks: 0, specksVoid: 0,
  shorePairs: 0, shoreFlush: 0, shoreWall: 0, bodies: 0, bodiesFlush: 0, waterSteps: 0, waterfallSteps: 0 };
for (let s = 0; s < N; s++) {
  const world = generateWorld('render' + s);
  resetWallSprites(sheet);
  for (const dim of world.dims) {
    const { w, h } = dim, n = w * h;
    const { ve, voidElev } = computeVe(dim);
    const lay = layout(dim, ve, voidElev);
    const { inst } = buildStatic(dim, lay, sheet, 1);
    const wl = framesOf('wl:'), dg = framesOf('dg:');
    const wallAt = new Map<number, [number, number]>(), halfAt = new Set<number>(), diagAt = new Set<number>();
    for (let k = 0; k < inst.n; k++) {
      const o = k * FLOATS, f = inst.f;
      const x = Math.round(f[o] / 16), y = Math.round((f[o + 1] - lay.top) / 16), t = y * w + x;
      if (f[o + 2] !== 16 || f[o + 3] !== 16 || x < 0 || y < 0 || x >= w || y >= h) continue;
      if (f[o + 6] === -3) tot.wallLive++;
      if (wl.has(f[o + 5] * 65536 + f[o + 4])) wallAt.set(t, [f[o + 9], f[o + 10]]);
      if (f[o + 6] >= 0 && dg.has(f[o + 7] * 65536 + f[o + 6])) { diagAt.add(t); if (f[o + 9] !== x || f[o + 10] !== y) halfAt.add(t); }
    }
    for (let i = 0; i < n; i++) {
      const x = i % w, y = (i / w) | 0, L = liftAt(dim, i), k = lay.kind![i];
      // ---- walls: every tile with a wall face on it is a baked piece, and takes the fog of lower ground it faces
      if ((k & KIND.SLOPED) && !(k & 3)) {
        const at = wallAt.get(i);
        if (at) {
          tot.wallBaked++;
          const j = at[1] * w + at[0];
          if (j !== i && liftAt(dim, j) < L) tot.faceFogLower++; else tot.faceFogOwn++;
        }
      }
      // ---- 45 degrees, walls: every outward corner of ground whose kind of wall is cut
      if (dim.solid[i] && !(kindAt(dim, i) & 3) && cornerAt(dim, i) && wallStyle(dim.kind, dim.ground[i]).corners === 'cut') {
        // a corner at a gap one tile wide is the jamb of a doorway or a gateway, and those stay upright
        let jamb = false;
        for (const d of [1, -1, w, -w]) { const t = i + d, u = t + d; if (t >= 0 && u >= 0 && t < n && u < n && dim.ground[t] !== T.VOID && liftAt(dim, t) < L && dim.ground[u] !== T.VOID && liftAt(dim, u) >= L) jamb = true; }
        if (jamb) { tot.jambs++; if (dim.cut?.[i]) tot.jambsCut++; }
        else {
          tot.corners++;
          all.set(dim.kind, (all.get(dim.kind) ?? 0) + 1);
          if (dim.cut?.[i]) tot.cornersCut++; else uncut.set(dim.kind, (uncut.get(dim.kind) ?? 0) + 1);
        }
      }
      if (dim.cut?.[i] && dim.solid[i]) { tot.cutTiles++; if (halfAt.has(i)) tot.cutWithHalf++; }
      // ---- 45 degrees, ground: land with water on its own level on two sides that meet (and land on the other two)
      if (!liquid(dim.ground[i]) && dim.ground[i] !== T.VOID && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const wet = (j: number) => liquid(dim.ground[j]) && liftAt(dim, j) === L, dry = (j: number) => !liquid(dim.ground[j]) && dim.ground[j] !== T.VOID;
        for (const [a, b, c, d] of [[i - w, i + 1, i + w, i - 1], [i + 1, i + w, i - 1, i - w], [i + w, i - 1, i - w, i + 1], [i - 1, i - w, i + 1, i + w]])
          if (wet(a) && wet(b) && dim.ground[a] === dim.ground[b] && dry(c) && dry(d)) { tot.shoreCorners++; if (diagAt.has(i)) tot.shoreDiag++; break; }
      }
    }
    // ---- specks: a patch of top smaller than a tile, cut off from any ground one can stand on
    {
      const W4 = w * 4, H4 = h * 4, F = fieldOf(dim), top = new Int16Array(W4 * H4).fill(-1), walk = new Uint8Array(W4 * H4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, k = kindAt(dim, i);
        if (k & 3) continue;
        const L = liftAt(dim, i);
        for (let b = 0; b < 4; b++) for (let a2 = 0; a2 < 4; a2++) {
          const q = (y * 4 + b) * W4 + x * 4 + a2;
          if (k & KIND.WALK) { top[q] = L; walk[q] = 1; } else if (!(lay.kind![i] & KIND.SLOPED) || surface(F, x, y, a2 * 4 + 2, b * 4 + 2) >= L - 0.3) top[q] = L;
        }
      }
      const seen4 = new Uint8Array(W4 * H4);
      for (let s0 = 0; s0 < W4 * H4; s0++) {
        if (seen4[s0] || top[s0] < 0) continue;
        const q = [s0]; seen4[s0] = 1;
        let hasWalk = false, edge = false, byVoid = false;
        for (let k = 0; k < q.length; k++) {
          const c = q[k], x = c % W4, y = (c / W4) | 0;
          if (walk[c]) hasWalk = true;
          if (x < 8 || y < 8 || x >= W4 - 8 || y >= H4 - 8) edge = true;
          for (const t of [x > 0 ? c - 1 : -1, x < W4 - 1 ? c + 1 : -1, c - W4, c + W4]) {
            if (t < 0 || t >= W4 * H4) continue;
            if (dim.ground[((t / W4) >> 2) * w + ((t % W4) >> 2)] === T.VOID) byVoid = true;
            if (!seen4[t] && top[t] === top[s0]) { seen4[t] = 1; q.push(t); }
          }
        }
        if (!hasWalk && !edge && q.length < 16) { if (byVoid) tot.specksVoid++; else tot.specks++; }
      }
    }
    // ---- water lies on the level of the land beside it
    const seen = new Uint8Array(n);
    for (let s0 = 0; s0 < n; s0++) {
      if (seen[s0] || !liquid(dim.ground[s0])) continue;
      const body = [s0]; seen[s0] = 1;
      let flush = false, shore = 0;
      for (let q = 0; q < body.length; q++) {
        const i = body[q], x = i % w, Li = liftAt(dim, i);
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j < 0 || j >= n || dim.ground[j] === T.VOID) continue;
          if (liquid(dim.ground[j])) {
            if (liftAt(dim, j) !== Li) { if (j > i) { tot.waterSteps++; if (dim.flow?.[i] || dim.flow?.[j]) tot.waterfallSteps++; } continue; }
            if (!seen[j]) { seen[j] = 1; body.push(j); }
            continue;
          }
          shore++; tot.shorePairs++;
          const dL = liftAt(dim, j) - Li;
          if (dL === 0) { tot.shoreFlush++; flush = true; } else if (dL > 0) tot.shoreWall++;
        }
      }
      if (shore) { tot.bodies++; if (flush) tot.bodiesFlush++; }
    }
    for (let i = 0; i < n; i++) if ((lay.kind![i] & KIND.SLOPED) && !(lay.kind![i] & 3) && dim.solid[i]) tot.wallTiles++;
  }
}
const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((a / b) * 100).toFixed(1) : '100.0'}%)`;
console.log(`composed the terrain of ${N} worlds`);
console.log('  walls drawn the slow way (not from a baked piece):', tot.wallLive, `(wall pieces baked per world: ${Math.round(wallStats.baked / N)}; times the sheet was full: ${wallStats.full})`);
console.log('  wall pieces that take the fog of lower ground they face:', pct(tot.faceFogLower, tot.faceFogLower + tot.faceFogOwn));
console.log('  outward corners of raised ground cut at 45 degrees:', pct(tot.cornersCut, tot.corners));
console.log('    by kind of map (cut of all):', [...all].map(([k, v]) => `${k} ${v - (uncut.get(k) ?? 0)} of ${v}`).join(', '), '(a corner stays square only where an object, a gate or a building stands on or beside it)');
console.log('  doorway and gateway jambs (kept upright):', tot.jambs, '| cut by mistake:', tot.jambsCut);
if (tot.cornersCut / Math.max(1, tot.corners) < 0.95) fail('outward corners are not cut at 45 degrees');
if (tot.jambsCut) fail('a doorway jamb was cut');
console.log('  cut corners that show the lower ground on their cut half:', pct(tot.cutWithHalf, tot.cutTiles));
console.log('  shore corners (water on two sides that meet) drawn as a 45 degree line:', pct(tot.shoreDiag, tot.shoreCorners));
console.log(`  specks of top (smaller than a tile, among wall faces): ${tot.specks} in ${N} worlds; at the edge of the rock outside a cave: ${tot.specksVoid}`);
if (tot.specks / N > 0.5) fail('walls leave specks of top');
console.log('  bodies of water and lava with a shore flush with the land:', pct(tot.bodiesFlush, tot.bodies));
console.log('  shore, tile by tile: flush', pct(tot.shoreFlush, tot.shorePairs), '| under a wall of higher land', tot.shoreWall, '| land below the water', tot.shorePairs - tot.shoreFlush - tot.shoreWall);
console.log('  steps between two water tiles:', tot.waterSteps, '(of which on a flowing river, a waterfall:', tot.waterfallSteps + ')');
if (tot.wallLive) fail('some walls are drawn the slow way');
if (tot.faceFogLower / Math.max(1, tot.faceFogLower + tot.faceFogOwn) < 0.97) fail('wall faces do not take the fog of the ground they face');
if (tot.cutWithHalf / Math.max(1, tot.cutTiles) < 0.99) fail('cut corners do not show the lower ground on their cut half');
if (tot.shoreDiag / Math.max(1, tot.shoreCorners) < 0.97) fail('shore corners are not drawn as 45 degree lines');
if (tot.bodiesFlush / Math.max(1, tot.bodies) < 0.97) fail('water lies below the land around it');
if ((tot.shorePairs - tot.shoreFlush - tot.shoreWall) / Math.max(1, tot.shorePairs) > 0.001) fail('land lies below the water beside it');
console.log(failed ? `RENDER ${failed} failed` : 'RENDER ok');
if (failed) process.exit(1);
