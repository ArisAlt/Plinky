import { useEffect, useState } from 'react';

/**
 * Sync broadcast helpers (T-012): the broadcast bar's command history, and
 * the event that lights up the panes a broadcast actually reached.
 */

/**
 * A broadcast went out. `ids` are the tabs (session ids) that received it,
 * as the backend reports them -- a tab on the channel that was skipped
 * (protected, still logging in) is not among them and must not light up.
 */
export const BROADCAST_SENT_EVENT = 'plinky:broadcast-sent';

export interface BroadcastSentDetail {
  ids: string[];
}

export function announceBroadcast(ids: string[]) {
  window.dispatchEvent(new CustomEvent<BroadcastSentDetail>(BROADCAST_SENT_EVENT, { detail: { ids } }));
}

/** How long a receiving pane or tab stays lit. */
export const GLOW_MS = 1200;

/** Glow colour for a pane, by its sync channel (matches the channel badges). */
export function glowColor(channel: string): string {
  switch (channel) {
    case 'A': return '#22d3ee';
    case 'B': return '#34d399';
    case 'C': return '#fbbf24';
    case 'D': return '#fb7185';
    default: return '#818cf8'; // reached only by ALL TABS
  }
}

/** The ids lit by the latest broadcast; each clears GLOW_MS after it was sent. */
export function useBroadcastGlow(): ReadonlySet<string> {
  const [lit, setLit] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSent = (e: Event) => {
      const ids = (e as CustomEvent<BroadcastSentDetail>).detail?.ids ?? [];
      if (ids.length === 0) return;
      setLit(new Set(ids));
      clearTimeout(timer);
      timer = setTimeout(() => setLit(new Set()), GLOW_MS);
    };
    window.addEventListener(BROADCAST_SENT_EVENT, onSent);
    return () => {
      window.removeEventListener(BROADCAST_SENT_EVENT, onSent);
      clearTimeout(timer);
    };
  }, []);
  return lit;
}

/** Commands kept per app run. */
export const MAX_HISTORY = 100;

/**
 * Up/Down recall for the broadcast bar, the way a shell does it: Up walks
 * back through what was sent, Down walks forward, and stepping past the
 * newest brings back what was being typed before Up was pressed.
 *
 * Kept in memory only, never in localStorage. What gets broadcast to
 * network gear includes config lines like "username admin secret ...";
 * localStorage would write those to disk in plain text.
 */
export class CommandHistory {
  private items: string[] = [];
  private pos = 0;
  private draft = '';

  get entries(): readonly string[] {
    return this.items;
  }

  /** Record a sent command. Blank lines and an immediate repeat are skipped. */
  push(cmd: string) {
    if (cmd.trim() && this.items[this.items.length - 1] !== cmd) {
      this.items.push(cmd);
      if (this.items.length > MAX_HISTORY) this.items.shift();
    }
    this.pos = this.items.length;
    this.draft = '';
  }

  clear() {
    this.items = [];
    this.pos = 0;
    this.draft = '';
  }

  /** The older entry to show, or null when there's nothing to go back to. */
  up(current: string): string | null {
    if (this.items.length === 0) return null;
    if (this.pos >= this.items.length) this.draft = current;
    if (this.pos > 0) this.pos--;
    return this.items[this.pos];
  }

  /** The newer entry to show, the saved draft past the newest, or null when not browsing. */
  down(): string | null {
    if (this.pos >= this.items.length) return null;
    this.pos++;
    return this.pos === this.items.length ? this.draft : this.items[this.pos];
  }
}

/** Module-level so it survives the bar re-rendering or remounting. */
export const broadcastHistory = new CommandHistory();
