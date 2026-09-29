import { describe, it, expect } from 'vitest';
import { terminalShortcut, appShortcut, keySequenceFor, SHORTCUT_LIST } from '../services/shortcuts';

const key = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe('terminal shortcuts', () => {
  it('copies with Ctrl+Shift+C and PuTTY\'s Ctrl+Insert', () => {
    expect(terminalShortcut(key('KeyC', { ctrl: true, shift: true }))).toBe('copy');
    expect(terminalShortcut(key('Insert', { ctrl: true }))).toBe('copy');
  });

  it('pastes with Ctrl+Shift+V and PuTTY\'s Shift+Insert', () => {
    expect(terminalShortcut(key('KeyV', { ctrl: true, shift: true }))).toBe('paste');
    expect(terminalShortcut(key('Insert', { shift: true }))).toBe('paste');
  });

  it('selects all with Ctrl+Shift+A', () => {
    expect(terminalShortcut(key('KeyA', { ctrl: true, shift: true }))).toBe('selectAll');
  });

  it('leaves Ctrl+C and Ctrl+V to the device, as PuTTY does', () => {
    // Ctrl+C stops a command on a router; taking it for copy would lose that.
    expect(terminalShortcut(key('KeyC', { ctrl: true }))).toBeNull();
    expect(terminalShortcut(key('KeyV', { ctrl: true }))).toBeNull();
    expect(terminalShortcut(key('KeyA', { ctrl: true }))).toBeNull();
  });

  it('matches the key position, so a Greek layout works too', () => {
    // On a Greek layout the C key reports e.key "ψ"; e.code is still KeyC.
    const greek = { ...key('KeyC', { ctrl: true, shift: true }), key: 'Ψ' };
    expect(terminalShortcut(greek)).toBe('copy');
  });

  it('ignores Alt and the Windows/Command key combinations', () => {
    expect(terminalShortcut(key('KeyV', { ctrl: true, shift: true, alt: true }))).toBeNull();
    expect(terminalShortcut(key('Insert', { shift: true, meta: true }))).toBeNull();
    expect(terminalShortcut(key('Insert'))).toBeNull();
  });
});

describe('app shortcuts', () => {
  it('switches tabs with Ctrl+Tab and Ctrl+Shift+Tab', () => {
    expect(appShortcut(key('Tab', { ctrl: true }))).toBe('nextTab');
    expect(appShortcut(key('Tab', { ctrl: true, shift: true }))).toBe('prevTab');
  });

  it('opens and closes tabs with Ctrl+Shift+T and Ctrl+Shift+W', () => {
    expect(appShortcut(key('KeyT', { ctrl: true, shift: true }))).toBe('newTab');
    expect(appShortcut(key('KeyW', { ctrl: true, shift: true }))).toBe('closeTab');
  });

  it('leaves bare Ctrl+T and Ctrl+W to the shell', () => {
    // Ctrl+W deletes the word before the cursor in bash and on Cisco IOS.
    expect(appShortcut(key('KeyW', { ctrl: true }))).toBeNull();
    expect(appShortcut(key('KeyT', { ctrl: true }))).toBeNull();
    expect(appShortcut(key('Tab'))).toBeNull();
  });
});

describe('the list in Settings', () => {
  it('names every shortcut the handlers take', () => {
    const listed = SHORTCUT_LIST.flatMap(s => s.keys);
    for (const k of ['Ctrl+Shift+C', 'Ctrl+Insert', 'Ctrl+Shift+V', 'Shift+Insert', 'Ctrl+Shift+A',
      'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Shift+T', 'Ctrl+Shift+W']) {
      expect(listed).toContain(k);
    }
  });
});

describe('keys sent as PuTTY sends them', () => {
  const press = (keyName: string, code: string, mods: Parameters<typeof key>[1] = {}) => ({ ...key(code, mods), key: keyName });

  it('Home and End send ESC [1~ and ESC [4~, PuTTY\'s "Standard"', () => {
    // xterm.js sends ESC [H and ESC [F (end-to-end suite).
    expect(keySequenceFor(press('Home', 'Home'), false)).toBe('\x1b[1~');
    expect(keySequenceFor(press('End', 'End'), false)).toBe('\x1b[4~');
    // The keypad's, with Num Lock off.
    expect(keySequenceFor(press('Home', 'Numpad7'), false)).toBe('\x1b[1~');
  });

  it('F1 to F4 send ESC [11~ to ESC [14~, PuTTY\'s "ESC[n~"', () => {
    expect(['F1', 'F2', 'F3', 'F4'].map((f) => keySequenceFor(press(f, f), false)))
      .toEqual(['\x1b[11~', '\x1b[12~', '\x1b[13~', '\x1b[14~']);
    // F5 and up already match: left to xterm.js.
    expect(keySequenceFor(press('F5', 'F5'), false)).toBeNull();
  });

  it('a local shell keeps xterm\'s keys, which its TERM expects', () => {
    expect(keySequenceFor(press('Home', 'Home'), true)).toBeNull();
    expect(keySequenceFor(press('F1', 'F1'), true)).toBeNull();
  });

  it('with a modifier held, the key is left to xterm.js', () => {
    expect(keySequenceFor(press('Home', 'Home', { ctrl: true }), false)).toBeNull();
    expect(keySequenceFor(press('F1', 'F1', { shift: true }), false)).toBeNull();
  });

  it('Ctrl+Shift+6 sends Ctrl+^, the key Cisco\'s escape sequence starts with', () => {
    // "Ctrl+Shift+6, x" stops a ping or traceroute on IOS. xterm.js sends
    // 0x1e for Ctrl+6 but nothing with Shift held (end-to-end suite); PuTTY
    // sends 0x1e.
    expect(keySequenceFor(press('^', 'Digit6', { ctrl: true, shift: true }), false)).toBe('\x1e');
    expect(keySequenceFor(press('^', 'Digit6', { ctrl: true, shift: true }), true)).toBe('\x1e');
  });

  it('leaves every other key to xterm.js', () => {
    expect(keySequenceFor(press('6', 'Digit6', { ctrl: true }), false)).toBeNull();
    expect(keySequenceFor(press('^', 'Digit6', { shift: true }), false)).toBeNull();
    expect(keySequenceFor(press('^', 'Digit6', { ctrl: true, shift: true, alt: true }), false)).toBeNull();
    expect(keySequenceFor(press('V', 'KeyV', { ctrl: true, shift: true }), false)).toBeNull();
    expect(keySequenceFor(press('Delete', 'Delete'), false)).toBeNull();
  });
});
