// Shared shell of the Settings and Graphics tabs: a fixed (non-scrolling) header with the change
// count, reset/undo, copy/import and a search box, over a scrolling list of collapsible groups.
// Built once, then synced in place, so focus, caret and drag state survive live updates.
import { h } from './shared';
import { searchWords, matches, type Row } from './settingRows';
import type { TabCtx, TabView } from './tab';

export interface ConfigTab extends TabView {
  /** focus the search box, optionally replacing its text */
  focusSearch(q?: string): void;
}

export interface Group { name: string; sec: HTMLElement; head: HTMLButtonElement; body: HTMLElement; badge: HTMLElement; rows: Row[]; searchOnly: boolean }

export interface ConfigTabOpts {
  id: string;
  /** shown above the groups */
  intro: string;
  searchPlaceholder: string;
  /** build rows; `mk` creates a group (searchOnly groups only appear while searching) */
  build(ctx: TabCtx | null, mk: (name: string, searchOnly?: boolean) => Group): void;
  /** needs a world before it can build (item rows use item names) */
  needsWorld: boolean;
  changes(): number;
  resetLabel: string;
  resetTitle: string;
  /** reset; returns an undo function */
  reset(): () => void;
  copyLabel: string;
  copyJson(): string;
  importLabel: string;
  importPlaceholder: string;
  /** apply pasted JSON; throws Error with a readable message */
  importJson(text: string): string;
  /** the other tab: how many of its rows match these words, and how to jump there */
  other: { label: string; count(words: string[], ctx: TabCtx | null): number; jump(query: string): void };
  onSubscribe(fn: () => void): void;
}

