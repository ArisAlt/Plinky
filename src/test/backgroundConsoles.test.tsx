import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';

// Two consoles opened at once, as GNS3's "console to all nodes" does; the
// backend has started both and reports when each connects.
const bridge = vi.hoisted(() => ({
  listeners: [] as ((id: string) => void)[],
  alreadyConnected: new Set<string>(),
}));
vi.mock('../services/tauriBridge', async (orig) => ({
  ...(await orig<typeof import('../services/tauriBridge')>()),
  takeOpenRequests: async () => [
    { protocol: 'telnet', host: '127.0.0.1', port: 5000, title: 'R1', sessionId: 'console-r1' },
    { protocol: 'telnet', host: '127.0.0.1', port: 5001, title: 'R2', sessionId: 'console-r2' },
  ],
  listenOpenRequests: async () => () => {},
  // The app and each tab's view listen; the event reaches them all.
  listenSessionConnected: async (cb: (id: string) => void) => { bridge.listeners.push(cb); return () => {}; },
  isSessionConnected: async (id: string) => bridge.alreadyConnected.has(id),
}));

import { App } from '../App';

const statusOf = (title: string) => {
  const tab = [...document.querySelectorAll<HTMLElement>('[data-tab-status]')]
    .find((el) => el.textContent?.includes(title));
  return tab?.dataset.tabStatus;
};

describe('consoles opened together', () => {
  it('the one behind the front tab turns ready when it connects', async () => {
    // It had no view to hear its connection: every tab but the front one
    // kept its "connecting" spinner until clicked (end-to-end suite).
    await act(async () => { render(<App />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(statusOf('R1')).toBe('connecting');
    await act(async () => { bridge.listeners.forEach((cb) => cb('console-r1')); });
    expect(statusOf('R1')).toBe('live');
  });

  it('one that connected before its tab existed is ready too', async () => {
    // The backend starts a GNS3 console before the page makes its tab, so
    // the event can go by with no tab to mark.
    bridge.alreadyConnected.add('console-r1');
    await act(async () => { render(<App />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(statusOf('R1')).toBe('live');
  });
});
