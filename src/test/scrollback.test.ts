import { describe, it, expect, beforeEach } from 'vitest';
import { getScrollback, setScrollback, DEFAULT_SCROLLBACK } from '../services/scrollback';

describe('scrollback length', () => {
  beforeEach(() => localStorage.clear());

  it('is 1,000 lines until chosen, as it always was', () => {
    expect(DEFAULT_SCROLLBACK).toBe(1000);
    expect(getScrollback()).toBe(1000);
  });

  it('keeps the choice, and falls back on anything that is not one of the choices', () => {
    setScrollback(10000);
    expect(getScrollback()).toBe(10000);
    localStorage.setItem('plinky_scrollback', '12345');
    expect(getScrollback()).toBe(1000);
    localStorage.setItem('plinky_scrollback', 'lots');
    expect(getScrollback()).toBe(1000);
  });
});
