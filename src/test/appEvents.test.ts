import { describe, it, expect } from 'vitest';
import { pasteLineDelayFrom, isMultiLinePaste, MAX_PASTE_LINE_DELAY_MS, keepaliveSecondsFrom, keepaliveKeys } from '../services/appEvents';

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

describe('keepalive settings', () => {
  it('reads PuTTY\'s two keys the way PuTTY does: minutes + seconds', () => {
    expect(keepaliveSecondsFrom({ PingInterval: '2', PingIntervalSecs: '5' })).toBe(125);
    expect(keepaliveSecondsFrom({ PingIntervalSecs: '30' })).toBe(30);
    expect(keepaliveSecondsFrom({})).toBe(0);
  });

  it('writes them the way PuTTY does, so a session opens the same in PuTTY', () => {
    expect(keepaliveKeys(90)).toEqual({ PingInterval: '1', PingIntervalSecs: '30' });
    expect(keepaliveKeys(0)).toEqual({ PingInterval: '0', PingIntervalSecs: '0' });
    expect(keepaliveSecondsFrom(keepaliveKeys(3661))).toBe(3661);
  });
});

