// Graphics tab: how the map is drawn. Built generically from GRAPHICS_DEFS; never regenerates the world.
import { SETTING_DEFS, ITEM_SETTING_DEFS } from '../core/settings';
import { GRAPHICS_DEFS, defaultGraphics } from '../render/graphics';
import { graphicsRow, settingText, itemText, matches } from './settingRows';
import { createConfigTab, type ConfigTab } from './configTab';
import type { SettingsModel } from './settingsModel';

export function createGraphicsTab(model: SettingsModel, jumpTo: (query: string) => void): ConfigTab {
  return createConfigTab({
    id: 'pa-gfx',
    intro: 'Graphics only change how the map is drawn. They apply instantly; the world stays the same.',
    searchPlaceholder: 'Search graphics',
    needsWorld: false,
    build(_ctx, mk) {
      const names: string[] = [];
      for (const d of GRAPHICS_DEFS) if (!names.includes(d.group)) names.push(d.group);
      for (const name of names) {
        const g = mk(name);
        for (const d of GRAPHICS_DEFS.filter((x) => x.group === name)) g.rows.push(graphicsRow(model, d, GRAPHICS_DEFS, 'sg'));
      }
    },
    changes: () => model.graphicsChanges(),
    resetLabel: 'Reset graphics',
    resetTitle: 'Reset every graphics setting (the world is not touched)',
    reset() {
      const prev = { ...model.gCur };
      model.replaceGraphics(defaultGraphics());
      return () => model.replaceGraphics(prev);
    },
    copyLabel: 'Copy graphics',
    copyJson: () => model.graphicsJson(),
    importLabel: 'Paste graphics JSON',
    importPlaceholder: '{"exposure": 0.8, "bloom": 0.5}',
    importJson(text) {
      model.replaceGraphics(model.parseGraphics(text));
      return 'Imported graphics. Values out of range were clamped.';
    },
    other: {
      label: 'Settings',
      count: (words, ctx) =>
        SETTING_DEFS.filter((d) => matches(settingText(d), words)).length +
        ITEM_SETTING_DEFS.filter((d) => matches(itemText(d, ctx?.world ?? null), words)).length,
      jump: jumpTo,
    },
    onSubscribe: (fn) => { model.onChange(fn); },
  });
}
