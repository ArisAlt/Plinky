/**
 * Window events between parts of the UI that don't share state.
 */

/**
 * The session editor saved a session. Carries the settings open terminals
 * apply without being reopened, so they don't have to re-read the session
 * file -- which may not be written yet when the event fires.
 */
export const SESSION_SAVED_EVENT = 'plinky:session-saved';

export interface SessionSavedDetail {
  name: string;
  /** 0 = paste normally. */
  pasteLineDelayMs: number;
  /** Reconnect by itself when the connection drops. */
  autoReconnect: boolean;
}

/** Highest line delay the backend accepts (paste.rs MAX_LINE_DELAY_MS). */
export const MAX_PASTE_LINE_DELAY_MS = 5000;

/** The session's paste line delay from its PuTTY `extra` keys, clamped. */
export function pasteLineDelayFrom(extra: Record<string, string> | undefined): number {
  const ms = parseInt(extra?.PlinkyPasteLineDelayMs ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_PASTE_LINE_DELAY_MS) : 0;
}

/** More than one line to send: a trailing newline alone doesn't count. */
export function isMultiLinePaste(text: string): boolean {
  return /[\r\n]/.test(text.replace(/[\r\n]+$/, ''));
}

/**
 * Seconds between keepalives. PuTTY adds its two keys together --
 * PingInterval (minutes, the old setting) and PingIntervalSecs -- so read
 * them the same way.
 */
export function keepaliveSecondsFrom(extra: Record<string, string> | undefined): number {
  const n = (k: string) => {
    const v = parseInt(extra?.[k] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return n('PingInterval') * 60 + n('PingIntervalSecs');
}

/** The keys PuTTY itself writes for a keepalive interval: minutes + remainder. */
export function keepaliveKeys(seconds: number): { PingInterval: string; PingIntervalSecs: string } {
  const s = Math.max(0, Math.floor(seconds) || 0);
  return { PingInterval: String(Math.floor(s / 60)), PingIntervalSecs: String(s % 60) };
}

/** Waits between automatic reconnect attempts, in seconds; then it stops. */
export const RECONNECT_DELAYS_S = [2, 4, 8, 16, 30];
