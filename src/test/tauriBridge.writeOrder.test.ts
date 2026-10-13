import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeTerminalInput } from '../services/tauriBridge';

// On Windows each IPC request may finish in any order. Keystrokes must still
// reach a session in the order they were typed.
describe('writeTerminalInput', () => {
  let started: string[];
  let finished: string[];

  beforeEach(() => {
    started = [];
    finished = [];
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: any) => {
        if (cmd !== 'write_terminal_input') return null;
        const key = `${args.sessionId}:${String.fromCharCode(...args.data)}`;
        started.push(key);
        // The first write is the slowest: concurrent requests would finish
        // the later ones first.
        await new Promise((r) => setTimeout(r, args.data[0] === 0x73 ? 30 : 1));
        finished.push(key);
        return null;
      },
      transformCallback: () => 1,
    };
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('sends a tab\'s keystrokes one after another, in the order typed', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    await Promise.all(['s', 'h', 'o', 'w'].map((c) => writeTerminalInput('t1', enc(c))));
    expect(started).toEqual(['t1:s', 't1:h', 't1:o', 't1:w']);
    expect(finished).toEqual(['t1:s', 't1:h', 't1:o', 't1:w']);
  });

  it('does not hold one tab\'s typing behind another tab\'s slow write', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const slow = writeTerminalInput('t1', enc('s'));
    await writeTerminalInput('t2', enc('x'));
    expect(finished).toEqual(['t2:x']);
    await slow;
    expect(finished).toEqual(['t2:x', 't1:s']);
  });
});
