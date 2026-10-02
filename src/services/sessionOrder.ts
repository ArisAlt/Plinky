// The order of saved sessions inside each folder, set by dragging them.
// Folders hold their sessions sorted by name until the user drags one;
// from then on the folder keeps the dragged order. Sessions the order
// doesn't name yet (new ones) follow, by name.
//
// Kept beside the folder list in this page's storage, not in PuTTY's
// store: an order is a view preference, and writing it into every
// session file on each drag would rewrite PuTTY sessions for nothing.

import { rebasePath } from './folderTree';
export { applyOrder } from './folderTree';

const STORAGE_KEY = 'plinky_session_order_v1';

export type SessionOrder = Record<string, string[]>;

export function getSessionOrder(): SessionOrder {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(order: SessionOrder) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Storage unavailable: the order lasts until the next reload.
  }
}

/** `names` (as shown) with `name` moved before or after `target`. A
 *  `target` that isn't there, or is `name` itself, puts it at the end. */
export function placeName(names: string[], name: string, target: string | null, after: boolean): string[] {
  const rest = names.filter(n => n !== name);
  const at = target === null || target === name ? -1 : rest.indexOf(target);
  if (at < 0) return [...rest, name];
  rest.splice(after ? at + 1 : at, 0, name);
  return rest;
}

/** Puts session `name` into `folder` before or after `target`, given the
 *  folder's sessions as shown (`shown`), and takes it out of every other
 *  folder's order. */
export function placeSession(folder: string, shown: string[], name: string, target: string | null, after: boolean): void {
  const order = getSessionOrder();
  for (const key of Object.keys(order)) order[key] = order[key].filter(n => n !== name);
  order[folder] = placeName(shown, name, target, after);
  save(order);
}

/** Back to sorting `folder` by name. */
export function clearFolderOrder(folder: string): void {
  const order = getSessionOrder();
  delete order[folder];
  save(order);
}

export function hasFolderOrder(folder: string): boolean {
  return (getSessionOrder()[folder]?.length ?? 0) > 0;
}

/** A folder renamed or moved: its order, and its subfolders', follow it. */
export function rebaseFolderOrder(from: string, to: string): void {
  const order = getSessionOrder();
  const next: SessionOrder = {};
  for (const [key, names] of Object.entries(order)) next[rebasePath(key, from, to) ?? key] = names;
  save(next);
}
