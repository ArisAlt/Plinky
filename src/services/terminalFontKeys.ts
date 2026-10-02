// Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0: the terminal's font size,
// as in other terminals. They used to scale the whole interface, which the
// owner didn't want from a key: the session list, tabs and dialogs grew
// with the text. Interface size is now set in Settings only.

export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 14;

const clamp = (n: number) => Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, n));

/** The font size a key asks for, or null when the key isn't one of these.
 *  Shift keeps plain Ctrl+- and Ctrl+0 for the shell, where readline and
 *  tmux users bind them. */
export function fontSizeForKey(e: KeyboardEvent, current: number): number | null {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return clamp(current + 1);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return clamp(current - 1);
  if (e.code === 'Digit0' || e.code === 'Numpad0') return TERMINAL_FONT_DEFAULT;
  return null;
}
