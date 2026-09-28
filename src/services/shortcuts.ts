// Keyboard shortcuts. Bare Ctrl+letters belong to the device (Ctrl+C stops
// a command on a router, Ctrl+V is the shell's literal-next), so the
// terminal's own shortcuts use Ctrl+Shift, plus PuTTY's Ctrl+Insert and
// Shift+Insert.
//
// Matched on the physical key (KeyboardEvent.code), not the character: with
// a Greek layout the C key types "ψ", and a check on e.key never fires.

type KeyInfo = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

export type TerminalShortcut = 'copy' | 'paste' | 'selectAll';

export function terminalShortcut(e: KeyInfo): TerminalShortcut | null {
  if (e.altKey || e.metaKey) return null;
  if (e.ctrlKey && e.shiftKey) {
    if (e.code === 'KeyC') return 'copy';
    if (e.code === 'KeyV') return 'paste';
    if (e.code === 'KeyA') return 'selectAll';
    return null;
  }
  if (e.code === 'Insert') {
    if (e.ctrlKey) return 'copy';
    if (e.shiftKey) return 'paste';
  }
  return null;
}

export type AppShortcut = 'nextTab' | 'prevTab' | 'newTab' | 'closeTab';

export function appShortcut(e: KeyInfo): AppShortcut | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.code === 'Tab') return e.shiftKey ? 'prevTab' : 'nextTab';
  if (!e.shiftKey) return null;
  if (e.code === 'KeyT') return 'newTab';
  if (e.code === 'KeyW') return 'closeTab';
  return null;
}

/** The list Settings shows. Keep it in step with the handlers above and
 *  with the ones that already existed (search, prompts, broadcast bar). */
export const SHORTCUT_LIST: { keys: string[]; action: string }[] = [
  { keys: ['Ctrl+Shift+C', 'Ctrl+Insert'], action: 'Copy the selection' },
  { keys: ['Ctrl+Shift+V', 'Shift+Insert'], action: 'Paste' },
  { keys: ['Ctrl+Shift+A'], action: 'Select all' },
  { keys: ['Ctrl+F'], action: 'Find in the terminal' },
  { keys: ['Shift+PgUp', 'Shift+PgDn'], action: 'Scroll back and forward' },
  { keys: ['Ctrl+↑', 'Ctrl+↓'], action: 'Jump to the previous or next command' },
  { keys: ['Ctrl+Tab', 'Ctrl+Shift+Tab'], action: 'Next or previous tab' },
  { keys: ['Ctrl+Shift+T'], action: 'Open a tab' },
  { keys: ['Ctrl+Shift+W'], action: 'Close the tab' },
  { keys: ['Ctrl+Shift+O'], action: 'Search sessions' },
  { keys: ['Ctrl+Shift+B'], action: 'Show or hide the broadcast bar' },
  { keys: ['Ctrl+Shift+=', 'Ctrl+Shift+-'], action: 'Make the interface larger or smaller' },
  { keys: ['Ctrl+Shift+0'], action: 'Reset the interface size' },
];
