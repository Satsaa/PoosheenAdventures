// What the world looks like after sphere k of the solver's playthrough. Pure function of World.
import type { ItemId, LocId, Phase, World } from './types';

/** Day runs from 6:00 to 18:00. */
export const phaseAt = (hours: number): Phase => (hours >= 6 && hours < 18 ? 'day' : 'night');
import { evalReq, type Caps } from './req';

export interface WorldState {
  sphere: number;
  /** time of day, 0..24 */
  hours: number;
  phase: Phase;
  reachable: Set<LocId>;
  fresh: Set<LocId>;
  inv: Record<ItemId, number>;
  renewable: Set<ItemId>;
  /** map object ids: opened chests, cleared gates, unlocked doors */
  done: Set<string>;
  /** map object ids of NPC stages that are not the active one */
  hidden: Set<string>;
  /** active stage index per npc id; -1 while the NPC has not appeared */
  npcStage: Record<string, number>;
  /** items picked up in exactly this sphere */
  gained: ItemId[];
}

export function stateAt(world: World, k: number, hours = 10): WorldState {
  const phase = phaseAt(hours);
  const sol = world.solution;
  k = Math.max(0, Math.min(sol.spheres.length - 1, k));
  const sp = sol.spheres[k];
  const inv = sp?.inv ?? {};
  const caps: Caps = { inv: new Map(Object.entries(inv)), renewable: new Set(sp?.renewable ?? []), anyTime: world.graph.timeFlows };
  const reachable = new Set<LocId>();
  const fresh = new Set<LocId>();
  for (const [loc, s] of Object.entries(sol.locSphere)) {
    if (s <= k) reachable.add(loc);
    if (s === k) fresh.add(loc);
  }
  const done = new Set<string>();
  for (const [check, s] of Object.entries(sol.checkSphere)) if (s <= k) done.add('o.' + check);
  const unlocked = new Set(sol.spheres.slice(0, k + 1).flatMap((s) => s.opened));
  for (const e of world.graph.edges) {
    const open = e.lock ? unlocked.has(e.id) : e.gate !== 'open' && e.gate !== 'ledge' && e.gate !== 'portal' && e.gate !== 'shore' && e.gate !== 'waterfall' && evalReq(e.req, caps, world.items);
    if (open) done.add('g.' + e.id);
  }
  const hidden = new Set<string>();
  const npcStage: Record<string, number> = {};
  for (const n of world.npcs) {
    let active = -1; // -1: this NPC has not appeared yet
    n.stages.forEach((st, i) => { if (evalReq(st.when, caps, world.items)) active = i; });
    npcStage[n.id] = active;
    // an NPC that keeps hours is simply not out at the wrong time of day
    n.stages.forEach((st, i) => { if (i !== active || (st.phase && st.phase !== phase)) hidden.add(`o.${n.id}.${i}`); });
  }
  // night creatures, moonlit chests, day-time stalls
  for (const d of world.dims) for (const o of d.objects) if (o.phase && o.phase !== phase) hidden.add(o.id);
  return { sphere: k, hours, phase, reachable, fresh, inv, renewable: caps.renewable, done, hidden, npcStage, gained: sp?.collected.map((c) => c.item) ?? [] };
}
