import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

// A stand-in xterm: any property is a no-op that returns another stand-in,
// write() runs its callback, and the size is fixed. Enough for TerminalView
// to mount and process output without a canvas.
function stand(): any {
  const fn: any = () => stand();
  return new Proxy(fn, {
    get: (_t, p) => {
      if (p === 'cols') return 100;
      if (p === 'rows') return 30;
      if (p === 'write') return (_d: unknown, cb?: () => void) => { cb?.(); };
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then') return undefined; // not a promise
      return stand();
    },
    apply: () => stand(),
    construct: () => stand(),
  });
}
vi.mock('@xterm/xterm', () => ({ Terminal: function Terminal() { return stand(); } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: function FitAddon() { return stand(); } }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: function SearchAddon() { return stand(); } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: function WebLinksAddon() { return stand(); } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: function Unicode11Addon() { return stand(); } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: function WebglAddon() { return stand(); } }));

// The backend's broadcast router, as the page tells it: session -> channel.
const router = vi.hoisted(() => new Map<string, string>());

vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  attachTerminalSession: async (id: string) => ({
    session_id: id, replay_data: [], truncated: false, is_live: true, pending_prompt: null,
  }),
  startTerminalSession: async () => ({ started: true }),
  detachTerminalSession: async () => {},
  setSyncChannel: async (id: string, channel: string | null) => {
    if (channel) router.set(id, channel); else router.delete(id);
  },
}));

import { TerminalView } from '../components/terminal/TerminalView';
import type { TerminalTab } from '../types/session';

const r1: TerminalTab = {
  id: 'tab-r1', title: 'R1', sessionName: 'telnet://192.0.2.13:5000', syncChannel: 'B',
  status: 'live', freeTypeMode: false, activeHighlighting: true,
  hostname: '192.0.2.13', port: 5000, protocol: 'Telnet',
};

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

describe('a tab on a broadcast channel', () => {
  beforeEach(() => router.clear());

  it('stays on its channel while another tab is shown, and after it comes back', async () => {
    // Owner's screenshot: R1 and R2 on channel B, both live, "Send to 2" --
    // then "Not sent: no live session on CH-B". Switching tabs unmounted
    // the view, and the unmount took the session off its channel.
    let view: ReturnType<typeof render> | undefined;
    await act(async () => { view = render(<TerminalView tab={r1} onUpdateTab={() => {}} />); });
    await settle();
    expect(router.get('tab-r1')).toBe('B');

    await act(async () => { view!.unmount(); }); // another tab is shown
    expect(router.get('tab-r1')).toBe('B');

    await act(async () => { render(<TerminalView tab={r1} onUpdateTab={() => {}} />); }); // shown again
    await settle();
    expect(router.get('tab-r1')).toBe('B');
  });

  it('a changed channel reaches the backend, and Off takes it off', async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => { view = render(<TerminalView tab={r1} onUpdateTab={() => {}} />); });
    await act(async () => { view!.rerender(<TerminalView tab={{ ...r1, syncChannel: 'C' }} onUpdateTab={() => {}} />); });
    expect(router.get('tab-r1')).toBe('C');
    await act(async () => { view!.rerender(<TerminalView tab={{ ...r1, syncChannel: 'none' }} onUpdateTab={() => {}} />); });
    expect(router.has('tab-r1')).toBe(false);
  });
});
