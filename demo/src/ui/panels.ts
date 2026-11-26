// Side panels: tab bar + views over one generated World, the current solver sphere and the settings.
// Plain DOM, no framework. Styles live in panels.css (scoped under .pa-panels).
import type { World, LocId } from '../core/types';
import type { WorldState } from '../core/view';
import type { GenSettings } from '../core/settings';
import type { GraphicsSettings } from '../render/graphics';
import { h, buildIndex, scrollWithin, phaseOf, type Index, type Selection } from './shared';
import type { TabCtx, TabView } from './tab';
import { createGraphTab } from './graph';
import { createTreeTab } from './tree';
import { createPlaythroughTab } from './playthrough';
import { createQuestsTab } from './quests';
import { createChecksTab } from './checks';
import { createSettingsTab } from './settingsTab';
import { createGraphicsTab } from './graphicsTab';
import type { ConfigTab } from './configTab';
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
  /** graphics changed. Applied live to the map; does NOT regenerate the world. */
  changeGraphics(next: GraphicsSettings): void;
}
export interface Panels {
  setWorld(world: World): void;
  setState(state: WorldState): void;
  /** highlight whatever relates to this map object / zone; also switch to the most relevant tab only if `reveal` */
  select(sel: { loc?: LocId; checkId?: string; edgeId?: string; npcId?: string } | null, reveal?: boolean): void;
  /** the effective graphics settings (called once at start and after every change) */
  setGraphics(g: GraphicsSettings): void;
  destroy(): void;
}

type TabId = 'graph' | 'tree' | 'play' | 'quests' | 'checks' | 'settings' | 'graphics' | 'items';
const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'tree', label: 'Hierarchy' },
  { id: 'play', label: 'Playthrough' },
  { id: 'quests', label: 'Quests' },
  { id: 'checks', label: 'Checks' },
  { id: 'settings', label: 'Settings' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'items', label: 'Items' },
];
const STORE_KEY = 'pa-panels-tab';
let instance = 0;

/** Fixed strips must not scroll anything: no touch panning starting there, no wheel scrolling through. */
function guardHead(el: HTMLElement): void {
  el.addEventListener('wheel', (ev) => {
    const t = ev.target as HTMLElement | null;
    // a textarea inside the header may scroll itself
    if (t && t.tagName === 'TEXTAREA' && t.scrollHeight > t.clientHeight) return;
    ev.preventDefault();
  }, { passive: false });
  // CSS touch-action should be enough, but an app that wraps the page in its own scroller can
  // still take the gesture unless the page consumes it. Cancelling the move does that everywhere;
  // taps are unaffected because they never move.
  el.addEventListener('touchmove', (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t && t.tagName === 'TEXTAREA' && t.scrollHeight > t.clientHeight) return;
    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();
  }, { passive: false });
}

/**
 * Whatever delivers a scroll to the list while a finger that went down on the header is still
 * down (the browser, or an app wrapped around the page), it is undone: the list is pinned to
 * where it was when the touch began, until shortly after the finger lifts.
 */
function pinListWhileOnHead(head: HTMLElement, body: HTMLElement): void {
  let pinned: number | null = null;
  let release = 0;
  const pin = () => { clearTimeout(release); pinned = body.scrollTop; };
  const unpin = () => { clearTimeout(release); release = window.setTimeout(() => { pinned = null; }, 350); };
  for (const type of ['touchstart', 'pointerdown'] as const) head.addEventListener(type, pin, { passive: true, capture: true });
  for (const type of ['touchend', 'touchcancel', 'pointerup', 'pointercancel'] as const) {
    head.addEventListener(type, unpin, { passive: true, capture: true });
    window.addEventListener(type, () => { if (pinned !== null) unpin(); }, { passive: true, capture: true });
  }
  body.addEventListener('scroll', () => { if (pinned !== null && body.scrollTop !== pinned) body.scrollTop = pinned; }, { passive: true });
}

