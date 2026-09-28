import { describe, it, expect } from 'vitest';
import { terminalShortcut, appShortcut, SHORTCUT_LIST } from '../services/shortcuts';

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
