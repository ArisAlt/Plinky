/**
 * Whether a terminal the mouse just moved into should take the keyboard
 * focus. Focus follows the mouse between terminals (a split or grid pane
 * can be typed into without a click), but never away from something the
 * user is typing into -- the broadcast bar, a search box, a dialog field --
 * and never in the middle of a drag, such as a text selection that crosses
 * into another pane.
 */
export function shouldTakeHoverFocus(
  buttonsHeld: number,
  focused: Element | null,
  promptPending: boolean,
): boolean {
  if (buttonsHeld !== 0 || promptPending) return false;
  if (!focused || focused === focused.ownerDocument?.body) return true;
  // Another terminal: xterm types through its hidden helper textarea.
  if (focused.classList.contains('xterm-helper-textarea')) return true;
  const el = focused as HTMLElement;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
  return !typing;
}
