// Row builders shared by the Settings and Items tabs. A row is built once and then synced in
// place (values, markers, notes), so focus, caret and drag state survive live regeneration.
import type { ItemId, World } from '../core/types';
import { ORDER_OPTIONS, HOME_OPTIONS, type SettingDef, type ItemSettingDef, type SettingKey } from '../core/settings';
import { GATES } from '../core/content';
import { reqItems } from '../core/req';
import { h } from './shared';
import type { Index } from './shared';
import type { SettingsModel } from './settingsModel';
import type { GraphicsDef } from '../render/graphics';

export interface Row {
  el: HTMLElement;
  /** lowercase text the search matches against */
  text: string;
  group: string;
  sync(world: World | null, ix: Index | null): void;
  highlight(words: string[]): void;
  /** values differing from default (for group badges) */
  changed(): number;
}

/** Settings that only matter when another one is on. Kept in the UI, not the core defs. */
export const DEPENDS: Partial<Record<SettingKey, SettingKey[]>> = {
  underworldSize: ['underworld'],
  underworldRegions: ['underworld'],
  skySize: ['sky'],
  extraStairs: ['underworld', 'sky'],
  ledges: ['cliffs'],
  pricePeddlerHeart: ['merchant'],
};

/** Search text of each kind of row (also used to count matches in the other tab). */
export function settingText(d: SettingDef): string {
  return `${d.label} ${d.group} ${d.help} ${d.keywords ?? ''} ${d.key}`.toLowerCase();
}
export function itemText(d: ItemSettingDef, world: World | null): string {
  const def = world?.items[d.id];
  const fieldWords = d.fields.map((f) => ({ enabled: 'enabled on off', order: 'order when start early late', home: 'home where dungeon loose overworld', cap: 'capacity cap carry limit' })[f]).join(' ');
  return `${def?.name ?? d.id} ${d.id} ${def?.kind ?? ''} ${d.help} items item ${fieldWords}`.toLowerCase();
}
export function graphicsText(d: GraphicsDef): string {
  return `${d.label} ${d.group} ${d.help} ${d.keywords ?? ''} ${d.key} graphics ${(d.options ?? []).map((o) => o.label).join(' ')}`.toLowerCase();
}
export const searchWords = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
export const matches = (text: string, words: string[]) => words.length > 0 && words.every((w) => text.includes(w));

let seq = 0;
const uid = (p: string) => `${p}-${(seq++).toString(36)}`;

export function fmtSetting(d: SettingDef, v: number | boolean): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (d.type === 'int') return String(v);
  if (d.min === 0 && d.max === 1) return `${Math.round(v * 100)}%`;
  const step = d.step ?? 0.1;
  const dec = step >= 1 ? 0 : Math.min(2, (String(step).split('.')[1] ?? '').length);
  return v.toFixed(dec);
}

/** Label text with every search word wrapped in <mark>. */
export function marked(text: string, words: string[]): (Node | string)[] {
  const ws = words.filter(Boolean);
  if (!ws.length) return [text];
  const lower = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const w of ws) {
    let i = lower.indexOf(w);
    while (i >= 0) { hits.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  if (!hits.length) return [text];
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of hits) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const out: (Node | string)[] = [];
  let p = 0;
  for (const [a, b] of merged) {
    if (a > p) out.push(text.slice(p, a));
    out.push(h('mark', null, text.slice(a, b)));
    p = b;
  }
  if (p < text.length) out.push(text.slice(p));
  return out;
}

function resetBtn(label: string, onclick: () => void): HTMLButtonElement {
  return h('button', { class: 'pa-reset', type: 'button', title: `Reset ${label} to its default`, 'aria-label': `Reset ${label}`, onclick }, 'Reset');
}

function switchInput(id: string, onchange: (v: boolean) => void): HTMLInputElement {
  const inp = h('input', { class: 'pa-switch', type: 'checkbox', role: 'switch', id });
  inp.addEventListener('input', () => onchange(inp.checked));
  return inp;
}

const notFocused = (el: Element) => document.activeElement !== el;

