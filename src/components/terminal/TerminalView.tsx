import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalTab, SyncChannel } from '../../types/session';
import { terminalManager } from '../../services/terminalManager';
import { 
  startTerminalSession, 
  attachTerminalSession,
  writeTerminalInput, 
  resizeTerminal, 
  closeTerminalSession,
  answerHostKeyPrompt,
  listenHostKeyPrompts,
  setSyncChannel,
  HostKeyPromptInfo
} from '../../services/tauriBridge';
import { Radio, Edit3, Sparkles, ShieldAlert } from 'lucide-react';

interface TerminalViewProps {
  tab: TerminalTab;
  onUpdateTab: (tabId: string, updates: Partial<TerminalTab>) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ tab, onUpdateTab }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isLivePtyRef = useRef<boolean>(false);
  const [isFreeType, setIsFreeType] = useState(tab.freeTypeMode);
  const [clickIndicator, setClickIndicator] = useState<{ x: number; y: number } | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<HostKeyPromptInfo | null>(null);

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

    // Register terminal with manager for broadcast sync input
    terminalManager.registerTerminal(tab.id, term, tab.syncChannel);
    terminalManager.setActiveTab(tab.id);

    // Register Real-time Regex Link Provider (IPs, URLs)
    term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          activate: (event: MouseEvent, text: string) => void;
        }> = [];

        // IPv4 Pattern Matcher
        const ipRegex = /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
        let match;
        while ((match = ipRegex.exec(text)) !== null) {
          const start = match.index + 1;
          const matchedText = match[0];
          links.push({
            range: {
              start: { x: start, y: bufferLineNumber },
              end: { x: start + matchedText.length, y: bufferLineNumber },
            },
            text: matchedText,
            activate: (_e, ip) => {
              if (navigator.clipboard) {
                navigator.clipboard.writeText(ip);
              }
            },
          });
        }

        // URL Pattern Matcher
        const urlRegex = /https?:\/\/[^\s/$.?#].[^\s]*/g;
        while ((match = urlRegex.exec(text)) !== null) {
          const start = match.index + 1;
          const matchedText = match[0];
          links.push({
            range: {
              start: { x: start, y: bufferLineNumber },
              end: { x: start + matchedText.length, y: bufferLineNumber },
            },
            text: matchedText,
            activate: (_e, url) => {
              window.open(url, '_blank');
            },
          });
        }

        callback(links);
      },
    });

    // Subscribe to native host key prompt events from backend
    let unlistenPrompts: (() => void) | null = null;
    listenHostKeyPrompts((event) => {
      if (event.session_id === tab.id) {
        setPendingPrompt(event.prompt);
      }
    }).then((unlisten) => {
      unlistenPrompts = unlisten;
    });

    // Attempt to reattach to existing session or start a new PTY session
    attachTerminalSession(tab.id, 0, (chunk) => {
      isLivePtyRef.current = true;
      term.write(chunk);
    }).then((attachInfo) => {
      if (attachInfo && attachInfo.replay_data.length > 0) {
        isLivePtyRef.current = true;
        term.write(new Uint8Array(attachInfo.replay_data));
      } else {
        // Fresh start
        startTerminalSession(
          tab.id,
          tab.sessionName,
          tab.hostname === 'localhost' || !tab.hostname,
          term.cols,
          term.rows,
          (chunk) => {
            isLivePtyRef.current = true;
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
      }
    });

    // Handle user keyboard input
    term.onData((data) => {
      if (isLivePtyRef.current) {
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
      if (isLivePtyRef.current) {
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
      if (unlistenPrompts) {
        unlistenPrompts();
      }
      setSyncChannel(tab.id, null);
      terminalManager.unregisterTerminal(tab.id);
      if (isLivePtyRef.current) {
        closeTerminalSession(tab.id);
      }
      term.dispose();
    };
  }, [tab.id, tab.sessionName, tab.hostname, tab.port, tab.username]);

  // WindTerm Free Type Mode: Arbitrary cursor placement and delta computation
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isFreeType || !containerRef.current || !terminalRef.current) return;
    const term = terminalRef.current;

    // Gating 1: Suppress in alternate screen buffer (vim, nano, htop, less)
    if (term.buffer.active.type === 'alternate') {
      return;
    }

    const screenEl = containerRef.current.querySelector('.xterm-screen');
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / term.cols;
    const cellHeight = rect.height / term.rows;

    const targetCol = Math.floor((e.clientX - rect.left) / cellWidth);
    const targetRow = Math.floor((e.clientY - rect.top) / cellHeight);

    // Visual click ripple
    const localX = e.clientX - containerRef.current.getBoundingClientRect().left;
    const localY = e.clientY - containerRef.current.getBoundingClientRect().top;
    setClickIndicator({ x: localX, y: localY });
    setTimeout(() => setClickIndicator(null), 600);

    const cursorCol = term.buffer.active.cursorX;
    const cursorRow = term.buffer.active.cursorY;

    // Line gating: only move cursor if clicking on the active input row
    if (targetRow === cursorRow && targetCol >= 0 && targetCol < term.cols) {
      const delta = targetCol - cursorCol;
      if (delta > 0) {
        const rightSeq = '\x1b[C'.repeat(delta);
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(rightSeq));
        } else {
          term.write(rightSeq);
        }
      } else if (delta < 0) {
        const leftSeq = '\x1b[D'.repeat(Math.abs(delta));
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(leftSeq));
        } else {
          term.write(leftSeq);
        }
      }
    }

    term.focus();
  }, [isFreeType, tab.id]);

  const handleAnswerPrompt = async (answer: 'store' | 'once' | 'reject') => {
    await answerHostKeyPrompt(tab.id, answer);
    setPendingPrompt(null);
    terminalRef.current?.focus();
  };

  const cycleChannel = () => {
    const channels: SyncChannel[] = ['none', 'A', 'B', 'C', 'D'];
    const currentIdx = channels.indexOf(tab.syncChannel);
    const nextChannel = channels[(currentIdx + 1) % channels.length];
    onUpdateTab(tab.id, { syncChannel: nextChannel });
    terminalManager.setSyncChannel(tab.id, nextChannel);
    setSyncChannel(tab.id, nextChannel === 'none' ? null : nextChannel);
  };

  const toggleFreeType = () => {
    const nextState = !isFreeType;
    setIsFreeType(nextState);
    onUpdateTab(tab.id, { freeTypeMode: nextState });
    terminalManager.setFreeTypeMode(tab.id, nextState);
    if (terminalRef.current) {
      terminalRef.current.options.cursorStyle = nextState ? 'bar' : 'block';
    }
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
            title="Active Regex Highlighting: IPs, UUIDs, Errors, Warnings, URLs (Clickable links enabled)"
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

        {/* Native Host Key Verification Dialog */}
        {pendingPrompt && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-plinky-900 border border-amber-500/60 rounded-xl shadow-2xl max-w-lg w-full p-6 text-slate-100">
              <div className="flex items-start space-x-3 mb-4">
                <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">Host Key Verification Required</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    The server's host key is not cached in PuTTY's known hosts store. You have no guarantee that the server is the computer you think it is.
                  </p>
                </div>
              </div>

              <div className="space-y-2 bg-slate-950/80 rounded-lg p-3 border border-slate-800 text-xs font-mono mb-5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Destination:</span>
                  <span className="text-slate-200 font-semibold">{pendingPrompt.host}:{pendingPrompt.port}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Key Type:</span>
                  <span className="text-cyan-400">{pendingPrompt.key_type}</span>
                </div>
                <div>
                  <span className="text-slate-400 block mb-1">Key Fingerprint:</span>
                  <span className="text-emerald-400 break-all select-all font-bold">{pendingPrompt.fingerprint}</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 justify-end">
                <button
                  onClick={() => handleAnswerPrompt('reject')}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-all"
                >
                  Abandon Connection
                </button>
                <button
                  onClick={() => handleAnswerPrompt('once')}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-amber-500/30 text-amber-300 text-xs font-medium transition-all"
                >
                  Connect Just Once
                </button>
                <button
                  onClick={() => handleAnswerPrompt('store')}
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-sm transition-all"
                >
                  Store Key in Cache & Connect
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
