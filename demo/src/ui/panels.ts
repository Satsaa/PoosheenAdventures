// Side panels: tab bar + five views over one generated World and the current solver sphere.
// Plain DOM, no framework. Styles live in panels.css (scoped under .pa-panels).
import type { World, LocId } from '../core/types';
import type { WorldState } from '../core/view';
import { h, buildIndex, scrollWithin, type Index, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';
import { createGraphTab } from './graph';
import { createTreeTab } from './tree';
import { createPlaythroughTab } from './playthrough';
import { createQuestsTab } from './quests';
import { createChecksTab } from './checks';

export interface PanelCallbacks {
  /** user clicked something that lives in a zone: move the map camera there (main switches dimension if needed) */
  focusLoc(loc: LocId): void;
  /** user picked a sphere in the playthrough list */
  setSphere(k: number): void;
  /** run generateWorld on many seeds and report; main provides it so the panel only renders the result */
  runBatch(n: number, onProgress: (done: number, bad: number, firstTry: number) => void): Promise<void>;
}
export interface Panels {
  setWorld(world: World): void;
  setState(state: WorldState): void;
  /** highlight whatever relates to this map object / zone; also switch to the most relevant tab only if `reveal` */
  select(sel: { loc?: LocId; checkId?: string; edgeId?: string; npcId?: string } | null, reveal?: boolean): void;
  destroy(): void;
}

type TabId = 'graph' | 'tree' | 'play' | 'quests' | 'checks';
const TABS: { id: TabId; label: string; make: () => TabView }[] = [
  { id: 'graph', label: 'Graph', make: createGraphTab },
  { id: 'tree', label: 'Hierarchy', make: createTreeTab },
  { id: 'play', label: 'Playthrough', make: createPlaythroughTab },
  { id: 'quests', label: 'Quests', make: createQuestsTab },
  { id: 'checks', label: 'Checks', make: createChecksTab },
];
const STORE_KEY = 'pa-panels-tab';
let instance = 0;

export function createPanels(root: HTMLElement, cb: PanelCallbacks): Panels {
  const pid = `pa${instance++}`;
  let world: World | null = null;
  let state: WorldState | null = null;
  let ix: Index | null = null;
  let sel: Selection = null;
  let active: TabId = 'graph';
  try {
    const saved = localStorage.getItem(STORE_KEY) as TabId | null;
    if (saved && TABS.some((t) => t.id === saved)) active = saved;
  } catch { /* storage unavailable */ }

  const wrap = h('div', { class: 'pa-panels' });
  const bar = h('div', { class: 'pa-tabs', role: 'tablist', 'aria-label': 'World panels' });
  const views = new Map<TabId, { view: TabView; btn: HTMLButtonElement; body: HTMLElement; dirty: boolean }>();

  for (const t of TABS) {
    const view = t.make();
    const btn = h('button', {
      class: 'pa-tab', type: 'button', role: 'tab', id: `${pid}-t-${t.id}`, 'aria-controls': `${pid}-p-${t.id}`,
      onclick: () => activate(t.id, true),
    }, t.label);
    const body = h('div', { class: 'pa-body', role: 'tabpanel', id: `${pid}-p-${t.id}`, 'aria-labelledby': `${pid}-t-${t.id}`, tabindex: '-1' }, view.el);
    views.set(t.id, { view, btn, body, dirty: true });
    bar.append(btn);
  }
  bar.addEventListener('keydown', (ev) => {
    const ids = TABS.map((t) => t.id);
    let i = ids.indexOf(active);
    if (ev.key === 'ArrowRight') i = (i + 1) % ids.length;
    else if (ev.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = ids.length - 1;
    else return;
    ev.preventDefault();
    activate(ids[i], true);
    views.get(ids[i])!.btn.focus();
  });
  const empty = h('div', { class: 'pa-empty' }, 'Generating world…');
  wrap.append(bar, ...[...views.values()].map((v) => v.body), empty);
  root.append(wrap);

  const ctxFor = (id: TabId): TabCtx | null => {
    if (!world || !state || !ix) return null;
    return { world, state, ix, cb, rerender: () => { const v = views.get(id)!; v.dirty = true; if (id === active) refresh(false); } };
  };

  function highlight(id: TabId, scroll: boolean): void {
    const v = views.get(id)!;
    const ctx = ctxFor(id);
    v.body.querySelectorAll('.is-sel').forEach((e) => e.classList.remove('is-sel'));
    if (!ctx || !sel) return;
    const hits = v.view.match(sel, ctx);
    hits.forEach((e) => e.classList.add('is-sel'));
    if (scroll && hits[0]) scrollWithin(v.body, hits[0]);
  }

  /** render the active tab if needed and re-apply the selection */
  function refresh(scrollSel: boolean): void {
    const v = views.get(active)!;
    const ctx = ctxFor(active);
    if (!ctx) return;
    if (v.dirty) {
      const top = v.body.scrollTop;
      v.view.render(ctx);
      v.body.scrollTop = top;
      v.dirty = false;
    }
    highlight(active, scrollSel);
  }

  function activate(id: TabId, user: boolean): void {
    const prev = active;
    active = id;
    for (const [tid, v] of views) {
      const on = tid === id;
      v.btn.setAttribute('aria-selected', String(on));
      v.btn.tabIndex = on ? 0 : -1;
      v.body.hidden = !on || !world;
    }
    if (user) { try { localStorage.setItem(STORE_KEY, id); } catch { /* ignore */ } }
    const v = views.get(id)!;
    const c0 = ctxFor(id);
    if (sel && c0 && v.view.reveal?.(sel, c0)) v.dirty = true;
    const wasDirty = v.dirty;
    refresh(true);
    if (wasDirty && prev !== id && !sel) {
      const ctx = ctxFor(id);
      const target = ctx && v.view.onState?.(ctx);
      if (target) scrollWithin(v.body, target, true);
    }
    // keep the active tab button visible in a horizontally scrolling bar
    const b = v.btn;
    if (b.offsetLeft < bar.scrollLeft || b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth) {
      bar.scrollLeft = Math.max(0, b.offsetLeft - 16);
    }
  }

  activate(active, false);

  return {
    setWorld(w: World) {
      world = w;
      ix = buildIndex(w);
      sel = null;
      empty.hidden = true;
      for (const v of views.values()) { v.dirty = true; v.body.scrollTop = 0; }
      if (state) activate(active, false);
    },
    setState(st: WorldState) {
      state = st;
      if (!world) return;
      empty.hidden = true;
      for (const v of views.values()) v.dirty = true;
      const first = views.get(active)!.body.hidden;
      if (first) activate(active, false);
      else refresh(false);
      const v = views.get(active)!;
      const ctx = ctxFor(active);
      const target = ctx && v.view.onState?.(ctx);
      if (target) scrollWithin(v.body, target, true);
    },
    select(s, reveal = false) {
      sel = s && (s.loc || s.checkId || s.edgeId || s.npcId) ? { ...s } : null;
      if (sel && reveal) {
        const best: TabId = sel.npcId ? 'quests' : sel.checkId ? 'play' : 'graph';
        if (best !== active) activate(best, false);
      }
      const v = views.get(active)!;
      const ctx = ctxFor(active);
      if (sel && ctx && v.view.reveal?.(sel, ctx)) v.dirty = true;
      refresh(true);
    },
    destroy() {
      for (const v of views.values()) v.view.destroy?.();
      wrap.remove();
      world = null; state = null; ix = null;
    },
  };
}