// ---------------------------------------------------------------- generation settings
export function settingRow(model: SettingsModel, d: SettingDef, prefix: string): Row {
  const id = uid(`${prefix}-${d.key}`);
  const lbl = h('span', { class: 'pa-set-lbl' }, d.label);
  const label = h('label', { for: id, class: 'pa-set-label' }, lbl);
  const val = h('span', { class: 'pa-set-val pa-num', 'aria-hidden': d.type === 'bool' ? 'true' : undefined });
  const reset = resetBtn(d.label, () => model.set(d.key, model.def(d.key)));
  const help = h('p', { class: 'pa-set-help', id: id + '-help' }, d.help);
  const note = h('p', { class: 'pa-set-note', id: id + '-note', 'aria-live': 'polite' });
  const el = h('div', { class: `pa-set is-${d.type}`, 'data-key': d.key });
  let sync: () => void;

  if (d.type === 'bool') {
    const sw = switchInput(id, (v) => { model.set(d.key, v); });
    sw.setAttribute('aria-describedby', `${id}-help ${id}-note`);
    el.append(h('div', { class: 'pa-set-top' }, label, reset, sw), help, note);
    sync = () => { sw.checked = model.get(d.key) as boolean; };
  } else {
    const range = h('input', {
      type: 'range', id, min: d.min, max: d.max, step: d.step ?? (d.type === 'int' ? 1 : 0.01),
      'aria-describedby': `${id}-help ${id}-note`,
    });
    const parse = (s: string) => {
      const n = Number(s);
      if (!Number.isFinite(n) || s.trim() === '') return null;
      const c = Math.max(d.min!, Math.min(d.max!, n));
      return d.type === 'int' ? Math.round(c) : c;
    };
    range.addEventListener('input', () => {
      const v = parse(range.value);
      if (v === null) return;
      model.set(d.key, v);
      val.textContent = fmtSetting(d, v);
      if (num) num.value = String(v);
    });
    let num: HTMLInputElement | null = null;
    const ctl = h('div', { class: 'pa-set-ctl' }, range);
    if (d.type === 'int') {
      num = h('input', { type: 'number', id: id + '-n', class: 'pa-num-in', min: d.min, max: d.max, step: d.step ?? 1, inputmode: 'numeric' });
      const n = num;
      n.addEventListener('input', () => {
        const v = parse(n.value);
        if (v === null) return;
        model.set(d.key, v);
        range.value = String(v);
      });
      n.addEventListener('blur', () => { n.value = String(model.get(d.key)); });
      ctl.append(h('label', { for: id + '-n', class: 'pa-sr' }, `${d.label} value`), n);
    } else {
      ctl.append(val);
    }
    el.append(h('div', { class: 'pa-set-top' }, label, reset), ctl, help, note);
    sync = () => {
      const v = model.get(d.key) as number;
      if (notFocused(range)) range.value = String(v);
      if (num && notFocused(num)) num.value = String(v);
      val.textContent = fmtSetting(d, v);
    };
  }

  const deps = DEPENDS[d.key];
  const depLabel = deps?.map((k) => labelOf(k)).join(' or ');
  return {
    el, group: d.group,
    text: settingText(d),
    sync() {
      sync();
      const mod = model.modified(d.key);
      el.classList.toggle('is-mod', mod);
      reset.hidden = !mod;
      const eff = model.effVal(d.key);
      const asked = model.get(d.key);
      const inert = !!deps && !deps.some((k) => model.effVal(k) === true);
      el.classList.toggle('is-inert', inert);
      if (eff !== asked) {
        note.textContent = `Using ${fmtSetting(d, eff)} in this world (you asked for ${fmtSetting(d, asked)}): limited by other settings.`;
        note.className = 'pa-set-note is-warn';
      } else if (inert) {
        note.textContent = `No effect right now: needs ${depLabel} on.`;
        note.className = 'pa-set-note';
      } else {
        note.textContent = '';
        note.className = 'pa-set-note';
      }
      note.hidden = !note.textContent;
    },
    highlight(words) { lbl.replaceChildren(...marked(d.label, words)); },
    changed: () => (model.modified(d.key) ? 1 : 0),
  };
}

let labels: Map<string, string> | null = null;
let labelSrc: SettingDef[] = [];
export function setLabelSource(defs: SettingDef[]): void { labelSrc = defs; labels = null; }
function labelOf(k: SettingKey): string {
  labels ??= new Map(labelSrc.map((d) => [d.key, d.label]));
  return labels.get(k) ?? k;
}

