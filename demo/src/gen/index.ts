// Public entry point: seed string in, finished World out.
import type { World } from '../core/types';
import { childSeed, hashStr } from '../core/rng';
import { solve } from '../core/solver';
import { buildBlueprint } from './logic';
import { realiseTiles } from './tiles';
import { runLints } from './validate';
import { checkTiles, summariseIssues } from '../core/tileset';
import { normalizeSettings, type GenSettings } from '../core/settings';

function attempt(seedStr: string, S: GenSettings, n: number, t0: number): World {
  const seed = childSeed(hashStr(seedStr), 'attempt' + n);
  const bp = buildBlueprint(seed, S);
  const tiles = realiseTiles(bp, seed);
  const solution = solve(bp.graph, bp.ctx.items);
  const kind = new Map(tiles.dims.map((d) => [d.id, d.kind]));
  const dimOf = new Map(bp.graph.locs.map((l) => [l.id, l.dim]));
  const lints = runLints(bp.graph, bp.ctx.items, solution, bp.ctx.npcs, bp.tree, (loc) => kind.get(dimOf.get(loc)!) ?? 'interior');
  lints.push({
    id: 'tiles', label: 'Tile maps match the logic graph (zones, gates, objects)', ok: tiles.problems.length === 0,
    detail: tiles.problems.length ? tiles.problems.slice(0, 4).join('; ') : `${tiles.dims.length} tile maps, ${bp.graph.edges.length} edges realised`,
  });
  // the tile table's own check: every ground, prop and object has what its place needs
  const issues = tiles.dims.flatMap((d) => checkTiles(d));
  lints.push({
    id: 'tileset', label: 'Every tile has what it needs where it stands (tile table)', ok: issues.length === 0, warn: true,
    detail: issues.length ? summariseIssues(issues).join('; ') : `${tiles.dims.reduce((a, d) => a + d.w * d.h, 0)} tiles and ${tiles.dims.reduce((a, d) => a + d.objects.length, 0)} objects checked`,
  });
  const sh = bp.ctx.shape;
  const sides = (['n', 'e', 's', 'w'] as const).map((k) => ({ k, name: { n: 'north', e: 'east', s: 'south', w: 'west' }[k], sea: sh.sea[k] }));
  const seaSides = sides.filter((x) => x.sea).map((x) => x.name), landSides = sides.filter((x) => !x.sea).map((x) => x.name);
  lints.push({
    id: 'shape', label: 'World shape (from the seed unless set)', ok: true,
    detail: `landlocked ${Math.round(sh.landlocked * 100)}%: ` + (seaSides.length === 4 ? 'a full island, sea on every side' : seaSides.length === 0 ? 'fully landlocked, no ocean' : `sea to the ${seaSides.join(', ')}; the land goes on to the ${landSides.join(', ')}`),
  });
  return {
    seed: seedStr, settings: S, shape: sh, items: bp.ctx.items, dims: tiles.dims, tree: bp.tree, graph: bp.graph, npcs: bp.ctx.npcs, quests: bp.ctx.quests,
    solution, lints, ok: lints.every((l) => l.ok || l.warn), stats: { attempts: n + 1, ms: Date.now() - t0 },
  };
}

/**
 * Generate-and-test: almost every attempt is valid by construction; when the tile pass cannot
 * fit something (a region came out too cramped), the next attempt reshuffles from a derived seed.
 * Still fully deterministic per seed string and settings.
 */
export function generateWorld(seedStr: string, settings?: Partial<GenSettings> | null, _opts: { anySize?: boolean } = {}): World {
  const S = normalizeSettings(settings);
  const maxAttempts = S.maxAttempts;
  const t0 = Date.now();
  let best: World | null = null;
  for (let n = 0; n < maxAttempts; n++) {
    try {
      const w = attempt(seedStr, S, n, t0);
      if (w.ok) return w;
      best ??= w;
    } catch (e) {
      if (n === maxAttempts - 1 && !best) throw e;
    }
  }
  return best!;
}
