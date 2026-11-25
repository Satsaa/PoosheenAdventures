// Generic forward lock-and-key builder. The SAME routine builds the region graph of a world,
// and the room graph of a dungeon; only nodes, candidate adjacencies and payloads differ.
//
// Solvable by construction: nodes are attached one at a time, and an edge may only be locked
// with something the player already owns at that moment. Payloads (what a node must contain)
// are consumed in the order the parent decided, so the progression order is fixed up front.
import type { GateKind, ItemId, Req } from '../core/types';
import type { Rng } from '../core/rng';
import { gateFor } from '../core/content';
import { NONE } from '../core/req';

export interface Payload {
  id: string;
  kind: 'item' | 'dungeon' | 'portal' | 'sanctum' | 'favor' | 'boss';
  /** everything the player owns after finishing this payload */
  provides: ItemId[];
  /** extra requirement on the payload itself (seal, trade item, ...) */
  needs?: Req;
  /** nothing may be attached behind the node holding this payload */
  terminal?: boolean;
  /** filled by the builder: what the player is guaranteed to own when reaching the payload */
  caps?: ItemId[];
  data?: Record<string, unknown>;
}

export interface LockEdge {
  a: string;
  b: string;
  req: Req;
  gate: GateKind;
  lock?: string;
  spends?: ItemId;
  label: string;
}

export interface LockGraphInput {
  rng: Rng;
  nodes: string[];
  entry: string;
  candidates: [string, string][];
  /** items owned on entry; usable as gates */
  entryCaps: ItemId[];
  payloads: Payload[];
  entryPayloads: number;
  /** chance that a filler edge has no gate at all */
  freeChance: number;
  /** dungeon scope: `key:<scope>` items lock doors */
  lockScope?: string;
  /** theme affinity: items whose gate fits the border between two nodes */
  likes?: (a: string, b: string) => ItemId[];
  /** higher = longer chains, lower = bushier */
  depthBias?: number;
}

export interface LockGraphOutput {
  edges: LockEdge[];
  order: string[];
  tier: Map<string, number>;
  assign: Map<string, Payload[]>;
  capsAt: Map<string, ItemId[]>;
  /** number of locked doors between the entry and each node */
  lockDepth: Map<string, number>;
  unused: [string, string][];
}

export function buildLockGraph(inp: LockGraphInput): LockGraphOutput {
  const { rng } = inp;
  const have: ItemId[] = [...inp.entryCaps];
  const pending: ItemId[] = []; // freshly obtained items that have not locked anything yet
  const queue = inp.payloads.slice();
  const assign = new Map<string, Payload[]>(inp.nodes.map((n) => [n, []]));
  const tier = new Map<string, number>([[inp.entry, 0]]);
  const lockDepth = new Map<string, number>([[inp.entry, 0]]);
  const capsAt = new Map<string, ItemId[]>([[inp.entry, have.slice()]]);
  const sealed = new Set<string>();
  const placed = new Set<string>([inp.entry]);
  const order = [inp.entry];
  const edges: LockEdge[] = [];
  const used = new Set<string>();
  const keyItem = inp.lockScope ? 'key:' + inp.lockScope : '';
  let maxLock = 0;

  const give = (node: string, n: number) => {
    for (let i = 0; i < n && queue.length; i++) {
      const p = queue.shift()!;
      p.caps = have.slice();
      assign.get(node)!.push(p);
      if (p.terminal) sealed.add(node);
      for (const it of p.provides) {
        have.push(it);
        if (it === keyItem || gateFor(it)) pending.push(it);
      }
    }
  };
  give(inp.entry, inp.entryPayloads);

  const key = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
  const options = () => {
    const out: { p: string; c: string }[] = [];
    for (const [a, b] of inp.candidates) {
      if (placed.has(a) && !placed.has(b) && !sealed.has(a)) out.push({ p: a, c: b });
      else if (placed.has(b) && !placed.has(a) && !sealed.has(b)) out.push({ p: b, c: a });
    }
    return out;
  };

  while (placed.size < inp.nodes.length) {
    let opts = options();
    if (!opts.length) {
      // only sealed parents left: unseal rather than leave nodes detached
      sealed.clear();
      opts = options();
      if (!opts.length) break;
    }
    const remaining = inp.nodes.length - placed.size;
    const progress = queue.length > 0 && (queue.length >= remaining || rng.chance(queue.length / remaining + 0.25));

    let gateItem: ItemId | null = null;
    if (progress && pending.length) {
      gateItem = pending.shift()!;
      if (gateItem === keyItem) {
        // key doors must chain: a new lock only goes behind every earlier lock
        const deep = opts.filter((o) => lockDepth.get(o.p) === maxLock);
        if (deep.length) opts = deep;
        else gateItem = null;
      }
    }
    const bias = inp.depthBias ?? 1;
    const opt = rng.weighted(opts, (o) => {
      const t = tier.get(o.p)!;
      let w = progress ? 1 + t * bias : 1.5;
      if (gateItem && inp.likes?.(o.p, o.c).includes(gateItem)) w *= 3;
      return w;
    });

    let edge: LockEdge;
    if (gateItem === keyItem && keyItem) {
      edge = { a: opt.p, b: opt.c, req: NONE, gate: 'locked', lock: inp.lockScope, label: 'Locked door' };
    } else {
      if (!gateItem && !rng.chance(inp.freeChance)) {
        const pool = have.filter((it) => it !== keyItem && gateFor(it));
        if (pool.length) {
          const likes = inp.likes?.(opt.p, opt.c) ?? [];
          gateItem = rng.weighted(pool, (it) => (1 + pool.indexOf(it)) * (likes.includes(it) ? 3 : 1));
        }
      }
      const g = gateItem ? gateFor(gateItem) : null;
      edge = g
        ? { a: opt.p, b: opt.c, req: g.req, gate: g.gate, spends: g.spends, label: g.label }
        : { a: opt.p, b: opt.c, req: NONE, gate: 'open', label: 'Open path' };
    }
    edges.push(edge);
    used.add(key(opt.p, opt.c));
    placed.add(opt.c);
    order.push(opt.c);
    tier.set(opt.c, tier.get(opt.p)! + 1);
    const ld = lockDepth.get(opt.p)! + (edge.lock ? 1 : 0);
    lockDepth.set(opt.c, ld);
    maxLock = Math.max(maxLock, ld);
    capsAt.set(opt.c, have.slice());
    if (progress) give(opt.c, Math.max(1, Math.ceil(queue.length / remaining)));
  }
  if (queue.length) give(order[order.length - 1], queue.length);

  const unused = inp.candidates.filter(([a, b]) => placed.has(a) && placed.has(b) && !used.has(key(a, b)));
  return { edges, order, tier, assign, capsAt, lockDepth, unused };
}
