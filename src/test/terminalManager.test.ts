import { describe, it, expect, beforeEach, vi } from 'vitest';
import { terminalManager } from '../services/terminalManager';
import { Terminal } from '@xterm/xterm';

describe('TerminalManager', () => {
  let mockTermA: any;
  let mockTermB: any;
  let mockTermC: any;

  beforeEach(() => {
    // Reset terminalManager internal state by unregistering
    terminalManager.unregisterTerminal('term-1');
    terminalManager.unregisterTerminal('term-2');
    terminalManager.unregisterTerminal('term-3');

    mockTermA = { write: vi.fn() } as unknown as Terminal;
    mockTermB = { write: vi.fn() } as unknown as Terminal;
    mockTermC = { write: vi.fn() } as unknown as Terminal;
  });

  it('registers and unregisters terminals correctly', () => {
    terminalManager.registerTerminal('term-1', mockTermA, 'none');
    expect(terminalManager.getTerminal('term-1')).toBe(mockTermA);

    terminalManager.unregisterTerminal('term-1');
    expect(terminalManager.getTerminal('term-1')).toBeUndefined();
  });

  it('sets and routes sync channels accurately', () => {
    terminalManager.registerTerminal('term-1', mockTermA, 'A');
    terminalManager.registerTerminal('term-2', mockTermB, 'B');
    terminalManager.registerTerminal('term-3', mockTermC, 'A');

    // Broadcast only to channel A
    terminalManager.broadcastInput('A', 'uptime');

    expect(mockTermA.write).toHaveBeenCalledWith('uptime\r\n');
    expect(mockTermC.write).toHaveBeenCalledWith('uptime\r\n');
    expect(mockTermB.write).not.toHaveBeenCalled();
  });

  it('broadcasts to all terminals when targetChannel is all', () => {
    terminalManager.registerTerminal('term-1', mockTermA, 'A');
    terminalManager.registerTerminal('term-2', mockTermB, 'B');
    terminalManager.registerTerminal('term-3', mockTermC, 'none');

    terminalManager.broadcastInput('all', 'hostname');

    expect(mockTermA.write).toHaveBeenCalledWith('hostname\r\n');
    expect(mockTermB.write).toHaveBeenCalledWith('hostname\r\n');
    expect(mockTermC.write).toHaveBeenCalledWith('hostname\r\n');
  });

  it('updates sync channel and active tab properly', () => {
    terminalManager.registerTerminal('term-1', mockTermA, 'none');
    terminalManager.setSyncChannel('term-1', 'C');
    terminalManager.setActiveTab('term-1');

    expect(terminalManager.getActiveTab()).toBe('term-1');

    terminalManager.broadcastInput('C', 'whoami');
    expect(mockTermA.write).toHaveBeenCalledWith('whoami\r\n');

    terminalManager.unregisterTerminal('term-1');
    expect(terminalManager.getActiveTab()).toBeNull();
  });
});
