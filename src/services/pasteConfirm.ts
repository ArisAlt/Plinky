// Confirming a paste before it reaches the device. A multi-line paste into
// a router's console runs every line as a command the moment it lands, and
// the clipboard does not always hold what you think it does. The paste
// window shows the exact text first, and lets you fix it or back out.
import { useEffect, useState } from 'react';
import { isMultiLinePaste } from './appEvents';

/** When the paste window appears. */
export type PasteConfirmMode = 'multiline' | 'always' | 'never';
export const DEFAULT_PASTE_CONFIRM: PasteConfirmMode = 'multiline';

const KEY = 'plinky_paste_confirm';
const EVENT = 'plinky:paste-confirm';

export function getPasteConfirmMode(): PasteConfirmMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'multiline' || v === 'always' || v === 'never') return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_PASTE_CONFIRM;
}

export function setPasteConfirmMode(mode: PasteConfirmMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* not remembered */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
}

export function usePasteConfirmMode(): PasteConfirmMode {
  const [mode, setMode] = useState(getPasteConfirmMode);
  useEffect(() => {
    const on = (e: Event) => setMode((e as CustomEvent<PasteConfirmMode>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return mode;
}

export function needsPasteConfirm(text: string, mode: PasteConfirmMode = getPasteConfirmMode()): boolean {
  if (!text || mode === 'never') return false;
  return mode === 'always' || isMultiLinePaste(text);
}

/** Lines as the device receives them: one final line break ends the last
 *  line, it does not start another. */
export function pasteLineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length;
}

/** The last line runs as soon as it lands. */
export const endsWithLineBreak = (text: string) => /[\r\n]$/.test(text);

export interface PasteRequest {
  text: string;
  /** The tab it goes to. */
  target: string;
  /** The session's paste line delay, when it paces multi-line pastes. */
  lineDelayMs?: number;
  /** At a password prompt: masked until the user asks to see it. */
  sensitive?: boolean;
}

type Pending = PasteRequest & { resolve: (text: string | null) => void };
type Listener = (req: Pending) => void;

let listener: Listener | null = null;

/** Called by PasteConfirmHost; returns its unsubscribe. */
export function setPasteConfirmListener(l: Listener): () => void {
  listener = l;
  return () => { if (listener === l) listener = null; };
}

/** Resolves with the text to paste (possibly edited), or null to cancel. */
export function askPaste(req: PasteRequest): Promise<string | null> {
  // No host (a component rendered on its own, as in a unit test): the
  // browser's dialog is the only one there is.
  if (!listener) {
    const lines = pasteLineCount(req.text);
    return Promise.resolve(window.confirm(`Paste ${lines} line${lines === 1 ? '' : 's'} into ${req.target}?`) ? req.text : null);
  }
  return new Promise(resolve => listener!({ ...req, resolve }));
}
