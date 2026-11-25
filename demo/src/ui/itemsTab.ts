// Items tab: per-item settings (tools: on/off, when, where; consumables: capacity), with what each
// tool actually did in the current world next to its controls. Built once, synced in place.
import { ITEM_SETTING_DEFS } from '../core/settings';
import type { World } from '../core/types';
import { h } from './shared';
import type { Index } from './shared';
import { itemRow, type Row } from './settingRows';
import type { SettingsModel } from './settingsModel';
import type { TabCtx, TabView } from './tab';

export function createItemsTab(model: SettingsModel): TabView {
  const el = h('div', { class: 'pa-items' });
  const summary = h('p', { class: 'pa-items-sum pa-num', 'aria-live': 'polite' });
  const rows: Row[] = [];
  let built = false;
  let ctx: TabCtx | null = null;

  function build(c: TabCtx): void {
    const tools = ITEM_SETTING_DEFS.filter((d) => d.fields.includes('enabled'));
    const caps = ITEM_SETTING_DEFS.filter((d) => !d.fields.includes('enabled'));
    const mk = (defs: typeof ITEM_SETTING_DEFS) => {
      const box = h('div', { class: 'pa-item-list' });
      for (const d of defs) {
        const r = itemRow(model, d, 'it', c.world, { focusLoc: (l) => ctx?.cb.focusLoc(l) });
        rows.push(r);
        box.append(r.el);
      }
      return box;
    };
    el.append(
      summary,
      h('h3', { class: 'pa-label pa-sec-t' }, 'Tools and skills'),
      h('p', { class: 'pa-note' }, 'Each tool opens one kind of gate. “When” biases where it lands in the progression, “Where” whether it can be a dungeon treasure. The lines under each show what happened in this world.'),
      mk(tools),
      h('h3', { class: 'pa-label pa-sec-t' }, 'Ammo and wallets'),
      mk(caps));
    built = true;
  }

  function sync(): void {
    if (!built || !ctx) return;
    for (const r of rows) r.sync(ctx.world, ctx.ix);
    summary.textContent = summarize(ctx.world, ctx.ix, model);
  }
  model.onChange(sync);

  return {
    el,
    keepScroll: true,
    render(c) { ctx = c; if (!built) build(c); sync(); },
    match: () => [],
  };
}

function summarize(w: World, ix: Index, model: SettingsModel): string {
  const toolIds = ITEM_SETTING_DEFS.filter((d) => d.fields.includes('enabled')).map((d) => d.id);
  const on = toolIds.filter((id) => model.effItem(id, 'enabled') !== false);
  const elder = w.npcs.find((n) => n.id === 'elder');
  const gifts = (elder?.stages[0]?.offers ?? []).map((c) => ix.check.get(c)?.item).filter((it): it is string => !!it && toolIds.includes(it));
  const dungeonsWithTool = new Set<string>();
  for (const c of w.graph.checks) {
    if (!toolIds.includes(c.item)) continue;
    for (let n = ix.locNode.get(c.loc); n; n = ix.parent.get(n.id)) {
      if (n.meta.placeKind === 'dungeon') { dungeonsWithTool.add(n.id); break; }
    }
  }
  const nd = dungeonsWithTool.size;
  return `${on.length} of ${toolIds.length} tools enabled · ${gifts.length} handed over at the start · ${nd} dungeon${nd === 1 ? '' : 's'} hold${nd === 1 ? 's' : ''} a tool`;
}
