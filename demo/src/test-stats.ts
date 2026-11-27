import { generateWorld } from './gen/index';
import { reqItems } from './core/req';
import { requiredFor } from './core/solver';
import { PROGRESSION_TOOLS } from './core/content';
import { useSmallDefaults } from './core/settings';
useSmallDefaults();
const N = 150; let dead = 0, notReq = 0, edges = 0, open = 0, loops = 0, verticals = 0;
const gates = new Map<string, number>();
for (let i = 0; i < N; i++) {
  const w = generateWorld('st' + i);
  const used = new Set<string>();
  for (const e of w.graph.edges) { reqItems(e.req, used); edges++; if (e.gate === 'open') open++; gates.set(e.gate, (gates.get(e.gate) ?? 0) + 1); }
  for (const t of PROGRESSION_TOOLS) if (!used.has(t) && !(t === 'bombBag' && used.has('bombs')) && !(t === 'bow' && used.has('arrows'))) dead++;
  const goalLoc = w.graph.checks.find((c) => c.item === w.graph.goal)!.loc;
  const req = requiredFor(w.graph, w.items, goalLoc, PROGRESSION_TOOLS);
  notReq += PROGRESSION_TOOLS.length - req.length;
}
console.log(JSON.stringify({ deadToolsPerSeed: dead / N, toolsNotRequiredForGoalPerSeed: +(notReq / N).toFixed(2), edgesPerSeed: +(edges / N).toFixed(1), gates: Object.fromEntries([...gates].map(([k, v]) => [k, +(v / N).toFixed(1)])) }));
