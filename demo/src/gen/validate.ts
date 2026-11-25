// Lints: every promise the generator makes is re-checked on the finished graph.
import type { Edge, ItemDef, ItemId, Lint, LocId, LogicGraph, Npc, Req, Solution, HNode } from '../core/types';
import { evalReq, reqItems } from '../core/req';
import { requiredFor, solve } from '../core/solver';

type Items = Record<ItemId, ItemDef>;

/**
 * A one-way edge is safe if a player holding only what is unavoidable at its top can still get
 * back to the start (or finish the game) from its bottom. More inventory never hurts.
 */
export function oneWaySafe(g: LogicGraph, items: Items, e: Edge): boolean {
  const all = [...new Set(g.checks.map((c) => c.item))];
  const must = new Set(requiredFor(g, items, e.a, all));
  for (const it of reqItems(e.req)) must.add(it);
  const inv: [ItemId, number][] = [...must].map((it) => [it, g.checks.filter((c) => c.item === it).length]);
  const skip = new Set(g.checks.filter((c) => must.has(c.item)).map((c) => c.id));
  const s = solve(g, items, { start: e.b, inv, skipChecks: skip });
  return s.locSphere[g.start] !== undefined || s.ok;
}

const usesOf = (req: Req, out: ItemId[] = []): ItemId[] => {
  if (req.t === 'use') out.push(req.item);
  else if (req.t === 'all' || req.t === 'any') req.of.forEach((r) => usesOf(r, out));
  return out;
};

export function runLints(g: LogicGraph, items: Items, sol: Solution, npcs: Npc[], tree: HNode, dimKind: (loc: LocId) => string): Lint[] {
  const lints: Lint[] = [];
  const add = (id: string, label: string, bad: string[], good: string) =>
    lints.push({ id, label, ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join('; ') + (bad.length > 4 ? ` (+${bad.length - 4})` : '') : good });
  const locName = new Map(g.locs.map((l) => [l.id, l.name]));
  const locDim = new Map(g.locs.map((l) => [l.id, l.dim]));

  add('solvable', 'Goal reachable from the start', sol.ok ? [] : ['goal item never collected'], `${sol.spheres.length} spheres`);
  add('complete', 'Every chest, NPC reward and shop item is obtainable',
    sol.unreachedChecks.map((c) => g.checks.find((k) => k.id === c)!.label), `${g.checks.length} checks`);
  add('zones', 'Every zone is reachable', g.locs.filter((l) => sol.locSphere[l.id] === undefined).map((l) => l.name), `${g.locs.length} zones`);

  const oneWay = g.edges.filter((e) => e.oneWay);
  add('softlock', 'One-way drops never trap the player',
    oneWay.filter((e) => !oneWaySafe(g, items, e)).map((e) => `${locName.get(e.a)} → ${locName.get(e.b)}`), `${oneWay.length} one-way edges`);

  // consumables: a free-standing source nearby for everything a gate spends
  const bad: string[] = [];
  let spends = 0;
  for (const e of g.edges) {
    for (const it of usesOf(e.req)) {
      if (it === 'rupees') continue;
      spends++;
      const near = (sol.locSphere[e.a] ?? 99) <= (sol.locSphere[e.b] ?? 99) ? e.a : e.b;
      const interior = dimKind(near) === 'interior';
      const ok = g.sources.some((s) => s.gives === it && !usesOf(s.req).includes(it) && s.req.t === 'none' &&
        (interior ? locDim.get(s.loc) === locDim.get(near) && (sol.locSphere[s.loc] ?? 99) <= (sol.locSphere[near] ?? 99) : s.loc === near));
      if (!ok) bad.push(`${items[it].name} at ${locName.get(near)}`);
    }
  }
  add('replenish', 'Each ammo gate has a free refill on its near side', bad, `${spends} ammo gates`);

  // shops and other paid refills must be payable with the best wallet the world offers
  const last = sol.spheres[sol.spheres.length - 1];
  const endCaps = { inv: new Map(Object.entries(last?.inv ?? {})), renewable: new Set(last?.renewable ?? []) };
  add('sources', 'Every refill and shop shelf can actually be used',
    g.sources.filter((s) => !evalReq(s.req, endCaps, items)).map((s) => s.label), `${g.sources.length} sources`);

  // small keys: worst-case logic passed (implied by solvable); also report the raw counts
  const scopes = [...new Set(g.edges.filter((e) => e.lock).map((e) => e.lock!))];
  add('keys', 'Small keys cannot be wasted (worst-case order)',
    scopes.filter((s) => g.checks.filter((c) => c.item === 'key:' + s).length < g.edges.filter((e) => e.lock === s).length).map((s) => `too few keys in ${s}`),
    `${g.edges.filter((e) => e.lock).length} locked doors`);

  // NPC stages: when a stage activates, the player can already walk there
  const npcBad: string[] = [];
  let stages = 0;
  for (const n of npcs) {
    for (const st of n.stages) {
      stages++;
      if (st === n.stages[0]) continue; // where an NPC starts is free; only MOVES can strand the player
      const k = sol.spheres.findIndex((sp) => evalReq(st.when, { inv: new Map(Object.entries(sp.inv)), renewable: new Set(sp.renewable) }, items));
      const first = st.when.t === 'none' ? -1 : k;
      if (k < 0 && st.when.t !== 'none') npcBad.push(`${n.name}: stage never activates`);
      else if ((sol.locSphere[st.loc] ?? 99) > first + 1) npcBad.push(`${n.name} moves to ${locName.get(st.loc)} before it is reachable`);
    }
  }
  add('npc', 'NPCs never move somewhere the player cannot follow', npcBad, `${stages} NPC stages`);

  // hierarchy: the caps a parent promised a child are obtainable without entering the child
  const capBad: string[] = [];
  let nodes = 0;
  const walk = (n: HNode) => {
    if (n.locs.length && n.entryCaps.length && n.kind !== 'game') {
      nodes++;
      const inside = new Set<LocId>();
      const collect = (m: HNode) => { m.locs.forEach((l) => inside.add(l)); m.children.forEach(collect); };
      collect(n);
      if (!inside.has(g.start)) {
        const s = solve(g, items, { blocked: inside });
        const got = new Set(s.spheres.flatMap((sp) => sp.collected.map((c) => c.item)));
        const miss = n.entryCaps.filter((c) => !got.has(c));
        if (miss.length) capBad.push(`${n.name} was promised ${miss.map((m) => items[m]?.name ?? m).join(', ')}`);
      }
    }
    n.children.forEach(walk);
  };
  walk(tree);
  add('briefs', 'Items promised on entry are obtainable outside the node', capBad, `${nodes} briefs`);
  return lints;
}
