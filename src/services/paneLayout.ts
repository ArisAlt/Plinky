import { SplitLayoutMode } from '../types/session';

// Which tab each split or grid pane shows. Panes used to show the first
// tabs in tab order, with the active tab borrowing the last pane when it
// wasn't among them. The terminal under the mouse becomes the active tab,
// so moving the mouse back to pane 1 took the borrowed tab out of pane 2
// again (owner: "when I select a tab with focus on the second terminal it
// changes to that tab; when it loses focus it goes back to the original").
// Now each pane keeps its tab until the user puts another one there.

/** Pane slots kept for every layout: the grid's four. */
export const PANE_SLOTS = 4;

export type PaneSlots = (string | null)[];

/** How many panes `mode` shows; 0 for the layouts with one terminal. */
export function paneCount(mode: SplitLayoutMode): number {
  if (mode === 'split-vertical' || mode === 'split-horizontal') return 2;
  if (mode === 'grid-4') return 4;
  return 0;
}

export interface PaneState {
  slots: PaneSlots;
  focused: number;
}

/**
 * The panes after the tabs or the active tab changed, for a layout of `n`
 * panes:
 * - a closed tab leaves its pane;
 * - the active tab, if no pane shows it, goes to the first empty pane, or
 *   else replaces the focused pane's tab (a tab picked from the tab bar, a
 *   new session);
 * - a pane still empty shows a tab no pane shows, in tab order;
 * - the focused pane is the one showing the active tab.
 */
export function assignPanes(
  slots: PaneSlots,
  focused: number,
  activeId: string | null,
  n: number,
  tabIds: string[],
): PaneState {
  const open = new Set(tabIds);
  const next: PaneSlots = Array.from({ length: PANE_SLOTS }, (_, i) => {
    const id = slots[i] ?? null;
    return id !== null && open.has(id) ? id : null;
  });
  // A tab in two visible panes keeps the first.
  for (let i = 0; i < n; i++) {
    const id = next[i];
    if (id !== null && next.slice(0, i).includes(id)) next[i] = null;
  }
  let f = Math.min(Math.max(0, focused), Math.max(0, n - 1));

  if (activeId !== null && open.has(activeId) && n > 0) {
    const at = next.slice(0, n).indexOf(activeId);
    if (at >= 0) {
      f = at;
    } else {
      // The focused pane if it's empty (its "Open a tab" was clicked), else
      // the first empty one, else the focused one.
      const empty = next.slice(0, n).indexOf(null);
      const target = next[f] === null ? f : empty >= 0 ? empty : f;
      next[target] = activeId;
      f = target;
    }
  }

  const shown = new Set(next.slice(0, n).filter((id): id is string => id !== null));
  const unseen = tabIds.filter(id => !shown.has(id));
  for (let i = 0; i < n; i++) {
    if (next[i] === null && unseen.length > 0) next[i] = unseen.shift()!;
  }
  return { slots: next, focused: f };
}

/** `id` put in pane `i`; if another visible pane showed it, the two swap. */
export function placeInPane(slots: PaneSlots, i: number, id: string, n: number): PaneSlots {
  const next = [...slots];
  while (next.length < PANE_SLOTS) next.push(null);
  const from = next.slice(0, n).indexOf(id);
  if (from === i) return next;
  if (from >= 0) next[from] = next[i];
  next[i] = id;
  return next;
}

export function samePanes(a: PaneState, b: PaneState): boolean {
  return a.focused === b.focused && a.slots.length === b.slots.length && a.slots.every((id, i) => id === b.slots[i]);
}
