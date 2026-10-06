import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';

// The desktop app: every clipboard call goes to the backend.
const env = vi.hoisted(() => ({ tauri: true, invoked: [] as { cmd: string; args?: unknown }[], clip: '' }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: { text?: string }) => {
    env.invoked.push({ cmd, args });
    if (cmd === 'read_clipboard_text') return env.clip;
    if (cmd === 'write_clipboard_text') { env.clip = args?.text ?? ''; return null; }
    return null;
  },
}));

// A stand-in xterm that keeps its key handler and records pastes.
const term = vi.hoisted(() => ({ keyHandler: null as null | ((e: KeyboardEvent) => boolean), pasted: [] as string[], input: [] as string[] }));
function stand(): any {
  const fn: any = () => stand();
  return new Proxy(fn, {
    get: (_t, p) => {
      if (p === 'cols') return 100;
      if (p === 'rows') return 30;
      if (p === 'write') return (_d: unknown, cb?: () => void) => { cb?.(); };
      if (p === 'attachCustomKeyEventHandler') return (h: (e: KeyboardEvent) => boolean) => { term.keyHandler = h; };
      if (p === 'paste') return (t: string) => { term.pasted.push(t); };
      if (p === 'input') return (t: string) => { term.input.push(t); };
      if (p === 'getSelection') return () => 'selected text';
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then') return undefined;
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

vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  isTauriEnvironment: () => env.tauri,
  attachTerminalSession: async () => null,
  startTerminalSession: async () => ({ started: false }),
}));

import { readClipboard, writeClipboard } from '../services/clipboard';
import { TerminalView } from '../components/terminal/TerminalView';
import type { TerminalTab } from '../types/session';

describe('the clipboard in the desktop app', () => {
  beforeEach(() => { env.invoked = []; env.clip = ''; env.tauri = true; });

  it('is read by the backend, not the page', async () => {
    // The webview blocks the page from reading the clipboard: paste from a
    // browser or any other program gave nothing, on Linux and Windows.
    const page = vi.spyOn(navigator.clipboard ?? { readText: async () => '' }, 'readText' as never);
    env.clip = 'copied in a browser';
    await expect(readClipboard()).resolves.toBe('copied in a browser');
    expect(env.invoked.map(i => i.cmd)).toEqual(['read_clipboard_text']);
    expect(page).not.toHaveBeenCalled();
  });

  it('is written by the backend too', async () => {
    await writeClipboard('R1#show run');
    expect(env.invoked).toEqual([{ cmd: 'write_clipboard_text', args: { text: 'R1#show run' } }]);
  });
});

describe('pasting into a terminal', () => {
  beforeEach(() => { env.invoked = []; env.clip = ''; env.tauri = true; term.keyHandler = null; term.pasted = []; term.input = []; });

  const tab: TerminalTab = {
    id: 'tab-paste', title: 'R1', sessionName: 'R1', syncChannel: 'none', status: 'live',
    freeTypeMode: false, activeHighlighting: true, hostname: '192.0.2.30', port: 5020, protocol: 'Telnet',
  };
  const key = (code: string, mods: KeyboardEventInit) => new KeyboardEvent('keydown', { code, ...mods });

  it('Ctrl+Shift+V pastes what another program copied', async () => {
    env.clip = 'show ip interface brief';
    await act(async () => { render(<TerminalView tab={tab} onUpdateTab={() => {}} />); });
    expect(term.keyHandler).toBeTruthy();
    await act(async () => { term.keyHandler!(key('KeyV', { ctrlKey: true, shiftKey: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(env.invoked.map(i => i.cmd)).toContain('read_clipboard_text');
    expect(term.pasted).toEqual(['show ip interface brief']);
  });

  it('Ctrl+Shift+C copies the selection through the backend', async () => {
    await act(async () => { render(<TerminalView tab={tab} onUpdateTab={() => {}} />); });
    await act(async () => { term.keyHandler!(key('KeyC', { ctrlKey: true, shiftKey: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(env.clip).toBe('selected text');
  });

  it('Paste in the right-click menu sends what Ctrl+Shift+V sends', async () => {
    // It wrote the clipboard raw: a line break reached the router as LF, and
    // CR LF (text copied on Windows) as two Enters per line. The keys go
    // through the terminal's paste, which sends each line with one Enter.
    env.clip = 'show ip route';
    const { container } = await act(async () => render(<TerminalView tab={tab} onUpdateTab={() => {}} />));
    const surface = container.querySelector('[class*="relative"]') ?? container.firstElementChild!;
    await act(async () => { fireEvent.contextMenu(surface, { clientX: 20, clientY: 20 }); });
    await act(async () => { fireEvent.click(screen.getByText('Paste')); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(term.pasted).toEqual(['show ip route']);
    expect(env.invoked.map(i => i.cmd)).not.toContain('write_terminal_input');
  });

  it('Ctrl+Shift+6 and Home go out as PuTTY sends them, as typed input', async () => {
    await act(async () => { render(<TerminalView tab={tab} onUpdateTab={() => {}} />); });
    expect(term.keyHandler!(key('Digit6', { ctrlKey: true, shiftKey: true, key: '^' }))).toBe(false);
    expect(term.keyHandler!(key('Home', { key: 'Home' }))).toBe(false);
    expect(term.input).toEqual(['\x1e', '\x1b[1~']);
  });
});
