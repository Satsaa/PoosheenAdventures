// Settings tab: searchable generation settings (+ item settings in search results).
import { SETTING_DEFS, ITEM_SETTING_DEFS, defaultSettings } from '../core/settings';
import { GRAPHICS_DEFS } from '../render/graphics';
import { settingRow, itemRow, setLabelSource, graphicsText, matches } from './settingRows';
import { createConfigTab, type ConfigTab } from './configTab';
import type { SettingsModel } from './settingsModel';

export function createSettingsTab(model: SettingsModel, jumpTo: (query: string) => void): ConfigTab {
  setLabelSource(SETTING_DEFS);
  return createConfigTab({
    id: 'pa-set',
    intro: 'Generation settings change the world: every change regenerates this seed. How it is drawn lives in the Graphics tab.',
    searchPlaceholder: 'Search settings and items',
    needsWorld: true,
    build(ctx, mk) {
      const names: string[] = [];
      for (const d of SETTING_DEFS) if (!names.includes(d.group)) names.push(d.group);
      for (const name of names) {
        const g = mk(name);
        for (const d of SETTING_DEFS.filter((x) => x.group === name)) g.rows.push(settingRow(model, d, 's'));
      }
      const gi = mk('Items', true);
      for (const d of ITEM_SETTING_DEFS) gi.rows.push(itemRow(model, d, 'si', ctx!.world, { focusLoc: (l) => ctx?.cb.focusLoc(l) }));
    },
    changes: () => model.genChanges(),
    resetLabel: 'Reset all',
    resetTitle: 'Reset every generation and item setting (graphics are kept)',
    reset() {
      const prev = JSON.parse(JSON.stringify(model.cur));
      model.replace(defaultSettings());
      return () => model.replace(prev);
    },
    copyLabel: 'Copy settings',
    copyJson: () => model.diffJson(),
    importLabel: 'Paste settings JSON',
    importPlaceholder: '{"regions": 5, "items": {"sword": {"order": "start"}}}',
    importJson(text) {
      const next = model.parse(text);
      model.replace(next.gen);
      if (next.graphics) model.replaceGraphics(next.graphics);
      return next.graphics ? 'Imported settings and graphics. Values out of range were clamped.' : 'Imported. Values out of range were clamped.';
    },
    other: {
      label: 'Graphics',
      count: (words) => GRAPHICS_DEFS.filter((d) => matches(graphicsText(d), words)).length,
      jump: jumpTo,
    },
    onSubscribe: (fn) => { model.onChange(fn); },
  });
}
