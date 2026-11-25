// Playthrough tab: the solver's spheres as a timeline, plus the inventory at the current sphere.
import { capacity } from '../core/req';
import { h, chip, selLoc, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';

export function createPlaythroughTab(): TabView {
  const el = h('div', { class: 'pa-play' });
  let openZones = new Set<number>();
  let forWorld: unknown = null;

  function inventory(ctx: TabCtx): HTMLElement {
    const { world, state } = ctx;
    const inv = new Map(Object.entries(state.inv));
    const own = (id: string) => inv.get(id) ?? 0;
    const items = Object.values(world.items);
    const tools = items.filter((i) => i.kind === 'tool' || i.kind === 'skill');
    const cons = items.filter((i) => i.kind === 'consumable');
    const ownedTools = tools.filter((t) => own(t.id) > 0).length;
    const total = (id: string) => world.graph.checks.filter((c) => c.item === id).length;
    const keys = items.filter((i) => i.kind === 'key');
    const small = keys.filter((k) => k.id.startsWith('key:')).reduce((a, k) => a + own(k.id), 0);
    const big = keys.filter((k) => !k.id.startsWith('key:')).reduce((a, k) => a + own(k.id), 0);
    const quest = items.filter((i) => (i.kind === 'quest' || i.kind === 'flag') && own(i.id) > 0);

    const toolChips = h('span', { class: 'pa-chips' }, ...tools.map((t) => chip(world, t.id, 1, { ghost: own(t.id) === 0, title: `${t.name}${own(t.id) ? '' : ' (not yet)'}` })));
    const consChips = h('span', { class: 'pa-chips' }, ...cons.map((c) => {
      const cap = capacity(world.items, inv, c.id);
      const ren = state.renewable.has(c.id);
      return chip(world, c.id, 1, {
        ghost: cap === 0, extra: cap ? `${cap}${ren ? ' ↻' : ''}` : 'none',
        title: `${c.name}: ${cap ? `carry up to ${cap}` : 'cannot carry yet'}${ren ? ', renewable (a refill is reachable)' : cap ? ', no refill reachable yet' : ''}`,
      });
    }));
    const stat = (label: string, v: string, title?: string) =>
      h('div', { class: 'pa-stat', title }, h('span', { class: 'pa-stat-v' }, v), h('span', { class: 'pa-stat-k' }, label));

    return h('section', { class: 'pa-inv', 'aria-label': 'Inventory' },
      h('div', { class: 'pa-sec-h' },
        h('h3', { class: 'pa-label' }, 'Inventory'),
        h('span', { class: 'pa-muted pa-num' }, `after sphere ${state.sphere} of ${world.solution.spheres.length - 1}`)),
      h('div', { class: 'pa-stats' },
        stat('medallions', `${own('medallion')}/${total('medallion')}`),
        stat('heart pieces', `${own('heart')}/${total('heart')}`),
        stat('small keys', String(small), 'Small keys picked up (spent keys still count here)'),
        stat('big keys', String(big)),
        stat('tools', `${ownedTools}/${tools.length}`)),
      h('div', { class: 'pa-kv' }, h('span', { class: 'pa-tf-k' }, 'tools'), toolChips),
      h('div', { class: 'pa-kv' }, h('span', { class: 'pa-tf-k' }, 'ammo'), consChips),
      quest.length ? h('div', { class: 'pa-kv' }, h('span', { class: 'pa-tf-k' }, 'quest'), h('span', { class: 'pa-chips' }, ...quest.map((q) => chip(world, q.id)))) : null,
      h('p', { class: 'pa-note' }, '↻ renewable: a refill source for it is reachable, so gates that spend it stay open.'),
    );
  }

  function ensure(ctx: TabCtx): void {
    if (forWorld !== ctx.world) { openZones = new Set(); forWorld = ctx.world; }
  }

  function render(ctx: TabCtx): void {
    const { world, state, ix, cb } = ctx;
    ensure(ctx);
    const list = h('ol', { class: 'pa-tl', 'aria-label': 'Spheres' });
    for (const sp of world.solution.spheres) {
      const k = sp.index;
      const cur = k === state.sphere;
      const main = sp.collected.filter((c) => world.items[c.item]?.kind !== 'key');
      const keys = sp.collected.filter((c) => world.items[c.item]?.kind === 'key');
      const zonesOpen = openZones.has(k);
      const li = h('li', { class: `pa-sp${cur ? ' is-current' : ''}${k > state.sphere ? ' is-future' : ''}`, 'data-sphere': String(k) },
        h('span', { class: 'pa-sp-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'pa-sp-head' },
          h('button', { class: 'pa-sp-btn', type: 'button', 'aria-current': cur ? 'step' : undefined, onclick: () => cb.setSphere(k), title: `Show the world after sphere ${k}` },
            h('span', { class: 'pa-sp-k' }, `Sphere ${k}`)),
          h('span', { class: 'pa-muted pa-num' }, `${sp.newLocs.length} new zone${sp.newLocs.length === 1 ? '' : 's'} · ${sp.collected.length} item${sp.collected.length === 1 ? '' : 's'}`)),
      );
      if (main.length) {
        const ul = h('ul', { class: 'pa-got' });
        for (const c of main) {
          const chk = ix.check.get(c.check);
          ul.append(h('li', { 'data-check': c.check },
            chip(world, c.item),
            h('button', { class: 'pa-link', type: 'button', onclick: () => chk && cb.focusLoc(chk.loc), title: chk ? ix.loc.get(chk.loc)?.name : undefined }, chk?.label ?? c.check)));
        }
        li.append(ul);
      }
      if (keys.length || sp.opened.length) {
        const line = h('div', { class: 'pa-keys' });
        if (keys.length) {
          line.append(h('span', { class: 'pa-tf-k' }, 'keys'));
          for (const c of keys) {
            const chk = ix.check.get(c.check);
            const scope = c.item.split(':')[1] ?? '';
            const where = chk ? ix.loc.get(chk.loc)?.name ?? '' : '';
            const b = h('button', { class: 'pa-keybtn', type: 'button', 'data-check': c.check, title: `${world.items[c.item]?.name ?? c.item} – ${where}`, onclick: () => chk && cb.focusLoc(chk.loc) },
              chip(world, c.item, 1, { compact: true }), h('span', { class: 'pa-keyscope' }, scope));
            line.append(b);
          }
        }
        if (sp.opened.length) {
          line.append(h('span', { class: 'pa-tf-k' }, 'doors'));
          for (const eid of sp.opened) {
            const e = ix.edge.get(eid);
            const nm = e ? `${short(ix.loc.get(e.a)?.name)} → ${short(ix.loc.get(e.b)?.name)}` : eid;
            line.append(h('button', { class: 'pa-door', type: 'button', 'data-edge': eid, title: `Unlocked: ${nm}`, onclick: () => e && cb.focusLoc(e.b) }, nm));
          }
        }
        li.append(line);
      }
      if (sp.newLocs.length) {
        const zid = `pa-z-${k}-${Math.random().toString(36).slice(2, 7)}`;
        const btn = h('button', {
          class: 'pa-more', type: 'button', 'aria-expanded': String(zonesOpen), 'aria-controls': zid,
          onclick: () => { if (openZones.has(k)) openZones.delete(k); else openZones.add(k); ctx.rerender(); },
        }, zonesOpen ? 'Hide new zones' : `Show ${sp.newLocs.length} new zone${sp.newLocs.length === 1 ? '' : 's'}`);
        li.append(btn);
        if (zonesOpen) {
          li.append(h('ul', { class: 'pa-zones', id: zid }, ...sp.newLocs.map((l) =>
            h('li', { 'data-loc': l }, h('button', { class: 'pa-link', type: 'button', onclick: () => cb.focusLoc(l) }, ix.loc.get(l)?.name || l)))));
        }
      }
      if (!sp.collected.length && !sp.newLocs.length) li.append(h('p', { class: 'pa-none' }, 'Nothing new.'));
      list.append(li);
    }
    el.replaceChildren(inventory(ctx), h('h3', { class: 'pa-label pa-sec-t' }, 'Solver spheres'),
      h('p', { class: 'pa-note' }, 'A sphere is everything the player can reach with what they own, then picks up at once. Click a sphere to scrub the map to it.'),
      list);
  }

  function reveal(sel: Selection, ctx: TabCtx): boolean {
    ensure(ctx);
    if (!sel || sel.checkId || sel.edgeId) return false;
    const loc = selLoc(ctx.world, ctx.ix, ctx.state, sel);
    const k = loc !== undefined ? ctx.world.solution.locSphere[loc] : undefined;
    if (k === undefined || openZones.has(k)) return false;
    openZones.add(k);
    return true;
  }

  function match(sel: Selection, ctx: TabCtx): Element[] {
    if (!sel) return [];
    const q = (a: string, v: string) => [...el.querySelectorAll(`[${a}="${CSS.escape(v)}"]`)];
    if (sel.checkId) return q('data-check', sel.checkId);
    if (sel.edgeId) {
      const hit = q('data-edge', sel.edgeId);
      if (hit.length) return hit;
    }
    if (sel.npcId) {
      const n = ctx.ix.npc.get(sel.npcId);
      const offers = n?.stages.flatMap((s) => s.offers) ?? [];
      const hits = offers.flatMap((c) => q('data-check', c));
      if (hits.length) return hits;
    }
    const loc = selLoc(ctx.world, ctx.ix, ctx.state, sel);
    return loc ? q('data-loc', loc) : [];
  }

  function onState(ctx: TabCtx): Element | null {
    return el.querySelector(`[data-sphere="${ctx.state.sphere}"]`);
  }

  return { el, render, match, reveal, onState };
}

function short(name?: string): string {
  if (!name) return '?';
  const i = name.indexOf(': ');
  return i >= 0 ? name.slice(i + 2) : name;
}