// ---------------------------------------------------------------- item settings
export interface ItemRowOpts { focusLoc(loc: string): void }

export function itemRow(model: SettingsModel, d: ItemSettingDef, prefix: string, world: World, opts: ItemRowOpts): Row {
  const def = world.items[d.id];
  const name = def?.name ?? d.id;
  const id = uid(`${prefix}-${d.id.replace(/[^a-z0-9]/gi, '')}`);
  const glyph = h('span', { class: 'pa-item-g', 'aria-hidden': 'true', style: { '--chip-c': def?.color ?? 'currentColor' } }, def?.icon ?? '?');
  const lbl = h('span', { class: 'pa-set-lbl' }, name);
  const help = h('p', { class: 'pa-set-help', id: id + '-help' }, d.help);
  const note = h('p', { class: 'pa-set-note' });
  const reset = resetBtn(name, () => { for (const f of d.fields) model.setItem(d.id, f, model.defItem(d.id, f)); });
  const el = h('div', { class: 'pa-set pa-item', 'data-item': d.id });
  const syncers: (() => void)[] = [];
  const isTool = d.fields.includes('enabled');
  let outcome: HTMLElement | null = null;
  let outcomeKey = '';
  let prices: HTMLElement | null = null;
  let pricesKey = '';

  if (isTool) {
    const sw = switchInput(id, (v) => model.setItem(d.id, 'enabled', v));
    sw.setAttribute('aria-describedby', id + '-help');
    el.append(h('div', { class: 'pa-set-top' }, glyph, h('label', { for: id, class: 'pa-set-label' }, lbl), reset, sw), help);
    syncers.push(() => { sw.checked = model.getItem(d.id, 'enabled') !== false; });
    const seg = (field: 'order' | 'home', title: string, options: { value: string; label: string; help: string }[]) => {
      const gname = `${id}-${field}`;
      const box = h('div', { class: 'pa-seg', role: 'radiogroup', 'aria-label': `${title}: ${name}` });
      const inputs: HTMLInputElement[] = [];
      for (const o of options) {
        const oid = `${gname}-${o.value}`;
        const r = h('input', { type: 'radio', name: gname, id: oid, value: o.value, class: 'pa-seg-in', 'aria-description': o.help });
        r.addEventListener('input', () => { if (r.checked) model.setItem(d.id, field, o.value); });
        inputs.push(r);
        box.append(r, h('label', { for: oid, class: 'pa-seg-l', title: o.help }, o.label));
      }
      syncers.push(() => {
        const v = model.getItem(d.id, field);
        for (const r of inputs) r.checked = r.value === v;
      });
      return h('div', { class: 'pa-seg-row' }, h('span', { class: 'pa-tf-k' }, title), box);
    };
    if (d.fields.includes('order')) el.append(seg('order', 'When', ORDER_OPTIONS));
    if (d.fields.includes('home')) el.append(seg('home', 'Where', HOME_OPTIONS));
    outcome = h('div', { class: 'pa-outcome' });
    el.append(outcome);
  }
  if (d.fields.includes('cap')) {
    const [lo, hi] = d.capRange ?? [1, 999];
    const range = h('input', { type: 'range', id, min: lo, max: hi, step: 1, 'aria-describedby': id + '-help' });
    const num = h('input', { type: 'number', id: id + '-n', class: 'pa-num-in', min: lo, max: hi, step: 1, inputmode: 'numeric' });
    const unit = h('span', { class: 'pa-set-val pa-num' });
    const parse = (s: string) => {
      const n = Number(s);
      return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(Math.max(lo, Math.min(hi, n)));
    };
    range.addEventListener('input', () => { const v = parse(range.value); if (v === null) return; model.setItem(d.id, 'cap', v); num.value = String(v); unit.textContent = `carry up to ${v}`; });
    num.addEventListener('input', () => { const v = parse(num.value); if (v === null) return; model.setItem(d.id, 'cap', v); range.value = String(v); unit.textContent = `carry up to ${v}`; });
    num.addEventListener('blur', () => { num.value = String(model.getItem(d.id, 'cap')); });
    el.append(
      h('div', { class: 'pa-set-top' }, glyph, h('label', { for: id, class: 'pa-set-label' }, lbl, h('span', { class: 'pa-sr' }, ' capacity')), unit, reset),
      h('div', { class: 'pa-set-ctl' }, range, h('label', { for: id + '-n', class: 'pa-sr' }, `${name} capacity value`), num),
      help);
    syncers.push(() => {
      const v = model.getItem(d.id, 'cap') as number;
      if (notFocused(range)) range.value = String(v);
      if (notFocused(num)) num.value = String(v);
      unit.textContent = `carry up to ${v}`;
    });
    if (d.id === 'rupees' || d.id === 'wallet') { prices = h('div', { class: 'pa-prices' }); el.append(prices); }
  }
  el.append(note);

  return {
    el, group: 'Items',
    text: itemText(d, world),
    sync(w, ix) {
      for (const s of syncers) s();
      const mod = d.fields.some((f) => model.modifiedItem(d.id, f));
      el.classList.toggle('is-mod', mod);
      reset.hidden = !mod;
      const off = isTool && model.effItem(d.id, 'enabled') === false;
      el.classList.toggle('is-off', off);
      // consumables whose container tool is switched off
      const container = w?.items[d.id]?.container;
      const contOff = !!container && model.effItem(container, 'enabled') === false;
      el.classList.toggle('is-inert', contOff);
      const capAsked = model.getItem(d.id, 'cap');
      const capEff = model.effItem(d.id, 'cap');
      if (capAsked !== undefined && capAsked !== capEff) note.textContent = `Using ${capEff} in this world: limited by other settings.`;
      else if (contOff) note.textContent = `No effect right now: needs ${w?.items[container!]?.name ?? container} enabled.`;
      else note.textContent = '';
      note.hidden = !note.textContent;
      if (outcome && w && ix) {
        const o = toolOutcome(w, ix, d.id, off);
        if (o.key !== outcomeKey) { outcomeKey = o.key; outcome.replaceChildren(...o.nodes(opts)); }
      }
      if (prices && w) {
        const p = priceLine(w, d.id);
        if (p.key !== pricesKey) { pricesKey = p.key; prices.replaceChildren(...p.nodes); }
      }
    },
    highlight(words) { lbl.replaceChildren(...marked(name, words)); },
    changed: () => d.fields.filter((f) => model.modifiedItem(d.id, f)).length,
  };
}

