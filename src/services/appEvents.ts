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
