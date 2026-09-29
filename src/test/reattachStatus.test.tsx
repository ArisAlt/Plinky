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

const bridge = vi.hoisted(() => ({
  attachInfo: null as null | { is_live: boolean; replay: string },
  liveChunk: null as null | ((chunk: Uint8Array) => void),
}));

vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  attachTerminalSession: async (id: string, _seq: number, onData: (c: Uint8Array) => void) => {
    bridge.liveChunk = onData;
    const a = bridge.attachInfo;
    if (!a) return null; // nothing to reattach to: the view starts a session
    return {
      session_id: id,
      replay_data: Array.from(new TextEncoder().encode(a.replay)),
      truncated: false,
      is_live: a.is_live,
      pending_prompt: null,
    };
  },
  startTerminalSession: async (_id: string, _name: string, _local: boolean, _c: number, _r: number, onData: (c: Uint8Array) => void) => {
    bridge.liveChunk = onData;
    return { started: true };
  },
}));

import { TerminalView } from '../components/terminal/TerminalView';
import type { TerminalTab } from '../types/session';

// An SSH login as plink prints it, then the shell: what a reattach replays.
const LOGIN = [
  'Using username "ops".\r\n',
  "ops@192.0.2.10's password: \r\n",
  'Access granted. Press Return to begin session. \r\n',
  '\r\nLinux server 6.12 #1 SMP aarch64\r\n',
  'Last login: Mon Sep 28 22:41:29 2026 from 192.0.2.62\r\n',
  'ops@server:~$ ',
].join('');

const tab: TerminalTab = {
  id: 'tab-ssh-1', title: 'server', sessionName: 'server', syncChannel: 'none',
  status: 'live', freeTypeMode: false, activeHighlighting: true,
  hostname: '192.0.2.10', port: 22, protocol: 'SSH',
};

async function mountAttached(attach: { is_live: boolean; replay: string }) {
  bridge.attachInfo = attach;
  const statuses: string[] = [];
  const onUpdateTab = (_id: string, u: Partial<TerminalTab>) => { if (u.status) statuses.push(u.status); };
  await act(async () => { render(<TerminalView tab={tab} onUpdateTab={onUpdateTab} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  return statuses;
}

describe('switching back to a logged-in SSH tab', () => {
  beforeEach(() => { bridge.attachInfo = null; bridge.liveChunk = null; });

  it('stays green although the replay holds the old login prompt', async () => {
    const statuses = await mountAttached({ is_live: true, replay: LOGIN });
    expect(statuses.at(-1)).toBe('live');
  });

  it('stays green when Windows repaints the whole login after the reattach', async () => {
    // Windows' pseudo-console repaints its whole screen when the tab tells
    // the session its size on reattach -- the old "password:" included.
    // Reproduced in a Windows 11 VM: the tab went amber after Ctrl+Tab.
    const statuses = await mountAttached({ is_live: true, replay: LOGIN });
    await act(async () => { bridge.liveChunk!(new TextEncoder().encode('\x1b[H\x1b[2J' + LOGIN)); });
    expect(statuses.at(-1)).toBe('live');
  });

  it('stays green when a live session asks for a password (a router\'s enable)', async () => {
    const statuses = await mountAttached({ is_live: true, replay: LOGIN });
    await act(async () => { bridge.liveChunk!(new TextEncoder().encode('R1>enable\r\nPassword: ')); });
    expect(statuses.at(-1)).toBe('live');
  });

  it('stays amber for a session that never logged in', async () => {
    const statuses = await mountAttached({ is_live: false, replay: "Using username \"ops\".\r\nops@192.0.2.10's password: " });
    expect(statuses.at(-1)).toBe('preauth');
  });

  it('still shows a login in progress, then turns green when it is over', async () => {
    // The live marker must not hide a real login: amber at the prompt,
    // green once plink says "Access granted" and the shell starts.
    const statuses = await mountAttached({ is_live: false, replay: "Using username \"ops\".\r\nops@192.0.2.10's password: " });
    expect(statuses.at(-1)).toBe('preauth');
    await act(async () => { bridge.liveChunk!(new TextEncoder().encode('\r\nAccess granted. Press Return to begin session. \r\nops@server:~$ ')); });
    expect(statuses.at(-1)).toBe('live');
  });

  it('stays green when the shell redraws its prompt after the reattach', async () => {
    const statuses = await mountAttached({ is_live: true, replay: LOGIN });
    await act(async () => { bridge.liveChunk!(new TextEncoder().encode('\r\x1b[Kops@server:~$ ')); });
    expect(statuses.at(-1)).toBe('live');
  });
});

describe('a session with no login', () => {
  beforeEach(() => { bridge.attachInfo = null; bridge.liveChunk = null; });

  async function mountFresh(t: Partial<TerminalTab>) {
    const statuses: string[] = [];
    const onUpdateTab = (_id: string, u: Partial<TerminalTab>) => { if (u.status) statuses.push(u.status); };
    const fresh = { ...tab, status: 'connecting' as const, ...t };
    await act(async () => { render(<TerminalView tab={fresh} onUpdateTab={onUpdateTab} />); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    return statuses;
  }

  it('a Local Shell is green once it starts, whatever its prompt looks like', async () => {
    // Windows' prompt ends in ">", which the live pattern never matched:
    // the tab spun "connecting" forever (Windows 11 VM).
    const statuses = await mountFresh({ id: 'tab-local', title: 'Local Shell', sessionName: 'Local Shell', protocol: undefined });
    await act(async () => { bridge.liveChunk!(new TextEncoder().encode('Microsoft Windows\r\n\r\nC:\\Users\\ops>')); });
    expect(statuses.at(-1)).toBe('live');
  });

  it('a serial line is green once it opens, before the device prints anything', async () => {
    const statuses = await mountFresh({ id: 'tab-serial', title: 'Console', sessionName: 'Console', protocol: 'Serial' });
    expect(statuses.at(-1)).toBe('live');
  });

  it('an SSH session is not green just because plink started', async () => {
    const statuses = await mountFresh({ id: 'tab-ssh-new' });
    expect(statuses).not.toContain('live');
  });
});

