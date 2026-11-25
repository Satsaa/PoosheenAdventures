// Settings tab: searchable generation settings. Built once, then synced in place on every world.
import { SETTING_DEFS, ITEM_SETTING_DEFS, defaultSettings, type GenSettings } from '../core/settings';
import { h } from './shared';
import { settingRow, itemRow, graphicsRow, setLabelSource, type Row } from './settingRows';
import { GRAPHICS_DEFS, defaultGraphics, type GraphicsSettings } from '../render/graphics';
import type { SettingsModel } from './settingsModel';
import type { TabCtx, TabView } from './tab';

export interface SettingsTab extends TabView { focusSearch(): void }

export function createSettingsTab(model: SettingsModel): SettingsTab {
  setLabelSource(SETTING_DEFS);
  const el = h('div', { class: 'pa-settings' });
  let built = false;
  let ctx: TabCtx | null = null;
  const rows: Row[] = [];
  type Kind = 'gen' | 'items' | 'gfx';
  const groups: { name: string; sec: HTMLElement; head: HTMLButtonElement; body: HTMLElement; badge: HTMLElement; rows: Row[]; kind: Kind }[] = [];
  const divisions: { kind: 'gen' | 'gfx'; el: HTMLElement; reset: HTMLButtonElement }[] = [];
  const collapsed = new Set<string>();
  let query = '';
  let undoTimer = 0;
  let undoPrev: { gen: GenSettings; gfx: GraphicsSettings } | null = null;
  let ro: ResizeObserver | null = null;

  // header strip
  const count = h('span', { class: 'pa-changed pa-num', 'aria-live': 'polite' });
  const resetAll = h('button', { class: 'pa-btn2', type: 'button' }, 'Reset all');
  const undoBox = h('span', { class: 'pa-undo', 'aria-live': 'polite' });
  const copyBtn = h('button', { class: 'pa-btn2', type: 'button', title: 'Copy the changed values as JSON' }, 'Copy settings');
  const importBtn = h('button', { class: 'pa-btn2', type: 'button', 'aria-expanded': 'false', title: 'Paste settings JSON' }, 'Import');
  const status = h('p', { class: 'pa-set-status', 'aria-live': 'polite' });
  const fallback = h('textarea', { class: 'pa-ta', readonly: true, rows: 5, 'aria-label': 'Settings JSON (select and copy)', id: 'pa-copy-fallback' });
  const fallbackBox = h('div', { class: 'pa-import', hidden: true },
    h('label', { for: 'pa-copy-fallback', class: 'pa-label' }, 'Copy this JSON'), fallback);
  const importTa = h('textarea', { class: 'pa-ta', rows: 4, id: 'pa-import-ta', placeholder: '{"regions": 5, "items": {"sword": {"order": "start"}}}', spellcheck: 'false' });
  const importErr = h('p', { class: 'pa-set-note is-warn', hidden: true });
  const importBox = h('div', { class: 'pa-import', hidden: true },
    h('label', { for: 'pa-import-ta', class: 'pa-label' }, 'Paste settings JSON'),
    importTa,
    h('div', { class: 'pa-row-btns' },
      h('button', { class: 'pa-btn2 is-primary', type: 'button', onclick: doImport }, 'Apply'),
      h('button', { class: 'pa-btn2', type: 'button', onclick: () => toggleImport(false) }, 'Cancel')),
    importErr);

  const search = h('input', { type: 'search', id: 'pa-set-search', class: 'pa-search-in', placeholder: 'Search settings, items, graphics', autocomplete: 'off', spellcheck: 'false', 'aria-keyshortcuts': '/' });
  const clearBtn = h('button', { class: 'pa-search-x', type: 'button', 'aria-label': 'Clear search', hidden: true }, '×');
  const searchBox = h('div', { class: 'pa-search' },
    h('label', { for: 'pa-set-search', class: 'pa-sr' }, 'Search settings'),
    h('span', { class: 'pa-search-i', 'aria-hidden': 'true' }, '⌕'),
    search, clearBtn,
    h('kbd', { class: 'pa-kbd', 'aria-hidden': 'true', title: 'Press / to search' }, '/'));
  const emptyQ = h('span', { class: 'pa-q' });
  const empty = h('div', { class: 'pa-search-empty', hidden: true },
    h('p', null, 'No settings match ', emptyQ, '.'),
    h('button', { class: 'pa-btn2', type: 'button', onclick: () => setQuery('', true) }, 'Clear search'));
  const groupsBox = h('div', { class: 'pa-groups' });

  resetAll.addEventListener('click', () => resetSome(true, true, 'Reset'));
  /** reset generation and/or graphics; always undoable for a few seconds */
  function resetSome(gen: boolean, gfx: boolean, what: string): void {
    undoPrev = { gen: JSON.parse(JSON.stringify(model.cur)), gfx: { ...model.gCur } };
    if (gen) model.replace(defaultSettings());
    if (gfx) model.replaceGraphics(defaultGraphics());
    undoBox.replaceChildren(`${what}. `, h('button', { class: 'pa-link', type: 'button', onclick: undo }, 'Undo'));
    clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => { undoBox.replaceChildren(); undoPrev = null; }, 8000);
  }
  function undo(): void {
    if (!undoPrev) return;
    const prev = undoPrev;
    undoPrev = null;
    clearTimeout(undoTimer);
    if (JSON.stringify(prev.gen) !== JSON.stringify(model.cur)) model.replace(prev.gen);
    if (JSON.stringify(prev.gfx) !== JSON.stringify(model.gCur)) model.replaceGraphics(prev.gfx);
    undoBox.replaceChildren('Restored.');
    undoTimer = window.setTimeout(() => undoBox.replaceChildren(), 2500);
    resetAll.focus();
  }

  copyBtn.addEventListener('click', () => {
    const json = model.diffJson();
    const n = Object.keys(JSON.parse(json)).length;
    const showFallback = () => {
      fallback.value = json;
      fallbackBox.hidden = false;
      fallback.focus();
      fallback.select();
      status.textContent = 'Clipboard not available: select the JSON below and copy it.';
    };
    try {
      if (!navigator.clipboard?.writeText) { showFallback(); return; }
      navigator.clipboard.writeText(json).then(() => {
        fallbackBox.hidden = true;
        status.textContent = n ? 'Copied the changed values as JSON.' : 'Copied {} (everything is at its default).';
      }, showFallback);
    } catch { showFallback(); }
  });
  importBtn.addEventListener('click', () => toggleImport(importBox.hidden));
  function toggleImport(open: boolean): void {
    importBox.hidden = !open;
    importBtn.setAttribute('aria-expanded', String(open));
    importErr.hidden = true;
    if (open) importTa.focus();
  }
  function doImport(): void {
    try {
      const next = model.parse(importTa.value);
      model.replace(next.gen);
      if (next.graphics) model.replaceGraphics(next.graphics);
      importTa.value = '';
      toggleImport(false);
      status.textContent = 'Imported. Values out of range were clamped.';
      importBtn.focus();
    } catch (e) {
      importErr.textContent = e instanceof Error ? e.message : String(e);
      importErr.hidden = false;
    }
  }

  search.addEventListener('input', () => setQuery(search.value, false));
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (search.value) { ev.preventDefault(); ev.stopPropagation(); setQuery('', true); }
    }
  });
  clearBtn.addEventListener('click', () => setQuery('', true));

  function setQuery(q: string, writeBack: boolean): void {
    query = q;
    if (writeBack) { search.value = q; search.focus(); }
    filter();
  }

  function filter(): void {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    clearBtn.hidden = !query;
    let any = 0;
    for (const g of groups) {
      let n = 0;
      for (const r of g.rows) {
        const ok = words.every((w) => r.text.includes(w));
        r.el.hidden = !ok;
        r.highlight(ok ? words : []);
        if (ok) n++;
      }
      const show = g.kind === 'items' ? words.length > 0 && n > 0 : n > 0;
      g.sec.hidden = !show;
      const open = words.length > 0 || !collapsed.has(g.name);
      g.body.hidden = !open;
      g.head.setAttribute('aria-expanded', String(open));
      if (show) any += n;
    }
    for (const d of divisions) d.el.hidden = !groups.some((g) => !g.sec.hidden && (g.kind === d.kind || (d.kind === 'gen' && g.kind === 'items')));
    let firstShown = true;
    for (const d of divisions) { d.el.classList.toggle('is-first', firstShown && !d.el.hidden); if (!d.el.hidden) firstShown = false; }
    emptyQ.textContent = `“${query.trim()}”`;
    empty.hidden = any > 0 || !words.length;
  }

  function build(c: TabCtx): void {
    const names: string[] = [];
    for (const d of SETTING_DEFS) if (!names.includes(d.group)) names.push(d.group);
    const division = (kind: 'gen' | 'gfx', title: string, sub: string, resetLabel: string, onReset: () => void) => {
      const reset = h('button', { class: 'pa-btn2 pa-div-reset', type: 'button', onclick: onReset }, resetLabel);
      const box = h('div', { class: `pa-div is-${kind}` },
        h('div', { class: 'pa-div-h' }, h('div', null, h('h3', { class: 'pa-div-t' }, title), h('p', { class: 'pa-div-s' }, sub)), reset));
      divisions.push({ kind, el: box, reset });
      groupsBox.append(box);
      return box;
    };
    let target = division('gen', 'Generation', 'Changes the world: every change regenerates this seed.', 'Reset generation', () => resetSome(true, false, 'Generation reset'));
    const mk = (name: string, kind: Kind) => {
      const badge = h('span', { class: 'pa-grp-n pa-num' });
      const head = h('button', { class: 'pa-grp-h', type: 'button', 'aria-expanded': 'true' },
        h('span', { class: 'pa-grp-tw', 'aria-hidden': 'true' }), h('span', { class: 'pa-grp-t' }, name.replace(/^Graphics:\s*/i, '')), badge);
      const body = h('div', { class: 'pa-grp-b' });
      const sec = h('section', { class: 'pa-grp', 'data-group': name }, head, body);
      const g = { name, sec, head, body, badge, rows: [] as Row[], kind };
      head.addEventListener('click', () => {
        if (query) return;
        if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
        filter();
      });
      groups.push(g);
      target.append(sec);
      return g;
    };
    for (const name of names) {
      const g = mk(name, 'gen');
      for (const d of SETTING_DEFS.filter((x) => x.group === name)) {
        const r = settingRow(model, d, 's');
        g.rows.push(r); rows.push(r); g.body.append(r.el);
      }
    }
    const gi = mk('Items', 'items');
    for (const d of ITEM_SETTING_DEFS) {
      const r = itemRow(model, d, 'si', c.world, { focusLoc: (l) => ctx?.cb.focusLoc(l) });
      gi.rows.push(r); rows.push(r); gi.body.append(r.el);
    }
    // graphics: built generically from GRAPHICS_DEFS, groups in the order they first appear
    target = division('gfx', 'Graphics', 'Changes only how the map is drawn. Applied instantly; the world stays the same.', 'Reset graphics', () => resetSome(false, true, 'Graphics reset'));
    const gNames: string[] = [];
    for (const d of GRAPHICS_DEFS) if (!gNames.includes(d.group)) gNames.push(d.group);
    for (const name of gNames) {
      const g = mk(name, 'gfx');
      for (const d of GRAPHICS_DEFS.filter((x) => x.group === name)) {
        const r = graphicsRow(model, d, GRAPHICS_DEFS, 'sg');
        g.rows.push(r); rows.push(r); g.body.append(r.el);
      }
    }
    const head = h('div', { class: 'pa-set-head' },
        h('div', { class: 'pa-set-bar' }, count, resetAll, undoBox, h('span', { class: 'pa-grow' }), copyBtn, importBtn),
        searchBox);
    el.append(head, status, fallbackBox, importBox, empty, groupsBox);
    // group headers stick right below the (sticky) search header, whatever its height
    const setH = () => el.style.setProperty('--pa-head-h', `${Math.max(0, head.offsetHeight - 12)}px`);
    try { ro = new ResizeObserver(setH); ro.observe(head); } catch { /* old browser: CSS fallback */ }
    setH();
    built = true;
    filter();
  }

  function sync(): void {
    if (!built) return;
    const w = ctx?.world ?? null;
    for (const r of rows) r.sync(w, ctx?.ix ?? null);
    for (const g of groups) {
      const n = g.rows.reduce((a, r) => a + r.changed(), 0);
      g.badge.textContent = n ? `${n} changed` : '';
      g.badge.hidden = !n;
    }
    const n = model.changes();
    count.textContent = n ? `${n} changed` : 'All defaults';
    count.classList.toggle('is-mod', n > 0);
    resetAll.disabled = n === 0;
    for (const d of divisions) d.reset.disabled = (d.kind === 'gen' ? model.genChanges() : model.graphicsChanges()) === 0;
  }
  model.onChange(sync);

  return {
    el,
    keepScroll: true,
    render(c) { ctx = c; if (!built) build(c); sync(); },
    match: () => [],
    focusSearch() { search.focus(); search.select(); },
    destroy() { clearTimeout(undoTimer); ro?.disconnect(); },
  };
}
