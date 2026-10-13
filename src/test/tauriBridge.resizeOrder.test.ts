import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resizeTerminal } from '../services/tauriBridge';

// On Windows each IPC request may finish in any order. Two resizes sent while
// a tab settled landed the other way round: the router was told 85 columns
// while the screen showed 84.
describe('resizeTerminal', () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        if (cmd !== 'resize_terminal') return null;
        // The first resize is the slowest: concurrent requests would land
        // the later one first.
        await new Promise((r) => setTimeout(r, args.cols === 85 ? 30 : 1));
        sent.push(`${args.sessionId}:${args.cols}x${args.rows}`);
        return null;
      },
      transformCallback: () => 1,
    };
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('leaves the session at the last size asked for', async () => {
    await Promise.all([resizeTerminal('t1', 85, 25), resizeTerminal('t1', 84, 25)]);
    expect(sent.at(-1)).toBe('t1:84x25');
  });

  it('skips a size that was already replaced while it waited', async () => {
    const first = resizeTerminal('t1', 85, 25);
    await new Promise((r) => setTimeout(r, 5));
    // 85 is on its way; 90 waits behind it and is replaced by 84.
    await Promise.all([first, resizeTerminal('t1', 90, 25), resizeTerminal('t1', 84, 25)]);
    expect(sent).toEqual(['t1:85x25', 't1:84x25']);
  });
});