/** What happened to a tool in this world: where and when it was found, what it opens. */
function toolOutcome(w: World, ix: Index, id: ItemId, off: boolean): { key: string; nodes(o: ItemRowOpts): Node[] } {
  const checks = w.graph.checks.filter((c) => c.item === id);
  if (off || !checks.length) {
    const t = off ? 'Not in this world.' : 'Not placed in this world.';
    return { key: t, nodes: () => [h('span', { class: 'pa-muted' }, t)] };
  }
  const g = GATES[id];
  const asks = new Set([id, ...(g?.spends ? [g.spends] : [])]);
  const mentions = (r: Parameters<typeof reqItems>[0]) => [...reqItems(r)].some((x) => asks.has(x));
  const nEdges = w.graph.edges.filter((e) => mentions(e.req)).length;
  const nOther = w.graph.checks.filter((c) => mentions(c.req)).length + w.graph.sources.filter((s) => mentions(s.req)).length;
  const found = checks.map((c) => {
    const k = w.solution.checkSphere[c.id];
    return { c, k, where: ix.loc.get(c.loc)?.name ?? c.loc };
  });
  const opens = g
    ? nEdges + nOther
      ? `${g.label} · ${nEdges} gate${nEdges === 1 ? '' : 's'}${nOther ? ` + ${nOther} other check${nOther === 1 ? '' : 's'}` : ''} ${nEdges + nOther === 1 ? 'asks' : 'ask'} for it`
      : `${g.label} · no gate asks for it this seed`
    : `${nEdges} gate${nEdges === 1 ? ' asks' : 's ask'}${nOther ? `, plus ${nOther} other check${nOther === 1 ? '' : 's'}` : ''}`;
  const key = JSON.stringify([found.map((f) => [f.c.id, f.k]), opens]);
  return {
    key,
    nodes: (o) => [
      h('div', { class: 'pa-out' }, h('span', { class: 'pa-tf-k' }, 'Found'),
        h('span', { class: 'pa-out-v' }, ...found.map((f, i) => h('span', null, i ? ', ' : '',
          h('span', { class: 'pa-num pa-muted' }, f.k !== undefined ? `sphere ${f.k} · ` : 'unreachable · '),
          h('button', { class: 'pa-link', type: 'button', title: `Show ${f.where} on the map`, onclick: () => o.focusLoc(f.c.loc) }, f.c.label))))),
      h('div', { class: 'pa-out' }, h('span', { class: 'pa-tf-k' }, 'Opens'), h('span', { class: 'pa-out-v' }, opens)),
    ],
  };
}

