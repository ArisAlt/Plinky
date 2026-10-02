import { describe, it, expect, beforeEach } from 'vitest';
import { getUiZoom, initUiZoom, setUiZoom, zoomIn, zoomOut, UI_ZOOM_MAX, UI_ZOOM_MIN } from '../services/uiZoom';

const key = (code: string) =>
  new KeyboardEvent('keydown', { code, ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });

describe('interface size', () => {
  beforeEach(() => setUiZoom(1));

  it('settings step the size by ten percent and persist it', () => {
    zoomIn();
    expect(getUiZoom()).toBe(1.1);
    expect(localStorage.getItem('plinky_ui_zoom')).toBe('1.1');
    zoomOut();
    zoomOut();
    expect(getUiZoom()).toBe(0.9);
  });

  it('no key changes it any more, only settings', () => {
    // Owner: Ctrl+Shift+=/- grew the session list, tabs and dialogs with
    // the text. Those keys are the terminal's font size now.
    initUiZoom();
    for (const code of ['Equal', 'Minus', 'Digit0', 'NumpadAdd']) window.dispatchEvent(key(code));
    expect(getUiZoom()).toBe(1);
  });

  it('stays inside the supported range, without float drift', () => {
    for (let i = 0; i < 20; i++) zoomIn();
    expect(getUiZoom()).toBe(UI_ZOOM_MAX);
    for (let i = 0; i < 20; i++) zoomOut();
    expect(getUiZoom()).toBe(UI_ZOOM_MIN);
  });
});
