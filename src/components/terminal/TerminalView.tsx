import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
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
import { 
  Radio, 
  Edit3, 
  Sparkles, 
  ShieldAlert, 
  Search, 
  ChevronUp, 
  ChevronDown, 
  X, 
  Copy, 
  Clipboard, 
  Trash2, 
  CheckSquare,
  Columns,
  Rows
} from 'lucide-react';

interface TerminalViewProps {
  tab: TerminalTab;
  onUpdateTab: (tabId: string, updates: Partial<TerminalTab>) => void;
  onSplitPane?: (direction: 'vertical' | 'horizontal') => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ 
  tab, 
  onUpdateTab,
  onSplitPane 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const isLivePtyRef = useRef<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isOsc133IntegratedRef = useRef<boolean>(false);
  const isPromptInputRegionRef = useRef<boolean>(true);

  const [isFreeType, setIsFreeType] = useState(tab.freeTypeMode);
  const [clickIndicator, setClickIndicator] = useState<{ x: number; y: number } | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<HostKeyPromptInfo | null>(null);

  // Search State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [searchStats, setSearchStats] = useState<{ index: number; total: number } | null>(null);

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm.js instance with modern dark theme
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: isFreeType ? 'bar' : 'block',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      allowTransparency: true,
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#090d16',
        selectionBackground: 'rgba(56, 189, 248, 0.35)',
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

    // Initialize Search Addon
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    // Register OSC 133 Shell Integration Handler (Semantic Prompt Gating)
    const osc133Disposable = term.parser.registerOscHandler(133, (data) => {
      isOsc133IntegratedRef.current = true;
      const code = data.charAt(0).toUpperCase();
      if (code === 'B') {
        isPromptInputRegionRef.current = true;
      } else if (code === 'C' || code === 'D') {
        isPromptInputRegionRef.current = false;
      }
      return false;
    });

    searchAddon.onDidChangeResults((e) => {
      if (e) {
        setSearchStats({ index: e.resultIndex, total: e.resultCount });
      } else {
        setSearchStats(null);
      }
    });

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

