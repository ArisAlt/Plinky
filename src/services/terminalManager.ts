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
    for (const [id, entry] of this.terminals.entries()) {
      if (targetChannel === 'all' || entry.syncChannel === targetChannel) {
        // Send input to terminal (in live mode this sends to PTY)
        entry.terminal.write(text.replace(/\n/g, '\r\n') + '\r\n');
        // Trigger simulated prompt response for visual preview
        this.simulateEcho(id, entry.terminal, text);
      }
    }
  }

  private simulateEcho(_tabId: string, terminal: Terminal, command: string) {
    setTimeout(() => {
      const trimmed = command.trim();
      if (trimmed === 'ls' || trimmed === 'll') {
        terminal.write('\x1b[34mapp\x1b[0m  \x1b[32mdeploy.sh\x1b[0m  docker-compose.yml  \x1b[31merror.log\x1b[0m  nginx.conf\r\n');
      } else if (trimmed === 'uptime') {
        terminal.write(' 20:25:00 up 42 days, 3:14, 2 users, load average: 0.12, 0.08, 0.05\r\n');
      } else if (trimmed === 'ip a' || trimmed === 'ifconfig') {
        terminal.write('2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\r\n    inet 192.0.2.10/24 brd 192.0.2.255 scope global eth0\r\n');
      } else if (trimmed === 'date') {
        terminal.write(new Date().toUTCString() + '\r\n');
      } else if (trimmed.startsWith('ping')) {
        terminal.write('64 bytes from 192.0.2.1: icmp_seq=1 ttl=64 time=0.421 ms\r\n');
      } else if (trimmed === 'help') {
        terminal.write('\x1b[36mPlinky PuTTY Wrapper Terminal\x1b[0m (WindTerm IDE features active)\r\nChannels: A, B, C, D | Free Type Mode: active\r\n');
      }
      terminal.write('\x1b[32mdeploy@server\x1b[0m:\x1b[34m~\x1b[0m$ ');
    }, 120);
  }
}

export const terminalManager = new TerminalManager();
