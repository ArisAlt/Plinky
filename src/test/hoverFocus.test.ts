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

  it('never takes it from a dialog or a menu, buttons included', () => {
    // Moving the mouse over a terminal behind the paste window must not
    // take Enter away from its Paste button.
    expect(shouldTakeHoverFocus(0, el('<div role="dialog"><button>Paste</button></div>').querySelector('button'), false)).toBe(false);
    expect(shouldTakeHoverFocus(0, el('<div role="menu"><button>Copy</button></div>').querySelector('button'), false)).toBe(false);
    expect(shouldTakeHoverFocus(0, el('<div aria-modal="true"><button>OK</button></div>').querySelector('button'), false)).toBe(false);
    // A button elsewhere (the tab bar, the session list) does let it go.
    expect(shouldTakeHoverFocus(0, el('<button>New session</button>'), false)).toBe(true);
  });

  it('not mid-drag, and not while a host-key question waits in that pane', () => {
    expect(shouldTakeHoverFocus(1, document.body, false)).toBe(false);
    expect(shouldTakeHoverFocus(0, document.body, true)).toBe(false);
  });
});
