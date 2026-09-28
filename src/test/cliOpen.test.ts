import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tabForOpenRequest, throttle } from '../services/cliOpen';
import { targetProtocolOf, startSessionInBackground, backgroundStartOf } from '../services/tauriBridge';
import { saveLayout, loadLayout } from '../services/layoutPersistence';

describe('console tabs from the command line (GNS3)', () => {
  it('turns `--telnet 127.0.0.1 5000 --title R1` into a telnet tab named R1', () => {
    const tab = tabForOpenRequest({ protocol: 'telnet', host: '127.0.0.1', port: 5000, title: 'R1' }, 'tab-1');
    expect(tab).toMatchObject({
      id: 'tab-1', title: 'R1', hostname: '127.0.0.1', port: 5000, protocol: 'Telnet', status: 'connecting',
    });
  });

  it('takes the id of the session the backend already started, so it attaches to it', () => {
    // The connect no longer waits for the tab: it starts when the request arrives.
    const started = tabForOpenRequest({ protocol: 'telnet', host: '10.0.0.5', port: 5020, sessionId: 'cli-1-0' }, 'tab-x');
    expect(started.id).toBe('cli-1-0');
    const notStarted = tabForOpenRequest({ protocol: 'telnet', host: '10.0.0.5', port: 5020, sessionId: null }, 'tab-x');
    expect(notStarted.id).toBe('tab-x');
  });

  it('never uses the title as the session name, so a saved session called R1 is not loaded instead', () => {
    const tab = tabForOpenRequest({ protocol: 'telnet', host: '127.0.0.1', port: 5000, title: 'R1' }, 't');
    expect(tab.sessionName).toBe('telnet://127.0.0.1:5000');
  });

  it('falls back to host:port, bracketing IPv6', () => {
    expect(tabForOpenRequest({ protocol: 'raw', host: '10.0.0.2', port: 2001 }, 't').title).toBe('10.0.0.2:2001');
    const v6 = tabForOpenRequest({ protocol: 'telnet', host: '::1', port: 5000, title: null }, 't');
    expect(v6.title).toBe('[::1]:5000');
    expect(v6.hostname).toBe('::1');
  });

  it('maps protocols both ways', () => {
    expect(tabForOpenRequest({ protocol: 'raw', host: 'h', port: 1 }, 't').protocol).toBe('RAW');
    expect(tabForOpenRequest({ protocol: 'ssh', host: 'h', port: 22, user: 'ops' }, 't')).toMatchObject({ protocol: 'SSH', username: 'ops' });
    expect(targetProtocolOf('Telnet')).toBe('telnet');
    expect(targetProtocolOf('RAW')).toBe('raw');
    expect(targetProtocolOf('SSH')).toBe('ssh');
    expect(targetProtocolOf('Serial')).toBeUndefined();
    expect(targetProtocolOf(undefined)).toBeUndefined();
  });
});

describe('a burst of launches', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the first console at once', () => {
    // It was a 60 ms debounce: every single console waited 60 ms for its tab.
    const fn = vi.fn();
    throttle(fn, 60)();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('takes the rest of a burst in a few batches, not one update each', () => {
    // GNS3's "open all consoles": twenty launches, twenty nudges, 5 ms apart.
    const fn = vi.fn();
    const nudge = throttle(fn, 60);
    for (let i = 0; i < 20; i++) { nudge(); vi.advanceTimersByTime(5); }
    vi.advanceTimersByTime(200);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('still takes a nudge that arrives after a quiet spell', () => {
    const fn = vi.fn();
    const nudge = throttle(fn, 60);
    nudge();
    vi.advanceTimersByTime(500);
    nudge();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('can be cancelled when the page goes away', () => {
    const fn = vi.fn();
    const nudge = throttle(fn, 60);
    nudge();
    nudge();
    nudge.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('background console starts', () => {
  it('are tracked until done, so the tab waits instead of starting a second session', async () => {
    startSessionInBackground({ id: 'tab-bg', sessionName: 'telnet://h:1', hostname: 'h', port: 1, protocol: 'Telnet' });
    const pending = backgroundStartOf('tab-bg');
    expect(pending).toBeTruthy();
    await pending;
    expect(backgroundStartOf('tab-bg')).toBeUndefined();
  });
});

describe('the saved layout', () => {
  beforeEach(() => localStorage.clear());

  it('keeps a console tab telnet across a restart', () => {
    // Without the protocol, the restored tab reconnected as SSH to a telnet port.
    const tab = tabForOpenRequest({ protocol: 'telnet', host: '127.0.0.1', port: 5000, title: 'R1' }, 'tab-r1');
    saveLayout('single', 'tab-r1', [tab]);
    expect(loadLayout()?.tabs[0].protocol).toBe('Telnet');
  });
});
