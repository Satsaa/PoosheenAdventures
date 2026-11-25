import type { ItemDef, ItemId, Phase, Req } from './types';

/** The item that sets the time of day at will. */
export const TIME_ITEM = 'sundial';

export const NONE: Req = { t: 'none' };
export const has = (item: ItemId, n?: number): Req => (n && n > 1 ? { t: 'has', item, n } : { t: 'has', item });
export const use = (item: ItemId, n?: number): Req => (n && n > 1 ? { t: 'use', item, n } : { t: 'use', item });
export const at = (phase: Phase): Req => ({ t: 'time', phase });

export function all(...of: Req[]): Req {
  const flat = of.flatMap((r) => (r.t === 'all' ? r.of : r.t === 'none' ? [] : [r]));
  return flat.length === 0 ? NONE : flat.length === 1 ? flat[0] : { t: 'all', of: flat };
}
export function any(...of: Req[]): Req {
  if (of.some((r) => r.t === 'none')) return NONE;
  const flat = of.flatMap((r) => (r.t === 'any' ? r.of : [r]));
  return flat.length === 1 ? flat[0] : { t: 'any', of: flat };
}

/** What the solver knows at a point in time. */
export interface Caps {
  inv: Map<ItemId, number>;
  /** consumables with an owned container and a reachable source */
  renewable: Set<ItemId>;
  /** time passes on its own in this world, so any time of day can simply be waited for */
  anyTime?: boolean;
}

export function capacity(items: Record<ItemId, ItemDef>, inv: Map<ItemId, number>, item: ItemId): number {
  const def = items[item];
  if (!def) return 0;
  if (def.container && !inv.get(def.container)) return 0;
  let cap = def.baseCap ?? 0;
  for (const u of def.upgrades ?? []) if (inv.get(u.item)) cap = Math.max(cap, u.cap);
  return cap;
}

export function evalReq(req: Req, caps: Caps, items: Record<ItemId, ItemDef>): boolean {
  switch (req.t) {
    case 'none':
      return true;
    case 'has':
      return (caps.inv.get(req.item) ?? 0) >= (req.n ?? 1);
    case 'use':
      return caps.renewable.has(req.item) && capacity(items, caps.inv, req.item) >= (req.n ?? 1);
    case 'time':
      return !!caps.anyTime || (caps.inv.get(TIME_ITEM) ?? 0) > 0;
    case 'all':
      return req.of.every((r) => evalReq(r, caps, items));
    case 'any':
      return req.of.some((r) => evalReq(r, caps, items));
  }
}

/**
 * Like evalReq, but for this very moment: a time requirement only holds if it is that time of
 * day right now. evalReq answers "can the player ever meet this", openNow "is it met as we speak".
 */
export function openNow(req: Req, caps: Caps, items: Record<ItemId, ItemDef>, phase: Phase): boolean {
  switch (req.t) {
    case 'time':
      return req.phase === phase;
    case 'all':
      return req.of.every((r) => openNow(r, caps, items, phase));
    case 'any':
      return req.of.some((r) => openNow(r, caps, items, phase));
    default:
      return evalReq(req, caps, items);
  }
}

/** Every item id mentioned anywhere in the requirement. */
export function reqItems(req: Req, out: Set<ItemId> = new Set()): Set<ItemId> {
  if (req.t === 'has' || req.t === 'use') out.add(req.item);
  else if (req.t === 'time') out.add(TIME_ITEM);
  else if (req.t === 'all' || req.t === 'any') for (const r of req.of) reqItems(r, out);
  return out;
}

export function fmtReq(req: Req, items: Record<ItemId, ItemDef>): string {
  const name = (id: ItemId) => items[id]?.name ?? id;
  switch (req.t) {
    case 'none':
      return 'free';
    case 'has':
      return req.n && req.n > 1 ? `${req.n}× ${name(req.item)}` : name(req.item);
    case 'use':
      return req.n && req.n > 1 ? `spend ${req.n} ${name(req.item)}` : `spend ${name(req.item)}`;
    case 'time':
      return req.phase === 'night' ? 'at night' : 'by day';
    case 'all':
      return req.of.map((r) => (r.t === 'any' ? `(${fmtReq(r, items)})` : fmtReq(r, items))).join(' + ');
    case 'any':
      return req.of.map((r) => (r.t === 'all' ? `(${fmtReq(r, items)})` : fmtReq(r, items))).join(' or ');
  }
}
