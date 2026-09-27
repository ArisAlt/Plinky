import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TooltipHost, adoptTitle, placeTip } from '../components/common/TooltipHost';

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('title adoption', () => {
  it('an icon button named only by its title keeps that name', () => {
    // 31 icon-only buttons were named by title alone; moving the title
    // out must not leave them nameless.
    const b = document.createElement('button');
    b.setAttribute('title', 'Split vertically');
    expect(adoptTitle(b)).toBe('Split vertically');
    expect(b.hasAttribute('title')).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('Split vertically');
  });

  it('a button with text keeps its text as the name and gets the tip as a description', () => {
    const b = document.createElement('button');
    b.textContent = 'Cancel';
    b.setAttribute('title', 'Esc');
    adoptTitle(b);
    expect(b.hasAttribute('aria-label')).toBe(false);
    expect(b.getAttribute('aria-description')).toBe('Esc');
  });
});

describe('placement', () => {
  it('goes under the anchor, centred', () => {
    expect(placeTip(rect(100, 100, 40, 20), 80, 24, 1280, 800)).toEqual({ top: 126, left: 80 });
  });
  it('flips above when there is no room below', () => {
    expect(placeTip(rect(100, 770, 40, 20), 80, 24, 1280, 800).top).toBe(740);
  });
  it('never leaves the window on the right, where the settings gear sits', () => {
    // The gear's native tooltip ran off the window's right edge.
    const { left } = placeTip(rect(1240, 8, 28, 28), 160, 24, 1280, 800);
    expect(left + 160).toBeLessThanOrEqual(1280 - 8);
  });
});

describe('tooltip host', () => {
  afterEach(() => vi.useRealTimers());

  it('shows after a pause, in the app, and a click hides it', () => {
    vi.useFakeTimers();
    render(<><TooltipHost /><button title="Host keys verified by PuTTY">Keys</button></>);
    const b = screen.getByText('Keys');
    fireEvent.pointerOver(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip').textContent).toBe('Host keys verified by PuTTY');
    expect(b.hasAttribute('title')).toBe(false); // the native one never shows
    fireEvent.pointerDown(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a second tooltip right after the first shows at once', () => {
    vi.useFakeTimers();
    render(<><TooltipHost /><button title="Find">F</button><button title="Log">L</button></>);
    fireEvent.pointerOver(screen.getByText('F'));
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerOver(screen.getByText('L'));
    expect(screen.getByRole('tooltip').textContent).toBe('Log');
  });
});
