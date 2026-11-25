// Sphere search over the flat logic graph.
//
// Soundness rules (the things that make "no deadlock" true by construction):
//  * Inventory only grows. Gates that take a tool, a flag or a count are permanent knowledge.
//  * `use` requirements never count ammo. A consumable is either RENEWABLE (container owned +
//    a source reachable whose own requirement holds) or unusable. Sources that themselves need
//    the consumable can never bootstrap it, because the fixpoint starts from "nothing renewable".
//  * Small keys use worst-case logic: a locked door only opens in logic when the player owns
//    enough keys to open EVERY locked door currently in front of them, in any order.
import type { Check, Edge, ItemDef, ItemId, LocId, LogicGraph, Solution, Sphere } from './types';
import { evalReq, type Caps } from './req';

export interface SolveOpts {
  start?: LocId;
  inv?: Iterable<[ItemId, number]>;
  /** pretend these items do not exist (used for "is item X required for Y" analysis) */
  without?: Set<ItemId>;
  /** skip these checks */
  skipChecks?: Set<string>;
  /** zones that may not be entered ("is X obtainable without going in here?") */
  blocked?: Set<LocId>;
}

export function solve(g: LogicGraph, items: Record<ItemId, ItemDef>, opts: SolveOpts = {}): Solution {
  const inv = new Map<ItemId, number>(opts.inv ?? []);
  const without = opts.without ?? new Set<ItemId>();
  const caps: Caps = { inv, renewable: new Set() };
  const reach = new Set<LocId>();
  const opened = new Set<string>();
  const openedByScope = new Map<string, number>();
  const done = new Set<string>();
  const locSphere: Record<LocId, number> = {};
  const checkSphere: Record<string, number> = {};
  const spheres: Sphere[] = [];

  const out = new Map<LocId, Edge[]>();
  for (const e of g.edges) {
    (out.get(e.a) ?? out.set(e.a, []).get(e.a)!).push(e);
    if (!e.oneWay) (out.get(e.b) ?? out.set(e.b, []).get(e.b)!).push(e);
  }
  const other = (e: Edge, from: LocId) => (e.a === from ? e.b : e.a);

  const updateRenewable = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of g.sources) {
        if (caps.renewable.has(s.gives) || without.has(s.gives) || !reach.has(s.loc)) continue;
        const def = items[s.gives];
        if (def?.container && !inv.get(def.container)) continue;
        if (evalReq(s.req, caps, items)) {
          caps.renewable.add(s.gives);
          changed = true;
        }
      }
    }
  };

  // Incremental bookkeeping, so a solve costs about (edges + checks) x spheres instead of
  // rescanning the whole graph on every step. Large worlds run thousands of solves.
  const checksAt = new Map<LocId, Check[]>();
  for (const c of g.checks) (checksAt.get(c.loc) ?? checksAt.set(c.loc, []).get(c.loc)!).push(c);
  /** edges leaving the reached set that were not passable yet */
  const pend: { e: Edge; to: LocId }[] = [];
  /** unopened locked doors touching the reached set */
  const locks = new Map<string, Edge>();
  /** checks in reached zones that could not be collected yet */
  let pendChecks: Check[] = [];
  const blocked = opts.blocked;
  const enter = (u: LocId, fresh: LocId[] | null) => {
    reach.add(u);
    fresh?.push(u);
    for (const e of out.get(u) ?? []) {
      const v = other(e, u);
      if (blocked?.has(v)) continue;
      if (e.lock && !opened.has(e.id)) locks.set(e.id, e);
      if (!reach.has(v)) pend.push({ e, to: v });
    }
    const cs = checksAt.get(u);
    if (cs) for (const c of cs) pendChecks.push(c);
  };
  enter(opts.start ?? g.start, null);

  /** grow `reach` through every edge that is passable right now; returns newly reached locs */
  const expand = (): { locs: LocId[]; doors: string[] } => {
    const fresh: LocId[] = [];
    const doors: string[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      updateRenewable();
      // one sweep over the waiting edges; zones reached during the sweep append theirs to the end
      let keep = 0;
      for (let i = 0; i < pend.length; i++) {
        const p = pend[i];
        if (reach.has(p.to)) continue;
        if ((p.e.lock && !opened.has(p.e.id)) || !evalReq(p.e.req, caps, items)) { pend[keep++] = p; continue; }
        enter(p.to, fresh);
        progress = true;
      }
      pend.length = keep;
      // worst-case small keys, per dungeon scope: a door between two reached rooms still counts,
      // because the player could spend a key on it
      const frontier = new Map<string, Edge[]>();
      for (const e of locks.values()) {
        if (!evalReq(e.req, caps, items)) continue;
        (frontier.get(e.lock!) ?? frontier.set(e.lock!, []).get(e.lock!)!).push(e);
      }
      for (const [scope, fs] of frontier) {
        const left = (inv.get('key:' + scope) ?? 0) - (openedByScope.get(scope) ?? 0);
        if (left >= fs.length) {
          for (const e of fs) {
            opened.add(e.id);
            locks.delete(e.id);
            doors.push(e.id);
          }
          openedByScope.set(scope, (openedByScope.get(scope) ?? 0) + fs.length);
          progress = true;
        }
      }
    }
    return { locs: fresh, doors };
  };

  for (let k = 0; k < 100000; k++) {
    const { locs, doors } = expand();
    if (k === 0) locs.unshift(opts.start ?? g.start);
    for (const l of locs) locSphere[l] = k;
    const collected: Sphere['collected'] = [];
    const waiting: Check[] = [];
    for (const c of pendChecks) {
      if (opts.skipChecks?.has(c.id) || without.has(c.item)) continue;
      if (!evalReq(c.req, caps, items)) { waiting.push(c); continue; }
      done.add(c.id);
      checkSphere[c.id] = k;
      collected.push({ check: c.id, item: c.item });
    }
    pendChecks = waiting;
    for (const c of collected) inv.set(c.item, (inv.get(c.item) ?? 0) + 1);
    updateRenewable();
    if (!locs.length && !collected.length && !doors.length) break;
    spheres.push({
      index: k,
      newLocs: locs,
      collected,
      opened: doors,
      inv: Object.fromEntries(inv),
      renewable: [...caps.renewable],
    });
  }

  return {
    ok: (inv.get(g.goal) ?? 0) > 0,
    spheres,
    locSphere,
    checkSphere,
    unreachedChecks: g.checks.filter((c) => !done.has(c.id)).map((c) => c.id),
  };
}

/** Items whose removal makes `target` unreachable: the inventory every player must hold there. */
export function requiredFor(g: LogicGraph, items: Record<ItemId, ItemDef>, target: LocId, candidates: ItemId[]): ItemId[] {
  return candidates.filter((it) => solve(g, items, { without: new Set([it]) }).locSphere[target] === undefined);
}
