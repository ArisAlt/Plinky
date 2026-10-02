import { describe, it, expect } from 'vitest';
import { fontSizeForKey, TERMINAL_FONT_DEFAULT, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from '../services/terminalFontKeys';

const key = (code: string, mods: Partial<KeyboardEventInit> = { ctrlKey: true, shiftKey: true }) =>
  new KeyboardEvent('keydown', { code, ...mods });

describe('terminal font size keys', () => {
  it('ctrl+shift+= and ctrl+shift+- step the terminal font by one pixel', () => {
    // They used to scale the whole interface (owner: change only the font).
    expect(fontSizeForKey(key('Equal'), 14)).toBe(15);
    expect(fontSizeForKey(key('NumpadAdd'), 14)).toBe(15);
    expect(fontSizeForKey(key('Minus'), 14)).toBe(13);
    expect(fontSizeForKey(key('NumpadSubtract'), 14)).toBe(13);
  });

  it('ctrl+shift+0 goes back to the default size', () => {
    expect(fontSizeForKey(key('Digit0'), 22)).toBe(TERMINAL_FONT_DEFAULT);
  });

  it('stays inside the sizes the terminal accepts', () => {
    expect(fontSizeForKey(key('Equal'), TERMINAL_FONT_MAX)).toBe(TERMINAL_FONT_MAX);
    expect(fontSizeForKey(key('Minus'), TERMINAL_FONT_MIN)).toBe(TERMINAL_FONT_MIN);
  });

  it('plain ctrl+- and ctrl+0 are left for the shell', () => {
    // readline and tmux users bind these; a terminal app must not take them.
    expect(fontSizeForKey(key('Minus', { ctrlKey: true }), 14)).toBeNull();
    expect(fontSizeForKey(key('Digit0', { ctrlKey: true }), 14)).toBeNull();
    expect(fontSizeForKey(key('Equal', { ctrlKey: true, shiftKey: true, altKey: true }), 14)).toBeNull();
  });
});

describe('in the app', () => {
  it('ctrl+shift+= grows the terminal font and leaves the interface size alone', async () => {
    const { render, screen, fireEvent, act } = await import('@testing-library/react');
    const { App } = await import('../App');
    const { getUiZoom, setUiZoom } = await import('../services/uiZoom');
    const React = await import('react');
    localStorage.setItem('plinky_terminal_font_size', '14');
    setUiZoom(1);
    render(React.createElement(App));
    await screen.findAllByText('Edge Gateway Router'); // the app is up
    act(() => { fireEvent.keyDown(window, { code: 'Equal', ctrlKey: true, shiftKey: true }); });
    act(() => { fireEvent.keyDown(window, { code: 'Equal', ctrlKey: true, shiftKey: true }); });
    expect(localStorage.getItem('plinky_terminal_font_size')).toBe('16');
    act(() => { fireEvent.keyDown(window, { code: 'Digit0', ctrlKey: true, shiftKey: true }); });
    expect(localStorage.getItem('plinky_terminal_font_size')).toBe(String(TERMINAL_FONT_DEFAULT));
    expect(getUiZoom()).toBe(1);
  });
});
