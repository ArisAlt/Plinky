import { describe, it, expect } from 'vitest';
import { pasteLineDelayFrom, isMultiLinePaste, MAX_PASTE_LINE_DELAY_MS } from '../services/appEvents';

describe('paste line delay helpers', () => {
  it('reads the session setting, treating missing or bad values as off', () => {
    expect(pasteLineDelayFrom({ PlinkyPasteLineDelayMs: '250' })).toBe(250);
    expect(pasteLineDelayFrom({})).toBe(0);
    expect(pasteLineDelayFrom(undefined)).toBe(0);
    expect(pasteLineDelayFrom({ PlinkyPasteLineDelayMs: 'fast' })).toBe(0);
    expect(pasteLineDelayFrom({ PlinkyPasteLineDelayMs: '-5' })).toBe(0);
  });

  it('clamps to what the backend accepts, so a paste is never refused for it', () => {
    expect(pasteLineDelayFrom({ PlinkyPasteLineDelayMs: '99999' })).toBe(MAX_PASTE_LINE_DELAY_MS);
  });

  it('paces only text that really has several lines', () => {
    expect(isMultiLinePaste('interface Gi0/1\n shutdown\n')).toBe(true);
    expect(isMultiLinePaste('a\r\nb')).toBe(true);
    expect(isMultiLinePaste('show version\n')).toBe(false); // one line + Enter
    expect(isMultiLinePaste('show version')).toBe(false);
  });
});
