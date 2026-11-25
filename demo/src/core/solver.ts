// Sphere search over the flat logic graph.
//
// Soundness rules (the things that make "no deadlock" true by construction):
//  * Inventory only grows. Gates that take a tool, a flag or a count are permanent knowledge.
//  * `use` requirements never count ammo. A consumable is either RENEWABLE (container owned +
//    a source reachable whose own requirement holds) or unusable. Sources that themselves need
//    the consumable can never bootstrap it, because the fixpoint starts from "nothing renewable".
//  * Small keys use worst-case logic: a locked door only opens in logic when the player owns
//    enough keys to open EVERY locked door currently in front of them, in any order.
import type { Edge, ItemDef, ItemId, LocId, LogicGraph, Solution, Sphere } from './types';
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
  const reach = new Set<LocId>([opts.start ?? g.start]);
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

  /** grow `reach` through every edge that is passable right now; returns newly reached locs */
  const expand = (): { locs: LocId[]; doors: string[] } => {
    const fresh: LocId[] = [];
    const doors: string[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      updateRenewable();
      const stack = [...reach];
      while (stack.length) {
        const u = stack.pop()!;
        for (const e of out.get(u) ?? []) {
          const v = other(e, u);
          if (reach.has(v) || opts.blocked?.has(v)) continue;
          if (e.lock && !opened.has(e.id)) continue;
          if (!evalReq(e.req, caps, items)) continue;
          reach.add(v);
          fresh.push(v);
          stack.push(v);
          progress = true;
        }
      }
      // worst-case small keys, per dungeon scope
      const frontier = new Map<string, Edge[]>();
      for (const e of g.edges) {
        if (!e.lock || opened.has(e.id)) continue;
        if (opts.blocked?.has(e.a) || opts.blocked?.has(e.b)) continue;
        if (!(reach.has(e.a) || reach.has(e.b))) continue;
        if (!evalReq(e.req, caps, items)) continue;
        (frontier.get(e.lock) ?? frontier.set(e.lock, []).get(e.lock)!).push(e);
      }
      for (const [scope, fs] of frontier) {
        const left = (inv.get('key:' + scope) ?? 0) - (openedByScope.get(scope) ?? 0);
        if (left >= fs.length) {
          for (const e of fs) {
            opened.add(e.id);
            doors.push(e.id);
          }
          openedByScope.set(scope, (openedByScope.get(scope) ?? 0) + fs.length);
          progress = true;
        }
      }
    }
    return { locs: fresh, doors };
  };

  for (let k = 0; k < 200; k++) {
    const { locs, doors } = expand();
    if (k === 0) locs.unshift(opts.start ?? g.start);
    for (const l of locs) locSphere[l] = k;
    const collected: Sphere['collected'] = [];
    for (const c of g.checks) {
      if (done.has(c.id) || opts.skipChecks?.has(c.id) || without.has(c.item)) continue;
      if (!reach.has(c.loc) || !evalReq(c.req, caps, items)) continue;
      done.add(c.id);
      checkSphere[c.id] = k;
      collected.push({ check: c.id, item: c.item });
    }
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
