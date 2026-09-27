import { describe, it, expect, beforeEach } from 'vitest';
import { handleZoomKey, getUiZoom, setUiZoom, UI_ZOOM_MAX, UI_ZOOM_MIN } from '../services/uiZoom';

const key = (code: string, mods: Partial<KeyboardEventInit> = { ctrlKey: true, shiftKey: true }) =>
  new KeyboardEvent('keydown', { code, cancelable: true, ...mods });

describe('interface size', () => {
  beforeEach(() => setUiZoom(1));

  it('ctrl+shift+= and ctrl+shift+- step the size by ten percent and persist it', () => {
    expect(handleZoomKey(key('Equal'))).toBe(true);
    expect(getUiZoom()).toBe(1.1);
    expect(localStorage.getItem('plinky_ui_zoom')).toBe('1.1');
    handleZoomKey(key('Minus'));
    handleZoomKey(key('Minus'));
    expect(getUiZoom()).toBe(0.9);
  });

  it('ctrl+shift+0 resets to 100 percent', () => {
    setUiZoom(1.3);
    handleZoomKey(key('Digit0'));
    expect(getUiZoom()).toBe(1);
  });

  it('plain ctrl+- and ctrl+0 are left for the shell', () => {
    // readline and tmux users bind these; a terminal app must not take them.
    const e = key('Minus', { ctrlKey: true });
    expect(handleZoomKey(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(getUiZoom()).toBe(1);
  });

  it('stays inside the supported range, without float drift', () => {
    for (let i = 0; i < 20; i++) handleZoomKey(key('Equal'));
    expect(getUiZoom()).toBe(UI_ZOOM_MAX);
    for (let i = 0; i < 20; i++) handleZoomKey(key('Minus'));
    expect(getUiZoom()).toBe(UI_ZOOM_MIN);
  });
});
