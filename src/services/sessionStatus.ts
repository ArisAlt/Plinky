import { TerminalTab } from '../types/session';

// One meaning for every status dot. The sidebar's dot was green whenever a
// tab was open, connecting, dead or cancelled alike, while the pane's dot
// told the truth: a scan of the tree read a dead router as up.
export const STATUS_DOT: Record<TerminalTab['status'], string> = {
  connecting: 'bg-amber-400 animate-pulse',
  preauth: 'bg-amber-400',
  live: 'bg-emerald-400',
  disconnected: 'bg-rose-500',
};

export const STATUS_TEXT: Record<TerminalTab['status'], string> = {
  connecting: 'Connecting',
  preauth: 'Waiting for login',
  live: 'Connected',
  disconnected: 'Disconnected',
};

const RANK: Record<TerminalTab['status'], number> = { live: 3, preauth: 2, connecting: 1, disconnected: 0 };

/** A session open in several tabs shows its best one: up if any is up. */
export function bestStatus(tabs: Pick<TerminalTab, 'status'>[]): TerminalTab['status'] | null {
  if (tabs.length === 0) return null;
  return tabs.reduce((a, t) => (RANK[t.status] > RANK[a.status] ? t : a)).status;
}
