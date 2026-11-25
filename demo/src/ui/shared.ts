// Shared helpers for the side panels: tiny DOM builders, item chips, and an index over the World.
import type { HNode, ItemId, Loc, LocId, World, Check, Edge, Npc } from '../core/types';
import type { WorldState } from '../core/view';
import { evalReq, type Caps } from '../core/req';

// ---------------------------------------------------------------- DOM
type Kid = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> | null | undefined;

function applyAttrs(el: Element, attrs: Attrs): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [p, sv] of Object.entries(v as Record<string, string>)) (el as HTMLElement).style.setProperty(p, sv);
    } else if (k === 'class') {
      el.setAttribute('class', String(v));
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function append(el: Element, kids: Kid[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    el.append(typeof k === 'number' ? String(k) : k);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, kids);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...kids: Kid[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  applyAttrs(el, attrs);
  append(el, kids);
  return el;
}

/** Small padlock drawn with currentColor (avoids depending on an emoji font). */
export function lockIcon(): SVGSVGElement {
  return s('svg', { class: 'pa-ico', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
    s('path', { d: 'M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }),
    s('rect', { x: '2', y: '5.5', width: '8', height: '5.5', rx: '1.2', fill: 'currentColor' }));
}

/** Scroll `el` into view inside `box` only (never scrolls the page). */
export function scrollWithin(box: HTMLElement, el: Element, center = false): void {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - b.top + box.scrollTop;
  const pad = 12;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let target: number | null = null;
  if (center) target = top - (box.clientHeight - Math.min(r.height, box.clientHeight)) / 2;
  else if (r.top < b.top + pad) target = top - pad;
  else if (r.bottom > b.bottom - pad) target = top + r.height - box.clientHeight + pad;
  if (target === null) return;
  box.scrollTo({ top: Math.max(0, target), behavior: reduce ? 'auto' : 'smooth' });
}

// ---------------------------------------------------------------- chips
export function itemName(world: World, id: ItemId): string {
  return world.items[id]?.name ?? id;
}

/** One pill: coloured glyph + name (+ ×n). `compact` drops the name (kept as tooltip). */
export function chip(world: World, id: ItemId, count = 1, opts: { compact?: boolean; ghost?: boolean; extra?: string; title?: string } = {}): HTMLElement {
  const def = world.items[id];
  const name = def?.name ?? id;
  const el = h('span', {
    class: 'pa-chip' + (opts.compact ? ' is-compact' : '') + (opts.ghost ? ' is-ghost' : ''),
    style: { '--chip-c': def?.color ?? 'currentColor' },
    title: opts.title ?? (count > 1 ? `${name} ×${count}` : name),
  },
  h('span', { class: 'pa-chip-g', 'aria-hidden': 'true' }, def?.icon ?? '?'),
  opts.compact ? h('span', { class: 'pa-sr' }, name) : h('span', { class: 'pa-chip-n' }, name),
  count > 1 ? h('span', { class: 'pa-chip-x' }, `×${count}`) : null,
  opts.extra ? h('span', { class: 'pa-chip-x' }, opts.extra) : null);
  return el;
}

/** Collapse duplicates ("♥ ×3") while keeping first-seen order. */
export function countItems(ids: ItemId[]): [ItemId, number][] {
  const m = new Map<ItemId, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m];
}

export function chipList(world: World, ids: ItemId[], opts: { compact?: boolean; empty?: string } = {}): HTMLElement {
  const box = h('span', { class: 'pa-chips' });
  const counted = countItems(ids);
  if (!counted.length && opts.empty) box.append(h('span', { class: 'pa-none' }, opts.empty));
  for (const [id, n] of counted) box.append(chip(world, id, n, { compact: opts.compact }));
  return box;
}

// ---------------------------------------------------------------- index
export interface Index {
  node: Map<string, HNode>;
  parent: Map<string, HNode>;
  loc: Map<LocId, Loc>;
  check: Map<string, Check>;
  edge: Map<string, Edge>;
  npc: Map<string, Npc>;
  /** loc -> hierarchy node that owns it */
  locNode: Map<LocId, HNode>;
  /** loc -> region node above it (or null for interiors without one) */
  locRegion: Map<LocId, HNode>;
  /** every loc inside a node's subtree */
  subLocs: Map<string, LocId[]>;
}

export function buildIndex(world: World): Index {
  const node = new Map<string, HNode>();
  const parent = new Map<string, HNode>();
  const subLocs = new Map<string, LocId[]>();
  const walk = (n: HNode, p?: HNode): LocId[] => {
    node.set(n.id, n);
    if (p) parent.set(n.id, p);
    const all = [...n.locs];
    for (const c of n.children) all.push(...walk(c, n));
    subLocs.set(n.id, all);
    return all;
  };
  walk(world.tree);
  const loc = new Map(world.graph.locs.map((l) => [l.id, l]));
  const locNode = new Map<LocId, HNode>();
  const locRegion = new Map<LocId, HNode>();
  for (const [id, n] of node) {
    for (const l of n.locs) locNode.set(l, n);
    void id;
  }
  for (const l of world.graph.locs) {
    let n: HNode | undefined = locNode.get(l.id) ?? node.get(l.hnode);
    if (n && !locNode.has(l.id)) locNode.set(l.id, n);
    while (n && n.kind !== 'region') n = parent.get(n.id);
    if (n) locRegion.set(l.id, n);
  }
  return {
    node, parent, loc, locNode, locRegion, subLocs,
    check: new Map(world.graph.checks.map((c) => [c.id, c])),
    edge: new Map(world.graph.edges.map((e) => [e.id, e])),
    npc: new Map(world.npcs.map((n) => [n.id, n])),
  };
}

/** A loc to focus for a node: its own, else the first descendant's, else the nearest ancestor's. */
export function focusLocOf(ix: Index, n: HNode): LocId | undefined {
  const own = ix.subLocs.get(n.id)?.[0];
  if (own) return own;
  for (let p = ix.parent.get(n.id); p; p = ix.parent.get(p.id)) if (p.locs[0]) return p.locs[0];
  return undefined;
}

export function capsOf(state: WorldState): Caps {
  return { inv: new Map(Object.entries(state.inv)), renewable: state.renewable };
}

export function reqOk(world: World, state: WorldState, req: Parameters<typeof evalReq>[0]): boolean {
  return evalReq(req, capsOf(state), world.items);
}

export type Selection = { loc?: LocId; checkId?: string; edgeId?: string; npcId?: string } | null;

/** The single loc a selection is "about", used by tabs that only think in zones. */
export function selLoc(world: World, ix: Index, state: WorldState | null, sel: Selection): LocId | undefined {
  if (!sel) return undefined;
  if (sel.loc) return sel.loc;
  if (sel.checkId) return ix.check.get(sel.checkId)?.loc;
  if (sel.edgeId) return ix.edge.get(sel.edgeId)?.b;
  if (sel.npcId) {
    const n = ix.npc.get(sel.npcId);
    if (!n) return undefined;
    const k = state?.npcStage[n.id] ?? 0;
    return n.stages[k]?.loc ?? n.stages[0]?.loc;
  }
  return undefined;
}