export function createPanels(root: HTMLElement, cb: PanelCallbacks): Panels {
  const pid = `pa${instance++}`;
  let world: World | null = null;
  let state: WorldState | null = null;
  let ix: Index | null = null;
  let sel: Selection = null;
  let stateWorld: World | null = null;
  let active: TabId = 'graph';
  try {
    const saved = localStorage.getItem(STORE_KEY) as TabId | null;
    if (saved && TAB_DEFS.some((t) => t.id === saved)) active = saved;
  } catch { /* storage unavailable */ }

  const model = new SettingsModel((next) => cb.changeSettings(next), (next) => cb.changeGraphics(next));
  const jump = (to: TabId) => (q: string) => { activate(to, true); (to === 'graphics' ? graphicsTab : settingsTab).focusSearch(q); };
  const settingsTab: ConfigTab = createSettingsTab(model, jump('graphics'));
  const graphicsTab: ConfigTab = createGraphicsTab(model, jump('settings'));
  const makers: Record<TabId, () => TabView> = {
    graph: createGraphTab, tree: createTreeTab, play: createPlaythroughTab, quests: createQuestsTab, checks: createChecksTab,
    settings: () => settingsTab, graphics: () => graphicsTab, items: () => createItemsTab(model),
  };

  const wrap = h('div', { class: 'pa-panels' });
  const bar = h('div', { class: 'pa-tabs', role: 'tablist', 'aria-label': 'World panels' });
  const views = new Map<TabId, { view: TabView; btn: HTMLButtonElement; pane: HTMLElement; body: HTMLElement; dirty: boolean }>();

  for (const t of TAB_DEFS) {
    const view = makers[t.id]();
    const btn = h('button', {
      class: 'pa-tab', type: 'button', role: 'tab', id: `${pid}-t-${t.id}`, 'aria-controls': `${pid}-p-${t.id}`,
      onclick: () => activate(t.id, true),
    }, t.label);
    const body = h('div', { class: 'pa-body', tabindex: '-1' }, view.el);
    // a tab's header (if any) sits outside the scrolling body, so dragging it never scrolls the list
    if (view.head) guardHead(view.head);
    const headBox = view.head ? h('div', { class: 'pa-pane-head' }, view.head) : null;
    if (headBox) pinListWhileOnHead(headBox, body);
    const pane = h('div', { class: 'pa-pane', role: 'tabpanel', id: `${pid}-p-${t.id}`, 'aria-labelledby': `${pid}-t-${t.id}` }, headBox, body);
    views.set(t.id, { view, btn, pane, body, dirty: true });
    bar.append(btn);
  }
  const badge = (id: TabId, label: string, count: () => number) => {
    const btn = views.get(id)!.btn;
    const dot = h('span', { class: 'pa-tab-dot', hidden: true });
    btn.append(dot);
    model.onChange(() => {
      const n = count();
      dot.hidden = n === 0;
      btn.setAttribute('aria-label', n ? `${label} (${n} changed)` : label);
    });
  };
  badge('settings', 'Settings', () => model.genChanges());
  badge('graphics', 'Graphics', () => model.graphicsChanges());

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
    const to: TabId = active === 'graphics' ? 'graphics' : 'settings';
    activate(to, true);
    (to === 'graphics' ? graphicsTab : settingsTab).focusSearch();
  });

  const empty = h('div', { class: 'pa-empty' }, 'Generating world…');
  // more-tabs hint for narrow panels: a fade + chevron at the edge that still has tabs behind it
  const moreR = h('button', { class: 'pa-tabs-more is-right', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: 'More tabs', onclick: () => bar.scrollBy({ left: bar.clientWidth * 0.6, behavior: 'smooth' }) }, '›');
  const moreL = h('button', { class: 'pa-tabs-more is-left', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: 'More tabs', onclick: () => bar.scrollBy({ left: -bar.clientWidth * 0.6, behavior: 'smooth' }) }, '‹');
  const barWrap = h('div', { class: 'pa-tabs-wrap' }, bar, moreL, moreR);
  const hint = () => {
    moreR.hidden = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2;
    moreL.hidden = bar.scrollLeft <= 2;
  };
  bar.addEventListener('scroll', hint, { passive: true });
  let ro: ResizeObserver | null = null;
  try { ro = new ResizeObserver(hint); ro.observe(bar); } catch { /* fine */ }
  wrap.append(barWrap, ...[...views.values()].map((v) => v.pane), empty);
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
      v.pane.hidden = !on || !world;
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
    hint();
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
        if (views.get(active)!.pane.hidden) activate(active, false);
        else refresh(false);
      }
    },
    setState(st: WorldState) {
      const prev = state;
      state = st;
      if (!world) return;
      // time scrubbing: same world and sphere, only hours/phase moved. Never rebuild for that.
      if (prev && stateWorld === world && prev.sphere === st.sphere && !views.get(active)!.pane.hidden) {
        const phaseChanged = phaseOf(prev) !== phaseOf(st);
        for (const [id, v] of views) {
          if (v.view.keepScroll) continue;
          if (id === active) { const c = ctxFor(id); if (c && !v.dirty) v.view.onTime?.(c); }
          else if (phaseChanged) v.dirty = true; // re-render lazily when shown
        }
        return;
      }
      stateWorld = world;
      empty.hidden = true;
      for (const v of views.values()) if (!v.view.keepScroll) v.dirty = true;
      syncPersistent();
      const first = views.get(active)!.pane.hidden;
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
    setGraphics(g: GraphicsSettings) {
      model.setGraphics(g);
    },
    destroy() {
      for (const v of views.values()) v.view.destroy?.();
      model.destroy();
      ro?.disconnect();
      wrap.remove();
      world = null; state = null; ix = null;
    },
  };
}
