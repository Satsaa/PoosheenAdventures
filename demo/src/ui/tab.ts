import type { World } from '../core/types';
import type { WorldState } from '../core/view';
import type { PanelCallbacks } from './panels';
import type { Index, Selection } from './shared';

export interface TabCtx {
  world: World;
  state: WorldState;
  ix: Index;
  cb: PanelCallbacks;
  /** ask the panel to re-render this tab (after a local toggle) */
  rerender(): void;
}

export interface TabView {
  /** content root, mounted into the scrolling tab body */
  el: HTMLElement;
  render(ctx: TabCtx): void;
  /** elements that relate to the selection, in priority order (first is scrolled to) */
  match(sel: Selection, ctx: TabCtx): Element[];
  /** before matching: make sure the matches are visible (expand collapsed rows) */
  reveal?(sel: Selection, ctx: TabCtx): boolean;
  /** after a sphere change: element to bring into view */
  onState?(ctx: TabCtx): Element | null;
  destroy?(): void;
}
