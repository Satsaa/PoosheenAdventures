import { hashStr } from './core/rng';
import { solve } from './core/solver';
import { fmtReq } from './core/req';
import { buildBlueprint } from './gen/logic';
import { runLints } from './gen/validate';
import { defaultSettings } from './core/settings';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();

let fail = 0, thrown = 0;
const N = Number(process.argv[2] ?? 300);
const t0 = Date.now();
const stats = { spheres: 0, checks: 0, locs: 0, oneWay: 0 };
for (let i = 0; i < N; i++) {
  try {
    const bp = buildBlueprint(hashStr('seed' + i), defaultSettings());
    const sol = solve(bp.graph, bp.ctx.items);
    const dimKind = (loc: string) => (bp.ctx.stacks.some((s) => s.id === bp.ctx.locs.get(loc)!.dim) ? 'stack' : 'interior');
    const lints = runLints(bp.graph, bp.ctx.items, sol, bp.ctx.npcs, bp.tree, dimKind);
    const bad = lints.filter((l) => !l.ok);
    stats.spheres += sol.spheres.length; stats.checks += bp.graph.checks.length; stats.locs += bp.graph.locs.length;
    stats.oneWay += bp.graph.edges.filter((e) => e.oneWay).length;
    if (bad.length) { fail++; if (fail <= 8) console.log('seed' + i, bad.map((b) => b.id + ': ' + b.detail).join(' | ')); }
    if (i === 0) {
      console.log('order', bp.plan.tools.join(' > '));
      for (const sp of sol.spheres) console.log(' sphere', sp.index, 'locs+', sp.newLocs.length, sp.collected.map((c) => c.item).join(','));
      for (const e of bp.graph.edges.slice(0, 12)) console.log('  ', e.a, e.oneWay ? '->' : '<->', e.b, e.gate, fmtReq(e.req, bp.ctx.items), e.lock ?? '');
    }
  } catch (e) { thrown++; if (thrown <= 5) console.log('seed' + i, 'THROW', (e as Error).message, (e as Error).stack?.split('\n')[1]); }
}
console.log('SUMMARY', JSON.stringify({ N, fail, thrown, ms: Date.now() - t0, avg: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, +(v / N).toFixed(1)])) }));