export function createConfigTab(o: ConfigTabOpts): ConfigTab {
  const el = h('div', { class: 'pa-settings' });
  let built = false;
  let ctx: TabCtx | null = null;
  const rows: Row[] = [];
  const groups: Group[] = [];
  const collapsed = new Set<string>();
  let query = '';
  let undoTimer = 0;
  let undoFn: (() => void) | null = null;
  const P = o.id;

  const count = h('span', { class: 'pa-changed pa-num', 'aria-live': 'polite' });
  const resetBtn = h('button', { class: 'pa-btn2', type: 'button', title: o.resetTitle }, o.resetLabel);
  const undoBox = h('span', { class: 'pa-undo', 'aria-live': 'polite' });
  const copyBtn = h('button', { class: 'pa-btn2', type: 'button', title: 'Copy the changed values as JSON' }, o.copyLabel);
  const importBtn = h('button', { class: 'pa-btn2', type: 'button', 'aria-expanded': 'false', title: 'Paste JSON' }, 'Import');
  const status = h('p', { class: 'pa-set-status', 'aria-live': 'polite' });
  const fallback = h('textarea', { class: 'pa-ta', readonly: true, rows: 5, 'aria-label': 'JSON (select and copy)', id: `${P}-copy-fallback` });
  const fallbackBox = h('div', { class: 'pa-import', hidden: true },
    h('label', { for: `${P}-copy-fallback`, class: 'pa-label' }, 'Copy this JSON'), fallback);
  const importTa = h('textarea', { class: 'pa-ta', rows: 4, id: `${P}-import-ta`, placeholder: o.importPlaceholder, spellcheck: 'false' });
  const importErr = h('p', { class: 'pa-set-note is-warn', hidden: true });
  const importBox = h('div', { class: 'pa-import', hidden: true },
    h('label', { for: `${P}-import-ta`, class: 'pa-label' }, o.importLabel),
    importTa,
    h('div', { class: 'pa-row-btns' },
      h('button', { class: 'pa-btn2 is-primary', type: 'button', onclick: doImport }, 'Apply'),
      h('button', { class: 'pa-btn2', type: 'button', onclick: () => toggleImport(false) }, 'Cancel')),
    importErr);

  const search = h('input', { type: 'search', id: `${P}-search`, class: 'pa-search-in', placeholder: o.searchPlaceholder, autocomplete: 'off', spellcheck: 'false', 'aria-keyshortcuts': '/' });
  const clearBtn = h('button', { class: 'pa-search-x', type: 'button', 'aria-label': 'Clear search', hidden: true }, '×');
  const searchBox = h('div', { class: 'pa-search' },
    h('label', { for: `${P}-search`, class: 'pa-sr' }, o.searchPlaceholder),
    h('span', { class: 'pa-search-i', 'aria-hidden': 'true' }, '⌕'),
    search, clearBtn,
    h('kbd', { class: 'pa-kbd', 'aria-hidden': 'true', title: 'Press / to search' }, '/'));
  const otherBtn = h('button', { class: 'pa-link pa-other', type: 'button', onclick: () => o.other.jump(query) });
  const otherBox = h('p', { class: 'pa-other-row', hidden: true }, otherBtn);
  const emptyQ = h('span', { class: 'pa-q' });
  const empty = h('div', { class: 'pa-search-empty', hidden: true },
    h('p', null, 'Nothing here matches ', emptyQ, '.'),
    h('button', { class: 'pa-btn2', type: 'button', onclick: () => setQuery('', true) }, 'Clear search'));
  const groupsBox = h('div', { class: 'pa-groups' });

  /** fixed header: lives outside the scrolling body (mounted by the panel) */
  const head = h('div', { class: 'pa-set-head' },
    h('div', { class: 'pa-set-bar' }, count, resetBtn, undoBox, h('span', { class: 'pa-grow' }), copyBtn, importBtn),
    searchBox, otherBox, status, fallbackBox, importBox);

  resetBtn.addEventListener('click', () => {
    undoFn = o.reset();
    undoBox.replaceChildren('Reset. ', h('button', { class: 'pa-link', type: 'button', onclick: undo }, 'Undo'));
    clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => { undoBox.replaceChildren(); undoFn = null; }, 8000);
  });
  function undo(): void {
    if (!undoFn) return;
    const fn = undoFn;
    undoFn = null;
    clearTimeout(undoTimer);
    fn();
    undoBox.replaceChildren('Restored.');
    undoTimer = window.setTimeout(() => undoBox.replaceChildren(), 2500);
    resetBtn.focus();
  }

  copyBtn.addEventListener('click', () => {
    const json = o.copyJson();
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
    if (open) { fallbackBox.hidden = true; importTa.focus(); }
  }
  function doImport(): void {
    try {
      status.textContent = o.importJson(importTa.value);
      importTa.value = '';
      toggleImport(false);
      importBtn.focus();
    } catch (e) {
      importErr.textContent = e instanceof Error ? e.message : String(e);
      importErr.hidden = false;
    }
  }

  search.addEventListener('input', () => setQuery(search.value, false));
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && search.value) { ev.preventDefault(); ev.stopPropagation(); setQuery('', true); }
  });
  clearBtn.addEventListener('click', () => setQuery('', true));

  function setQuery(q: string, writeBack: boolean): void {
    query = q;
    if (writeBack) { search.value = q; search.focus(); }
    filter();
  }

  function filter(): void {
    const words = searchWords(query);
    clearBtn.hidden = !query;
    let any = 0;
    for (const g of groups) {
      let n = 0;
      for (const r of g.rows) {
        const ok = !words.length || matches(r.text, words);
        r.el.hidden = !ok;
        r.highlight(ok ? words : []);
        if (ok) n++;
      }
      const show = g.searchOnly ? words.length > 0 && n > 0 : n > 0;
      g.sec.hidden = !show;
      const open = words.length > 0 || !collapsed.has(g.name);
      g.body.hidden = !open;
      g.head.setAttribute('aria-expanded', String(open));
      if (show) any += n;
    }
    const other = words.length ? o.other.count(words, ctx) : 0;
    otherBox.hidden = other === 0;
    otherBtn.textContent = `${other} more in ${o.other.label} →`;
    emptyQ.textContent = `“${query.trim()}”`;
    empty.hidden = any > 0 || !words.length;
  }

  function mk(name: string, searchOnly = false): Group {
    const badge = h('span', { class: 'pa-grp-n pa-num' });
    const gh = h('button', { class: 'pa-grp-h', type: 'button', 'aria-expanded': 'true' },
      h('span', { class: 'pa-grp-tw', 'aria-hidden': 'true' }), h('span', { class: 'pa-grp-t' }, name.replace(/^Graphics:\s*/i, '')), badge);
    const body = h('div', { class: 'pa-grp-b' });
    const sec = h('section', { class: 'pa-grp', 'data-group': name }, gh, body);
    const g: Group = { name, sec, head: gh, body, badge, rows: [], searchOnly };
    gh.addEventListener('click', () => {
      if (query) return;
      if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
      filter();
    });
    groups.push(g);
    groupsBox.append(sec);
    return g;
  }

  function build(c: TabCtx | null): void {
    o.build(c, (name, searchOnly) => mk(name, searchOnly));
    for (const g of groups) for (const r of g.rows) { rows.push(r); g.body.append(r.el); }
    el.append(h('p', { class: 'pa-note pa-intro' }, o.intro), empty, groupsBox);
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
    const n = o.changes();
    count.textContent = n ? `${n} changed` : 'All defaults';
    count.classList.toggle('is-mod', n > 0);
    resetBtn.disabled = n === 0;
    if (query) filter();
  }
  o.onSubscribe(sync);

  return {
    el,
    head,
    keepScroll: true,
    render(c) {
      ctx = c;
      if (!built && (c || !o.needsWorld)) build(c);
      sync();
    },
    match: () => [],
    focusSearch(q?: string) {
      if (q !== undefined) { search.value = q; query = q; filter(); }
      search.focus();
      if (q === undefined) search.select();
    },
    destroy() { clearTimeout(undoTimer); },
  };
}
