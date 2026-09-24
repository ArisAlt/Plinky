import { Terminal } from '@xterm/xterm';
import { SyncChannel } from '../types/session';

interface RegisteredTerminal {
  terminal: Terminal;
  syncChannel: SyncChannel;
  freeTypeMode: boolean;
}

class TerminalManager {
  private terminals = new Map<string, RegisteredTerminal>();
  private activeTabId: string | null = null;

  registerTerminal(id: string, terminal: Terminal, syncChannel: SyncChannel = 'none') {
    this.terminals.set(id, {
      terminal,
      syncChannel,
      freeTypeMode: false,
    });
  }

  unregisterTerminal(id: string) {
    this.terminals.delete(id);
    if (this.activeTabId === id) {
      this.activeTabId = null;
    }
  }

  getTerminal(id: string): Terminal | undefined {
    return this.terminals.get(id)?.terminal;
  }

  setSyncChannel(id: string, channel: SyncChannel) {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.syncChannel = channel;
    }
  }

  setFreeTypeMode(id: string, enabled: boolean) {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.freeTypeMode = enabled;
    }
  }

  setActiveTab(id: string) {
    this.activeTabId = id;
  }

  getActiveTab(): string | null {
    return this.activeTabId;
  }

  // Broadcasts input to all terminals matching the target channel
  broadcastInput(targetChannel: SyncChannel | 'all', text: string) {
    for (const [_id, entry] of this.terminals.entries()) {
      if (targetChannel === 'all' || entry.syncChannel === targetChannel) {
        entry.terminal.write(text.replace(/\n/g, '\r\n') + '\r\n');
      }
    }
  }
}

export const terminalManager = new TerminalManager();
