import { describe, it, expect } from 'vitest';
import { shouldTakeHoverFocus } from '../services/hoverFocus';

const el = (html: string) => {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.appendChild(box);
  return box.firstElementChild as HTMLElement;
};

describe('focus follows the mouse into a terminal', () => {
  it('takes focus from nothing, or from another terminal', () => {
    expect(shouldTakeHoverFocus(0, document.body, false)).toBe(true);
    expect(shouldTakeHoverFocus(0, null, false)).toBe(true);
    expect(shouldTakeHoverFocus(0, el('<textarea class="xterm-helper-textarea"></textarea>'), false)).toBe(true);
    expect(shouldTakeHoverFocus(0, el('<button>Split</button>'), false)).toBe(true);
  });

  it('never takes it from something being typed into', () => {
    expect(shouldTakeHoverFocus(0, el('<input aria-label="Broadcast command">'), false)).toBe(false);
    expect(shouldTakeHoverFocus(0, el('<textarea></textarea>'), false)).toBe(false);
    expect(shouldTakeHoverFocus(0, el('<select><option>A</option></select>'), false)).toBe(false);
  });

  it('not mid-drag, and not while a host-key question waits in that pane', () => {
    expect(shouldTakeHoverFocus(1, document.body, false)).toBe(false);
    expect(shouldTakeHoverFocus(0, document.body, true)).toBe(false);
  });
});
