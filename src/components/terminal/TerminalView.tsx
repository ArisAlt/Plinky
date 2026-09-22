import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalTab, SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { 
  startTerminalSession, 
  writeTerminalInput, 
  resizeTerminal, 
  closeTerminalSession 
} from '../../services/tauriBridge';
import { Radio, Edit3, Sparkles } from 'lucide-react';

interface TerminalViewProps {
  tab: TerminalTab;
  onUpdateTab: (tabId: string, updates: Partial<TerminalTab>) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ tab, onUpdateTab }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isFreeType, setIsFreeType] = useState(tab.freeTypeMode);
  const [clickIndicator, setClickIndicator] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js instance with modern dark theme
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: isFreeType ? 'bar' : 'block',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#090d16',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black: '#0f172a',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#06b6d4',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register terminal with manager
    terminalManager.registerTerminal(tab.id, term, tab.syncChannel);
    terminalManager.setActiveTab(tab.id);

    // Connect to live Tauri backend PTY session or fallback to preview
    let isLivePty = false;
    startTerminalSession(
      tab.id,
      tab.sessionName,
      tab.hostname === 'localhost' || !tab.hostname,
      term.cols,
      term.rows,
      (chunk) => {
        isLivePty = true;
        term.write(chunk);
      }
    ).then((started) => {
      if (!started) {
        // Browser development preview fallback banner
        term.writeln(`\x1b[36m╔══════════════════════════════════════════════════════════════════╗\x1b[0m`);
        term.writeln(`\x1b[36m║\x1b[0m  \x1b[1mPlinky PuTTY Wrapper (Preview)\x1b[0m — ${tab.sessionName} (${tab.hostname}:${tab.port})  \x1b[36m║\x1b[0m`);
        term.writeln(`\x1b[36m║\x1b[0m  Protocol: \x1b[35mSSH\x1b[0m | Free Type: \x1b[32mActive\x1b[0m | Sync Channel: \x1b[36m${tab.syncChannel.toUpperCase()}\x1b[0m     \x1b[36m║\x1b[0m`);
        term.writeln(`\x1b[36m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\r\n`);
        term.write(`\x1b[32m${tab.username || 'deploy'}@${tab.sessionName.toLowerCase().replace(/\s+/g, '-')}\x1b[0m:\x1b[34m~\x1b[0m$ `);
      }
    });

    // Handle user keyboard input
    term.onData((data) => {
      if (isLivePty) {
        writeTerminalInput(tab.id, new TextEncoder().encode(data));
      } else {
        // Echo input locally for browser preview
        if (data === '\r') {
          term.write('\r\n');
          term.write(`\x1b[32m${tab.username || 'deploy'}@server\x1b[0m:\x1b[34m~\x1b[0m$ `);
        } else if (data === '\u007F') {
          term.write('\b \b');
        } else {
          term.write(data);
        }
      }
    });

    term.onResize(({ cols, rows }) => {
      if (isLivePty) {
        resizeTerminal(tab.id, cols, rows);
      }
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // Ignored
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminalManager.unregisterTerminal(tab.id);
      if (isLivePty) {
        closeTerminalSession(tab.id);
      }
      term.dispose();
    };
  }, [tab.id, tab.sessionName, tab.hostname, tab.port, tab.username]);

  // Handle Free Type Mode Click
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isFreeType || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setClickIndicator({ x, y });
    setTimeout(() => setClickIndicator(null), 800);

    // Place cursor in terminal
    terminalRef.current?.focus();
  };

  const cycleChannel = () => {
    const channels: SyncChannel[] = ['none', 'A', 'B', 'C', 'D'];
    const currentIdx = channels.indexOf(tab.syncChannel);
    const nextChannel = channels[(currentIdx + 1) % channels.length];
    onUpdateTab(tab.id, { syncChannel: nextChannel });
    terminalManager.setSyncChannel(tab.id, nextChannel);
  };

  const toggleFreeType = () => {
    const nextState = !isFreeType;
    setIsFreeType(nextState);
    onUpdateTab(tab.id, { freeTypeMode: nextState });
    terminalManager.setFreeTypeMode(tab.id, nextState);
  };

  const getChannelColor = (ch: SyncChannel) => {
    switch (ch) {
      case 'A': return 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40';
      case 'B': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40';
      case 'C': return 'bg-amber-500/20 text-amber-400 border-amber-500/40';
      case 'D': return 'bg-rose-500/20 text-rose-400 border-rose-500/40';
      default: return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  return (
    <div className="relative flex flex-col h-full w-full bg-plinky-950 overflow-hidden">
      {/* Tab Control Overlay Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-plinky-900/90 border-b border-plinky-800 text-xs select-none">
        <div className="flex items-center space-x-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="font-semibold text-slate-200">{tab.sessionName}</span>
          <span className="text-slate-500">({tab.hostname}:{tab.port})</span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Sync Input Channel Badge */}
          <button
            onClick={cycleChannel}
            title="Click to cycle broadcast sync channel (A, B, C, D, none)"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] font-mono transition-all ${getChannelColor(tab.syncChannel)}`}
          >
            <Radio className="w-3 h-3" />
            <span>Channel: {tab.syncChannel === 'none' ? 'Off' : tab.syncChannel}</span>
          </button>

          {/* Free Type Mode Toggle */}
          <button
            onClick={toggleFreeType}
            title="Toggle WindTerm Free Type Mode (click anywhere to edit)"
            className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[11px] transition-all ${
              isFreeType
                ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 shadow-sm'
                : 'bg-slate-800/80 text-slate-400 border-slate-700 hover:text-slate-300'
            }`}
          >
            <Edit3 className="w-3 h-3" />
            <span>Free Type</span>
          </button>

          {/* Regex Highlighting Indicator */}
          <span
            title="Active Regex Highlighting: IPs, UUIDs, Errors, Warnings, URLs"
            className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 text-[11px]"
          >
            <Sparkles className="w-3 h-3" />
            <span>Regex Hi</span>
          </span>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div
        ref={containerRef}
        onClick={handleCanvasClick}
        className={`flex-1 relative w-full h-full overflow-hidden ${isFreeType ? 'free-type-active' : ''}`}
      >
        {/* Free Type Visual Click Indicator */}
        {clickIndicator && (
          <div
            className="free-type-cursor-indicator rounded"
            style={{
              left: clickIndicator.x - 12,
              top: clickIndicator.y - 8,
              width: '24px',
              height: '18px',
            }}
          />
        )}
      </div>
    </div>
  );
};
