import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { fitMenu } from '../services/menuFit';
import { SessionExplorer } from '../components/sidebar/SessionExplorer';
import type { PuttySession } from '../types/session';

describe('fitting a menu inside the window', () => {
  const view = { width: 800, height: 600 };
  const menu = { width: 176, height: 260 };

  it('leaves a menu that fits where it was opened', () => {
    expect(fitMenu(100, 100, menu, view)).toEqual({ x: 100, y: 100 });
  });

  it('moves a menu opened near the bottom up, so its last item shows', () => {
    // The owner's case: right-click on the last session of a full tree.
    expect(fitMenu(100, 580, menu, view)).toEqual({ x: 100, y: 600 - 260 - 8 });
  });

  it('moves a menu opened near the right edge to the left', () => {
    expect(fitMenu(790, 100, menu, view).x).toBe(800 - 176 - 8);
  });

  it('never pushes a menu taller than the window above its top', () => {
    expect(fitMenu(100, 580, { width: 176, height: 900 }, view).y).toBe(8);
  });
});

describe('the session list menus', () => {
  const sessions: PuttySession[] = [
    { name: 'R1', protocol: 'Telnet', hostname: '192.0.2.30', port: 5020, folder: 'GNS3' },
    { name: 'Server', protocol: 'SSH', hostname: '192.0.2.10', port: 22 },
  ];
  const props = {
    sessions, tabs: [], activeTabId: null,
    onConnectSession: vi.fn(), onOpenSftp: vi.fn(), onCreateSession: vi.fn(),
    onEditSession: vi.fn(), onMoveToFolder: vi.fn(),
  };

  const sizeOf = (el: HTMLElement, full: number) => (el.getAttribute('role') === 'menu' ? full : 0);
  let width: ReturnType<typeof vi.spyOn>;
  let height: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    // jsdom has no layout: give menus the size the real one has.
    width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this, 176); });
    height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return sizeOf(this, 260); });
  });
  afterEach(() => { width.mockRestore(); height.mockRestore(); });

  it('a session menu opened low in the tree is moved up to fit', () => {
    render(<SessionExplorer {...(props as any)} />);
    const row = screen.getByText('Server').closest('[data-session-row]')!;
    fireEvent.contextMenu(row, { clientX: 60, clientY: 590 });
    const menu = screen.getByRole('menu', { name: /Session Server/ });
    expect(menu.style.top).toBe(`${600 - 260 - 8}px`);
    expect(menu.style.left).toBe('60px');
  });

  it('a folder menu opened low in the tree is moved up to fit', () => {
    render(<SessionExplorer {...(props as any)} />);
    const folder = screen.getByText('GNS3');
    fireEvent.contextMenu(folder, { clientX: 60, clientY: 595 });
    const menu = screen.getByRole('menu', { name: /Folder/ });
    expect(menu.style.top).toBe(`${600 - 260 - 8}px`);
  });
});
