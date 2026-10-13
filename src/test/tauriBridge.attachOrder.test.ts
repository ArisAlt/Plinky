import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { attachTerminalSession, detachTerminalSession } from '../services/tauriBridge';

// Switching away from a tab and back detaches its session and attaches it
// again. On Windows the detach could land last, and the tab never got its
// output again: not even the notice that the device hung up.
describe('attach and detach', () => {
  let handled: string[];

  beforeEach(() => {
    handled = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        // The detach is the slowest: concurrent requests would land it last.
        await new Promise((r) => setTimeout(r, cmd === 'detach_terminal_session' ? 30 : 1));
        handled.push(`${cmd}:${args.sessionId}`);
        return cmd === 'attach_terminal_session' ? { is_live: true } : null;
      },
      transformCallback: () => 1,
      // Channel registration.
      convertFileSrc: (s: string) => s,
    };
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('a tab switched away from and back to ends attached', async () => {
    await Promise.all([detachTerminalSession('t1'), attachTerminalSession('t1', 0, () => {})]);
    expect(handled).toEqual(['detach_terminal_session:t1', 'attach_terminal_session:t1']);
  });

  it('does not hold one tab\'s attach behind another tab\'s detach', async () => {
    const slow = detachTerminalSession('t1');
    await attachTerminalSession('t2', 0, () => {});
    expect(handled).toEqual(['attach_terminal_session:t2']);
    await slow;
  });
});
