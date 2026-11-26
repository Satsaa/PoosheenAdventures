// Shared state for the Settings and Items tabs.
// `cur` is what the user asked for; `eff` is what the current world was generated with (normalised by main).
// They differ when a value was clamped by another setting; the UI shows both rather than fighting the user.
import type { ItemId, World } from '../core/types';
import { GRAPHICS_DEFS, defaultGraphics, normalizeGraphics, type GraphicsSettings } from '../render/graphics';
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
  // graphics: same asked/effective split, but applying them never regenerates the world
  readonly gDefaults: GraphicsSettings = defaultGraphics();
  gCur: GraphicsSettings = defaultGraphics();
  gEff: GraphicsSettings = defaultGraphics();
  private gRaf = 0;
  private gPending = false;

  constructor(private send: (next: GenSettings) => void, private sendG: (next: GraphicsSettings) => void) {}

  setGraphics(g: GraphicsSettings): void {
    this.gEff = { ...g };
    if (!this.gPending && !same(normalizeGraphics(this.gCur), this.gEff)) this.gCur = { ...g };
    this.emit();
  }
  getG(key: string): number | boolean | string | undefined { return this.gCur[key] ?? this.gDefaults[key]; }
  effG(key: string): number | boolean | string | undefined { return this.gEff[key] ?? this.gDefaults[key]; }
  defG(key: string): number | boolean | string | undefined { return this.gDefaults[key]; }
  modifiedG(key: string): boolean { return this.getG(key) !== this.defG(key) || this.effG(key) !== this.defG(key); }
  setG(key: string, v: number | boolean | string): void {
    if (this.gCur[key] === v) return;
    this.gCur = { ...this.gCur, [key]: v };
    this.scheduleG();
  }
  replaceGraphics(next: GraphicsSettings): void {
    this.gCur = { ...next };
    this.scheduleG(true);
  }
  graphicsChanges(): number {
    let n = 0;
    for (const d of GRAPHICS_DEFS) if (this.effG(d.key) !== this.defG(d.key) || this.getG(d.key) !== this.defG(d.key)) n++;
    return n;
  }
  genChanges(): number { return Math.max(countChanges(this.eff), countChanges(normalizeSettings(this.cur))); }
  private scheduleG(now = false): void {
    this.gPending = true;
    this.emit();
    const fire = () => { this.gRaf = 0; this.gPending = false; this.sendG({ ...this.gCur }); };
    if (now) { if (this.gRaf) cancelAnimationFrame(this.gRaf); fire(); return; }
    if (this.gRaf) return;
    this.gRaf = requestAnimationFrame(fire);
  }

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
  changes(): number { return this.genChanges() + this.graphicsChanges(); }

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
    const g: Record<string, unknown> = {};
    for (const d of GRAPHICS_DEFS) if (this.effG(d.key) !== this.defG(d.key)) g[d.key] = this.effG(d.key);
    if (Object.keys(g).length) out.graphics = g;
    return JSON.stringify(out, null, 2);
  }

  /** JSON with only the non-default graphics values, as a plain object */
  graphicsJson(): string {
    const g: Record<string, unknown> = {};
    for (const d of GRAPHICS_DEFS) if (this.effG(d.key) !== this.defG(d.key)) g[d.key] = this.effG(d.key);
    return JSON.stringify(g, null, 2);
  }
  /** accepts a plain graphics object or the combined format with a top-level "graphics" key */
  parseGraphics(text: string): GraphicsSettings {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object like {"exposure": 0.8}.');
    let r = raw as Record<string, unknown>;
    if (r.graphics && typeof r.graphics === 'object' && !Array.isArray(r.graphics)) r = r.graphics as Record<string, unknown>;
    const known = new Set(GRAPHICS_DEFS.map((d) => d.key));
    const keys = Object.keys(r);
    if (keys.length && !keys.some((k) => known.has(k))) throw new Error(`No graphics settings in it (${keys.slice(0, 3).join(', ')}).`);
    return normalizeGraphics({ ...this.gDefaults, ...r });
  }

  /** parse pasted JSON on top of the defaults; throws with a readable message */
  parse(text: string): { gen: GenSettings; graphics: GraphicsSettings | null } {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object like {"regions": 5}.');
    const r = raw as Record<string, unknown>;
    const known = new Set<string>([...SETTING_DEFS.map((d) => d.key), 'items', 'graphics']);
    const unknown = Object.keys(r).filter((k) => !known.has(k));
    if (unknown.length === Object.keys(r).length && unknown.length) throw new Error(`No known settings in it (${unknown.slice(0, 3).join(', ')}).`);
    const next = defaultSettings();
    for (const d of SETTING_DEFS) if (d.key in r) (next as unknown as Record<string, unknown>)[d.key] = r[d.key];
    const items = r.items as Record<string, ItemSetting> | undefined;
    if (items && typeof items === 'object') for (const [id, v] of Object.entries(items)) if (v && typeof v === 'object') next.items[id] = { ...next.items[id], ...v };
    const g = r.graphics;
    const graphics = g && typeof g === 'object' && !Array.isArray(g) ? normalizeGraphics(g as Record<string, unknown>) : null;
    return { gen: next, graphics };
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

  destroy(): void { if (this.raf) cancelAnimationFrame(this.raf); if (this.gRaf) cancelAnimationFrame(this.gRaf); this.listeners.clear(); }
}
