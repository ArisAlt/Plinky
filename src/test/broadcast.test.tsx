import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook, waitFor } from '@testing-library/react';
import {
  CommandHistory, MAX_HISTORY, useBroadcastGlow, announceBroadcast, GLOW_MS,
  BROADCAST_SENT_EVENT, broadcastHistory,
} from '../services/broadcast';
import { SyncBroadcastBar } from '../components/sync/SyncBroadcastBar';
import { broadcastSyncInput } from '../services/tauriBridge';

vi.mock('../services/tauriBridge', () => ({
  isTauriEnvironment: () => true,
  broadcastSyncInput: vi.fn(),
}));

describe('broadcast command history', () => {
  it('walks back with Up and forward with Down, like a shell', () => {
    const h = new CommandHistory();
    ['show version', 'show ip int brief', 'show clock'].forEach(c => h.push(c));
    expect(h.up('')).toBe('show clock');
    expect(h.up('')).toBe('show ip int brief');
    expect(h.up('')).toBe('show version');
    expect(h.up('')).toBe('show version'); // stays at the oldest
    expect(h.down()).toBe('show ip int brief');
    expect(h.down()).toBe('show clock');
  });

  it('gives back the half-typed line when Down passes the newest', () => {
    const h = new CommandHistory();
    h.push('show clock');
    expect(h.up('show run | inc hostn')).toBe('show clock');
    expect(h.down()).toBe('show run | inc hostn');
    expect(h.down()).toBeNull(); // not browsing: leave the field alone
  });

  it('has nothing to recall before the first command', () => {
    const h = new CommandHistory();
    expect(h.up('typing')).toBeNull();
    expect(h.down()).toBeNull();
  });

  it('skips blanks and an immediate repeat, and starts over after each send', () => {
    const h = new CommandHistory();
    h.push('uptime');
    h.push('uptime');
    h.push('   ');
    h.push('df -h');
    expect(h.entries).toEqual(['uptime', 'df -h']);
    h.up('');
    h.up('');
    h.push('w');
    expect(h.up('')).toBe('w');
  });

  it('keeps the newest MAX_HISTORY commands', () => {
    const h = new CommandHistory();
    for (let i = 0; i < MAX_HISTORY + 5; i++) h.push(`cmd ${i}`);
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.entries[0]).toBe('cmd 5');
  });

  it('is never written to localStorage', () => {
    localStorage.clear();
    const h = new CommandHistory();
    h.push('username admin secret hunter2');
    expect(localStorage.length).toBe(0);
  });
});

describe('broadcast glow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lights exactly the recipients, then goes out', () => {
    const { result } = renderHook(() => useBroadcastGlow());
    act(() => announceBroadcast(['tab-1', 'tab-3']));
    expect([...result.current].sort()).toEqual(['tab-1', 'tab-3']);
    act(() => { vi.advanceTimersByTime(GLOW_MS + 1); });
    expect(result.current.size).toBe(0);
  });

  it('a broadcast nobody received lights nothing', () => {
    const { result } = renderHook(() => useBroadcastGlow());
    act(() => announceBroadcast([]));
    expect(result.current.size).toBe(0);
  });

  it('a second broadcast restarts the timer', () => {
    const { result } = renderHook(() => useBroadcastGlow());
    act(() => announceBroadcast(['a']));
    act(() => { vi.advanceTimersByTime(GLOW_MS - 100); });
    act(() => announceBroadcast(['b']));
    act(() => { vi.advanceTimersByTime(200); });
    expect([...result.current]).toEqual(['b']);
  });
});

describe('the broadcast bar', () => {
  const send = vi.mocked(broadcastSyncInput);
  beforeEach(() => {
    send.mockReset();
    broadcastHistory.clear(); // module-level: start each test from a clean one
  });

  const type = (value: string) => {
    const input = screen.getByLabelText('Broadcast command');
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest('form')!);
    return input as HTMLInputElement;
  };

  it('announces the recipients the backend reports and says how many', async () => {
    send.mockResolvedValue(['tab-1', 'tab-2']);
    const heard = vi.fn();
    window.addEventListener(BROADCAST_SENT_EVENT, heard);
    render(<SyncBroadcastBar />);
    type('show clock');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Sent to 2 sessions'));
    expect(send).toHaveBeenCalledWith('all', new TextEncoder().encode('show clock\n'));
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({ ids: ['tab-1', 'tab-2'] });
    window.removeEventListener(BROADCAST_SENT_EVENT, heard);
  });

  it('says so when the command reached nobody', async () => {
    send.mockResolvedValue([]);
    render(<SyncBroadcastBar />);
    fireEvent.click(screen.getByText('CH-B'));
    type('show clock');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Not sent: no live session on CH-B'));
  });

  it('recalls sent commands with Up and Down', async () => {
    send.mockResolvedValue(['tab-1']);
    render(<SyncBroadcastBar />);
    const input = type('show version');
    await waitFor(() => expect(input.value).toBe(''));
    type('show clock');
    await waitFor(() => expect(input.value).toBe(''));

    fireEvent.change(input, { target: { value: 'sh' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('show clock');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('show version');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('sh');
  });
});
