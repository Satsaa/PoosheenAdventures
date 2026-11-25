// Side panels: tab bar + views over one generated World, the current solver sphere and the settings.
// Plain DOM, no framework. Styles live in panels.css (scoped under .pa-panels).
import type { World, LocId } from '../core/types';
import type { WorldState } from '../core/view';
import type { GenSettings } from '../core/settings';
import { h, buildIndex, scrollWithin, type Index, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';
import { createGraphTab } from './graph';
import { createTreeTab } from './tree';
import { createPlaythroughTab } from './playthrough';
import { createQuestsTab } from './quests';
import { createChecksTab } from './checks';
import { createSettingsTab, type SettingsTab } from './settingsTab';
import { createItemsTab } from './itemsTab';
import { SettingsModel } from './settingsModel';

export interface PanelCallbacks {
  /** user clicked something that lives in a zone: move the map camera there (main switches dimension if needed) */
  focusLoc(loc: LocId): void;
  /** user picked a sphere in the playthrough list */
  setSphere(k: number): void;
  /** run generateWorld on many seeds and report; main provides it so the panel only renders the result */
  runBatch(n: number, onProgress: (done: number, bad: number, firstTry: number) => void): Promise<void>;
  /** the user changed settings. main normalises them, regenerates the same seed and calls setWorld(). */
  changeSettings(next: GenSettings): void;
}
export interface Panels {
  setWorld(world: World): void;
  setState(state: WorldState): void;
  /** highlight whatever relates to this map object / zone; also switch to the most relevant tab only if `reveal` */
  select(sel: { loc?: LocId; checkId?: string; edgeId?: string; npcId?: string } | null, reveal?: boolean): void;
  destroy(): void;
}

type TabId = 'graph' | 'tree' | 'play' | 'quests' | 'checks' | 'settings' | 'items';
const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'tree', label: 'Hierarchy' },
  { id: 'play', label: 'Playthrough' },
  { id: 'quests', label: 'Quests' },
  { id: 'checks', label: 'Checks' },
  { id: 'settings', label: 'Settings' },
  { id: 'items', label: 'Items' },
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
    if (saved && TAB_DEFS.some((t) => t.id === saved)) active = saved;
  } catch { /* storage unavailable */ }

  const model = new SettingsModel((next) => cb.changeSettings(next));
  const settingsTab: SettingsTab = createSettingsTab(model);
  const makers: Record<TabId, () => TabView> = {
    graph: createGraphTab, tree: createTreeTab, play: createPlaythroughTab, quests: createQuestsTab, checks: createChecksTab,
    settings: () => settingsTab, items: () => createItemsTab(model),
  };

  const wrap = h('div', { class: 'pa-panels' });
  const bar = h('div', { class: 'pa-tabs', role: 'tablist', 'aria-label': 'World panels' });
  const views = new Map<TabId, { view: TabView; btn: HTMLButtonElement; body: HTMLElement; dirty: boolean }>();

  for (const t of TAB_DEFS) {
    const view = makers[t.id]();
    const btn = h('button', {
      class: 'pa-tab', type: 'button', role: 'tab', id: `${pid}-t-${t.id}`, 'aria-controls': `${pid}-p-${t.id}`,
      onclick: () => activate(t.id, true),
    }, t.label);
    const body = h('div', { class: 'pa-body', role: 'tabpanel', id: `${pid}-p-${t.id}`, 'aria-labelledby': `${pid}-t-${t.id}`, tabindex: '-1' }, view.el);
    views.set(t.id, { view, btn, body, dirty: true });
    bar.append(btn);
  }
  const setBtn = views.get('settings')!.btn;
  const dot = h('span', { class: 'pa-tab-dot', hidden: true });
  setBtn.append(dot);
  model.onChange(() => {
    const n = model.changes();
    dot.hidden = n === 0;
    setBtn.setAttribute('aria-label', n ? `Settings (${n} changed)` : 'Settings');
  });

  bar.addEventListener('keydown', (ev) => {
    const ids = TAB_DEFS.map((t) => t.id);
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
  // "/" anywhere in the panel (outside text fields) jumps to the settings search
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      const type = (t as HTMLInputElement).type;
      if (t.tagName !== 'INPUT' || !/^(range|checkbox|radio|button)$/.test(type)) return;
    }
    ev.preventDefault();
    activate('settings', true);
    settingsTab.focusSearch();
  });

  const empty = h('div', { class: 'pa-empty' }, 'Generating world…');
  wrap.append(bar, ...[...views.values()].map((v) => v.body), empty);
  root.append(wrap);

  const ctxFor = (id: TabId): TabCtx | null => {
    if (!world || !state || !ix) return null;
    return {
      world, state, ix, cb,
      rerender: () => { const v = views.get(id)!; v.dirty = true; if (id === active) refresh(false); },
      goTab: (t: string) => { if (views.has(t as TabId)) { activate(t as TabId, true); views.get(t as TabId)!.btn.focus(); } },
    };
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
      if (v.body.scrollTop !== top) v.body.scrollTop = top;
      v.dirty = false;
    }
    highlight(active, scrollSel);
  }

  /** settings-like tabs only sync in place; keep them current even when hidden */
  function syncPersistent(): void {
    for (const [id, v] of views) {
      if (!v.view.keepScroll) continue;
      const ctx = ctxFor(id);
      if (ctx) { v.view.render(ctx); v.dirty = false; }
    }
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
    if (b.offsetLeft < bar.scrollLeft + 8 || b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth - 8) {
      bar.scrollLeft = Math.max(0, b.offsetLeft - (bar.clientWidth - b.offsetWidth) / 2);
    }
  }

  activate(active, false);

  return {
    setWorld(w: World) {
      const newSeed = !world || world.seed !== w.seed;
      world = w;
      ix = buildIndex(w);
      if (newSeed) sel = null;
      empty.hidden = true;
      for (const v of views.values()) {
        if (v.view.keepScroll) continue;
        v.dirty = true;
        if (newSeed) v.body.scrollTop = 0;
      }
      model.setWorld(w);
      if (state) {
        syncPersistent();
        if (views.get(active)!.body.hidden) activate(active, false);
        else refresh(false);
      }
    },
    setState(st: WorldState) {
      state = st;
      if (!world) return;
      empty.hidden = true;
      for (const v of views.values()) if (!v.view.keepScroll) v.dirty = true;
      syncPersistent();
      const first = views.get(active)!.body.hidden;
      if (first) activate(active, false);
      else refresh(false);
      const v = views.get(active)!;
      if (v.view.keepScroll) return;
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
      model.destroy();
      wrap.remove();
      world = null; state = null; ix = null;
    },
  };
}
