// Shared state for the Settings and Items tabs.
// `cur` is what the user asked for; `eff` is what the current world was generated with (normalised by main).
// They differ when a value was clamped by another setting; the UI shows both rather than fighting the user.
import type { ItemId, World } from '../core/types';
import {
  SETTING_DEFS, ITEM_SETTING_DEFS, defaultSettings, normalizeSettings, countChanges,
  type GenSettings, type ItemSetting, type SettingKey,
} from '../core/settings';

type Field = keyof ItemSetting;
type Val = number | boolean | string | undefined;

const clone = (s: GenSettings): GenSettings => JSON.parse(JSON.stringify(s));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class SettingsModel {
  readonly defaults = defaultSettings();
  cur: GenSettings = defaultSettings();
  eff: GenSettings = defaultSettings();
  private raf = 0;
  private pending = false;
  private listeners = new Set<() => void>();

  constructor(private send: (next: GenSettings) => void) {}

  /** called with every new world; keeps the user's asked-for values unless the settings changed elsewhere */
  setWorld(world: World): void {
    const eff = world.settings ? clone(world.settings) : defaultSettings();
    this.eff = eff;
    if (!this.pending && !same(normalizeSettings(this.cur), eff)) this.cur = clone(eff);
    this.emit();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(): void { for (const fn of this.listeners) fn(); }

  get(key: SettingKey): number | boolean { return this.cur[key] as number | boolean; }
  effVal(key: SettingKey): number | boolean { return this.eff[key] as number | boolean; }
  def(key: SettingKey): number | boolean { return this.defaults[key] as number | boolean; }
  getItem(id: ItemId, f: Field): Val { return this.cur.items[id]?.[f]; }
  effItem(id: ItemId, f: Field): Val { return this.eff.items[id]?.[f]; }
  defItem(id: ItemId, f: Field): Val { return this.defaults.items[id]?.[f]; }

  // "modified" means the user asked for something else. A default that other settings limit is not a change.
  modified(key: SettingKey): boolean { return this.get(key) !== this.def(key); }
  modifiedItem(id: ItemId, f: Field): boolean { return this.getItem(id, f) !== this.defItem(id, f); }

  set(key: SettingKey, v: number | boolean): void {
    if (this.cur[key] === v) return;
    (this.cur as unknown as Record<string, unknown>)[key] = v;
    this.schedule();
  }
  setItem(id: ItemId, f: Field, v: Val): void {
    const it = (this.cur.items[id] ??= {});
    if (it[f] === v) return;
    (it as Record<string, Val>)[f] = v;
    this.schedule();
  }
  /** replace everything (reset all, undo, import) and send right away */
  replace(next: GenSettings): void {
    this.cur = clone(next);
    this.schedule(true);
  }

  /** number of changed values in the effective settings, or in what was asked if that is larger */
  changes(): number { return Math.max(countChanges(this.eff), countChanges(normalizeSettings(this.cur))); }

  /** JSON with only the values that differ from the defaults */
  diffJson(): string {
    const out: Record<string, unknown> = {};
    for (const d of SETTING_DEFS) if (this.eff[d.key] !== this.defaults[d.key]) out[d.key] = this.eff[d.key];
    const items: Record<string, Record<string, unknown>> = {};
    for (const d of ITEM_SETTING_DEFS) {
      for (const f of d.fields) {
        const v = this.eff.items[d.id]?.[f];
        if (v !== this.defaults.items[d.id]?.[f]) (items[d.id] ??= {})[f] = v;
      }
    }
    if (Object.keys(items).length) out.items = items;
    return JSON.stringify(out, null, 2);
  }

  /** parse pasted JSON on top of the defaults; throws with a readable message */
  parse(text: string): GenSettings {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object like {"regions": 5}.');
    const r = raw as Record<string, unknown>;
    const known = new Set<string>([...SETTING_DEFS.map((d) => d.key), 'items']);
    const unknown = Object.keys(r).filter((k) => !known.has(k));
    if (unknown.length === Object.keys(r).length && unknown.length) throw new Error(`No known settings in it (${unknown.slice(0, 3).join(', ')}).`);
    const next = defaultSettings();
    for (const d of SETTING_DEFS) if (d.key in r) (next as unknown as Record<string, unknown>)[d.key] = r[d.key];
    const items = r.items as Record<string, ItemSetting> | undefined;
    if (items && typeof items === 'object') for (const [id, v] of Object.entries(items)) if (v && typeof v === 'object') next.items[id] = { ...next.items[id], ...v };
    return next;
  }

  private schedule(now = false): void {
    this.pending = true;
    this.emit();
    const fire = () => {
      this.raf = 0;
      this.pending = false;
      this.send(clone(this.cur));
    };
    if (now) { if (this.raf) cancelAnimationFrame(this.raf); fire(); return; }
    if (this.raf) return;
    this.raf = requestAnimationFrame(fire);
  }

  destroy(): void { if (this.raf) cancelAnimationFrame(this.raf); this.listeners.clear(); }
}
