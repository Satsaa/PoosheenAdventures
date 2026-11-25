// What the world looks like after sphere k of the solver's playthrough. Pure function of World.
import type { ItemId, LocId, World } from './types';
import { evalReq, type Caps } from './req';

export interface WorldState {
  sphere: number;
  reachable: Set<LocId>;
  fresh: Set<LocId>;
  inv: Record<ItemId, number>;
  renewable: Set<ItemId>;
  /** map object ids: opened chests, cleared gates, unlocked doors */
  done: Set<string>;
  /** map object ids of NPC stages that are not the active one */
  hidden: Set<string>;
  /** active stage index per npc id */
  npcStage: Record<string, number>;
  /** items picked up in exactly this sphere */
  gained: ItemId[];
}

export function stateAt(world: World, k: number): WorldState {
  const sol = world.solution;
  k = Math.max(0, Math.min(sol.spheres.length - 1, k));
  const sp = sol.spheres[k];
  const inv = sp?.inv ?? {};
  const caps: Caps = { inv: new Map(Object.entries(inv)), renewable: new Set(sp?.renewable ?? []) };
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
    const open = e.lock ? unlocked.has(e.id) : e.gate !== 'open' && e.gate !== 'ledge' && e.gate !== 'portal' && evalReq(e.req, caps, world.items);
    if (open) done.add('g.' + e.id);
  }
  const hidden = new Set<string>();
  const npcStage: Record<string, number> = {};
  for (const n of world.npcs) {
    let active = 0;
    n.stages.forEach((st, i) => { if (evalReq(st.when, caps, world.items)) active = i; });
    npcStage[n.id] = active;
    n.stages.forEach((_, i) => { if (i !== active) hidden.add(`o.${n.id}.${i}`); });
  }
  return { sphere: k, reachable, fresh, inv, renewable: caps.renewable, done, hidden, npcStage, gained: sp?.collected.map((c) => c.item) ?? [] };
}