    // Handle Ctrl+F for searching inside terminal
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
        searchAddonRef.current?.clearDecorations();
        term.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // Ignored
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      if (unlistenPrompts) {
        unlistenPrompts();
      }
      setSyncChannel(tab.id, null);
      terminalManager.unregisterTerminal(tab.id);
      osc133Disposable.dispose();
      if (isLivePtyRef.current) {
        closeTerminalSession(tab.id);
      }
      term.dispose();
    };
  }, [tab.id, tab.sessionName, tab.hostname, tab.port, tab.username]);

  // Execute in-buffer search
  const performSearch = useCallback((direction: 'next' | 'prev' = 'next') => {
    if (!searchAddonRef.current || !searchQuery) return;
    const options = {
      caseSensitive,
      wholeWord,
      regex: isRegex,
      incremental: direction === 'next',
      decorations: {
        matchOverviewRuler: '#38bdf8',
        activeMatchColorOverviewRuler: '#f59e0b',
        matchBackground: 'rgba(56, 189, 248, 0.3)',
        activeMatchBackground: 'rgba(245, 158, 11, 0.6)',
      }
    };

    if (direction === 'next') {
      searchAddonRef.current.findNext(searchQuery, options);
    } else {
      searchAddonRef.current.findPrevious(searchQuery, options);
    }
  }, [searchQuery, caseSensitive, wholeWord, isRegex]);

  useEffect(() => {
    if (isSearchOpen && searchQuery) {
      performSearch('next');
    } else if (!searchQuery && searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
      setSearchStats(null);
    }
  }, [searchQuery, caseSensitive, wholeWord, isRegex, isSearchOpen, performSearch]);

  // WindTerm Free Type Mode: Arbitrary cursor placement and delta computation
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Close context menu on left click
    if (contextMenu) {
      setContextMenu(null);
    }

    if (!isFreeType || !containerRef.current || !terminalRef.current) return;
    const term = terminalRef.current;

    // Gating 1: Suppress in alternate screen buffer (vim, nano, htop, less)
    if (term.buffer.active.type === 'alternate') {
      return;
    }

    // Gating 2: Suppress if OSC 133 semantic prompt is integrated and outside B..C input region
    if (isOsc133IntegratedRef.current && !isPromptInputRegionRef.current) {
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
      // Gating 3: DECCKM (Application Cursor Keys Mode)
      // When DECCKM is active, arrow keys send SS3 (\x1bO[A-D]) instead of CSI (\x1b[[A-D])
      const isDecckm = (term.modes as { applicationCursorKeysMode?: boolean } | undefined)?.applicationCursorKeysMode === true;
      const rightSeqToken = isDecckm ? '\x1bOC' : '\x1b[C';
      const leftSeqToken = isDecckm ? '\x1bOD' : '\x1b[D';

      const delta = targetCol - cursorCol;
      if (delta > 0) {
        const rightSeq = rightSeqToken.repeat(delta);
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(rightSeq));
        } else {
          term.write(rightSeq);
        }
      } else if (delta < 0) {
        const leftSeq = leftSeqToken.repeat(Math.abs(delta));
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(leftSeq));
        } else {
          term.write(leftSeq);
        }
      }
    }

    term.focus();
  }, [isFreeType, tab.id, contextMenu]);

  // Context Menu Handler
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 280);
    setContextMenu({ x, y });
  };

  const handleCopy = () => {
    const selection = terminalRef.current?.getSelection();
    if (selection && navigator.clipboard) {
      navigator.clipboard.writeText(selection);
    }
    setContextMenu(null);
  };

  const handlePaste = async () => {
    if (navigator.clipboard) {
      const text = await navigator.clipboard.readText();
      if (text) {
        if (isLivePtyRef.current) {
          writeTerminalInput(tab.id, new TextEncoder().encode(text));
        } else {
          terminalRef.current?.write(text);
        }
      }
    }
    setContextMenu(null);
  };

  const handleSelectAll = () => {
    terminalRef.current?.selectAll();
    setContextMenu(null);
  };

  const handleClear = () => {
    terminalRef.current?.clear();
    setContextMenu(null);
  };

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
    <div 
      className="relative flex flex-col h-full w-full bg-plinky-950 overflow-hidden"
      onContextMenu={handleContextMenu}
    >
      {/* Tab Control Overlay Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-plinky-900/90 border-b border-plinky-800 text-xs select-none">
        <div className="flex items-center space-x-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="font-semibold text-slate-200">{tab.sessionName}</span>
          <span className="text-slate-500 font-mono">({tab.hostname}:{tab.port})</span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Find In Terminal Button */}
          <button
            onClick={() => {
              setIsSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 50);
            }}
            title="Find in Terminal (Ctrl+F)"
            className="flex items-center space-x-1 px-2 py-0.5 rounded bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] transition"
          >
            <Search className="w-3 h-3 text-sky-400" />
            <span>Find</span>
          </button>

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
                ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 shadow-xs'
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

      {/* Floating In-Buffer Search Bar Overlay */}
      {isSearchOpen && (
        <div className="absolute top-10 right-4 z-40 flex items-center space-x-1.5 p-2 bg-plinky-900 border border-sky-500/40 rounded-lg shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150 text-xs">
          <Search className="w-3.5 h-3.5 text-sky-400 ml-1" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Find in terminal..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) {
                  performSearch('prev');
                } else {
                  performSearch('next');
                }
              }
            }}
            className="w-44 bg-plinky-950 border border-plinky-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-hidden focus:border-sky-500"
          />

          {/* Search Result Counter */}
          <span className="text-[10px] font-mono text-slate-400 px-1 min-w-[50px] text-center">
            {searchStats ? `${searchStats.index + 1}/${searchStats.total}` : (searchQuery ? '0/0' : '')}
          </span>

          {/* Direction Navigation */}
          <button
            onClick={() => performSearch('prev')}
            title="Previous Match (Shift+Enter)"
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-white"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => performSearch('next')}
            title="Next Match (Enter)"
            className="p-1 rounded hover:bg-plinky-800 text-slate-400 hover:text-white"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>

          {/* Match Options Toggles */}
          <button
            onClick={() => setCaseSensitive(!caseSensitive)}
            title="Match Case"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              caseSensitive ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            Aa
          </button>
          <button
            onClick={() => setWholeWord(!wholeWord)}
            title="Match Whole Word"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              wholeWord ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            \b
          </button>
          <button
            onClick={() => setIsRegex(!isRegex)}
            title="Use Regular Expression"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition ${
              isRegex ? 'bg-sky-500/20 text-sky-300 border-sky-500/50' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            .*
          </button>

          {/* Close Search */}
          <button
            onClick={() => {
              setIsSearchOpen(false);
              searchAddonRef.current?.clearDecorations();
              terminalRef.current?.focus();
            }}
            title="Close Search (Esc)"
            className="p-1 text-slate-500 hover:text-rose-400 ml-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

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

        {/* Custom Terminal Context Menu */}
        {contextMenu && (
          <div
            className="fixed z-50 w-48 bg-plinky-900 border border-plinky-700/80 rounded-lg shadow-2xl py-1 text-slate-200 text-xs select-none backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={handleCopy}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Copy className="w-3.5 h-3.5 text-sky-400" />
              <span>Copy Selection</span>
            </button>
            <button
              onClick={handlePaste}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Clipboard className="w-3.5 h-3.5 text-emerald-400" />
              <span>Paste Clipboard</span>
            </button>
            <button
              onClick={handleSelectAll}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
              <span>Select All</span>
            </button>
            <div className="border-t border-plinky-800 my-1" />
            <button
              onClick={() => {
                setContextMenu(null);
                setIsSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Search className="w-3.5 h-3.5 text-amber-400" />
              <span>Find in Terminal...</span>
            </button>
            <button
              onClick={() => {
                toggleFreeType();
                setContextMenu(null);
              }}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
            >
              <Edit3 className="w-3.5 h-3.5 text-cyan-400" />
              <span>{isFreeType ? 'Disable Free Type' : 'Enable Free Type'}</span>
            </button>
            <div className="border-t border-plinky-800 my-1" />
            {onSplitPane && (
              <>
                <button
                  onClick={() => {
                    onSplitPane('vertical');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                >
                  <Columns className="w-3.5 h-3.5 text-sky-400" />
                  <span>Split Vertically</span>
                </button>
                <button
                  onClick={() => {
                    onSplitPane('horizontal');
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-sky-600/30 hover:text-sky-200 text-left transition"
                >
                  <Rows className="w-3.5 h-3.5 text-sky-400" />
                  <span>Split Horizontally</span>
                </button>
                <div className="border-t border-plinky-800 my-1" />
              </>
            )}
            <button
              onClick={handleClear}
              className="w-full flex items-center space-x-2 px-3 py-1.5 hover:bg-rose-500/20 hover:text-rose-300 text-left transition"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Clear Terminal</span>
            </button>
          </div>
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
