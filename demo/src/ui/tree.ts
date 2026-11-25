// Hierarchy tab: World > Region > Place > Room, every row showing the same three fields:
// needs (entry gate), provides (items inside), and, when expanded, what is promised on entry.
import type { HNode } from '../core/types';
import { fmtReq } from '../core/req';
import { h, chipList, focusLocOf, lockIcon, selLoc, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';

const KIND_LABEL: Record<string, string> = { game: 'Game', world: 'World', region: 'Region', place: 'Place', room: 'Room' };

export function createTreeTab(): TabView {
  const el = h('div', { class: 'pa-tree', role: 'tree', 'aria-label': 'World hierarchy' });
  let open = new Set<string>();
  let forWorld: unknown = null;

  function defaults(n: HNode): void {
    if (n.kind === 'game' || n.kind === 'world' || n.kind === 'region') open.add(n.id);
    n.children.forEach(defaults);
  }

  function row(ctx: TabCtx, n: HNode, depth: number): HTMLElement {
    const { world, state, ix, cb } = ctx;
    const sub = ix.subLocs.get(n.id) ?? [];
    const reach = sub.length ? sub.some((l) => state.reachable.has(l)) : true;
    const fresh = sub.some((l) => state.fresh.has(l));
    const isOpen = open.has(n.id);
    const hasKids = n.children.length > 0;
    const toggle = () => { if (open.has(n.id)) open.delete(n.id); else open.add(n.id); ctx.rerender(); };
    const target = focusLocOf(ix, n);
    const sub2 = n.meta.placeKind ? n.meta.placeKind : n.meta.biome && n.kind !== 'game' ? n.meta.biome : '';

    const head = h('div', { class: 'pa-trow-head' },
      h('button', {
        class: 'pa-tw', type: 'button', 'aria-expanded': String(isOpen),
        'aria-label': `${isOpen ? 'Collapse' : 'Expand'} ${n.name}`, onclick: toggle,
      }, h('span', { 'aria-hidden': 'true' }, isOpen ? '▾' : '▸')),
      h('span', { class: `pa-kind is-${n.kind}` }, KIND_LABEL[n.kind] ?? n.kind),
      h('button', {
        class: 'pa-tname', type: 'button', disabled: !target,
        title: target ? `Show ${n.name} on the map` : undefined,
        onclick: () => { if (target) cb.focusLoc(target); },
      }, n.name || '(unnamed)', sub2 ? h('span', { class: 'pa-tsub' }, sub2) : null),
      fresh && n.kind !== 'game' && n.kind !== 'world' ? h('span', { class: 'pa-tag is-fresh', title: 'Became reachable in this sphere' }, 'new') : null,
    );
    const fields = h('div', { class: 'pa-tfields' },
      h('div', { class: 'pa-tf' }, h('span', { class: 'pa-tf-k' }, 'needs'),
        n.needs.t === 'none'
          ? h('span', { class: 'pa-none' }, 'free')
          : h('span', { class: 'pa-need' }, lockIcon(), fmtReq(n.needs, world.items))),
      h('div', { class: 'pa-tf' }, h('span', { class: 'pa-tf-k' }, 'gives'), chipList(world, n.provides, { empty: 'nothing' })),
      isOpen ? h('div', { class: 'pa-tf' }, h('span', { class: 'pa-tf-k' }, 'on entry'), chipList(world, n.entryCaps, { empty: 'nothing promised' })) : null,
    );
    const r = h('div', {
      class: `pa-trow is-${n.kind}${reach ? '' : ' is-dim'}`, 'data-node': n.id,
      style: { '--depth': String(depth) },
    }, head, fields);
    const wrap = h('div', { class: 'pa-tnode', role: 'treeitem', 'aria-expanded': hasKids ? String(isOpen) : undefined }, r);
    if (isOpen && hasKids) {
      const kids = h('div', { class: 'pa-tkids', role: 'group' });
      for (const c of n.children) kids.append(row(ctx, c, depth + 1));
      wrap.append(kids);
    }
    return wrap;
  }

  function ensure(ctx: TabCtx): void {
    if (forWorld !== ctx.world) { open = new Set(); defaults(ctx.world.tree); forWorld = ctx.world; }
  }

  function render(ctx: TabCtx): void {
    ensure(ctx);
    el.replaceChildren(
      h('p', { class: 'pa-note' }, 'Every level answers the same three questions: what it needs to get in, what it gives, and what the player is guaranteed to own on entry. Expand a row to see the promise.'),
      row(ctx, ctx.world.tree, 0));
  }

  function nodeFor(sel: Selection, ctx: TabCtx): HNode | undefined {
    const loc = selLoc(ctx.world, ctx.ix, ctx.state, sel);
    return loc ? ctx.ix.locNode.get(loc) : undefined;
  }

  function reveal(sel: Selection, ctx: TabCtx): boolean {
    ensure(ctx);
    const n = nodeFor(sel, ctx);
    let changed = false;
    for (let p = n ? ctx.ix.parent.get(n.id) : undefined; p; p = ctx.ix.parent.get(p.id)) {
      if (!open.has(p.id)) { open.add(p.id); changed = true; }
    }
    return changed;
  }

  function match(sel: Selection, ctx: TabCtx): Element[] {
    const n = nodeFor(sel, ctx);
    return n ? [...el.querySelectorAll(`[data-node="${CSS.escape(n.id)}"]`)] : [];
  }

  return { el, render, match, reveal };
}