/** Shop prices next to the wallet rows; a price above the capacity that pays for it is flagged. */
function priceLine(w: World, id: ItemId): { key: string; nodes: Node[] } {
  const s = w.settings;
  if (!s) return { key: '', nodes: [] };
  const base = s.items.rupees?.cap ?? 99;
  const big = s.items.wallet?.cap ?? 300;
  const list: [string, number, number, string][] = id === 'rupees'
    ? [['Bombs', s.priceBombs, base, 'base wallet'], ['Arrows', s.priceArrows, base, 'base wallet'], ...(s.merchant && w.npcs.some((n) => n.id === 'merchant') ? [['Peddler heart', s.pricePeddlerHeart, base, 'base wallet'] as [string, number, number, string]] : [])]
    : [['Shop heart', s.priceHeart, big, 'Big Wallet']];
  const key = JSON.stringify(list);
  const nodes: Node[] = [h('span', { class: 'pa-tf-k' }, 'Prices')];
  const box = h('span', { class: 'pa-out-v' });
  const moot = (n: string) => (n === 'Bombs' && s.items.bombBag?.enabled === false) || (n === 'Arrows' && s.items.bow?.enabled === false);
  list.forEach(([n, p, cap, wallet], i) => {
    if (moot(n)) { box.append(i ? ' · ' : '', h('span', { class: 'pa-muted', title: 'Not sold: the tool that carries it is off' }, `${n} ${p} (unused)`)); return; }
    const bad = p > cap;
    box.append(i ? ' · ' : '', h('span', { class: bad ? 'pa-bad' : '', title: bad ? `Costs ${p}, more than the ${wallet} holds (${cap}): it can never be bought` : `Paid from the ${wallet} (${cap})` },
      `${n} ${p}`, bad ? ` > ${cap}` : ''));
  });
  nodes.push(box);
  return { key, nodes: [h('div', { class: 'pa-out' }, ...nodes)] };
}

// ---------------------------------------------------------------- graphics settings (generic over GRAPHICS_DEFS)
export function fmtGraphic(d: GraphicsDef, v: number | boolean | string | undefined): string {
  if (v === undefined) return '';
  if (d.type === 'enum') return d.options?.find((o) => o.value === v)?.label ?? String(v);
  if (typeof v !== 'number') return typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  if (d.type === 'int') return String(v);
  if (d.min === 0 && d.max === 1) return `${Math.round(v * 100)}%`;
  const step = d.step ?? 0.1;
  const dec = step >= 1 ? 0 : Math.min(3, (String(step).split('.')[1] ?? '').length);
  return v.toFixed(dec);
}

/**
 * A graphics row has no effect when its "master" in the same group is off: the master is another
 * def whose key (minus a plural s) prefixes this key, e.g. shadows -> shadowStrength, bloom -> bloomThreshold.
 * Off means: bool false, enum 'off'/'none', or a number at 0. Missing keys are simply ignored.
 */
export function graphicsMaster(defs: GraphicsDef[], d: GraphicsDef): GraphicsDef | undefined {
  return defs.find((m) => {
    if (m === d || m.group !== d.group) return false;
    const stem = m.key.replace(/s$/, '');
    return stem.length >= 3 && d.key.startsWith(stem) && d.key !== m.key;
  });
}
const isOff = (m: GraphicsDef, v: unknown) =>
  m.type === 'bool' ? v === false : m.type === 'enum' ? v === 'off' || v === 'none' : typeof v === 'number' && m.min === 0 && v === 0;

