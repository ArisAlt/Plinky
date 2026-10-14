import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';

// A stand-in xterm that keeps what the view registers with onData, so the
// test can type into it. Anything else is a no-op stand-in.
const typed = vi.hoisted(() => ({ onData: null as null | ((d: string) => void) }));
function stand(): any {
  const fn: any = () => stand();
  return new Proxy(fn, {
    get: (_t, p) => {
      if (p === 'cols') return 100;
      if (p === 'rows') return 30;
      if (p === 'write') return (_d: unknown, cb?: () => void) => { cb?.(); };
      if (p === 'onData') return (cb: (d: string) => void) => { typed.onData = cb; return stand(); };
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

const bridge = vi.hoisted(() => ({
  sent: [] as string[],
  finishAttach: null as null | (() => void),
}));

vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  isTauriEnvironment: () => true,
  writeTerminalInput: async (_id: string, data: Uint8Array) => { bridge.sent.push(new TextDecoder().decode(data)); },
  // An attach that takes its time, as one does on Windows with a full
  // scrollback, until the test lets it finish.
  attachTerminalSession: (id: string) => new Promise((resolve) => {
    bridge.finishAttach = () => resolve({
      session_id: id, replay_data: [], truncated: false, is_live: true, pending_prompt: null,
    });
  }),
}));

import { TerminalView } from '../components/terminal/TerminalView';
import type { TerminalTab } from '../types/session';

const tab: TerminalTab = {
  id: 'cli-r1', title: 'R1', sessionName: 'R1', syncChannel: 'none',
  status: 'live', freeTypeMode: false, activeHighlighting: true,
  hostname: '127.0.0.1', port: 5000, protocol: 'Telnet',
};

describe('keys typed while the tab is still attaching', () => {
  it('are sent once it has attached, in order, not dropped', async () => {
    await act(async () => { render(<TerminalView tab={tab} onUpdateTab={() => {}} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(typed.onData).toBeTruthy();
    // The tab already shows live; its view has no session yet.
    act(() => { typed.onData!('\r'); typed.onData!('show ver'); });
    expect(bridge.sent).toEqual([]);
    await act(async () => { bridge.finishAttach!(); await new Promise(r => setTimeout(r, 20)); });
    expect(bridge.sent.slice(0, 2)).toEqual(['\r', 'show ver']);
    // And what is typed after goes straight on.
    act(() => { typed.onData!('x'); });
    expect(bridge.sent.at(-1)).toBe('x');
  });
});