export function graphicsRow(model: SettingsModel, d: GraphicsDef, defs: GraphicsDef[], prefix: string): Row {
  const id = uid(`${prefix}-${d.key.replace(/[^a-z0-9]/gi, '')}`);
  const lbl = h('span', { class: 'pa-set-lbl' }, d.label);
  const label = h('label', { for: id, class: 'pa-set-label' }, lbl);
  const val = h('span', { class: 'pa-set-val pa-num' });
  const reset = resetBtn(d.label, () => { if (d.default !== undefined) model.setG(d.key, d.default); });
  const help = h('p', { class: 'pa-set-help', id: id + '-help' }, d.help);
  const note = h('p', { class: 'pa-set-note' });
  const el = h('div', { class: `pa-set is-${d.type} is-gfx`, 'data-gkey': d.key });
  let sync: () => void = () => {};
  const master = graphicsMaster(defs, d);

  if (d.type === 'bool') {
    const sw = switchInput(id, (v) => model.setG(d.key, v));
    sw.setAttribute('aria-describedby', id + '-help');
    el.append(h('div', { class: 'pa-set-top' }, label, reset, sw), help, note);
    sync = () => { sw.checked = model.getG(d.key) === true; };
  } else if (d.type === 'enum') {
    const opts = d.options ?? [];
    if (opts.length <= 4) {
      const box = h('div', { class: 'pa-seg', role: 'radiogroup', 'aria-labelledby': id + '-l' });
      const inputs: HTMLInputElement[] = [];
      opts.forEach((o, i) => {
        const oid = `${id}-${i}`;
        const r = h('input', { type: 'radio', name: id, id: i === 0 ? id : oid, value: o.value, class: 'pa-seg-in', 'aria-description': o.help });
        r.addEventListener('input', () => { if (r.checked) model.setG(d.key, o.value); });
        inputs.push(r);
        box.append(r, h('label', { for: i === 0 ? id : oid, class: 'pa-seg-l', title: o.help ?? o.label }, o.label));
      });
      label.id = id + '-l';
      label.removeAttribute('for');
      el.append(h('div', { class: 'pa-set-top' }, label, reset), h('div', { class: 'pa-set-ctl' }, box), help, note);
      sync = () => { const v = model.getG(d.key); for (const r of inputs) r.checked = r.value === v; };
    } else {
      const sel = h('select', { id, class: 'pa-select', 'aria-describedby': id + '-help' },
        ...opts.map((o) => h('option', { value: o.value, title: o.help }, o.label)));
      sel.addEventListener('input', () => model.setG(d.key, sel.value));
      el.append(h('div', { class: 'pa-set-top' }, label, reset), h('div', { class: 'pa-set-ctl' }, sel), help, note);
      sync = () => { if (notFocused(sel)) sel.value = String(model.getG(d.key)); };
    }
  } else {
    const min = d.min ?? 0, max = d.max ?? 1;
    const range = h('input', { type: 'range', id, min, max, step: d.step ?? (d.type === 'int' ? 1 : 0.01), 'aria-describedby': id + '-help' });
    range.addEventListener('input', () => {
      const n = Number(range.value);
      if (!Number.isFinite(n)) return;
      const v = d.type === 'int' ? Math.round(n) : n;
      model.setG(d.key, v);
      val.textContent = fmtGraphic(d, v);
    });
    el.append(h('div', { class: 'pa-set-top' }, label, reset), h('div', { class: 'pa-set-ctl' }, range, val), help, note);
    sync = () => {
      const v = model.getG(d.key);
      if (notFocused(range) && typeof v === 'number') range.value = String(v);
      val.textContent = fmtGraphic(d, v);
    };
  }

  return {
    el, group: d.group,
    text: graphicsText(d),
    sync() {
      sync();
      const mod = model.modifiedG(d.key);
      el.classList.toggle('is-mod', mod);
      reset.hidden = !mod;
      const inert = !!master && isOff(master, model.effG(master.key));
      el.classList.toggle('is-inert', inert);
      const asked = model.getG(d.key), eff = model.effG(d.key);
      note.textContent = asked !== eff ? `Using ${fmtGraphic(d, eff)}: limited by the renderer.` : inert ? `No effect right now: ${master!.label} is off.` : '';
      note.className = asked !== eff ? 'pa-set-note is-warn' : 'pa-set-note';
      note.hidden = !note.textContent;
    },
    highlight(words) { lbl.replaceChildren(...marked(d.label, words)); },
    changed: () => (model.effG(d.key) !== model.defG(d.key) ? 1 : 0),
  };
}
